import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "../../../test/helpers/opd";
import {
  events, opdEncounters, opdPrescriptionDrafts, opdPrescriptions, opdQueueEntries, patientAllergies, patientDocuments, workflowInstances,
} from "../../kernel/db/schema";
import { captureDocument } from "../patients";
import { completeConsultation, parkConsultation, registerConsultStartGuard, saveConsultNote, startConsultation } from "./consultation";
import { loadOpdDepartmentReport, loadOpdReport } from "./report";
import { getEncounter, openVisit } from "./encounters";
import { registerPaperConsultHook } from "./opd.module";
import {
  PAPER_FEE_REASON, confirmPaperConsult, correctPaperPrescription, listPaperConsults, markConsultedOnPaper,
  paperCheck, reopenPaperConsult, transcribePaper,
} from "./paper-consult";
import { issuePrescription } from "./prescriptions";
import { callNext, listQueue } from "./queue";
import { recordVitals } from "./vitals";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { PaperVerdict } from "./paper-consult";

const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 20 * 60_000);
const MON3 = new Date(MON.getTime() + 40 * 60_000);
const TUE = new Date(MON.getTime() + 24 * 60 * 60_000);
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const PARA: RxLine = { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false };
const CETZ: RxLine = { drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS", durationDays: 3, instructions: null, noSubstitution: false };
const PEN: RxLine = { drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false };
const CBC = { serviceId: "svc-cbc", code: "LAB-CBC", name: "Complete blood count", pricePaise: 25000 };
const LFT = { serviceId: "svc-lft", code: "LAB-LFT", name: "Liver function test", pricePaise: 60000 };

class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> { return this.files.get(key)!; }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

/**
 * ═══ CONSULTED ON PAPER — OWNER RULING 2026-10-06 ═══
 *
 * *"If the Slip Desk or Scribe Desk staff by performing either clicking a picture of prescription
 * slip or typing the prescriptions … will mark the patient as Consulted even if the doctor hasn't
 * marked or has not operated dashboard."* A) the pharmacy may dispense from what the desk typed;
 * B) only the slip desk and the desk scribe may close a visit this way.
 *
 * Every rule below is executed against the real permission read, the real workflow engine and the
 * real document capture — a paper road that closed visits for the wrong seat, on the wrong day, or
 * over a doctor's open consultation would be worse than the stuck queue it replaces.
 */
describe("consulted on paper — the slip desk, the scribe, the doctor's look and the supervisor's reopen", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let store: FakeStore;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let slipDesk: Awaited<ReturnType<typeof mkUser>>;
  let scribe: Awaited<ReturnType<typeof mkUser>>;
  let typist: Awaited<ReturnType<typeof mkUser>>;
  let supervisor: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let patient: { id: string; uhid: string };
  let unhook: () => void;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unhook = registerPaperConsultHook(); });
  afterAll(async () => { unhook(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    store = new FakeStore();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    /* REAL grants — `ensureRole` mints a role with no permissions, and every guard here reads one. */
    const registry = new ModuleRegistry();
    registry.install({
      key: "opd", title: "OPD", menu: [], subscriptions: [],
      permissions: ["opd.prescription.transcribe", "opd.consult.paper", "opd.queue.transfer"],
    });
    await syncPermissions(db, registry);
    for (const role of ["opd_scribe", "opd_slip_desk", "opd_typist_only", "front_office_supervisor"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "opd_scribe", "opd.prescription.transcribe");
    await grantPermissionToRole(db, registry, "opd_scribe", "opd.consult.paper");
    await grantPermissionToRole(db, registry, "opd_slip_desk", "opd.consult.paper");
    await grantPermissionToRole(db, registry, "opd_typist_only", "opd.prescription.transcribe");
    await grantPermissionToRole(db, registry, "front_office_supervisor", "opd.queue.transfer");
    scribe = await mkUser(db, "scribe", ["opd_scribe"]);
    slipDesk = await mkUser(db, "slipdesk", ["opd_slip_desk"]);
    typist = await mkUser(db, "typist", ["opd_typist_only"]);
    supervisor = await mkUser(db, "sup", ["front_office_supervisor"]);
    patient = await mkPatient(db, clerk.actor, {});
  });

  async function registered(doc = dra, at = MON): Promise<EncounterRow> {
    return (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doc.doctorId }, at)).encounter;
  }
  async function waiting(doc = dra, at = MON): Promise<EncounterRow> {
    const enc = await registered(doc, at);
    await recordVitals(db, vd.actor, enc.id, adultOk, at);
    return (await getEncounter(db, enc.id))!;
  }
  async function fileSlip(by: { actor: typeof clerk.actor }, enc: EncounterRow, at = MON2): Promise<{ documentId: string; paper: PaperVerdict | undefined }> {
    const out = await withTx(db, (tx) => captureDocument(tx, store, by.actor, enc.patientId, {
      encounterId: enc.id, kind: "consult_prescription", mimeType: "image/jpeg", bytes: JPEG,
    }, at));
    return { documentId: out.documentId, paper: out.effects["opd.paper"] as PaperVerdict | undefined };
  }
  const named = (name: string, encounterId: string) =>
    db.select().from(events).where(and(eq(events.name, name), eq(events.encounterId, encounterId)));
  const liveEntries = async (encounterId: string) =>
    (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(desc(opdQueueEntries.seq)));

  // ——— the slip desk ———

  it("a photographed slip closes a WAITING visit: completed, off the doctor's line, and the desk's name is on it", async () => {
    const enc = await waiting();
    expect((await listQueue(db, dra.actor, dra.doctorId, enc.serviceDate, MON))!.ordered.map((q) => q.encounterId)).toEqual([enc.id]);

    const { documentId, paper } = await fileSlip(slipDesk, enc);
    expect(paper).toMatchObject({ outcome: "marked", consulted: true, encounterId: enc.id, visitNo: enc.visitNo });

    const after = (await getEncounter(db, enc.id))!;
    expect(after).toMatchObject({
      status: "completed", completedVia: "paper", paperCompletedBy: slipDesk.id,
      paperEvidenceKind: "slip_photo", paperEvidenceId: documentId, followUpDays: 7, followUpExtended: false,
    });
    expect(after.consultCompletedAt).toEqual(MON2);
    expect((await liveEntries(enc.id))[0]!.status).toBe("done");
    const view = (await listQueue(db, dra.actor, dra.doctorId, enc.serviceDate, MON2))!;
    expect(view.ordered).toEqual([]);
    expect(view.inConsult).toEqual([]);
    /* The workflow instance really ended — the mirror column is not lying about a live instance. */
    const wf = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, enc.workflowInstanceId)))[0]!;
    expect(wf).toMatchObject({ currentState: "completed", status: "completed" });

    /* Every reader of a completion still counts it; the audit's own event names the desk. */
    expect(await named("consultation.completed", enc.id)).toHaveLength(1);
    const audit = await named("consultation.completed_on_paper", enc.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "user", actorId: slipDesk.id });
    expect(audit[0]!.payload).toMatchObject({ fromState: "waiting", evidenceKind: "slip_photo", evidenceId: documentId, feeUnsettled: false });
  });

  it("a visit that never reached the vitals bay is closed too — the doctor saw them, and that is what the paper says", async () => {
    const enc = await registered();
    const { paper } = await fileSlip(slipDesk, enc);
    expect(paper?.outcome).toBe("marked");
    expect((await getEncounter(db, enc.id))!.status).toBe("completed");
    expect((await liveEntries(enc.id))[0]!.status).toBe("done");
    expect((await named("consultation.completed_on_paper", enc.id))[0]!.payload).toMatchObject({ fromState: "registered" });
  });

  it("RULING B: a seat without the grant still FILES the slip — and closes nothing", async () => {
    const enc = await waiting();
    /* `clerk` is front_office: it holds `patients.update` in production, and not `opd.consult.paper`. */
    const { documentId, paper } = await fileSlip(clerk, enc);
    expect(paper).toMatchObject({ outcome: "not_permitted", consulted: false });
    expect((await getEncounter(db, enc.id))!).toMatchObject({ status: "waiting", completedVia: null });
    expect((await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId)))).toHaveLength(1);
    expect(await named("consultation.completed", enc.id)).toHaveLength(0);
  });

  it("TODAY ONLY: yesterday's visit is filed against and left exactly as it stood", async () => {
    const enc = await waiting();
    const { paper } = await fileSlip(slipDesk, enc, TUE);
    expect(paper).toMatchObject({ outcome: "not_today", consulted: false });
    expect((await getEncounter(db, enc.id))!.status).toBe("waiting");
  });

  it("only the doctor's own slip counts — an outside report filed on the visit closes nothing", async () => {
    const enc = await waiting();
    const out = await withTx(db, (tx) => captureDocument(tx, store, slipDesk.actor, enc.patientId, {
      encounterId: enc.id, kind: "outside_report", mimeType: "image/jpeg", bytes: JPEG,
    }, MON2));
    expect(out.effects["opd.paper"]).toBeUndefined();
    expect((await getEncounter(db, enc.id))!.status).toBe("waiting");
  });

  /**
   * ═══ OWNER, 2026-10-06: "Yes, paper close that visit too." ═══
   *
   * A visit the doctor STARTED on the screen and never completed is closed by the paper road as
   * well. What the doctor typed is the part that must survive it: the medicines drafted on the
   * screen and never issued stay drafted and UNISSUED (the pharmacy gets only what the desk typed),
   * they are shown to the doctor, and the doctor's own screen — still open on that patient — is
   * told in a sentence rather than handed a state error.
   */
  it("a consultation the doctor STARTED and left open is closed by the slip too — the draft they typed is kept, issued by nobody, and shown to them", async () => {
    const enc = await waiting();
    const opened = (await liveEntries(enc.id))[0]!;
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, enc.id, MON);
    const DRAFT = [{ drug: "Tab Azithromycin 500", dose: "1 tab", route: "oral", frequency: "OD", durationDays: "3", instructions: "", noSubstitution: false }];
    await saveConsultNote(db, dra.actor, enc.id, { chiefComplaint: "fever", rxDraft: DRAFT }, MON);

    const { documentId, paper } = await fileSlip(slipDesk, enc);
    expect(paper).toMatchObject({ outcome: "marked", consulted: true });
    const after = (await getEncounter(db, enc.id))!;
    expect(after).toMatchObject({ status: "completed", completedVia: "paper", paperCompletedBy: slipDesk.id, paperEvidenceId: documentId, chiefComplaint: "fever" });
    expect(after.consultStartedAt).toEqual(MON); // the doctor's own start is not rewritten
    expect((await liveEntries(enc.id))[0]!.status).toBe("done");
    expect((await named("consultation.completed_on_paper", enc.id))[0]!.payload).toMatchObject({ fromState: "in_consultation" });

    /* THE DRAFT: still on the visit, word for word; no prescription was issued from it; the doctor's list names it. */
    expect(after.rxDraft).toEqual(DRAFT);
    expect(await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id))).toHaveLength(0);
    expect(await named("prescription.issued", enc.id)).toHaveLength(0);
    const mine = await listPaperConsults(db, dra.actor, { scope: "mine" }, MON3);
    expect(mine.items[0]!.doctorDraft).toEqual([{ drug: "Tab Azithromycin 500", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 3, instructions: null, noSubstitution: false }]);

    /* THE DOCTOR'S SCREEN, STILL OPEN: a sentence about what happened — for the save, the completion and an issue. */
    for (const act of [
      () => saveConsultNote(db, dra.actor, enc.id, { chiefComplaint: "fever, cough" }, MON3),
      () => completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON3),
      () => issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [PARA] }, MON3),
    ]) {
      await expect(act()).rejects.toMatchObject({ code: "closed_on_paper_state_conflict", message: expect.stringContaining("marked consulted from your paper prescription") });
    }
    /* …and the doctor can still issue what they had drafted, the sanctioned way. */
    const row = await correctPaperPrescription(db, dra.actor, testCfg, enc.id, { lines: mine.items[0]!.doctorDraft }, MON3);
    expect(row.prescription).toMatchObject({ version: 1, transcribedByName: null });
    expect(row.doctorDraft).toEqual([]);
  });

  it("a PARKED consultation is closed the same way, and the scribe's typing sends ONLY the scribe's lines", async () => {
    const enc = await waiting();
    await startConsultation(db, dra.actor, enc.id, MON);
    await saveConsultNote(db, dra.actor, enc.id, { rxDraft: [{ drug: "Tab Azithromycin 500", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 3, instructions: "", noSubstitution: false }] }, MON);
    await parkConsultation(db, dra.actor, enc.id, MON);

    const out = await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA] }, MON2);
    expect(out.paper).toMatchObject({ outcome: "marked", consulted: true });
    const rx = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id));
    expect(rx).toHaveLength(1);
    expect(rx[0]!.lines).toEqual([PARA]); // not the doctor's unissued Azithromycin
    expect(rx[0]!.transcribedBy).toBe(scribe.id);
    const entry = (await liveEntries(enc.id))[0]!;
    expect(entry).toMatchObject({ status: "done", parkedAt: null });
    expect((await listPaperConsults(db, dra.actor, { scope: "mine" }, MON3)).items[0]!.doctorDraft.map((l) => l.drug)).toEqual(["Tab Azithromycin 500"]);
  });

  it("a visit the doctor completed on the screen stays the doctor's: nothing is rewritten", async () => {
    const enc = await waiting();
    await startConsultation(db, dra.actor, enc.id, MON);
    await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2);
    const { paper } = await fileSlip(slipDesk, enc, MON3);
    expect(paper).toMatchObject({ outcome: "doctor_completed", consulted: true });
    const after = (await getEncounter(db, enc.id))!;
    expect(after.completedVia).toBeNull();
    expect(after.consultCompletedAt).toEqual(MON2);
    expect(await named("consultation.completed_on_paper", enc.id)).toHaveLength(0);
  });

  it("WHICHEVER COMES FIRST: the second page, and the typing after it, find the visit closed and change nothing", async () => {
    const enc = await waiting();
    const first = await fileSlip(slipDesk, enc, MON2);
    const second = await fileSlip(slipDesk, enc, MON3);
    expect(second.paper).toMatchObject({ outcome: "already_marked", consulted: true });
    const typed = await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA] }, MON3);
    expect(typed.paper).toMatchObject({ outcome: "already_marked", consulted: true });

    const after = (await getEncounter(db, enc.id))!;
    expect(after).toMatchObject({ paperCompletedBy: slipDesk.id, paperEvidenceKind: "slip_photo", paperEvidenceId: first.documentId });
    expect(after.consultCompletedAt).toEqual(MON2);
    expect(await named("consultation.completed", enc.id)).toHaveLength(1);
    expect(await named("consultation.completed_on_paper", enc.id)).toHaveLength(1);
  });

  // ——— the fee door ———

  it("THE FEE DOOR: an unpaid visit is closed, the waiver is written in the desk's name with its reason, and the due is untouched", async () => {
    const off = registerConsultStartGuard("test.fee", async () => ({ ok: false, code: "fee_unsettled" }));
    try {
      const enc = await waiting();
      const { paper } = await fileSlip(slipDesk, enc);
      expect(paper?.outcome).toBe("marked");
      const after = (await getEncounter(db, enc.id))!;
      expect(after).toMatchObject({ status: "completed", consultFeeOverrideBy: slipDesk.id, consultFeeOverrideReason: PAPER_FEE_REASON });
      expect(await named("consultation.fee_overridden", enc.id)).toHaveLength(1);
      expect((await named("consultation.completed_on_paper", enc.id))[0]!.payload).toMatchObject({ feeUnsettled: true });
    } finally { off(); }
  });

  it("a refusal at the consult door that is NOT money refuses the paper road too", async () => {
    const off = registerConsultStartGuard("test.seal", async () => ({ ok: false, code: "record_sealed" }));
    try {
      const enc = await waiting();
      const { paper } = await fileSlip(slipDesk, enc);
      expect(paper).toMatchObject({ outcome: "gate_refused", consulted: false, gate: { guard: "test.seal", code: "record_sealed" } });
      expect((await getEncounter(db, enc.id))!).toMatchObject({ status: "waiting", consultFeeOverrideBy: null });
    } finally { off(); }
  });

  // ——— the desk scribe ———

  it("the scribe types medicines and tests: a real prescription in the DOCTOR's name marked transcribed, the tests where the lab reads them, and the visit closed", async () => {
    const enc = await waiting();
    const out = await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA, CETZ], advisedTests: [CBC, LFT] }, MON2);

    expect(out.paper).toMatchObject({ outcome: "marked", consulted: true });
    expect(out.held).toEqual([]);
    expect(out.prescription).toMatchObject({ version: 1, lineCount: 2 });
    const rx = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id));
    expect(rx).toHaveLength(1);
    expect(rx[0]).toMatchObject({ doctorId: dra.doctorId, issuedBy: scribe.id, transcribedBy: scribe.id, status: "active" });
    /* Ruling A — the pharmacy's queue is fed by this event and by nothing else. */
    expect(await named("prescription.issued", enc.id)).toHaveLength(1);

    const after = (await getEncounter(db, enc.id))!;
    expect(after).toMatchObject({ status: "completed", completedVia: "paper", paperEvidenceKind: "transcription", paperEvidenceId: out.prescription!.prescriptionId });
    expect(after.advisedTests).toEqual([{ ...CBC, transcribedBy: scribe.id }, { ...LFT, transcribedBy: scribe.id }]);
    expect((await named("prescription.paper_transcribed", enc.id))[0]!.payload).toMatchObject({ issuedLines: 2, heldLines: 0, advisedTests: 2 });
  });

  it("tests alone are a transcription too — and typing again REPLACES the desk's tests without touching the doctor's", async () => {
    const enc = await waiting();
    await db.update(opdEncounters).set({ advisedTests: [{ serviceId: "svc-doc", code: "LAB-TSH", name: "TSH", pricePaise: 30000 }] }).where(eq(opdEncounters.id, enc.id));
    await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [], advisedTests: [CBC] }, MON2);
    await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [], advisedTests: [LFT] }, MON3);
    const tests = (await getEncounter(db, enc.id))!.advisedTests as { serviceId: string; transcribedBy?: string }[];
    expect(tests.map((t) => t.serviceId)).toEqual(["svc-doc", "svc-lft"]);
    expect(tests[0]!.transcribedBy).toBeUndefined();
    expect((await getEncounter(db, enc.id))!.status).toBe("completed");
    expect(await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id))).toHaveLength(0);
  });

  it("an empty save is not a transcription of anything", async () => {
    const enc = await waiting();
    await expect(transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [] }, MON2)).rejects.toMatchObject({ code: "empty_prescription" });
    expect((await getEncounter(db, enc.id))!.status).toBe("waiting");
  });

  it("the grants are the SERVICE's: no transcribe grant, no typing; typing without the closing grant writes nothing at all", async () => {
    const enc = await waiting();
    await expect(transcribePaper(db, slipDesk.actor, testCfg, enc.id, { lines: [PARA] }, MON2))
      .rejects.toMatchObject({ code: "transcription_not_permitted" });
    await expect(transcribePaper(db, typist.actor, testCfg, enc.id, { lines: [PARA] }, MON2))
      .rejects.toMatchObject({ code: "paper_consult_not_permitted" });
    expect(await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id))).toHaveLength(0);
    expect((await getEncounter(db, enc.id))!.status).toBe("waiting");
  });

  it("TODAY ONLY for the scribe as well, and never over a prescription the doctor issued on the screen", async () => {
    const old = await waiting();
    await expect(transcribePaper(db, scribe.actor, testCfg, old.id, { lines: [PARA] }, TUE))
      .rejects.toMatchObject({ code: "paper_consult_state_conflict" });

    const other = await mkPatient(db, clerk.actor, {});
    const enc = (await openVisit(db, clerk.actor, { patientId: other.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter;
    await recordVitals(db, vd.actor, enc.id, adultOk, MON);
    await startConsultation(db, dra.actor, enc.id, MON);
    await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [CETZ] }, MON);
    await expect(transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA] }, MON2))
      .rejects.toMatchObject({ code: "doctor_rx_exists_state_conflict" });
    const rx = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id));
    expect(rx).toHaveLength(1);
    expect(rx[0]!.transcribedBy).toBeNull();
  });

  // ——— the scribe clears no warning ———

  it("HELD FOR THE DOCTOR: the line with a hard warning is neither issued nor dropped; the clean line still reaches the pharmacy", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const enc = await waiting();

    const seen = await paperCheck(db, scribe.actor, enc.id, [PARA, PEN], MON2);
    expect(seen.lines).toEqual([{ lineIndex: 1, alerts: [expect.objectContaining({ kind: "allergy", hard: true, substance: "Penicillin" })] }]);

    const out = await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA, PEN], note: "second line hard to read" }, MON2);
    expect(out.prescription).toMatchObject({ lineCount: 1 });
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ line: PEN, alerts: [{ kind: "allergy", hard: true, substance: "Penicillin" }] });

    const rx = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id));
    expect(rx).toHaveLength(1);
    expect(rx[0]!.lines).toEqual([PARA]);
    const draft = (await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.encounterId, enc.id)))[0]!;
    expect(draft).toMatchObject({ status: "pending", draftedBy: scribe.id, note: "second line hard to read" });
    expect(draft.lines).toEqual([PEN]);
    expect(draft.heldAlerts).toEqual([[expect.objectContaining({ kind: "allergy", substance: "Penicillin" })]]);
    /* The patient is not kept waiting for the held line. */
    expect((await getEncounter(db, enc.id))!.status).toBe("completed");
  });

  it("the paper road accepts NO override — a reason sent from a desk is refused, not recorded", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const enc = await waiting();
    await startConsultation(db, dra.actor, enc.id, MON);
    await expect(issuePrescription(
      db, scribe.actor, testCfg, enc.id,
      { lines: [PEN], overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "the desk thinks it is fine" }] },
      MON2, "paper_slip",
    )).rejects.toMatchObject({ code: "override_reason_required" });
    expect(await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id))).toHaveLength(0);
  });

  // ——— the doctor's optional look ———

  it("the doctor's list: held lines first; 'looks right' is refused while a line is held, and is the TREATING doctor's alone", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const held = await waiting();
    await transcribePaper(db, scribe.actor, testCfg, held.id, { lines: [PARA, PEN] }, MON2);
    const other = await mkPatient(db, clerk.actor, {});
    const clean = (await openVisit(db, clerk.actor, { patientId: other.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter;
    await fileSlip(slipDesk, clean, MON3);

    const mine = await listPaperConsults(db, dra.actor, { scope: "mine" }, MON3);
    expect(mine.items.map((r) => r.encounterId)).toEqual([held.id, clean.id]);
    expect(mine.items[0]!.held?.lines).toEqual([PEN]);
    expect(mine.items[0]!.prescription?.transcribedByName).not.toBeNull();
    expect(mine.items[1]!.documents).toHaveLength(1);
    expect((await listPaperConsults(db, drb.actor, { scope: "mine" }, MON3)).items).toEqual([]);

    await expect(confirmPaperConsult(db, dra.actor, held.id, MON3)).rejects.toMatchObject({ code: "paper_consult_state_conflict" });
    await expect(confirmPaperConsult(db, drb.actor, clean.id, MON3)).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(confirmPaperConsult(db, scribe.actor, clean.id, MON3)).rejects.toMatchObject({ code: "not_a_doctor" });

    const ok = await confirmPaperConsult(db, dra.actor, clean.id, MON3);
    expect(ok.confirmedAt).toEqual(MON3);
    expect((await getEncounter(db, clean.id))!.paperConfirmedBy).toBe(dra.userId);
    expect(await named("consultation.paper_confirmed", clean.id)).toHaveLength(1);
    /* A second glance is not a second event. */
    await confirmPaperConsult(db, dra.actor, clean.id, MON3);
    expect(await named("consultation.paper_confirmed", clean.id)).toHaveLength(1);
  });

  it("'correct it': the DOCTOR clears the held line with a reason, in their own name, on a visit already closed", async () => {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance: "Penicillin", source: "registration", recordedBy: "t" });
    const enc = await waiting();
    await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA, PEN] }, MON2);

    /* No reason for the warned line: refused exactly as a consultation would refuse it. */
    await expect(correctPaperPrescription(db, dra.actor, testCfg, enc.id, { lines: [PARA, PEN] }, MON3))
      .rejects.toMatchObject({ code: "allergy_conflict" });
    await expect(correctPaperPrescription(db, drb.actor, testCfg, enc.id, { lines: [PARA, PEN], reasons: [{ lineIndex: 1, reason: "no" }] }, MON3))
      .rejects.toMatchObject({ code: "not_your_patient" });

    const row = await correctPaperPrescription(
      db, dra.actor, testCfg, enc.id,
      { lines: [PARA, PEN], reasons: [{ lineIndex: 1, reason: "the reaction on file was to amoxicillin" }] }, MON3,
    );
    expect(row.held).toBeNull();
    expect(row.prescription).toMatchObject({ version: 2, transcribedByName: null });
    const rx = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, enc.id)).orderBy(desc(opdPrescriptions.version));
    expect(rx[0]).toMatchObject({ version: 2, status: "active", issuedBy: dra.userId, transcribedBy: null });
    expect(rx[0]!.allergyOverrides).toEqual([{ lineIndex: 1, substance: "Penicillin", reason: "the reaction on file was to amoxicillin" }]);
    expect(rx[1]).toMatchObject({ version: 1, status: "superseded" });
    expect((await db.select().from(opdPrescriptionDrafts).where(eq(opdPrescriptionDrafts.encounterId, enc.id)))[0]!)
      .toMatchObject({ status: "issued", resolvedBy: dra.userId, issuedPrescriptionId: rx[0]!.id });
    expect((await getEncounter(db, enc.id))!.paperConfirmedBy).toBe(dra.userId);
    expect((await named("consultation.paper_confirmed", enc.id))[0]!.payload).toMatchObject({ corrected: true });
  });

  it("the ordinary issue route did NOT widen: a doctor still cannot issue on a completed visit outside the paper correction", async () => {
    const enc = await waiting();
    await fileSlip(slipDesk, enc);
    /* Refused — and said as what happened (the desk closed it), not as a bare state error. */
    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [PARA] }, MON3))
      .rejects.toMatchObject({ code: "closed_on_paper_state_conflict" });
    await expect(issuePrescription(db, scribe.actor, testCfg, enc.id, { lines: [PARA] }, MON3, "paper_slip"))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  // ——— the supervisor's reopen ———

  it("REOPEN: the supervisor puts a wrongly-closed patient back in the line with their own token, and the paper's fee waiver is withdrawn", async () => {
    const off = registerConsultStartGuard("test.fee", async () => ({ ok: false, code: "fee_unsettled" }));
    try {
      const enc = await waiting();
      const token = (await liveEntries(enc.id))[0]!.tokenNo;
      await fileSlip(slipDesk, enc);

      await expect(reopenPaperConsult(db, clerk.actor, enc.id, { reason: "wrong visit" }, MON3)).rejects.toMatchObject({ code: "paper_consult_not_permitted" });
      await expect(reopenPaperConsult(db, supervisor.actor, enc.id, { reason: " " }, MON3)).rejects.toMatchObject({ code: "reason_required" });
      await expect(reopenPaperConsult(db, supervisor.actor, enc.id, { reason: "wrong visit" }, TUE)).rejects.toMatchObject({ code: "paper_consult_state_conflict" });

      const { encounter } = await reopenPaperConsult(db, supervisor.actor, enc.id, { reason: "slip was filed on the wrong visit" }, MON3);
      expect(encounter).toMatchObject({
        status: "waiting", completedVia: null, consultCompletedAt: null, followUpDays: null,
        paperReopenedBy: supervisor.id, paperReopenReason: "slip was filed on the wrong visit",
        consultFeeOverrideBy: null, consultFeeOverrideReason: null,
      });
      expect(encounter.workflowInstanceId).not.toBe(enc.workflowInstanceId);
      const wf = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, encounter.workflowInstanceId)))[0]!;
      expect(wf).toMatchObject({ currentState: "waiting", status: "active" });
      const entries = await liveEntries(enc.id);
      expect(entries[0]).toMatchObject({ status: "waiting", tokenNo: token });
      expect(entries[1]!.status).toBe("done");
      expect((await named("consultation.paper_reopened", enc.id))[0]).toMatchObject({ actorId: supervisor.id });

      /* And it is a real waiting visit again: the paper road can close it a second time. */
      const again = await fileSlip(slipDesk, encounter, new Date(MON3.getTime() + 60_000));
      expect(again.paper?.outcome).toBe("marked");
    } finally { off(); }
  });

  it("REOPEN is for paper closures only — a doctor's own completion is not a desk's to undo", async () => {
    const enc = await waiting();
    await startConsultation(db, dra.actor, enc.id, MON);
    await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2);
    await expect(reopenPaperConsult(db, supervisor.actor, enc.id, { reason: "wrong visit" }, MON3))
      .rejects.toMatchObject({ code: "paper_consult_state_conflict" });
  });

  it("REOPEN can withdraw what the desk typed for the wrong patient; a visit never weighed goes back to the bay", async () => {
    const enc = await registered();
    const typed = await transcribePaper(db, scribe.actor, testCfg, enc.id, { lines: [PARA] }, MON2);
    const { encounter } = await reopenPaperConsult(db, supervisor.actor, enc.id, { reason: "typed on the wrong visit", voidTranscription: true }, MON3);
    expect(encounter.status).toBe("registered");
    expect((await liveEntries(enc.id))[0]!.status).toBe("waiting_vitals");
    expect((await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, typed.prescription!.prescriptionId)))[0]!.status).toBe("superseded");
    expect((await named("consultation.paper_reopened", enc.id))[0]!.payload).toMatchObject({ toState: "registered", voidedPrescriptionId: typed.prescription!.prescriptionId });
  });

  it("the whole day's list is the supervisor's — and a visit the paper road did not touch is not on it", async () => {
    const enc = await waiting();
    await fileSlip(slipDesk, enc);
    const other = await mkPatient(db, clerk.actor, {});
    await openVisit(db, clerk.actor, { patientId: other.id, departmentId: deptId, doctorId: drb.doctorId }, MON);
    await expect(listPaperConsults(db, clerk.actor, { scope: "all" }, MON3)).rejects.toMatchObject({ code: "paper_consult_not_permitted" });
    const all = await listPaperConsults(db, supervisor.actor, { scope: "all" }, MON3);
    expect(all.items.map((r) => r.encounterId)).toEqual([enc.id]);
    expect(all.items[0]).toMatchObject({ completedVia: "paper", evidenceKind: "slip_photo", paperCompletedByName: expect.any(String) });
  });

  // ——— the report follows ———

  it("the OPD day report counts a visit closed from paper as a consultation, and lists the patient", async () => {
    const enc = await waiting();
    const range = { period: "day" as const, anchor: enc.serviceDate, from: enc.serviceDate, to: enc.serviceDate };
    const before = await loadOpdReport(db, range, MON2);
    await markConsultedOnPaper(db, slipDesk.actor, enc.id, { kind: "slip_photo", id: "doc-1" }, MON2);
    const after = await loadOpdReport(db, range, MON3);
    const count = (r: typeof after): number => r.departments.find((d) => d.departmentId === deptId)?.consulted ?? 0;
    expect(count(before)).toBe(0);
    expect(count(after)).toBe(1);
    const list = await loadOpdDepartmentReport(db, supervisor.actor, range, deptId, MON3);
    expect(list!.rows.map((p) => p.visitNo)).toContain(enc.visitNo);
  });
});
