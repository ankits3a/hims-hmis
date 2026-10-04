import { setupTestDb, truncateAll } from "./helpers/db";
import { assertRosterDemoAllowed, seedRosterDemo } from "../scripts/seed-roster-demo";
import {
  opdDepartments, opdDoctors, orgDepartments, permissions, roleAssignments, rolePermissions, roles,
  rosterPeriods, rosterTeamMemberships, users,
} from "../src/kernel/db/schema";
import {
  ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, onNowBoard, seedOrgDepartments, seedRosterPositions,
  seedRosterRules, seedUnits,
} from "../src/modules/roster";
import type { Db } from "../src/kernel/db/client";

/**
 * 20-U U5a — the opt-in demo roster that lets the owner SEE the "who is on now" board on staging.
 *
 * What matters is not that rows exist but that the board, read through `onNowBoard`, shows a
 * believable hospital: a unit on take, a named person in the building, a faculty member on call, a
 * hospital-wide duty manager — and one honest hole. And that it got there through the publish gate
 * with the rule book SEEDED, so the validator actually judged it.
 */
describe("seed:roster-demo — a demo roster for the on-now board", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  /** A Sunday afternoon — the moment the owner looks. */
  const NOW = ist("2026-10-04T15:40");
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };
  const by = { createdBy: "t", updatedBy: "t" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values(["doctor", "medical_superintendent", "duty_manager", "pharmacy", "admin", "owner", "radiologist", "pathologist", "anaesthetist"]
      .map((key) => ({ key, title: key })));
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ]
      .map((permission) => ({ roleKey: "medical_superintendent", permission })));
    await db.insert(opdDepartments).values(["MED", "SUR", "ENT"].map((code) => ({ id: `OPD-${code}`, code, name: code, ...by })));

    const people: [string, string, string[], string | null][] = [
      ["admin", "Administrator", ["admin", "owner", "medical_superintendent", "duty_manager"], null],
      ["anand.rao", "Dr. Anand Rao", ["doctor", "medical_superintendent"], "MED"],
      ["ritu.singh", "Dr. Ritu Singh", ["doctor"], "MED"],
      ["sanjay.prasad", "Dr. Sanjay Prasad", ["doctor"], "MED"],
      ["kavya.shekhar", "Dr. Kavya Shekhar", ["doctor"], "SUR"],
      ["rakesh.mahto", "Dr. Rakesh Mahto", ["doctor"], "SUR"],
      ["shalini.pandey", "Dr. Shalini Pandey", ["doctor"], "ENT"],
      ["vivek.thakur", "Dr. Vivek Thakur", ["doctor"], "ENT"],
      ["manoj.bhat", "Manoj Bhat", ["duty_manager"], null],
      ["abhay.kumar", "Abhay Kumar", ["pharmacy"], null],
      ["kavita.joshi", "Kavita Joshi", ["pharmacy"], null],
    ];
    for (const [username, fullName, roleKeys, opd] of people) {
      const id = `U-${username}`;
      await db.insert(users).values({ id, username, fullName, staffCode: `EMP-${username}`, passwordHash: "x" });
      await db.insert(roleAssignments).values(roleKeys.map((roleKey) => ({ id: `RA-${username}-${roleKey}`, userId: id, roleKey, scopeType: "hospital", scopeId: null })));
      if (opd !== null) {
        await db.insert(opdDoctors).values({ id: `D-${username}`, userId: id, displayName: fullName, code: `DR-${username}`, departmentId: `OPD-${opd}`, ...by });
      }
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await seedRosterRules(db);
  });

  it("refuses without both doors", () => {
    expect(() => assertRosterDemoAllowed({ ALLOW_DEMO_DATA: "yes" }, "hmis")).toThrow(/HMIS_SYNTHETIC_DATA_OK/);
    expect(() => assertRosterDemoAllowed({ HMIS_SYNTHETIC_DATA_OK: "1" }, "hmis")).toThrow(/ALLOW_DEMO_DATA=yes/);
    expect(() => assertRosterDemoAllowed({ HMIS_SYNTHETIC_DATA_OK: "1", ALLOW_DEMO_DATA: "yes" }, "hmis")).not.toThrow();
  });

  it("publishes through the gate and the board shows a unit on take, people, faculty, services and one hole", async () => {
    const report = await seedRosterDemo(db, NOW);
    expect(report.actor).toBe("U-anand.rao");
    expect(report.periodsPublished.sort()).toEqual(["ENT", "MED", "SUR", "hospital services"]);
    expect(report.cyclesPublished.map((c) => c.slice(0, 3)).sort()).toEqual(["ENT", "MED", "SUR"]);

    const depts = await db.select().from(orgDepartments);
    const id = (code: string): string => depts.find((d) => d.code === code)!.id;
    const board = await onNowBoard(db, NOW, ON);
    const row = (code: string) => board.departments.find((d) => d.departmentId === id(code))!;

    const med = row("MED");
    expect(med.source).toBe("published");
    expect(med.unitOnTake).not.toBeNull();
    // 20-U U5 DECIDED — the gallery's patterns name yesterday's take unit as today's backup.
    expect(med.backupUnit).not.toBeNull();
    expect(med.backupUnit!.teamId).not.toBe(med.unitOnTake!.teamId);
    expect(med.inTheBuilding.map((p) => [p.positionKey, p.name])).toEqual([["unit_sr", "Dr. Ritu Singh"]]);
    expect(med.facultyOnCall.map((r) => r.name)).toEqual(["Dr. Anand Rao"]);
    // At night the JR is the one in the building.
    const night = (await onNowBoard(db, ist("2026-10-04T23:00"), ON)).departments.find((d) => d.departmentId === id("MED"))!;
    expect(night.inTheBuilding.map((p) => p.name)).toEqual(["Dr. Sanjay Prasad"]);

    expect(row("ENT")).toMatchObject({ source: "published", inTheBuilding: [{ name: "Dr. Vivek Thakur" }] });
    // A department with no doctor is honestly unpublished, and its missing cycle is a hole.
    expect(row("PED").source).not.toBe("published");
    expect(board.holes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "no_take_cycle", departmentId: id("PED") }),
      expect.objectContaining({ kind: "vacant_slot", departmentId: id("SUR"), positionKey: "unit_sr", from: ist("2026-10-04T20:00") }),
    ]));
    // The deliberate hole is the ONLY vacant slot, and no published department has a take gap.
    expect(board.holes.filter((h) => h.kind === "vacant_slot")).toHaveLength(1);
    expect(board.holes.filter((h) => h.kind === "take_gap")).toEqual([]);

    const dm = board.services.find((s) => s.positionKey === "duty_manager")!;
    expect(dm).toMatchObject({ source: "published", people: [{ name: "Manoj Bhat", departmentId: id("ADMN") }] });
    const ph = board.services.find((s) => s.positionKey === "pharmacist_counter")!;
    expect(ph.people.map((p) => p.name)).toEqual(["Abhay Kumar"]);
  });

  it("is idempotent: a second run publishes nothing and duplicates nothing", async () => {
    await seedRosterDemo(db, NOW);
    const periods = (await db.select().from(rosterPeriods)).length;
    const memberships = (await db.select().from(rosterTeamMemberships)).length;
    const again = await seedRosterDemo(db, NOW);
    expect(again).toMatchObject({ unitsConfirmed: 0, membershipsAdded: 0, cyclesPublished: [], periodsPublished: [], slotsAssigned: 0 });
    expect((await db.select().from(rosterPeriods)).length).toBe(periods);
    expect((await db.select().from(rosterTeamMemberships)).length).toBe(memberships);
  });
});
