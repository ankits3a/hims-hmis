import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createDb, DEFAULT_WORKER_POOL_MAX } from "./client";
import { requireEnv } from "../config";
import { setupTestDb } from "../../../test/helpers/db";

/**
 * Phase 11i T0 (11j remediation steps 1–2; ROADMAP-v2 Q6, DECIDED 2026-09-06).
 *
 * Until this suite existed the pool was `new Pool({ connectionString })`, which means node-pg's
 * own defaults: `max: 10` and `connectionTimeoutMillis: 0` — and 0 does not mean "fail fast", it
 * means WAIT FOREVER. The eleventh concurrent query on a busy API did not error; it hung, and the
 * only symptom reachable from outside was a request that never answered. The two values here turn
 * that invisible hang into a logged rejection (step 1) and give the API room for the concurrency
 * it already has (step 2).
 */
describe("createDb — the pool's two limits", () => {
  let teardown: () => Promise<void>;
  let workerUrl: string;
  const pools: Pool[] = [];

  const saved = { max: process.env.DB_POOL_MAX, timeout: process.env.DB_POOL_CONNECT_TIMEOUT_MS };

  beforeAll(async () => {
    ({ teardown } = await setupTestDb());
    // setupTestDb derives "<base>_<JEST_WORKER_ID>"; mirror it so these pools reach a real database.
    const url = new URL(requireEnv("TEST_DATABASE_URL"));
    url.pathname = `${url.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    workerUrl = url.toString();
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    await teardown();
  });

  afterEach(() => {
    if (saved.max === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = saved.max;
    if (saved.timeout === undefined) delete process.env.DB_POOL_CONNECT_TIMEOUT_MS;
    else process.env.DB_POOL_CONNECT_TIMEOUT_MS = saved.timeout;
  });

  const track = (pool: Pool): Pool => { pools.push(pool); return pool; };

  it("defaults to the API's twenty connections and a ten-second connect budget", () => {
    const { pool } = createDb(workerUrl);
    track(pool);
    expect(pool.options.max).toBe(20);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
  });

  it("lets the worker declare its own smaller default without an env file", () => {
    const { pool } = createDb(workerUrl, { defaultMax: 10 });
    track(pool);
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
  });

  it("reads both values from the environment, overriding the caller's default", () => {
    process.env.DB_POOL_MAX = "3";
    process.env.DB_POOL_CONNECT_TIMEOUT_MS = "250";
    const { pool } = createDb(workerUrl, { defaultMax: 10 });
    track(pool);
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(250);
  });

  it("refuses a value that is not a positive integer, naming the key", () => {
    process.env.DB_POOL_MAX = "twenty";
    expect(() => createDb(workerUrl)).toThrow(/DB_POOL_MAX/);
    process.env.DB_POOL_MAX = "0";
    expect(() => createDb(workerUrl)).toThrow(/DB_POOL_MAX/);
    delete process.env.DB_POOL_MAX;
    process.env.DB_POOL_CONNECT_TIMEOUT_MS = "-1";
    expect(() => createDb(workerUrl)).toThrow(/DB_POOL_CONNECT_TIMEOUT_MS/);
  });

  it("REJECTS a starved connect inside the budget instead of hanging forever", async () => {
    process.env.DB_POOL_MAX = "1";
    process.env.DB_POOL_CONNECT_TIMEOUT_MS = "400";
    const { pool } = createDb(workerUrl);
    track(pool);

    const held = await pool.connect(); // the only connection this pool may open
    const started = Date.now();
    // Before T0 this awaited forever and the suite died on jest's hook timeout, not on an
    // assertion. Resolved-or-rejected is captured by hand so a regression reports one line
    // instead of dumping a whole pg client.
    const outcome = await pool.connect().then(
      (client) => { client.release(); return "connected"; },
      (error: unknown) => error,
    );
    const elapsed = Date.now() - started;
    held.release();
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/timeout/i);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("gives the worker process the smaller default at its call site", () => {
    // The value only reaches a running worker through worker.module.ts, and importing the whole
    // module here would drag in the queue. The deploy-parity shape applies: read the seam's text.
    const source = readFileSync(join(__dirname, "../worker/worker.module.ts"), "utf8");
    expect(source).toMatch(/createDb\(cfg\.databaseUrl, \{ defaultMax: DEFAULT_WORKER_POOL_MAX \}\)/);
    expect(DEFAULT_WORKER_POOL_MAX).toBe(10);
  });
});
