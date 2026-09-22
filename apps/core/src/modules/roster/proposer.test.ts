import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterPositions,
  rosterRequirements, rosterTeams, staffAbsences, users,
} from "../../kernel/db/schema";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { addMembership } from "./memberships";
import { periodWithAssignments } from "./periods";
import { seedRosterRules } from "./rules";
import { validate } from "./validator";
import { fairnessOf, fairnessSpread, proposeMonth } from "./proposer";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R9) — **THE PROPOSER, AGAINST A REAL DATABASE.**
 *
 * The headline assertion is the one the plan asks for: **a drafted month carries zero `block`
 * findings at NMC-minimum staffing.** Everything else here exists to stop that assertion being
 * satisfied dishonestly —
 *
 *   · by drafting nothing (the slot counts are asserted);
 *   · by filling every hole with somebody who should not be there (the leave leg);
 *   · by producing a different rota each run, so a green is a coincidence (the determinism leg);
 *   · by dumping the nights on whoever sorts first (the fairness leg).
 */
describe("roster — the proposer and the monthly draft (R9)", () => {
  const MS = "01USER00000000000000000MS";
  const MED = "01ORGDEPT000000000000MED";
  const TEAM = "01ROSTERTEAM00000MEDU2";
  const TEAM2 = "01ROSTERTEAM00000MEDU3";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = { startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00") };

  const ms: Actor = { type: "user", id: MS };
  const machine: Actor = { type: "system", id: "roster-proposer" };

  /** Six junior residents — a unit at NMC minimum with room to rotate nights one in three. */
  const JRS = Array.from({ length: 6 }, (_, i) => `01USERJR00000000000000${i}`);
  /** Three more on a second unit, for the pooled-nights leg. */
  const JRS2 = Array.from({ length: 3 }, (_, i) => `01USERJX00000000000000${i}`);

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "doctor", title: "Doctor" },
      { key: "medical_superintendent", title: "Medical Superintendent" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    await db.insert(orgDepartments).values([
      { id: MED, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(rosterPositions).values([
      { key: "ward_jr", label: "Ward junior resident", cadre: "junior_resident", ladderRank: 2, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
      { key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(users).values({ id: MS, username: "sunita.mishra", fullName: "sunita.mishra", staffCode: "EMP-MS", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    for (const [i, id] of [...JRS, ...JRS2].entries()) {
      await db.insert(users).values({ id, username: `jr${i}`, fullName: `Resident ${i}`, staffCode: `EMP-JR${i}`, passwordHash: "x" });
      await db.insert(roleAssignments).values({ id: `RA-${id}`, userId: id, roleKey: "doctor", scopeType: "hospital", scopeId: null });
    }
    await db.insert(rosterTeams).values([
      { id: TEAM, departmentId: MED, code: "MED-U2", name: "Medicine Unit II", kind: "clinical_unit", createdBy: "t", updatedBy: "t" },
      { id: TEAM2, departmentId: MED, code: "MED-U3", name: "Medicine Unit III", kind: "clinical_unit", createdBy: "t", updatedBy: "t" },
    ]);
    for (const [team, list] of [[TEAM, JRS], [TEAM2, JRS2]] as const) {
      for (const userId of list) {
        await withTx(db, (tx) => addMembership(tx, ms, {
          teamId: team, userId, positionKey: "ward_jr", grade: "jr2",
          roleInTeam: "junior_resident", kind: "parent", startsAt: at("2026-01-01T00:00"),
        }));
      }
    }
    await seedRosterRules(db, "t");
  });

  const propose = (over: Partial<Parameters<typeof proposeMonth>[2]> = {}) =>
    withTx(db, (tx) => proposeMonth(tx, machine, {
      departmentId: MED, teamId: TEAM, title: "October — Medicine Unit II",
      strategy: "unit_split", seed: 7, nightPositionKey: "ward_jr", ...OCT, ...over,
    }));

  /* ═══════════════════ the assertion the plan asks for ═══════════════════ */

  it("a drafted month carries ZERO block findings at NMC-minimum staffing", async () => {
    /**
     * A REQUIREMENT ROW, so that "zero blocks" means what it says.
     *
     * Without one, the only block this fixture can produce is `rest_after_duty` — `slot_over_24h`
     * needs a duty past a position's cap, and `credential_expired` needs a requirement naming a
     * credential. A green would then be a narrower claim than the sentence above it. With this row
     * the staffing GATE (R-067) is live too, so an unfilled night is a block and the assertion
     * covers both of the things a drafted month can get wrong.
     */
    await db.insert(rosterRequirements).values({
      id: "01REQ0000000000000000001", scopeType: "team", scopeId: TEAM, positionKey: "ward_jr",
      dayClass: "any", minCount: 1, basis: "fixed", authority: "nmc",
      citation: "NMC UG-MSR 2023 — unit staffing", validFrom: "2026-01-01",
      createdBy: "t", updatedBy: "t",
    });

    const r = await propose();

    // It drafted something: a green cannot come from an empty month.
    expect(r.nights).toBe(31); // October
    expect(r.vacant).toBe(0);
    expect(r.filled).toBeGreaterThan(31);

    const findings = await validate(db, r.periodId);
    const blocks = findings.filter((f) => f.severity === "block");
    expect(blocks.map((b) => `${b.ruleKey}:${b.userId ?? ""}`)).toEqual([]);
  });

  it("…and the month it drafted is a DRAFT — a machine never publishes", async () => {
    const r = await propose();
    const row = await db.execute(sql`select status, origin, drafted_by_actor_type as t from roster_periods where id = ${r.periodId}`);
    expect(row.rows[0]).toMatchObject({ status: "draft", origin: "machine", t: "system" });
  });

  /* ═══════════════════ determinism ═══════════════════ */

  it("the same seed gives the same rota, and a different seed does not", async () => {
    const shape = async (periodId: string): Promise<string> => {
      const { assignments } = await periodWithAssignments(db, periodId);
      return assignments
        .map((a) => `${a.startsAt.toISOString()}|${a.positionKey}|${a.userId ?? "VACANT"}`)
        .sort()
        .join("\n");
    };

    const a = await propose({ seed: 7 });
    const b = await propose({ seed: 7 });
    expect(await shape(b.periodId)).toEqual(await shape(a.periodId));

    // A proposer that ignored its seed would pass the leg above and mean nothing by it.
    const c = await propose({ seed: 99 });
    expect(await shape(c.periodId)).not.toEqual(await shape(a.periodId));
  });

  /* ═══════════════════ fairness ═══════════════════ */

  it("nights are spread, not dumped on whoever sorts first", async () => {
    const r = await propose();
    const nights = r.fairness.map((f) => f.nights);
    expect(nights.reduce((x, y) => x + y, 0)).toBe(31);
    // Six residents over thirty-one nights: five or six each, never one person taking twelve.
    expect(fairnessSpread(r.fairness)).toBeLessThanOrEqual(1);
    expect(Math.min(...nights)).toBeGreaterThanOrEqual(5);

    // Counted from the ROWS as well as from the proposer's own bookkeeping — a proposer that
    // miscounted its own fairness would otherwise report a spread it had not achieved.
    const { assignments } = await periodWithAssignments(db, r.periodId);
    const fromRows = fairnessOf(assignments);
    expect(fromRows.map((f) => f.nights).sort()).toEqual(nights.slice().sort());
  });

  /* ═══════════════════ leave, and the honest hole ═══════════════════ */

  it("somebody on approved leave is never rostered", async () => {
    await db.insert(staffAbsences).values({
      id: "01ABS000000000000000001", userId: JRS[0]!, kind: "ML",
      startsAt: OCT.startsAt, endsAt: OCT.endsAt, status: "approved",
      reason: "under treatment", requestedBy: JRS[0]!, approvedBy: MS,
      decidedAt: at("2026-09-20T10:00"), source: "manual", createdBy: "t", updatedBy: "t",
    });
    const r = await propose();
    const { assignments } = await periodWithAssignments(db, r.periodId);
    expect(assignments.some((a) => a.userId === JRS[0])).toBe(false);
    expect(r.fairness.some((f) => f.userId === JRS[0])).toBe(false);
    // The other five still cover every night.
    expect(r.vacant).toBe(0);
  });

  it("too few people produce HOLES, not broken rest", async () => {
    // One resident cannot cover a month of nights one-in-three. The proposer must leave the
    // nights it cannot legally fill VACANT rather than rostering the same person nightly.
    const solo = await propose({ teamId: TEAM2, strategy: "unit_split" });
    // Three residents, one night in three: it can fill roughly every night, so squeeze harder.
    await db.execute(sql`delete from roster_team_memberships where team_id = ${TEAM2} and user_id <> ${JRS2[0]!}`);
    const r = await propose({ teamId: TEAM2, strategy: "unit_split", title: "October — Unit III, one resident" });

    expect(r.vacant).toBeGreaterThan(0);
    const findings = await validate(db, r.periodId);
    // Whatever it could not fill, it did not fill ILLEGALLY: no rest or night-frequency block.
    const illegal = findings.filter((f) =>
      f.severity === "block" && (f.ruleKey === "rest_after_duty" || f.ruleKey === "night_one_in_three"));
    expect(illegal).toEqual([]);
    expect(solo.periodId).not.toEqual(r.periodId);
  });

  /* ═══════════════════ S4, in the draft rather than the arithmetic ═══════════════════ */

  it("pooled nights draw on the department, unit-split does not — S4 in a real rota", async () => {
    const split = await propose({ teamId: TEAM2, strategy: "unit_split", seed: 3 });
    const pooled = await propose({ teamId: TEAM2, strategy: "pooled_nights", seed: 3 });

    // Unit III has three residents of its own; the department has nine.
    expect(split.fairness).toHaveLength(3);
    expect(pooled.fairness.length).toBeGreaterThan(3);

    // The same month, and the pooled rota asks far less of each person.
    const worst = (f: readonly { nights: number }[]): number => Math.max(...f.map((x) => x.nights));
    expect(worst(pooled.fairness)).toBeLessThan(worst(split.fairness));
  });
});
