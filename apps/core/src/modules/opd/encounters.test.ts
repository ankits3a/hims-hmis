import { and, asc, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdQueueEntries, opdQueueSessions, patients, workflowInstances } from "../../kernel/db/schema";
import {
  abandonVisit, getEncounter, moveEncounter, openVisit, patientTimeline, reEnterVisit, transferQueue, reclassifyVisit,
} from "./encounters";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST. Every doctor's default template covers Mon–Sat 09:00–13:00. */
const MON = new Date("2026-08-17T04:00:00.000Z");
const SUN = new Date("2026-08-16T04:00:00.000Z");
const T0 = new Date("2026-08-08T10:00:00.000Z"); // Saturday 2026-08-08, the anchor consult day

describe("opd encounters (the spine: open / abandon / re-enter / transfer / timeline)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let sup: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let roomId: string;
  let room2Id: string;
  let patient: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, dept2Id, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    sup = await mkUser(db, "sup", ["front_office_supervisor"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  /** Drives one encounter registered → waiting → in_consultation → completed, stamping the follow-up window. */
  async function completeEncounter(
    doc: Awaited<ReturnType<typeof mkDoctor>>, departmentId: string, patientId: string, completedAt: Date, followUpDays: number,
  ): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId, doctorId: doc.doctorId }, completedAt);
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd.actor, opened.encounter, "waiting", {}, completedAt));
    enc = await withTx(db, (tx) => moveEncounter(tx, doc.actor, enc, "in_consultation", {}, completedAt));
    return withTx(db, (tx) => moveEncounter(tx, doc.actor, enc, "completed", { consultCompletedAt: completedAt, followUpDays }, completedAt));
  }

  it("opens a walk-in visit: encounter, workflow instance, queue entry and exactly two events with the §10.5 envelope", async () => {
    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    expect(r.visitType).toBe("new");
    expect(r.tokenNo).toBe(1);
    expect(r.roomId).toBe(roomId);
    expect(r.doctorScheduledToday).toBe(true);

    const enc = r.encounter;
    expect(enc.status).toBe("registered");
    expect(enc.serviceDate).toBe("2026-08-17");
    expect(enc.intendedPayer).toBe("self");
    expect(enc.openedBy).toBe(clerk.id);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, enc.workflowInstanceId)))[0]!;
    expect(inst.defKey).toBe("opd_visit");
    expect(inst.currentState).toBe("registered");
    expect(inst.subjectType).toBe("opd_encounter");
    expect(inst.subjectId).toBe(enc.id);
    expect(inst.encounterId).toBe(enc.id);
    expect(inst.patientId).toBe(patient.id);

    expect(r.queueEntry.status).toBe("waiting_vitals");
    expect(r.queueEntry.kind).toBe("walk_in");
    expect(r.queueEntry.tokenNo).toBe(1);
    expect(r.queueEntry.appointmentAt).toBeNull();
    expect(r.queueEntry.eligibleAt).toBeNull();

    const opened = await db.select().from(events).where(eq(events.name, "visit.opened"));
    expect(opened).toHaveLength(1);
    expect(opened[0]!.encounterId).toBe(enc.id);
    expect(opened[0]!.patientId).toBe(patient.id);
    expect(opened[0]!.correlationId).toBe(enc.workflowInstanceId);
    expect(opened[0]!.payload).toEqual({
      encounterId: enc.id, patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId,
      serviceDate: "2026-08-17", sessionId: r.sessionId, roomId, tokenNo: 1,
      visitType: "new", intendedPayer: "self", kind: "walk_in", appointmentId: null,
    });

    const checkedIn = await db.select().from(events).where(eq(events.name, "patient.checked_in"));
    expect(checkedIn).toHaveLength(1);
    expect(checkedIn[0]!.encounterId).toBe(enc.id);
    expect(checkedIn[0]!.patientId).toBe(patient.id);
    expect(checkedIn[0]!.correlationId).toBe(enc.workflowInstanceId);
    expect(checkedIn[0]!.payload).toEqual({
      encounterId: enc.id, patientId: patient.id, doctorId: dra.doctorId, serviceDate: "2026-08-17",
      sessionId: r.sessionId, roomId, tokenNo: 1, kind: "arrival",
    });
  });

  it("tokens climb inside one doctor-day; another doctor and an unscheduled day start their own session", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const second = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, new Date(MON.getTime() + 5 * 60_000));
    expect(second.tokenNo).toBe(2);
    expect(second.sessionId).toBe(first.sessionId);

    const sunday = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, SUN);
    expect(sunday.roomId).toBeNull();
    expect(sunday.doctorScheduledToday).toBe(false);
    expect(sunday.tokenNo).toBe(1);
    expect(sunday.sessionId).not.toBe(first.sessionId);

    const other = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: drb.doctorId }, MON);
    expect(other.tokenNo).toBe(1);
  });

  it("visit type anchors on the newest completed consult in the SAME department, across the merge chain", async () => {
    await completeEncounter(dra, deptId, patient.id, T0, 7);
    const aug15 = new Date("2026-08-15T05:00:00.000Z");
    expect((await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: drb.doctorId }, aug15)).visitType).toBe("revisit");
    expect((await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: dept2Id, doctorId: drp.doctorId }, aug15)).visitType).toBe("new");
    expect((await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, new Date("2026-08-15T18:30:00.000Z"))).visitType).toBe("renewal");

    // A later consult on the same IST day, with an extended 30-day window, becomes the anchor.
    await completeEncounter(dra, deptId, patient.id, new Date("2026-08-08T11:00:00.000Z"), 30);
    expect((await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, new Date("2026-09-07T05:00:00.000Z"))).visitType).toBe("revisit");

    // Merged-loser history counts: the winner has NO completed consult in the second department, the loser does.
    const loser = await mkPatient(db, clerk.actor, { phone: "9876500099" });
    await completeEncounter(drp, dept2Id, loser.id, T0, 7);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: patient.id }).where(eq(patients.id, loser.id));
    expect((await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: dept2Id, doctorId: drp.doctorId }, aug15)).visitType).toBe("revisit");
  });

  it("six concurrent opens on one doctor-day allocate tokens 1..6 from a single session", async () => {
    const six: { id: string; uhid: string }[] = [];
    for (let i = 0; i < 6; i++) six.push(await mkPatient(db, clerk.actor, { phone: `98765100${i}0` }));
    const results = await Promise.all(
      six.map((p) => openVisit(db, clerk.actor, { patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, MON)),
    );
    expect(results.map((r) => r.tokenNo).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const sessions = await db.select().from(opdQueueSessions)
      .where(and(eq(opdQueueSessions.doctorId, dra.doctorId), eq(opdQueueSessions.serviceDate, "2026-08-17")));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nextToken).toBe(7);
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.sessionId, sessions[0]!.id));
    expect(entries).toHaveLength(6);
  });

  it("abandon cancels the queue entry, completes the instance and events once; a blank reason and a repeat refuse", async () => {
    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const { encounter } = await abandonVisit(db, clerk.actor, r.encounter.id, "left after billing", MON);
    expect(encounter.status).toBe("abandoned");
    expect(encounter.abandonReason).toBe("left after billing");
    expect(encounter.abandonedAt).toEqual(MON);

    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, r.queueEntry.id)))[0]!;
    expect(entry.status).toBe("cancelled");
    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, encounter.workflowInstanceId)))[0]!;
    expect(inst.status).toBe("completed");
    expect(inst.currentState).toBe("abandoned");

    const evs = await db.select().from(events).where(eq(events.name, "visit.abandoned"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ encounterId: r.encounter.id, fromState: "registered", reason: "left after billing", tokenNo: 1 });

    await expect(abandonVisit(db, clerk.actor, r.encounter.id, "  ")).rejects.toMatchObject({ code: "reason_required" });
    await expect(abandonVisit(db, clerk.actor, r.encounter.id, "again")).rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("the abandon race has exactly one winner, exactly one event and ONE mapped loser code, on five iterations", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await mkPatient(db, clerk.actor, { phone: `98765020${i}0` });
      const r = await openVisit(db, clerk.actor, { patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      const settled = await Promise.allSettled([
        abandonVisit(db, clerk.actor, r.encounter.id, "left after billing", MON),
        abandonVisit(db, sup.actor, r.encounter.id, "left after billing", MON),
      ]);
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "encounter_state_conflict" });
      const evs = await db.select().from(events)
        .where(and(eq(events.name, "visit.abandoned"), eq(events.encounterId, r.encounter.id)));
      expect(evs).toHaveLength(1);
      expect((await getEncounter(db, r.encounter.id))!.status).toBe("abandoned");
    }
  });

  it("role_denied propagates untouched from the engine: the mirror never runs", async () => {
    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await expect(withTx(db, (tx) => moveEncounter(tx, clerk.actor, r.encounter, "waiting", {}, MON)))
      .rejects.toMatchObject({ name: "WorkflowError", code: "role_denied" });
    expect((await getEncounter(db, r.encounter.id))!.status).toBe("registered");
  });

  it("a visit is numbered V<YYMMDD><0001>, counting up per IST day", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    expect(first.encounter.visitNo).toBe("V2608170001");
    const other = await mkPatient(db, clerk.actor, { name: "Second Patient", phone: "9811100011" });
    const second = await openVisit(db, clerk.actor, { patientId: other.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    expect(second.encounter.visitNo).toBe("V2608170002");
  });

  it("A SAME-DAY RE-ENTRY KEEPS THE VISIT NUMBER — the rule the whole grammar rests on", async () => {
    // A patient sent back through the queue after results is still on the SAME visit. Minting a
    // second V number here would attach those results to a visit that never ordered them, and
    // would put two numbers on one episode of care. The token is reused; so is this.
    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r.encounter, "waiting", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "in_consultation", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "awaiting_results", {}, MON));
    const re = await reEnterVisit(db, clerk.actor, enc.id, new Date(MON.getTime() + 3 * 3_600_000));
    expect(re.encounter.visitNo).toBe(r.encounter.visitNo);
    expect(re.queueEntry.reEntry).toBe(true); // it really is the re-entry path, not a fresh visit
  });

  it("a same-day re-entry keeps the token, retires the old entry and checks in again as re_entry", async () => {
    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r.encounter, "waiting", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "in_consultation", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "awaiting_results", {}, MON));

    // Another IST day is refused while the encounter is still legitimately awaiting results.
    await expect(reEnterVisit(db, clerk.actor, enc.id, new Date("2026-08-18T04:00:00.000Z")))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });

    const MON2 = new Date(MON.getTime() + 3 * 3_600_000);
    const re = await reEnterVisit(db, clerk.actor, enc.id, MON2);
    expect(re.encounter.status).toBe("waiting");
    expect(re.queueEntry.status).toBe("waiting");
    expect(re.queueEntry.reEntry).toBe(true);
    expect(re.queueEntry.tokenNo).toBe(1);
    expect(re.queueEntry.kind).toBe("walk_in");
    expect(re.queueEntry.eligibleAt).toEqual(MON2);
    expect(re.queueEntry.seq).toBeGreaterThan(r.queueEntry.seq);
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, r.queueEntry.id)))[0]!.status).toBe("done");

    const checkins = await db.select().from(events).where(eq(events.name, "patient.checked_in"));
    expect(checkins).toHaveLength(2);
    expect(checkins.filter((e) => (e.payload as { kind: string }).kind === "re_entry")).toHaveLength(1);

    await expect(reEnterVisit(db, clerk.actor, enc.id, MON2)).rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("the E2 transfer moves the live queue to another doctor of the same department, preserving order and eligibility", async () => {
    const p2 = await mkPatient(db, clerk.actor, { phone: "9876530001" });
    const r1 = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r2 = await openVisit(db, clerk.actor, { patientId: p2.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const e1 = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r1.encounter, "waiting", {}, MON));
    const e2 = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r2.encounter, "waiting", {}, MON));
    // eligible_at is written by reEnterVisit and (T6) recordVitals; this test writes the module's own table directly.
    const el1 = new Date(MON.getTime() + 60_000);
    const el2 = new Date(MON.getTime() + 120_000);
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: el1 }).where(eq(opdQueueEntries.id, r1.queueEntry.id));
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: el2 }).where(eq(opdQueueEntries.id, r2.queueEntry.id));

    const MON3 = new Date(MON.getTime() + 4 * 3_600_000);
    const out = await transferQueue(db, sup.actor, {
      fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, serviceDate: "2026-08-17", consented: true, reason: "Dr A called away",
    }, MON3);
    expect(out.transferred).toBe(2);

    const moved = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.sessionId, out.toSessionId)).orderBy(asc(opdQueueEntries.seq));
    expect(moved.map((m) => m.tokenNo)).toEqual([1, 2]);
    expect(moved.map((m) => m.eligibleAt)).toEqual([el1, el2]);
    expect(moved.every((m) => m.status === "waiting")).toBe(true);
    const olds = await db.select().from(opdQueueEntries).where(inArray(opdQueueEntries.id, [r1.queueEntry.id, r2.queueEntry.id]));
    expect(olds.map((o) => o.status)).toEqual(["transferred", "transferred"]);
    expect((await getEncounter(db, e1.id))!.doctorId).toBe(drb.doctorId);
    expect((await getEncounter(db, e2.id))!.doctorId).toBe(drb.doctorId);

    const evs = await db.select().from(events).where(eq(events.name, "visit.transferred"));
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => (e.payload as { consented: boolean }).consented)).toEqual([true, true]);
    expect(evs.map((e) => (e.payload as { toDoctorId: string }).toDoctorId)).toEqual([drb.doctorId, drb.doctorId]);

    const base = { fromDoctorId: dra.doctorId, serviceDate: "2026-08-17", reason: "Dr A called away" };
    await expect(transferQueue(db, sup.actor, { ...base, toDoctorId: drb.doctorId, consented: false }, MON3))
      .rejects.toMatchObject({ code: "invalid_transfer" });
    await expect(transferQueue(db, sup.actor, { ...base, toDoctorId: drp.doctorId, consented: true }, MON3))
      .rejects.toMatchObject({ code: "invalid_transfer" });
    expect((await transferQueue(db, sup.actor, { ...base, toDoctorId: drb.doctorId, consented: true }, MON3)).transferred).toBe(0);
  });

  it("the patient timeline spans the merge chain, newest first, carrying doctor and department names", async () => {
    const loser = await mkPatient(db, clerk.actor, { phone: "9876540001" });
    const older = await openVisit(db, clerk.actor, { patientId: loser.id, departmentId: deptId, doctorId: dra.doctorId }, new Date("2026-08-10T04:00:00.000Z"));
    const newer = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: patient.id }).where(eq(patients.id, loser.id));

    const items = await patientTimeline(db, clerk.actor, patient.id);
    expect(items.map((i) => i.encounterId)).toEqual([newer.encounter.id, older.encounter.id]);
    expect(items[0]).toMatchObject({
      doctorName: "Dr dra", departmentName: "General Medicine", status: "registered", visitType: "new", serviceDate: "2026-08-17",
    });
    expect(items[1]!.serviceDate).toBe("2026-08-10");
    const viaLoser = await patientTimeline(db, clerk.actor, loser.id);
    expect(viaLoser.map((i) => i.encounterId)).toEqual(items.map((i) => i.encounterId));
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * FD-18 — THE BILLING OVERRIDE, BUILT AS A CORRECTION TO THE PREMISE
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner, 2026-09-04: *"there should be a manual override button or something in case of AI agent
   * failure or system failure in case billing the patient in revisit."* — then, choosing between
   * three designs: *"re-classify the visit, not the price"*, and *"cashier alone, fully audited"*.
   *
   * The failure is real and reachable: `classifyVisit` needs the previous consult to be COMPLETED
   * with a timestamp, so a doctor who never closed one leaves no anchor and a patient plainly on a
   * revisit opens as `new` and is charged. The first test below MANUFACTURES exactly that.
   */
  describe("FD-18: correcting a misread visit type", () => {
    it("the failure mode is real: an unclosed consult makes a genuine revisit open as new", async () => {
      // seen four days ago, but the consult was never completed — so there is no anchor
      const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
      await withTx(db, (tx) => moveEncounter(tx, vd.actor, opened.encounter, "waiting", {}, T0));

      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      expect(today.visitType).toBe("new"); // …and `feeServiceFor` will therefore charge them
    });

    it("corrects the type, and the correction is what makes the fee free — not a discount", async () => {
      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      expect(today.encounter.visitType).toBe("new");

      const { encounter } = await reclassifyVisit(
        db, clerk.actor, today.encounter.id,
        { visitType: "revisit", reason: "seen here on 8 Aug; the consult was never closed" }, MON,
      );
      expect(encounter.visitType).toBe("revisit");
      /*
        THE FEE CONSEQUENCE IS ASSERTED IN BILLING, NOT HERE, and the module boundary is why: a
        module may only import another's `index.ts`, and `feeServiceFor` is billing's internal.
        Reaching into it — or widening billing's public interface to make a test convenient — would
        be a worse trade than stating the seam plainly. What OPD owns and proves is that the TYPE is
        corrected; that `revisit` maps to the free branch is `charge-rules.ts`'s own invariant and
        its own tests', and this correction reaches it through the ordinary quote path.
      */
    });

    /* The audit IS the control, because the owner ruled the cashier acts alone. */
    it("records who corrected it, from what, to what and why", async () => {
      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      await reclassifyVisit(db, clerk.actor, today.encounter.id, { visitType: "revisit", reason: "consult never closed" }, MON);

      const logged = await db.select().from(events).where(eq(events.name, "visit.reclassified"));
      expect(logged).toHaveLength(1);
      const payload = logged[0]!.payload as Record<string, unknown>;
      expect(payload["from"]).toBe("new");
      expect(payload["to"]).toBe("revisit");
      expect(payload["reason"]).toBe("consult never closed");
      expect(logged[0]!.actorId).toBe(clerk.actor.id);
    });

    it("a correction with no reason is refused — an unreviewable correction is not a control", async () => {
      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      await expect(reclassifyVisit(db, clerk.actor, today.encounter.id, { visitType: "revisit", reason: "   " }, MON))
        .rejects.toMatchObject({ code: "reason_required" });
      expect(await db.select().from(events).where(eq(events.name, "visit.reclassified"))).toHaveLength(0);
    });

    it("re-asserting the type it already has writes nothing at all", async () => {
      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      const { encounter } = await reclassifyVisit(db, clerk.actor, today.encounter.id, { visitType: "new", reason: "no change" }, MON);
      expect(encounter.visitType).toBe("new");
      expect(await db.select().from(events).where(eq(events.name, "visit.reclassified"))).toHaveLength(0);
    });

    it("an abandoned visit is not re-classified", async () => {
      const today = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      await abandonVisit(db, clerk.actor, today.encounter.id, "left the queue", MON);
      await expect(reclassifyVisit(db, clerk.actor, today.encounter.id, { visitType: "revisit", reason: "x" }, MON))
        .rejects.toMatchObject({ code: "encounter_state_conflict" });
    });

    it("an unknown encounter is refused", async () => {
      await expect(reclassifyVisit(db, clerk.actor, "no-such-encounter", { visitType: "revisit", reason: "x" }, MON))
        .rejects.toMatchObject({ code: "unknown_encounter" });
    });
  });
});
