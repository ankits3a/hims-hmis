import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { callNext } from "./queue";
import { getOrCreateSession, roomForDoctorDay, setSessionStatus } from "./sessions";
import { opdTopicsFor } from "./realtime";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07c T6 — WHO OPENED THE DOCTOR-DAY, AND WHEN.
 *
 * Measured at kickoff: `opd_queue_sessions` had `opened_at`/`closed_at` and NO actor column, and
 * `setSessionStatus` — its only writer — appended no event at all. The gap is not merely an audit
 * one. Every other alarm in the hall is raised by somebody waiting, and **nobody waits on a queue
 * that does not exist yet**, so a doctor-day that was never opened produced silence. The signal a
 * supervisor's desk most needs had nothing to be computed from.
 */
const MON = "2026-08-17";
const T = (hhmmIst: string) => new Date(`${MON}T${hhmmIst}:00.000+05:30`);

describe("opd queue sessions — attribution (07c T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let nurse: Awaited<ReturnType<typeof mkUser>>;
  let sessionId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    nurse = await mkUser(db, "nurse1", ["front_office_t"]);
    const room = await withTx(db, (tx) => roomForDoctorDay(tx, dra.doctorId, MON));
    const s = await withTx(db, (tx) => getOrCreateSession(tx, dra.doctorId, MON, room));
    sessionId = s.id;
  });

  const row = async () => (await db.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId)))[0]!;
  const named = async (name: string) => db.select().from(events).where(eq(events.name, name));

  it("A1: opening the doctor-day records WHO opened it and when", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));

    const s = await row();
    expect(s.openedBy).toBe(nurse.id);
    expect(s.openedAt?.toISOString()).toBe(T("09:40").toISOString());
    expect(s.closedBy).toBeNull();
  });

  it("A1: closing records a DIFFERENT actor without disturbing who opened it", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "closed", T("13:10")));

    const s = await row();
    expect({ openedBy: s.openedBy, closedBy: s.closedBy }).toEqual({ openedBy: nurse.id, closedBy: dra.userId });
    expect(s.closedAt?.toISOString()).toBe(T("13:10").toISOString());
  });

  /**
   * The stamp is a fact about the MORNING, not about the last time somebody came back from lunch.
   * `in → out → in` is an ordinary day and it must not rewrite the answer — the same reasoning the
   * `openedAt` column already applied to the timestamp, now applied to the person.
   */
  it("A1: an in → out → in day keeps its original opener, and emits ONE opened event", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "out", T("11:00")));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("11:30")));

    const s = await row();
    expect(s.openedBy).toBe(nurse.id);
    expect(s.openedAt?.toISOString()).toBe(T("09:40").toISOString());
    expect(await named("queue_session.opened")).toHaveLength(1);
  });

  /**
   * A2 — the two events, and the lateness figure they exist to make computable. `scheduledStart` is
   * the template's own start time, so "opened at 09:40 against an 09:00 template" is one row rather
   * than a join a consumer has to remember to write.
   */
  it("A2: opening appends `queue_session.opened` carrying the schedule it can be judged against", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));

    const [e] = await named("queue_session.opened");
    expect(e).toBeDefined();
    expect(e!.actorId).toBe(nurse.id);
    expect(e!.payload).toMatchObject({
      sessionId, doctorId: dra.doctorId, serviceDate: MON, scheduledStart: "09:00",
    });
  });

  it("A2: closing appends `queue_session.closed` with the count the day actually finished", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "closed", T("13:10")));

    const [e] = await named("queue_session.closed");
    expect(e!.actorId).toBe(dra.userId);
    expect(e!.payload).toMatchObject({ sessionId, doctorId: dra.doctorId, serviceDate: MON, seen: 0 });
  });

  /**
   * A2 — AND THEY REACH SOMEBODY. An event nobody routes is a row in a table: both names are in the
   * realtime catalogue and both carry the fields `opdTopicsFor` needs to put them on the hall's own
   * topic, which is what makes the desk's "session not started" row disappear the moment it starts.
   *
   * IT ALSO REACHES THE CORRIDOR BOARD, and that was NOT predicted — the first version of this
   * assertion said `toEqual([queue:…])` and failed with a second topic, `display:<roomId>`. The
   * cause is that `opdTopicsFor` routes on the PAYLOAD's shape rather than on the event's name, and
   * carrying `roomId` (which the desk card needs) puts the fact on the room's display topic as
   * well. Keeping it is the right answer rather than a shrug: a board announcing "Dr Rao — session
   * not started" should stop announcing it the moment the session starts, and it now does without
   * anybody adding a route. The assertion is widened to name BOTH, so a future change that drops
   * either one is a failure rather than a silent narrowing.
   */
  it("A2: both events route to the doctor-day's queue topic AND the room's display", async () => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));
    const [opened] = await named("queue_session.opened");
    const s = await row();

    expect(opdTopicsFor({ name: opened!.name, payload: opened!.payload }).sort()).toEqual(
      [`display:${s.roomId!}`, `queue:${dra.doctorId}:${MON}`].sort(),
    );
  });

  it("a session that never opened has no opener — null means NOT RECORDED, and that is true", async () => {
    const s = await row();
    expect({ status: s.status, openedBy: s.openedBy, closedBy: s.closedBy })
      .toEqual({ status: "not_started", openedBy: null, closedBy: null });
    expect(await named("queue_session.opened")).toHaveLength(0);
  });

  it("an unscheduled doctor-day opens with a NULL scheduled start — an unscheduled doctor cannot be late", async () => {
    // A Sunday: the default templates cover Mon–Sat, so this doctor-day has no schedule at all.
    const sun = "2026-08-16";
    const s = await withTx(db, (tx) => getOrCreateSession(tx, dra.doctorId, sun, null));
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, s.id, "in", new Date(`${sun}T04:10:00.000Z`)));

    const [e] = await named("queue_session.opened");
    expect(e!.payload).toMatchObject({ serviceDate: sun, scheduledStart: null });
  });
});

