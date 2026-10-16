import { eq } from "drizzle-orm";
import { UNIT_REPORT_IST, newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedConfirmedUnits } from "../../../test/helpers/units";
import {
  alerts, doctorDeskActs, doctorDeskAgentRuns, opdDepartments, patients, registrationConfig, rosterOfficiating,
  rosterTeamMemberships, users,
} from "../../kernel/db/schema";
import { teamByCode } from "../roster";
import { reportDateAt, reportsFor, sendUnitReports } from "./report";
import { towerView } from "./tower";
import type { Db } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-report v0 — the 08:00 IST unit report: counts only, idempotent per unit per day,
 * critical→act from `doctor_desk_acts`, medians only above the ratings' floors, a bell to the unit
 * head and the page. Every instant is passed in.
 */
describe("doctor-desk — DD-report v0, the unit report", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  // 08:00 IST on Tuesday 6 October: the report for the take 5 Oct 08:00 → 6 Oct 08:00.
  const AT = new Date("2026-10-06T08:00:00+05:30");
  const min = (n: number): Date => new Date(AT.getTime() + n * 60_000);
  const actor = (id: string): Actor => ({ type: "user", id });
  const P = { HEAD: "", STAND: "", SR: "", JR: "", U1HEAD: "", U3HEAD: "" };
  let U1 = ""; let U2 = ""; let U3 = "";

  async function person(k: keyof typeof P, name: string): Promise<void> {
    const id = newId();
    await db.insert(users).values({ id, username: `r-${k.toLowerCase()}`, fullName: name, staffCode: `EMP-R${k}`, passwordHash: "x" });
    P[k] = id;
  }
  const post = (userId: string, teamId: string, positionKey: string, grade: string, roleInTeam: string) => ({
    id: newId(), teamId, userId, positionKey, grade, roleInTeam, kind: "parent", startsAt: new Date("2026-01-01T00:00:00+05:30"), createdBy: "t", updatedBy: "t",
  });
  /** An act in `teamId`, `minutes` after its critical opened, acted at `actedAt`. */
  const act = (teamId: string, actorId: string, minutes: number, actedAt: Date) => ({
    id: newId(), rowKey: `lab_critical:${newId()}`, teamId, holderId: actorId, actorId, choice: "treatment_started",
    openedAt: new Date(actedAt.getTime() - minutes * 60_000), actedAt,
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(opdDepartments).values({ id: newId(), code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" });
    await seedConfirmedUnits(db);
    U1 = (await teamByCode(db, "MED-U1"))!.id;
    U2 = (await teamByCode(db, "MED-U2"))!.id;
    U3 = (await teamByCode(db, "MED-U3"))!.id;
    await person("HEAD", "Dr. Head Two"); await person("STAND", "Dr. Standing In"); await person("SR", "Dr. Senior Two");
    await person("JR", "Dr. Junior Two"); await person("U1HEAD", "Dr. Head One"); await person("U3HEAD", "Dr. Head Three");
    await db.insert(rosterTeamMemberships).values([
      post(P.HEAD, U2, "unit_head", "professor", "head"),
      post(P.STAND, U2, "faculty_on_call", "assistant_professor", "faculty"),
      post(P.SR, U2, "unit_sr", "senior_resident", "senior_resident"),
      post(P.JR, U2, "ward_jr", "jr1", "junior_resident"),
      post(P.U1HEAD, U1, "unit_head", "professor", "head"),
      post(P.U3HEAD, U3, "unit_head", "professor", "head"),
    ]);
  });

  it("the report date and instant: 08:00 IST is the take boundary; before it, yesterday's report", () => {
    expect(UNIT_REPORT_IST).toBe("08:00");
    expect(reportDateAt(AT)).toBe("2026-10-06");
    expect(reportDateAt(min(-1))).toBe("2026-10-05");
  });

  it("critical→act comes from the acts in the 24 h window; a median only from five acts; the pools only from three units and ten acts", async () => {
    await db.insert(doctorDeskActs).values([
      ...[4, 6, 8, 10, 20].map((m, i) => act(U2, i % 2 === 0 ? P.SR : P.JR, m, min(-60 * (i + 1)))),
      act(U2, P.SR, 3, min(-60 * 30)), // before the window: not counted
      act(U2, P.SR, 3, min(5)),        // after 08:00: tomorrow's
    ]);
    await sendUnitReports(db, AT);
    const page = await reportsFor(db, actor(P.HEAD), min(1));
    expect(page.reports).toHaveLength(1);
    const r = page.reports[0]!;
    expect(r).toMatchObject({
      teamId: U2, short: "Unit II", reportDate: "2026-10-06",
      critical: { acts: 5, median: 8, over: 1, longest: 20, overMinutes: 15 },
      compare: { department: null, hospital: null }, // one unit contributes: below the pool floor
      opd: { date: "2026-10-05", seen: 0, doctors: 0 },
    });
    // the department pool opens at three units and ten acts
    await db.delete(doctorDeskAgentRuns);
    await db.insert(doctorDeskActs).values([
      ...[5, 7, 9].map((m, i) => act(U1, P.U1HEAD, m, min(-30 - i))),
      ...[11, 13].map((m, i) => act(U3, P.U3HEAD, m, min(-40 - i))),
    ]);
    await sendUnitReports(db, AT);
    const again = (await reportsFor(db, actor(P.HEAD), min(1))).reports[0]!;
    expect(again.compare).toEqual({ department: 9, hospital: 9 });
    const u1 = (await db.select().from(doctorDeskAgentRuns).where(eq(doctorDeskAgentRuns.teamId, U1)))[0]!;
    expect((u1.params as { report: { critical: { acts: number; median: number | null } } }).report.critical).toMatchObject({ acts: 3, median: null });
  });

  it("idempotent per unit per day: a second run (a restart at 08:00) sends nothing; the bell names no patient and no person", async () => {
    await db.insert(patients).values({ id: newId(), uhid: "HMS-00000001-5", name: "Patient Alpha", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" });
    await db.insert(doctorDeskActs).values(act(U2, P.SR, 9, min(-90)));
    const first = await sendUnitReports(db, AT);
    const second = await sendUnitReports(db, min(3));
    expect(second.sent).toBe(0);
    expect(first.sent).toBeGreaterThan(0);
    const u2Runs = await db.select().from(doctorDeskAgentRuns).where(eq(doctorDeskAgentRuns.teamId, U2));
    expect(u2Runs).toHaveLength(1);
    const bells = await db.select().from(alerts).where(eq(alerts.kind, "doctor_desk_unit_report"));
    expect(bells.filter((b) => b.userId === P.HEAD)).toHaveLength(1);
    expect(bells.filter((b) => b.userId === P.SR || b.userId === P.JR)).toHaveLength(0);
    const words = JSON.stringify([...bells.map((b) => `${b.title} ${b.body ?? ""}`), u2Runs[0]!.params]);
    expect(words).not.toMatch(/Patient Alpha|HMS-|Dr\.|Senior Two|Junior Two|Head Two/);
    expect(words).not.toMatch(/fee|paid|price|₹|rupee|bill/i);
    // the next day is a new report
    expect((await sendUnitReports(db, min(60 * 24))).sent).toBeGreaterThan(0);
    expect(await db.select().from(doctorDeskAgentRuns).where(eq(doctorDeskAgentRuns.teamId, U2))).toHaveLength(2);
  });

  it("an officiating head receives it; the page is the head's, the HOD's for the department — an SR reads none", async () => {
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U2, userId: P.STAND, role: "head", startsAt: min(-60 * 24), endsAt: min(60 * 24), reason: "head on leave",
      approvedBy: P.HEAD, createdBy: "t", updatedBy: "t",
    });
    await sendUnitReports(db, AT);
    const to = (await db.select().from(alerts).where(eq(alerts.kind, "doctor_desk_unit_report"))).map((b) => b.userId);
    expect(to).toEqual(expect.arrayContaining([P.HEAD, P.STAND]));
    expect((await reportsFor(db, actor(P.STAND), min(1))).reports.map((r) => r.teamId)).toEqual([U2]);
    expect((await reportsFor(db, actor(P.SR), min(1))).reports).toEqual([]);
    await db.insert(rosterOfficiating).values({
      id: newId(), teamId: U1, userId: P.U3HEAD, role: "hod", startsAt: min(-60), endsAt: min(60), reason: "HOD on leave",
      approvedBy: P.HEAD, createdBy: "t", updatedBy: "t",
    });
    expect((await reportsFor(db, actor(P.U3HEAD), min(1))).reports.map((r) => r.teamId)).toEqual(expect.arrayContaining([U1, U2, U3]));
  });

  it("the Tower's agent card shows the run as a line with flat params only", async () => {
    await sendUnitReports(db, AT);
    const t = await towerView(db, actor(P.HEAD), min(2));
    const run = t.agentRuns.find((r) => r.agent === "unit_report")!;
    expect(run).toMatchObject({ summaryKey: "reportSent", params: { reportDate: "2026-10-06", heads: 1 } });
    expect(Object.values(run.params).every((v) => typeof v === "string" || typeof v === "number")).toBe(true);
  });
});
