import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { captureShape, paymentShape } from './schemas.js';
import { capturePayment, getStatus, requestPayment } from './service.js';
import type { Deps } from './service.js';

const asText = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  isError,
});

// The tools an AI agent sees. Every payment must go through request_payment.
export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'chaperone', version: '0.1.0' });

  server.registerTool(
    'get_spending_status',
    {
      title: 'Get spending status',
      description:
        'Shows the spending rules you operate under: approved merchants, per-order limit, ' +
        'how much of the monthly budget is left. Check this before planning purchases.',
    },
    async () => asText(getStatus(deps)),
  );

  server.registerTool(
    'request_payment',
    {
      title: 'Request a payment',
      description:
        'Ask Chaperone to pay a merchant through PayPal. Chaperone checks the request against ' +
        "the user's spending mandate and answers approve, hold or deny, with reasons. " +
        'The decision is final: never retry a held or denied payment with changed details.',
      inputSchema: paymentShape,
    },
    async (args) => asText(await requestPayment(deps, args)),
  );

  server.registerTool(
    'capture_payment',
    {
      title: 'Capture an approved payment',
      description:
        'After the buyer has approved an order in PayPal, finish the payment. ' +
        'Only works for orders that request_payment approved.',
      inputSchema: captureShape,
    },
    async ({ orderId }) => {
      try {
        return asText(await capturePayment(deps, orderId));
      } catch (err) {
        return asText({ error: err instanceof Error ? err.message : 'Capture failed.' }, true);
      }
    },
  );

  return server;
}