/**
 * ═══ THE DAY CLOSED BY MISTAKE (owner report, 2026-09-13) ═══
 *
 * `closed` was a TERMINAL state: the first line of `setSessionStatus` refused every move out of it,
 * so one wrong pick on a dropdown the doctor uses all day ended the clinic. `callNext` refuses a
 * closed session, so every patient still holding a token became uncallable, and no act in the
 * system could put the doctor-day back.
 *
 * The reopen is deliberately NARROW: to `in` only (a reopened day whose doctor is "out" says
 * nothing anyone can act on), and only on the session's OWN service date — yesterday's clinic is
 * history, its `seen` count has been read, and reopening it would put a stale doctor-day back on
 * today's corridor board.
 */
describe("opd queue sessions — reopening a day closed by mistake", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let nurse: Awaited<ReturnType<typeof mkUser>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let sessionId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    nurse = await mkUser(db, "nurse1", ["front_office_t"]);
    clerk = await mkUser(db, "clerk", ["front_office"]);
    const room = await withTx(db, (tx) => roomForDoctorDay(tx, dra.doctorId, MON));
    const s = await withTx(db, (tx) => getOrCreateSession(tx, dra.doctorId, MON, room));
    sessionId = s.id;
  });

  const row = async () => (await db.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId)))[0]!;
  const named = async (name: string) => db.select().from(events).where(eq(events.name, name));

  const closeIt = async (): Promise<void> => {
    await withTx(db, (tx) => setSessionStatus(tx, nurse.actor, sessionId, "in", T("09:40")));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "closed", T("13:10")));
  };

  it("R1: a day closed by mistake goes back to `in`, and the close stamp is cleared with it", async () => {
    await closeIt();
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("13:12")));

    const s = await row();
    expect({ status: s.status, closedAt: s.closedAt, closedBy: s.closedBy })
      .toEqual({ status: "in", closedAt: null, closedBy: null });
  });

  /** The morning had ONE opener and still does: a reopen is a correction, not a second morning. */
  it("R2: the reopen does not rewrite who opened the day, and mints no second `opened` event", async () => {
    await closeIt();
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("13:12")));

    const s = await row();
    expect({ openedBy: s.openedBy, openedAt: s.openedAt?.toISOString() })
      .toEqual({ openedBy: nurse.id, openedAt: T("09:40").toISOString() });
    expect(await named("queue_session.opened")).toHaveLength(1);
  });

  it("R3: it appends `queue_session.reopened` naming who did it and how long the day was shut", async () => {
    await closeIt();
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("13:12")));

    const [e] = await named("queue_session.reopened");
    expect(e).toBeDefined();
    expect(e!.actorId).toBe(dra.userId);
    expect(e!.payload).toMatchObject({
      sessionId, doctorId: dra.doctorId, serviceDate: MON,
      closedAt: T("13:10").toISOString(), closedMs: 120_000,
    });
    // The close it corrects stays in the log — a reopen adds a fact, it does not delete one.
    expect(await named("queue_session.closed")).toHaveLength(1);
  });

  /** The point of the whole fix: the patients still holding tokens can be called again. */
  it("R4: calling the next token works again once the day is reopened", async () => {
    const patient = await mkPatient(db, clerk.actor);
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, T("09:50"));
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: T("09:50") }).where(eq(opdQueueEntries.id, visit.queueEntry.id));
    await closeIt();

    await expect(callNext(db, dra.actor, sessionId, T("13:11"))).rejects.toMatchObject({ code: "session_closed" });
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("13:12")));
    const called = await callNext(db, dra.actor, sessionId, T("13:13"));
    expect(called.entry?.id).toBe(visit.queueEntry.id);
  });

  it("R5: yesterday's clinic stays closed — a reopen is same-day only", async () => {
    const SUN = "2026-08-16";
    const s = await withTx(db, (tx) => getOrCreateSession(tx, dra.doctorId, SUN, null));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, s.id, "in", new Date(`${SUN}T04:10:00.000Z`)));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, s.id, "closed", new Date(`${SUN}T08:10:00.000Z`)));

    await expect(withTx(db, (tx) => setSessionStatus(tx, dra.actor, s.id, "in", T("13:12"))))
      .rejects.toMatchObject({ code: "session_closed" });
    expect(await named("queue_session.reopened")).toHaveLength(0);
  });

  it("R6: a closed day reopens to `in` and to nothing else", async () => {
    await closeIt();
    await expect(withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "out", T("13:12"))))
      .rejects.toMatchObject({ code: "session_closed" });
    await expect(withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "closed", T("13:12"))))
      .rejects.toMatchObject({ code: "session_closed" });
    expect((await row()).status).toBe("closed");
  });
});
