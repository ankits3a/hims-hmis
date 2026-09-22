import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { opdDepartments, orgDepartments, roles, rosterPositions } from "../../kernel/db/schema";
import { DEFAULT_DEPARTMENTS } from "../opd";
import {
  ORG_DEPARTMENTS, ROSTER_POSITIONS, listOrgDepartments, listRosterPositions, orgDepartmentByCode,
  rosterMasterCounts, seedOrgDepartments, seedRosterPositions,
} from "./masters";
import type { Db } from "../../kernel/db/client";

/**
 * PHASE R (R1) — the two master lists, seeded against a real database.
 *
 * ═══ WHAT THESE LEGS ARE ACTUALLY FOR ═══
 *
 * A seed is the easiest thing in a repository to ship broken, because it runs once on an empty box
 * and never again where anyone is watching. The three ways this one could be wrong are each a leg:
 *
 *   · it is **not idempotent** — a second deploy duplicates the list, or worse, overwrites the
 *     edits a human made to it between the two;
 *   · the **OPD link resolves by a hard-coded id** — correct on the machine it was written on and
 *     wrong on every install, because those ids are ULIDs minted by whoever ran `seed:opd`;
 *   · a **position names an RBAC role that does not exist**, so seventeen inserts fail on the
 *     eighth and leave the list half seeded with no message anybody can act on.
 */
