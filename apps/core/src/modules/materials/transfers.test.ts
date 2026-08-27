import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, stockBatches } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { registerItem } from "./items";
import { createStore, findStoreByCode } from "./stores";
import { balances, movementsFor, postMovements, recallBatch } from "./ledger";
import { getTransfer, issueStock, listDiscrepancies, listTransfers, receiveStock } from "./transfers";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T7 / DD9 — two-sided issue, and the discrepancy that is a row rather than an adjustment.
 *
 * ═══ §2.102 ═══
 *
 *   · **one batch per item** hides FEFO, so the issue fixtures carry two whose expiry order is the
 *     OPPOSITE of their creation order.
 *   · **receive-all** is the fixture that cannot discriminate A18, and the plan says so; it is here
 *     as the control, and the assertion is the SHORT receive.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const T0 = new Date("2026-08-27T06:00:00Z");

describe("two-sided issue and receive (Plan 14 T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function anItem(code = "CROC500"): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `Item ${code}`, class: "drug", formularyMedicineId: medicineId,
      baseUom: "tablet", batchTracked: true,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    }));
    return itemId;
  }
  async function aStore(code: string): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code, name: `Store ${code}` }));
    return resourceId;
  }
  async function aBatch(itemId: string, batchNo: string, expiryDate: string): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({
      id, itemId, batchNo, expiryDate, landedCostPaise: 100, ownership: "owned", createdBy: HEAD.id,
    });
    return id;
  }
  async function eventsNamed(name: string): Promise<{ payload: unknown }[]> {
    return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
  }

  // ══════════════════════════ the transit store is a real place ══════════════════════════

  it("an issue moves stock INTO `IN-TRANSIT`, and it is visible there between the two signatures", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));

    const { transferId } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 30 }], occurredAt: T0,
    }));

    const transit = await findStoreByCode(db, "IN-TRANSIT");
    expect(transit).toBeDefined();
    // The source is down 30, TRANSIT holds 30, and the destination has nothing yet. "Where is the
    // stock right now" has an answer, which is the whole reason the transit store is a real row.
    expect((await balances(db, { resourceId: main }))[0]?.qtyOnHand).toBe(70);
    expect((await balances(db, { resourceId: transit?.id ?? "" }))[0]?.qtyOnHand).toBe(30);
    expect(await balances(db, { resourceId: ward })).toEqual([]);

    expect((await getTransfer(db, transferId))?.status).toBe("in_transit");
    const issued = await eventsNamed("material.issued");
    expect(issued).toHaveLength(1);
    expect((issued[0]?.payload as { lines: unknown[] }).lines).toHaveLength(1);
  });

  // ══════════════════════════ A18 — THE SHORTFALL ══════════════════════════

  /**
   * **A18, with the plan's discriminating input: issue 10, receive 7.** Destination 7, transit 3,
   * header `discrepancy`, event fired. **A18's mutant moves `qty_issued` regardless** — destination
   * 10, transit 0 — which fills a ward with stock nobody counted. **Receive-all does not
   * discriminate** and is the control below.
   */
  it("A18: issue 10, receive 7 — the THREE stay in transit and the header is flagged", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));

    const { transferId, lines } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    const lineId = lines[0]?.transferLineId ?? "";

    const { status, shortfalls } = await withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId, qtyReceived: 7 }], T0,
    ));

    expect(status).toBe("discrepancy");
    expect(shortfalls).toEqual([{ transferLineId: lineId, qtyShort: 3 }]);

    const transit = await findStoreByCode(db, "IN-TRANSIT");
    // **THE THREE ARE STILL IN TRANSIT.** Nothing wrote them off and nothing moved them onward.
    expect((await balances(db, { resourceId: ward }))[0]?.qtyOnHand).toBe(7);
    expect((await balances(db, { resourceId: transit?.id ?? "" }))[0]?.qtyOnHand).toBe(3);
    expect((await balances(db, { resourceId: main }))[0]?.qtyOnHand).toBe(90);
    // …and the three quantities still add up to what the hospital owns.
    expect((await balances(db, { itemId })).reduce((a, b) => a + b.qtyOnHand, 0)).toBe(100);

    const t = await getTransfer(db, transferId);
    expect(t?.status).toBe("discrepancy");
    expect(t?.lines[0]?.qtyIssued).toBe(10);
    expect(t?.lines[0]?.qtyReceived).toBe(7);
    expect(t?.lines[0]?.discrepancyReason).toBe("short_3");

    // SAME TRANSACTION as the receive (§11.10: "discrepancies surface same-hour").
    const flagged = await eventsNamed("material.discrepancy_flagged");
    expect(flagged).toHaveLength(1);
    expect((flagged[0]?.payload as { gaps: { qtyShort: number }[] }).gaps).toEqual([
      { transferLineId: lineId, batchId, qtyIssued: 10, qtyReceived: 7, qtyShort: 3 },
    ]);
    expect(await eventsNamed("material.received")).toHaveLength(1);
    // The worklist DD16's second tab renders.
    expect(await listDiscrepancies(db)).toHaveLength(1);
  });

  it("A18 control: RECEIVE-ALL cannot discriminate — both implementations move 10", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    const { transferId, lines } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    const { status } = await withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId: lines[0]?.transferLineId ?? "", qtyReceived: 10 }], T0,
    ));
    expect(status).toBe("received");
    const transit = await findStoreByCode(db, "IN-TRANSIT");
    expect((await balances(db, { resourceId: ward }))[0]?.qtyOnHand).toBe(10);
    expect((await balances(db, { resourceId: transit?.id ?? "" }))[0]?.qtyOnHand).toBe(0);
    expect(await eventsNamed("material.discrepancy_flagged")).toHaveLength(0);
    expect(await listDiscrepancies(db)).toEqual([]);
  });

  it("receiving ZERO is a total shortfall, not a no-op — everything stays in transit", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    const { transferId, lines } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    const { status } = await withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId: lines[0]?.transferLineId ?? "", qtyReceived: 0 }], T0,
    ));
    expect(status).toBe("discrepancy");
    const transit = await findStoreByCode(db, "IN-TRANSIT");
    expect((await balances(db, { resourceId: transit?.id ?? "" }))[0]?.qtyOnHand).toBe(10);
    expect(await balances(db, { resourceId: ward })).toEqual([]);
  });

  it("receiving MORE than was issued is refused — there is no source for the excess", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    const { transferId, lines } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    await expect(withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId: lines[0]?.transferLineId ?? "", qtyReceived: 11 }], T0,
    ))).rejects.toThrow(/more than was sent/);
  });

  // ══════════════════════════ FEFO, and the evented override ══════════════════════════

  it("an issue picks FEFO across batches, earliest expiry first", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    // Created FIRST, expires LAST — the §2.102 shape.
    const late = await aBatch(itemId, "B-LATE", "2029-01-31");
    const early = await aBatch(itemId, "B-EARLY", "2027-01-31");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId: late, qtyDelta: 50, reason: "grn", occurredAt: T0 },
      { resourceId: main, batchId: early, qtyDelta: 30, reason: "grn", occurredAt: T0 },
    ]));
    const { transferId } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 40 }], occurredAt: T0,
    }));
    const t = await getTransfer(db, transferId);
    // The earlier-EXPIRING batch is exhausted first, then the later one — two transfer lines.
    // `getTransfer` orders lines by their own ULID id (arrival order within the transfer), which is
    // NOT the pick order, so the comparison is made on a keyed map rather than on an array whose
    // order neither side controls. What is asserted is WHICH batch gave HOW MUCH.
    const issuedByBatch = Object.fromEntries((t?.lines ?? []).map((l) => [l.batchId, l.qtyIssued]));
    expect(issuedByBatch).toEqual({ [early]: 30, [late]: 10 });
    expect((await balances(db, { batchId: early, resourceId: main }))[0]?.qtyOnHand).toBe(0);
    expect((await balances(db, { batchId: late, resourceId: main }))[0]?.qtyOnHand).toBe(40);
  });

  it("naming a batch OVERRIDES FEFO, and the override needs a reason", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const late = await aBatch(itemId, "B-LATE", "2029-01-31");
    const early = await aBatch(itemId, "B-EARLY", "2027-01-31");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId: late, qtyDelta: 50, reason: "grn", occurredAt: T0 },
      { resourceId: main, batchId: early, qtyDelta: 30, reason: "grn", occurredAt: T0 },
    ]));
    // NO reason → refused. A silent override is indistinguishable from a FEFO failure.
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 5, batchId: late }], occurredAt: T0,
    }))).rejects.toThrow(/needs a reason/);

    const { transferId } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 5, batchId: late, overrideReason: "ward asked for the newer lot" }],
      occurredAt: T0,
    }));
    const t = await getTransfer(db, transferId);
    expect(t?.lines[0]?.batchId).toBe(late);
    // The override is RECORDED, so "why was the later batch issued" has an answer.
    expect(t?.lines[0]?.discrepancyReason).toContain("fefo_override");
    expect((await balances(db, { batchId: early, resourceId: main }))[0]?.qtyOnHand).toBe(30);
  });

  it("an issue exceeding what is available is refused BEFORE anything moves", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 10, reason: "grn", occurredAt: T0 },
    ]));
    try {
      await withTx(db, (tx) => issueStock(tx, HEAD, {
        fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 11 }], occurredAt: T0,
      }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("insufficient_stock");
    }
    expect((await balances(db, { resourceId: main }))[0]?.qtyOnHand).toBe(10);
    expect(await listTransfers(db)).toEqual([]);
    expect(await movementsFor(db, { batchId })).toHaveLength(1);
  });

  it("a recall-frozen batch cannot be issued", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "NPPA recall"));
    // FEFO skips it entirely, so the issue fails as "nothing available" rather than as "frozen" —
    // which is the honest answer: from the picker's point of view there IS no stock.
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 1 }], occurredAt: T0,
    }))).rejects.toThrow(/available/);
    // …and naming it explicitly is refused by the ledger itself.
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 1, batchId, overrideReason: "explicit" }], occurredAt: T0,
    }))).rejects.toThrow(/recall-frozen/);
  });

  it("a transfer cannot be received twice, and an unknown line is refused", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-001", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    const { transferId, lines } = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    const lineId = lines[0]?.transferLineId ?? "";
    await expect(withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId: newId(), qtyReceived: 1 }], T0,
    ))).rejects.toThrow(/is not on transfer/);

    await withTx(db, (tx) => receiveStock(tx, HEAD, transferId, [{ lineId, qtyReceived: 10 }], T0));
    await expect(withTx(db, (tx) => receiveStock(
      tx, HEAD, transferId, [{ lineId, qtyReceived: 10 }], T0,
    ))).rejects.toThrow(/cannot be received again/);
    // …and the stock moved exactly once.
    expect((await balances(db, { resourceId: ward }))[0]?.qtyOnHand).toBe(10);
  });

  it("a transfer to the SAME store, and one with no lines, are refused", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: main, lines: [{ itemId, qtyBase: 1 }], occurredAt: T0,
    }))).rejects.toThrow(/nothing to move/);
    const ward = await aStore("WARD-A");
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward, lines: [], occurredAt: T0,
    }))).rejects.toThrow(/at least one line/);
  });
});
