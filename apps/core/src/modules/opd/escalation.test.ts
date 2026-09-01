import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdEncounters, opdQueueEntries } from "../../kernel/db/schema";
import { getEncounter, openVisit } from "./encounters";
import { CANCEL_WINDOW_MS, cancelEscalation, demandRecheck, escalate, escalationFor } from "./escalation";
import { classOf } from "./queue-engine";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ VD-1 T3 — THE DANGER PROTOCOL ═══
 *
 * Ganesh Oraon, 61, a class-3 walk-in, "sir bhaari, chakkar". 208/126, then 214/132.
 *
 * The property every test here circles is the one the owner ruled and the one a wrong
 * implementation would quietly lose: **cancel moves the BOARD and never the CHART.** A cancel
 * that also cleared `danger_flagged` would be a patient-safety regression wearing a feature's
 * clothes, and a cancel that the next save silently undid would be theatre. Both are asserted,
 * in the same test, because they are the two ways to get this wrong and they fail in opposite
 * directions.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB_61 = new Date(Date.UTC(1965, 0, 15)); // 61 at MON
const DANGER = { sbp: 208, dbp: 126, pulse: 104, spo2: 95, tempC: 36.9, heightCm: 168, weightKg: 71.5 };
const WORSE = { ...DANGER, sbp: 214, dbp: 132 };
const CALM = { ...DANGER, sbp: 128, dbp: 82 };

