// The payment service: ties the rules (policy), the log (ledger) and PayPal
// together. Both the MCP tools and the web API call these same functions.

import { decide } from './policy.js';
import type { Decision, Mandate, PaymentRequest } from './policy.js';
import type { Ledger } from './ledger.js';

export type PayPalOrder = {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
};

// The only PayPal operations Chaperone needs. Tests plug in a fake.
export type PayPalPort = {
  createOrder(amount: string, description: string): Promise<PayPalOrder>;
  approvalLink(order: PayPalOrder): string | undefined;
  captureOrder(id: string): Promise<PayPalOrder>;
};

export type Deps = { ledger: Ledger; mandate: Mandate; paypal: PayPalPort };

// What an AI agent sends. Amounts are in dollars because that is natural for agents.
export type PaymentInput = {
  merchant: string;
  amount: number;
  currency: string;
  description: string;
  reason: string;
};

export type PaymentResult = {
  decisionId: number;
  verdict: Decision['verdict'];
  reasons: string[];
  orderId?: string;
  approvalUrl?: string;
  nextStep: string;
};

// Dollars to whole cents. Anything with more than two decimals becomes NaN, which
// the rules then reject, instead of silently rounding to a different price.
export function toCents(amount: number): number {
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 1e-6 ? cents : Number.NaN;
}

// Requests run one at a time. Without this, two requests that arrive together could
// both pass the spending-limit check before either one is written to the log.
let tail: Promise<unknown> = Promise.resolve();
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job);
  tail = run.catch(() => undefined);
  return run;
}

const NEXT_STEP = {
  approve:
    'Open approvalUrl as the buyer to approve it in PayPal, then call capture_payment with the orderId.',
  hold: 'A human must approve this payment in the Chaperone dashboard. Do not retry it.',
  deny: 'This payment is blocked. Do not retry it with changed details.',
} as const;

export function requestPayment(
  deps: Deps,
  input: PaymentInput,
  now: number = Date.now(),
): Promise<PaymentResult> {
  return serialize(async () => {
    const request: PaymentRequest = {
      merchant: input.merchant,
      amountCents: toCents(input.amount),
      currency: input.currency,
      description: input.description,
      agentReason: input.reason,
    };

    let decision = decide(deps.mandate, request, deps.ledger.history(now));
    let orderId: string | undefined;
    let approvalUrl: string | undefined;

    if (decision.verdict === 'approve') {
      try {
        const order = await deps.paypal.createOrder(
          (request.amountCents / 100).toFixed(2),
          `${input.merchant}: ${input.description}`.slice(0, 127), // PayPal's limit
        );
        orderId = order.id;
        approvalUrl = deps.paypal.approvalLink(order);
      } catch (err) {
        // Fail closed: if PayPal cannot confirm the order, the payment is blocked.
        const why = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
        decision = {
          verdict: 'deny',
          reasons: [`PayPal could not create the order, so the payment was blocked: ${why}`],
        };
      }
    }

    // The log needs a whole number, so a rejected nonsense amount is stored as 0.
    const logged = Number.isInteger(request.amountCents)
      ? request
      : { ...request, amountCents: 0 };
    const decisionId = deps.ledger.record(logged, decision, orderId ?? null, now);

    return {
      decisionId,
      verdict: decision.verdict,
      reasons: decision.reasons,
      ...(orderId ? { orderId, approvalUrl } : {}),
      nextStep: NEXT_STEP[decision.verdict],
    };
  });
}

// An agent may only capture orders that Chaperone itself approved.
export async function capturePayment(
  deps: Deps,
  orderId: string,
): Promise<{ orderId: string; status: string }> {
  const row = deps.ledger.findByOrderId(orderId);
  if (!row || row.verdict !== 'approve') {
    throw new Error('Unknown order: Chaperone only captures orders it approved.');
  }
  const order = await deps.paypal.captureOrder(orderId);
  return { orderId: order.id, status: order.status };
}

// Lets an agent see its own budget. Blocked keywords are left out on purpose.
export function getStatus(deps: Deps, now: number = Date.now()) {
  const m = deps.mandate;
  const h = deps.ledger.history(now);
  return {
    task: m.task,
    currency: m.currency,
    perOrderLimit: m.perOrderLimitCents / 100,
    holdAbove: m.holdAboveCents / 100,
    periodLimit: m.periodLimitCents / 100,
    spentInPeriod: h.spentInPeriodCents / 100,
    remainingInPeriod: Math.max(0, m.periodLimitCents - h.spentInPeriodCents) / 100,
    allowedMerchants: m.allowedMerchants,
    requestsLast10Min: h.requestsLast10Min,
    maxRequestsPer10Min: m.maxRequestsPer10Min,
  };
}