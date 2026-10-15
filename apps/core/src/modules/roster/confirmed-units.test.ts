import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MS_USER, linkCommunityMedicineClinic, seedCrkmchDoctors } from "../../../test/fixtures/crkmch-doctors";
import { withTx } from "../../kernel/db/client";
import { orgDepartments, rosterTeams } from "../../kernel/db/schema";
import { seedRoster } from "../../../scripts/seed-roster";
import {
  addMembership, boardAsItStood, cycleTemplate, declarationsView, departmentsWithoutPublishedCycle, draftCycleFromTemplate,
  onNowBoard, opdUnitsOn, publishCycle, rosterUnits, teamByCode,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 2026-10-04 (owner) — **ONLY A CONFIRMED UNIT COUNTS.** *"We only have 1 unit per department right
 * now … some departments do not even have any single doctor so we don't have units there."*
 *
 * The hospital's OPD doctor list, as fixture doctors. `seed:roster` seeds the 27-unit establishment
 * inactive; here only General Medicine Unit I is confirmed (Dr Chandan in-charge, Dr Yash Vardhan its
 * SR) and holds the OPD every day. Paediatrics — guest faculty only — has a cycle published on its
 * UNCONFIRMED Unit I (the gallery lets a head do that), which is exactly the trap: no reader may
 * present it as a unit-running department, raise its missing cycle as a hole, or tell the front desk
 * a Paediatrics unit holds the OPD.
 */
describe("roster — only confirmed units count (owner 2026-10-04)", () => {
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const MON = "2026-10-05";
  const THU = "2026-10-08";
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };
  const ms: Actor = { type: "user", id: MS_USER };
  let db: Db;
  let teardown: () => Promise<void>;
  let userOf: Map<number, string>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    ({ userOf } = await seedCrkmchDoctors(db));
    await seedRoster(db);
    await linkCommunityMedicineClinic(db);
    const med = (await teamByCode(db, "MED-U1"))!;
    const ped = (await teamByCode(db, "PED-U1"))!;
    const deptId = async (code: string): Promise<string> => (await db.select().from(orgDepartments).where(eq(orgDepartments.code, code)))[0]!.id;
    await db.update(rosterTeams).set({ active: true }).where(eq(rosterTeams.id, med.id));
    await withTx(db, async (tx) => {
      const since = ist("2026-10-01T00:00");
      await addMembership(tx, ms, { teamId: med.id, userId: userOf.get(5)!, positionKey: "unit_head", grade: "assistant_professor", roleInTeam: "head", startsAt: since });
      await addMembership(tx, ms, { teamId: med.id, userId: userOf.get(9)!, positionKey: "unit_sr", grade: "senior_resident", roleInTeam: "senior_resident", startsAt: since });
      for (const code of ["MED", "PED"]) {
        const { cycleId } = await draftCycleFromTemplate(tx, ms, { departmentId: await deptId(code), templateKey: cycleTemplate("single_unit_call").key, anchorIstDate: "2026-10-01" });
        await publishCycle(tx, ms, cycleId, "2026-10-01");
      }
    });
    expect(ped.active).toBe(false);
  });

  it("Who is on now lists only the department with a confirmed unit, raises no 'no take cycle' hole, and names Paediatrics as without a unit", async () => {
    const board = await onNowBoard(db, ist(`${MON}T11:00`), ON);
    expect(board.departments.map((d) => d.code)).toEqual(["MED"]);
    expect(board.departments[0]!.units).toBe(1);
    expect(board.holes.filter((h) => h.kind === "no_take_cycle")).toEqual([]);
    expect(board.departmentsWithoutUnit.map((d) => d.code)).toEqual(expect.arrayContaining(["PED"]));
    expect(board.departmentsWithoutUnit.find((d) => d.code === "PED")!.doctors).toBe(1);
    // A department with doctors AND a unit is not "without a unit"; Community Medicine (an OPD, no unit under NMC) is.
    expect(board.departmentsWithoutUnit.map((d) => d.code)).not.toContain("MED");
    expect(board.departmentsWithoutUnit.map((d) => d.code)).toContain("COMM");

    const stood = await boardAsItStood(db, ist(`${MON}T11:00`), ist(`${MON}T12:00`), ON);
    expect(stood.departments.map((d) => d.code)).toEqual(["MED"]);
  });

  it("the OPD line: no unconfirmed unit, and a unit names only the doctors who sit that day", async () => {
    const mon = await opdUnitsOn(db, MON);
    expect(mon.map((c) => c.opdDepartmentId)).toEqual(["OPD-MED"]);
    expect(mon[0]!.units.map((u) => [u.short, u.doctors.map((d) => d.name)])).toEqual([["Unit I", ["Dr. Chandan"]]]);
    const thu = await opdUnitsOn(db, THU);
    expect(thu.map((c) => c.opdDepartmentId)).toEqual(["OPD-MED"]);
    expect(thu[0]!.units[0]!.doctors.map((d) => d.name)).toEqual(["Dr. Yash Vardhan"]);
  });

  it("the month picker, the declarations picker, the copilot's departments and the census population are the confirmed units only", async () => {
    expect((await rosterUnits(db)).map((d) => [d.code, d.units.map((u) => u.code)])).toEqual([["MED", ["MED-U1"]]]);
    expect(await departmentsWithoutPublishedCycle(db, ist(`${MON}T11:00`))).toEqual([]);
    expect((await declarationsView(db, ms, ist(`${MON}T11:00`))).departments.map((d) => d.code)).toEqual(["MED"]);
  });
});
