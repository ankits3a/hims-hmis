import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { assignRole } from "../../kernel/auth/permissions";
import { createUser } from "../../kernel/auth/identity";
import { seedSodPairs } from "../../kernel/auth/sod";
import { consignmentLots, events, roles, stockBatches, vendorDocuments } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { registerItem, setPriceRegulation } from "./items";
import { createStore } from "./stores";
import { balances, movementsFor, recallBatch } from "./ledger";
import { captureGrn, getGrn, listGrns, lotsForBatch, postGrn, requestNearExpiryAcceptance, runGateQc } from "./grn";
import { activateVendor, addVendorDocument, blacklistVendor, registerVendor } from "./vendors";
import type { CaptureLine } from "./grn";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import { formularyMedicines } from "../../kernel/db/schema";

/**
 * PLAN 14 T6 — the GRN gate, end to end against the database.
 *
 * The RULES are `qc.test.ts`'s, as arithmetic. What is asserted here is the machinery around them:
 * capture writes nothing to stock, QC records verdicts and moves nothing, post moves everything in
 * one transaction, and the three assertions that need real rows — **A14** (find-or-create the
 * batch), **A16** (O-8's agreement window), **A17** (the approval's STATUS).
 *
 * ═══ §2.102, AND THE ONE THAT BITES HARDEST HERE ═══
 *
 * `mrp = cost` is A15's discriminating leg in `qc.test.ts`, so **every fixture in THIS file gives
 * them different values** — a suite where they coincided would pass with rule 6 inverted. The
 * multiplier is 10 (a strip), never 1, so `qty_in_uom` and `qty_base` differ on every line.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const T0 = new Date("2026-08-27T06:00:00Z");
const CHALLAN = "2026-08-27";

describe("the GRN gate (Plan 14 T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function drugItem(code = "CROC500", over: { shelfLifeDays?: number } = {}): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `Item ${code}`, class: "drug", formularyMedicineId: medicineId,
      baseUom: "tablet", batchTracked: true, shelfLifeDays: over.shelfLifeDays ?? 1095,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }, { uom: "box", toBaseMultiplier: 100 }],
    }));
    return itemId;
  }

  async function aStore(code = "MAIN"): Promise<string> {
    const { resourceId } = await withTx(db, (tx) => createStore(tx, HEAD, { code, name: `Store ${code}` }));
    return resourceId;
  }

  async function aVendor(code = "ACME", opts: { agreementValidTo?: string | null } = {}): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, {
      code, legalName: "Acme Pharma Pvt Ltd",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    if (opts.agreementValidTo !== undefined) {
      await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
        type: "consignment_agreement", number: "CA/1",
        validFrom: "2026-01-01", validTo: opts.agreementValidTo,
      }));
    }
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    return vendorId;
  }

  /** A clean line: 3 boxes = 300 tablets, MRP 8500 a strip (850/tablet), cost 700/tablet. */
  function goodLine(itemId: string, over: Partial<CaptureLine> = {}): CaptureLine {
    return {
      itemId, uom: "box", qtyInUom: 3,
      batchNo: "B-001", mfgDate: "2026-01-01", expiryDate: "2028-06-30",
      mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700,
      ...over,
    };
  }

  async function mkOwner(): Promise<string> {
    await db.insert(roles).values({ key: "owner", title: "owner" }).onConflictDoNothing();
    await db.insert(roles).values({ key: "materials_head", title: "materials_head" }).onConflictDoNothing();
    const { id } = await createUser(db, {
      username: `head-${newId().slice(0, 10)}`, fullName: "Head", password: "correct horse battery",
    });
    await assignRole(db, { userId: id, roleKey: "materials_head", scopeType: "hospital" });
    return id;
  }

  // ══════════════════════════ capture → QC → post ══════════════════════════

  it("capture writes NO stock; QC writes NO stock; post moves everything at once", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();

    const { grnId, grnNo } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/2026/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    // The GRN number joins the house's daily grammar rather than a private counter.
    expect(grnNo).toMatch(/^GRN\d{6}\d{4}$/);
    let grn = await getGrn(db, grnId);
    expect(grn?.status).toBe("gate_qc");
    // DD7: "3 boxes" is stored as both, and they DIFFER.
    expect(grn?.lines[0]?.qtyInUom).toBe(3);
    expect(grn?.lines[0]?.qtyBase).toBe(300);
    // NOTHING has moved.
    expect(await balances(db, {})).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);

    const { status, verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(status).toBe("accepted");
    expect(verdicts[0]?.verdict).toBe("pass");
    grn = await getGrn(db, grnId);
    expect(grn?.lines[0]?.qtyAcceptedBase).toBe(300);
    expect(grn?.qcBy).toBe(HEAD.id);
    // STILL nothing moved.
    expect(await balances(db, {})).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);

    const { ledgerEntryIds } = await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect(ledgerEntryIds).toHaveLength(1);
    const [bal] = await balances(db, {});
    expect(bal?.qtyOnHand).toBe(300);
    expect(bal?.resourceId).toBe(storeId);
    const batch = (await db.select().from(stockBatches))[0];
    expect(batch?.batchNo).toBe("B-001");
    expect(batch?.ownership).toBe("owned");
    expect(batch?.landedCostPaise).toBe(700);
    expect(batch?.vendorId).toBe(vendorId);
    expect((await getGrn(db, grnId))?.status).toBe("posted");
    // ONE `grn.received`, and no `grn.rejected`.
    expect(await eventsNamed("grn.received")).toHaveLength(1);
    expect(await eventsNamed("grn.rejected")).toHaveLength(0);
    expect(await eventsNamed("grn.line_rejected")).toHaveLength(0);
  });

  async function eventsNamed(name: string): Promise<{ payload: unknown }[]> {
    return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
  }

  /**
   * ═══ CLOSE REVIEW m4 — DD8 RULE 8 IS RE-ASKED AT POST, BECAUSE QC's ANSWER HAS AN AGE ═══
   *
   * Rule 8 refuses a receipt into a recall-frozen batch, and it is evaluated in `runGateQc` — a
   * SEPARATE transaction, minutes or hours before `postGrn`. `recallBatch` is one action and DD14
   * gives it to `materials_head`; a recall is precisely the thing that happens between a delivery
   * arriving and its paperwork being posted.
   *
   * What that produced: `recallBatch` sets `qty_frozen = qty_on_hand` **at the moment of the
   * freeze**, so a receipt posted afterwards raised `qty_on_hand` and left `qty_frozen` behind.
   * `available()` — `on_hand − reserved − frozen` — then reported the new stock as AVAILABLE on a
   * batch under recall. Nothing could actually leave (`postMovements` refuses every outbound
   * movement of a frozen batch), but the recall screen and 14c's leakage triangle would both have
   * read a frozen batch as partly free — and a recall is the one place a wrong number gets acted on
   * in a hurry.
   *
   * The refusal is recoverable by design: `runGateQc` accepts a GRN in `accepted`, so re-running
   * gate QC rejects the affected line by rule 8 and the rest of the delivery posts.
   */
  it("m4: a batch frozen BETWEEN QC and post refuses the post, and re-running QC clears it", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();

    // A first delivery, posted — so the batch row exists and can be recalled.
    const first = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/M4/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, first.grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, first.grnId, T0));
    const batchId = (await db.select().from(stockBatches))[0]?.id ?? "";

    // A SECOND delivery of the same batch, captured and QC'd while the batch is still healthy.
    const second = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/M4/2", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    const qc = await withTx(db, (tx) => runGateQc(tx, HEAD, second.grnId));
    expect(qc.status).toBe("accepted"); // rule 8 was satisfied AT THAT MOMENT

    // …and NOW the recall lands, after the verdict and before the post.
    await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "supplier notice"));

    await expect(withTx(db, (tx) => postGrn(tx, HEAD, second.grnId, T0)))
      .rejects.toMatchObject({ code: "batch_frozen" });

    /**
     * The invariant the defect broke, asserted directly: on a frozen batch every unit on hand is
     * frozen. Without the refusal this read `{ onHand: 600, frozen: 300 }` — 300 tablets of
     * recalled stock showing as available to anything reading the balance.
     */
    const [bal] = await balances(db, { batchId });
    expect({ onHand: bal?.qtyOnHand, frozen: bal?.qtyFrozen })
      .toEqual({ onHand: 300, frozen: 300 });

    // And the GRN is not stuck: re-run gate QC, rule 8 rejects the line, the delivery closes.
    const requalified = await withTx(db, (tx) => runGateQc(tx, HEAD, second.grnId));
    expect({ status: requalified.status, rule: requalified.verdicts[0]?.rule })
      .toEqual({ status: "rejected", rule: "batch_frozen" });
    await withTx(db, (tx) => postGrn(tx, HEAD, second.grnId, T0));
    expect((await getGrn(db, second.grnId))?.status).toBe("posted");
    // Still 300, still wholly frozen: nothing was received into the recalled batch.
    const [after] = await balances(db, { batchId });
    expect({ onHand: after?.qtyOnHand, frozen: after?.qtyFrozen })
      .toEqual({ onHand: 300, frozen: 300 });
  });

  /**
   * ═══ CLOSE REVIEW M8 — `postGrn` ON AN UN-QC'd GRN SAYS `qc_not_run`, NOT `not_in_transit` ═══
   *
   * It threw `not_in_transit`, which `errors.ts` documents as *"`receiveStock` against a transfer
   * whose status is not `in_transit`"*. A GRN is not a transfer and has no `in_transit` status: the
   * code was BORROWED, which the same file forbids in as many words. A client told `not_in_transit`
   * about a GRN cannot act on it — the remedy is *run gate QC*, and nothing in the code said so.
   */
  it("M8: posting a GRN that has not been through gate QC refuses `qc_not_run`", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/M8/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    expect((await getGrn(db, grnId))?.status).toBe("gate_qc");
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0)))
      .rejects.toMatchObject({ code: "qc_not_run" });
    // A posted GRN is a different refusal, and it keeps its own code.
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0)))
      .rejects.toMatchObject({ code: "already_received" });
  });

  /**
   * ═══ CLOSE REVIEW M9 — THE LOT RECORDS THE AGREEMENT IT WAS RECEIVED UNDER ═══
   *
   * `createConsignmentLot` took `limit(1)` with **no `ORDER BY` and no validity filter**. QC rule 9
   * had already proved that SOME valid agreement exists; this then recorded an ARBITRARY one — and
   * with an expired `CA/2023` beside a current `CA/2026`, "arbitrary" is whichever the heap returns
   * first, which can differ between runs on the same data.
   *
   * The FK is what makes O-8 structural. Pointing it at an agreement the goods were NOT received
   * under is worse than not pointing it anywhere, because 14c's reconciliation and any statutory
   * audit will follow it in good faith.
   *
   * **The discriminating fixture is TWO agreements where the EXPIRED one is inserted FIRST**, so a
   * heap-order `limit(1)` returns exactly the wrong row — the §2.102 discipline applied to a
   * missing `ORDER BY`.
   */
  /**
   * ═══ SECOND-PASS FINDING F3 — M7's OTHER HALF: THE THROW MUST BE CAUGHT IN `qcContextFor` ═══
   *
   * M7 has two halves. `qc.test.ts` pins the second — rule 7 rejects when `ceilingUnconvertible` is
   * set — by handing `qcLine` a context built by hand. **Nothing tested the first**, which is the
   * half M7 is actually about: `qcContextFor` calling `mrpPerBaseUnit` on the CEILING outside any
   * `try`, so the throw escaped `runGateQc` and `materialsHttpStatus` answered **404 for the whole
   * delivery**. The second-pass reviewer measured it: deleting the `try`/`catch` in `grn.ts` left
   * the entire suite green.
   *
   * The path is reachable through shipped code. `setPriceRegulation` enforces the pair rule and
   * that `mrpUom` is one of the item's units — it does **not** check divisibility — so a gazette
   * entered as ₹85.05 per strip of ten is ACCEPTED at write time and only fails when a GRN is
   * gated against it. A price that does not divide into whole paise per base unit is refused
   * rather than rounded, deliberately (`uom.ts`), and that refusal has to become a LINE verdict.
   *
   * The second line is what makes this leg discriminating rather than decorative: **the rest of the
   * delivery must still post.** A per-line rule that takes the whole GRN down with it is the defect,
   * not the fix.
   */
  it("F3: an unconvertible CEILING rejects its line and leaves the rest of the delivery postable", async () => {
    const bad = await drugItem("CEIL-BAD");
    const good = await drugItem("CEIL-OK");
    const storeId = await aStore();
    const vendorId = await aVendor();

    // ₹85.05 per strip of TEN — 8505 % 10 = 5, so it does not divide into whole paise per tablet.
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, bad, {
      ceilingPaise: 8505, mrpUom: "strip",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "NPPA/BAD",
    }));

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/F3/1", challanDate: CHALLAN,
      lines: [goodLine(bad, { batchNo: "B-BAD" }), goodLine(good, { batchNo: "B-OK" })],
      now: T0,
    }));

    // It does NOT throw, and it does NOT 404: it returns a verdict per line.
    const { status, verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(status).toBe("partially_accepted");
    expect(verdicts.map((v) => ({ verdict: v.verdict, rule: v.rule })))
      .toEqual([
        { verdict: "reject", rule: "mrp_unconvertible" },
        { verdict: "pass", rule: undefined },
      ]);

    // …and the good line posts. One mistyped gazette costs one line, not a lorry.
    const { ledgerEntryIds } = await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect(ledgerEntryIds).toHaveLength(1);
    const posted = await getGrn(db, grnId);
    expect(posted?.lines.map((l) => l.qtyAcceptedBase).sort((a, b) => a - b)).toEqual([0, 300]);
  });

  it("M9: the consignment lot names the agreement VALID on the challan date, not an arbitrary one", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, {
      code: "CONSIGN-M9", legalName: "Consign Co Pvt Ltd",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    // The EXPIRED one first — heap order therefore favours the wrong answer.
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/2023",
      validFrom: "2023-01-01", validTo: "2023-12-31",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/2026",
      validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/M9/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));

    const [lot] = await db.select().from(consignmentLots);
    const [doc] = await db.select().from(vendorDocuments)
      .where(eq(vendorDocuments.id, lot?.agreementDocumentId ?? ""));
    expect({ number: doc?.number, validTo: doc?.validTo })
      .toEqual({ number: "CA/2026", validTo: "2027-12-31" });
  });

  /**
   * ═══ SECOND-PASS FINDING F4 — THE `ORDER BY` NEEDS TWO AGREEMENTS VALID **AT ONCE** ═══
   *
   * The M9 leg above pairs an EXPIRED agreement with a current one, so exactly one row survives the
   * validity filter and the `ORDER BY` is never exercised: an implementation carrying the `WHERE`
   * and no `ORDER BY` passes it unchanged. **That is §2.102 applied to a sort — the fixture makes
   * the ordering vacuous.**
   *
   * The case the ordering exists for is ordinary: a RENEWAL signed before the old agreement lapses,
   * so two are in force on the challan date. Both here are valid on 2026-08-27.
   *
   * And the second half is the `NULLS LAST` fix. An OPEN-ENDED agreement — `valid_from IS NULL`,
   * which the filter admits because `hasValidDocument` admits it — sorts FIRST under a plain
   * `desc`, so the vaguest document on file would win. It must lose to a dated one.
   */
  it("F4: with TWO agreements in force the LATEST-DATED wins, and an undated one never outranks a dated one", async () => {
    const itemId = await drugItem("CONSIGN-F4");
    const storeId = await aStore();
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, {
      code: "CONSIGN-F4", legalName: "Consign Co Pvt Ltd",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    // Inserted OLDEST-FIRST and UNDATED-FIRST, so heap order and a NULLS-FIRST sort both favour
    // the wrong answer. All three are valid on the challan date.
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/OPEN", validFrom: null, validTo: null,
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/OLD",
      validFrom: "2024-01-01", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, {
      type: "consignment_agreement", number: "CA/RENEWAL",
      validFrom: "2026-06-01", validTo: "2028-12-31",
    }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/F4/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));

    const [lot] = await db.select().from(consignmentLots);
    const [doc] = await db.select().from(vendorDocuments)
      .where(eq(vendorDocuments.id, lot?.agreementDocumentId ?? ""));
    /**
     * `CA/RENEWAL` — the most recently dated agreement in force. NOT `CA/OPEN` (which a NULLS-FIRST
     * `desc` returns) and NOT `CA/OLD` (which heap order returns, since it was inserted first among
     * the dated pair).
     */
    expect(doc?.number).toBe("CA/RENEWAL");
  });

  it("a FULLY REJECTED GRN writes NO ledger row and emits grn.rejected plus a line event each", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/2", challanDate: CHALLAN, now: T0,
      lines: [
        goodLine(itemId, { expiryDate: "2020-01-01" }),                    // expired
        goodLine(itemId, { batchNo: "B-2", mrpPaise: 500, mrpUom: "strip" }), // mrp below cost
      ],
    }));
    const { status } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(status).toBe("rejected");
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));

    // T6's acceptance, in as many words: a fully rejected GRN writes NO ledger row.
    expect(await movementsFor(db, {})).toEqual([]);
    expect(await balances(db, {})).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);
    expect(await eventsNamed("grn.rejected")).toHaveLength(1);
    expect(await eventsNamed("grn.received")).toHaveLength(0);
    // One per rejected line, each carrying the RULE that fired — 14b's scorecard counts by kind.
    const lineEvents = await eventsNamed("grn.line_rejected");
    expect(lineEvents).toHaveLength(2);
    expect(lineEvents.map((e) => (e.payload as { rule: string }).rule).sort())
      .toEqual(["expired", "mrp_below_cost"]);
  });

  it("a PARTIALLY accepted GRN posts only the accepted lines", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/3", challanDate: CHALLAN, now: T0,
      lines: [
        goodLine(itemId),
        goodLine(itemId, { batchNo: "B-BAD", expiryDate: "2020-01-01" }),
      ],
    }));
    expect((await withTx(db, (tx) => runGateQc(tx, HEAD, grnId))).status).toBe("partially_accepted");
    const { ledgerEntryIds } = await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect(ledgerEntryIds).toHaveLength(1);
    expect((await balances(db, {}))[0]?.qtyOnHand).toBe(300);
    // The rejected line's batch was never created.
    expect(await db.select().from(stockBatches)).toHaveLength(1);
    expect(await eventsNamed("grn.received")).toHaveLength(1);
    expect(await eventsNamed("grn.line_rejected")).toHaveLength(1);
  });

  // ══════════════════════════ A14 — FIND-OR-CREATE ══════════════════════════

  /**
   * **A14, with the plan's discriminating input: two GRNs of the same item and batch number, the
   * second with a DIFFERENT expiry.** The shipped code REFUSES with `batch_mismatch`. A post that
   * always inserts either violates the unique index (a constraint name, not a code) or, if the key
   * dropped `ownership`, silently creates a second pile. **The error CODE is what is asserted.**
   */
  it("A14: re-receiving a batch REUSES the row, and REFUSES when expiry or MRP disagree", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();

    async function receive(over: Partial<CaptureLine>, challanNo: string): Promise<string> {
      const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
        vendorId, source: "challan", storeResourceId: storeId,
        challanNo, challanDate: CHALLAN, lines: [goodLine(itemId, over)], now: T0,
      }));
      await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
      return grnId;
    }

    const first = await receive({}, "CH/A");
    await withTx(db, (tx) => postGrn(tx, HEAD, first, T0));
    expect(await db.select().from(stockBatches)).toHaveLength(1);
    const batchId = (await db.select().from(stockBatches))[0]?.id ?? "";

    // SAME batch number, SAME facts → the row is REUSED and the balance accumulates.
    const second = await receive({}, "CH/B");
    await withTx(db, (tx) => postGrn(tx, HEAD, second, T0));
    expect(await db.select().from(stockBatches)).toHaveLength(1);
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(600);
    // …and case-insensitively, because a batch number is read off a carton.
    const third = await receive({ batchNo: "b-001" }, "CH/C");
    await withTx(db, (tx) => postGrn(tx, HEAD, third, T0));
    expect(await db.select().from(stockBatches)).toHaveLength(1);
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(900);

    // DIFFERENT EXPIRY → refused with a CODE. One of the two challans is wrong and a human decides.
    const clash = await receive({ expiryDate: "2029-01-31" }, "CH/D");
    try {
      await withTx(db, (tx) => postGrn(tx, HEAD, clash, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("batch_mismatch");
    }
    // NOTHING changed — the refusal is inside the transaction, so the whole post rolled back.
    expect(await db.select().from(stockBatches)).toHaveLength(1);
    expect((await balances(db, { batchId }))[0]?.qtyOnHand).toBe(900);

    // A DIFFERENT MRP is the same refusal from the other side.
    const clash2 = await receive({ mrpPaise: 9500 }, "CH/E");
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, clash2, T0))).rejects.toThrow(/already exists with/);
  });

  /**
   * DD5's key includes OWNERSHIP, so the same batch number arriving on a purchase challan and on a
   * consignment challan is TWO piles. Merging them would put a vendor's stock on the hospital's
   * books — the money consequence the third key element exists for.
   */
  it("A14: the same batch number under two OWNERSHIPS is two batches, not a mismatch", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const owned = await aVendor("ACME");
    const consigned = await aVendor("IMPLANTCO", { agreementValidTo: "2027-12-31" });

    const g1 = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId: owned, source: "challan", storeResourceId: storeId,
      challanNo: "CH/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, g1.grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, g1.grnId, T0));

    const g2 = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId: consigned, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/2", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, g2.grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, g2.grnId, T0));

    const batches = await db.select().from(stockBatches);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.ownership).sort()).toEqual(["consignment", "owned"]);
    expect(batches.map((b) => b.batchNo)).toEqual(["B-001", "B-001"]);
  });

  // ══════════════════════════ A16 — O-8's AGREEMENT WINDOW ══════════════════════════

  /**
   * **A16, with the plan's discriminating input: a vendor with an agreement whose `valid_to` is the
   * day BEFORE the challan date.** The shipped code refuses; a check that ignores `valid_to`
   * accepts. **A vendor with no document at all does not discriminate** — and is here as the
   * control the plan names.
   */
  it("A16: a consignment challan is refused when the agreement EXPIRED YESTERDAY", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    // Agreement valid through 2026-08-26. The challan is dated 2026-08-27.
    const vendorId = await aVendor("IMPLANTCO", { agreementValidTo: "2026-08-26" });

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/X", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    const { status, verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(status).toBe("rejected");
    expect(verdicts[0]?.rule).toBe("agreement_missing");
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect(await db.select().from(consignmentLots)).toEqual([]);
    expect(await balances(db, {})).toEqual([]);
  });

  it("A16 control: NO agreement at all is also refused — which is why it cannot discriminate", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor("NODOC"); // no consignment_agreement at all
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/Y", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    const { verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(verdicts[0]?.rule).toBe("agreement_missing");
  });

  /**
   * The consignment lot, and its §31(7) deadline. **`challan_date + 180` EXACTLY, across a month
   * boundary and across a leap day** — §2.93's "verify a formula where its operands differ".
   */
  it("a consignment challan creates a lot with a deemed-supply deadline of challan + 180 days", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor("IMPLANTCO", { agreementValidTo: "2027-12-31" });

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/OT/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));

    const lots = await db.select().from(consignmentLots);
    expect(lots).toHaveLength(1);
    // 2026-08-27 + 180 days = 2027-02-23. Crosses four month boundaries and a year boundary.
    expect(lots[0]?.deemedSupplyDeadline).toBe("2027-02-23");
    expect(lots[0]?.qtyReceived).toBe(300);
    expect(lots[0]?.qtyDeployed).toBe(0);
    expect(lots[0]?.status).toBe("open");
    expect(lots[0]?.challanNo).toBe("CH/OT/1");
    // The lot points at the batch, and the batch is `consignment`-owned.
    const batch = (await db.select().from(stockBatches))[0];
    expect(lots[0]?.batchId).toBe(batch?.id);
    expect(batch?.ownership).toBe("consignment");
    expect(await lotsForBatch(db, batch?.id ?? "")).toHaveLength(1);
  });

  /**
   * **THE LEAP-DAY LEG, and the number is the evidence.**
   *
   * `2027-10-01 + 180 days` spans February 2028, which HAS 29 days. Counting month by month:
   * 30 (to Oct 31) + 30 (Nov) + 31 (Dec) + 31 (Jan) + **29 (Feb)** + 29 = 180, landing on
   * **2028-03-29**. The same span over a NON-leap February would land on 2028-03-30 — one day
   * later — so this single date distinguishes real day arithmetic from anything that approximates
   * 180 days as "six months" or "180/30 months".
   *
   * The first draft of this leg asserted 2028-03-28, which was the AUTHOR's arithmetic error and
   * not the code's; the failure is recorded here because a test that had been "fixed" by relaxing
   * it would have thrown away the only assertion that sees the leap day.
   */
  it("the deemed-supply deadline crosses a LEAP DAY correctly", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor("IMPLANTCO", { agreementValidTo: "2029-12-31" });
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/LEAP", challanDate: "2027-10-01",
      lines: [goodLine(itemId, { expiryDate: "2029-06-30" })], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect((await db.select().from(consignmentLots))[0]?.deemedSupplyDeadline).toBe("2028-03-29");

    // THE CONTRAST, so the leap day is visible rather than asserted: the SAME 180-day span one
    // year later spans a 28-day February and lands a day further into March.
    const { grnId: noLeap } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "consignment_challan", storeResourceId: storeId,
      challanNo: "CH/NOLEAP", challanDate: "2028-10-01",
      lines: [goodLine(itemId, { batchNo: "B-NL", expiryDate: "2029-06-30" })], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, noLeap));
    await withTx(db, (tx) => postGrn(tx, HEAD, noLeap, T0));
    const lots = await db.select().from(consignmentLots);
    expect(lots.find((l) => l.challanNo === "CH/NOLEAP")?.deemedSupplyDeadline).toBe("2029-03-30");
  });

  // ══════════════════════════ A17 — THE APPROVAL'S STATUS ══════════════════════════

  /**
   * **A17, with the plan's discriminating input: request the approval, do NOT approve, attempt the
   * post.** The shipped code refuses `near_expiry_unapproved` because it reads the approval's
   * STATUS. A post that checked `approval_id IS NOT NULL` would succeed — and `approval_id` is set
   * the moment the request is FILED, so that mutant approves everything it asks about.
   */
  it("A17: a near-expiry line posts only with a GRANTED approval, never a pending one", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    // A 180-day reagent: 75% of 180 is 135 days, so a batch 100 days out is near-expiry.
    const itemId = await drugItem("REAG", { shelfLifeDays: 180 });
    const storeId = await aStore();
    const vendorId = await aVendor();
    const headId = await mkOwner();

    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/NEAR", challanDate: CHALLAN, now: T0,
      lines: [goodLine(itemId, { expiryDate: "2026-12-05" })], // 100 days out
    }));
    const { status, verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    // near_expiry is ACCEPTED at the gate — it is not a rejection, it needs an approval.
    expect(status).toBe("accepted");
    expect(verdicts[0]?.verdict).toBe("near_expiry");
    expect((await getGrn(db, grnId))?.lines[0]?.nearExpiry).toBe(true);

    // NO approval requested at all → refused.
    try {
      await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("near_expiry_unapproved");
    }

    // REQUESTED but PENDING → still refused. This is the leg the mutant fails.
    const { approvalId } = await withTx(db, (tx) =>
      requestNearExpiryAcceptance(tx, HEAD, grnId, "fast mover, 100 days is fine"));
    expect((await getGrn(db, grnId))?.approvalId).toBe(approvalId);
    try {
      await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("near_expiry_unapproved");
    }
    expect(await balances(db, {})).toEqual([]);

    // GRANTED → posts, and the GRN carries the approval that was granted.
    await approveRequest(db, { type: "user", id: headId }, { approvalId, note: "accepted" });
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    expect((await balances(db, {}))[0]?.qtyOnHand).toBe(300);
    const grn = await getGrn(db, grnId);
    expect(grn?.status).toBe("posted");
    expect(grn?.approvalId).toBe(approvalId);
    // The event names the approval that allowed it — the audit trail for short-dated stock.
    const received = await eventsNamed("grn.received");
    expect((received[0]?.payload as { approvalId: string }).approvalId).toBe(approvalId);
  });

  it("requesting a near-expiry acceptance for a GRN with no near-expiry line is refused", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/OK", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await expect(withTx(db, (tx) => requestNearExpiryAcceptance(tx, HEAD, grnId)))
      .rejects.toThrow(/no near-expiry line/);
  });

  // ══════════════════════════ the other two sources, and the gate's refusals ══════════════════════════

  it("a DONATION posts as `donated`-owned stock and needs no agreement", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "donation", storeResourceId: storeId,
      challanNo: "DON/1", challanDate: CHALLAN, now: T0,
      lines: [goodLine(itemId, { unitCostPaise: 0, freeGoods: true })],
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    const batch = (await db.select().from(stockBatches))[0];
    expect(batch?.ownership).toBe("donated");
    expect(batch?.landedCostPaise).toBe(0);
    expect(await db.select().from(consignmentLots)).toEqual([]);
  });

  it("free goods are a separate zero-cost line with FULL batch discipline", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/FREE", challanDate: CHALLAN, now: T0,
      lines: [
        goodLine(itemId),
        // The bonus carton: same item, its OWN batch number, expiry and MRP — and cost 0.
        goodLine(itemId, { batchNo: "B-FREE", qtyInUom: 1, unitCostPaise: 0, freeGoods: true }),
      ],
    }));
    expect((await withTx(db, (tx) => runGateQc(tx, HEAD, grnId))).status).toBe("accepted");
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    const batches = await db.select().from(stockBatches);
    expect(batches).toHaveLength(2);
    // A free batch is a real batch: it expires, it can be recalled, it is picked by FEFO.
    expect(batches.map((b) => b.expiryDate)).toEqual(["2028-06-30", "2028-06-30"]);
    expect(batches.find((b) => b.batchNo === "B-FREE")?.landedCostPaise).toBe(0);
    expect((await balances(db, { itemId })).reduce((a, b) => a + b.qtyOnHand, 0)).toBe(400);
  });

  it("a blacklisted vendor's delivery is refused AT CAPTURE, before anything is written", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    await withTx(db, (tx) => blacklistVendor(tx, HEAD, vendorId, "regulatory_breach", T0));
    try {
      await withTx(db, (tx) => captureGrn(tx, HEAD, {
        vendorId, source: "challan", storeResourceId: storeId,
        challanNo: "CH/NO", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
      }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("vendor_blacklisted");
    }
    expect(await listGrns(db)).toEqual([]);
  });

  it("a recall-frozen batch refuses a NEW receipt at the gate (rule 8)", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const g1 = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await withTx(db, (tx) => runGateQc(tx, HEAD, g1.grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, g1.grnId, T0));
    const batchId = (await db.select().from(stockBatches))[0]?.id ?? "";
    await withTx(db, (tx) => recallBatch(tx, HEAD, batchId, "NPPA recall"));

    const g2 = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/2", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    const { verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, g2.grnId));
    expect(verdicts[0]?.rule).toBe("batch_frozen");
  });

  it("an MRP above a ceiling effective ON THE CHALLAN DATE is refused (rule 7)", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    // A ceiling of 800 paise a TABLET, in force from 1 August.
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 800, mrpUom: "tablet",
      effectiveFrom: new Date("2026-08-01T00:00:00Z"), gazetteRef: "NPPA/2026/9",
    }));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/CEIL", challanDate: CHALLAN, now: T0,
      // 8500 a strip of 10 = 850 a tablet, above the 800 ceiling.
      lines: [goodLine(itemId, { mrpPaise: 8500, mrpUom: "strip" })],
    }));
    const { verdicts } = await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    expect(verdicts[0]?.rule).toBe("mrp_above_ceiling");

    // A challan dated BEFORE the gazette is judged by the gazette that was in force then — none.
    const { grnId: earlier } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/OLD", challanDate: "2026-07-15", now: T0,
      lines: [goodLine(itemId, { batchNo: "B-JUL", mrpPaise: 8500, mrpUom: "strip" })],
    }));
    expect((await withTx(db, (tx) => runGateQc(tx, HEAD, earlier))).status).toBe("accepted");
  });

  it("posting without gate QC, and posting twice, are both refused", async () => {
    const itemId = await drugItem();
    const storeId = await aStore();
    const vendorId = await aVendor();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/1", challanDate: CHALLAN, lines: [goodLine(itemId)], now: T0,
    }));
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0)))
      .rejects.toThrow(/has not been through gate QC/);
    await withTx(db, (tx) => runGateQc(tx, HEAD, grnId));
    await withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0));
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, grnId, T0)))
      .rejects.toThrow(/already posted/);
    // …and the stock moved exactly once.
    expect((await balances(db, {}))[0]?.qtyOnHand).toBe(300);
  });

  it("an unknown GRN, and a GRN with no lines, refuse with codes", async () => {
    const storeId = await aStore();
    const vendorId = await aVendor();
    await expect(withTx(db, (tx) => postGrn(tx, HEAD, newId(), T0))).rejects.toThrow(/not found/);
    await expect(withTx(db, (tx) => captureGrn(tx, HEAD, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: "CH/EMPTY", challanDate: CHALLAN, lines: [], now: T0,
    }))).rejects.toThrow(/at least one line/);
    expect(await getGrn(db, newId())).toBeUndefined();
  });
});