describe("VD-1 T3 — recheck, the double confirm, and the ten seconds", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let ganesh: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    ganesh = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_61 });
  });

  const walkIn = async (): Promise<string> =>
    (await openVisit(db, clerk.actor, { patientId: ganesh.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;
  const entryOf = async (encounterId: string) =>
    (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)))[0]!;
  const classNow = async (encounterId: string): Promise<number> => {
    const e = await entryOf(encounterId);
    return classOf({
      id: e.id, tokenNo: e.tokenNo, kind: e.kind === "appointment" ? "appointment" : "walk_in",
      appointmentAt: e.appointmentAt, eligibleAt: e.eligibleAt ?? e.createdAt, seq: e.seq,
      danger: e.danger, reEntry: e.reEntry, perk: e.perk, skips: e.skips,
    }, MON);
  };

  it("ONE danger reading demands the other arm and moves NOTHING on the board", async () => {
    const enc = await walkIn();
    expect(await classNow(enc)).toBe(3); // a walk-in

    const view = await demandRecheck(db, vd.actor, enc, DANGER, MON);
    expect(view.state).toBe("recheck_demanded");
    expect(view.cancelMsRemaining).toBe(0);

    const entry = await entryOf(enc);
    expect(entry.danger).toBe(false);
    expect(entry.escalatedAt).toBeNull();
    expect(await classNow(enc)).toBe(3); // STILL a walk-in — a single bad number does not reorder a board
  });

  it("the double confirm bumps to class 0, by the agent, with ten seconds on the clock", async () => {
    const enc = await walkIn();
    await demandRecheck(db, vd.actor, enc, DANGER, MON);
    const view = await escalate(db, vd.actor, enc, WORSE, MON);

    expect(view.state).toBe("escalated");
    expect(view.escalatedFromClass).toBe(3);
    expect(view.cancelMsRemaining).toBe(CANCEL_WINDOW_MS);
    expect(await classNow(enc)).toBe(0);
    expect((await getEncounter(db, enc))!.dangerFlagged).toBe(true);

    // The flash: the event rides `queue:<doctorId>:<serviceDate>` like the call itself.
    const escalated = (await db.select().from(events).where(eq(events.name, "queue.escalated")))[0]!;
    const payload = escalated.payload as { doctorId: string; serviceDate: string; fromClass: number; toClass: number; by: string };
    expect(payload).toMatchObject({ doctorId: dra.doctorId, serviceDate: "2026-08-17", fromClass: 3, toClass: 0, by: "agent" });
  });

  it("escalating without the first reading is refused — 'double-confirmed' is mechanical, not advisory", async () => {
    const enc = await walkIn();
    await expect(escalate(db, vd.actor, enc, WORSE, MON))
      .rejects.toMatchObject({ code: "escalation_state_conflict" });
    expect(await classNow(enc)).toBe(3);
  });

  it("the SERVER decides whether a bump is warranted — a calm reading cannot buy one", async () => {
    const enc = await walkIn();
    await expect(demandRecheck(db, vd.actor, enc, CALM, MON))
      .rejects.toMatchObject({ code: "escalation_not_warranted" });
    await expect(escalate(db, vd.actor, enc, CALM, MON))
      .rejects.toMatchObject({ code: "escalation_state_conflict" });
    expect(await classNow(enc)).toBe(3);
  });

  /**
   * THE TEST THIS WHOLE TASK EXISTS FOR. Both halves, in one place, because they fail in
   * opposite directions: a cancel that clears the chart is a safety regression, and a cancel the
   * next save undoes is theatre.
   */
  it("cancel restores the BOARD, never the CHART — and the next save does not re-bump", async () => {
    const enc = await walkIn();
    await demandRecheck(db, vd.actor, enc, DANGER, MON);
    await escalate(db, vd.actor, enc, WORSE, MON);
    expect(await classNow(enc)).toBe(0);

    const at = new Date(MON.getTime() + 4_000); // four seconds in
    const view = await cancelEscalation(db, vd.actor, enc, at);
    expect(view.state).toBe("cancelled");
    expect(view.escalationBy).toBe(vd.actor.id);
    expect(await classNow(enc)).toBe(3); // the original queuing stands

    // THE CHART IS UNTOUCHED by the cancel…
    expect((await getEncounter(db, enc))!.dangerFlagged).toBe(true);
    const cancelled = await db.select().from(events).where(eq(events.name, "queue.escalation_cancelled"));
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0]!.payload as { withinMs: number; restoredClass: number }))
      .toMatchObject({ withinMs: 4_000, restoredClass: 3 });

    // …and the ordinary save that follows records BOTH takes, flags danger to the doctor, and
    // does NOT put the token back at the head of the board.
    const r = await recordVitals(db, vd.actor, enc, WORSE, new Date(MON.getTime() + 60_000), {
      readings: {
        bp: { takes: [[208, 126], [214, 132]], source: "device" },
        pulse: { takes: [104], source: "device" }, spo2: { takes: [95], source: "device" },
        tempC: { takes: [36.9], source: "device" }, heightCm: { takes: [168], source: "typed" },
        weightKg: { takes: [71.5], source: "typed" },
      },
    });
    expect(r.flags.map((f) => f.vital).sort()).toEqual(["dbp", "sbp"]);
    expect(r.encounter.dangerFlagged).toBe(true);
    expect((await entryOf(enc)).danger).toBe(false); // the predicate that makes cancel real
    expect(await classNow(enc)).toBe(3);
    expect((await db.select().from(events).where(eq(events.name, "vitals.danger_flagged")))).toHaveLength(1);
  });

  it("one millisecond past the window is refused, and the class stands", async () => {
    const enc = await walkIn();
    await demandRecheck(db, vd.actor, enc, DANGER, MON);
    await escalate(db, vd.actor, enc, WORSE, MON);

    const late = new Date(MON.getTime() + CANCEL_WINDOW_MS + 1);
    await expect(cancelEscalation(db, vd.actor, enc, late))
      .rejects.toMatchObject({ code: "escalation_window_closed" });
    expect(await classNow(enc)).toBe(0);
    expect((await entryOf(enc)).escalation).toBe("escalated");

    // The boundary itself is closed, not open: at exactly +10 000 ms the ten seconds are up.
    const exact = new Date(MON.getTime() + CANCEL_WINDOW_MS);
    await expect(cancelEscalation(db, vd.actor, enc, exact))
      .rejects.toMatchObject({ code: "escalation_window_closed" });
    // …and one millisecond inside it still works.
    const inside = new Date(MON.getTime() + CANCEL_WINDOW_MS - 1);
    expect((await cancelEscalation(db, vd.actor, enc, inside)).state).toBe("cancelled");
  });

  it("escalationFor is what the bay paints its countdown from, and it decays with the clock", async () => {
    const enc = await walkIn();
    expect((await escalationFor(db, enc, MON))!.state).toBe("none");
    await demandRecheck(db, vd.actor, enc, DANGER, MON);
    await escalate(db, vd.actor, enc, WORSE, MON);

    expect((await escalationFor(db, enc, MON))!.cancelMsRemaining).toBe(CANCEL_WINDOW_MS);
    expect((await escalationFor(db, enc, new Date(MON.getTime() + 7_000)))!.cancelMsRemaining).toBe(3_000);
    expect((await escalationFor(db, enc, new Date(MON.getTime() + 30_000)))!.cancelMsRemaining).toBe(0);
    // …but the STATE is still `escalated`: the window closing is not the escalation ending.
    expect((await escalationFor(db, enc, new Date(MON.getTime() + 30_000)))!.state).toBe("escalated");
  });

  it("a bill-first visit with no live entry has no board position to escalate on", async () => {
    const deferred = await openVisit(
      db, clerk.actor,
      { patientId: ganesh.id, departmentId: deptId, doctorId: dra.doctorId, join: "defer" }, MON,
    );
    await expect(demandRecheck(db, vd.actor, deferred.encounter.id, DANGER, MON))
      .rejects.toMatchObject({ code: "unknown_queue_entry" });
    expect(await db.select().from(opdEncounters).where(eq(opdEncounters.id, deferred.encounter.id))).toHaveLength(1);
  });
});
