import { withTx } from "../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { nextDocNo } from "./series";
import type { BillingConfig } from "./config";
import type { Db } from "../../kernel/db/client";

// nextDocNo only ever reads cfg.seriesPrefixes — a minimal fixture avoids seeding billing_config.
const CFG = {
  seriesPrefixes: { invoice: "INV", receipt: "RCP", credit_note: "CN", voucher: "RFV" },
} as BillingConfig;

// IST Apr 1 boundary, hand-derived (IST = UTC+5:30, the same instants T1's K4 uses for fyOf).
const OLD_FY_INSTANT = new Date("2027-03-31T18:29:00.000Z"); // IST 2027-03-31 23:59 -> FY 2026-27
const NEW_FY_INSTANT = new Date("2027-03-31T18:30:00.000Z"); // IST 2027-04-01 00:00 -> FY 2027-28

describe("series: nextDocNo (D5 — per-FY, row-locked, <=16 chars)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
  });

  test("sequential 1, 2, 3 within one (key, fy)", async () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const one = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    const two = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    const three = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    expect(one).toBe("INV/26-27/000001");
    expect(two).toBe("INV/26-27/000002");
    expect(three).toBe("INV/26-27/000003");
  });

  test("independent counters across series keys", async () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const invoiceFirst = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    const receiptFirst = await withTx(db, (tx) => nextDocNo(tx, CFG, "receipt", at));
    const invoiceSecond = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    expect(invoiceFirst).toBe("INV/26-27/000001");
    expect(receiptFirst).toBe("RCP/26-27/000001"); // a different key starts fresh, unaffected by "invoice"'s counter
    expect(invoiceSecond).toBe("INV/26-27/000002");
  });

  test("independent counters across fiscal years", async () => {
    const fy25 = new Date("2025-06-01T00:00:00.000Z"); // IST FY 2025-26
    const fy26 = new Date("2026-06-01T00:00:00.000Z"); // IST FY 2026-27
    const a = await withTx(db, (tx) => nextDocNo(tx, CFG, "voucher", fy25));
    const b = await withTx(db, (tx) => nextDocNo(tx, CFG, "voucher", fy26));
    expect(a).toBe("RFV/25-26/000001");
    expect(b).toBe("RFV/26-27/000001"); // a different FY starts fresh, unaffected by 2025-26's counter
  });

  test("format is exactly 16 characters: PREFIX/FY/000001 (the GST serial ceiling)", async () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const no = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at));
    expect(no).toBe("INV/26-27/000001");
    expect(no).toHaveLength(16);
  });

  test("FY rollover at the IST Apr 1 boundary: old FY unaffected, new FY restarts at 1", async () => {
    const oldFyFirst = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", OLD_FY_INSTANT));
    const newFyFirst = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", NEW_FY_INSTANT));
    const oldFySecond = await withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", OLD_FY_INSTANT));
    expect(oldFyFirst).toBe("INV/26-27/000001");
    expect(newFyFirst).toBe("INV/27-28/000001"); // the new FY restarts at 1, independent of the old FY's counter
    expect(oldFySecond).toBe("INV/26-27/000002"); // the old FY's counter is unaffected by the new FY's activity
  });

  test("unknown series key: no prefix configured -> unknown_series", async () => {
    const badCfg = { seriesPrefixes: {} } as BillingConfig;
    const at = new Date("2026-06-01T00:00:00.000Z");
    await expect(withTx(db, (tx) => nextDocNo(tx, badCfg, "invoice", at))).rejects.toMatchObject({ code: "unknown_series" });
  });

  test("race: 6 concurrent nextDocNo calls in separate transactions -> exactly {1..6}, no duplicate (measured 10x isolated, cold start every run)", async () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const RUNS = 10;
    let cleanRuns = 0;
    for (let i = 0; i < RUNS; i++) {
      // Cold start (verify-by-execution flag 6): no pre-seeded document_series row before each
      // of the 6 racers fires — every racer's own INSERT ... ON CONFLICT DO NOTHING races too.
      await truncateAll(db);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => withTx(db, (tx) => nextDocNo(tx, CFG, "invoice", at))),
      );
      const numbers = results.map((r) => Number(r.slice(-6))).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
      cleanRuns++;
    }
    expect(cleanRuns).toBe(RUNS);
  });
});
