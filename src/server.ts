import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Ledger } from './ledger.js';
import { demoMandate } from './mandate.js';
import { createMcpServer } from './mcp.js';
import * as paypal from './paypal.js';
import { PaymentInputSchema } from './schemas.js';
import { capturePayment, getStatus, requestPayment } from './service.js';
import type { Deps } from './service.js';

const deps: Deps = { ledger: new Ledger(), mandate: demoMandate, paypal };
const apiKey = process.env.CHAPERONE_API_KEY;
const demoMode = process.env.DEMO_MODE === 'true';

// If CHAPERONE_API_KEY is set, payment and MCP calls must send it as a Bearer token.
function requireKey(req: Request, res: Response, next: NextFunction): void {
  if (!apiKey) {
    next();
    return;
  }
  const given = Buffer.from(req.get('authorization') ?? '');
  const wanted = Buffer.from(`Bearer ${apiKey}`);
  if (given.length === wanted.length && timingSafeEqual(given, wanted)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Missing or invalid API key.' });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, demoMode });
});

app.get('/api/status', (_req, res) => {
  res.json(getStatus(deps));
});

app.get('/api/decisions', (_req, res) => {
  const rows = deps.ledger
    .recent(100)
    .map((row) => ({ ...row, reasons: JSON.parse(row.reasons) as string[] }));
  res.json(rows);
});

app.post('/api/payments', requireKey, async (req, res) => {
  const parsed = PaymentInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid payment request.',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  res.json(await requestPayment(deps, parsed.data));
});

app.post('/api/payments/:orderId/capture', requireKey, async (req, res) => {
  try {
    res.json(await capturePayment(deps, String(req.params.orderId)));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Capture failed.' });
  }
});

// Only exists when DEMO_MODE=true, so demos and test runs can start from a clean log.
app.post('/api/demo/reset', requireKey, (_req, res) => {
  if (!demoMode) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  deps.ledger.clearForDemo();
  res.json({ ok: true });
});

// MCP over Streamable HTTP, stateless: a fresh server and transport for every request.
app.post('/mcp', requireKey, async (req, res) => {
  try {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
};
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) {
    res.status(status).json({ error: status >= 500 ? 'Internal error.' : 'Bad request.' });
  }
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.RENDER ? '0.0.0.0' : '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Chaperone listening on http://${host}:${port}`);
  console.log(`  MCP endpoint: http://${host}:${port}/mcp`);
});