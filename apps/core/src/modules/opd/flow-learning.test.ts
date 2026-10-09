import { eq, inArray } from "drizzle-orm";
import { addDayIso, mondayIndex, newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { insertVisits, type FixtureVisit } from "../../../test/helpers/flow";
import { events, opdDepartments, opdEncounters, opdFlowBaselines, opdFlowFindings, opdVitals } from "../../kernel/db/schema";
import { loadFlowReport } from "./flow";
import { dismissFinding, lastWeekdays, runFlowLearning, triedFinding } from "./flow-learning";
import type { Db } from "../../kernel/db/client";

/**
 * HOW LONG PATIENTS WAIT (owner 2026-10-09) — the half that touches the tables: which visits the SQL
 * reads and drops, and the nightly learning's memory — a finding opened, kept by a second run, kept
 * quiet by ×, brought back at 20 % worse, and resolved with its before and after once "Tried it" worked.
 * Every instant is handed in (`NOW`); nothing here reads the real clock.
 */
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+05:30`);
const DESK_TIMES = ["10:00", "10:30", "11:00", "11:30", "13:00", "14:00", "15:00", "16:00"];
const inWindow = (desk: string): boolean => desk >= "10:00" && desk < "12:00";

describe("OPD — the waits from the tables, and what the nightly learning remembers", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string; let labId: string;
  let ctx: { patientId: string; doctorId: string; by: string };
  let owner: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    labId = newId();
    await db.insert(opdDepartments).values({ id: labId, code: "LAB", name: "Laboratory", createdBy: "t", updatedBy: "t" });
    const clerk = await mkUser(db, "fl_clerk", ["front_office"]);
    owner = await mkUser(db, "fl_owner", ["owner"]);
    const dr = await mkDoctor(db, { username: "fl_dr", departmentId: deptId, roomId, displayName: "Dr. Kavita Flowcheck" });
    const p = await mkPatient(db, clerk.actor, { name: "Ramesh Flowpatient", phone: "9811100011" });
    ctx = { patientId: p.id, doctorId: dr.doctorId, by: clerk.id };
  });

  it("reads the first vitals save and the consult start, and drops — and counts — every visit it should", async () => {
    const DAY = "2026-10-05";
    const v = (desk: string, o: Partial<FixtureVisit> = {}): FixtureVisit => ({ departmentId: deptId, serviceDate: DAY, openedAt: at(DAY, desk), a: 10, b: 20, ...o });
    await insertVisits(db, ctx, [
      v("09:00"), v("09:10"), v("09:20"), v("09:30"),
      v("09:40", { amendAfter: 30 }), // the amendment 30 minutes later does not move the wait
      v("09:50", { guardian: true, a: null }),
      v("10:00", { abandoned: true }),
      v("10:10", { leftLine: true }),
      v("10:20", { paper: { realStart: false } }), // desk → vitals counted; the start on paper is the filing
      v("10:30", { paper: { realStart: true } }), // a doctor who opened it and then closed on paper: counted
      v("10:40", { reEntry: true }),
      v("10:50", { a: 500 }),
      v("11:00", { departmentId: labId }), // a lab walk-in is not a consultation
      v("11:10", { visitType: "pharmacy" }),
    ]);
    const r = await loadFlowReport(db, { range: { from: DAY, to: DAY }, compare: null, groupBy: "department", departmentId: null }, { mayAct: false, learning: true, now: at(DAY, "23:00") });
    expect(r.hospital.deskToVitals).toEqual({ n: 8, avg: 10, median: 10, p90: 10 });
    /* The 500-minute desk → vitals is dropped; that visit's vitals → doctor (20) was real and stays. */
    expect(r.hospital.vitalsToDoctor).toEqual({ n: 7, avg: 20, median: 20, p90: 20 });
    expect(r.hospital.deskToDoctor).toEqual({ n: 6, avg: 30, median: 30, p90: 30 });
    expect(r.drops).toEqual({ guardian: 1, left: 2, paperNoStart: 1, reEntry: 1, outOfRange: 1 });
    expect(r.groups.map((g) => [g.key, g.name, g.cell.deskToDoctor.n])).toEqual([[deptId, "General Medicine", 6]]);
    /* No patient, no doctor, no clerk — in any field, at any depth. */
    const json = JSON.stringify(r);
    for (const name of ["Ramesh", "Flowpatient", "Kavita", "Flowcheck", "fl_clerk", "fl_dr", ctx.patientId, ctx.doctorId, ctx.by]) expect({ name, found: json.includes(name) }).toEqual({ name, found: false });
  });

  /** An ordinary department over `days` days ending `last`: eight visits a day, 10 minutes to vitals, 12 to the doctor. */
  const month = (last: string, days: number, a: (day: string, desk: string) => number = () => 10): FixtureVisit[] =>
    Array.from({ length: days }, (_, i) => addDayIso(last, -i)).flatMap((day) =>
      DESK_TIMES.map((desk) => ({ departmentId: deptId, serviceDate: day, openedAt: at(day, desk), a: a(day, desk), b: 12 })));

  const findings = async () => db.select().from(opdFlowFindings);

  it("bay_peak opens, a second run keeps it, × keeps it quiet, and it comes back only at 20 % worse than when it was dismissed", async () => {
    const TODAY = "2026-10-09"; // a Friday
    const NOW = at(TODAY, "23:55");
    const fridays = lastWeekdays(TODAY, mondayIndex(TODAY), 4);
    await insertVisits(db, ctx, month(TODAY, 42, (day, desk) => (fridays.includes(day) && inWindow(desk) ? 20 : 10)));

    expect(await runFlowLearning(db, false, NOW)).toEqual({ ran: false, baselines: 0, opened: 0, updated: 0, reopened: 0, resolved: 0 });
    expect(await findings()).toEqual([]);

    const first = await runFlowLearning(db, true, NOW);
    expect(first).toMatchObject({ ran: true, opened: 1, updated: 0 });
    const [row] = await findings();
    expect(row).toMatchObject({ type: "bay_peak", scope: deptId, leg: "desk_vitals", weekday: 4, hourFrom: 10, hourTo: 12, observedMin: 20, baselineMin: 10, patients: 16, minutesLost: 160, firstSeen: TODAY, lastSeen: TODAY, state: "open" });
    /* The department's own baseline, every weekday and hour together, the last 28 days. */
    const base = await db.select().from(opdFlowBaselines).where(eq(opdFlowBaselines.scope, deptId));
    expect(base.find((b) => b.leg === "desk_vitals" && b.weekday === -1 && b.hour === -1)).toMatchObject({ n: 224, medianMin: 10, windowFrom: addDayIso(TODAY, -27), windowTo: TODAY });
    expect(base.find((b) => b.leg === "desk_vitals" && b.weekday === 4 && b.hour === 10)).toMatchObject({ n: 8, medianMin: 20 });

    expect(await runFlowLearning(db, true, NOW)).toMatchObject({ opened: 0, updated: 1 });
    expect(await findings()).toHaveLength(1);

    expect(await dismissFinding(db, owner.actor, row!.id, NOW)).toEqual({ ok: true });
    expect(await dismissFinding(db, owner.actor, row!.id, NOW)).toEqual({ ok: false, problem: "finding_not_open" });
    const audit = await db.select().from(events).where(eq(events.name, "flow.finding_dismissed"));
    expect(audit.map((e) => [e.actorId, (e.payload as { findingId: string }).findingId])).toEqual([[owner.id, row!.id]]);
    await runFlowLearning(db, true, NOW);
    expect((await findings())[0]).toMatchObject({ state: "dismissed", dismissedObservedMin: 20 });

    /* The window's visits on the hot Fridays, made slower: 23 minutes is under 1.2 × 20 — still quiet. */
    const hot = await db.select({ id: opdEncounters.id, openedAt: opdEncounters.openedAt }).from(opdEncounters);
    const slow = hot.filter((e) => fridays.some((f) => e.openedAt >= at(f, "10:00") && e.openedAt < at(f, "12:00")));
    const slower = async (min: number) => {
      for (const e of slow) await db.update(opdVitals).set({ recordedAt: new Date(e.openedAt.getTime() + min * 60_000) }).where(eq(opdVitals.encounterId, e.id));
    };
    await slower(23);
    expect(await runFlowLearning(db, true, NOW)).toMatchObject({ reopened: 0 });
    expect((await findings())[0]).toMatchObject({ state: "dismissed" });
    await slower(25);
    expect(await runFlowLearning(db, true, NOW)).toMatchObject({ reopened: 1 });
    expect((await findings())[0]).toMatchObject({ state: "open", note: "returned_worse", observedMin: 25, dismissedAt: null });
  });

  it("a dismissed finding comes back as it was after 28 quiet days, if it still fires", async () => {
    const TODAY = "2026-10-09";
    const fridays = lastWeekdays(TODAY, mondayIndex(TODAY), 4);
    await insertVisits(db, ctx, month(TODAY, 42, (day, desk) => (fridays.includes(day) && inWindow(desk) ? 20 : 10)));
    await runFlowLearning(db, true, at(TODAY, "23:55"));
    const [row] = await findings();
    /* Dismissed 28 days before tonight. */
    await dismissFinding(db, owner.actor, row!.id, at(addDayIso(TODAY, -28), "12:00"));
    expect(await runFlowLearning(db, true, at(TODAY, "23:55"))).toMatchObject({ reopened: 1 });
    expect((await findings())[0]).toMatchObject({ state: "open", note: "returned" });
  });

  it("'Tried it' stamps the median then; two quiet weeks later the finding is resolved with its before, after and minutes won", async () => {
    const DAY0 = "2026-10-09", DAY1 = "2026-10-23"; // two Fridays, two weeks apart
    const hotFridays = lastWeekdays(DAY0, mondayIndex(DAY0), 4);
    await insertVisits(db, ctx, month(DAY1, 56, (day, desk) => (hotFridays.includes(day) && inWindow(desk) ? 20 : 10)));
    await runFlowLearning(db, true, at(DAY0, "23:55"));
    const [row] = await findings();
    expect(await triedFinding(db, owner.actor, row!.id, at(addDayIso(DAY0, 1), "09:00"))).toEqual({ ok: true });
    expect(await triedFinding(db, owner.actor, row!.id, at(addDayIso(DAY0, 1), "09:05"))).toEqual({ ok: false, problem: "already_tried" });
    expect((await findings())[0]).toMatchObject({ beforeMedianMin: 20, triedBy: owner.id });

    expect(await runFlowLearning(db, true, at(DAY1, "23:55"))).toMatchObject({ resolved: 1 });
    expect((await findings())[0]).toMatchObject({ state: "resolved", resolvedOn: DAY1, beforeMedianMin: 20, afterMedianMin: 10, minutesWon: 80 });

    const r = await loadFlowReport(db, { range: { from: DAY1, to: DAY1 }, compare: null, groupBy: null, departmentId: null }, { mayAct: true, learning: true, now: at(DAY1, "23:58") });
    expect(r.findings).toEqual([]);
    expect(r.fixed.map((f) => [f.type, f.before, f.after, f.minutesWon, f.triedOn, f.department])).toEqual([["bay_peak", 20, 10, 80, addDayIso(DAY0, 1), "General Medicine"]]);
    /* The same pattern coming back opens a NEW row; the resolved one stays as history. */
    const tried = await db.select({ name: events.name }).from(events).where(inArray(events.name, ["flow.finding_tried"]));
    expect(tried).toHaveLength(1);
  });
});
