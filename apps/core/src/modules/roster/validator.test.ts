import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, permissions, roleAssignments, rolePermissions, roles, rosterPositions,
  rosterRequirements, rosterTeams, staffAbsences, staffCredentials, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import { assign, draftPeriod, publishPeriod, unassign } from "./periods";
import { seedRosterRules } from "./rules";
import { templateFeasibility, validate } from "./validator";
import { simulate } from "./simulate";
import { acceptFinding, listFindings, recordFindings } from "./findings";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R8) — **THE VALIDATOR, AGAINST A REAL DATABASE.**
 *
 * The legs a reviewer should read first, because each is a claim the rest of the phase rests on:
 *
 *   · **S4, and it is arithmetic.** Three junior residents covering their own unit's nights is
 *     infeasible; the same three in a department pool is feasible. That single pair of numbers is
 *     the whole argument for pooling nights, and if it ever stops being true the roster's advice
 *     about unit strength is wrong.
 *   · **A block stops a publish and an ACCEPTED block does not** — the distinction the whole
 *     findings table exists for. Both legs, because only the pair shows the acceptance is doing
 *     the work rather than the rule having quietly stopped firing.
 *   · **`simulate()` writes nothing**, proved by counting rows before and after rather than by
 *     reading the function and believing it.
 *   · **An absence is `unavailable`, never its kind** — D6 surviving into the layer above.
 *   · **V16**: a supernumerary slot does not satisfy a requirement, and a vacant one is a hole.
 */
