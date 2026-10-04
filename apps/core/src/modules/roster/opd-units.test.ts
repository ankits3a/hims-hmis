import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, orgDepartments, permissions, roleAssignments, rolePermissions, roles,
  rosterCycleEntries, rosterCycles, rosterTeamMemberships, users,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { declareHoliday, publishCycle } from "./calendar";
import { opdUnitsOn } from "./index";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 20-U U7 — **OPD READS THE UNIT CALENDAR, READ-ONLY.** General Medicine runs two units on a two-day
 * cycle: Unit I holds the OPD on the anchor Monday, Unit II on the Tuesday. The front desk is told
 * which unit, and its head, faculty and senior resident by name — never its juniors; a department
 * with no units (Paediatrics here) is absent, not "Unit —"; and a declared holiday that closes the
 * OPD withdraws the answer with the window.
 */
describe("roster — which unit holds the OPD (20-U U7)", () => {
  const MS = "01USER00000000000000000MS";
  const ms: Actor = { type: "user", id: MS };
  const MON = "2026-10-05";
  const TUE = "2026-10-06";
  const PEOPLE = {
    HEAD: ["01USER0000000000000000HEAD", "Dr. Rakesh Verma"],
    FAC: ["01USER00000000000000000FAC", "Dr. Anita Sharma"],
    SR: ["01USER000000000000000000SR", "Dr. Meena Joshi"],
    JR: ["01USER000000000000000000JR", "Dr. Aman Gupta"],
  } as const;

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;
  let CLINIC: string;
  let U1: string;
  let U2: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" }, { key: "medical_superintendent", title: "Medical Superintendent" },
      ...["duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"].map((key) => ({ key, title: key })),
    ]);
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })));
    await db.insert(users).values({ id: MS, username: "ms", fullName: "Dr. Sunita Mishra", staffCode: "EMP-MS", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    for (const [id, fullName] of Object.values(PEOPLE)) {
      await db.insert(users).values({ id, username: id.toLowerCase(), fullName, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    // The clinics exist BEFORE the departments are seeded, so the seed links General Medicine to its OPD.
    CLINIC = newId();
    await db.insert(opdDepartments).values([
      { id: CLINIC, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" },
      { id: newId(), code: "PED", name: "Paediatrics", createdBy: "t", updatedBy: "t" },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    U1 = (await teamByCode(db, "MED-U1"))!.id;
    U2 = (await teamByCode(db, "MED-U2"))!.id;

    const since = new Date("2026-01-01T00:00:00+05:30");
    const post = (userId: string, teamId: string, positionKey: string, grade: string, roleInTeam: string) => ({
      id: newId(), teamId, userId, positionKey, grade, roleInTeam, kind: "parent", startsAt: since, createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterTeamMemberships).values([
      post(PEOPLE.JR[0], U2, "ward_jr", "jr1", "junior_resident"),
      post(PEOPLE.SR[0], U2, "unit_sr", "senior_resident", "senior_resident"),
      post(PEOPLE.FAC[0], U2, "faculty_on_call", "assistant_professor", "faculty"),
      post(PEOPLE.HEAD[0], U2, "unit_head", "professor", "head"),
    ]);

    // Two-day cycle: Unit I on day 0 (Monday), Unit II on day 1. Take 08:00→08:00; OPD 09:00–13:00.
    const cycleId = newId();
    await db.insert(rosterCycles).values({ id: cycleId, departmentId: MED, cycleDays: 2, anchorIstDate: MON, version: 1, createdBy: "t", updatedBy: "t" });
    await db.insert(rosterCycleEntries).values([U1, U2].flatMap((teamId, dayIndex) => [
      { id: newId(), cycleId, dayIndex, teamId, activity: "take" as const, startMinute: 480, durationMinutes: 1440, createdBy: "t", updatedBy: "t" },
      { id: newId(), cycleId, dayIndex, teamId, activity: "opd" as const, startMinute: 540, durationMinutes: 240, createdBy: "t", updatedBy: "t" },
    ]));
    await withTx(db, (tx) => publishCycle(tx, ms, cycleId, MON));
  });

  it("names the unit holding the day's OPD, and its head, faculty and SR — not its juniors", async () => {
    const tue = await opdUnitsOn(db, TUE);
    expect(tue).toHaveLength(1);
    expect(tue[0]).toMatchObject({ opdDepartmentId: CLINIC, departmentId: MED });
    expect(tue[0]!.units.map((u) => [u.code, u.short])).toEqual([["MED-U2", "Unit II"]]);
    expect(tue[0]!.units[0]!.startsAt.toISOString()).toBe(new Date(`${TUE}T09:00:00+05:30`).toISOString());
    expect(tue[0]!.units[0]!.doctors.map((d) => [d.name, d.role])).toEqual([
      ["Dr. Rakesh Verma", "head"], ["Dr. Anita Sharma", "faculty"], ["Dr. Meena Joshi", "senior_resident"],
    ]);
    // Monday is Unit I's — nobody is posted to it, so the unit is named and no doctor is invented.
    const mon = await opdUnitsOn(db, MON);
    expect(mon[0]!.units.map((u) => u.short)).toEqual(["Unit I"]);
    expect(mon[0]!.units[0]!.doctors).toEqual([]);
  });

  it("a department that runs no units is absent — Paediatrics is never answered with an empty unit", async () => {
    const tue = await opdUnitsOn(db, TUE);
    const ped = (await db.select().from(opdDepartments)).find((d) => d.code === "PED")!.id;
    expect(tue.map((x) => x.opdDepartmentId)).not.toContain(ped);
  });

  it("a holiday that closes the OPD withdraws the answer with the window", async () => {
    await withTx(db, (tx) => declareHoliday(tx, ms, { istDate: TUE, kind: "declared", pattern: "opd_off_ot_proceeds" }));
    expect(await opdUnitsOn(db, TUE)).toEqual([]);
  });
});
