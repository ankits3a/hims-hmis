import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  consignmentLots, events, formularyMedicines, stockBatches, vendorDocuments,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { registerItem, setPriceRegulation } from "./items";
import { createStore } from "./stores";
import { balances, movementsFor, postMovements } from "./ledger";
import { registerVendor } from "./vendors";
import { consignmentDeployed } from "./events";
import { consumptionsFor, handleConsignmentDeployed } from "./consumption";
import type { MovementInput } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T7 / DD13 — the consignment consumer, and the interface Plan 15 imports.
 *
 * ═══ A20's FIXTURE — THE PLAN GOT THIS EXACTLY BACKWARDS, AND IT WAS MEASURED ═══
 *
 * The plan says the obvious fixture (lot `received 1, deployed 1`, deploy one more) cannot
 * discriminate because `postMovement` would refuse `insufficient_stock` too, and prescribes keeping
 * the balance ≥ 1 "by receiving a second, OWNED batch of the same item into the same store".
 *
 * **Both halves are wrong, and the mutants say so.**
 *
 *   · A second OWNED batch does not help AT ALL: the deployment names a specific `batchId`, and a
 *     balance is keyed `(resource, batch)`. Stock on a different batch of the same item is not
 *     stock on THIS batch. The only shape that leaves the batch healthy while ONE lot is exhausted
 *     is a SECOND LOT against the SAME batch — which is a real case the consumer's own comment
 *     anticipates ("one batch can back several lots").
 *   · With that corrected fixture the movement-first mutant **SURVIVES**, because both
 *     implementations run in ONE transaction: the throw rolls the movement back either way, so
 *     "writes NOTHING" is a property of the transaction and not of the order of the checks.
 *   · **The obvious fixture is the DISCRIMINATOR**, on the refusal's CODE: with both the lot and
 *     the balance exhausted, the shipped code checks the lot first and says `lot_exhausted`; the
 *     movement-first mutant reaches `postMovement` first and says `insufficient_stock`. Measured:
 *     `Expected: "lot_exhausted"  Received: "insufficient_stock"`.
 *
 * Both legs are kept below — the corrected one as the assertion, the plan's as the property it
 * genuinely proves. The Assertion Book row is corrected in the phase document.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const OCCURRED = new Date("2026-08-27T06:00:00Z");

