import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { alerts, events, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { setSessionStatus } from "./sessions";
import { LONG_WAIT_MIN, NOT_IN_MAX_PER_DAY, queueNudgesAt, sweepQueueNudges } from "./queue-nudges";
import type { Db } from "../../kernel/db/client";

/**
 * MOBILE §3i (owner 2026-10-07) — "PATIENTS ARE WAITING AND YOU ARE NOT IN".
 *
 * A patient is READY (vitals done) and the doctor's day is not started, or the doctor stepped out.
 * The doctor is told after ten minutes, again at most every twenty, never once they are in — and
 * what they are told is a COUNT and MINUTES: no token, no name, no UHID reaches a per-user surface.
 */
const MON = "2026-08-17";
const T = (hhmmIst: string) => new Date(`${MON}T${hhmmIst}:00.000+05:30`);

describe("opd — the doctor's own line nudges the doctor (mobile §3i)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let sessionId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  /** A visit whose vitals are done at `readyAt`: the entry is `waiting`, eligible from then. */
  const ready = async (readyAt: Date, name = "Asha Devi"): Promise<string> => {
    const patient = await mkPatient(db, clerk.actor, { name, phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` });
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, readyAt);
    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, visit.encounter.id)))[0]!;
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: readyAt }).where(eq(opdQueueEntries.id, entry.id));
    sessionId = entry.sessionId;
    return entry.id;
  };
  const told = async (kind: string) => db.select().from(alerts).where(eq(alerts.kind, kind));

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
  });

  it("nothing at nine minutes; at ten the doctor who has not started is told — a count and minutes, nothing of the patient", async () => {
    await ready(T("09:00"), "Geeta Kumari");
    expect(await queueNudgesAt(db, T("09:09"))).toEqual([]);
    expect(await sweepQueueNudges(db, T("09:10"))).toBe(1);
    const rows = await told("opd_not_in");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: dra.userId, refType: "opd_queue_session", refId: sessionId, title: "Patients are waiting and you are not in" });
    expect(rows[0]!.body).toBe("1 patient is ready in your OPD line; the first has waited 10 min. Step in, or tell the desk.");
    expect(JSON.stringify(rows)).not.toMatch(/Geeta|Kumari/);
    expect(await db.select().from(events).where(eq(events.name, "alert.raised"))).toHaveLength(1);
  });

  it("repeats at most every twenty minutes, and stops the moment the doctor steps in", async () => {
    await ready(T("09:00"));
    expect(await sweepQueueNudges(db, T("09:10"))).toBe(1);
    expect(await sweepQueueNudges(db, T("09:11"))).toBe(0);
    expect(await sweepQueueNudges(db, T("09:29"))).toBe(0);
    expect(await sweepQueueNudges(db, T("09:30"))).toBe(1);
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("09:35")));
    expect(await sweepQueueNudges(db, T("09:39"))).toBe(0); // in: nothing more is said about not being in
    await sweepQueueNudges(db, T("09:51")); // twenty-one minutes after the last one — the pacing would allow a third…
    expect(await told("opd_not_in")).toHaveLength(2); // …and being IN is what stops it
    expect(await told("opd_long_wait")).toHaveLength(1); // (the forty-minute crossing is its own notice)
    // Stepped out again with the patient still ready: the nudge is back.
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "out", T("10:00")));
    expect((await queueNudgesAt(db, T("10:01"))).map((n) => n.kind)).toContain("opd_not_in");
  });

  it("a doctor who never comes hears it six times, then silence — the seventh buzz helps nobody", async () => {
    await ready(T("09:00"));
    let raised = 0;
    for (let m = 10; m <= 10 + 20 * 9; m += 20) raised += await sweepQueueNudges(db, new Date(T("09:00").getTime() + m * 60_000));
    expect((await told("opd_not_in")).length).toBe(NOT_IN_MAX_PER_DAY);
    expect(raised).toBe(NOT_IN_MAX_PER_DAY + 1); // + the one long-wait crossing
  });

  it("a wait past forty minutes is said ONCE per doctor-day, to a doctor who is in the room too", async () => {
    await ready(T("09:00"));
    await ready(T("09:05"));
    await withTx(db, (tx) => setSessionStatus(tx, dra.actor, sessionId, "in", T("09:06")));
    expect(await sweepQueueNudges(db, T("09:39"))).toBe(0);
    expect(await sweepQueueNudges(db, new Date(T("09:00").getTime() + LONG_WAIT_MIN * 60_000))).toBe(1);
    expect(await sweepQueueNudges(db, T("09:50"))).toBe(0); // the second patient crossing is the same notice
    const rows = await told("opd_long_wait");
    expect(rows.map((r) => r.title)).toEqual(["A patient has waited over 40 minutes"]);
    expect(await told("opd_not_in")).toEqual([]);
  });

  it("a closed day, a patient still at vitals and yesterday's line raise nothing", async () => {
    const entryId = await ready(T("09:00"));
    await db.update(opdQueueEntries).set({ status: "waiting_vitals", eligibleAt: null }).where(eq(opdQueueEntries.id, entryId));
    expect(await queueNudgesAt(db, T("10:00"))).toEqual([]);
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: T("09:00") }).where(eq(opdQueueEntries.id, entryId));
    expect((await queueNudgesAt(db, new Date(T("10:00").getTime() + 24 * 3_600_000)))).toEqual([]);
    await db.update(opdQueueSessions).set({ status: "closed" }).where(eq(opdQueueSessions.id, sessionId));
    expect(await queueNudgesAt(db, T("10:00"))).toEqual([]);
  });
});
