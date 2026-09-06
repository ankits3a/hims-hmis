import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The pool's two limits — 11j remediation steps 1–2, DECIDED in ROADMAP-v2 Q6 (2026-09-06),
 * landed by Phase 11i T0.
 *
 * WHY THESE TWO VALUES AND NOT A REWRITE. Until this change the pool was constructed as
 * `new Pool({ connectionString })`, which takes node-pg's own defaults: `max: 10` and
 * `connectionTimeoutMillis: 0`. Zero does not mean "fail fast"; it means WAIT FOREVER. So the
 * eleventh concurrent checkout on a busy API did not error and did not log — it hung, and the
 * only symptom outside the process was a request that never answered. Step 1 (the timeout) turns
 * that invisible hang into a rejection the caller can log; step 2 (the size) gives the API room
 * for the concurrency it already has, so five simultaneous invoice issuances are unremarkable.
 * Step 3 — un-nesting the transactions that consume two connections at once — is 11j and is
 * deliberately NOT here: a pool value is configuration, a nesting fix is behaviour.
 *
 * WHY THE API AND THE WORKER DIFFER. `max` is per process. The API serves the counters; the
 * worker drains a queue on a schedule. Postgres runs at its default `max_connections = 100`
 * (nothing under `docker/prod` overrides it), and 20 + 10 plus the exporter and pgBackRest fits
 * with headroom. The worker declares its own default at the call site rather than reading a
 * second environment key, because a deployment that wants to move both moves `DB_POOL_MAX` once.
 *
 * WHY A MALFORMED VALUE REFUSES (11i D14). `Number("twenty")` is `NaN`, and a pool built with
 * `max: NaN` neither errors nor limits anything — it is a configuration lie that survives a
 * deploy. A startup that refuses names the key in the log the operator is already reading.
 */
const DEFAULT_POOL_MAX = 20;
export const DEFAULT_WORKER_POOL_MAX = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function readPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function createDb(url: string, opts: { defaultMax?: number } = {}): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: url,
    max: readPositiveInt("DB_POOL_MAX", opts.defaultMax ?? DEFAULT_POOL_MAX),
    connectionTimeoutMillis: readPositiveInt("DB_POOL_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
