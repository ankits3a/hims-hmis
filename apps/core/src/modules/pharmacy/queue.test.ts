import { and, desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { mkPatient, testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { prescriptionIssued } from "../opd";
import { claimDispense, findAtCounter } from "./claim";
import { handlePrescriptionIssued } from "./consumers";
import { getDispense, listQueue } from "./queue";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PHASE PD, PD-1 — what the queue says about a ticket somebody else is working, and about a patient
 * the reader may not name. Both answers belong on the ROW: a pharmacist should never have to be
 * refused to learn a fact the list could have told them.
 */
describe("the counter's queue — who holds a ticket, and who is on it (PD-1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const TODAY = "2026-08-17";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  /**
   * Issue, then run the worker's consumer on the event — how a ticket reaches the queue in
   * production. NOT the QR scan: that door reads the prescription AS the pharmacist, and refuses a
   * sealed patient's to one who may not read it (measured here, E3), so it would build a different
   * queue from the one the worker builds.
   */
  async function queued(drug: string, medicineId: string, opts: { patientId?: string; at?: Date } = {}): Promise<string> {
    const { encounter } = await issueRx(db, fx, [line({ drug, medicineId })], opts);
    const [e] = await db.select({ eventId: events.eventId, payload: events.payload }).from(events)
      .where(and(eq(events.name, prescriptionIssued.name), eq(events.encounterId, encounter.id))).orderBy(desc(events.seq)).limit(1);
    const { dispenseId } = await withTx(db, (tx) => handlePrescriptionIssued(tx, e!.eventId, e!.payload, MON2));
    return dispenseId!;
  }

  it("E1 — a claimed ticket names its holder on every OTHER pharmacist's list", async () => {
    await queued("Crocin 500", fx.med.crocin);
    const [waiting] = await listQueue(db, fx.incharge.actor, { serviceDate: TODAY });
    expect(waiting).toMatchObject({ status: "queued", claimedBy: null, claimedByName: null });

    await claimDispense(db, fx.pharmacist.actor, { dispenseId: waiting!.dispenseId, door: "token" }, MON2);
    const [held] = await listQueue(db, fx.incharge.actor, { serviceDate: TODAY });
    // `mkUser` makes the full name the username, so the NAME here is the user's `full_name` column.
    expect(held).toMatchObject({ status: "claimed", claimedBy: fx.pharmacist.id, claimedByName: "ph.mehta" });
  });

  it("E1 — a claimed ticket opened by another pharmacist names its holder on the ticket itself", async () => {
    const id = await queued("Crocin 500", fx.med.crocin);
    expect(await getDispense(db, fx.incharge.actor, id, MON2)).toMatchObject({ claimedBy: null, claimedByName: null });
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "token" }, MON2);
    expect(await getDispense(db, fx.incharge.actor, id, MON2)).toMatchObject({ claimedBy: fx.pharmacist.id, claimedByName: "ph.mehta" });
  });

  it("E1 — the pharmacist who loses the claim is told WHO won it, not only that they lost", async () => {
    await queued("Crocin 500", fx.med.crocin);
    const [row] = await listQueue(db, fx.incharge.actor, { serviceDate: TODAY });
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: row!.dispenseId, door: "token" }, MON2);

    await expect(claimDispense(db, fx.incharge.actor, { dispenseId: row!.dispenseId, door: "token" }, MON2))
      .rejects.toMatchObject({
        code: "dispense_not_in_state",
        detail: { status: "claimed", claimedBy: fx.pharmacist.id, claimedByName: "ph.mehta" },
      });
  });

  it("E3, MEASURED — a sealed patient's ticket is ON the list, under the alias; nobody is dropped", async () => {
    /* The phase doc said `listQueue` drops patients the reader may not see. It does not:
       `getPatientSummaries` returns a confidential patient RESTRICTED — alias, no name — and the FK
       on `pharmacy_dispenses.patient_id` means a summary can be missing only for a merge chain it
       cannot follow. This pins the listing so it cannot quietly become a drop. */
    const sealed = await mkPatient(db, fx.clerk.actor, { name: "Real Name", phone: "9876500001", isConfidential: true, alias: "Patient R-17" });
    await queued("Crocin 500", fx.med.crocin);
    await queued("Calpol 500", fx.med.calpol, { patientId: sealed.id, at: MON2 });

    const rows = await listQueue(db, fx.pharmacist.actor, { serviceDate: TODAY });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.patient.id === sealed.id)?.patient).toEqual({
      id: sealed.id, uhid: sealed.uhid, name: null, alias: "Patient R-17", restricted: true,
    });
  });

  it("E3b — a sealed patient's SIGNED slip scanned by a pharmacist who may not open it says RESTRICTED, not 'not found'", async () => {
    /* The slip is a signed capability and the patient is standing at the window holding it:
       `verifyPrescriptionQr` has just proved the prescription exists, so a null from the reader's
       own `getPrescription` has one meaning. `getDispense`'s "unknown" for an invisible patient is
       a different, deliberate rule (an id is not a capability) and is untouched. */
    const sealed = await mkPatient(db, fx.clerk.actor, { name: "Real Name", phone: "9876500002", isConfidential: true, alias: "Patient R-18" });
    const { issued } = await issueRx(db, fx, [line({ drug: "Calpol 500", medicineId: fx.med.calpol })], { patientId: sealed.id });
    expect(await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2))
      .toEqual({ kind: "none", door: "rx_qr", reason: "restricted" });
  });

  it("E3, THE REAL DEFECT — a sealed ticket this pharmacist may not open is refused as RESTRICTED, never as 'not found'", async () => {
    /* Measured 2026-09-19: the claim answered `unknown_prescription` — "prescription … not found" —
       about a ticket on the pharmacist's own list, because `getPrescription` returns null for a
       record the reader may not see and the FK means that is the ONLY reason it can. The grant is
       not widened; the refusal names the rule. */
    const sealed = await mkPatient(db, fx.clerk.actor, { name: "Real Name", phone: "9876500001", isConfidential: true, alias: "Patient R-17" });
    const dispenseId = await queued("Calpol 500", fx.med.calpol, { patientId: sealed.id });

    await expect(claimDispense(db, fx.pharmacist.actor, { dispenseId, door: "token" }, MON2))
      .rejects.toMatchObject({ code: "permission_denied", detail: { reason: "patient_restricted" } });
    const [row] = await listQueue(db, fx.pharmacist.actor, { serviceDate: TODAY });
    expect(row).toMatchObject({ status: "queued", claimedBy: null }); // nothing was written by the refusal
  });
});