describe("roster — the master lists (R1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const seedRolesUsed = async (): Promise<void> => {
    const used = [...new Set(ROSTER_POSITIONS.map((p) => p.eligibleRoleKey).filter((k): k is string => k !== null))];
    await db.insert(roles).values(used.map((key) => ({ key, title: key }))).onConflictDoNothing();
  };

  const seedClinics = async (): Promise<void> => {
    await db.insert(opdDepartments).values(
      DEFAULT_DEPARTMENTS.map((d, i) => ({
        id: `01OPDDEPT${String(i).padStart(14, "0")}`, code: d.code, name: d.name,
        createdBy: "t", updatedBy: "t",
      })),
    );
  };

  beforeEach(async () => { await truncateAll(db); });

  /* ═══════════════════ the lists themselves ═══════════════════ */

  it("the department list has no duplicate code and no duplicate clinic", () => {
    const codes = ORG_DEPARTMENTS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    const opdCodes = ORG_DEPARTMENTS.map((d) => d.opdCode).filter((c): c is string => c !== undefined);
    expect(new Set(opdCodes).size).toBe(opdCodes.length);
  });

  it("every one of the OPD's twelve clinics is owned by exactly one organisational department", () => {
    // The failure this catches is a clinic nobody rosters for: a department added to `seed:opd`
    // with no org row is a counter that opens with no rota behind it.
    const linked = ORG_DEPARTMENTS.map((d) => d.opdCode).filter((c): c is string => c !== undefined).sort();
    expect(linked).toEqual(DEFAULT_DEPARTMENTS.map((d) => d.code).sort());
  });

  it("the departments the intern year posts to all exist — the S3 finding, as a test", () => {
    // Stress test S3: the CRMI intern year posts to Community Medicine, Anaesthesia, Casualty and
    // Forensic Medicine, and `opd_departments` has none of the four. R3's generator needs all four.
    const codes = new Set(ORG_DEPARTMENTS.map((d) => d.code));
    for (const code of ["COMM", "ANAE", "CAS", "FMT"]) expect(`${code}: ${codes.has(code)}`).toBe(`${code}: true`);
  });

  it("every department that admits is clinical, and nursing/admin/support admit nobody", () => {
    for (const d of ORG_DEPARTMENTS) {
      if (d.admitting) expect(`${d.code}: ${d.kind}`).toBe(`${d.code}: clinical`);
    }
  });

  it("the position list is the plan's seventeen, with unique keys, labels and no rung below the bedside", () => {
    expect(ROSTER_POSITIONS).toHaveLength(17);
    expect(new Set(ROSTER_POSITIONS.map((p) => p.key)).size).toBe(17);
    expect(new Set(ROSTER_POSITIONS.map((p) => p.label)).size).toBe(17);
    for (const p of ROSTER_POSITIONS) expect(`${p.key}: ${p.ladderRank >= 1}`).toBe(`${p.key}: true`);
  });

  it("the intern is the one position that does not fill a hole (V16's fact)", () => {
    const notCounting = ROSTER_POSITIONS.filter((p) => p.countsTowardRequirements === false).map((p) => p.key);
    expect(notCounting).toEqual(["intern"]);
  });

  /* ═══════════════════ seeding, twice ═══════════════════ */

  it("seeds both lists, and a SECOND run adds nothing", async () => {
    await seedRolesUsed();
    await seedClinics();

    const d1 = await seedOrgDepartments(db);
    const p1 = await seedRosterPositions(db);
    expect(d1).toEqual({ added: ORG_DEPARTMENTS.length, present: 0 });
    expect(p1).toEqual({ added: ROSTER_POSITIONS.length, present: 0 });

    const d2 = await seedOrgDepartments(db);
    const p2 = await seedRosterPositions(db);
    expect(d2).toEqual({ added: 0, present: ORG_DEPARTMENTS.length });
    expect(p2).toEqual({ added: 0, present: ROSTER_POSITIONS.length });

    expect(await rosterMasterCounts(db)).toEqual({
      departments: ORG_DEPARTMENTS.length, positions: ROSTER_POSITIONS.length,
    });
  });

  it("a second run does NOT overwrite what a human changed between the two", async () => {
    await seedRolesUsed();
    await seedClinics();
    await seedOrgDepartments(db);
    await seedRosterPositions(db);

    await db.update(orgDepartments).set({ name: "Medicine (Wing B)", updatedBy: "hod" }).where(eq(orgDepartments.code, "MED"));
    await db.update(rosterPositions).set({ active: false, updatedBy: "ms" }).where(eq(rosterPositions.key, "blood_bank_mo"));

    await seedOrgDepartments(db);
    await seedRosterPositions(db);

    expect((await orgDepartmentByCode(db, "MED"))?.name).toBe("Medicine (Wing B)");
    expect((await listRosterPositions(db)).find((p) => p.key === "blood_bank_mo")?.active).toBe(false);
  });

  /* ═══════════════════ the link, resolved by CODE ═══════════════════ */

  it("links each clinical department to the clinic it runs, by code, whatever ids seed:opd minted", async () => {
    await seedRolesUsed();
    await seedClinics();
    await seedOrgDepartments(db);

    const clinics = new Map((await db.select().from(opdDepartments)).map((c) => [c.code, c.id]));
    const orgs = await listOrgDepartments(db);
    const linked = orgs.filter((o) => o.opdDepartmentId !== null);
    expect(linked).toHaveLength(DEFAULT_DEPARTMENTS.length);
    for (const o of linked) expect(`${o.code} -> ${o.opdDepartmentId}`).toBe(`${o.code} -> ${clinics.get(o.code)}`);
  });

  it("seeds the whole list with NO clinics present — the twelve are simply unlinked", async () => {
    // The order `seed:roster` before `seed:opd` must not lose eleven departments. It loses the
    // LINK, which `standup:check` reports, and that is a difference worth having in a test.
    await seedRolesUsed();
    const d = await seedOrgDepartments(db);
    expect(d.added).toBe(ORG_DEPARTMENTS.length);
    expect((await listOrgDepartments(db)).every((o) => o.opdDepartmentId === null)).toBe(true);
  });

  /* ═══════════════════ the refusal that keeps the list from half-seeding ═══════════════════ */

  it("refuses BEFORE the first write when an RBAC role a position names does not exist", async () => {
    await expect(seedRosterPositions(db)).rejects.toThrow(/do not exist.*seed:roles/s);
    expect(await rosterMasterCounts(db)).toEqual({ departments: 0, positions: 0 });
  });

  /* ═══════════════════ the reads the census and R3 use ═══════════════════ */

  it("lists positions up the ladder, and filters the inactive out only when asked", async () => {
    await seedRolesUsed();
    await seedRosterPositions(db);
    await db.update(rosterPositions).set({ active: false, updatedBy: "t" }).where(eq(rosterPositions.key, "intern"));

    const all = await listRosterPositions(db);
    expect(all).toHaveLength(17);
    expect(all.map((p) => p.ladderRank)).toEqual([...all.map((p) => p.ladderRank)].sort((a, b) => a - b));
    expect(await listRosterPositions(db, { activeOnly: true })).toHaveLength(16);
  });
});
