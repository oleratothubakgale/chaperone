import { z } from 'zod';

// Shared by the MCP tools and the web API, so both validate input the same way.
export const paymentShape = {
  merchant: z
    .string()
    .min(1)
    .max(100)
    .describe('Merchant being paid, exactly as shown in the store listing'),
  amount: z
    .number()
    .positive()
    .max(100000)
    .describe('Amount in dollars with at most two decimals, for example 24.99'),
  currency: z.string().length(3).default('USD').describe('Three-letter currency code'),
  description: z
    .string()
    .min(1)
    .max(500)
    .describe('What is being bought, copied from the listing'),
  reason: z.string().min(1).max(500).describe("Why this purchase serves the user's task"),
};

export const PaymentInputSchema = z.object(paymentShape);

export const captureShape = {
  orderId: z.string().min(1).max(64).describe('The orderId returned by request_payment'),
};