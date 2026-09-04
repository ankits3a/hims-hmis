import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, resources, stockBatches } from "../../kernel/db/schema";
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

  /**
   * ═══ CLOSE REVIEW m3 — A FEFO OVERRIDE MUST NAME A BATCH **OF** THE ITEM IT OVERRIDES ═══
   *
   * The override path took `itemId` and `batchId` from the caller and checked neither against the
   * other. `postMovements` reads the batch's OWN `item_id` for the ledger row, so the ledger and
   * the balances were always right — which is why the reviewer filed this MINOR.
   *
   * But the transfer LINE and the `material.issued` EVENT both carry the CALLER's `itemId`. A
   * transposed pair therefore produced a permanent, plausible, wrong record — "300 of paracetamol"
   * against a batch of insulin — in an append-only stream where nothing downstream can tell.
   */
  it("m3: an override naming a batch of a DIFFERENT item is refused `batch_mismatch`", async () => {
    const paracetamol = await anItem("CROC500");
    const insulin = await anItem("INSULIN");
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const insulinBatch = await aBatch(insulin, "INS-1", "2028-01-31");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId: insulinBatch, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));

    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      // The item is paracetamol; the batch is insulin's. Stock is plentiful, so nothing else refuses.
      lines: [{ itemId: paracetamol, qtyBase: 10, batchId: insulinBatch, overrideReason: "substitution" }],
      occurredAt: T0,
    }))).rejects.toMatchObject({ code: "batch_mismatch" });

    // NOTHING was written — not a transfer, not a ledger row, not an event.
    expect(await listTransfers(db, {})).toEqual([]);
    expect(await movementsFor(db, { batchId: insulinBatch })).toHaveLength(1); // the receipt only
    expect(await eventsNamed("material.issued")).toEqual([]);

    // A batch id that names nothing is a different refusal, and it keeps its own code.
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId: insulin, qtyBase: 10, batchId: newId(), overrideReason: "substitution" }],
      occurredAt: T0,
    }))).rejects.toMatchObject({ code: "unknown_batch" });

    // …and the CORRECT pairing still overrides FEFO, which is the behaviour this must not break.
    const ok = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId: insulin, qtyBase: 10, batchId: insulinBatch, overrideReason: "substitution" }],
      occurredAt: T0,
    }));
    expect(ok.lines[0]?.batchId).toBe(insulinBatch);
  });

  /**
   * ═══ CLOSE REVIEW M2 (and its own second-pass fix R1) — THE TRANSIT STORE'S COLD-START RACE ═══
   *
   * `ensureTransitStore` is a read-then-create, and the unique index on
   * `(site_id, kind, lower(code))` is what makes it safe: the loser re-reads instead of propagating
   * a constraint violation. **Two defects were stacked in that recovery.**
   *
   *   · **M2** — the `catch` tested for a raw Postgres `23505`, but `createResource` has ALREADY
   *     converted it to `ResourceError("duplicate_code")`, whose `.code` is a STRING. The
   *     comparison could never be true, so the re-read never ran and the race surfaced as an
   *     unmapped `ResourceError` — a **500 on `POST /materials/transfers`** for the second of two
   *     storekeepers issuing stock for the first time at a site.
   *   · **R1**, found reviewing the fix for M2 — fixing the predicate made the recovery REACHABLE
   *     and still broken. A unique violation ABORTS the enclosing Postgres transaction, so the
   *     re-read would have failed with `25P02 current transaction is aborted`: a second, more
   *     confusing error on top of the first. The create now runs in a SAVEPOINT (drizzle's nested
   *     `transaction()`), so only the failed insert rolls back.
   *
   * **The interleave is forced by the winner's own uncommitted tuple**, the C1 leg's instrument:
   * A creates the store and parks; B's read sees nothing (A is uncommitted), B's insert blocks on
   * A's tuple; A commits; B's savepoint rolls back and B re-reads the row A committed. Both return
   * the SAME id and exactly one `IN-TRANSIT` store exists.
   */
  it("M2/R1: two first-issues racing to create IN-TRANSIT both succeed on ONE store", async () => {
    const itemId = await anItem();
    const main = await aStore("MAIN");
    const ward = await aStore("WARD-A");
    const batchId = await aBatch(itemId, "B-1", "2028-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId, qtyDelta: 100, reason: "grn", occurredAt: T0 },
    ]));
    // The whole point: there is no transit store yet.
    expect(await findStoreByCode(db, "IN-TRANSIT")).toBeUndefined();

    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const delay = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

    const a = withTx(db, async (tx) => {
      const r = await issueStock(tx, HEAD, {
        fromResourceId: main, toResourceId: ward,
        lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
      });
      await gate;
      return r;
    });
    a.catch(() => { /* settled below */ });
    await delay(400);

    const b = withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 10 }], occurredAt: T0,
    }));
    b.catch(() => { /* settled below */ });

    // B is blocked on A's uncommitted `resources` row — a STATE, not a duration (§2.99).
    const state = await Promise.race([
      b.then(() => "settled", () => "settled"),
      delay(400).then(() => "pending"),
    ]);
    expect(state).toBe("pending");

    openGate();
    // BOTH fulfil. Before the fix the second was a `ResourceError` nobody mapped, i.e. a 500.
    const [ra, rb] = await Promise.all([a, b]);
    expect({ a: ra.lines.length, b: rb.lines.length }).toEqual({ a: 1, b: 1 });

    // ONE transit store, and both transfers went through it.
    const transit = await findStoreByCode(db, "IN-TRANSIT");
    expect(transit).toBeDefined();
    const allStores = await db.select().from(resources)
      .where(and(eq(resources.kind, "store"), eq(resources.code, "IN-TRANSIT")));
    expect(allStores).toHaveLength(1);
    // 20 tablets in transit, 80 left at MAIN — the arithmetic is intact through the race.
    expect((await balances(db, { resourceId: transit?.id ?? "" }))[0]?.qtyOnHand).toBe(20);
    expect((await balances(db, { resourceId: main }))[0]?.qtyOnHand).toBe(80);
  });

  /**
   * ═══ PASS 2 — THE OTHER `fefoPick` CALLER, AND THE CLOCK IT WAS DROPPING ═══
   *
   * The 16c close review stopped `fefoPick` OFFERING expired stock, which was a pharmacy-counter
   * CRITICAL. But `fefoPick` has two production callers and only the pharmacy one was tested: this
   * one changed underneath, silently, in the same commit. Two things needed pinning and neither
   * was.
   *
   * FIRST, that a transfer no longer ships expired stock by FEFO — the same argument as the
   * counter's, one warehouse further back: a batch that must not reach a patient must not be put
   * on a van to the ward that will hand it over.
   *
   * SECOND, the escape hatch, because `ledger.ts` ASSERTS it in prose — "stock that IS expired is
   * still transferable by NAMING its batch, which is how it reaches a quarantine or destruction
   * store". An unexecuted claim in a comment is exactly the shape the close review kept finding, so
   * it is executed here: expired stock still moves to QUARANTINE when a human names the batch and
   * says why, and that is the ONLY way it moves.
   *
   * The dates are all relative to `occurredAt` rather than to the wall clock, which is the third
   * thing this fixes: `issueStock` was calling `fefoPick` with no `asOf` at all, so a transfer
   * recorded after the fact picked the batches in date the day it was TYPED, not the day it
   * HAPPENED — and any test written the obvious way would have rotted into a date bomb.
   */
  it("FEFO will not ship EXPIRED stock, and naming the batch is the only way it reaches quarantine", async () => {
    const itemId = await anItem("PCM650");
    const main = await aStore("MAIN");
    const quarantine = await aStore("QUAR");
    // dated BEFORE both others, so an ordering-only FEFO puts it first
    const dead = await aBatch(itemId, "B-DEAD", "2026-08-01");
    /**
     * THE BATCH THAT DISCRIMINATES THE CLOCK. `T0` is 27 Aug 2026 and this batch dies on the 28th:
     * in date at the moment the issue HAPPENED, and long expired by the wall clock any later run of
     * this suite sees. Written the obvious way — one dead batch, one good one — this test passed
     * against the unfixed code, because a batch that is expired under both clocks cannot tell them
     * apart. It only asserts something because of this row.
     *
     * It also cannot rot: it depends on `new Date()` being AFTER a fixed past date, and time only
     * moves in that direction.
     */
    const edge = await aBatch(itemId, "B-EDGE", "2026-08-28");
    const good = await aBatch(itemId, "B-GOOD", "2027-06-30");
    await withTx(db, (tx) => postMovements(tx, HEAD, [
      { resourceId: main, batchId: dead, qtyDelta: 40, reason: "grn", occurredAt: T0 },
      { resourceId: main, batchId: edge, qtyDelta: 10, reason: "grn", occurredAt: T0 },
      { resourceId: main, batchId: good, qtyDelta: 10, reason: "grn", occurredAt: T0 },
    ]));

    // FEFO as of `occurredAt`: B-DEAD is skipped, and the earliest batch still IN DATE THAT DAY is
    // B-EDGE. Reading the wall clock instead skips B-EDGE too and reaches for B-GOOD.
    const issued = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: quarantine, occurredAt: T0,
      lines: [{ itemId, qtyBase: 10 }],
    }));
    expect(issued.lines.map((l) => l.batchId)).toEqual([edge]);

    // and the forty expired tablets are not stock any transfer can reach by asking for a quantity:
    // B-EDGE is spent, so only B-DEAD could cover this and FEFO will not offer it.
    await expect(withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: quarantine, occurredAt: T0,
      lines: [{ itemId, qtyBase: 20 }],
    }))).rejects.toThrow(MaterialsError);

    // NAMED, with a reason — the documented road to a quarantine store, and it works.
    const swept = await withTx(db, (tx) => issueStock(tx, HEAD, {
      fromResourceId: main, toResourceId: quarantine, occurredAt: T0,
      lines: [{ itemId, qtyBase: 40, batchId: dead, overrideReason: "expired — moved for destruction" }],
    }));
    expect(swept.lines).toEqual([expect.objectContaining({ batchId: dead, qtyIssued: 40 })]);
    expect((await balances(db, { resourceId: main, batchId: dead }))[0]?.qtyOnHand).toBe(0);
  });
});
