import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { invoices, opdEncounters, patients, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueInvoice, previewInvoice } from "./invoices";
import type { Db } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-35 — ONE BILL, TWO PEOPLE: THE COUNTER COULD NAME A PATIENT AND CHARGE SOMEBODY ELSE'S VISIT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-13, on `/billing`: *"I have a patient in hand, let's call him Ankit … in the
 * Encounter Id field, I input encounter Id of another patient, lets call him Abhay … It shows
 * Abhay's encounter/visit details under the Ankit."*
 *
 * The screen blending two people is the half he can see. THIS is the half underneath it: nothing
 * on the server ever checked that `patientId` and `encounterId` name the same human being.
 *
 * MEASURED, because the two routes differ and the difference matters. `POST /billing/invoices/preview`
 * is SAFE already and not by luck: its body deliberately omits `patientId` (review MAJOR 4 removed it
 * as an instrument oracle), so a preview's subject is always the encounter's own patient. `POST
 * /billing/invoices` — the WRITE — takes both, `patientId` required. So the counter could price
 * Abhay's visit honestly, show it under Ankit's name, and then ISSUE one row carrying Ankit's
 * `patient_id` beside Abhay's `encounter_id`; `priceDraftWithBenefits` preferred the caller's patient
 * (`draft.patientId ?? encounter.patientId`), so Ankit's memberships and coupons were composed
 * against Abhay's visit on the way.
 *
 * WHAT THAT ROW DOES AFTERWARDS, which is why this is a guard and not a nicety: it puts the charge
 * on Ankit's ledger and his outstanding cap; it marks Abhay's visit as billed, so FD-33's orphan
 * scan stops asking about it; and it spends Ankit's entitlement counters on care he did not
 * receive. Every one of those is discovered later, by somebody trying to reconcile money, and none
 * of them is visible on the bill itself.
 *
 * A GUARD, NOT A CORRECTION. The server does not get to decide which of the two the cashier meant —
 * it refuses, names both, and lets the person at the counter say which.
 */
describe("a bill names ONE person: patientId and encounterId must agree (FD-35)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  const mkPatient = async (name: string): Promise<string> => {
    const actor: Actor = { type: "user", id: "binding-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "male", ageYears: 35 }));
    return patient.id;
  };

  /*
    ONE `opd_encounters` row inserted directly — `invoices.test.ts`'s own disclosed shaping, and its
    reasoning holds here unchanged: opening a real visit needs the whole Class-A workflow definition,
    departments, doctors and an appointment, to read two columns. Billing still reaches it only
    through `getEncounter`.
  */
  const mkEncounter = async (patientId: string): Promise<string> => {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType: "new", intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped",
    });
    return id;
  };

  const line = () => ({ lineId: "L1", serviceId: base.consultNewServiceId, qty: 1 });

  it("refuses to PRICE a draft whose patient did not have the visit", async () => {
    const ankit = await mkPatient("Ankit Kumar");
    const abhay = await mkPatient("Abhay Kumar");
    const abhaysVisit = await mkEncounter(abhay);

    await expect(
      previewInvoice(db, { patientId: ankit, encounterId: abhaysVisit, lines: [line()] }, NOW),
    ).rejects.toMatchObject({ code: "patient_encounter_mismatch" });
  });

  /*
    THE WRITE IS THE ONE THAT MATTERS, AND IT IS ASSERTED BY ROW COUNT. A refusal that still left an
    invoice behind would be the worst of both — the cashier told it failed, the ledger holding a bill
    for a visit that was somebody else's.
  */
  it("refuses to ISSUE one, and writes nothing", async () => {
    const ankit = await mkPatient("Ankit Kumar");
    const abhay = await mkPatient("Abhay Kumar");
    const abhaysVisit = await mkEncounter(abhay);
    const cashier = await mkCashier(db, "binding-cashier");
    await openSessionFor(db, cashier, 100_000);

    await expect(
      issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId: ankit, encounterId: abhaysVisit, lines: [line()],
        receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
      }, NOW),
    ).rejects.toMatchObject({ code: "patient_encounter_mismatch" });

    expect(await db.select().from(invoices)).toEqual([]);
  });

  it("the honest bill still prices and still issues", async () => {
    const abhay = await mkPatient("Abhay Kumar");
    const abhaysVisit = await mkEncounter(abhay);
    const cashier = await mkCashier(db, "honest-cashier");
    await openSessionFor(db, cashier, 100_000);

    const priced = await previewInvoice(db, { patientId: abhay, encounterId: abhaysVisit, lines: [line()] }, NOW);
    expect(priced.lines).toHaveLength(1);

    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: abhay, encounterId: abhaysVisit, lines: [line()],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }, NOW);
    expect(issued.invoiceId).toEqual(expect.any(String));
  });

  /**
   * ═══ THE TEETH: A MERGED PATIENT IS THE SAME PERSON, AND A BARE `!==` WOULD BILL NOBODY ═══
   *
   * `opd_encounters.patient_id` is "the canonical id AT OPEN" — it is not rewritten when the record
   * is later merged. So for every patient the hospital has ever de-duplicated, the visit holds the
   * LOSER's id while every screen, search and picker hands the counter the WINNER's. That is the
   * ordinary state of a merged patient's history, not an edge case, and the naive version of this
   * guard refuses to bill all of it — a guard that stops the cashier taking money from a real
   * person standing at the window.
   *
   * Both sides therefore resolve through the merge chain before they are compared.
   */
  it("bills a merged patient's older visit under the surviving record", async () => {
    const winner = await mkPatient("Abhay Kumar");
    const loser = await mkPatient("Abhay K");
    const visitBeforeTheMerge = await mkEncounter(loser);
    /*
      The merge STATE, written directly: `createMergeRequest`/`executeMerge` carry a
      separation-of-duties gate that is `merge.test.ts`'s subject, and what this needs is what they
      leave behind.
    */
    await db.update(patients)
      .set({ status: "merged", mergedIntoPatientId: winner })
      .where(eq(patients.id, loser));

    const priced = await previewInvoice(
      db, { patientId: winner, encounterId: visitBeforeTheMerge, lines: [line()] }, NOW,
    );
    expect(priced.lines).toHaveLength(1);
  });

  /* A draft with no encounter at all is unchanged — the counter sells over-the-counter items too. */
  it("leaves an encounter-less draft alone", async () => {
    const ankit = await mkPatient("Ankit Kumar");
    const priced = await previewInvoice(db, { patientId: ankit, lines: [line()] }, NOW);
    expect(priced.lines).toHaveLength(1);
  });
});