describe("roster — requirements, rules, the validator and simulate (R8)", () => {
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000000SR";
  const JR = "01USER00000000000000000JR";
  const JR2 = "01USER0000000000000000JR2";
  const MED = "01ORGDEPT000000000000MED";
  const TEAM = "01ROSTERTEAM00000MEDU2";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = { startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00") };

  const ms: Actor = { type: "user", id: MS };

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
      { key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
      { key: "ward_jr", label: "Ward junior resident", cadre: "junior_resident", ladderRank: 2, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
      { key: "intern", label: "Intern", cadre: "intern", ladderRank: 1, eligibleRoleKey: null, maxPresenceHours: 24, countsTowardRequirements: false, createdBy: "t", updatedBy: "t" },
      // A post whose OWN cap is looser than the hospital-wide line. R2 refuses a presence window
      // past `max_presence_hours`, so this is the only shape in which `slot_over_24h` is reachable
      // at all — and building the fixture is what proved that.
      { key: "duty_manager", label: "Duty manager", cadre: "medical_officer", ladderRank: 4, eligibleRoleKey: "doctor", maxPresenceHours: 36, createdBy: "t", updatedBy: "t" },
    ]);
    for (const [id, username] of [[MS, "sunita.mishra"], [SR, "kavita.rao"], [JR, "sandeep.yadav"], [JR2, "asha.kumari"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-SR", userId: SR, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-JR", userId: JR, roleKey: "doctor", scopeType: "hospital", scopeId: null },
      { id: "RA-JR2", userId: JR2, roleKey: "doctor", scopeType: "hospital", scopeId: null },
    ]);
    await db.insert(rosterTeams).values([
      { id: TEAM, departmentId: MED, code: "MED-U2", name: "Medicine Unit II", kind: "clinical_unit", createdBy: "t", updatedBy: "t" },
    ]);
    await seedRosterRules(db, "t");
  });

  /* ═══════════════════════════════ helpers ═══════════════════════════════ */

  const draft = (over: { coversPositions?: string[] } = {}) => withTx(db, (tx) => draftPeriod(tx, ms, {
    scopeType: "team", scopeId: "MED-U2", departmentId: MED, title: "October — Medicine Unit II",
    coversPositions: ["unit_sr", "ward_jr"], ...OCT, ...over,
  }));

  /** A 30-hour duty PRESENT ON SITE — the one shape `slot_over_24h` blocks. */
  const overLongDraft = async () => {
    const p = await draft({ coversPositions: ["unit_sr", "ward_jr", "duty_manager"] });
    const a = await slot(p.periodId, {
      userId: SR, positionKey: "duty_manager", mode: "presence",
      startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-13T14:00"),
    });
    return { periodId: p.periodId, assignmentId: a.assignmentId };
  };

  const slot = (periodId: string, over: Partial<Parameters<typeof assign>[3]> = {}) =>
    withTx(db, (tx) => assign(tx, ms, periodId, {
      userId: SR, positionKey: "unit_sr", departmentId: MED, teamId: TEAM,
      startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-12T16:00"), ...over,
    }));

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  /** Read back from the row rather than from the call's return: it is the roster that must have moved. */
  const statusOf = async (periodId: string): Promise<string> => {
    const r = await db.execute(sql`select status from roster_periods where id = ${periodId}`);
    return (r.rows[0] as { status: string }).status;
  };

  const codes = (findings: readonly { ruleKey: string }[]): string[] =>
    [...new Set(findings.map((f) => f.ruleKey))].sort();

  /* ═══════════════════════════ S4 — feasibility is arithmetic ═══════════════════════════ */

  it("S4: three junior residents cannot cover their own unit's nights, and pooled they can", () => {
    const unitOnly = templateFeasibility({ residents: 3 });
    const pooled = templateFeasibility({ residents: 3, poolSize: 12 });

    // Unit-only: every third night, 16 hours each, on top of six day shifts.
    expect(unitOnly.feasible).toBe(false);
    expect(unitOnly.hoursPerWeek).toBeGreaterThan(74);
    expect(unitOnly.nightsPerWeek).toBeCloseTo(2.33, 1);

    // The same three residents, nights shared across the department's twelve.
    expect(pooled.feasible).toBe(true);
    expect(pooled.hoursPerWeek).toBeLessThan(74);

    // The residents per unit did not change. Only where the nights came from did.
    expect(unitOnly.residentsPerUnit).toBe(3);
    expect(pooled.residentsPerUnit).toBe(3);
  });

  it("feasibility answers in the two units a head thinks in, and honours a moved limit", () => {
    const f = templateFeasibility({ residents: 5, limitHours: 48 });
    expect(f.limitHours).toBe(48);
    expect(f.feasible).toBe(false); // 48 is the sub judice figure; almost nothing clears it
    expect(templateFeasibility({ residents: 5 }).feasible).toBe(true); // …and 74 does
  });

  /* ═══════════════════════════ the rules, red and green ═══════════════════════════ */

  it("slot_over_24h: a 30-hour duty is a BLOCK, and a 16-hour one is not", async () => {
    const red = await overLongDraft();
    const redFindings = await validate(db, red.periodId);
    const over = redFindings.filter((f) => f.ruleKey === "slot_over_24h");
    expect(over).toHaveLength(1);
    expect(over[0]!.severity).toBe("block");
    expect(over[0]!.params.hours).toBe(30);

    const green = await draft();
    await slot(green.periodId, { startsAt: at("2026-10-12T16:00"), endsAt: at("2026-10-13T08:00") });
    expect(codes(await validate(db, green.periodId))).not.toContain("slot_over_24h");
  });

  it("rest_after_duty: six hours between duties is a finding, and sixteen is not", async () => {
    const red = await draft();
    await slot(red.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await slot(red.periodId, { startsAt: at("2026-10-13T14:00"), endsAt: at("2026-10-13T20:00") });
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "rest_after_duty");
    expect(f).toHaveLength(1);
    expect(f[0]!.params.restHours).toBe(6);
    expect(f[0]!.userId).toBe(SR);
    // doc 10 §3.9 rules this a HARD BLOCK with an evented HOD override — not a warning.
    expect(f[0]!.severity).toBe("block");

    const green = await draft();
    await slot(green.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await slot(green.periodId, { startsAt: at("2026-10-14T00:00"), endsAt: at("2026-10-14T08:00") });
    expect(codes(await validate(db, green.periodId))).not.toContain("rest_after_duty");
  });

  it("night_one_in_three: nights two days apart are a finding, three days apart are not", async () => {
    const red = await draft();
    // Nights beginning on the 12th and the 14th — two days apart, where the rule asks for three.
    await slot(red.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await slot(red.periodId, { startsAt: at("2026-10-14T20:00"), endsAt: at("2026-10-15T08:00") });
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "night_one_in_three");
    expect(f).toHaveLength(1);
    expect(f[0]!.params.gapDays).toBe(2);

    const green = await draft();
    for (const [s, e] of [["2026-10-12T20:00", "2026-10-13T08:00"], ["2026-10-15T20:00", "2026-10-16T08:00"]] as const) {
      await slot(green.periodId, { startsAt: at(s), endsAt: at(e) });
    }
    expect(codes(await validate(db, green.periodId))).not.toContain("night_one_in_three");
  });

  it("weekly_hours_74: a fortnight of 16-hour days is a finding; an ordinary week is not", async () => {
    const red = await draft();
    for (let d = 5; d <= 12; d += 1) {
      await slot(red.periodId, {
        startsAt: at(`2026-10-${String(d).padStart(2, "0")}T06:00`),
        endsAt: at(`2026-10-${String(d).padStart(2, "0")}T22:00`),
      });
    }
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "weekly_hours_74");
    expect(f.length).toBeGreaterThan(0);
    expect(Number(f[0]!.params.weekHours)).toBeGreaterThan(74);

    const green = await draft();
    for (let d = 5; d <= 10; d += 1) {
      await slot(green.periodId, {
        startsAt: at(`2026-10-${String(d).padStart(2, "0")}T09:00`),
        endsAt: at(`2026-10-${String(d).padStart(2, "0")}T17:00`),
      });
    }
    expect(codes(await validate(db, green.periodId))).not.toContain("weekly_hours_74");
  });

  it("weekly_off: seven straight days on duty is a finding, six is not", async () => {
    const red = await draft();
    for (let d = 5; d <= 11; d += 1) {
      await slot(red.periodId, {
        startsAt: at(`2026-10-${String(d).padStart(2, "0")}T09:00`),
        endsAt: at(`2026-10-${String(d).padStart(2, "0")}T15:00`),
      });
    }
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "weekly_off");
    expect(f).toHaveLength(1); // said once per person, not once per day
    expect(f[0]!.userId).toBe(SR);

    const green = await draft();
    for (let d = 5; d <= 10; d += 1) {
      await slot(green.periodId, {
        startsAt: at(`2026-10-${String(d).padStart(2, "0")}T09:00`),
        endsAt: at(`2026-10-${String(d).padStart(2, "0")}T15:00`),
      });
    }
    expect(codes(await validate(db, green.periodId))).not.toContain("weekly_off");
  });

  it("unit_min_jr: one JR on a working unit is a finding, two are not", async () => {
    const red = await draft();
    await slot(red.periodId, { userId: JR, positionKey: "ward_jr" });
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "unit_min_jr");
    expect(f).toHaveLength(1);
    expect(f[0]!.params).toMatchObject({ teamId: TEAM, present: 1, minCount: 2 });

    const green = await draft();
    await slot(green.periodId, { userId: JR, positionKey: "ward_jr" });
    await slot(green.periodId, { userId: JR2, positionKey: "ward_jr" });
    expect(codes(await validate(db, green.periodId))).not.toContain("unit_min_jr");
  });

  it("rostered_while_absent: approved leave against a planned duty, and the KIND never travels", async () => {
    await db.insert(staffAbsences).values({
      id: "01ABS000000000000000001", userId: SR, kind: "ML",
      startsAt: at("2026-10-10T00:00"), endsAt: at("2026-10-15T00:00"),
      status: "approved", reason: "under treatment at Patna", requestedBy: SR, approvedBy: MS,
      decidedAt: at("2026-09-20T10:00"),
      source: "manual", createdBy: "t", updatedBy: "t",
    });
    const red = await draft();
    await slot(red.periodId);
    const f = (await validate(db, red.periodId)).filter((x) => x.ruleKey === "rostered_while_absent");
    expect(f).toHaveLength(1);
    expect(f[0]!.userId).toBe(SR);

    // D6 — neither the kind nor the reason may travel in a finding anybody can read. Asserted on
    // the SHAPE as well as the text: a `kind` key must not exist at all, so a future edit cannot
    // reintroduce it under a value this test happens not to grep for.
    expect(Object.keys(f[0]!.params)).not.toContain("kind");
    expect(JSON.stringify(f)).not.toContain("Patna");
  });

  /* ═══════════════════════════ V16 — what counts as cover ═══════════════════════════ */

  it("V16: a supernumerary slot does not satisfy a requirement, and a vacant one is a hole", async () => {
    await db.insert(rosterRequirements).values({
      id: "01REQ0000000000000000001", scopeType: "team", scopeId: TEAM, positionKey: "ward_jr",
      dayClass: "any", minCount: 2, basis: "fixed", authority: "nmc",
      citation: "NMC UG-MSR 2023", validFrom: "2026-01-01", createdBy: "t", updatedBy: "t",
    });

    // Two JRs on the unit — but one is supernumerary and the other slot is vacant.
    const period = await draft();
    await slot(period.periodId, { userId: JR, positionKey: "ward_jr", supernumerary: true });
    await slot(period.periodId, { userId: null, positionKey: "ward_jr" });

    const f = (await validate(db, period.periodId))
      .filter((x) => x.ruleKey === "requirement_shortfall");
    expect(f).toHaveLength(1);
    // R-067: staffing ratios are roster GATES — a violating roster does not publish.
    expect(f[0]!.severity).toBe("block");
    // Two slots, and cover of NONE: the supernumerary does not relieve the establishment and the
    // vacancy is the hole the requirement exists to find.
    expect(f[0]!.params).toMatchObject({
      present: 0, minCount: 2, supernumerary: 1, vacant: 1,
      authority: "nmc", citation: "NMC UG-MSR 2023",
    });

    // …and two ordinary JRs satisfy it.
    const green = await draft();
    await slot(green.periodId, { userId: JR, positionKey: "ward_jr" });
    await slot(green.periodId, { userId: JR2, positionKey: "ward_jr" });
    expect(codes(await validate(db, green.periodId))).not.toContain("requirement_shortfall");
  });

  it("an emptiness cannot read green: a requirement over a scope with nothing rostered is silent", async () => {
    await db.insert(rosterRequirements).values({
      id: "01REQ0000000000000000002", scopeType: "team", scopeId: TEAM, positionKey: "ward_jr",
      dayClass: "any", minCount: 2, basis: "fixed", authority: "institution",
      validFrom: "2026-01-01", createdBy: "t", updatedBy: "t",
    });
    const period = await draft();
    // An SR is rostered; no JR slot exists at all on this unit.
    await slot(period.periodId);
    const f = (await validate(db, period.periodId))
      .filter((x) => x.ruleKey === "requirement_shortfall");
    // The requirement says nothing, because the population it speaks about is not there. A check
    // that reported "0 of 2" here would report it for every unit in the hospital on every day it
    // does not work, and nobody would read any of them.
    expect(f).toHaveLength(0);
  });

  /* ═══════════════════════════ the publish gate ═══════════════════════════ */

  it("a BLOCK stops the publish and names every blocking code at once", async () => {
    const period = await overLongDraft();

    const e = await refusal(withTx(db, (tx) => publishPeriod(tx, ms, period.periodId)));
    expect(e.code).toBe("blocked_by_findings");
    expect((e.detail as { codes: string[] }).codes).toEqual(["slot_over_24h"]);
  });

  it("…and an ACCEPTED block does not — which is what the findings table is for", async () => {
    const period = await overLongDraft();

    // First it refuses.
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, period.periodId)))).code)
      .toBe("blocked_by_findings");

    // A named human records the findings and takes responsibility for the blocking one.
    await withTx(db, (tx) => recordFindings(tx, ms, period.periodId));
    const stored = await listFindings(db, period.periodId);
    const block = stored.find((r) => r.ruleKey === "slot_over_24h")!;
    await withTx(db, (tx) => acceptFinding(tx, ms, block.id, "consultant cover arranged, MS informed"));

    // Now it publishes — and the acceptance is still on the record afterwards.
    await withTx(db, (tx) => publishPeriod(tx, ms, period.periodId));
    expect(await statusOf(period.periodId)).toBe("published");
    const after = await listFindings(db, period.periodId);
    const kept = after.find((r) => r.ruleKey === "slot_over_24h")!;
    expect(kept.acceptedBy).toBe(MS);
    expect(kept.acceptReason).toBe("consultant cover arranged, MS informed");
    expect(kept.acceptedAt).not.toBeNull();
  });

  it("the override is EVENTED — doc 10 §3.9 asks for it, and the reason does not travel (V9)", async () => {
    const period = await overLongDraft();
    await withTx(db, (tx) => recordFindings(tx, ms, period.periodId));
    const block = (await listFindings(db, period.periodId)).find((r) => r.ruleKey === "slot_over_24h")!;
    await withTx(db, (tx) => acceptFinding(tx, ms, block.id, "night administrator on site all shift"));

    const rows = await db.execute(sql`
      select name, payload::text as payload from events where name = 'roster.finding_accepted'
    `);
    expect(rows.rows).toHaveLength(1);
    const payload = (rows.rows[0] as { payload: string }).payload;
    expect(payload).toContain("slot_over_24h");
    expect(payload).toContain(block.id);
    // V9 — ids, codes and instants only. The acceptance REASON stays in the row, where the
    // hospital's access rules cover it, and never enters a log a summariser may read.
    expect(payload).not.toContain("night administrator on site all shift");
  });

  it("a WARN never stopped it in the first place", async () => {
    const period = await draft();
    // One JR on a working unit: a real finding, and not one that stops a hospital publishing.
    await slot(period.periodId, { userId: JR, positionKey: "ward_jr" });
    const findings = await validate(db, period.periodId);
    expect(codes(findings)).toContain("unit_min_jr");
    expect(findings.every((f) => f.severity !== "block")).toBe(true);

    await withTx(db, (tx) => publishPeriod(tx, ms, period.periodId));
    expect(await statusOf(period.periodId)).toBe("published");
  });

  it("an acceptance without a reason is refused, and a second acceptance does not overwrite the first", async () => {
    const period = await overLongDraft();
    await withTx(db, (tx) => recordFindings(tx, ms, period.periodId));
    const block = (await listFindings(db, period.periodId)).find((r) => r.ruleKey === "slot_over_24h")!;

    expect((await refusal(withTx(db, (tx) => acceptFinding(tx, ms, block.id, "   ")))).code)
      .toBe("invalid_window");
    await withTx(db, (tx) => acceptFinding(tx, ms, block.id, "first reason"));
    expect((await refusal(withTx(db, (tx) => acceptFinding(tx, ms, block.id, "second reason")))).code)
      .toBe("finding_already_accepted");
    const kept = (await listFindings(db, period.periodId)).find((r) => r.ruleKey === "slot_over_24h")!;
    expect(kept.acceptReason).toBe("first reason");
  });

  it("a finding the next draft no longer produces is CLEARED, not deleted", async () => {
    const period = await overLongDraft();
    await withTx(db, (tx) => recordFindings(tx, ms, period.periodId));
    expect((await listFindings(db, period.periodId)).some((r) => r.ruleKey === "slot_over_24h")).toBe(true);

    await withTx(db, (tx) => unassign(tx, ms, period.assignmentId));
    const again = await withTx(db, (tx) => recordFindings(tx, ms, period.periodId));
    expect(again.cleared).toBeGreaterThan(0);
    expect((await listFindings(db, period.periodId)).some((r) => r.ruleKey === "slot_over_24h")).toBe(false);
    // …and the row is still there, carrying what the roster used to be wrong about.
    expect((await listFindings(db, period.periodId, { includeCleared: true }))
      .some((r) => r.ruleKey === "slot_over_24h")).toBe(true);
  });

  /**
   * THE GATE'S ORDERING, PINNED IN THE SOURCE — and the reason it is pinned this way.
   *
   * Plan §7's first judgement call says the validator must run in `publishPeriods` step (2), with
   * the refusals decided from the drafts alone, BEFORE step (3) takes the live version out of
   * effect. A mutant that moved the call after the supersede was built, and it **survived the
   * whole roster suite, 251 of 251 green** — because both orders roll back, so inside one
   * transaction the difference is genuinely unobservable from outside.
   *
   * That is precisely why it needs a STRUCTURAL guard rather than a behavioural one. The ordering
   * is not protecting against a bug anybody can provoke today; it protects the next reader, who
   * would otherwise reorder these steps for tidiness and produce a gate that un-effects a live
   * roster before deciding whether to refuse it — correct only by virtue of the rollback, and one
   * swallowed error away from not being correct at all.
   */
  it("the gate validates BEFORE it supersedes — pinned in the source, because a rollback hides it", () => {
    const src = readFileSync(join(__dirname, "periods.ts"), "utf8");
    const publish = src.slice(src.indexOf("export async function publishPeriods"));

    const validateAt = publish.indexOf("await validate(tx, period.id)");
    const supersedeAt = publish.indexOf("set({ effective: false");
    const intoEffectAt = publish.indexOf("set({ effective: true");

    // All three must be FOUND, or this test is asserting about text it never located — an empty
    // search reading as a pass is the failure mode a source-scanning test has.
    expect(validateAt).toBeGreaterThan(-1);
    expect(supersedeAt).toBeGreaterThan(-1);
    expect(intoEffectAt).toBeGreaterThan(-1);

    expect(`validate before supersede: ${validateAt < supersedeAt}`)
      .toBe("validate before supersede: true");
    expect(`validate before into-effect: ${validateAt < intoEffectAt}`)
      .toBe("validate before into-effect: true");
  });

  /* ═══════════════════════════ simulate ═══════════════════════════ */

  const rowCounts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of ["roster_periods", "roster_assignments", "roster_findings", "events"]) {
      const r = await db.execute(sql`select count(*)::int as n from ${sql.identifier(t)}`);
      out[t] = (r.rows[0] as { n: number }).n;
    }
    return out;
  };

  it("simulate writes NOTHING, and is the same answer twice", async () => {
    const period = await draft();
    await slot(period.periodId, { userId: JR, positionKey: "ward_jr" });
    const vacancy = await slot(period.periodId, {
      userId: null, positionKey: "ward_jr",
      startsAt: at("2026-10-13T08:00"), endsAt: at("2026-10-13T16:00"),
    });

    const before = await rowCounts();
    const first = await simulate(db, period.periodId, [], {
      forAssignmentId: vacancy.assignmentId, pool: [JR, JR2],
    });
    const second = await simulate(db, period.periodId, [], {
      forAssignmentId: vacancy.assignmentId, pool: [JR, JR2],
    });
    const after = await rowCounts();

    // Not one row, in any table this module writes to — asserted, not intended.
    expect(after).toEqual(before);
    // Same input, same output.
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it("simulate's excluded reason is a RULE CODE, and an absence is `unavailable` and nothing more", async () => {
    await db.insert(staffAbsences).values({
      id: "01ABS000000000000000002", userId: JR2, kind: "maternity",
      startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00"),
      status: "approved", reason: "expecting in October", requestedBy: JR2, approvedBy: MS,
      decidedAt: at("2026-09-20T10:00"),
      source: "manual", createdBy: "t", updatedBy: "t",
    });
    const period = await draft();
    const vacancy = await slot(period.periodId, {
      userId: null, positionKey: "ward_jr",
      startsAt: at("2026-10-13T08:00"), endsAt: at("2026-10-13T16:00"),
    });

    const res = await simulate(db, period.periodId, [], {
      forAssignmentId: vacancy.assignmentId, pool: [JR, JR2],
    });

    const jr2 = res.excluded.find((x) => x.userId === JR2);
    expect(jr2).toBeDefined();
    expect(jr2!.reason).toBe("unavailable");

    // The one thing this must never do: say WHY she is away.
    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain("maternity");
    expect(serialised).not.toContain("expecting");

    // Every reason given is a code from the hospital's own vocabulary, never prose.
    for (const x of res.excluded) {
      expect(x.reason).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("simulate names the person who CAN take the slot", async () => {
    const period = await draft();
    const vacancy = await slot(period.periodId, {
      userId: null, positionKey: "ward_jr",
      startsAt: at("2026-10-13T08:00"), endsAt: at("2026-10-13T16:00"),
    });
    const res = await simulate(db, period.periodId, [], {
      forAssignmentId: vacancy.assignmentId, pool: [JR],
    });
    expect(res.candidates).toEqual([JR]);
    expect(res.excluded).toEqual([]);
  });

  it("somebody already on duty in that window is excluded as presence_overlap, not as a rule break", async () => {
    const period = await draft();
    await slot(period.periodId, {
      userId: JR, positionKey: "ward_jr",
      startsAt: at("2026-10-13T06:00"), endsAt: at("2026-10-13T12:00"),
    });
    const vacancy = await slot(period.periodId, {
      userId: null, positionKey: "ward_jr",
      startsAt: at("2026-10-13T08:00"), endsAt: at("2026-10-13T16:00"),
    });
    const res = await simulate(db, period.periodId, [], {
      forAssignmentId: vacancy.assignmentId, pool: [JR],
    });
    expect(res.excluded).toEqual([{ userId: JR, reason: "presence_overlap" }]);
    expect(res.candidates).toEqual([]);
  });

  /* ═══════════════════════════ the book itself ═══════════════════════════ */

  it("the seeded book carries its authorities, and NOT ONE `state` row (owner, 2026-09-21)", async () => {
    const rows = await db.execute(sql`select key, severity, authority, citation from roster_rules order by key`);
    const book = rows.rows as { key: string; severity: string; authority: string; citation: string | null }[];
    expect(book.length).toBeGreaterThan(0);

    // The owner's ruling: the vocabulary must be able to hold `state`, and the book must not use it.
    expect(book.every((r) => r.authority !== "state")).toBe(true);

    // The two rulings already inside the book.
    const seventyFour = book.find((r) => r.key === "weekly_hours_74")!;
    expect(seventyFour.authority).toBe("nmc_recommended");
    const directive = book.find((r) => r.key === "shift_12h_week_48h")!;
    expect(directive.authority).toBe("central_directive");
    expect(directive.severity).toBe("warn"); // sub judice — it warns, it does not block
    expect(directive.citation).toContain("27.10.2026");

    // A weekly off is a warn with a reason, never a block: PGMER says "subject to exigencies".
    expect(book.find((r) => r.key === "weekly_off")!.severity).toBe("warn");

    // THE TWO SEVERITIES THAT ARE RULINGS, NOT DESIGN CHOICES. An earlier draft of the book had
    // both of these as warns, reasoned from first principles. They are pinned here so the next
    // person to find that reasoning persuasive has to come and read the ruling first.
    // R-067 — staffing ratios are roster gates, a violating roster does not publish.
    expect(book.find((r) => r.key === "requirement_shortfall")!.severity).toBe("block");
    // doc 10 §3.9 — post-night rest >= 12 h, hard block, HOD override evented.
    expect(book.find((r) => r.key === "rest_after_duty")!.severity).toBe("block");

    // And the column can still hold a `state` rule when somebody has actually read one.
    await db.execute(sql`
      insert into roster_rules (key, label, severity, authority, applies_to, params, created_by, updated_by)
      values ('state_probe', 'a probe', 'info', 'state', '{}', '{}', 't', 't')
    `);
    const probed = await db.execute(sql`select authority from roster_rules where key = 'state_probe'`);
    expect((probed.rows[0] as { authority: string }).authority).toBe("state");
  });

  it("seeding twice adds nothing the second time", async () => {
    const again = await seedRosterRules(db, "t");
    expect(again.added).toBe(0);
    expect(again.present).toBeGreaterThan(0);
  });

  it("a department profile moves a rule's NUMBERS and leaves its authority alone", async () => {
    const period = await draft();
    // Two nights two days apart — a finding under the standing one-in-three.
    await slot(period.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await slot(period.periodId, { startsAt: at("2026-10-14T20:00"), endsAt: at("2026-10-15T08:00") });
    expect(codes(await validate(db, period.periodId))).toContain("night_one_in_three");

    // A lean period approved for this department: one night in two, for October only.
    await db.execute(sql`
      insert into roster_rule_profiles
        (id, department_id, rule_key, params, reason, valid_from, valid_to, approved_by, created_by, updated_by)
      values ('01PROF00000000000000001', ${MED}, 'night_one_in_three', '{"oneInN": 2}',
              'four residents at the national conference', '2026-10-01', '2026-10-31', ${MS}, 't', 't')
    `);
    expect(codes(await validate(db, period.periodId))).not.toContain("night_one_in_three");
  });
});
