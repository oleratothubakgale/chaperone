import 'dotenv/config';
import { randomUUID } from 'node:crypto';

// Sandbox only: this project never talks to live PayPal.
const BASE = 'https://api-m.sandbox.paypal.com';

export type Order = {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: unknown[];
};

function creds() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in .env');
  }
  return { id, secret };
}

export async function getAccessToken(): Promise<string> {
  const { id, secret } = creds();
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function paypalFetch(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Order> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID(),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PayPal ${init.method} ${path} failed: ${res.status} ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as Order;
}

export function createOrder(amount: string, description: string): Promise<Order> {
  return paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        { description, amount: { currency_code: 'USD', value: amount } },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: 'https://example.com/return',
            cancel_url: 'https://example.com/cancel',
            user_action: 'PAY_NOW',
          },
        },
      },
    },
  });
}

export function approvalLink(order: Order): string | undefined {
  return order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
    ?.href;
}

export function getOrder(id: string): Promise<Order> {
  return paypalFetch(`/v2/checkout/orders/${id}`, { method: 'GET' });
}

export function captureOrder(id: string): Promise<Order> {
  return paypalFetch(`/v2/checkout/orders/${id}/capture`, { method: 'POST' });
}