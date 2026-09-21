import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, orgDepartments, permissions, roleAssignments, rolePermissions, roles,
  rosterTeams, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import {
  UNIT_COUNT, UNIT_ESTABLISHMENT, closeTeam, confirmTeam, createTeam, listTeams, nightPoolFor,
  seedUnits, teamByCode, teamMembers, unconfirmedTeams,
} from "./teams";
import { addMembership, importMemberships, membershipsOf, parentTeamOf } from "./memberships";
import { officiatingAt, recordOfficiating } from "./officiating";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R3) — the establishment, the people in it, and who is standing in.
 *
 * The two legs a reviewer should read first are the two that decide whether a NIGHT is covered:
 * **officiating preferred by `teamMembers`** (a head on leave whose phone would otherwise be rung)
 * and **a rotation that keeps its parent unit's nights** (get it wrong and a department's night
 * pool silently empties while every individual roster looks correct).
 */
describe("roster — teams, memberships and officiating (R3)", () => {
  const MS = "01USER00000000000000000MS";
  const HEAD = "01USER000000000000000HEAD";
  const ACTING = "01USER00000000000000ACTNG";
  const JR = "01USER00000000000000000JR";
  const ms: Actor = { type: "user", id: MS };

  let db: Db;
  let teardown: () => Promise<void>;
  let MED: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "duty_manager", title: "Duty manager" },
      { key: "radiologist", title: "Radiologist" },
      { key: "pathologist", title: "Pathologist" },
      { key: "anaesthetist", title: "Anaesthetist" },
      { key: "pharmacy", title: "Pharmacy" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    for (const [id, username] of [[MS, "sunita.mishra"], [HEAD, "r.prasad"], [ACTING, "n.verma"], [JR, "sandeep.yadav"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-5)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-HEAD", userId: HEAD, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-ACT", userId: ACTING, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-JR", userId: JR, roleKey: "doctor", scopeType: "hospital", scopeId: null },
    ]);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
  });

  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = at("2026-10-12T08:00");

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  /* ═══════════════════ the establishment, seeded as a DRAFT ═══════════════════ */

  it("seeds the 27 units plus one night pool per unit-bearing department, all INACTIVE", async () => {
    const result = await seedUnits(db);
    expect(UNIT_COUNT).toBe(27);
    expect(result.added).toBe(UNIT_COUNT + UNIT_ESTABLISHMENT.length);
    const teams = await listTeams(db);
    expect(teams.filter((t) => t.kind === "clinical_unit")).toHaveLength(27);
    expect(teams.filter((t) => t.kind === "pool")).toHaveLength(UNIT_ESTABLISHMENT.length);
    // Every one of them is unconfirmed: the establishment is OURS, and a human ratifies it.
    expect(teams.every((t) => !t.active)).toBe(true);
    expect(await unconfirmedTeams(db)).toHaveLength(teams.length);
  });

  it("the seed is idempotent, and Medicine gets five units with its beds divided between them", async () => {
    await seedUnits(db);
    const second = await seedUnits(db);
    expect(second.added).toBe(0);
    const med = (await listTeams(db, { kind: "clinical_unit" })).filter((t) => t.code.startsWith("MED-U"));
    expect(med).toHaveLength(5);
    expect(med.map((t) => t.sanctionedBeds)).toEqual([30, 30, 30, 30, 30]); // 150 beds, 5 units
    expect((await teamByCode(db, "MED-U2"))?.name).toBe("General Medicine Unit II");
  });

  it("a head of department confirms a unit, and the census row goes quiet only when all are confirmed", async () => {
    await seedUnits(db);
    const before = (await unconfirmedTeams(db)).length;
    const u1 = (await teamByCode(db, "MED-U1"))!;
    await withTx(db, (tx) => confirmTeam(tx, ms, u1.id));
    expect((await unconfirmedTeams(db)).length).toBe(before - 1);
    expect((await teamByCode(db, "MED-U1"))?.active).toBe(true);
  });

  it("creating a team refuses a duplicate code, and closing one dates it rather than deleting it", async () => {
    const { teamId } = await withTx(db, (tx) => createTeam(tx, ms, {
      kind: "ward_team", departmentId: MED, code: "ward-3b", name: "Ward 3B nursing team",
    }));
    expect((await teamByCode(db, "WARD-3B"))?.id).toBe(teamId); // codes are upper-cased
    expect((await refusal(withTx(db, (tx) => createTeam(tx, ms, {
      kind: "ward_team", departmentId: MED, code: "WARD-3B", name: "again",
    })))).code).toBe("duplicate_team_code");

    await withTx(db, (tx) => closeTeam(tx, ms, teamId, at("2027-04-01T00:00")));
    const [row] = await db.select().from(rosterTeams).where(eq(rosterTeams.id, teamId));
    expect(row!.active).toBe(false);
    expect(row!.validTo).not.toBeNull();
    expect(await unconfirmedTeams(db)).toHaveLength(0); // closed teams are not "unconfirmed"
  });

  /* ═══════════════════ memberships ═══════════════════ */

  const unit = async (): Promise<string> => {
    await seedUnits(db);
    return (await teamByCode(db, "MED-U1"))!.id;
  };

  it("a person belongs to ONE unit, and the refusal says what to do instead", async () => {
    const teamId = await unit();
    const other = (await teamByCode(db, "MED-U2"))!.id;
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      startsAt: at("2026-04-01T00:00"),
    }));
    const e = await refusal(withTx(db, (tx) => addMembership(tx, ms, {
      teamId: other, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      startsAt: at("2026-04-01T00:00"),
    })));
    expect(e.code).toBe("parent_membership_overlap");
    expect(e.message).toContain("rotation");
  });

  it("a rotation is an ADDITIONAL place, and `retains_parent_nights` keeps the person in the parent pool", async () => {
    const teamId = await unit();
    const icu = (await teamByCode(db, "MED-U3"))!.id;
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      startsAt: at("2026-04-01T00:00"),
    }));
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: icu, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      kind: "rotation", retainsParentNights: true,
      startsAt: at("2026-10-01T00:00"), endsAt: at("2027-01-01T00:00"),
    }));

    const held = await membershipsOf(db, JR, OCT);
    expect(held.map((m) => m.kind)).toEqual(["parent", "rotation"]); // parent first
    expect((await parentTeamOf(db, JR, OCT))?.teamId).toBe(teamId);

    // The department's night pool still counts them — which is the whole S4 argument.
    expect(await nightPoolFor(db, MED, OCT)).toContain(JR);
  });

  it("…and a rotation that does NOT keep its nights leaves the parent pool", async () => {
    const teamId = await unit();
    const other = (await teamByCode(db, "MED-U3"))!.id;
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      startsAt: at("2026-04-01T00:00"), endsAt: at("2026-10-01T00:00"),
    }));
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: other, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      kind: "rotation", retainsParentNights: false, startsAt: at("2026-10-01T00:00"),
    }));
    // Their parent membership has closed, so at OCT they are on rotation only and hold no parent place.
    expect(await parentTeamOf(db, JR, OCT)).toBeUndefined();
    expect(await nightPoolFor(db, MED, OCT)).not.toContain(JR);
  });

  it("refuses `retains_parent_nights` on anything but a rotation", async () => {
    const teamId = await unit();
    const e = await refusal(withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      kind: "parent", retainsParentNights: true, startsAt: at("2026-04-01T00:00"),
    })));
    expect(e.code).toBe("invalid_window");
    expect(e.message).toContain("ROTATION");
  });

  it("membership is judged AT THE INSTANT ASKED — yesterday's team does not change when somebody transfers today", async () => {
    const teamId = await unit();
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: JR, positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident",
      startsAt: at("2026-04-01T00:00"), endsAt: at("2026-10-01T00:00"),
    }));
    expect((await teamMembers(db, teamId, at("2026-09-15T08:00"))).map((m) => m.userId)).toEqual([JR]);
    expect(await teamMembers(db, teamId, OCT)).toEqual([]);
  });

  /* ═══════════════════ officiating — the leg that decides who gets rung ═══════════════════ */

  it("an officiating head is PREFERRED, and the substantive head's own membership is untouched", async () => {
    const teamId = await unit();
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: HEAD, positionKey: "unit_head", grade: "professor", roleInTeam: "head",
      startsAt: at("2026-04-01T00:00"),
    }));
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId, userId: ACTING, positionKey: "faculty_on_call", grade: "associate_professor",
      roleInTeam: "faculty", startsAt: at("2026-04-01T00:00"), kind: "rotation",
    }));
    await withTx(db, (tx) => recordOfficiating(tx, ms, {
      teamId, userId: ACTING, role: "head", reason: "the head is on leave until the 21st",
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-10-21T00:00"),
    }));

    const during = await teamMembers(db, teamId, OCT);
    const acting = during.find((m) => m.userId === ACTING)!;
    expect(acting.roleInTeam).toBe("head");
    expect(acting.officiating).toBe(true);
    // The head has NOT stopped being the head; their membership is a fact about the establishment.
    const substantive = during.find((m) => m.userId === HEAD)!;
    expect(substantive.roleInTeam).toBe("head");
    expect(substantive.officiating).toBe(false);

    // ...and after it ends, the stand-in is back to being faculty.
    const after = await teamMembers(db, teamId, at("2026-10-22T08:00"));
    expect(after.find((m) => m.userId === ACTING)!.roleInTeam).toBe("faculty");
    expect(after.find((m) => m.userId === ACTING)!.officiating).toBe(false);
    expect(await officiatingAt(db, teamId, at("2026-10-22T08:00"))).toEqual([]);
  });

  it("refuses a second stand-in for the same role over the same stretch", async () => {
    const teamId = await unit();
    await withTx(db, (tx) => recordOfficiating(tx, ms, {
      teamId, userId: ACTING, role: "head", reason: "on leave",
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-10-21T00:00"),
    }));
    expect((await refusal(withTx(db, (tx) => recordOfficiating(tx, ms, {
      teamId, userId: JR, role: "head", reason: "also on leave",
      startsAt: at("2026-10-10T00:00"), endsAt: at("2026-10-25T00:00"),
    })))).code).toBe("officiating_overlap");
  });

  it("an officiating row needs a reason — a stand-in nobody explained is one nobody can question", async () => {
    const teamId = await unit();
    expect((await refusal(withTx(db, (tx) => recordOfficiating(tx, ms, {
      teamId, userId: ACTING, role: "head", reason: "  ", startsAt: at("2026-10-01T00:00"),
    })))).code).toBe("invalid_window");
  });

  /* ═══════════════════ the import, validated whole ═══════════════════ */

  it("refuses the WHOLE import when any row is wrong, and writes nothing", async () => {
    await unit();
    const result = await withTx(db, (tx) => importMemberships(tx, ms, [
      { teamCode: "MED-U1", staffCode: "EMP-000JR", positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident", startsAt: "2026-04-01" },
      { teamCode: "MED-U9", staffCode: "EMP-000JR", positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident", startsAt: "2026-04-01" },
      { teamCode: "MED-U1", staffCode: "EMP-000JR", positionKey: "registrar", grade: "nope", roleInTeam: "junior_resident", startsAt: "not a date" },
    ]));
    expect("problems" in result).toBe(true);
    const { problems } = result as { problems: { row: number; message: string }[] };
    expect(problems.map((p) => p.row)).toEqual([2, 3, 3, 3]);
    // NOTHING landed — the half-imported file is the failure this posture exists to prevent.
    expect(await membershipsOf(db, JR, at("2026-05-01T00:00"))).toEqual([]);
  });

  it("imports the whole file when every row resolves", async () => {
    const teamId = await unit();
    const result = await withTx(db, (tx) => importMemberships(tx, ms, [
      { teamCode: "MED-U1", staffCode: "EMP-000JR", positionKey: "ward_jr", grade: "jr2", roleInTeam: "junior_resident", startsAt: "2026-04-01" },
      { teamCode: "MED-U2", staffCode: "EMP-0HEAD", positionKey: "unit_head", grade: "professor", roleInTeam: "head", startsAt: "2026-04-01" },
    ]));
    expect(result).toEqual({ imported: 2 });
    expect((await parentTeamOf(db, JR, at("2026-05-01T00:00")))?.teamId).toBe(teamId);
  });

  /* ═══════════════════ the seed's own precondition ═══════════════════ */

  it("refuses to seed units when the departments have not been seeded", async () => {
    await db.delete(rosterTeams);
    await db.delete(orgDepartments);
    await db.delete(opdDepartments);
    await expect(seedUnits(db)).rejects.toThrow(/seed:roster/);
  });
});
