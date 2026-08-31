import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries } from "../../kernel/db/schema";
import { abandonVisit, joinQueue, openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * RC-1 T3 / D4 — BILL-FIRST IS A DEFERRED QUEUE JOIN, NEVER A REORDERED TRANSACTION.
 *
 * The deferred open writes the encounter and STOPS: no session, no token, no queue entry, and a
 * `visit.opened` whose sessionId/tokenNo are null. `joinQueue` is the second half, and its two
 * properties are the assertion book's rows: it is IDEMPOTENT (a replay answers the existing
 * entry), and it is RACE-SAFE by the encounter-row lock — two concurrent joins yield ONE token
 * and ONE row, whichever way the interleaving falls.
 */
describe("RC-1 T3 — the deferred queue join", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Actor;
  let deptId: string;
  let roomId: string;
  let doctorId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    clerk = (await mkUser(db, "rc_clerk", ["front_office"])).actor;
    ({ doctorId } = await mkDoctor(db, { username: "rc_dr", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
  });

  const openDeferred = async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899000001" });
    return openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
  };

  it("a deferred open has no token, no entry, and a visit.opened with null session/token", async () => {
    const r = await openDeferred();
    expect(r.tokenNo).toBeNull();
    expect(r.queueEntry).toBeNull();
    expect(r.sessionId).toBeNull();
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.encounter.id));
    expect(entries).toHaveLength(0);
    const opened = (await db.select().from(events).where(eq(events.name, "visit.opened")))[0]!;
    expect((opened.payload as { tokenNo: number | null }).tokenNo).toBeNull();
    expect((opened.payload as { sessionId: string | null }).sessionId).toBeNull();
    // patient.checked_in belongs to the JOIN, not the open — a deferred patient is not in any hall.
    expect(await db.select().from(events).where(eq(events.name, "patient.checked_in"))).toHaveLength(0);
  });

  it("joinQueue seats the visit: one waiting_vitals entry, a real token, and the checked-in event", async () => {
    const r = await openDeferred();
    const joined = await joinQueue(db, clerk, r.encounter.id);
    expect(joined.alreadyJoined).toBe(false);
    expect(joined.tokenNo).toBe(1);
    expect(joined.queueEntry.status).toBe("waiting_vitals");
    const checked = await db.select().from(events).where(eq(events.name, "patient.checked_in"));
    expect(checked).toHaveLength(1);
    expect((checked[0]!.payload as { tokenNo: number }).tokenNo).toBe(1);
  });

  it("is idempotent: a replay answers the SAME entry and mints no second token", async () => {
    const r = await openDeferred();
    const first = await joinQueue(db, clerk, r.encounter.id);
    const replay = await joinQueue(db, clerk, r.encounter.id);
    expect(replay.alreadyJoined).toBe(true);
    expect(replay.queueEntry.id).toBe(first.queueEntry.id);
    expect(replay.tokenNo).toBe(first.tokenNo);
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.encounter.id));
    expect(entries).toHaveLength(1);
  });

  it("A-a: two CONCURRENT joins yield ONE entry and ONE token — the encounter lock serializes them", async () => {
    const r = await openDeferred();
    const [a, b] = await Promise.all([
      joinQueue(db, clerk, r.encounter.id),
      joinQueue(db, clerk, r.encounter.id),
    ]);
    expect([a.alreadyJoined, b.alreadyJoined].sort()).toEqual([false, true]);
    expect(a.tokenNo).toBe(b.tokenNo);
    const entries = await db
      .select().from(opdQueueEntries)
      .where(and(eq(opdQueueEntries.encounterId, r.encounter.id), inArray(opdQueueEntries.status, ["waiting_vitals", "waiting", "called", "in_consult"])));
    expect(entries).toHaveLength(1);
  });

  it("refuses an unknown encounter, a past day's visit, and a visit that already moved on", async () => {
    await expect(joinQueue(db, clerk, "01NOSUCH00000000000000000")).rejects.toMatchObject({ code: "unknown_encounter" });

    const r = await openDeferred();
    await expect(joinQueue(db, clerk, r.encounter.id, new Date(Date.now() + 2 * 24 * 3600 * 1000)))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });

    // The queue-first path + vitals moves the encounter off `registered`; joining then is a conflict.
    // (`registered → waiting` is a vitals-desk transition in the workflow definition — R-1.)
    const vd = (await mkUser(db, "rc_vd", ["vitals_desk"])).actor;
    const patient2 = await mkPatient(db, clerk, { phone: "9899000002" });
    const opened = await openVisit(db, clerk, { patientId: patient2.id, departmentId: deptId, doctorId });
    await recordVitals(db, vd, opened.encounter.id, { heightCm: 170, weightKg: 70, sbp: 120, dbp: 80, pulse: 72, rr: 14, spo2: 98, tempC: 36.6 });
    await expect(joinQueue(db, clerk, opened.encounter.id)).rejects.toMatchObject({ code: "encounter_state_conflict" });

    // And the immediate (queue-first) open is byte-for-byte the shipped behaviour: entry + token.
    expect(opened.tokenNo).toBe(1);
    expect(opened.queueEntry.status).toBe("waiting_vitals");
  });

  /*
   * RC-1 CLOSE C1 — the walked-away bill-first patient. The reviewer found abandonVisit 500ing on
   * a deferred visit (`entries[0]!` on zero rows), which made the visit UNCLOSABLE: the only exit
   * was minting a token for someone who had left. The abandon must succeed, and its event carries
   * null session/token exactly as visit.opened does for the same state.
   */
  it("C1: a deferred visit can be ABANDONED — no 500, encounter closed, event with null token", async () => {
    const r = await openDeferred();
    const { encounter } = await abandonVisit(db, clerk, r.encounter.id, "patient left before billing");
    expect(encounter.status).toBe("abandoned");
    const abandoned = await db.select().from(events).where(eq(events.name, "visit.abandoned"));
    expect(abandoned).toHaveLength(1);
    const p = abandoned[0]!.payload as { tokenNo: number | null; sessionId: string | null; fromState: string };
    expect(p.tokenNo).toBeNull();
    expect(p.sessionId).toBeNull();
    expect(p.fromState).toBe("registered");
    // And an abandoned visit cannot then join a queue.
    await expect(joinQueue(db, clerk, r.encounter.id)).rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("a non-user actor is refused", async () => {
    const r = await openDeferred();
    const agent: Actor = { type: "agent", id: "a-1" };
    await expect(joinQueue(db, agent, r.encounter.id)).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
