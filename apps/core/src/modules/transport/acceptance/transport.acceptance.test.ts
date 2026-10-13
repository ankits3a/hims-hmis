import { and, eq } from "drizzle-orm";
import { TRANSPORT_KINDS } from "@hmis/contracts";
import { alerts, tasks, transportRequests } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkTransportWorld } from "../../../../test/helpers/transport";
import { acceptTask, completeTask, startTask } from "../../tasks";
import { addEscort, recordOxygenCheck, requestTransport } from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { TransportWorld } from "../../../../test/helpers/transport";

/**
 * E1.6 TRANSPORT (issue #723, decision 0072) — "DONE MEANS" (SPEC-ipd-companions §6, §11; brief §8). Every check calls
 * the intents — the engine's own start and done, where the rules live — never a screen. No date is pinned: every
 * instant is the real clock's, and nothing asserted depends on which one.
 */
jest.setTimeout(90_000);

describe("E1.6 transport — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: TransportWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkTransportWorld(db); });

  /** The porter who holds the task (dispatch gave it to the least-loaded porter on duty), after Accept. */
  async function accepted(taskId: string): Promise<Actor> {
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    expect(row.assigneeId).not.toBeNull();
    const porter: Actor = { type: "user", id: row.assigneeId! };
    await acceptTask(db, porter, { taskId });
    return porter;
  }

  it("(i) a move for a critical-care (ICU) patient cannot start without an escort; with a nurse recorded it starts", async () => {
    const p = await w.admitted("T-ICU-1", "icu");
    const r = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: p.admissionId, toResourceId: w.wardId, mode: "bed", reason: "imaging",
    });
    // The requester did not ask for an escort; the ICU bed forced it.
    expect(r.request.escortRequired).toBe(true);
    expect(r.request.escortReason).toBe("critical_care_bed");
    const porter = await accepted(r.task.id);
    await expect(startTask(db, porter, { taskId: r.task.id })).rejects.toMatchObject({
      code: "escort_required", message: "A critical patient moves only with a nurse or doctor escort.", fix: "Add escort",
    });
    // A person who is not a nurse or doctor is not an escort.
    await expect(addEscort(db, porter, { taskId: r.task.id, escortUserId: w.clerk.id })).rejects.toMatchObject({ code: "escort_not_clinical" });
    await expect(startTask(db, porter, { taskId: r.task.id })).rejects.toMatchObject({ code: "escort_required" });
    await addEscort(db, porter, { taskId: r.task.id, escortUserId: w.escortNurse.id });
    await expect(startTask(db, porter, { taskId: r.task.id })).resolves.toMatchObject({ state: "in_progress" });
  });

  it("(i-b) the requester's high-risk flag forces an escort on a ward patient too", async () => {
    const p = await w.admitted("T-GEN-HR");
    const r = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: p.admissionId, toNote: "CT scan, ground floor", highRisk: true,
    });
    expect(r.request.escortReason).toBe("high_risk_flag");
    const porter = await accepted(r.task.id);
    await expect(startTask(db, porter, { taskId: r.task.id })).rejects.toMatchObject({ code: "escort_required" });
  });

  it("(ii) handover refuses a different patient's wristband; the patient's own band completes the move", async () => {
    const p = await w.admitted("T-GEN-A");
    const other = await w.admitted("T-GEN-B");
    const r = await requestTransport(db, w.requester, { kind: TRANSPORT_KINDS.patientMove, admissionId: p.admissionId, toResourceId: w.roomId });
    const porter = await accepted(r.task.id);
    await startTask(db, porter, { taskId: r.task.id });
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: other.band } })).rejects.toMatchObject({
      code: "wrong_patient",
    });
    // The QR form of the other band is refused the same way; nothing was written.
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: `IPDBAND1|${other.band}|U0000000` } }))
      .rejects.toMatchObject({ code: "wrong_patient" });
    await expect(completeTask(db, porter, { taskId: r.task.id })).rejects.toMatchObject({ code: "proof_missing" });
    const still = (await db.select().from(tasks).where(eq(tasks.id, r.task.id)))[0]!;
    expect(still.state).toBe("in_progress");
    // The patient's own band (its Code 128 serial; the QR form's UHID is checked in review.test.ts) completes it.
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: p.band } }))
      .resolves.toMatchObject({ state: "done" });
    const req = (await db.select().from(transportRequests).where(eq(transportRequests.taskId, r.task.id)))[0]!;
    expect(req.handoverBandSerial).toBe(p.band);
    expect(req.handoverAt).not.toBeNull();
  });

  it("(ii-b) a refused wrong-patient handover leaves a record and tells the services supervisor", async () => {
    const p = await w.admitted("T-GEN-R1");
    const other = await w.admitted("T-GEN-R2");
    const r = await requestTransport(db, w.requester, { kind: TRANSPORT_KINDS.patientMove, admissionId: p.admissionId, toResourceId: w.roomId });
    const porter = await accepted(r.task.id);
    await startTask(db, porter, { taskId: r.task.id });
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: other.band } })).rejects.toMatchObject({
      code: "wrong_patient",
    });
    const req = (await db.select().from(transportRequests).where(eq(transportRequests.taskId, r.task.id)))[0]!;
    expect(req.handoverRefusals).toEqual([expect.objectContaining({ actorId: porter.id, scannedAdmissionId: other.admissionId, serial: other.band })]);
    expect(req.handoverAt).toBeNull();
    const bells = await db.select().from(alerts).where(and(eq(alerts.userId, w.supervisor.id), eq(alerts.kind, "transport.handover_refused")));
    expect(bells).toHaveLength(1);
    expect(bells[0]!.refId).toBe(r.task.id);
  });

  it("(iii) an oxygen move cannot start before the cylinder check", async () => {
    const p = await w.admitted("T-GEN-O2");
    const r = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: p.admissionId, toResourceId: w.wardId, oxygen: true, mode: "stretcher",
    });
    const porter = await accepted(r.task.id);
    await expect(startTask(db, porter, { taskId: r.task.id })).rejects.toMatchObject({ code: "oxygen_not_checked" });
    await recordOxygenCheck(db, porter, { taskId: r.task.id });
    await expect(startTask(db, porter, { taskId: r.task.id })).resolves.toMatchObject({ state: "in_progress" });
  });

  it("(iv) the same patient's move asked twice within ten minutes merges; a different patient never merges", async () => {
    const a = await w.admitted("T-GEN-M1");
    const b = await w.admitted("T-GEN-M2");
    const first = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: a.admissionId, fromResourceId: w.wardId, toResourceId: w.roomId,
    });
    const again = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: a.admissionId, fromResourceId: w.wardId, toResourceId: w.roomId, oxygen: true,
    });
    expect(again.merged).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    // The second asker's oxygen is not lost in the merge.
    expect(again.request.oxygen).toBe(true);
    // Same place, same kind, another patient: its own task.
    const otherPatient = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.patientMove, admissionId: b.admissionId, fromResourceId: w.wardId, toResourceId: w.roomId,
    });
    expect(otherPatient.merged).toBe(false);
    expect(otherPatient.task.id).not.toBe(first.task.id);
    expect(await db.select().from(transportRequests)).toHaveLength(2);
  });

  it("(v) a sample run needs no patient and completes with a tap", async () => {
    const r = await requestTransport(db, w.requester, {
      kind: TRANSPORT_KINDS.sampleRun, fromResourceId: w.wardId, toNote: "Central lab, ground floor",
    });
    expect(r.task.patientId).toBeNull();
    expect(r.request.admissionId).toBeNull();
    expect(r.request.escortRequired).toBe(false);
    const porter = await accepted(r.task.id);
    await startTask(db, porter, { taskId: r.task.id });
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "tap" } })).resolves.toMatchObject({ state: "done" });
    // A patient move without a patient is refused with the fix.
    await expect(requestTransport(db, w.requester, { kind: TRANSPORT_KINDS.patientMove, toNote: "OT" }))
      .rejects.toMatchObject({ code: "admission_required" });
  });
});
