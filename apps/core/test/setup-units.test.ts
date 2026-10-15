import { setupTestDb, truncateAll } from "./helpers/db";
import { linkCommunityMedicineClinic, seedCrkmchDoctors } from "./fixtures/crkmch-doctors";
import { loadUnitsData, nameTokens, setupUnits, weeklyEntries } from "../scripts/setup-units";
import { seedRoster } from "../scripts/seed-roster";
import { opdDoctors, rosterCycles, rosterTeamMemberships, rosterTeams } from "../src/kernel/db/schema";
import { fixDesignations, splitSpecialty } from "../scripts/fix-designations";
import { doctorUnitsOn, onNowBoard, opdUnitsOn } from "../src/modules/roster";
import type { Db } from "../src/kernel/db/client";

/**
 * 2026-10-04 (owner) — `setup:units`: the hospital's real units, from its OPD doctor list.
 *
 * Dry run by default and writes nothing; `--apply` confirms ONE unit in each of the five departments
 * that have one (MED, SUR, ENT, OBG, ORT), posts six people (five in-charges and Medicine's SR), and
 * publishes five weekly cycles whose OPD days are the members' own. Guest faculty, the casualty MO and
 * Community Medicine's Assistant Professor are never posted. A second run changes nothing.
 */
describe("setup:units — the hospital's units from the OPD doctor list", () => {
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const NOW = ist("2026-10-04T18:00");
  const FROM = "2026-10-05";
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("reads the sheet's spellings the way the owner does", () => {
    expect(nameTokens("Dr. S.I Raza")).toEqual(nameTokens("Dr. S I Raza"));
    expect(nameTokens("Dr. Sonam Kumar")).toEqual(nameTokens("Dr. Sonam Kumari"));
    expect(nameTokens("Dr. Rutu Mam")).toEqual(["rutu"]);
    const data = loadUnitsData();
    expect(data.doctors).toHaveLength(11);
    expect(data.omitted.map((o) => o.name)).toEqual(["Dr. Rajesh Kumar", "Dr. Nadia Imam"]);
    // A Monday-anchored week: take all 7 days, OPD on Fri + Sat only for Surgery.
    const sur = weeklyEntries("T", [5, 6], data.opdWindow);
    expect(sur.filter((e) => e.activity === "take")).toHaveLength(7);
    expect(sur.filter((e) => e.activity === "opd").map((e) => [e.dayIndex, e.startMinute, e.durationMinutes])).toEqual([[4, 540, 480], [5, 540, 480]]);
  });

  it("dry run on an empty database: every doctor unmatched, the missing masters named, nothing written", async () => {
    const r = await setupUnits(db, { apply: false, from: FROM, now: NOW });
    expect(r.matches.filter((m) => m.problem === "unmatched").map((m) => m.sl)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.preconditions.join("\n")).toMatch(/seed:roster/);
    expect(r.preconditions.join("\n")).toMatch(/medical_superintendent/);
    expect(await db.select().from(rosterTeams)).toEqual([]);
    // --apply with the preconditions unmet writes nothing either.
    const a = await setupUnits(db, { apply: true, from: FROM, now: NOW });
    expect([a.unitsConfirmed, a.membershipsAdded, a.cyclesPublished]).toEqual([0, 0, []]);
  });

  it("dry run with the doctors present plans exactly the five units and writes nothing", async () => {
    await seedCrkmchDoctors(db);
    await seedRoster(db);
    const r = await setupUnits(db, { apply: false, from: FROM, now: NOW });
    expect(r.preconditions).toEqual([]);
    expect(r.matches.filter((m) => m.userId === null)).toEqual([]);
    expect(r.units.map((u) => [u.teamCode, u.opdWeekdays])).toEqual([
      ["ENT-U1", [1, 2, 3, 4, 5]],
      ["MED-U1", [1, 2, 3, 4, 5, 6]],
      ["OBG-U1", [1, 2, 3]],
      ["ORT-U1", [2, 3, 4, 6]],
      ["SUR-U1", [5, 6]],
    ]);
    expect(r.actions.every((a) => a.startsWith("WOULD "))).toBe(true);
    expect(r.actions.filter((a) => a.includes("confirm"))).toHaveLength(5);
    expect(r.actions.filter((a) => a.includes("post "))).toHaveLength(6);
    expect(r.actions.filter((a) => a.includes("publish"))).toHaveLength(5);
    expect(r.noUnit.join("\n")).toMatch(/Paediatrics: guest faculty only — NO unit/);
    // Before the other lane links Community Medicine to its OPD clinic, the script says the clinic is missing.
    expect(r.noUnit.join("\n")).toMatch(/Community Medicine has no clinical unit \(NMC gives it none\); its OPD clinic is MISSING/);
    expect((await db.select().from(rosterTeams)).filter((t) => t.active)).toEqual([]);
    expect(await db.select().from(rosterTeamMemberships)).toEqual([]);
    expect(await db.select().from(rosterCycles)).toEqual([]);
  });

  it("apply: 5 units, 6 memberships, 5 cycles; guest faculty never members; the readers then show the hospital", async () => {
    const { userOf } = await seedCrkmchDoctors(db);
    await seedRoster(db);
    await linkCommunityMedicineClinic(db);
    const r = await setupUnits(db, { apply: true, from: FROM, now: NOW });
    expect(r.noUnit.join("\n")).toMatch(/Community Medicine has no clinical unit \(NMC gives it none\); sits in its OPD, no unit line/);
    expect([r.unitsConfirmed, r.membershipsAdded, [...r.cyclesPublished].sort()]).toEqual([5, 6, ["ENT", "MED", "OBG", "ORT", "SUR"]]);
    // Every listed OPD doctor gets the owner's designation (the casualty MO has no OPD profile).
    expect(r.designationsSet).toBe(10);
    const tags = Object.fromEntries((await db.select().from(opdDoctors)).map((d) => [d.displayName, d.designation]));
    expect(tags).toMatchObject({ "Dr. S.I Raza": "Guest Faculty", "Dr. Yash Vardhan": "Senior Resident", "Dr. Chandan": "Assistant Professor & Deputy Superintendent", "Dr. Saurabh Ranjan": "Assistant Professor" });
    expect(r.warnings).toEqual([]);

    const active = (await db.select().from(rosterTeams)).filter((t) => t.active).map((t) => t.code).sort();
    expect(active).toEqual(["ENT-U1", "MED-U1", "OBG-U1", "ORT-U1", "SUR-U1"]);
    const members = await db.select().from(rosterTeamMemberships);
    expect(members).toHaveLength(6);
    const posted = new Set(members.map((m) => m.userId));
    for (const sl of [1, 2, 3, 7, 10]) expect(posted.has(userOf.get(sl)!)).toBe(false); // guests, casualty MO, Community Medicine
    expect(members.filter((m) => m.roleInTeam === "head")).toHaveLength(5);
    expect(members.filter((m) => m.positionKey === "unit_sr").map((m) => m.userId)).toEqual([userOf.get(9)]);

    // Monday: Medicine's Unit I with Dr Chandan; no Surgery unit (its surgeon sits Fri/Sat; Mon is the guest's).
    const names = async (day: string) => Object.fromEntries((await opdUnitsOn(db, day)).map((c) => [c.opdDepartmentId, c.units.map((u) => `${u.short}: ${u.doctors.map((d) => d.name).join(", ")}`)]));
    expect(await names("2026-10-05")).toEqual({
      "OPD-MED": ["Unit I: Dr. Chandan"], "OPD-ENT": ["Unit I: Dr. Sonam Kumari"], "OPD-OBG": ["Unit I: Dr. Ritu Kumari"],
    });
    expect(await names("2026-10-08")).toEqual({
      "OPD-MED": ["Unit I: Dr. Yash Vardhan"], "OPD-ENT": ["Unit I: Dr. Sonam Kumari"], "OPD-ORT": ["Unit I: Dr. Kishore Kunal"],
    });
    expect(await names("2026-10-10")).toEqual({
      "OPD-MED": ["Unit I: Dr. Yash Vardhan"], "OPD-ORT": ["Unit I: Dr. Kishore Kunal"], "OPD-SUR": ["Unit I: Dr. Saurabh Ranjan"],
    });

    const board = await onNowBoard(db, ist("2026-10-08T11:00"), { ROSTER_RESOLVER_ENABLED: "true" });
    expect(board.departments.map((d) => d.code).sort()).toEqual(["ENT", "MED", "OBG", "ORT", "SUR"]);
    expect(board.departments.every((d) => d.unitOnTake !== null && d.units === 1)).toBe(true);
    expect(board.holes.filter((h) => h.kind === "no_take_cycle" || h.kind === "take_gap")).toEqual([]);
    // Community Medicine has an OPD and a doctor but no unit (NMC): named beside Paediatrics, never a row.
    expect(board.departmentsWithoutUnit.map((d) => d.code)).toEqual(["COMM", "PED"]);
    expect((await opdUnitsOn(db, "2026-10-05")).find((c) => c.opdDepartmentId === "OPD-COMM")).toBeUndefined();

    // 2026-10-04 (owner: only the OPD is live) — no duty roster published, so each row carries who
    // sits in its OPD: at 11:00 Thursday Medicine has Raza and Yash in; Ortho's 9–11 session is over
    // and his next is 14:00; Paediatrics and Community Medicine (no unit) carry theirs too.
    const opd = (rows: { inOpd: { name: string; now: boolean; designation: string | null }[] | null }) => rows.inOpd!.map((p) => `${p.name}${p.now ? "" : " (later)"} [${p.designation ?? "-"}]`);
    const row = (code: string) => board.departments.find((d) => d.code === code)!;
    expect(row("MED").source).not.toBe("published");
    expect(opd(row("MED"))).toEqual(["Dr. S.I Raza [Guest Faculty]", "Dr. Yash Vardhan [Senior Resident]"]);
    expect(opd(row("ORT"))).toEqual(["Dr. Kishore Kunal (later) [Assistant Professor]"]);
    expect(opd(row("SUR"))).toEqual([]);
    expect(board.departmentsWithoutUnit.map((d) => [d.code, opd(d)])).toEqual([
      ["COMM", ["Dr. Nitish Kumar Jha [Assistant Professor]"]], ["PED", ["Dr. Suryendru Kumar [Guest Faculty]"]],
    ]);

    // 2026-10-04 (owner) — the unit beside a doctor's name: members only, guests and Community Medicine absent.
    const units = Object.fromEntries((await doctorUnitsOn(db, "2026-10-05")).map((u) => [u.userId, u.short]));
    expect(units).toEqual({
      [userOf.get(4)!]: "Unit I", [userOf.get(5)!]: "Unit I", [userOf.get(6)!]: "Unit I",
      [userOf.get(8)!]: "Unit I", [userOf.get(9)!]: "Unit I", [userOf.get(11)!]: "Unit I",
    });
    // Before the postings began, nobody is in a unit.
    expect(await doctorUnitsOn(db, "2026-10-01")).toEqual([]);
  });

  it("is idempotent: a second --apply changes nothing", async () => {
    await seedCrkmchDoctors(db);
    await seedRoster(db);
    await setupUnits(db, { apply: true, from: FROM, now: NOW });
    const cycles = (await db.select().from(rosterCycles)).length;
    const again = await setupUnits(db, { apply: true, from: FROM, now: NOW });
    expect([again.unitsConfirmed, again.membershipsAdded, again.cyclesPublished, again.designationsSet, again.actions]).toEqual([0, 0, [], 0, []]);
    expect((await db.select().from(rosterCycles)).length).toBe(cycles);
    expect(await db.select().from(rosterTeamMemberships)).toHaveLength(6);
  });

  it("matches the sheet's spellings when the database holds them instead", async () => {
    await seedCrkmchDoctors(db, { rename: { 1: "Dr. S I Raza", 3: "Dr. Nitesh Kumar Jha", 4: "Dr. Sonam Kumar", 5: "Dr. Chandan Kumar" } });
    await seedRoster(db);
    const r = await setupUnits(db, { apply: false, from: FROM, now: NOW });
    expect(r.matches.filter((m) => m.userId === null)).toEqual([]);
    expect(r.matches.find((m) => m.sl === 5)).toMatchObject({ how: "loose", matchedAs: "Dr. Chandan Kumar" });
    expect(r.warnings).toEqual([expect.stringMatching(/#5 Dr\. Chandan: matched loosely to "Dr\. Chandan Kumar"/)]);
  });

  it("fix:designations moves a designation typed into the specialty (staging 2026-10-04), keeps a real specialty, and runs once", async () => {
    expect(splitSpecialty("Guest Faculty")).toEqual({ designation: "Guest Faculty", specialty: null });
    expect(splitSpecialty("Assistant Professor & Deputy Superintendent")).toEqual({ designation: "Assistant Professor & Deputy Superintendent", specialty: null });
    expect(splitSpecialty("Assistant Professor (Neurosurgeon)")).toEqual({ designation: "Assistant Professor", specialty: "Neurosurgeon" });
    expect(splitSpecialty("Cardiology")).toBeNull();
    expect(splitSpecialty("Neurosurgeon")).toBeNull();

    await seedCrkmchDoctors(db, { designationsInSpecialty: true });
    await seedRoster(db);
    const dry = await fixDesignations(db, { apply: false });
    expect(dry.moves).toHaveLength(10);
    expect(dry.moved).toBe(0);
    expect((await db.select().from(opdDoctors)).every((d) => d.designation === null)).toBe(true);

    const r = await fixDesignations(db, { apply: true });
    expect(r.moved).toBe(10);
    const by = Object.fromEntries((await db.select().from(opdDoctors)).map((d) => [d.displayName, [d.designation, d.specialty]]));
    expect(by["Dr. Saurabh Ranjan"]).toEqual(["Assistant Professor", "Neurosurgeon"]);
    expect(by["Dr. S.I Raza"]).toEqual(["Guest Faculty", null]);
    expect(by["Dr. Chandan"]).toEqual(["Assistant Professor & Deputy Superintendent", null]);
    expect((await fixDesignations(db, { apply: true })).moves).toEqual([]);
    // …and the setup script then finds every designation already on file.
    expect((await setupUnits(db, { apply: false, from: FROM, now: NOW })).actions.filter((a) => a.includes("designation"))).toEqual([]);
  });
});
