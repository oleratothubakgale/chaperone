import { DatabaseSync } from 'node:sqlite';
import type { Decision, History, PaymentRequest } from './policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

export type LedgerRow = {
  id: number;
  ts: number;
  merchant: string;
  amount_cents: number;
  currency: string;
  description: string;
  agent_reason: string;
  verdict: string;
  reasons: string; // JSON array of strings
  paypal_order_id: string | null;
};

// Append-only decision log. Rows are only ever inserted, never changed.
export class Ledger {
  private db: DatabaseSync;

  constructor(path: string = process.env.LEDGER_PATH ?? 'chaperone.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        merchant TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_reason TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reasons TEXT NOT NULL,
        paypal_order_id TEXT
      )
    `);
  }

  record(
    r: PaymentRequest,
    d: Decision,
    orderId: string | null = null,
    now: number = Date.now(),
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO decisions
          (ts, merchant, amount_cents, currency, description, agent_reason, verdict, reasons, paypal_order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now,
        r.merchant,
        r.amountCents,
        r.currency,
        r.description,
        r.agentReason,
        d.verdict,
        JSON.stringify(d.reasons),
        orderId,
      );
    return Number(result.lastInsertRowid);
  }

  // Money counts as spent only when the decision was 'approve'.
  history(now: number = Date.now()): History {
    const spent = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM decisions WHERE verdict = 'approve' AND ts >= ?`,
      )
      .get(now - 30 * DAY_MS) as unknown as { total: number };

    // Velocity counts every attempt, including denied ones, to catch hammering.
    const recent = this.db
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ts >= ?`)
      .get(now - TEN_MIN_MS) as unknown as { n: number };

    return {
      spentInPeriodCents: Number(spent.total),
      requestsLast10Min: Number(recent.n),
    };
  }

  recent(limit = 50): LedgerRow[] {
    return this.db
      .prepare(`SELECT * FROM decisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as LedgerRow[];
  }

  close(): void {
    this.db.close();
  }
}