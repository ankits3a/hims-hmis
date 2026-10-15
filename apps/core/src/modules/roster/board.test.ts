import { eq } from "drizzle-orm";
import { confirmSeededUnits } from "../../../test/helpers/units";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterCycleEntries, rosterCycles, users,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { recordAbsence } from "./absences";
import { assign, draftPeriod, publishPeriod } from "./periods";
import { publishCycle } from "./calendar";
import { onNowBoard } from "./board";
import { staffToday } from "./staff-today";
import { rosterAssignments, rosterCoverRequests, staffAbsences } from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 20-U U5a — **WHO IS ON NOW**, the hospital's unit board, as one composing read.
 *
 * The leg to read first is **"an unpublished department says so"**: an empty published department
 * and an unpublished one render identically unless the read carries `source`, and they mean
 * opposite things. The second is **02:40**: the take runs 08:00 to 08:00, so at 02:40 on Tuesday
 * it is still Monday's unit, and the window it reports ends at 08:00 that morning.
 */
describe("roster — who is on now (20-U U5a)", () => {
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000SRMED";
  const JR = "01USER00000000000000JRMED";
  const JR2 = "01USER0000000000000JR2MED";
  const FAC = "01USER00000000000000FACMD";
  const DM = "01USER000000000000000DMGR";
  const ms: Actor = { type: "user", id: MS };
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let SUR: string;
  let ADMN: string;
  let units: string[];

  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  /** A Monday. Day 0 of Medicine's cycle is Unit I's take: [Mon 08:00, Tue 08:00). */
  const ANCHOR = "2026-10-05";
  const OCT = { startsAt: ist("2026-10-01T00:00"), endsAt: ist("2026-11-01T00:00") };
  const MON_NIGHT = { startsAt: ist("2026-10-05T20:00"), endsAt: ist("2026-10-06T08:00") };
  const TUE_NIGHT = { startsAt: ist("2026-10-06T20:00"), endsAt: ist("2026-10-07T08:00") };
  /** The board's headline instant: past midnight, before the handover. */
  const T0240 = ist("2026-10-06T02:40");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "duty_manager", title: "Duty manager" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "radiologist", title: "Radiologist" }, { key: "pathologist", title: "Pathologist" },
      { key: "anaesthetist", title: "Anaesthetist" }, { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    for (const [id, fullName] of [
      [MS, "Dr. Sunita Mishra"], [SR, "Dr. Aditi Deshmukh"], [JR, "Dr. Yusuf Qureshi"],
      [JR2, "Dr. Tanvi Shah"], [FAC, "Dr. S. P. Tripathi"], [DM, "Mr. Alok Srivastava"],
    ] as const) {
      await db.insert(users).values({ id, username: id.toLowerCase(), fullName, staffCode: `EMP-${id.slice(-5)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      ...[SR, JR, JR2, FAC].map((userId, i) => ({ id: `RA-D${String(i)}`, userId, roleKey: "doctor", scopeType: "hospital", scopeId: null })),
      { id: "RA-DM", userId: DM, roleKey: "duty_manager", scopeType: "hospital", scopeId: null },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await confirmSeededUnits(db); // only a confirmed unit counts (owner 2026-10-04)
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;
    SUR = depts.find((d) => d.code === "SUR")!.id;
    ADMN = depts.find((d) => d.code === "ADMN")!.id;
    units = [];
    for (let i = 1; i <= 5; i += 1) units.push((await teamByCode(db, `MED-U${String(i)}`))!.id);
  });

  /** Medicine's five-day cycle: one unit takes 08:00–08:00, yesterday's unit backs it up. */
  const publishMedicineCycle = async (): Promise<void> => {
    const cycleId = newId();
    await db.insert(rosterCycles).values({
      id: cycleId, departmentId: MED, cycleDays: 5, anchorIstDate: ANCHOR, version: 1, createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterCycleEntries).values(units.flatMap((teamId, dayIndex) => [
      { id: newId(), cycleId, dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
      { id: newId(), cycleId, dayIndex, teamId: units[(dayIndex + 4) % 5]!, activity: "backup" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
    ]));
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, ANCHOR));
  };

  const publish = async (
    over: { scopeType: "department" | "hospital"; departmentId: string | null; covers: string[] },
    slots: Parameters<typeof assign>[3][],
  ): Promise<void> => {
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: over.scopeType, scopeId: over.departmentId, departmentId: over.departmentId, teamId: null,
      title: "October", coversPositions: over.covers, ...OCT,
    }));
    for (const slot of slots) await withTx(db, (tx) => assign(tx, ms, periodId, slot));
    await withTx(db, (tx) => publishPeriod(tx, ms, periodId));
  };

  const publishMedicineOctober = async (): Promise<void> => publish(
    { scopeType: "department", departmentId: MED, covers: ["unit_sr", "ward_jr", "faculty_on_call"] },
    [
      { userId: SR, positionKey: "unit_sr", departmentId: MED, ...MON_NIGHT },
      { userId: JR, positionKey: "ward_jr", departmentId: MED, ...MON_NIGHT },
      { userId: JR2, positionKey: "ward_jr", departmentId: MED, ...MON_NIGHT },
      { userId: FAC, positionKey: "faculty_on_call", departmentId: MED, mode: "call", callTier: 1, ...MON_NIGHT },
      // Tuesday night's SR is not yet named: a hole inside the next 24 hours.
      { userId: null, positionKey: "unit_sr", departmentId: MED, ...TUE_NIGHT },
    ],
  );

  const row = (board: Awaited<ReturnType<typeof onNowBoard>>, departmentId: string) => {
    const r = board.departments.find((d) => d.departmentId === departmentId);
    if (r === undefined) throw new Error(`no board row for ${departmentId}`);
    return r;
  };

  it("a published department shows its unit on take, the people in the building and the faculty on call", async () => {
    await publishMedicineCycle();
    await publishMedicineOctober();
    const board = await onNowBoard(db, T0240, ON);
    const med = row(board, MED);
    expect(med.source).toBe("published");
    expect(med.code).toBe("MED");
    expect(med.units).toBe(5);
    expect(med.inTheBuilding.map((p) => [p.cadre, p.name])).toEqual([
      ["senior_resident", "Dr. Aditi Deshmukh"],
      ["junior_resident", "Dr. Tanvi Shah"],
      ["junior_resident", "Dr. Yusuf Qureshi"],
    ]);
    expect(med.facultyOnCall).toEqual([{
      userId: FAC, name: "Dr. S. P. Tripathi", positionKey: "faculty_on_call", positionLabel: "Faculty on call", callTier: 1,
    }]);
    // The faculty member is on CALL, not in the building — a separate column.
    expect(med.inTheBuilding.map((p) => p.userId)).not.toContain(FAC);
  });

  it("D6 — a phone number is on the board for a person in the building now, and for nobody else", async () => {
    await db.update(users).set({ phone: "9876543210" }).where(eq(users.id, SR));
    await db.update(users).set({ phone: "9811111111" }).where(eq(users.id, FAC));
    await db.update(users).set({ phone: "9822222222" }).where(eq(users.id, DM));
    await publishMedicineCycle();
    await publishMedicineOctober();
    const board = await onNowBoard(db, T0240, ON);
    const med = row(board, MED);
    expect(med.inTheBuilding.map((p) => [p.name, p.phone])).toEqual([
      ["Dr. Aditi Deshmukh", "9876543210"], ["Dr. Tanvi Shah", null], ["Dr. Yusuf Qureshi", null],
    ]);
    // Not the faculty column, not the services: the board draws a call button only beside the building.
    expect(JSON.stringify(board)).not.toContain("9811111111");
    expect(JSON.stringify(board)).not.toContain("9822222222");
    // Nor once the duty has ended: at 10:00 the SR is off and her number is gone with her.
    expect(JSON.stringify(await onNowBoard(db, new Date(T0240.getTime() + 8 * 3_600_000), ON))).not.toContain("9876543210");
  });

  it("02:40 belongs to the PREVIOUS day's take — Monday's unit, till 08:00 Tuesday", async () => {
    await publishMedicineCycle();
    const med = row(await onNowBoard(db, T0240, ON), MED);
    expect(med.unitOnTake).toMatchObject({ teamId: units[0], code: "MED-U1" });
    expect(med.unitOnTake?.endsAt.toISOString()).toBe(ist("2026-10-06T08:00").toISOString());
    expect(med.backupUnit).toMatchObject({ teamId: units[4], code: "MED-U5" });
    // 08:00 exactly: Tuesday's unit, and its window runs to Wednesday 08:00.
    const after = row(await onNowBoard(db, ist("2026-10-06T08:00"), ON), MED);
    expect(after.unitOnTake).toMatchObject({ teamId: units[1], code: "MED-U2" });
    expect(after.unitOnTake?.endsAt.toISOString()).toBe(ist("2026-10-07T08:00").toISOString());
  });

  it("an UNPUBLISHED department says so — never an empty row that looks staffed", async () => {
    await publishMedicineOctober();
    // A hospital-wide roster (the duty manager's) is live. It must NOT make Surgery read as published.
    await publish(
      { scopeType: "hospital", departmentId: null, covers: ["duty_manager"] },
      [{ userId: DM, positionKey: "duty_manager", departmentId: ADMN, coverScope: "hospital", ...MON_NIGHT }],
    );
    const board = await onNowBoard(db, T0240, ON);
    const sur = row(board, SUR);
    expect(sur.source).not.toBe("published");
    expect(sur.inTheBuilding).toEqual([]);
    expect(sur.facultyOnCall).toEqual([]);
    expect(sur.unitOnTake).toBeNull();
    // ...and Surgery's missing take cycle is a hole.
    expect(board.holes.some((h) => h.kind === "no_take_cycle" && h.departmentId === SUR)).toBe(true);
    // The duty manager is a hospital-wide service, not a unit row.
    const dm = board.services.find((s) => s.positionKey === "duty_manager");
    expect(dm).toMatchObject({ source: "published", people: [{ userId: DM, name: "Mr. Alok Srivastava", departmentId: ADMN }] });
    expect(row(board, MED).inTheBuilding.map((p) => p.userId)).not.toContain(DM);
  });

  it("with the resolver flag OFF every department is unpublished, and nobody is listed from RBAC", async () => {
    await publishMedicineCycle();
    await publishMedicineOctober();
    const board = await onNowBoard(db, T0240, {});
    const med = row(board, MED);
    expect(board.resolverEnabled).toBe(false);
    expect(med.source).toBe("static");
    expect(med.inTheBuilding).toEqual([]);
    // The calendar still answers: which unit is on take does not depend on the resolver flag.
    expect(med.unitOnTake).toMatchObject({ teamId: units[0] });
    expect(board.services.every((s) => s.source !== "published" && s.people.length === 0)).toBe(true);
  });

  it("an absent person is subtracted from the building, and named as a hole", async () => {
    await publishMedicineCycle();
    await publishMedicineOctober();
    await withTx(db, (tx) => recordAbsence(tx, ms, {
      userId: JR2, kind: "ML", startsAt: ist("2026-10-05T18:00"), endsAt: ist("2026-10-07T00:00"),
    }));
    const board = await onNowBoard(db, T0240, ON);
    expect(row(board, MED).inTheBuilding.map((p) => p.userId)).toEqual([SR, JR]);
    expect(board.holes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "absent_on_duty", departmentId: MED, userId: JR2, name: "Dr. Tanvi Shah", positionKey: "ward_jr" }),
      expect.objectContaining({ kind: "vacant_slot", departmentId: MED, userId: null, positionKey: "unit_sr", from: TUE_NIGHT.startsAt }),
    ]));
    // Medicine's take is continuous, so it has no take hole.
    expect(board.holes.filter((h) => h.departmentId === MED && (h.kind === "take_gap" || h.kind === "no_take_cycle"))).toEqual([]);
  });

  /**
   * THE OWNER'S STAFF PAGE (owner 2026-10-09) — composed from the board above, so the two cannot
   * disagree. No attendance: an approved leave is named (name only), a hole is a hole, and what is
   * waiting is counted. Kind and reason never leave (D6).
   */
  it("staff today: who the board names, who is on approved leave, the gaps, and what waits — no kind, no reason", async () => {
    await publishMedicineCycle();
    await publishMedicineOctober();
    const calm = await staffToday(db, ms, T0240, ON);
    const board = await onNowBoard(db, T0240, ON);
    expect(calm.day).toBe("2026-10-06");
    expect(calm.onDuty).toBe(4); // SR, two JRs in the building and the faculty member on call
    expect(calm.onLeave).toEqual([]);
    expect(calm.waiting).toEqual({ cover: 0, coverLines: [], leave: 0 });
    expect(calm.gaps.length).toBe(board.holes.filter((h) => h.to.getTime() > T0240.getTime()).length);
    expect(calm.gaps).toEqual(expect.arrayContaining([{ department: "General Medicine", from: TUE_NIGHT.startsAt.toISOString(), what: expect.any(String) }]));

    await withTx(db, (tx) => recordAbsence(tx, ms, {
      userId: JR2, kind: "ML", reason: "fever", startsAt: ist("2026-10-05T18:00"), endsAt: ist("2026-10-07T00:00"),
    }));
    await db.insert(staffAbsences).values({
      id: newId(), userId: JR, kind: "CL", status: "requested", requestedBy: JR, reason: "family function",
      startsAt: ist("2026-10-06T00:00"), endsAt: ist("2026-10-08T00:00"), createdBy: JR, updatedBy: JR,
    });
    const duty = (await db.select().from(rosterAssignments).where(eq(rosterAssignments.userId, SR)))[0]!;
    await db.insert(rosterCoverRequests).values({
      id: newId(), kind: "cover", status: "asked", assignmentId: duty.id, periodId: duty.periodId, ownerId: SR, requestedBy: SR,
      counterpartId: JR, departmentId: MED, createdBy: SR, updatedBy: SR,
    });
    const day = await staffToday(db, ms, T0240, ON);
    expect(day.onDuty).toBe(3);
    expect(day.onLeave).toEqual([{ userId: JR2, name: "Dr. Tanvi Shah" }]);
    expect(day.waiting).toEqual({ cover: 1, coverLines: [{ department: "General Medicine", day: "2026-10-05" }], leave: 1 });
    expect(JSON.stringify(day)).not.toMatch(/fever|family function|"ML"|"CL"|kind/);
    /* A requested leave is not a leave: the person is still on the board and not on the list. */
    expect(day.onLeave.map((p) => p.userId)).not.toContain(JR);
  });
});
