import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import {
  OT_IMPLANT_SERVICE_CODE, mkOtPatient, mkOtUser, seedOtBase,
} from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import {
  daycareEncounters, events, invoiceLines, invoices, otCaseImplants, otCases, otDepositHolds,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { issueInvoice, recordReceipt, registeredEncounterPrefixes } from "../billing";
import { materialConsumed } from "../materials";
import { loadPricingContext } from "../tariff";
import { registerItem } from "../materials";
import { bookCase } from "./booking";
import { heldPaise, holdDeposit, openHolds } from "./deposit";
import { intendedPayerFor } from "./ot.module";
import {
  CASH_LIMIT_PAISE, assertCashWithinEncounterLimit, clampImplantUnitPaise, composeDischargeBill,
  frozenCeilingPaisePerBase, settleDischargeBill, unbilledDaycare,
} from "./bill";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T7 / DD11 — the discharge bill.
 *
 * ═══ THE FIXTURE OBEYS §2.102, AND EVERY COINCIDENCE THE PLAN NAMES IS BROKEN ═══
 *
 * **tariff ≠ MRP ≠ ceiling** — 50,000 / 42,000 / 45,000, so the clamp has three distinct operands
 * and A24 can say WHICH won. The plan names `tariff = MRP = ceiling` as the coinciding fixture and
 * it appears here only as a labelled control.
 *
 * **`mrpUom` is NOT the base unit on one leg** — A25's box of two, where the printed ₹80,000 is the
 * price of a PAIR and the per-base figure is ₹40,000. Plan 14's close found that exact coincidence
 * hiding a factor-of-five error, and it is the seventh coinciding field its own note names.
 *
 * **frozen ≠ derived on the F5 leg** — A28's gazette correction, without which the divergence path
 * is unreachable.
 */
const LIST_DATE = "2026-09-02";
jest.setTimeout(40_000);

/** A24's three operands, deliberately all different. */
const TARIFF_UNIT = 5_000_000;   // ₹50,000 — `seedOtBase` prices the implant service at this
const MRP_PER_BASE = 4_200_000;  // ₹42,000
const CEILING_PER_BASE = 4_500_000; // ₹45,000

describe("the OT discharge bill (Plan 15 T7 / DD11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let patientId: string;
  let cashier: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800001111" });
    cashier = await mkOtUser(db, "ot_cashier_b", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  /**
   * An encounter with ONE case, driven straight to an outcome by writing the rows the theatre would
   * have written. The gate/cockpit walk is T4's and T5's subject; this suite is about the MONEY, and
   * a fifty-line walk in every leg would make the money hard to see.
   */
  async function anEncounter(outcome = "discharged"): Promise<{ caseId: string; encounterId: string; encounterNo: string }> {
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", force: true,
    });
    await forceState(r.caseId, "discharged");
    await db.update(daycareEncounters)
      .set({ status: outcome, outcome, dischargedAt: new Date() })
      .where(eq(daycareEncounters.id, r.encounterId));
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, r.encounterId)))[0]!;
    return { caseId: r.caseId, encounterId: r.encounterId, encounterNo: enc.encounterNo };
  }

  /** A hold big enough to settle whatever the bill comes to — used where the leg is not about money. */
  async function holdFor(encounterId: string, amountPaise: number): Promise<void> {
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise, refText: `UPI/${encounterId.slice(-6)}` }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId, receiptId, amountPaise }));
  }

  async function forceState(caseId: string, state: string): Promise<void> {
    await db.execute(sql`
      update workflow_instances set current_state = ${state}, status = 'completed'
       where id = (select workflow_instance_id from ot_cases where id = ${caseId})
    `);
  }

  /**
   * An implant on a case, with its ledger row and its `material.consumed` event — the two facts the
   * composer reads. Written directly because the materials consumer's own path is Plan 14's subject
   * and T5's A18 already proves this module's half of the handshake.
   */
  async function anImplant(
    args: {
      caseId: string; encounterId: string; serial: string;
      mrpPaisePerBase?: number | null; ceilingPaisePerBase?: number | null;
      frozenCeiling?: number | null; occurredAt?: Date; qtyBase?: number; explanted?: boolean;
      mrpPaise?: number | null; mrpUom?: string | null;
    },
  ): Promise<{ implantId: string; ledgerEntryId: string }> {
    const implantId = newId();
    const ledgerEntryId = newId();
    const occurredAt = args.occurredAt ?? new Date("2026-09-02T05:00:00.000Z");
    const qtyBase = args.qtyBase ?? 1;

    await db.insert(otCaseImplants).values({
      id: implantId, caseId: args.caseId, encounterId: args.encounterId,
      itemId: f.implantItemId, batchId: "b-plate-1", lotId: "lot-plate-1", serial: args.serial,
      serviceCode: OT_IMPLANT_SERVICE_CODE, qtyBase, source: "consignment",
      state: "confirmed", ledgerEntryId, deployedBy: f.otNurse.id, deployedAt: occurredAt,
      ...(args.explanted === true ? { explantedAt: new Date(), explantReason: "wrong size" } : {}),
    });

    // The ledger row `consumptionsFor` reads, and the batch it joins.
    await db.execute(sql`
      insert into stock_batches (id, item_id, batch_no, expiry_date, landed_cost_paise, ownership, vendor_id, mrp_paise, mrp_uom, created_by)
      values ('b-plate-1', ${f.implantItemId}, 'BATCH-1', '2028-01-01', 100, 'consignment', null,
              ${args.mrpPaise ?? MRP_PER_BASE}, ${args.mrpUom ?? "each"}, 't')
      on conflict (id) do update set mrp_paise = excluded.mrp_paise, mrp_uom = excluded.mrp_uom
    `);
    await db.execute(sql`
      insert into stock_ledger (id, resource_id, batch_id, item_id, qty_delta, reason, ref_type, ref_id,
                                patient_id, encounter_id, actor_id, occurred_at)
      values (${ledgerEntryId}, ${f.consignmentStoreId}, 'b-plate-1', ${f.implantItemId}, ${-qtyBase}, 'consume',
              'ot_case', ${args.caseId}, ${patientId}, ${args.encounterId}, ${f.otNurse.id}, ${occurredAt})
    `);
    await withTx(db, (tx) => appendEvent(tx, materialConsumed.make({
      actor: { type: "system", id: "materials.consumption" },
      patientId, encounterId: args.encounterId, occurredAt,
      payload: {
        ledgerEntryId, itemId: f.implantItemId, batchId: "b-plate-1", ownership: "consignment",
        vendorId: null, qtyBase, patientId, encounterId: args.encounterId,
        caseRef: { type: "ot_case", id: args.caseId },
        mrpPaise: args.mrpPaise ?? MRP_PER_BASE, mrpUom: args.mrpUom ?? "each",
        mrpPaisePerBase: args.mrpPaisePerBase === undefined ? MRP_PER_BASE : args.mrpPaisePerBase,
        ceilingPaisePerBase: args.frozenCeiling === undefined
          ? (args.ceilingPaisePerBase === undefined ? CEILING_PER_BASE : args.ceilingPaisePerBase)
          : args.frozenCeiling,
        occurredAt: occurredAt.toISOString(),
      },
    })));
    // The REGULATION `consumptionsFor` re-derives from — the derived ceiling.
    const derived = args.ceilingPaisePerBase === undefined ? CEILING_PER_BASE : args.ceilingPaisePerBase;
    if (derived !== null) {
      await db.execute(sql`
        insert into item_price_regulations (id, item_id, effective_from, ceiling_paise, mrp_default_paise, mrp_uom, gazette_ref, created_by)
        values (${newId()}, ${f.implantItemId}, '2026-01-01', ${derived}, ${MRP_PER_BASE}, 'each', 'NPPA/2026/1', 't')
      `);
    }
    return { implantId, ledgerEntryId };
  }

  // ═══════════════════════════════ A24 ═══════════════════════════════

  /**
   * ═══ A24 — `min(tariff, MRP, ceiling)`, AND THE NOTE NAMES THE WINNER ═══
   *
   * tariff 50,000 · MRP/base 42,000 · ceiling/base 45,000, qty 1 → **42,000, "mrp"**.
   * A second leg with the tariff at 40,000 → **40,000, "tariff"**.
   * The mutant prices by the tariff alone and bills 50,000 — 8,000 above the printed MRP, which is
   * the number a patient can read off the box in their own hand.
   */
  it("A24 — the implant line is the MINIMUM of the three, and the note says which won", async () => {
    const e = await anEncounter();
    await anImplant({ caseId: e.caseId, encounterId: e.encounterId, serial: "SN-1" });
    const composed = await composeDischargeBill(db, e.encounterId);

    expect(composed.implantLines).toHaveLength(1);
    expect(composed.implantLines[0]).toMatchObject({
      tariffUnitPaise: TARIFF_UNIT, mrpPaisePerBase: MRP_PER_BASE,
      ceilingPaisePerBase: CEILING_PER_BASE, capUnitPaise: MRP_PER_BASE, boundApplied: "mrp",
    });
    expect(composed.notes[`impl-${composed.implantLines[0]!.implantId}`])
      .toMatch(/unit bound: mrp \(4200000p\/base\)/);

    // The engine really applies it: the priced line is 42,000, not 50,000.
    await holdFor(e.encounterId, composed.expectedNetPaise);
    const settled = await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    const invoice = { invoiceId: settled.invoiceId };
    const linesOut = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.invoiceId));
    const implantLine = linesOut.find((l) => l.serviceId === composed.lines.find((c) => c.lineId.startsWith("impl-"))!.serviceId)!;
    expect(implantLine.unitPaise).toBe(MRP_PER_BASE);
    // …and the clamp it recorded names the CALLER's bound, so the invoice itself carries which
    // of the three won rather than only the note.
    expect(implantLine.regulatedClamp).toMatchObject({ boundApplied: "caller_cap", capUnitPaise: MRP_PER_BASE });
  });

  it("A24 — when the TARIFF is the lowest it wins, and the note says `tariff`", () => {
    // The pure function, so the three legs are three numbers rather than three fixtures.
    expect(clampImplantUnitPaise(4_000_000, { mrpPaisePerBase: MRP_PER_BASE, ceilingPaisePerBase: CEILING_PER_BASE }))
      .toEqual({ capUnitPaise: 4_000_000, boundApplied: "tariff" });
    expect(clampImplantUnitPaise(TARIFF_UNIT, { mrpPaisePerBase: MRP_PER_BASE, ceilingPaisePerBase: CEILING_PER_BASE }))
      .toEqual({ capUnitPaise: MRP_PER_BASE, boundApplied: "mrp" });
    // The CEILING wins only when it is below BOTH — the leg that separates it from the MRP.
    expect(clampImplantUnitPaise(TARIFF_UNIT, { mrpPaisePerBase: 4_600_000, ceilingPaisePerBase: CEILING_PER_BASE }))
      .toEqual({ capUnitPaise: CEILING_PER_BASE, boundApplied: "ceiling" });
    // A missing bound is not a zero bound: an unregulated item with no MRP prices at tariff.
    expect(clampImplantUnitPaise(TARIFF_UNIT, { mrpPaisePerBase: null, ceilingPaisePerBase: null }))
      .toEqual({ capUnitPaise: TARIFF_UNIT, boundApplied: "tariff" });
    // THE COINCIDING FIXTURE, LABELLED: all three equal proves nothing about the ordering.
    expect(clampImplantUnitPaise(TARIFF_UNIT, { mrpPaisePerBase: TARIFF_UNIT, ceilingPaisePerBase: TARIFF_UNIT }))
      .toEqual({ capUnitPaise: TARIFF_UNIT, boundApplied: "tariff" });
  });

  // ═══════════════════════════════ A25 ═══════════════════════════════

  /**
   * ═══ A25 — MRP IS PER BASE UNIT × qty, NEVER THE PRINTED PACK MRP ONCE ═══
   *
   * `mrpUom = "box"` of two, `mrpPaise` 80,000 printed on the box, one BASE unit deployed. The
   * lawful maximum for one plate is 40,000. The mutant uses `mrpPaise` directly and bills 80,000 —
   * double, on an item the patient can read the box of. Plan 14's close found exactly this
   * coincidence hidden by a fixture where `mrpUom` WAS the base unit.
   */
  it("A25 — a pack MRP is converted to the base unit before it can bound anything", async () => {
    const e = await anEncounter();
    await anImplant({
      caseId: e.caseId, encounterId: e.encounterId, serial: "SN-1",
      mrpPaise: 8_000_000, mrpUom: "box", mrpPaisePerBase: 4_000_000,
      ceilingPaisePerBase: CEILING_PER_BASE,
    });
    const composed = await composeDischargeBill(db, e.encounterId);
    // 40,000 per base, NOT the 80,000 printed on the box.
    expect(composed.implantLines[0]).toMatchObject({ capUnitPaise: 4_000_000, boundApplied: "mrp" });
    expect(composed.implantLines[0]!.mrpPaisePerBase).toBe(4_000_000);
  });

  // ═══════════════════════════════ A26 ═══════════════════════════════

  /**
   * A26 — D8's case: a plate deployed, found wrong, explanted, a second one deployed. ONE charge.
   * The mutant filters on `deployed_at`, which is set on BOTH rows, and bills the patient for the
   * plate that came back out.
   */
  it("A26 — an EXPLANTED implant is excluded; the patient is charged once for D8's two deployments", async () => {
    const e = await anEncounter();
    await anImplant({ caseId: e.caseId, encounterId: e.encounterId, serial: "SN-1", explanted: true });
    await anImplant({
      caseId: e.caseId, encounterId: e.encounterId, serial: "SN-2",
      occurredAt: new Date("2026-09-02T05:30:00.000Z"),
    });
    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.implantLines).toHaveLength(1);
    // …and it is the SECOND one — the plate that stayed in.
    const kept = (await db.select().from(otCaseImplants).where(eq(otCaseImplants.serial, "SN-2")))[0]!;
    expect(composed.implantLines[0]!.implantId).toBe(kept.id);
  });

  // ═══════════════════════════════ A27 ═══════════════════════════════

  /**
   * A27 — EVERY case on the encounter must be signed out, not the first. N8's bilateral encounter
   * carries two, and the mutant checks `cases[0]`: a bill composed while the second side is still
   * being operated on.
   */
  it("A27 — composition is refused while the SECOND case of a bilateral encounter is still open", async () => {
    const e = await anEncounter();
    const second = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-02", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", encounterId: e.encounterId, force: true,
    });
    await forceState(second.caseId, "incision");
    await expect(composeDischargeBill(db, e.encounterId)).rejects.toThrow(/have not been signed out/);
    // Sign the second one out and it composes.
    await forceState(second.caseId, "signed_out");
    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.packageLines).toHaveLength(2);
  });

  it("A27 — composition is refused while any implant is still `deploying`", async () => {
    const e = await anEncounter();
    await db.insert(otCaseImplants).values({
      id: newId(), caseId: e.caseId, encounterId: e.encounterId, itemId: f.implantItemId,
      batchId: "b-plate-1", lotId: "lot-plate-1", serial: "SN-WAIT",
      serviceCode: OT_IMPLANT_SERVICE_CODE, qtyBase: 1, source: "consignment",
      state: "deploying", deployedBy: f.otNurse.id,
    });
    await expect(composeDischargeBill(db, e.encounterId)).rejects.toThrow(/have no ledger fact yet/);
  });

  it("a CANCELLED encounter composes nothing at all (DD11)", async () => {
    const e = await anEncounter();
    await db.update(daycareEncounters).set({ outcome: "cancelled", status: "cancelled" })
      .where(eq(daycareEncounters.id, e.encounterId));
    await expect(composeDischargeBill(db, e.encounterId)).rejects.toThrow(/composes no bill/);
  });

  it("a DECEASED encounter whose case never reached incision bills NO package", async () => {
    const e = await anEncounter("deceased");
    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.packageLines).toEqual([]);
    // With an incision it DOES bill the package — the theatre happened.
    await db.update(otCases).set({ incision: new Date("2026-09-02T04:00:00.000Z") }).where(eq(otCases.id, e.caseId));
    const withIncision = await composeDischargeBill(db, e.encounterId);
    expect(withIncision.packageLines).toHaveLength(1);
  });

  // ═══════════════════════════════ A28 ═══════════════════════════════

  /**
   * ═══ A28 — THE GAZETTE MOVED UNDER THE DEPLOYMENT ═══
   *
   * A correcting regulation with the SAME `effective_from` and a LOWER ceiling, filed AFTER the
   * deployment. `effectiveRegulation` orders `effective_from desc, seq desc`, so the correction
   * supersedes. Frozen 45,000 · derived 43,000 → the line is **43,000** and
   * `material.ceiling_diverged` records both. The mutant uses the frozen value and issues a tax
   * document 2,000 above the gazette as corrected on the day of issue.
   */
  it("A28 — a later gazette correction wins, and the divergence is evented", async () => {
    const e = await anEncounter();
    const { ledgerEntryId } = await anImplant({
      caseId: e.caseId, encounterId: e.encounterId, serial: "SN-1",
      frozenCeiling: CEILING_PER_BASE,   // what `material.consumed` froze
      ceilingPaisePerBase: CEILING_PER_BASE,
      /**
       * The MRP is set ABOVE both ceilings so the CEILING is the binding bound and the correction
       * can be seen. It is set on the BATCH (`mrpPaise`), not only in the event payload, because
       * `consumptionsFor` derives `mrpPaisePerBase` from the batch — the first version of this
       * fixture set it in the payload alone and the MRP quietly won at 42,000, hiding the very
       * correction the leg is about.
       */
      mrpPaise: 4_900_000, mrpUom: "each", mrpPaisePerBase: 4_900_000,
    });
    // The CORRECTION: same effective_from, lower ceiling, filed later (a higher seq).
    await db.execute(sql`
      insert into item_price_regulations (id, item_id, effective_from, ceiling_paise, mrp_default_paise, mrp_uom, gazette_ref, created_by)
      values (${newId()}, ${f.implantItemId}, '2026-01-01', 4300000, ${MRP_PER_BASE}, 'each', 'NPPA/2026/1-CORR', 't')
    `);

    expect(await frozenCeilingPaisePerBase(db, ledgerEntryId)).toBe(CEILING_PER_BASE);
    const composed = await composeDischargeBill(db, e.encounterId);
    // The DERIVED value is on the invoice.
    expect(composed.implantLines[0]).toMatchObject({ capUnitPaise: 4_300_000, boundApplied: "ceiling" });
    expect(composed.divergences).toEqual([{ ledgerEntryId, frozen: CEILING_PER_BASE, derived: 4_300_000 }]);

    await holdFor(e.encounterId, composed.expectedNetPaise);
    await settleDischargeBill(db, cashier, { encounterId: e.encounterId });

    const diverged = (await db.select().from(events)).filter((ev) => ev.name === "material.ceiling_diverged");
    expect(diverged).toHaveLength(1);
    expect(diverged[0]!.payload).toMatchObject({
      ledgerEntryId, frozenCeilingPaisePerBase: CEILING_PER_BASE,
      derivedCeilingPaisePerBase: 4_300_000, invoicedUnitPaise: 4_300_000,
    });
  });

  it("A28 — EQUAL values emit nothing: the divergence path is not a per-implant event", async () => {
    const e = await anEncounter();
    await anImplant({ caseId: e.caseId, encounterId: e.encounterId, serial: "SN-1" });
    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.divergences).toEqual([]);
    await holdFor(e.encounterId, composed.expectedNetPaise);
    await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    expect((await db.select().from(events)).filter((ev) => ev.name === "material.ceiling_diverged")).toHaveLength(0);
  });

  // ═══════════════════════════════ A29 ═══════════════════════════════

  /**
   * ═══ A29 — THE HOLD ON *THIS* ENCOUNTER, AND THE OTHER ONE IS UNTOUCHED ═══
   *
   * Hold 60,000 on E1 and 20,000 on E2; E1's invoice is 52,000 → a refund request for exactly 8,000
   * and E2's hold intact. The mutant allocates from `advanceOf`, which is the PATIENT's balance, and
   * spends E2's deposit on E1's bill — F3's finding at the settlement end.
   */
  it("A29 — the encounter's own hold settles the bill; the other encounter's hold is untouched", async () => {
    const e1 = await anEncounter();
    const e2 = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: "2026-09-09", payerClass: "self_pay", force: true,
    });
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise: 8_000_000, refText: "UPI/1" }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e1.encounterId, receiptId, amountPaise: 6_000_000 }));
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e2.encounterId, receiptId, amountPaise: 2_000_000 }));

    const settled = await settleDischargeBill(db, cashier, { encounterId: e1.encounterId });
    // The package alone: ₹60,000, GST-exempt.
    expect(settled.netPayablePaise).toBe(6_000_000);
    expect(settled.allocatedPaise).toBe(6_000_000);
    // Nothing over: the hold exactly covered it, so no refund.
    expect({ refund: settled.refundPaise, approval: settled.refundApprovalId })
      .toEqual({ refund: 0, approval: null });

    // E2's hold is INTACT.
    const e2Holds = await withTx(db, (tx) => openHolds(tx, e2.encounterId));
    expect(e2Holds).toHaveLength(1);
    expect(e2Holds[0]!.amountPaise).toBe(2_000_000);
  });

  it("A29 — an OVER-deposit raises a refund request for exactly the excess, never a silent credit", async () => {
    const e = await anEncounter();
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise: 7_000_000, refText: "UPI/1" }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e.encounterId, receiptId, amountPaise: 7_000_000 }));
    const settled = await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    expect(settled.netPayablePaise).toBe(6_000_000);
    expect(settled.allocatedPaise).toBe(6_000_000);
    // ₹10,000 over → a refund REQUEST, approval-gated, for exactly that.
    expect(settled.refundPaise).toBe(1_000_000);
    expect(settled.refundApprovalId).not.toBeNull();
  });

  // ═══════════════════════════════ A30 ═══════════════════════════════

  /**
   * ═══ A30 — THE CONVERSION BOUNDARY (F9) ═══
   *
   * Deploy at 14:00, convert at 16:00, deploy again at 17:00. ONE line on the invoice and ONE row in
   * `handoff_unbilled`. The mutant has no filter and bills the incumbent IPD's stock on our invoice
   * — which is double-billing the patient, because the incumbent bills it too.
   */
  it("A30 — only consumptions at or before `converted_at` are billed; later ones go to handoff_unbilled", async () => {
    const e = await anEncounter("converted");
    const convertedAt = new Date("2026-09-02T16:00:00.000Z");
    await db.update(daycareEncounters).set({ convertedAt }).where(eq(daycareEncounters.id, e.encounterId));

    await anImplant({
      caseId: e.caseId, encounterId: e.encounterId, serial: "SN-BEFORE",
      occurredAt: new Date("2026-09-02T14:00:00.000Z"),
    });
    await anImplant({
      caseId: e.caseId, encounterId: e.encounterId, serial: "SN-AFTER",
      occurredAt: new Date("2026-09-02T17:00:00.000Z"),
    });

    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.implantLines).toHaveLength(1);
    expect(composed.handoffUnbilled).toHaveLength(1);
    expect(composed.handoffUnbilled[0]!.occurredAt.toISOString()).toBe("2026-09-02T17:00:00.000Z");

    // The boundary is INCLUSIVE at the instant itself: a consumption AT `converted_at` is ours.
    await anImplant({ caseId: e.caseId, encounterId: e.encounterId, serial: "SN-AT", occurredAt: convertedAt });
    const again = await composeDischargeBill(db, e.encounterId);
    expect(again.implantLines).toHaveLength(2);
    expect(again.handoffUnbilled).toHaveLength(1);
  });

  // ═══════════════════════════════ A31 ═══════════════════════════════

  /**
   * ═══ A31 — §269ST ACROSS THE ENCOUNTER, ACROSS DAYS (F24e) ═══
   *
   * Cash hold ₹1,50,000 on day 1; cash tender ₹60,000 on day 3. Billing's own C-2 check is per
   * `service_day` and sees two lawful days; §269ST counts receipts in respect of a SINGLE
   * TRANSACTION, and one operation is one transaction. The mutant checks the day only.
   */
  it("A31 — a discharge cash tender is refused when the ENCOUNTER's cash total would reach ₹2,00,000", async () => {
    const e = await anEncounter();
    // Day 1: ₹1,50,000 in cash, with PAN, held against the encounter.
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "cash", amountPaise: 15_000_000 }], panNumber: "ABCDE1234F",
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: e.encounterId, receiptId, amountPaise: 15_000_000 }));
    expect(await assertCashWithinEncounterLimit(db, e.encounterId, 4_000_000).then(() => "ok", () => "refused")).toBe("ok");

    // Day 3: ₹60,000 more takes the encounter to ₹2,10,000.
    await expect(assertCashWithinEncounterLimit(db, e.encounterId, 6_000_000))
      .rejects.toThrow(/§269ST blocks at 20000000p/);
    await expect(settleDischargeBill(db, cashier, { encounterId: e.encounterId, cashTenderPaise: 6_000_000 }))
      .rejects.toThrow(/cash total would reach/);
    // NO invoice was issued — the refusal comes before the bill, so a refused tender leaves nothing.
    expect(await db.select().from(invoices)).toHaveLength(0);
    expect(CASH_LIMIT_PAISE).toBe(20_000_000);
  });

  // ═══════════════════════════════ A32 ═══════════════════════════════

  /**
   * ═══ A32 — THE RESOLVER SEAM: `D` RESOLVES HERE, `V` STILL RESOLVES THROUGH OPD, `X` THROWS ═══
   *
   * Before this seam, `issueInvoice` resolved every encounter through OPD and threw
   * `unknown_encounter` for a day-care one — so the whole discharge bill was unreachable (F2).
   */
  it("A32 — a `D` encounter resolves through the OT and carries the MAPPED payer", async () => {
    const e = await anEncounter();
    await db.update(daycareEncounters).set({ payerClass: "insured_tpa" })
      .where(eq(daycareEncounters.id, e.encounterId));
    const composed = await composeDischargeBill(db, e.encounterId);
    await holdFor(e.encounterId, composed.expectedNetPaise);
    const settled = await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    const row = (await db.select().from(invoices).where(eq(invoices.id, settled.invoiceId)))[0]!;
    expect({ encounterId: row.encounterId, payer: row.intendedPayer })
      .toEqual({ encounterId: e.encounterNo, payer: "tpa" });
  });

  it("A32 — an UNKNOWN encounter still throws `unknown_encounter`", async () => {
    await expect(issueInvoice(db, cashier, {
      draftId: newId(), patientId, encounterId: "X2609020001",
      lines: [{ lineId: "l1", serviceId: f.packageServiceIds.gynaeDnc, qty: 1 }],
    })).rejects.toThrow(/unknown encounter/);
    // …and a `D` number that names no encounter throws too — the resolver returning null is a miss,
    // not a fall-through to OPD.
    await expect(issueInvoice(db, cashier, {
      draftId: newId(), patientId, encounterId: "D2609020099",
      lines: [{ lineId: "l1", serviceId: f.packageServiceIds.gynaeDnc, qty: 1 }],
    })).rejects.toThrow(/unknown encounter/);
  });

  it("A32 — both prefixes are registered, and the OT's mapping covers all eight payer classes", () => {
    expect(registeredEncounterPrefixes()).toEqual(["D", "V"]);
    expect({
      self_pay: intendedPayerFor("self_pay"),
      staff_dependant: intendedPayerFor("staff_dependant"),
      charity: intendedPayerFor("charity"),
      membership_prepaid: intendedPayerFor("membership_prepaid"),
      insured_tpa: intendedPayerFor("insured_tpa"),
      corporate_credit: intendedPayerFor("corporate_credit"),
      govt_scheme: intendedPayerFor("govt_scheme"),
      // PROVISIONAL — 15b widens billing's enum if the CA rules an FP claim may not share PMJAY's
      // bucket. The phase says so rather than inventing an enum value it cannot support.
      fp_scheme: intendedPayerFor("fp_scheme"),
    }).toEqual({
      self_pay: "self", staff_dependant: "self", charity: "self", membership_prepaid: "self",
      insured_tpa: "tpa", corporate_credit: "corporate", govt_scheme: "pmjay", fp_scheme: "pmjay",
    });
  });

  // ═══════════════════════════════ D12 and the orphan scan ═══════════════════════════════

  /**
   * ═══ THE EARMARK IS CONSUMED BY THE SETTLEMENT THAT SPENDS IT ═══
   *
   * Found by T8's e2e, which asserted the hold was spent after a real discharge and measured
   * `released_at: null`. `settleDischargeBill` passes the holds to `issueInvoice` as
   * `settleFromReceipts` — the money genuinely moves — but nothing closed the hold rows, so
   * `heldPaise()` went on reporting ₹60,000 that billing had already allocated. Two copies of one
   * fact, disagreeing (§2.54), and the stale copy is the one three callers read:
   *
   *   - DD12's deposit gate, which decides whether a case may be booked;
   *   - `composeDischargeBill`, whose `excess = heldPaise − plannedFromHolds` is the REFUND amount;
   *   - `POST /ot/cases/:id/deposit/release` (ot-cases.controller.ts), which would cheerfully
   *     report "₹60,000 released" for money already inside an invoice.
   *
   * Every open hold is disposed of by a settlement — spent into the invoice, or returned as the
   * `excess` refund request — so releasing all of them is right, and the reason names the invoice
   * so a ledger reader can follow the money out.
   */
  it("F-settle — settlement releases the holds it spends, naming the invoice", async () => {
    const e = await anEncounter();
    const composed = await composeDischargeBill(db, e.encounterId);
    await holdFor(e.encounterId, composed.expectedNetPaise);
    const settled = await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    expect(settled.allocatedPaise).toBe(composed.expectedNetPaise);

    expect(await withTx(db, (tx) => openHolds(tx, e.encounterId))).toEqual([]);
    expect(await withTx(db, (tx) => heldPaise(tx, e.encounterId))).toBe(0);
    const rows = await db.select().from(otDepositHolds).where(eq(otDepositHolds.encounterId, e.encounterId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.releasedReason).toContain(settled.invoiceNo);
  });

  /**
   * The refund leg of the same fact: a deposit LARGER than the bill leaves an excess, which becomes
   * a refund request — and the hold must still close, or the next composition would count the same
   * excess a second time.
   */
  it("F-settle — an over-deposit closes its hold too, and refunds the excess exactly once", async () => {
    const e = await anEncounter();
    const composed = await composeDischargeBill(db, e.encounterId);
    await holdFor(e.encounterId, composed.expectedNetPaise + 1_000_000);
    const settled = await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    expect({ refundPaise: settled.refundPaise, hasApproval: settled.refundApprovalId !== null })
      .toEqual({ refundPaise: 1_000_000, hasApproval: true });
    expect(await withTx(db, (tx) => heldPaise(tx, e.encounterId))).toBe(0);
  });

  /**
   * ═══ THE ORDERING, WHICH IS THE ONLY THING THE TWO TESTS ABOVE CANNOT SEE ═══
   *
   * Both legs above pass just as well if the release happens BEFORE `issueInvoice` — on the happy
   * path the two orders are indistinguishable. They differ only when the invoice is REFUSED, and
   * then they differ in the direction that costs a patient money: release-first drops the earmark
   * on a deposit that was never spent, so the next reader sees ₹0 held against money sitting in the
   * patient's advance. A hold under-deposited for its bill and tendered no cash is exactly that
   * case, so this pins the order the failure path depends on.
   */
  it("F-settle — a REFUSED invoice leaves the hold open, money still earmarked", async () => {
    const e = await anEncounter();
    const composed = await composeDischargeBill(db, e.encounterId);
    await holdFor(e.encounterId, composed.expectedNetPaise - 1_000_000);

    await expect(settleDischargeBill(db, cashier, { encounterId: e.encounterId }))
      .rejects.toThrow(/unsettled/);
    expect(await withTx(db, (tx) => heldPaise(tx, e.encounterId)))
      .toBe(composed.expectedNetPaise - 1_000_000);
  });

  it("D12 — stock ISSUED and never consumed is a warning row, not a block", async () => {
    const e = await anEncounter();
    const kitItem = await withTx(db, (tx) => registerItem(tx, f.drafter, {
      code: "OT-KIT-1", name: "Minor set", class: "consumable", baseUom: "each", batchTracked: true,
    }));
    await db.execute(sql`
      insert into stock_batches (id, item_id, batch_no, expiry_date, landed_cost_paise, ownership, created_by)
      values ('b-kit-1', ${kitItem.itemId}, 'KIT-1', '2028-01-01', 100, 'owned', 't') on conflict (id) do nothing
    `);
    await db.execute(sql`
      insert into stock_ledger (id, resource_id, batch_id, item_id, qty_delta, reason, ref_type, ref_id,
                                patient_id, encounter_id, actor_id, occurred_at)
      values (${newId()}, ${f.consignmentStoreId}, 'b-kit-1', ${kitItem.itemId}, -3, 'issue', 'ot_case', ${e.caseId},
              ${patientId}, ${e.encounterId}, ${f.otNurse.id}, ${new Date("2026-09-02T04:00:00.000Z")})
    `);
    const composed = await composeDischargeBill(db, e.encounterId);
    expect(composed.unreturnedIssues).toHaveLength(1);
    expect(composed.unreturnedIssues[0]).toMatchObject({ itemId: kitItem.itemId, qtyBase: 3 });
    // It does NOT block: the bill composes and the warning rides with it.
    expect(composed.lines.length).toBeGreaterThan(0);
  });

  it("§11.11 — a discharged encounter with no invoice is reported by the OT's own scan", async () => {
    const e = await anEncounter();
    const today = new Date().toISOString().slice(0, 10);
    await db.update(daycareEncounters).set({ dischargedAt: new Date() }).where(eq(daycareEncounters.id, e.encounterId));
    const orphans = await unbilledDaycare(db, today);
    expect(orphans.map((o) => o.encounterNo)).toContain(e.encounterNo);

    await holdFor(e.encounterId, 6_000_000);
    await settleDischargeBill(db, cashier, { encounterId: e.encounterId });
    expect((await unbilledDaycare(db, today)).map((o) => o.encounterNo)).not.toContain(e.encounterNo);
  });

  /** F4 — no implant service carries a `regulated_prices` row, so billing's own clamp is a no-op
   *  for them and this module's is the only one. Asserted, because a fixture that added one would
   *  make the two clamps disagree silently. */
  it("F4 — no `daycare_implant` service has a regulated_prices row", async () => {
    const ctx = await loadPricingContext(db, { at: new Date(), tags: [] });
    const implantServices = Object.values(ctx.services).filter((s) => s.category === "daycare_implant");
    expect(implantServices.length).toBeGreaterThan(0);
    for (const service of implantServices) {
      expect({ code: service.code, regulated: service.regulated }).toEqual({ code: service.code, regulated: false });
      expect(ctx.regulatedPrices[service.id]).toBeUndefined();
    }
  });
});
