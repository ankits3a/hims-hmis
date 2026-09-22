import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../helpers/db";
import { withTx } from "../../src/kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterPositions,
  rosterTeams, staffAbsences, users,
} from "../../src/kernel/db/schema";
import {
  ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, addMembership, fairnessSpread,
  periodWithAssignments, proposeMonth, seedRosterRules, validate,
} from "../../src/modules/roster";
import type { Db } from "../../src/kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { ProposalStrategy } from "../../src/modules/roster";

/**
 * PHASE R (R9) — **THE EVALUATION HARNESS: A MONTH REPLAYED, WITH THE SICK CALLS.**
 *
 * The proposer's own suite asks whether one drafted month is legal. This asks the question a head
 * actually has, which is what happens to that month when the month happens to it: three residents
 * call in sick on three different days, somebody's leave is approved late, and the rota has to be
 * re-cut. A proposer that produced a beautiful rota once and a worse one every time reality touched
 * it would be useless, and nothing in a single-draft test could tell.
 *
 * ═══ THE THREE PROPERTIES, AND WHY EACH IS HERE ═══
 *
 *   1. **It never publishes.** Every period this harness produces, across every scenario and every
 *      replay, is still a `draft` at the end. The matrix forbids a machine to publish; this is that
 *      forbidding, executed rather than asserted about a policy table.
 *   2. **A replay never makes the rota WORSE.** After a sick call, the re-draft must carry no more
 *      *violations* — rest, night frequency — than the draft before it. It may well carry more
 *      HOLES, and that is not a regression: it is the truthful consequence of having fewer people,
 *      and the distinction between those two is the entire design of the proposer.
 *   3. **It is deterministic.** Same scenario, same seed, same rota — twice, from a clean database.
 *      Without this the other two are unfalsifiable: any green could be the luck of a shuffle.
 *
 * ═══ RUN UNDER THE LOCK, LIKE EVERY OTHER POOL ═══
 *
 * This is an ordinary jest suite in `test/`, so `$L run <lane> … jest test/` covers it and CI runs
 * it with everything else. It deliberately does NOT get a runner of its own: a harness nobody runs
 * is a harness that rots, and this one is cheap because the scenarios are small on purpose.
 */
