import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { billingConfig, enteredInErrorMarks, invoices, opdEncounters, registrationConfig } from "../../kernel/db/schema";
import { getEncounter } from "../opd";
import { registerPatient } from "../patients";
import { BILLING_FEE_GATE_KEY, feeGate } from "./gate";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T10, D8 — billing's half of the pay-before-consult gate.
 *
 * THE SEEDED FIXTURE (test/helpers/billing.ts `seedBillingBase`): OPD-CONSULT-NEW, category
 * "consultation", EXEMPT healthcare, priced 50000 paise, is `charge_rules.opdConsult.new` — so a
 * consult invoice's NET PAYABLE is 50000 (exempt ⇒ no head, and nothing to round).
 *
 * WHERE THE OTHER HALF IS TESTED, and why it is not here. The plan's Step 2 asked this suite to
 * drive the REAL `startConsultation` with the guard registered. The shipped ESLint rule
 * (eslint.config.mjs, spec §4 module isolation) forbids any file under `apps/core/src/modules/**`
 * from importing another module's internals, and `startConsultation` is deliberately absent from
 * OPD's index — that module exposes its services over HTTP only, and T10's Files list adds exactly
 * two export lines there. So the seam is proven in two halves that meet at a verdict:
 *   · BILLING produces the verdict — this file;
 *   · OPD turns ANY not-ok verdict into `OpdError("consult_gate_refused")` carrying the guard's
 *     key, code and detail, with nothing moved — `modules/opd/consultation.test.ts`, whose stub
 *     guard returns exactly the shape `feeGate` returns below;
 *   · the two COMPOSED, through the module-init registration, over real HTTP — T11's e2e, which
 *     is where the plan itself puts the wiring proof (self-review 30).
 * Reported as a plan defect rather than resolved by relaxing a shipped lint rule or widening
 * OPD's public interface (the pipeline-A `settlement.ts` precedent).
 *
 * DISCLOSED SHAPING: `opd_encounters` rows are inserted directly (the T5/T8 precedent), and
 * `entered_in_error_marks` rows against INVOICES are inserted directly — `markEnteredInError` (T6)
 * covers receipts only, because an invoice's void is a `correction` credit note (D4).
 */
describe("the pay-before-consult gate: billing's verdict (D8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — IST day 2026-08-19
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    cashier = await mkCashier(db, "gate_cashier");
    await openSessionFor(db, cashier, 100_000);
  });

  async function mkTestPatient(name: string): Promise<string> {
    const actor: Actor = { type: "user", id: "gate-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 33 }));
    return patient.id;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(input: { patientId: string; visitType: string }): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId: input.patientId, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType: input.visitType, status: "waiting", intendedPayer: "self",
      openedBy: "shaped", updatedBy: "shaped", openedAt: NOW,
    });
    return id;
  }

  async function encounterOf(input: { patientId: string; visitType: string }) {
    return (await getEncounter(db, await shapeEncounter(input)))!;
  }

  async function markInvoiceEnteredInError(invoiceId: string): Promise<void> {
    await db.insert(enteredInErrorMarks).values({
      id: newId(), docType: "invoice", docId: invoiceId, reason: "keyed against the wrong visit",
      markedBy: cashier.id, markedAt: NOW,
    });
  }

  it("an UNPAID new visit is refused, and the refusal is DATA — the guard resolves, it never throws", async () => {
    const patientId = await mkTestPatient("Unpaid Patient");
    const encounter = await encounterOf({ patientId, visitType: "new" });

    // Resolved, not rejected: a thrown BillingError inside an OPD route would 500, not 409.
    const verdict = await feeGate(db, encounter);
    expect(verdict).toEqual({
      ok: false,
      code: "fee_unsettled",
      detail: { encounterId: encounter.id, visitType: "new", feeServiceId: base.consultNewServiceId },
    });
    // The key OPD's registry holds it under — T11 registers `feeGate` under exactly this.
    expect(BILLING_FEE_GATE_KEY).toBe("billing_fee_gate");
  });

  it("a SETTLED fee invoice passes; voiding that invoice stops it covering the visit", async () => {
    const patientId = await mkTestPatient("Settled Patient");
    const encounter = await encounterOf({ patientId, visitType: "new" });

    const invoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId: encounter.id,
    });
    expect(invoice.totals.netPayablePaise).toBe(50_000);
    expect(invoice.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(await feeGate(db, encounter)).toEqual({ ok: true });

    // An entered-in-error invoice is not cover: the money it recorded was never really taken.
    await markInvoiceEnteredInError(invoice.invoiceId);
    expect(await feeGate(db, encounter)).toEqual({
      ok: false,
      code: "fee_unsettled",
      detail: { encounterId: encounter.id, visitType: "new", feeServiceId: base.consultNewServiceId },
    });
  });

  it("a CREDIT-EXTENDED unpaid invoice passes — dues are a legitimate state, not an unbilled visit", async () => {
    await grantCreditExtend(db);
    const patientId = await mkTestPatient("Dues Patient");
    const encounter = await encounterOf({ patientId, visitType: "new" });

    const invoice = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId: encounter.id,
    });
    expect(invoice.creditExtended).toBe(true);
    expect(invoice.settlement).toEqual({ state: "unpaid", outstandingPaise: 50_000 });
    expect(await feeGate(db, encounter)).toEqual({ ok: true });
  });

  it("a REVISIT passes with NO invoice at all — the check is the free branch, never bare invoice existence", async () => {
    const patientId = await mkTestPatient("Revisit Patient");
    const encounter = await encounterOf({ patientId, visitType: "revisit" });

    // The fixture carries what would make a refusal appear: there is no invoice anywhere.
    expect(await db.select().from(invoices).where(eq(invoices.encounterId, encounter.id))).toHaveLength(0);
    expect(await feeGate(db, encounter)).toEqual({ ok: true });

    // …and a paid consult belonging to SOMEONE ELSE is not this visit's cover either.
    const other = await mkTestPatient("Other Patient");
    const otherEncounter = await encounterOf({ patientId: other, visitType: "new" });
    await issuePaidInvoice(db, cashier, {
      patientId: other, serviceId: base.consultNewServiceId, encounterId: otherEncounter.id,
    });
    expect(await feeGate(db, encounter)).toEqual({ ok: true });
    expect((await feeGate(db, await encounterOf({ patientId, visitType: "new" }))).ok).toBe(false);
  });

  it("a billing failure crosses the seam as a VERDICT carrying its own code, never as a BillingError", async () => {
    const patientId = await mkTestPatient("Unconfigured Patient");
    const encounter = await encounterOf({ patientId, visitType: "new" });
    await db.delete(billingConfig).where(eq(billingConfig.id, "main"));

    expect(await feeGate(db, encounter)).toMatchObject({ ok: false, code: "billing_not_configured" });
  });
});