describe("the consignment consumer (Plan 14 T7 / DD13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function anItem(code = "IMPLANT-X"): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: "Titanium plate 6-hole", class: "implant",
      baseUom: "each", batchTracked: true,
      uoms: [{ uom: "box", toBaseMultiplier: 5 }],
    }));
    void medicineId;
    return itemId;
  }

  /**
   * The mini-OT's shape: a consignment lot of ONE implant in the OT's bin, plus — where the test
   * needs it — a SECOND OWNED batch of the same item in the same store, so the balance outlives the
   * lot. See the file header.
   */
  /**
   * ═══ CLOSE REVIEW M3 — `mrpUom` IS A PARAMETER NOW, AND THAT IS THE WHOLE FINDING ═══
   *
   * Every leg in this file used to pin the batch's `mrpUom` to `"each"` — **the item's BASE unit**
   * — so `mrpPerBaseUnit` multiplied by 1 and every unit conversion in the consumer was a no-op.
   * The payload could mix a per-PACK MRP with a per-BASE ceiling and no assertion here could tell,
   * because in this fixture the two units were the same unit.
   *
   * **That is a SEVENTH §2.102 coinciding-field trap and it is the one that hid a money defect.**
   * The six the phase's standing note already names are about ordering and identity; this one is
   * about UNITS, and its cost is a factor-of-five error in a patient's bill rather than a test that
   * fails to discriminate. `mrpUom === baseUom` belongs on the list.
   */
  async function fixture(opts: {
    received?: number; deployed?: number; secondLot?: number;
    /** The unit the batch's MRP is PRINTED on. `"box"` is 5 × the base unit `"each"`. */
    mrpUom?: string;
  } = {}): Promise<{
    itemId: string; storeId: string; vendorId: string; batchId: string; lotId: string;
  }> {
    const itemId = await anItem();
    const { resourceId: storeId } = await withTx(db, (tx) =>
      createStore(tx, HEAD, { code: "OT-BIN", name: "OT consignment bin" }));
    const { vendorId } = await withTx(db, (tx) =>
      registerVendor(tx, HEAD, { code: "IMPLANTCO", legalName: "ImplantCo Pvt Ltd" }));
    const docId = newId();
    await db.insert(vendorDocuments).values({
      id: docId, vendorId, type: "consignment_agreement", number: "CA/1",
      validFrom: "2026-01-01", validTo: "2027-12-31", createdBy: HEAD.id,
    });

    const received = opts.received ?? 2;
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId, batchNo: "LOT-A", expiryDate: "2029-06-30",
      mrpPaise: 4500000, mrpUom: opts.mrpUom ?? "each", landedCostPaise: 3000000,
      vendorId, ownership: "consignment", createdBy: HEAD.id,
    });
    const lotId = newId();
    await db.insert(consignmentLots).values({
      id: lotId, vendorId, agreementDocumentId: docId, challanNo: "CH/OT/1",
      challanDate: "2026-08-01", itemId, batchId, storeResourceId: storeId,
      qtyReceived: received, qtyDeployed: opts.deployed ?? 0, qtyReturned: 0,
      deemedSupplyDeadline: "2027-01-28", status: "open", createdBy: HEAD.id,
    });

    const movements: MovementInput[] = [
      { resourceId: storeId, batchId, qtyDelta: received, reason: "grn", occurredAt: OCCURRED },
    ];
    if ((opts.deployed ?? 0) > 0) {
      movements.push({
        resourceId: storeId, batchId, qtyDelta: -(opts.deployed ?? 0),
        reason: "consume", occurredAt: OCCURRED,
      });
    }
    /**
     * **A SECOND LOT AGAINST THE SAME BATCH** — the corrected A20 fixture (see the file header).
     * A second challan of the same physical batch number is a real case, and it is the only shape
     * that leaves the BATCH balance healthy while ONE lot is exhausted. A second OWNED batch — what
     * the plan prescribed — cannot do it: a balance is keyed `(resource, batch)`, so stock on
     * another batch of the same item is not stock on this one.
     */
    if ((opts.secondLot ?? 0) > 0) {
      await db.insert(consignmentLots).values({
        id: newId(), vendorId, agreementDocumentId: docId, challanNo: "CH/OT/2",
        challanDate: "2026-08-05", itemId, batchId, storeResourceId: storeId,
        qtyReceived: opts.secondLot ?? 0, qtyDeployed: 0, qtyReturned: 0,
        deemedSupplyDeadline: "2027-02-01", status: "open", createdBy: HEAD.id,
      });
      movements.push({
        resourceId: storeId, batchId, qtyDelta: opts.secondLot ?? 0,
        reason: "grn", occurredAt: OCCURRED,
      });
    }
    await withTx(db, (tx) => postMovements(tx, HEAD, movements));
    return { itemId, storeId, vendorId, batchId, lotId };
  }

  function deployment(f: { itemId: string; storeId: string; batchId: string; lotId: string }, over: Record<string, unknown> = {}) {
    return {
      lotId: f.lotId, batchId: f.batchId, itemId: f.itemId, storeResourceId: f.storeId,
      qtyBase: 1, patientId: "pat-1", encounterId: "enc-1",
      caseRef: { type: "ot_case", id: "case-1" },
      stickerRef: "STK-0001",
      occurredAt: OCCURRED.toISOString(),
      ...over,
    };
  }

  async function eventsNamed(name: string): Promise<{ payload: unknown }[]> {
    return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
  }

  // ══════════════════════════ the happy path, and the interface it ships ══════════════════════════

  it("a deployment appends ONE consume row, increments the lot, and emits material.consumed", async () => {
    const f = await fixture({ received: 2 });
    const { handled, ledgerEntryId } = await withTx(db, (tx) =>
      handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));
    expect(handled).toBe(true);

    // The BALANCE moved through the ledger's own lock.
    expect((await balances(db, { batchId: f.batchId }))[0]?.qtyOnHand).toBe(1);
    const consumes = (await movementsFor(db, { batchId: f.batchId })).filter((r) => r.reason === "consume");
    expect(consumes).toHaveLength(1);
    expect(consumes[0]?.id).toBe(ledgerEntryId);
    expect(consumes[0]?.qtyDelta).toBe(-1);
    expect(consumes[0]?.patientId).toBe("pat-1");
    expect(consumes[0]?.encounterId).toBe("enc-1");
    // The event that caused it is traceable FROM the ledger row.
    expect(consumes[0]?.eventId).toBe("evt-1");
    expect(consumes[0]?.refType).toBe("ot_case");
    expect(consumes[0]?.refId).toBe("case-1");

    // The LOT counter.
    const lot = (await db.select().from(consignmentLots).where(eq(consignmentLots.id, f.lotId)))[0];
    expect(lot?.qtyDeployed).toBe(1);

    // The event, with the price facts a bill will need — and NO charge posted anywhere.
    const consumed = await eventsNamed("material.consumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.payload).toMatchObject({
      ledgerEntryId, itemId: f.itemId, batchId: f.batchId,
      ownership: "consignment", vendorId: f.vendorId, qtyBase: 1,
      patientId: "pat-1", encounterId: "enc-1",
      caseRef: { type: "ot_case", id: "case-1" },
      // AS PRINTED, with its unit beside it — and, since M3, the same price expressed per BASE
      // unit under a name that says so. Here `mrpUom` IS the base unit, so the two agree; the leg
      // below is the one where they must not.
      mrpPaise: 4500000, mrpUom: "each", mrpPaisePerBase: 4500000,
    });
  });

  it("`consumptionsFor` is the read Plan 15 composes a discharge bill from, ordered by seq", async () => {
    const f = await fixture({ received: 3 });
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-2", deployment(f, {
      occurredAt: new Date("2026-08-20T02:00:00Z").toISOString(), // EARLIER than the first
    })));

    const rows = await consumptionsFor(db, "enc-1");
    expect(rows).toHaveLength(2);
    // `seq` order — the ARRIVAL order — not `occurred_at`, which runs backwards here on purpose.
    expect(rows[0]?.seq).toBeLessThan(rows[1]?.seq ?? 0);
    expect(rows[0]?.occurredAt.getTime()).toBeGreaterThan(rows[1]?.occurredAt.getTime() ?? 0);
    // The quantity is a MAGNITUDE: a caller composing a bill should not have to know the ledger's
    // sign convention.
    expect(rows.map((r) => r.qtyBase)).toEqual([1, 1]);
    expect(rows[0]?.ownership).toBe("consignment");
    expect(rows[0]?.vendorId).toBe(f.vendorId);
    expect(rows[0]?.mrpPaise).toBe(4500000);
    // M5 — the read carries what a bill's clamp actually needs: both operands in ONE unit, and the
    // case the consumption belongs to. Plan 15 composes the bill from THIS call and no other.
    expect(rows[0]?.mrpPaisePerBase).toBe(4500000);
    expect(rows[0]?.ceilingPaisePerBase).toBeNull();
    expect(rows[0]?.caseRef).toEqual({ type: "ot_case", id: "case-1" });
    // A different encounter sees nothing.
    expect(await consumptionsFor(db, "enc-other")).toEqual([]);
  });

  // ══════════════════════════ A19 — IDEMPOTENCE ══════════════════════════

  /**
   * **A19, with the plan's discriminating input: the SAME event delivered twice.** One ledger row,
   * `qty_deployed` incremented ONCE. A consumer that skipped the claim writes two consume rows and
   * doubles the counter — and the second row would look exactly like a second implant.
   */
  it("A19: the same event twice writes ONE ledger row and increments qty_deployed ONCE", async () => {
    const f = await fixture({ received: 2 });
    const first = await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-dup", deployment(f)));
    const second = await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-dup", deployment(f)));
    const third = await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-dup", deployment(f)));

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(third.handled).toBe(false);
    expect(second.ledgerEntryId).toBeUndefined();

    expect((await movementsFor(db, { batchId: f.batchId })).filter((r) => r.reason === "consume")).toHaveLength(1);
    expect((await db.select().from(consignmentLots).where(eq(consignmentLots.id, f.lotId)))[0]?.qtyDeployed).toBe(1);
    expect((await balances(db, { batchId: f.batchId }))[0]?.qtyOnHand).toBe(1);
    expect(await eventsNamed("material.consumed")).toHaveLength(1);

    // A DIFFERENT event id for the same deployment IS a second implant, and is handled.
    const other = await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-other", deployment(f)));
    expect(other.handled).toBe(true);
    expect((await db.select().from(consignmentLots).where(eq(consignmentLots.id, f.lotId)))[0]?.qtyDeployed).toBe(2);
  });

  // ══════════════════════════ A20 — THE LOT CHECK, BEFORE THE MOVEMENT ══════════════════════════

  /**
   * **A20, THE DISCRIMINATING LEG — and it is the fixture the plan called non-discriminating.**
   *
   * The lot is exhausted AND the batch balance is exhausted. The shipped code checks the lot FIRST,
   * so the refusal names the LOT; a movement-first implementation reaches `postMovement` first and
   * names the BALANCE. **The code is the observable.** Measured against the mutant:
   * `Expected: "lot_exhausted"  Received: "insufficient_stock"`.
   *
   * Why this matters operationally rather than pedantically: `insufficient_stock` tells a scrub
   * nurse "the shelf is empty", which is a picking problem; `lot_exhausted` tells them "this implant
   * is not on the vendor's challan", which is doc 09 §6.3's Friday evening and a phone call to the
   * rep. Two different next actions from one physical situation.
   */
  it("A20: a deployment beyond the lot names the LOT, not the balance, and writes NOTHING", async () => {
    const f = await fixture({ received: 1, deployed: 1 });
    const before = await movementsFor(db, {});
    const balancesBefore = await balances(db, {});

    try {
      await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-over", deployment(f)));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("lot_exhausted");
      expect((e as MaterialsError).detail).toMatchObject({
        remaining: 0, required: 1, qtyReceived: 1, qtyDeployed: 1, qtyReturned: 0,
      });
    }

    // NOTHING was written: no ledger row, no balance change, no counter change, no event.
    expect(await movementsFor(db, {})).toHaveLength(before.length);
    expect(await balances(db, {})).toEqual(balancesBefore);
    expect((await db.select().from(consignmentLots).where(eq(consignmentLots.id, f.lotId)))[0]?.qtyDeployed).toBe(1);
    expect(await eventsNamed("material.consumed")).toHaveLength(0);
  });

  /**
   * **A20's OTHER leg — the plan's fixture, kept for the property it genuinely proves.**
   *
   * A second LOT backs the same batch, so the batch balance is healthy (5) while lot A is
   * exhausted. The refusal still names the LOT, which proves the check is per-LOT and not merely a
   * restatement of the balance. It does NOT discriminate the movement-first mutant — both
   * implementations run in one transaction and the throw rolls the movement back either way — and
   * saying so is the point of the file header.
   */
  it("A20: one batch, TWO lots — an exhausted lot refuses even when the batch is healthy", async () => {
    const f = await fixture({ received: 1, deployed: 1, secondLot: 5 });
    // The BATCH has stock: 1 received + 5 from the second lot, minus the 1 already deployed.
    expect((await balances(db, { batchId: f.batchId }))[0]?.qtyOnHand).toBe(5);
    const before = (await movementsFor(db, {})).length;
    try {
      await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-lotA", deployment(f)));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("lot_exhausted");
      expect((e as MaterialsError).detail).toMatchObject({ remaining: 0, required: 1 });
    }
    expect(await movementsFor(db, {})).toHaveLength(before);
    expect(await eventsNamed("material.consumed")).toHaveLength(0);
  });

  it("a deployment against the WRONG lot for the batch is refused", async () => {
    const f = await fixture({ received: 2 });
    const otherBatch = newId();
    await db.insert(stockBatches).values({
      id: otherBatch, itemId: f.itemId, batchNo: "LOT-B", expiryDate: "2029-06-30",
      landedCostPaise: 1, ownership: "consignment", createdBy: HEAD.id,
    });
    await expect(withTx(db, (tx) => handleConsignmentDeployed(
      tx, HEAD, "evt-x", deployment(f, { batchId: otherBatch }),
    ))).rejects.toThrow(/is against batch/);
  });

  it("an unknown lot refuses with a code", async () => {
    const f = await fixture({ received: 2 });
    await expect(withTx(db, (tx) => handleConsignmentDeployed(
      tx, HEAD, "evt-y", deployment(f, { lotId: newId() }),
    ))).rejects.toThrow(/consignment lot .* not found/);
  });

  // ══════════════════════════ A21 — THE REGULATION AT `occurredAt` ══════════════════════════

  /**
   * **A21, with the plan's discriminating input: TWO regulation rows — one effective BEFORE
   * `occurredAt` with ceiling C1, one effective AFTER `occurredAt` but before now with C2.** The
   * shipped consumer carries C1; a consumer asking `effectiveRegulation(itemId, now())` carries C2.
   * **One regulation row does not discriminate**, and that leg is the control below.
   */
  it("A21: material.consumed carries the ceiling effective at occurredAt, not at processing time", async () => {
    const f = await fixture({ received: 2 });
    // C1 — in force when the implant went into the patient.
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, f.itemId, {
      ceilingPaise: 4000000, mrpUom: "each",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "NPPA/2026/1",
    }));
    /**
     * C2 — gazetted AFTER the deployment (06:00) but BEFORE this test runs.
     *
     * **The first draft of this leg put C2 on 2026-08-28, which is in the FUTURE relative to the
     * real clock — so `effectiveRegulation(now())` still returned C1 and the leg was VACUOUS: it
     * passed against the mutant.** The plan's own wording is precise ("effective after `occurredAt`
     * but BEFORE now") and the fixture simply failed to instantiate it. Recorded because a green
     * assertion that cannot fail is worse than no assertion.
     */
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, f.itemId, {
      ceilingPaise: 3500000, mrpUom: "each",
      effectiveFrom: new Date("2026-08-27T07:00:00Z"), gazetteRef: "NPPA/2026/2",
    }));

    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));

    const consumed = await eventsNamed("material.consumed");
    expect(consumed).toHaveLength(1);
    // **C1**, the ceiling in force on 27 August — not C2, the one in force today.
    expect((consumed[0]?.payload as { ceilingPaisePerBase: number }).ceilingPaisePerBase).toBe(4000000);
    expect((consumed[0]?.payload as { occurredAt: string }).occurredAt).toBe(OCCURRED.toISOString());
  });

  it("A21 control: ONE regulation row cannot discriminate — both implementations agree", async () => {
    const f = await fixture({ received: 2 });
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, f.itemId, {
      ceilingPaise: 4000000, mrpUom: "each",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "NPPA/2026/1",
    }));
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));
    expect(((await eventsNamed("material.consumed"))[0]?.payload as { ceilingPaisePerBase: number }).ceilingPaisePerBase)
      .toBe(4000000);
  });

  /**
   * ═══ CLOSE REVIEW M3 — THE LEG THIS FILE DID NOT HAVE, AND THE DEFECT IT WOULD HAVE CAUGHT ═══
   *
   * The item is `each`-based and sold in boxes of five. The MRP is printed **on the box**
   * (₹45,000/box) and the NPPA ceiling is notified **on the box** too (₹40,000/box). Per base unit
   * those are ₹9,000 and ₹8,000 — and the implant is under the cap, comfortably.
   *
   * **What shipped put `mrpPaise: 4500000` (per BOX) in the payload beside a `ceilingPaise` that
   * had been silently divided down to 800000 (per EACH), with nothing in either name to say so.**
   * Plan 15's discharge bill applies `min(tariff, MRP, ceiling)` from this payload. Comparing
   * 4,500,000 with 800,000 says the implant is more than five times over a government price cap —
   * on an item that is not over it at all — and the bill would have been clamped to a fifth of the
   * legitimate price, or the case flagged as a pricing offence. Either way a real number, wrong by
   * the pack multiplier, in a patient's bill.
   *
   * Both fields now carry their unit in the NAME, and this leg asserts the two `…PerBase` figures
   * against each other in the one fixture where the multiplier is not 1. **Every other leg in this
   * file passes with or without the fix.**
   */
  it("M3: the MRP and the ceiling reach the payload in ONE unit when the pack is not the base unit", async () => {
    const f = await fixture({ received: 2, mrpUom: "box" });
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, f.itemId, {
      ceilingPaise: 4000000, mrpUom: "box",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "NPPA/2026/1",
    }));
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));

    const payload = (await eventsNamed("material.consumed"))[0]?.payload as {
      mrpPaise: number; mrpUom: string; mrpPaisePerBase: number; ceilingPaisePerBase: number;
    };
    // AS PRINTED, on the pack it is printed on — unchanged, and still paired with its unit.
    expect({ mrpPaise: payload.mrpPaise, mrpUom: payload.mrpUom })
      .toEqual({ mrpPaise: 4500000, mrpUom: "box" });
    // AND per base unit, both of them, which is the pair a bill compares.
    expect({ mrp: payload.mrpPaisePerBase, ceiling: payload.ceilingPaisePerBase })
      .toEqual({ mrp: 900000, ceiling: 800000 });
    /**
     * The consequence, stated as an assertion rather than left to the reader: under the cap when
     * the operands share a unit, and 5.6× over it when they do not. This is the line that fails
     * against the shipped payload.
     */
    expect(payload.mrpPaisePerBase > payload.ceilingPaisePerBase).toBe(true);
    expect(payload.mrpPaise / payload.ceilingPaisePerBase).toBeCloseTo(5.625, 3);
  });

  /** M5 — the same fact through the READ Plan 15 actually calls, not just through the event. */
  it("M5: `consumptionsFor` returns both operands per base unit, resolved per row", async () => {
    const f = await fixture({ received: 2, mrpUom: "box" });
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, f.itemId, {
      ceilingPaise: 4000000, mrpUom: "box",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "NPPA/2026/1",
    }));
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));

    const rows = await consumptionsFor(db, "enc-1");
    expect(rows).toHaveLength(1);
    expect({
      printed: rows[0]?.mrpPaise, unit: rows[0]?.mrpUom,
      mrp: rows[0]?.mrpPaisePerBase, ceiling: rows[0]?.ceilingPaisePerBase,
      caseRef: rows[0]?.caseRef,
    }).toEqual({
      printed: 4500000, unit: "box",
      mrp: 900000, ceiling: 800000,
      caseRef: { type: "ot_case", id: "case-1" },
    });
  });

  /**
   * An unconvertible price is carried as NULL and never throws — the implant is already in the
   * patient. `"drum"` is not one of this item's units, so `mrpPerBaseUnit` refuses it.
   */
  it("M3: a price that cannot be expressed per base unit is null, and the consumption still records", async () => {
    const f = await fixture({ received: 2, mrpUom: "drum" });
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));

    const payload = (await eventsNamed("material.consumed"))[0]?.payload as {
      mrpPaise: number; mrpUom: string; mrpPaisePerBase: number | null;
    };
    expect({ printed: payload.mrpPaise, unit: payload.mrpUom, perBase: payload.mrpPaisePerBase })
      .toEqual({ printed: 4500000, unit: "drum", perBase: null });
    // The stock still moved and the lot still drew down: a price we cannot restate is not a reason
    // to lose the clinical record.
    expect((await consumptionsFor(db, "enc-1"))).toHaveLength(1);
  });

  it("NO regulation at all carries a null ceiling rather than failing", async () => {
    const f = await fixture({ received: 2 });
    await withTx(db, (tx) => handleConsignmentDeployed(tx, HEAD, "evt-1", deployment(f)));
    expect(((await eventsNamed("material.consumed"))[0]?.payload as { ceilingPaisePerBase: number | null })
      .ceilingPaisePerBase).toBeNull();
  });

  // ══════════════════════════ the frozen interface itself ══════════════════════════

  /**
   * **DD13's payload, asserted as a CONTRACT.** Plan 15 is written against these field names; a
   * rename here is a break in another plan's code, so the shape is pinned rather than left to the
   * zod object to imply.
   */
  it("consignment.deployed's payload is the frozen DD13 shape Plan 15 imports", () => {
    expect(consignmentDeployed.name).toBe("consignment.deployed");
    expect(consignmentDeployed.module).toBe("materials");
    const ok = consignmentDeployed.payloadSchema.safeParse({
      lotId: "l", batchId: "b", itemId: "i", storeResourceId: "s", qtyBase: 1,
      patientId: "p", encounterId: "e", caseRef: { type: "ot_case", id: "c" },
      occurredAt: "2026-08-27T06:00:00.000Z",
    });
    expect(ok.success).toBe(true);
    // `stickerRef` is OPTIONAL — not every consignment item carries one (bone cement does not).
    expect(consignmentDeployed.payloadSchema.safeParse({
      lotId: "l", batchId: "b", itemId: "i", storeResourceId: "s", qtyBase: 1,
      patientId: "p", encounterId: "e", caseRef: { type: "ot_case", id: "c" },
      stickerRef: "STK-1", occurredAt: "2026-08-27T06:00:00.000Z",
    }).success).toBe(true);
    // A quantity of zero or a fraction is NOT a deployment.
    expect(consignmentDeployed.payloadSchema.safeParse({
      lotId: "l", batchId: "b", itemId: "i", storeResourceId: "s", qtyBase: 0,
      patientId: "p", encounterId: "e", caseRef: { type: "ot_case", id: "c" },
      occurredAt: "2026-08-27T06:00:00.000Z",
    }).success).toBe(false);
    // `patientId` and `encounterId` are REQUIRED: an implant with no patient is a stock issue.
    expect(consignmentDeployed.payloadSchema.safeParse({
      lotId: "l", batchId: "b", itemId: "i", storeResourceId: "s", qtyBase: 1,
      caseRef: { type: "ot_case", id: "c" }, occurredAt: "2026-08-27T06:00:00.000Z",
    }).success).toBe(false);
  });
});
