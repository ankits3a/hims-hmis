import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "../../../test/helpers/opd";
import { opdPrescriptionDrafts, patientAllergies } from "../../kernel/db/schema";
import { startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { discardDraft, getPendingDraft, issueDraft, saveDraft } from "./prescription-drafts";
import { listPrescriptions } from "./prescriptions";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import type { EncounterRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { Db } from "../../kernel/db/client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 20 * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

const SLIP: RxLine[] = [
  { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false },
  { drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS", durationDays: null, instructions: null, noSubstitution: false },
];
const PENICILLIN: RxLine[] = [
  { drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false },
];

/**
 * ═══ FD-30 — THE PAPER SLIP, TRANSCRIBED THEN CONFIRMED (OWNER RULING 2026-09-12) ═══
 *
 * *"Sometimes doctors have so tight schedule that they fail to enter his observation on the
 * operating system. They just write manually by pen on the prescription slip."* The ruling:
 * **draft then confirm, doctor taps to issue.**
 *
 * The whole safety argument of this phase is one sentence — *the scribe never prescribes* — and it
 * is not a claim this suite takes on trust from a permission string. Three rows below execute the
 * refusal itself: a scribe issuing, a DIFFERENT doctor issuing, and a doctor issuing into an
 * allergy conflict. A permission can be widened by a future commit and the model would still pass
 * its census; `requireTreatingDoctor` failing is the property that actually holds.
 */
describe("FD-30 — the transcription draft, and the doctor's tap", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let scribe: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let patient: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    /*
      THE GRANT IS REAL, because the guard under test is a REAL permission read. `ensureRole` mints a
      role row and no permissions, so a scribe made the ordinary way would be refused
      `transcription_not_permitted` for the wrong reason and the Mode B rows below would pass while
      proving nothing. The radiology helper sets the same thing up the same way.
    */
    const registry = new ModuleRegistry();
    registry.install({ key: "opd", title: "OPD", menu: [], permissions: ["opd.prescription.transcribe"], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "opd_scribe");
    await grantPermissionToRole(db, registry, "opd_scribe", "opd.prescription.transcribe");
    scribe = await mkUser(db, "scribe", ["opd_scribe"]);
    patient = await mkPatient(db, clerk.actor, {});
  });

  async function inConsult(doc = dra): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doc.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, doc.actor, opened.sessionId, MON);
    return (await startConsultation(db, doc.actor, opened.encounter.id, MON)).encounter;
  }

  it("the scribe composes, the pending draft reads back, and re-saving REPLACES rather than piling up", async () => {
    const enc = await inConsult();
    const first = await saveDraft(db, scribe.actor, enc.id, { lines: SLIP, note: "handwriting unclear on line 2" }, MON);
    expect(first).toMatchObject({
      encounterId: enc.id, patientId: patient.id, status: "pending",
      draftedBy: scribe.id, note: "handwriting unclear on line 2", issuedPrescriptionId: null,
    });
    expect(first.lines).toEqual(SLIP);

    const reread = await getPendingDraft(db, enc.id);
    expect(reread?.id).toBe(first.id);

    /* The scribe re-reads the slip and corrects it. ONE pending row, not two — the partial unique
       index says so, and a second row would leave the doctor choosing between two slips. */
    const second = await saveDraft(db, scribe.actor, enc.id, { lines: [SLIP[0]!], note: null }, MON2);
    expect(second.id).toBe(first.id);
    expect(second.lines).toHaveLength(1);
    expect(second.note).toBeNull();
    const all = await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.encounterId, enc.id));
    expect(all).toHaveLength(1);

    /* AND IT IS NOT A PRESCRIPTION. Nothing downstream can see it — this is the claim the whole
       separate-table decision rests on, so it is executed rather than asserted in a comment. */
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
  });

  it("an empty slip is not a transcription of anything", async () => {
    const enc = await inConsult();
    await expect(saveDraft(db, scribe.actor, enc.id, { lines: [] }, MON)).rejects.toMatchObject({ code: "empty_prescription" });
  });

  /**
   * ═══ THE ROW THIS PHASE EXISTS FOR ═══
   *
   * The scribe holds `opd.prescription.draft` and NOT `opd.consult`, so the route refuses them
   * first. This calls the service DIRECTLY, underneath the decorator, because a permission is a
   * door and `requireTreatingDoctor` is the lock — and it is the lock that must hold if a future
   * commit ever widens the door.
   */
  it("a SCRIBE cannot issue the draft they wrote — not_a_doctor, underneath the permission", async () => {
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);

    await expect(issueDraft(db, scribe.actor, testCfg, enc.id, {}, MON2)).rejects.toMatchObject({ code: "not_a_doctor" });
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
    expect((await getPendingDraft(db, enc.id))?.status).toBe("pending");
  });

  it("ANOTHER doctor cannot issue it either — the slip belongs to the treating doctor's encounter", async () => {
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);

    await expect(issueDraft(db, drb.actor, testCfg, enc.id, {}, MON2)).rejects.toMatchObject({ code: "not_your_patient" });
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
    expect((await getPendingDraft(db, enc.id))?.status).toBe("pending");
  });

  it("the TREATING doctor's tap issues it — prescribed by the doctor, typed by the scribe, and the chain is recoverable", async () => {
    const enc = await inConsult();
    const draft = await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);

    const issued = await issueDraft(db, dra.actor, testCfg, enc.id, {}, MON2);
    expect(issued.version).toBe(1);
    expect(issued.draftId).toBe(draft.id);

    const rows = await listPrescriptions(db, dra.actor, enc.id);
    expect(rows).toHaveLength(1);
    /*
      BOTH NAMES, AND THIS IS THE MEDICO-LEGAL POINT. `doctorId` and `issuedBy` are the DOCTOR —
      they were never going to be anyone else, because `issuePrescription` derives both from the
      actor and the encounter. The scribe is recoverable from the draft row, which is why
      `opd_prescriptions` needed no new column for any of this.
    */
    expect(rows[0]).toMatchObject({ doctorId: dra.doctorId, issuedBy: dra.userId, status: "active" });
    expect(rows[0]!.lines).toEqual(SLIP);

    const after = await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.id, draft.id));
    expect(after[0]).toMatchObject({
      status: "issued", resolvedBy: dra.userId, issuedPrescriptionId: issued.prescriptionId, draftedBy: scribe.id,
    });
    /* Issued, so it is off the doctor's list — the next read finds nothing pending. */
    expect(await getPendingDraft(db, enc.id)).toBeNull();
  });

  /**
   * ═══ THE GATES DID NOT MOVE, AND THE DRAFT SURVIVES THE REFUSAL ═══
   *
   * A transcription path that skipped the allergy check would be the one genuinely dangerous way to
   * build this. It does not skip it — the tap runs `issuePrescription` whole — and the SECOND half
   * matters just as much: the draft must still be PENDING afterwards, because the doctor's next act
   * is to look at the slip the warning is about.
   */
  it("the doctor's tap runs every safety gate, and a refused tap leaves the slip pending", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const enc = await inConsult();
    const draft = await saveDraft(db, scribe.actor, enc.id, { lines: PENICILLIN }, MON);

    await expect(issueDraft(db, dra.actor, testCfg, enc.id, {}, MON2)).rejects.toMatchObject({ code: "allergy_conflict" });
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
    expect((await getPendingDraft(db, enc.id))?.id).toBe(draft.id);

    /* The override rides the DOCTOR'S tap, never the draft — clearing a conflict is a clinical
       judgement with a reason recorded against the prescriber who made it. */
    const issued = await issueDraft(
      db, dra.actor, testCfg, enc.id,
      { overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "patient reports the rash was to amoxicillin, not penicillin V" }] },
      MON2,
    );
    expect(issued.allergyOverrideCount).toBe(1);
    expect((await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.id, draft.id)))[0]!.status).toBe("issued");
  });

  /**
   * ═══ FD-31 — MODE B: NO ASSISTANT, SO THE DESK SENDS IT (OWNER RULING 2026-09-12) ═══
   *
   * *"I can't hire a human assistant for the doctor to scribe on behalf of the doctor."* So the
   * desk sends a slip the doctor signed in pen, and the clinical check moves to the pharmacist.
   *
   * The three properties that make that safe are each executed here rather than asserted in prose:
   * the PRESCRIBER still comes from the encounter, the GRANT is required, and the row is MARKED.
   */
  it("the desk sends a signed paper slip: the prescriber is the ENCOUNTER'S doctor, and the row says it was transcribed", async () => {
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);

    const issued = await issueDraft(db, scribe.actor, testCfg, enc.id, {}, MON2, "paper_slip");
    const rows = await listPrescriptions(db, dra.actor, enc.id);
    expect(rows).toHaveLength(1);
    /*
      `doctorId` IS STILL DR A. The clerk named nobody — there is no field on this road for them to
      name a doctor with — so a transcription cannot attribute a prescription to a doctor the
      patient never saw. `issuedBy` is the clerk because the clerk operated the keyboard, and
      `transcribedBy` is what every reader downstream branches on.
    */
    expect(rows[0]).toMatchObject({ doctorId: dra.doctorId, issuedBy: scribe.id, transcribedBy: scribe.id, status: "active" });
    expect(issued.prescriptionId).toBe(rows[0]!.id);
  });

  it("without the transcribe grant the same call is refused — and the refusal is the SERVICE's, not the route's", async () => {
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);
    /* `clerk` is `front_office`: it holds neither `opd.consult` nor `opd.prescription.transcribe`. */
    await expect(issueDraft(db, clerk.actor, testCfg, enc.id, {}, MON2, "paper_slip"))
      .rejects.toMatchObject({ code: "transcription_not_permitted" });
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
  });

  it("MODE B DOES NOT SKIP THE SAFETY GATES — an allergy still refuses, and the desk cannot override it", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: PENICILLIN }, MON);

    await expect(issueDraft(db, scribe.actor, testCfg, enc.id, {}, MON2, "paper_slip"))
      .rejects.toMatchObject({ code: "allergy_conflict" });
    expect(await listPrescriptions(db, dra.actor, enc.id)).toEqual([]);
    expect((await getPendingDraft(db, enc.id))?.status).toBe("pending");
  });

  /** The doctor's own tap is UNCHANGED by any of this: nothing is marked, because nothing was transcribed. */
  it("a doctor-issued prescription carries NO transcriber", async () => {
    const enc = await inConsult();
    await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);
    await issueDraft(db, dra.actor, testCfg, enc.id, {}, MON2);
    expect((await listPrescriptions(db, dra.actor, enc.id))[0]).toMatchObject({ transcribedBy: null });
  });

  it("a discarded slip is gone from the list but not from the record, and cannot then be issued", async () => {
    const enc = await inConsult();
    const draft = await saveDraft(db, scribe.actor, enc.id, { lines: SLIP }, MON);

    const discarded = await discardDraft(db, dra.actor, enc.id, MON2);
    expect(discarded).toMatchObject({ id: draft.id, status: "discarded", resolvedBy: dra.userId });
    expect(await getPendingDraft(db, enc.id)).toBeNull();
    /* Kept, not deleted: who typed it and who threw it away is the audit trail. */
    const rows = await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.id, draft.id));
    expect(rows).toHaveLength(1);

    await expect(issueDraft(db, dra.actor, testCfg, enc.id, {}, MON2)).rejects.toMatchObject({ code: "unknown_draft" });
    /* And discarding nothing is not an error — the doctor's second tap on an empty list says so. */
    expect(await discardDraft(db, dra.actor, enc.id, MON2)).toBeNull();
  });
});
