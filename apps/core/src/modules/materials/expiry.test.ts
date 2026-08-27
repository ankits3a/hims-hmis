import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, stockBatches } from "../../kernel/db/schema";
import { registerItem } from "./items";
import { createStore } from "./stores";
import { postMovements } from "./ledger";
import { expiringBatches, sweepBatchExpiry, thresholdToAnnounce } from "./expiry";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T8 / DD14 — the expiry sweep.
 *
 * T8's acceptance names two properties and both are here: **one event per batch per threshold across
 * two sweeps**, and **none for a zero-on-hand batch**.
 *
 * ═══ §2.102 ═══
 *
 * A single sweep hides the idempotence (everything is announced once by definition), and a single
 * batch at a single threshold hides the ordering. So the fixtures below run the sweep TWICE, and
 * carry batches at 100, 70, 40 and 10 days out — one per threshold band, plus one already expired.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const NOW = new Date("2026-08-27T06:30:00Z");

/** `NOW` plus `days`, as an IST calendar date string. */
function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

describe("the batch-expiry sweep (Plan 14 T8 / DD14)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function anItem(): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: `IT-${newId().slice(0, 8)}`, name: "Item", class: "drug",
      formularyMedicineId: medicineId, baseUom: "tablet", batchTracked: true,
    }));
    return itemId;
  }
  async function aStore(code = "MAIN"): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code, name: `Store ${code}` }));
    return resourceId;
  }
  /** A batch expiring `days` from NOW, with `qty` on hand (0 = received then fully issued out). */
  async function aBatch(itemId: string, storeId: string, batchNo: string, days: number, qty: number): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({
      id, itemId, batchNo, expiryDate: inDays(days), landedCostPaise: 100,
      ownership: "owned", createdBy: HEAD.id,
    });
    if (qty > 0) {
      await withTx(db, (tx) => postMovements(tx, HEAD, [
        { resourceId: storeId, batchId: id, qtyDelta: qty, reason: "grn", occurredAt: NOW },
      ]));
    }
    return id;
  }
  async function expiringEvents(): Promise<{ batchId: string; thresholdDays: number }[]> {
    const rows = await db.select({ payload: events.payload }).from(events)
      .where(eq(events.name, "batch.expiring"));
    return rows.map((r) => r.payload as { batchId: string; thresholdDays: number });
  }

  // ───────────────────────── the pure threshold choice ─────────────────────────

  /**
   * The TIGHTEST crossed threshold, not the widest. A batch first seen with 40 days left announces
   * **60**, because "90 days" would read as "plenty of time" for something inside six weeks.
   */
  it("thresholdToAnnounce picks the tightest crossed band, and never one already announced", () => {
    expect(thresholdToAnnounce(100, [])).toBeNull();   // outside every band
    expect(thresholdToAnnounce(90, [])).toBe(90);      // ON the boundary is inside it
    expect(thresholdToAnnounce(70, [])).toBe(90);
    expect(thresholdToAnnounce(40, [])).toBe(60);      // NOT 90 — the tightest crossed band
    expect(thresholdToAnnounce(10, [])).toBe(30);
    expect(thresholdToAnnounce(-5, [])).toBe(30);      // already expired: still the tightest band
    // …and never one already announced.
    expect(thresholdToAnnounce(10, [90])).toBe(30);
    expect(thresholdToAnnounce(10, [60])).toBe(30);

    /**
     * **AND NEVER A WIDER BAND AFTER A TIGHTER ONE.** A batch 40 days out has crossed 90 AND 60; it
     * announces 60, and 90 is then closed for ever. The first implementation returned 90 on the
     * second sweep — telling a storekeeper "ninety days" about something with six weeks left — and
     * only running the sweep TWICE showed it. Reassuring noise is the worst kind.
     */
    expect(thresholdToAnnounce(40, [60])).toBeNull();
    expect(thresholdToAnnounce(40, [60, 90])).toBeNull();
    expect(thresholdToAnnounce(10, [30])).toBeNull();
    expect(thresholdToAnnounce(10, [30, 60, 90])).toBeNull();
    // The tightest band still fires when it is genuinely newly crossed.
    expect(thresholdToAnnounce(25, [60])).toBe(30);
  });

  // ───────────────────────── the worklist read ─────────────────────────

  it("expiringBatches lists only batches with stock, soonest first, with days remaining", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    const far = await aBatch(itemId, storeId, "B-FAR", 200, 50);
    const soon = await aBatch(itemId, storeId, "B-SOON", 10, 5);
    const mid = await aBatch(itemId, storeId, "B-MID", 70, 20);
    const empty = await aBatch(itemId, storeId, "B-EMPTY", 5, 0);

    const list = await expiringBatches(db, NOW);
    // Soonest first, `B-FAR` outside the 90-day window, `B-EMPTY` excluded for having no stock.
    expect(list.map((b) => b.batchNo)).toEqual(["B-SOON", "B-MID"]);
    expect(list[0]?.daysRemaining).toBe(10);
    expect(list[0]?.qtyOnHandTotal).toBe(5);
    expect(list[1]?.daysRemaining).toBe(70);
    expect(list.map((b) => b.batchId)).not.toContain(far);
    expect(list.map((b) => b.batchId)).not.toContain(empty);
    void soon; void mid;

    // A wider window brings the far one in — the ceiling is a parameter, not a hard rule.
    expect((await expiringBatches(db, NOW, 365)).map((b) => b.batchNo))
      .toEqual(["B-SOON", "B-MID", "B-FAR"]);
  });

  it("a batch's on-hand is SUMMED across stores — one batch in three stores is one row", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ot = await aStore("OT");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, main, "B-1", 20, 10);
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: ot, batchId, qtyDelta: 5, reason: "grn", occurredAt: NOW },
      { resourceId: ward, batchId, qtyDelta: 2, reason: "grn", occurredAt: NOW },
    ]));
    const list = await expiringBatches(db, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.qtyOnHandTotal).toBe(17);
  });

  // ───────────────────────── the sweep: T8's two named properties ─────────────────────────

  /**
   * **ONE EVENT PER BATCH PER THRESHOLD, ACROSS TWO SWEEPS** — T8's acceptance, verbatim. A single
   * sweep cannot show this: everything is announced once by definition the first time.
   */
  it("announces once per (batch, threshold) — a second sweep on the same day says nothing", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    const b70 = await aBatch(itemId, storeId, "B-70", 70, 10);
    const b40 = await aBatch(itemId, storeId, "B-40", 40, 10);
    const b10 = await aBatch(itemId, storeId, "B-10", 10, 10);

    const first = await sweepBatchExpiry(db, NOW);
    expect(first.announced).toHaveLength(3);
    // Each at its TIGHTEST crossed band: 70→90, 40→60, 10→30.
    expect(new Map(first.announced.map((a) => [a.batchId, a.thresholdDays]))).toEqual(new Map([
      [b70, 90], [b40, 60], [b10, 30],
    ]));
    expect(await expiringEvents()).toHaveLength(3);

    // THE SECOND SWEEP, same day, same data: NOTHING new. A job that re-announced every morning is
    // a job an operator mutes, and a muted expiry watch is worse than none.
    const second = await sweepBatchExpiry(db, NOW);
    expect(second.announced).toEqual([]);
    expect(await expiringEvents()).toHaveLength(3);

    // …and the claim is recorded on the batch row, which is what makes it survive a restart.
    const rows = await db.select().from(stockBatches).where(eq(stockBatches.id, b40));
    expect(rows[0]?.expiryNotifiedThresholds).toEqual([60]);
  });

  /**
   * The other half of "once per threshold": as the batch gets closer it crosses the NEXT band and
   * is announced again — once. Three sweeps at three instants produce exactly three events for one
   * batch, never one and never nine.
   */
  it("announces AGAIN when the batch crosses the next band, and only then", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    // 85 days out at NOW: inside 90, outside 60.
    const batchId = await aBatch(itemId, storeId, "B-1", 85, 10);

    await sweepBatchExpiry(db, NOW);
    expect((await expiringEvents()).map((e) => e.thresholdDays)).toEqual([90]);

    // 30 days later it is 55 days out — inside 60.
    const later = new Date(NOW.getTime() + 30 * 86_400_000);
    await sweepBatchExpiry(db, later);
    expect((await expiringEvents()).map((e) => e.thresholdDays)).toEqual([90, 60]);
    // …and a repeat sweep at the same instant adds nothing.
    await sweepBatchExpiry(db, later);
    expect(await expiringEvents()).toHaveLength(2);

    // 30 days later again: 25 days out — inside 30.
    const later2 = new Date(NOW.getTime() + 60 * 86_400_000);
    await sweepBatchExpiry(db, later2);
    expect((await expiringEvents()).map((e) => e.thresholdDays)).toEqual([90, 60, 30]);

    // And past the last band there is nothing left to say — the batch is expired, and the worklist
    // (not a fourth event) is where an expired batch is dealt with.
    const later3 = new Date(NOW.getTime() + 90 * 86_400_000);
    await sweepBatchExpiry(db, later3);
    expect(await expiringEvents()).toHaveLength(3);
    expect((await db.select().from(stockBatches).where(eq(stockBatches.id, batchId)))[0]
      ?.expiryNotifiedThresholds).toEqual([90, 60, 30]);
  });

  /** **NONE FOR A ZERO-ON-HAND BATCH** — T8's acceptance, verbatim. */
  it("says NOTHING about a batch with no stock anywhere", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    await aBatch(itemId, storeId, "B-NEVER-RECEIVED", 10, 0);
    // …and one that WAS received and has since been fully issued out.
    const drained = await aBatch(itemId, storeId, "B-DRAINED", 10, 5);
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: drained, qtyDelta: -5, reason: "issue", occurredAt: NOW },
    ]));

    const { announced } = await sweepBatchExpiry(db, NOW);
    expect(announced).toEqual([]);
    expect(await expiringEvents()).toEqual([]);
    expect(await expiringBatches(db, NOW)).toEqual([]);
  });

  it("says nothing about a batch with NO expiry date at all", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    const id = newId();
    await db.insert(stockBatches).values({
      id, itemId, batchNo: "B-UNDATED", expiryDate: null, landedCostPaise: 100,
      ownership: "owned", createdBy: HEAD.id,
    });
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: id, qtyDelta: 10, reason: "grn", occurredAt: NOW },
    ]));
    expect((await sweepBatchExpiry(db, NOW)).announced).toEqual([]);
    expect(await expiringBatches(db, NOW)).toEqual([]);
  });

  it("an ALREADY EXPIRED batch with stock is the most urgent row, and is announced at 30", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    await aBatch(itemId, storeId, "B-PAST", -5, 10);
    const list = await expiringBatches(db, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.daysRemaining).toBe(-5);
    expect((await sweepBatchExpiry(db, NOW)).announced.map((a) => a.thresholdDays)).toEqual([30]);
  });

  it("the event carries what a worklist row needs, and NO alert is raised", async () => {
    const itemId = await anItem();
    const storeId = await aStore();
    const batchId = await aBatch(itemId, storeId, "B-1", 40, 12);
    await sweepBatchExpiry(db, NOW);
    const rows = await db.select({ payload: events.payload }).from(events)
      .where(eq(events.name, "batch.expiring"));
    expect(rows[0]?.payload).toMatchObject({
      batchId, itemId, batchNo: "B-1", expiryDate: inDays(40),
      thresholdDays: 60, qtyOnHandTotal: 12,
    });
    // DD14: an EVENT and a WORKLIST, not an alert. Nothing routed one.
    const alerts = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    expect(alerts).toEqual([]);
  });
});
