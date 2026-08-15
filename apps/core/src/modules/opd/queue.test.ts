import { and, asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdConfig, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { setSessionStatus } from "./sessions";
import { boardSnapshot, callNext, listQueue, markDone, markInConsult, skipCalled, summaryByDoctor } from "./queue";
import type { OpenVisitResult } from "./encounters";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17. NOW = 10:00 IST; every doctor's default template covers Mon–Sat 09:00–13:00. */
const MON = "2026-08-17";
const NOW = new Date("2026-08-17T04:30:00.000Z");
const T = (hhmmIst: string) => new Date(`2026-08-17T${hhmmIst}:00.000+05:30`);
const onDay = (day: string, hhmmIst: string) => new Date(`${day}T${hhmmIst}:00.000+05:30`);

describe("opd queue (list / call / skip / in-consult / board / desk summary)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
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
    patient = await mkPatient(db, clerk.actor);
  });

  const open = (doctor: Awaited<ReturnType<typeof mkDoctor>>, at: Date = NOW): Promise<OpenVisitResult> =>
    openVisit(db, clerk.actor, { patientId: patient.id, departmentId: doctor === drp ? dept2Id : deptId, doctorId: doctor.doctorId }, at);

  /**
   * TEST SHAPING (disclosed): a queue entry reaches 'waiting' in production through T6's vitals, which does not exist
   * yet — so these tests write the module's OWN table directly to produce the shape production will produce.
   */
  const shape = (
    entryId: string,
    patch: { eligibleAt?: Date; danger?: boolean; reEntry?: boolean; perk?: boolean; kind?: string; appointmentAt?: Date },
  ) => db.update(opdQueueEntries).set({ status: "waiting", ...patch }).where(eq(opdQueueEntries.id, entryId));

  const calledRows = (sessionId: string) =>
    db.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.sessionId, sessionId), eq(opdQueueEntries.status, "called")));
  const eventsNamed = (name: string) => db.select().from(events).where(eq(events.name, name)).orderBy(asc(events.seq));

  it("listQueue mirrors the engine: order, positions and classes, waiting_vitals apart, patient + encounter facts on every row", async () => {
    const d = await open(dra); await shape(d.queueEntry.id, { eligibleAt: T("09:10"), danger: true });
    const e = await open(dra); await shape(e.queueEntry.id, { eligibleAt: T("09:55"), reEntry: true });
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });
    const f = await open(dra); await shape(f.queueEntry.id, { eligibleAt: T("09:05") });
    const w = await open(dra); // never got vitals — stays waiting_vitals

    const view = (await listQueue(db, clerk.actor, dra.doctorId, MON, NOW))!;
    expect(view.ordered.map((r) => r.id)).toEqual([d, e, a, f].map((x) => x.queueEntry.id));
    expect(view.ordered.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(view.ordered.map((r) => r.queueClass)).toEqual([0, 1, 3, 3]);
    expect(view.ordered.map((r) => r.tokenNo)).toEqual([d.tokenNo, e.tokenNo, a.tokenNo, f.tokenNo]);
    expect(view.waitingVitals).toBe(1);
    expect(view.current).toBeNull();
    expect(view.inConsult).toEqual([]);
    expect(view.counts).toEqual({ waiting: 4, called: 0, inConsult: 0, done: 0, left: 0 });
    expect(view.session.id).toBe(d.sessionId);
    expect(view.doctor.id).toBe(dra.doctorId);
    expect(view.ordered[0]!.patient!.uhid).toBe(patient.uhid);
    expect(view.ordered[0]!.encounter.visitType).toBe("new");
    expect(view.ordered[0]!.encounter.id).toBe(d.encounter.id);
    expect(w.queueEntry.status).toBe("waiting_vitals");

    expect(await listQueue(db, clerk.actor, drb.doctorId, MON, NOW)).toBeNull(); // no session yet
  });

  it("callNext calls the head and opens the session, emitting exactly one queue.called; a second call conflicts; an empty queue returns null", async () => {
    const d = await open(dra); await shape(d.queueEntry.id, { eligibleAt: T("09:10"), danger: true });
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });

    const { entry } = await callNext(db, dra.actor, d.sessionId, NOW);
    expect(entry!.id).toBe(d.queueEntry.id);
    expect(entry!.status).toBe("called");
    expect(entry!.calledAt!.toISOString()).toBe(NOW.toISOString());
    expect(entry!.callCount).toBe(1);
    expect(entry!.tokenNo).toBe(d.tokenNo);

    const session = (await db.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, d.sessionId)))[0]!;
    expect(session.callsMade).toBe(1);
    expect(session.status).toBe("in");
    expect(session.openedAt!.toISOString()).toBe(NOW.toISOString());

    const called = await eventsNamed("queue.called");
    expect(called).toHaveLength(1);
    expect(called[0]!.payload).toEqual({
      encounterId: d.encounter.id, patientId: patient.id, entryId: d.queueEntry.id, doctorId: dra.doctorId,
      serviceDate: MON, sessionId: d.sessionId, roomId, tokenNo: d.tokenNo, callCount: 1,
    });
    expect(called[0]!.encounterId).toBe(d.encounter.id);
    expect(called[0]!.correlationId).toBe(d.encounter.workflowInstanceId);

    await expect(callNext(db, dra.actor, d.sessionId, NOW)).rejects.toMatchObject({ code: "call_conflict" });
    expect(await calledRows(d.sessionId)).toHaveLength(1);
    expect(a.queueEntry.tokenNo).toBe(2);

    const other = await open(drb); // its only entry is still waiting_vitals — nothing to call
    expect(await callNext(db, drb.actor, other.sessionId, NOW)).toEqual({ entry: null, encounter: null });
  });

  it("a skip re-queues behind the other walk-ins and keeps the token; the third skip leaves the queue; skipping a waiting entry conflicts", async () => {
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });
    const f = await open(dra); await shape(f.queueEntry.id, { eligibleAt: T("09:05") });

    await callNext(db, dra.actor, a.sessionId, NOW); // → A (09:00 is the earliest)
    const at1 = new Date(NOW.getTime() + 60_000);
    const r1 = await skipCalled(db, dra.actor, a.queueEntry.id, at1);
    expect(r1.entry.status).toBe("waiting");
    expect(r1.entry.skips).toBe(1);
    expect(r1.entry.eligibleAt!.toISOString()).toBe(at1.toISOString());
    expect(r1.entry.tokenNo).toBe(a.tokenNo); // the place is lost, the token is not
    const skipped = await eventsNamed("queue.skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload).toMatchObject({ entryId: a.queueEntry.id, tokenNo: a.tokenNo, skips: 1, left: false });

    const behind = (await listQueue(db, clerk.actor, dra.doctorId, MON, at1))!;
    expect(behind.ordered.map((r) => r.id)).toEqual([f.queueEntry.id, a.queueEntry.id]);

    await expect(skipCalled(db, dra.actor, f.queueEntry.id, at1)).rejects.toMatchObject({ code: "queue_entry_state_conflict" });

    await callNext(db, dra.actor, a.sessionId, at1); // → F
    await withTx(db, (tx) => markDone(tx, f.encounter.id, at1)); // F out of the way
    const at2 = new Date(NOW.getTime() + 120_000);
    await callNext(db, dra.actor, a.sessionId, at2); // → A again
    expect((await skipCalled(db, dra.actor, a.queueEntry.id, at2)).entry).toMatchObject({ status: "waiting", skips: 2 });
    const at3 = new Date(NOW.getTime() + 180_000);
    await callNext(db, dra.actor, a.sessionId, at3); // → A again
    const r3 = await skipCalled(db, dra.actor, a.queueEntry.id, at3);
    expect(r3.entry.status).toBe("left"); // config maxSkipsBeforeLeft = 3
    expect(r3.entry.skips).toBe(3);

    const all = await eventsNamed("queue.skipped");
    expect(all).toHaveLength(3);
    expect(all[2]!.payload).toMatchObject({ skips: 3, left: true });
    const after = (await listQueue(db, clerk.actor, dra.doctorId, MON, at3))!;
    expect(after.ordered).toEqual([]);
    expect(after.counts).toMatchObject({ waiting: 0, called: 0, done: 1, left: 1 });
  });

  it("markInConsult takes a called OR a waiting entry, refuses a done one; markDone stamps doneAt and is null when nothing is live", async () => {
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });
    const b = await open(dra); await shape(b.queueEntry.id, { eligibleAt: T("09:05") });
    await callNext(db, dra.actor, a.sessionId, NOW); // A called

    expect((await withTx(db, (tx) => markInConsult(tx, a.encounter.id, NOW))).status).toBe("in_consult");
    expect((await withTx(db, (tx) => markInConsult(tx, b.encounter.id, NOW))).status).toBe("in_consult"); // waiting → in_consult

    const doneA = await withTx(db, (tx) => markDone(tx, a.encounter.id, NOW));
    expect(doneA!.status).toBe("done");
    expect(doneA!.doneAt!.toISOString()).toBe(NOW.toISOString());
    await expect(withTx(db, (tx) => markInConsult(tx, a.encounter.id, NOW))).rejects.toMatchObject({ code: "queue_entry_state_conflict" });
    expect((await withTx(db, (tx) => markDone(tx, b.encounter.id, NOW)))!.status).toBe("done");
    expect(await withTx(db, (tx) => markDone(tx, a.encounter.id, NOW))).toBeNull();
  });

  it("the call race at one instant: one winner, one call_conflict, one called row and one event — five iterations, no early bail", async () => {
    let priorCalls = 0;
    for (let k = 0; k < 5; k++) {
      const day = `2026-08-${17 + k}`; // a fresh doctor-day session per iteration
      const at = new Date(`${day}T04:30:00.000Z`);
      const x = await open(dra, at); await shape(x.queueEntry.id, { eligibleAt: onDay(day, "09:00") });
      const y = await open(dra, at); await shape(y.queueEntry.id, { eligibleAt: onDay(day, "09:10") });

      const results = await Promise.allSettled([
        callNext(db, dra.actor, x.sessionId, at),
        callNext(db, dra.actor, x.sessionId, at),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "call_conflict" });
      expect(await calledRows(x.sessionId)).toHaveLength(1);
      expect(y.sessionId).toBe(x.sessionId);

      const called = await eventsNamed("queue.called");
      expect(called.length).toBe(priorCalls + 1);
      priorCalls = called.length;
    }
  });

  it("the serializer: two callers whose clocks straddle an appointment's due time would pick DIFFERENT heads — still exactly ONE call", async () => {
    const w = await open(dra); await shape(w.queueEntry.id, { eligibleAt: T("09:00") });
    const x = await open(dra);
    await shape(x.queueEntry.id, { eligibleAt: T("09:30"), kind: "appointment", appointmentAt: new Date("2026-08-17T04:50:00.000Z") }); // due at 10:20 IST

    const early = new Date("2026-08-17T04:49:00.000Z");
    const late = new Date("2026-08-17T04:51:00.000Z");
    // The premise, proven rather than asserted: the two clocks see different heads.
    expect((await listQueue(db, clerk.actor, dra.doctorId, MON, early))!.ordered[0]!.id).toBe(w.queueEntry.id);
    expect((await listQueue(db, clerk.actor, dra.doctorId, MON, late))!.ordered[0]!.id).toBe(x.queueEntry.id);

    const results = await Promise.allSettled([
      callNext(db, dra.actor, w.sessionId, early),
      callNext(db, dra.actor, w.sessionId, late),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "call_conflict" });
    expect(await calledRows(w.sessionId)).toHaveLength(1);
    expect(await eventsNamed("queue.called")).toHaveLength(1);
  });

  it("the doctor's session status gates the call: out → doctor_out, back in → works, closed → session_closed", async () => {
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });

    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, a.sessionId, "out", NOW));
    await expect(callNext(db, dra.actor, a.sessionId, NOW)).rejects.toMatchObject({ code: "doctor_out" });

    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, a.sessionId, "in", NOW));
    expect((await callNext(db, dra.actor, a.sessionId, NOW)).entry!.id).toBe(a.queueEntry.id);

    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, a.sessionId, "closed", NOW));
    await expect(callNext(db, dra.actor, a.sessionId, NOW)).rejects.toMatchObject({ code: "session_closed" });
    await expect(callNext(db, dra.actor, "01NOSUCHSESSION000000000A", NOW)).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("the E-32 perk turn promotes one perk walk-in on the Nth call; with the hook off the same setup is plain FIFO", async () => {
    await db.update(opdConfig).set({ perkEveryNth: 2 }).where(eq(opdConfig.id, "main")); // config data — Plan 09 sets it for real
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });
    const b = await open(dra); await shape(b.queueEntry.id, { eligibleAt: T("09:10") });
    const f = await open(dra); await shape(f.queueEntry.id, { eligibleAt: T("09:20"), perk: true });

    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { entry, encounter } = await callNext(db, dra.actor, a.sessionId, NOW);
      order.push(entry!.tokenNo);
      await withTx(db, (tx) => markDone(tx, encounter!.id, NOW));
    }
    expect(order).toEqual([a.tokenNo, f.tokenNo, b.tokenNo]); // calls 0,1,2 → the perk turn is the second call

    await db.update(opdConfig).set({ perkEveryNth: null }).where(eq(opdConfig.id, "main"));
    const TUE = new Date("2026-08-18T04:30:00.000Z"); // a fresh doctor-day session
    const a2 = await open(dra, TUE); await shape(a2.queueEntry.id, { eligibleAt: onDay("2026-08-18", "09:00") });
    const b2 = await open(dra, TUE); await shape(b2.queueEntry.id, { eligibleAt: onDay("2026-08-18", "09:10") });
    const f2 = await open(dra, TUE); await shape(f2.queueEntry.id, { eligibleAt: onDay("2026-08-18", "09:20"), perk: true });

    const plain: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { entry, encounter } = await callNext(db, dra.actor, a2.sessionId, TUE);
      plain.push(entry!.tokenNo);
      await withTx(db, (tx) => markDone(tx, encounter!.id, TUE));
    }
    expect(plain).toEqual([a2.tokenNo, b2.tokenNo, f2.tokenNo]);
  });

  it("boardSnapshot is a public surface — exactly the documented keys, token/room/doctor only; summaryByDoctor lists the department's desks", async () => {
    const a = await open(dra); await shape(a.queueEntry.id, { eligibleAt: T("09:00") });
    const b = await open(dra); await shape(b.queueEntry.id, { eligibleAt: T("09:10") });
    const c = await open(dra); await shape(c.queueEntry.id, { eligibleAt: T("09:20") });
    await callNext(db, dra.actor, a.sessionId, NOW); // A is being served
    const z = await open(drb);
    await withTx(db, (tx) => markDone(tx, z.encounter.id, NOW)); // drb has a session, nothing live

    const board = await boardSnapshot(db, MON, undefined, NOW);
    expect(board).toHaveLength(2);
    expect(Object.keys(board[0]!).sort()).toEqual(
      ["departmentName", "doctorId", "doctorName", "next", "nowServing", "roomCode", "roomId", "sessionId", "status", "waitingCount"],
    );
    expect(board[0]).toEqual({
      sessionId: a.sessionId, roomId, roomCode: "12", doctorId: dra.doctorId, doctorName: "Dr dra",
      departmentName: "General Medicine", status: "in", nowServing: a.tokenNo, next: [b.tokenNo, c.tokenNo], waitingCount: 2,
    });
    expect(board[1]).toEqual({
      sessionId: z.sessionId, roomId: room2Id, roomCode: "14", doctorId: drb.doctorId, doctorName: "Dr drb",
      departmentName: "General Medicine", status: "not_started", nowServing: null, next: [], waitingCount: 0,
    });
    expect(await boardSnapshot(db, MON, [room2Id], NOW)).toHaveLength(1);

    const summary = await summaryByDoctor(db, deptId, MON, NOW);
    expect(summary.map((s) => s.doctor.id)).toEqual([dra.doctorId, drb.doctorId]);
    expect(summary[0]).toMatchObject({
      sessionId: a.sessionId, status: "in", waitingCount: 2, waitingVitalsCount: 0, nowServing: a.tokenNo, scheduledToday: true, roomCode: "12",
    });
    expect(summary[1]).toMatchObject({ sessionId: z.sessionId, status: "not_started", waitingCount: 0, nowServing: null, scheduledToday: true, roomCode: "14" });
    expect((await summaryByDoctor(db, undefined, MON, NOW)).map((s) => s.doctor.id).sort()).toEqual([dra.doctorId, drb.doctorId, drp.doctorId].sort());
    expect((await summaryByDoctor(db, dept2Id, MON, NOW))[0]).toMatchObject({ sessionId: null, status: "none", waitingCount: 0, scheduledToday: true });
  });
});
