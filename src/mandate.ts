import type { Mandate } from './policy.js';

// Demo mandate. Later, Claude compiles a plain-English mandate into this shape.
export const demoMandate: Mandate = {
  task: 'Office snacks and supplies, max $80 per order and $200 per month, approved merchants only, no subscriptions.',
  currency: 'USD',
  perOrderLimitCents: 8000,
  periodLimitCents: 20000,
  holdAboveCents: 5000,
  allowedMerchants: ['acme snacks', 'paper plus', 'brew bros'],
  blockedKeywords: [
    'gift card',
    'giftcard',
    'crypto',
    'bitcoin',
    'wire transfer',
    'western union',
    'subscription',
    'recurring',
  ],
  maxRequestsPer10Min: 5,
};
