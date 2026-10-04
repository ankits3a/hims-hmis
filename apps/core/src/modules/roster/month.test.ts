import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterTeams, users,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedRosterPositions } from "./masters";
import { seedRosterRules } from "./rules";
import { addMembership } from "./memberships";
import { recordAbsence } from "./absences";
import { declareHoliday, publishCycle } from "./calendar";
import { newId } from "@hmis/contracts";
import { rosterCycleEntries, rosterCycles } from "../../kernel/db/schema";
import { RosterError } from "./errors";
import {
  acceptUnitFinding, draftUnitMonth, editSlot, monthWindow, publishUnitMonth, rosterUnits, unitMonth,
} from "./month";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { UnitMonth } from "./month";

/**
 * 20-U U5b — **THE UNIT'S MONTH**, as one read and four writes, each write a domain function.
 *
 * The leg to read first is **"a blocking finding stops the publish, and the one-tap fix clears
 * it"**: the senior resident puts the night's JR onto the next morning's list (the board's own
 * Kavita case), the month reads one MUST-FIX with the person and the day named, publish is refused
 * with `blocked_by_findings`, and vacating that one slot makes it publishable.
 */
describe("roster — the unit's month (20-U U5b)", () => {
  const MS = "01USER00000000000000000MS";
  const DOC = "01USER0000000000000000DOC";
  const MED = "01ORGDEPT000000000000MED";
  const TEAM = "01ROSTERTEAM00000MEDU2";
  const JRS = Array.from({ length: 4 }, (_, i) => `01USERJR00000000000000${String(i)}`);
  const ms: Actor = { type: "user", id: MS };
  const doc: Actor = { type: "user", id: DOC };
  const at = (s: string): Date => new Date(`${s}:00+05:30`);

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "medical_superintendent", title: "Medical Superintendent" },
      ...["duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"].map((key) => ({ key, title: key })),
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values([
      ...[ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
      { roleKey: "doctor", permission: ROSTER_READ },
    ]);
    await db.insert(orgDepartments).values([
      { id: MED, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, createdBy: "t", updatedBy: "t" },
    ]);
    await seedRosterPositions(db);
    await db.insert(users).values([
      { id: MS, username: "ms", fullName: "Dr. Sunita Mishra", staffCode: "EMP-MS", passwordHash: "x" },
      { id: DOC, username: "doc", fullName: "Dr. Read Only", staffCode: "EMP-DOC", passwordHash: "x" },
    ]);
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-DOC", userId: DOC, roleKey: "doctor", scopeType: "hospital", scopeId: null },
    ]);
    for (const [i, id] of JRS.entries()) {
      await db.insert(users).values({ id, username: `jr${String(i)}`, fullName: `Dr. Resident ${String(i)}`, staffCode: `EMP-JR${String(i)}`, passwordHash: "x" });
      await db.insert(roleAssignments).values({ id: `RA-${id}`, userId: id, roleKey: "doctor", scopeType: "hospital", scopeId: null });
    }
    await db.insert(rosterTeams).values([
      { id: TEAM, departmentId: MED, code: "MED-U2", name: "Medicine Unit II", kind: "clinical_unit", createdBy: "t", updatedBy: "t" },
    ]);
    for (const userId of JRS) {
      await withTx(db, (tx) => addMembership(tx, ms, {
        teamId: TEAM, userId, positionKey: "ward_jr", grade: "jr2",
        roleInTeam: "junior_resident", kind: "parent", startsAt: at("2026-01-01T00:00"),
      }));
    }
    await seedRosterRules(db, "t");
  });

  /** The night of 5 Oct and, the next morning, a day slot held by somebody else. */
  const nightAndNextMorning = (m: UnitMonth) => {
    const night = m.assignments.find((a) => a.night && a.istDate === "2026-10-05" && a.userId !== null)!;
    const morning = m.assignments.find((a) => !a.night && a.istDate === "2026-10-06" && a.userId !== null && a.userId !== night.userId)!;
    expect(night).toBeDefined();
    expect(morning).toBeDefined();
    return { night, morning };
  };

  it("the month carries the unit's own days, declared holidays, approved leave and posting dates — and no leave reason", async () => {
    // A two-day cycle for this unit: day 0 is OPD and take, day 1 is theatre.
    const cycleId = newId();
    await db.insert(rosterCycles).values({ id: cycleId, departmentId: MED, cycleDays: 2, anchorIstDate: "2026-10-01", version: 1, createdBy: "t", updatedBy: "t" });
    await db.insert(rosterCycleEntries).values([
      { id: newId(), cycleId, dayIndex: 0, teamId: TEAM, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
      { id: newId(), cycleId, dayIndex: 0, teamId: TEAM, activity: "opd" as const, startMinute: 540, durationMinutes: 240, createdBy: "t", updatedBy: "t" },
      { id: newId(), cycleId, dayIndex: 1, teamId: TEAM, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
      { id: newId(), cycleId, dayIndex: 1, teamId: TEAM, activity: "elective_ot" as const, startMinute: 540, durationMinutes: 480, createdBy: "t", updatedBy: "t" },
    ]);
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, "2026-10-01"));
    await withTx(db, (tx) => declareHoliday(tx, ms, { istDate: "2026-10-20", kind: "gazetted", pattern: "opd_off_ot_proceeds" }));
    await withTx(db, (tx) => recordAbsence(tx, ms, {
      userId: JRS[0]!, kind: "CL", startsAt: at("2026-10-14T00:00"), endsAt: at("2026-10-17T00:00"), reason: "family wedding",
    }));
    const INTERN = "01USERINTERN0000000000001";
    const LEAVER = "01USERLEAVER0000000000001";
    await db.insert(users).values([
      { id: INTERN, username: "intern", fullName: "Dr. Ritu Singh", staffCode: "EMP-IN1", passwordHash: "x" },
      { id: LEAVER, username: "leaver", fullName: "Dr. Farhan Ali", staffCode: "EMP-LV1", passwordHash: "x" },
    ]);
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: TEAM, userId: INTERN, positionKey: "intern", grade: "intern", roleInTeam: "intern", kind: "parent", startsAt: at("2026-10-16T00:00"),
    }));
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: TEAM, userId: LEAVER, positionKey: "intern", grade: "intern", roleInTeam: "intern", kind: "parent",
      startsAt: at("2026-09-01T00:00"), endsAt: at("2026-10-16T00:00"),
    }));

    const m = await unitMonth(db, ms, TEAM, "2026-10");
    expect(m.unitDays).toHaveLength(31);
    expect(m.unitDays[0]).toEqual({ istDate: "2026-10-01", activities: ["opd"], take: true, overlay: false });
    expect(m.unitDays[1]).toEqual({ istDate: "2026-10-02", activities: ["elective_ot"], take: true, overlay: false });
    expect(m.holidays).toEqual([{ istDate: "2026-10-20", kind: "gazetted", pattern: "opd_off_ot_proceeds" }]);
    expect(m.leave).toEqual([{ userId: JRS[0], kind: "CL", from: "2026-10-14", to: "2026-10-16" }]);
    expect(JSON.stringify(m.leave)).not.toContain("wedding");
    const ritu = m.people.find((p) => p.userId === INTERN);
    const farhan = m.people.find((p) => p.userId === LEAVER);
    expect(ritu).toMatchObject({ grade: "intern", postedFrom: "2026-10-16", postedTo: null });
    expect(farhan).toMatchObject({ grade: "intern", postedFrom: null, postedTo: "2026-10-15" });
    expect(m.people.find((p) => p.userId === JRS[1])).toMatchObject({ postedFrom: null, postedTo: null });
  });

  it("an IST month is 1st 00:00 IST to the next 1st, with one column per day", () => {
    const w = monthWindow("2026-10");
    expect(w.startsAt.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(w.days).toHaveLength(31);
    expect(w.days[0]).toBe("2026-10-01");
    expect(() => monthWindow("2026-13")).toThrow(RosterError);
  });

  it("the units a person can open: departments that run units, each with its units — an unconfirmed unit flagged, not hidden", async () => {
    const list = await rosterUnits(db);
    expect(list).toEqual([{ departmentId: MED, code: "MED", name: "General Medicine", units: [{ teamId: TEAM, code: "MED-U2", name: "Medicine Unit II", confirmed: false }] }]);
  });

  it("an undrafted month says so, and says who may draft it", async () => {
    const m = await unitMonth(db, ms, TEAM, "2026-10");
    expect(m.period).toBeNull();
    expect(m.days).toHaveLength(31);
    expect(m.people.map((p) => p.name)).toEqual(["Dr. Resident 0", "Dr. Resident 1", "Dr. Resident 2", "Dr. Resident 3"]);
    expect(m.youMay).toEqual({ draft: true, edit: false, acceptWarning: true, publish: false });
    expect((await unitMonth(db, doc, TEAM, "2026-10")).youMay).toEqual({ draft: false, edit: false, acceptWarning: false, publish: false });
  });

  it("the proposer drafts the month once — a second ask returns the same draft", async () => {
    const m = await draftUnitMonth(db, ms, TEAM, "2026-10");
    expect(m.period).toMatchObject({ status: "draft", origin: "machine", version: 1 });
    expect(m.assignments.filter((a) => a.night)).toHaveLength(31);
    expect(m.assignments.every((a) => a.userId === null || a.name?.startsWith("Dr. Resident"))).toBe(true);
    expect(m.counts.blocking).toBe(0);
    expect(m.fairness.reduce((n, f) => n + f.nights, 0)).toBe(31);
    expect(m.youMay).toEqual({ draft: false, edit: true, acceptWarning: true, publish: true });
    expect(m.period!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await draftUnitMonth(db, ms, TEAM, "2026-10");
    expect(again.period!.periodId).toBe(m.period!.periodId);
  });

  it("a reader without the grant cannot draft, edit or publish", async () => {
    await expect(draftUnitMonth(db, doc, TEAM, "2026-10")).rejects.toMatchObject({ code: "not_permitted" });
    const m = await draftUnitMonth(db, ms, TEAM, "2026-10");
    const { morning } = nightAndNextMorning(m);
    await expect(editSlot(db, doc, morning.assignmentId, null)).rejects.toMatchObject({ code: "not_permitted" });
    await expect(publishUnitMonth(db, doc, m.period!.periodId, m.period!.contentHash)).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("a blocking finding names the person and the day, stops the publish, and the one-tap fix clears it", async () => {
    const m = await draftUnitMonth(db, ms, TEAM, "2026-10");
    const { night, morning } = nightAndNextMorning(m);

    // The night's JR put on the next morning's list — one hour after a 12-hour night.
    const ref = await editSlot(db, ms, morning.assignmentId, night.userId);
    const bad = await unitMonth(db, ms, ref.teamId, ref.month);
    const stop = bad.findings.filter((f) => f.blocking);
    expect(stop.map((f) => [f.ruleKey, f.name, f.istDate])).toEqual([["rest_after_duty", night.name, "2026-10-06"]]);
    expect(bad.counts.blocking).toBe(1);

    await expect(publishUnitMonth(db, ms, bad.period!.periodId, bad.period!.contentHash))
      .rejects.toMatchObject({ code: "blocked_by_findings" });

    // The fix: leave that morning slot vacant (a hole is an honest answer).
    await editSlot(db, ms, stop[0]!.assignmentId!, null);
    const fixed = await unitMonth(db, ms, TEAM, "2026-10");
    expect(fixed.counts.blocking).toBe(0);
    expect(fixed.assignments.filter((a) => a.userId === null && a.istDate === "2026-10-06")).toHaveLength(1);

    const published = await publishUnitMonth(db, ms, fixed.period!.periodId, fixed.period!.contentHash);
    const after = await unitMonth(db, ms, published.teamId, published.month);
    expect(after.period).toMatchObject({ status: "published", version: 1 });
    expect(after.youMay).toEqual({ draft: false, edit: false, acceptWarning: true, publish: false });
  });

  it("a stale review is refused: the hash the screen showed must be the draft's", async () => {
    const m = await draftUnitMonth(db, ms, TEAM, "2026-10");
    const { morning } = nightAndNextMorning(m);
    await editSlot(db, ms, morning.assignmentId, null);
    await expect(publishUnitMonth(db, ms, m.period!.periodId, m.period!.contentHash))
      .rejects.toMatchObject({ code: "draft_changed_since_review" });
  });

  it("a warning is accepted with a reason by a holder of accept_warning, and only by one", async () => {
    const m = await draftUnitMonth(db, ms, TEAM, "2026-10");
    const warn = m.findings.find((f) => f.severity === "warn" && f.accepted === null);
    expect(warn).toBeDefined();
    const key = { ruleKey: warn!.ruleKey, assignmentId: warn!.assignmentId, userId: warn!.userId };

    await expect(acceptUnitFinding(db, doc, m.period!.periodId, key, "the unit is short this month"))
      .rejects.toMatchObject({ code: "not_permitted" });

    await acceptUnitFinding(db, ms, m.period!.periodId, key, "the unit is short this month");
    const after = await unitMonth(db, ms, TEAM, "2026-10");
    const same = after.findings.find((f) => f.ruleKey === key.ruleKey && f.assignmentId === key.assignmentId && f.userId === key.userId);
    expect(same?.accepted).toMatchObject({ byName: "Dr. Sunita Mishra", reason: "the unit is short this month" });
  });
});
