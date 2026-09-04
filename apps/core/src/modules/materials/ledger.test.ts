import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, resources, stockBatches, stockBalances } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { registerItem } from "./items";
import { createStore, ensureTransitStore, findStoreByCode, listStores, requireStore } from "./stores";
import {
  balances, batchLocations, consumeReservation, fefoPick, movementsFor, postMovement, postMovements,
  recallBatch, releaseReservation, reserveStock,
} from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T5 — the stock ledger, and the stores it keys on.
 *
 * ═══ EVERY §2.102 COINCIDENCE THIS TASK COULD HIDE BEHIND IS BROKEN ON PURPOSE ═══
 *
 * The phase's standing note names six, and FIVE of them bite here:
 *   · **one store** hides the `(resource, batch)` key and A12's whole subject → the recall fixture
 *     holds one batch in THREE stores, and the balance legs use two.
 *   · **one batch per item** hides FEFO → the FEFO fixture has three, and the LATER-CREATED one
 *     expires EARLIEST (A10's discriminating shape).
 *   · **`occurred_at = recorded_at`** hides the downtime convention → one leg writes them apart.
 *   · **`ownership = 'owned'` everywhere** hides DD5 → the balance legs carry an `owned` and a
 *     `consignment` batch of the SAME item and batch number.
 *   · **`qty_in_uom = qty_base`** is T3's and T6's; the ledger is base units throughout by design.
 *
 * A8 and A9 are NOT here. They need two connections and a barrier, and they live in
 * `ledger.concurrency.test.ts` — where an idle host cannot pass them by luck.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const T0 = new Date("2026-08-27T06:00:00Z");

describe("the stock ledger (Plan 14 T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function anItem(code = "CROC500", cls = "drug"): Promise<string> {
    let medicineId: string | null = null;
    if (cls === "drug") {
      medicineId = newId();
      await db.insert(formularyMedicines).values({
        id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
        createdBy: HEAD.id, updatedBy: HEAD.id,
      });
    }
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `Item ${code}`, class: cls, formularyMedicineId: medicineId,
      baseUom: "tablet", batchTracked: true,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    }));
    return itemId;
  }

  async function aStore(code: string): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code, name: `Store ${code}` }));
    return resourceId;
  }

  async function aBatch(
    itemId: string,
    over: { batchNo?: string; expiryDate?: string | null; ownership?: string; landedCostPaise?: number } = {},
  ): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({
      id, itemId, batchNo: over.batchNo ?? `B-${id.slice(0, 6)}`,
      expiryDate: over.expiryDate === undefined ? "2027-06-30" : over.expiryDate,
      landedCostPaise: over.landedCostPaise ?? 100,
      ownership: over.ownership ?? "owned", createdBy: HEAD.id,
    });
    return id;
  }

  // ══════════════════════════ stores ══════════════════════════

  it("a store is a registry resource of kind `store`, and a room is not one", async () => {
    const storeId = await aStore("MAIN");
    const store = await requireStore(db, storeId);
    expect(store.kind).toBe("store");
    expect(store.status).toBe("available");

    // A `room` resource passes the FOREIGN KEY and must still be refused: the FK says "this is a
    // resource", and only `requireStore` says "this is a place stock can be".
    const roomId = newId();
    await db.insert(resources).values({
      id: roomId, kind: "room", code: "OPD-1", name: "OPD 1", status: "available",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    try {
      await requireStore(db, roomId);
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("unknown_store");
      expect((e as MaterialsError).message).toContain('is a "room"');
    }
  });

  it("ensureTransitStore is lazy and idempotent, and listStores hides it — in one predicate", async () => {
    await aStore("MAIN");
    await aStore("PHARM");
    // Not there until something needs it.
    expect(await findStoreByCode(db, "IN-TRANSIT")).toBeUndefined();
    expect((await listStores(db)).map((s) => s.code)).toEqual(["MAIN", "PHARM"]);

    const transitId = await withTx(db, (tx) => ensureTransitStore(tx));
    const again = await withTx(db, (tx) => ensureTransitStore(tx));
    expect(again).toBe(transitId);

    // EXCLUDED from the picker — DD9's one predicate in one reader…
    expect((await listStores(db)).map((s) => s.code)).toEqual(["MAIN", "PHARM"]);
    // …and visible when asked for, because for the ledger it is a real place.
    expect((await listStores(db, { includeTransit: true })).map((s) => s.code))
      .toEqual(["IN-TRANSIT", "MAIN", "PHARM"]);
    expect((await requireStore(db, transitId)).code).toBe("IN-TRANSIT");
  });

  // ══════════════════════════ movements and balances ══════════════════════════

  it("posts a movement, materialises the balance in the SAME transaction, and appends the row", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);

    const { ledgerEntryId, balanceAfter } = await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 300, reason: "grn", refType: "grn", refId: "g1",
      occurredAt: T0,
    }));
    expect(balanceAfter).toBe(300);
    const [bal] = await balances(db, { batchId });
    expect(bal?.qtyOnHand).toBe(300);
    expect(bal?.qtyReserved).toBe(0);
    expect(bal?.qtyFrozen).toBe(0);
    expect(bal?.itemId).toBe(itemId);
    const rows = await movementsFor(db, { batchId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ledgerEntryId);
    expect(rows[0]?.qtyDelta).toBe(300);
    expect(rows[0]?.actorId).toBe(HEAD.id);
  });

  it("an outbound movement is NEGATIVE, and the balance never goes below zero", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -4, reason: "issue", occurredAt: T0,
    }));
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(6);

    try {
      await withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId, qtyDelta: -7, reason: "issue", occurredAt: T0,
      }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("insufficient_stock");
      expect((e as MaterialsError).detail).toMatchObject({ available: 6, required: 7 });
    }
    // Nothing moved and nothing was written — the refusal is BEFORE the append.
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(6);
    expect(await movementsFor(db, { batchId })).toHaveLength(2);

    // Taking the last unit to EXACTLY zero is legal — `>= 0`, not `> 0`.
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -6, reason: "issue", occurredAt: T0,
    }));
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(0);
  });

  it("a movement of ZERO is refused — the ledger records changes, not non-events", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 0, reason: "grn", occurredAt: T0,
    }))).rejects.toThrow(/is not a movement/);
  });

  /**
   * Two lines against the SAME `(resource, batch)` are checked TOGETHER. Checked one at a time,
   * a pair that is individually affordable and jointly not slips through — the classic aggregation
   * defect, and the reason `postMovements` exists rather than a loop in the caller.
   */
  it("a multi-line movement checks the NET delta per balance, not each line alone", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    // 6 + 6 = 12 against 10. Each line alone is affordable; together they are not.
    await expect(withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId, qtyDelta: -6, reason: "issue", occurredAt: T0 },
      { resourceId: storeId, batchId, qtyDelta: -6, reason: "issue", occurredAt: T0 },
    ]))).rejects.toThrow(/available/);
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(10);
    // …and a pair that fits writes BOTH rows and one final balance.
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId, qtyDelta: -6, reason: "issue", occurredAt: T0 },
      { resourceId: storeId, batchId, qtyDelta: -4, reason: "issue", occurredAt: T0 },
    ]));
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(0);
    expect(await movementsFor(db, { batchId })).toHaveLength(3);
  });

  /**
   * `(resource, batch)` is the KEY, so the same batch in two stores is two balances — and DD5's
   * ownership dimension falls out of the join rather than needing a column. This fixture carries an
   * `owned` and a `consignment` batch of the SAME item and the SAME batch number, which the unique
   * key permits precisely because they are two piles with two owners.
   */
  it("balances are per (resource, batch), and ownership per location is a JOIN", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ot = await aStore("OT");
    const owned = await aBatch(itemId, { batchNo: "B-001", ownership: "owned" });
    const consigned = await aBatch(itemId, { batchNo: "B-001", ownership: "consignment" });

    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId: owned, qtyDelta: 100, reason: "grn", occurredAt: T0 },
      { resourceId: ot, batchId: owned, qtyDelta: 20, reason: "grn", occurredAt: T0 },
      { resourceId: ot, batchId: consigned, qtyDelta: 5, reason: "grn", occurredAt: T0 },
    ]));
    expect((await balances(db, { itemId })).map((b) => b.qtyOnHand).reduce((a, c) => a + c, 0)).toBe(125);
    expect(await balances(db, { resourceId: ot })).toHaveLength(2);
    expect((await balances(db, { resourceId: main }))[0]?.qtyOnHand).toBe(100);
    // The OWNED `B-001` pile lives in two stores; the CONSIGNMENT `B-001` pile in one. Same item,
    // same batch number, different owners — which is exactly what DD5's three-part unique key is
    // for, and what a `(item, batch_no)` key would have merged.
    expect((await balances(db, { batchId: owned })).map((b) => b.qtyOnHand).sort((x, y) => x - y))
      .toEqual([20, 100]);
    expect((await balances(db, { batchId: consigned })).map((b) => b.qtyOnHand)).toEqual([5]);
  });

  // ══════════════════════════ A10 — FEFO ══════════════════════════

  /**
   * **A10, with the plan's discriminating fixture: two batches of one item where the LATER-CREATED
   * one expires EARLIER, plus a third, earliest-expiring, that is FROZEN.** A pick ordered by `id`
   * (creation order) returns the earlier-created one; the shipped code returns the later-created,
   * earlier-expiring one. **Creation order = expiry order is the coinciding fixture and it cannot
   * discriminate** (§2.102).
   */
  it("A10: FEFO picks the EARLIEST-EXPIRING batch, never the earliest-created", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    // Created FIRST, expires LAST.
    const late = await aBatch(itemId, { batchNo: "B-LATE", expiryDate: "2028-01-31" });
    // Created SECOND, expires FIRST of the two available.
    const early = await aBatch(itemId, { batchNo: "B-EARLY", expiryDate: "2027-01-31" });
    // Created THIRD, expires EARLIEST OF ALL — and is FROZEN, so it must be skipped entirely.
    const frozen = await aBatch(itemId, { batchNo: "B-FROZEN", expiryDate: "2026-09-30" });

    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: late, qtyDelta: 50, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: early, qtyDelta: 30, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: frozen, qtyDelta: 90, reason: "grn", occurredAt: T0 },
    ]));
    await withTx(db, (tx) => recallBatch(tx, HEAD, frozen, "supplier recall"));

    // 10 comes entirely from the earliest-expiring AVAILABLE batch.
    expect(await fefoPick(db, storeId, itemId, 10)).toEqual([{ batchId: early, qty: 10 }]);
    // 40 exhausts it and spills into the later one, IN ORDER.
    expect(await fefoPick(db, storeId, itemId, 40)).toEqual([
      { batchId: early, qty: 30 }, { batchId: late, qty: 10 },
    ]);
    // The frozen batch is never offered, even though it expires first and holds the most.
    expect((await fefoPick(db, storeId, itemId, 200)).map((p) => p.batchId)).not.toContain(frozen);
    // A short pick returns what it CAN — the caller decides whether that is an error.
    expect((await fefoPick(db, storeId, itemId, 200)).reduce((a, p) => a + p.qty, 0)).toBe(80);
  });

  it("A10: a batch with NO expiry sorts LAST, not first", async () => {
    const itemId = await anItem("GLOVES", "consumable");
    const storeId = await aStore("MAIN");
    const undated = await aBatch(itemId, { batchNo: "B-NONE", expiryDate: null });
    const dated = await aBatch(itemId, { batchNo: "B-DATED", expiryDate: "2027-01-31" });
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: undated, qtyDelta: 10, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: dated, qtyDelta: 10, reason: "grn", occurredAt: T0 },
    ]));
    // NULLS LAST: a batch with no expiry is not "expiring first". Sorting nulls first would empty
    // the undated stock before anything perishable, which is backwards.
    expect((await fefoPick(db, storeId, itemId, 15)).map((p) => p.batchId)).toEqual([dated, undated]);
  });

  /**
   * PLAN 16c CLOSE REVIEW — FEFO ORDERED BY EXPIRY AND NEVER FILTERED ON IT.
   *
   * The recall exclusion has been in this query from the start; expiry was only ever a SORT KEY. So
   * the first batch FEFO offered was the most expired one the store held, and the pharmacy counter
   * — which takes `offered[0]` — dispensed expired medicine by preference. `expiry_date` is the
   * last day a batch may be used, so today's date is still good and yesterday's is not.
   */
  it("A10b: an EXPIRED batch is excluded, not merely sorted first — and one expiring TODAY is still good", async () => {
    const itemId = await anItem("PCM500", "drug");
    const storeId = await aStore("MAIN");
    const dead = await aBatch(itemId, { batchNo: "B-DEAD", expiryDate: "2026-08-31" });
    const today = await aBatch(itemId, { batchNo: "B-TODAY", expiryDate: "2026-09-01" });
    const later = await aBatch(itemId, { batchNo: "B-LATER", expiryDate: "2027-01-31" });
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: storeId, batchId: dead, qtyDelta: 10, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: today, qtyDelta: 10, reason: "grn", occurredAt: T0 },
      { resourceId: storeId, batchId: later, qtyDelta: 10, reason: "grn", occurredAt: T0 },
    ]));
    const asOf = new Date("2026-09-01T04:00:00.000Z"); // 09:30 IST on the day B-TODAY expires (stock received T0, 27 Aug)
    const picked = await fefoPick(db, storeId, itemId, 30, asOf);
    expect(picked.map((p) => p.batchId)).toEqual([today, later]);
    expect(picked.reduce((a, p) => a + p.qty, 0)).toBe(20); // the expired ten are not offered at all
    // and the day after, today's batch drops out too
    expect((await fefoPick(db, storeId, itemId, 30, new Date("2026-09-02T04:00:00.000Z"))).map((p) => p.batchId))
      .toEqual([later]);
  });

  it("FEFO offers only AVAILABLE quantity — reserved and frozen are subtracted", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => reserveStock(tx, HEAD, {
      resourceId: storeId, batchId, qty: 7, refType: "ot_case", refId: "case-1",
    }));
    expect((await fefoPick(db, storeId, itemId, 10)).reduce((a, p) => a + p.qty, 0)).toBe(3);
    // …and a movement sees the same number.
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -4, reason: "issue", occurredAt: T0,
    }))).rejects.toThrow(/available/);
  });

  // ══════════════════════════ reservations ══════════════════════════

  it("a reservation holds stock without moving it, and releasing gives it back", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    const { reservationId } = await withTx(db, (tx) => reserveStock(tx, HEAD, {
      resourceId: storeId, batchId, qty: 6, refType: "ot_case", refId: "case-1",
    }));
    let bal = (await balances(db, { batchId }))[0];
    // ON HAND is unchanged — nothing moved. Only what is SPOKEN FOR changed.
    expect(bal?.qtyOnHand).toBe(10);
    expect(bal?.qtyReserved).toBe(6);
    expect(await movementsFor(db, { batchId })).toHaveLength(1);

    // A second reservation cannot exceed what is left.
    await expect(withTx(db, (tx) => reserveStock(tx, HEAD, {
      resourceId: storeId, batchId, qty: 5, refType: "ot_case", refId: "case-2",
    }))).rejects.toThrow(/available/);

    await withTx(db, (tx) => releaseReservation(tx, HEAD, reservationId));
    bal = (await balances(db, { batchId }))[0];
    expect(bal?.qtyOnHand).toBe(10);
    expect(bal?.qtyReserved).toBe(0);
  });

  it("consuming a reservation drops the hold and moves the stock in ONE transaction", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    const { reservationId } = await withTx(db, (tx) => reserveStock(tx, HEAD, {
      resourceId: storeId, batchId, qty: 6, refType: "ot_case", refId: "case-1",
    }));
    const { balanceAfter } = await withTx(db, (tx) => consumeReservation(tx, HEAD, reservationId, {
      reason: "consume", occurredAt: T0, refType: "ot_case", refId: "case-1",
    }));
    expect(balanceAfter).toBe(4);
    const bal = (await balances(db, { batchId }))[0];
    expect(bal?.qtyOnHand).toBe(4);
    // The hold is gone WITH the movement — a residual reservation would double-count the stock.
    expect(bal?.qtyReserved).toBe(0);
    await expect(withTx(db, (tx) => releaseReservation(tx, HEAD, reservationId)))
      .rejects.toThrow(/already "consumed"/);
  });

  // ══════════════════════════ A12 — THE ONE-ACTION RECALL ══════════════════════════

  /**
   * **A12, with the plan's fixture: ONE batch held in THREE stores.** A recall that froze only the
   * store the caller passed would leave two locations live — and `recallBatch` takes NO store
   * argument at all, because a batch is bad everywhere it is. **One store cannot discriminate.**
   */
  it("A12: a recall freezes EVERY location in one transaction and names all of them in ONE event", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ot = await aStore("OT");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, { batchNo: "B-BAD" });
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
      { resourceId: ot, batchId, qtyDelta: 20, reason: "grn", occurredAt: T0 },
      { resourceId: ward, batchId, qtyDelta: 7, reason: "grn", occurredAt: T0 },
    ]));

    const { locations } = await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "NPPA recall 2026/44"));

    // ALL THREE, and `qty_frozen` equals `qty_on_hand` at each.
    const after = await batchLocations(db, batchId);
    expect(after).toHaveLength(3);
    for (const b of after) {
      expect({ store: b.resourceId, frozen: b.qtyFrozen, onHand: b.qtyOnHand })
        .toEqual({ store: b.resourceId, frozen: b.qtyOnHand, onHand: b.qtyOnHand });
    }
    expect(locations).toHaveLength(3);
    expect(locations.map((l) => l.qtyFrozen).sort((a, b) => a - b)).toEqual([7, 20, 100]);

    // ONE event, naming all three (§11.10: "one-action freeze at every location").
    const recalled = await db.select({ payload: events.payload }).from(events)
      .where(eq(events.name, "batch.recalled"));
    expect(recalled).toHaveLength(1);
    expect((recalled[0]?.payload as { locations: unknown[] }).locations).toHaveLength(3);

    // …and NOTHING may leave ANY of them now.
    for (const store of [main, ot, ward]) {
      await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: store, batchId, qtyDelta: -1, reason: "issue", occurredAt: T0,
      }))).rejects.toThrow(/recall-frozen/);
    }
    // …nor may it be reserved, nor picked by FEFO.
    await expect(withTx(db, (tx) => reserveStock(tx, HEAD, {
      resourceId: main, batchId, qty: 1, refType: "ot_case", refId: "c",
    }))).rejects.toThrow(/recall-frozen/);
    expect(await fefoPick(db, main, itemId, 1)).toEqual([]);
  });

  /**
   * A `return` INTO a frozen batch stays possible, and that is the safe direction: recalled stock
   * coming back from a ward must have somewhere to land. Only OUTBOUND is refused (DD14).
   */
  it("a frozen batch refuses OUTBOUND movement but accepts a return", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: main, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "recall"));
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: main, batchId, qtyDelta: -1, reason: "issue", occurredAt: T0,
    }))).rejects.toThrow(/recall-frozen/);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: main, batchId, qtyDelta: 3, reason: "return", occurredAt: T0,
    }));
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(13);
  });

  // ══════════════════════════ ordering and the downtime convention ══════════════════════════

  /**
   * `seq` is the ordering key, not `id` and not `occurred_at`. The fixture writes ids in DESCENDING
   * lexical order and `occurred_at` BACKWARDS, so a reader sorting by either would return these
   * rows in a different order than the one they arrived in.
   */
  it("movementsFor is ordered by `seq` — not by `id`, and not by `occurred_at`", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 10, reason: "grn",
      occurredAt: new Date("2026-08-27T10:00:00Z"), refId: "first",
    }));
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -1, reason: "issue",
      // EARLIER than the row before it — the downtime convention, backwards on purpose.
      occurredAt: new Date("2026-08-20T02:00:00Z"), refId: "second",
    }));
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -1, reason: "issue",
      occurredAt: new Date("2026-08-24T02:00:00Z"), refId: "third",
    }));
    expect((await movementsFor(db, { batchId })).map((r) => r.refId)).toEqual(["first", "second", "third"]);
    expect((await movementsFor(db, { batchId }, { order: "desc" })).map((r) => r.refId))
      .toEqual(["third", "second", "first"]);
    expect((await movementsFor(db, { batchId }, { limit: 2 })).map((r) => r.refId)).toEqual(["first", "second"]);
  });

  it("occurred_at may precede recorded_at, and the balance check applies in RECORDED order", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 5, reason: "grn",
      occurredAt: new Date("2026-08-20T02:00:00Z"),
      recordedAt: new Date("2026-08-27T09:00:00Z"),
    }));
    const [row] = await movementsFor(db, { batchId });
    expect(row?.occurredAt.getTime()).toBeLessThan(row?.recordedAt.getTime() ?? 0);

    // DD6: negative stock is refused FULL STOP — a backdated issue does not get an exception just
    // because it "happened" before the receipt that would have covered it. That case is 16c's, with
    // 11c's downtime kit, and the refusal here is chosen rather than defaulted.
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -9, reason: "issue",
      occurredAt: new Date("2026-08-19T02:00:00Z"),
    }))).rejects.toThrow(/available/);
  });

  // ══════════════════════════ A11 — APPEND-ONLY, ASSERTED AS AN ABSENCE ══════════════════════════

  /**
   * **A11, and the plan names it a WEAK row in as many words** — *"it is a grep and an absence,
   * kept because the reviewer should confirm the absence rather than infer it."* Both halves are
   * here so the confirmation is executed rather than asserted:
   *
   *   1. the module's public surface exports no updater or deleter for either table;
   *   2. `ledger.ts` contains no `update(stockLedger)` and no write to `stock_batches.ownership`.
   *
   * The second is a source-text assertion, which is unusual and deliberate: append-only here is not
   * a trigger, it is the ABSENCE OF CODE, and the only way to test an absence is to look.
   */
  it("A11: nothing anywhere updates the ledger, and nothing updates `ownership`", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const surface = require("./index") as Record<string, unknown>;
    const names = Object.keys(surface);
    expect(names.filter((n) => /^(update|delete|amend|reverse)(Ledger|Movement|Batch)/.test(n))).toEqual([]);

    const src = readFileSync(resolve(__dirname, "ledger.ts"), "utf8");
    // The ledger table is INSERTed and SELECTed and never UPDATEd or DELETEd.
    expect(src).toContain("insert(stockLedger)");
    expect(src).not.toContain("update(stockLedger)");
    expect(src).not.toContain("delete(stockLedger)");
    // `ownership` is written by T6's find-or-create and by nothing here; this file must not touch it.
    expect(src).not.toContain("ownership:");

    // And the property itself, observed: a batch's ownership survives every movement path above.
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId, { ownership: "consignment" });
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 5, reason: "grn", occurredAt: T0,
    }));
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: -2, reason: "consume", occurredAt: T0,
    }));
    await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "recall"));
    const rows = await db.select().from(stockBatches).where(eq(stockBatches.id, batchId));
    expect(rows[0]?.ownership).toBe("consignment");
  });

  it("the database refuses a negative balance even when raw SQL tries", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    const batchId = await aBatch(itemId);
    await withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId, qtyDelta: 5, reason: "grn", occurredAt: T0,
    }));
    // The CHECK is the backstop the code's refusal sits in front of (DD6). This is the path a
    // future migration would take, and it is the one the constraint exists for.
    await expect(db.update(stockBalances).set({ qtyOnHand: -1 })
      .where(eq(stockBalances.batchId, batchId)))
      .rejects.toThrow(/stock_balances_non_negative_ck/);
  });

  it("an unknown batch or an unknown store refuses with a code, not a foreign-key error", async () => {
    const itemId = await anItem();
    const storeId = await aStore("MAIN");
    await expect(withTx(db, (tx) => postMovement(tx, HEAD, {
      resourceId: storeId, batchId: newId(), qtyDelta: 1, reason: "grn", occurredAt: T0,
    }))).rejects.toThrow(/batch .* not found/);
    await expect(requireStore(db, newId())).rejects.toThrow(/not found/);
  });
});