describe("roster-sim — a month replayed, with the sick calls (R9)", () => {
  const MS = "01USER00000000000000000MS";
  const MED = "01ORGDEPT000000000000MED";
  const TEAM = "01ROSTERTEAM00000MEDU2";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const NOV = { startsAt: at("2026-11-01T00:00"), endsAt: at("2026-12-01T00:00") };

  const ms: Actor = { type: "user", id: MS };
  const machine: Actor = { type: "system", id: "roster-proposer" };

  /** The violation rules — the ones a REPLAY must never make worse. Holes are not violations. */
  const VIOLATIONS = ["rest_after_duty", "night_one_in_three", "slot_over_24h"];

  type Scenario = {
    readonly name: string;
    readonly residents: number;
    readonly strategy: ProposalStrategy;
    /** `[istDate, residentIndex]` — somebody calls in sick for the rest of the month. */
    readonly sickCalls: readonly (readonly [string, number])[];
  };

  /**
   * GOLDEN SCENARIOS — 20-U §8 and the brainstorm's §9, reduced to the smallest shape that still
   * distinguishes a working proposer from a broken one.
   */
  const SCENARIOS: readonly Scenario[] = [
    {
      name: "a six-resident unit, nights its own — the ordinary month",
      residents: 6, strategy: "unit_split", sickCalls: [],
    },
    {
      name: "the same unit, one resident sick from the 10th",
      residents: 6, strategy: "unit_split", sickCalls: [["2026-11-10", 0]],
    },
    {
      name: "…and a second from the 18th, which is when a rota usually breaks",
      residents: 6, strategy: "unit_split", sickCalls: [["2026-11-10", 0], ["2026-11-18", 1]],
    },
    {
      name: "a four-resident unit — at the edge of one night in three",
      residents: 4, strategy: "unit_split", sickCalls: [],
    },
    {
      name: "a four-resident unit drawing on the department's night pool",
      residents: 4, strategy: "pooled_nights", sickCalls: [],
    },
  ];

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const residentId = (i: number): string => `01USERSIM0000000000000${String(i).padStart(2, "0")}`;

  const seedHospital = async (residents: number): Promise<void> => {
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
    await db.insert(orgDepartments).values({
      id: MED, code: "MED", name: "General Medicine", kind: "clinical", admitting: true,
      createdBy: "t", updatedBy: "t",
    });
    await db.insert(rosterPositions).values({
      key: "ward_jr", label: "Ward junior resident", cadre: "junior_resident", ladderRank: 2,
      eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t",
    });
    await db.insert(users).values({ id: MS, username: "ms", fullName: "MS", staffCode: "EMP-MS", passwordHash: "x" });
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
    await db.insert(rosterTeams).values({
      id: TEAM, departmentId: MED, code: "MED-U2", name: "Medicine Unit II", kind: "clinical_unit",
      createdBy: "t", updatedBy: "t",
    });
    for (let i = 0; i < residents; i += 1) {
      const id = residentId(i);
      await db.insert(users).values({ id, username: `sim${i}`, fullName: `Sim ${i}`, staffCode: `EMP-S${i}`, passwordHash: "x" });
      await db.insert(roleAssignments).values({ id: `RA-S${i}`, userId: id, roleKey: "doctor", scopeType: "hospital", scopeId: null });
      await withTx(db, (tx) => addMembership(tx, ms, {
        teamId: TEAM, userId: id, positionKey: "ward_jr", grade: "jr2",
        roleInTeam: "junior_resident", kind: "parent", startsAt: at("2026-01-01T00:00"),
      }));
    }
    await seedRosterRules(db, "t");
  };

  const draftMonth = (strategy: ProposalStrategy, seed: number, title: string) =>
    withTx(db, (tx) => proposeMonth(tx, machine, {
      departmentId: MED, teamId: TEAM, title, strategy, seed,
      nightPositionKey: "ward_jr", ...NOV,
    }));

  const violationsOf = async (periodId: string): Promise<string[]> =>
    (await validate(db, periodId))
      .filter((f) => VIOLATIONS.includes(f.ruleKey))
      .map((f) => `${f.ruleKey}:${f.userId ?? ""}`)
      .sort();

  const shapeOf = async (periodId: string): Promise<string> => {
    const { assignments } = await periodWithAssignments(db, periodId);
    return assignments
      .map((a) => `${a.startsAt.toISOString()}|${a.userId ?? "VACANT"}`)
      .sort().join("\n");
  };

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s",
    async (_name, scenario) => {
      await seedHospital(Math.max(scenario.residents, 4));

      // ── the first cut of the month
      const first = await draftMonth(scenario.strategy, 11, "November — first cut");
      expect(first.nights).toBe(30); // November
      const before = await violationsOf(first.periodId);
      expect(before).toEqual([]); // the proposer never drafts a violation, staffing aside

      // ── reality happens
      for (const [istDate, who] of scenario.sickCalls) {
        await db.insert(staffAbsences).values({
          id: `01ABSSIM${istDate.replace(/-/g, "")}${who}`.padEnd(26, "0").slice(0, 26),
          userId: residentId(who), kind: "CL",
          startsAt: at(`${istDate}T00:00`), endsAt: NOV.endsAt,
          status: "approved", requestedBy: residentId(who), approvedBy: MS,
          decidedAt: at("2026-10-30T10:00"), source: "manual", createdBy: "t", updatedBy: "t",
        });
      }

      // ── and the rota is re-cut against the world as it now is
      const replay = await draftMonth(scenario.strategy, 11, "November — replay");
      const after = await violationsOf(replay.periodId);

      // (2) A REPLAY NEVER MAKES IT WORSE. More holes are honest; more violations are not.
      expect(after).toEqual([]);
      expect(after.length).toBeLessThanOrEqual(before.length);

      // (1) NOTHING WAS PUBLISHED, by either cut.
      const statuses = await db.execute(sql`select distinct status from roster_periods`);
      expect((statuses.rows as { status: string }[]).map((r) => r.status)).toEqual(["draft"]);

      // Fairness survives the replay: nobody is carrying the whole month.
      expect(fairnessSpread(replay.fairness)).toBeLessThanOrEqual(2);
    },
  );

  it("is deterministic: the same scenario and seed give the same rota from a clean database", async () => {
    await seedHospital(6);
    const a = await draftMonth("unit_split", 42, "November — run A");
    const shapeA = await shapeOf(a.periodId);

    await seedHospital(6); // a genuinely clean database, not a second draft beside the first
    const b = await draftMonth("unit_split", 42, "November — run B");
    expect(await shapeOf(b.periodId)).toEqual(shapeA);

    await seedHospital(6);
    const c = await draftMonth("unit_split", 43, "November — run C");
    // …and the seed is doing something, or the leg above proves nothing.
    expect(await shapeOf(c.periodId)).not.toEqual(shapeA);
  });
});
