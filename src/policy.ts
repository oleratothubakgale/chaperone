// The deterministic heart of Chaperone. Pure functions only: no network, no
// database, no AI. Same input always gives the same answer, so it can be tested
// exhaustively and a clever prompt can never talk its way past it.

export type Mandate = {
  task: string; // the user's plain-English instruction, kept for the audit trail
  currency: string; // e.g. 'USD'
  perOrderLimitCents: number;
  periodLimitCents: number; // total allowed in any rolling 30 days
  holdAboveCents: number; // above this, a human must approve
  allowedMerchants: string[]; // lowercase
  blockedKeywords: string[]; // lowercase, matched against the description
  maxRequestsPer10Min: number; // velocity cap
};

export type PaymentRequest = {
  merchant: string;
  amountCents: number;
  currency: string;
  description: string;
  agentReason: string; // why the agent says it wants this purchase
};

export type History = {
  spentInPeriodCents: number;
  requestsLast10Min: number;
};

export type Verdict = 'approve' | 'hold' | 'deny';

export type Decision = {
  verdict: Verdict;
  reasons: string[];
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function decide(m: Mandate, r: PaymentRequest, h: History): Decision {
  const denies: string[] = [];
  const holds: string[] = [];

  if (!Number.isInteger(r.amountCents) || r.amountCents <= 0) {
    denies.push('Amount must be a positive whole number of cents.');
  }

  if (r.currency.trim().toUpperCase() !== m.currency.toUpperCase()) {
    denies.push(`Currency ${r.currency} is not allowed; the mandate uses ${m.currency}.`);
  }

  if (!m.allowedMerchants.includes(r.merchant.trim().toLowerCase())) {
    denies.push(`Merchant "${r.merchant}" is not on the allowlist.`);
  }

  const description = r.description.toLowerCase();
  for (const word of m.blockedKeywords) {
    if (description.includes(word)) {
      denies.push(`Description matches the blocked term "${word}".`);
    }
  }

  if (r.amountCents > m.perOrderLimitCents) {
    denies.push(
      `${money(r.amountCents)} exceeds the per-order limit of ${money(m.perOrderLimitCents)}.`,
    );
  }

  const projected = h.spentInPeriodCents + r.amountCents;
  if (projected > m.periodLimitCents) {
    denies.push(
      `This would bring 30-day spending to ${money(projected)}, over the ${money(m.periodLimitCents)} limit.`,
    );
  }

  if (denies.length > 0) return { verdict: 'deny', reasons: denies };

  if (r.amountCents > m.holdAboveCents) {
    holds.push(
      `${money(r.amountCents)} is above ${money(m.holdAboveCents)}, so a human must approve it.`,
    );
  }

  if (h.requestsLast10Min >= m.maxRequestsPer10Min) {
    holds.push(
      `${h.requestsLast10Min} requests in the last 10 minutes reached the cap of ${m.maxRequestsPer10Min}.`,
    );
  }

  if (holds.length > 0) return { verdict: 'hold', reasons: holds };

  return {
    verdict: 'approve',
    reasons: [`Within the mandate: ${money(r.amountCents)} at ${r.merchant}.`],
  };
}

const RANK: Record<Verdict, number> = { approve: 0, hold: 1, deny: 2 };

// The AI intent check may only make a decision stricter, never looser. This is
// the safety property the whole project rests on.
export function tighten(d: Decision, aiVerdict: Verdict, aiReason: string): Decision {
  if (RANK[aiVerdict] <= RANK[d.verdict]) return d;
  return { verdict: aiVerdict, reasons: [...d.reasons, `AI intent check: ${aiReason}`] };
}