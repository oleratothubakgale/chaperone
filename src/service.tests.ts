import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.js';
import { demoMandate } from './mandate.js';
import { capturePayment, getStatus, requestPayment, toCents } from './service.js';
import type { Deps, PayPalPort, PaymentInput } from './service.js';

function setup(opts: { failCreate?: boolean } = {}) {
  const calls = {
    created: [] as { amount: string; description: string }[],
    captured: [] as string[],
  };
  let n = 0;
  const paypal: PayPalPort = {
    async createOrder(amount, description) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (opts.failCreate) throw new Error('PayPal is down');
      calls.created.push({ amount, description });
      n += 1;
      return {
        id: `ORDER${n}`,
        status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'payer-action', href: `https://sandbox.paypal.test/approve/ORDER${n}` }],
      };
    },
    approvalLink: (order) => order.links?.find((l) => l.rel === 'payer-action')?.href,
    async captureOrder(id) {
      calls.captured.push(id);
      return { id, status: 'COMPLETED' };
    },
  };
  const ledger = new Ledger(':memory:');
  const deps: Deps = { ledger, mandate: demoMandate, paypal };
  return { deps, ledger, calls };
}

const input: PaymentInput = {
  merchant: 'Acme Snacks',
  amount: 25,
  currency: 'USD',
  description: 'Box of granola bars',
  reason: 'Office snack restock',
};

test('toCents converts dollars exactly and rejects extra decimals', () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(25), 2500);
  assert.ok(Number.isNaN(toCents(12.345)));
  assert.ok(Number.isNaN(toCents(Number.NaN)));
  assert.ok(Number.isNaN(toCents(Number.POSITIVE_INFINITY)));
});

test('an approved payment creates a PayPal order and is logged with its order id', async () => {
  const { deps, ledger, calls } = setup();
  const r = await requestPayment(deps, input);

  assert.equal(r.verdict, 'approve');
  assert.equal(r.orderId, 'ORDER1');
  assert.equal(r.approvalUrl, 'https://sandbox.paypal.test/approve/ORDER1');
  assert.deepEqual(calls.created, [{ amount: '25.00', description: 'Acme Snacks: Box of granola bars' }]);

  const row = ledger.findByOrderId('ORDER1');
  assert.equal(row?.verdict, 'approve');
  assert.equal(row?.amount_cents, 2500);
});

test('a denied payment never reaches PayPal', async () => {
  const { deps, calls } = setup();
  const r = await requestPayment(deps, { ...input, merchant: 'Shady Deals' });
  assert.equal(r.verdict, 'deny');
  assert.equal(r.orderId, undefined);
  assert.equal(calls.created.length, 0);
});

test('a held payment never reaches PayPal either', async () => {
  const { deps, calls } = setup();
  const r = await requestPayment(deps, { ...input, amount: 60 });
  assert.equal(r.verdict, 'hold');
  assert.equal(calls.created.length, 0);
  assert.ok(r.decisionId > 0);
});

test('a price with fractions of a cent is denied and still logged', async () => {
  const { deps, ledger } = setup();
  const r = await requestPayment(deps, { ...input, amount: 12.345 });
  assert.equal(r.verdict, 'deny');
  assert.equal(ledger.recent()[0].amount_cents, 0);
});

test('if PayPal fails the payment is blocked and does not count as spend', async () => {
  const { deps, ledger } = setup({ failCreate: true });
  const r = await requestPayment(deps, input);
  assert.equal(r.verdict, 'deny');
  assert.match(r.reasons.join(' '), /PayPal could not create the order/);
  assert.equal(ledger.history().spentInPeriodCents, 0);
});

test('two requests that arrive together cannot both squeeze under the limit', async () => {
  const { deps, ledger } = setup();
  ledger.record(
    { merchant: 'Acme Snacks', amountCents: 17000, currency: 'USD', description: 'bulk order', agentReason: 'earlier' },
    { verdict: 'approve', reasons: ['ok'] },
    'PRE',
    Date.now() - 60 * 60 * 1000,
  );

  const [a, b] = await Promise.all([
    requestPayment(deps, { ...input, amount: 20 }),
    requestPayment(deps, { ...input, amount: 20 }),
  ]);
  assert.deepEqual([a.verdict, b.verdict].sort(), ['approve', 'deny']);
});

test('long descriptions are cut to the 127 characters PayPal allows', async () => {
  const { deps, calls } = setup();
  await requestPayment(deps, { ...input, description: 'x'.repeat(400) });
  assert.ok(calls.created[0].description.length <= 127);
});

test('capture works only for orders Chaperone approved', async () => {
  const { deps, calls } = setup();
  const r = await requestPayment(deps, input);

  await assert.rejects(() => capturePayment(deps, 'SOMEONE-ELSES-ORDER'), /Unknown order/);
  assert.equal(calls.captured.length, 0);

  const done = await capturePayment(deps, r.orderId!);
  assert.deepEqual(done, { orderId: 'ORDER1', status: 'COMPLETED' });
  assert.deepEqual(calls.captured, ['ORDER1']);
});

test('status shows the remaining budget without leaking the blocked keywords', async () => {
  const { deps } = setup();
  await requestPayment(deps, input);
  const s = getStatus(deps);
  assert.equal(s.spentInPeriod, 25);
  assert.equal(s.remainingInPeriod, 175);
  assert.equal(JSON.stringify(s).includes('gift card'), false);
});