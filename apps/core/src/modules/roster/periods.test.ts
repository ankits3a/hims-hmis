import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  events, orgDepartments, permissions, roleAssignments, rolePermissions, roles,
  rosterAssignments, rosterPeriods, rosterPositions, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import {
  amend, asKnownAt, assign, contentHash, draftPeriod, effectiveDrift, periodWithAssignments,
  presenceClashes,
  publishPeriod, publishPeriods, unassign,
} from "./periods";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R2) — drafting, filling, publishing and AMENDING a roster, against a real database.
 *
 * The four legs a reviewer should read first are the four the stress test bought, because each is a
 * defect that Plan 20 T1 shipped and no test of T1's could see:
 *
 *   · **`stale_base`** — S2(a)'s lost update. Two people draft from v1; one publishes; the other's
 *     publish would silently discard the first's work. T1 had no error for this and no column to
 *     detect it with.
 *   · **`draft_changed_since_review`** — V4. "What the human reviewed is what goes live" was an
 *     intention until something compared the two.
 *   · **the same-night cross-unit swap** — S2(b). It cannot be published one roster at a time in
 *     EITHER order, so the test publishes both orders singly, watches both fail, and then watches
 *     the list form succeed. A test that only showed the success would not show why the API needs
 *     a list at all.
 *   · **the amendment and `asKnownAt`** — the two time axes. The duty at 03:10 and what the roster
 *     SAID about 03:10 are different questions, and a system that can only answer the second as of
 *     now cannot answer an inquiry.
 */
describe("roster — periods, the publication gate and amendments (R2)", () => {
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000000SR";
  const JR = "01USER00000000000000000JR";
  const JR2 = "01USER0000000000000000JR2";
  const MED = "01ORGDEPT000000000000MED";
  const SUR = "01ORGDEPT000000000000SUR";
  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const OCT = { startsAt: at("2026-10-01T00:00"), endsAt: at("2026-11-01T00:00") };

  const ms: Actor = { type: "user", id: MS };
  const machine: Actor = { type: "system", id: "roster-proposer" };

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
      { id: SUR, code: "SUR", name: "General Surgery", kind: "clinical", admitting: true, createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(rosterPositions).values([
      { key: "unit_sr", label: "Unit senior resident", cadre: "senior_resident", ladderRank: 3, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
      { key: "ward_jr", label: "Ward junior resident", cadre: "junior_resident", ladderRank: 2, eligibleRoleKey: "doctor", maxPresenceHours: 24, createdBy: "t", updatedBy: "t" },
      { key: "intern", label: "Intern", cadre: "intern", ladderRank: 1, eligibleRoleKey: null, maxPresenceHours: 24, countsTowardRequirements: false, createdBy: "t", updatedBy: "t" },
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
  });

  /* ═══════════════════════════════ helpers ═══════════════════════════════ */

  const draft = (over: Partial<Parameters<typeof draftPeriod>[2]> = {}) =>
    withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "team", scopeId: "MED-U2", departmentId: MED, title: "October — Medicine Unit II",
      coversPositions: ["unit_sr", "ward_jr"], ...OCT, ...over,
    }));

  const slot = (periodId: string, over: Partial<Parameters<typeof assign>[3]> = {}) =>
    withTx(db, (tx) => assign(tx, ms, periodId, {
      userId: SR, positionKey: "unit_sr", departmentId: MED,
      startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-13T08:00"), ...over,
    }));

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  const eventNames = async (): Promise<string[]> =>
    (await db.select({ name: events.name }).from(events).orderBy(events.seq)).map((r) => r.name);

  /* ═══════════════════════════════ drafting ═══════════════════════════════ */

  it("drafts version 1, then version 2 beside it, and numbers them inside the series", async () => {
    const v1 = await draft();
    expect(v1.version).toBe(1);
    const v2 = await draft();
    expect(v2.version).toBe(2);
    // a different team's October is a different series
    const other = await draft({ scopeId: "MED-U3" });
    expect(other.version).toBe(1);
  });

  it("refuses a roster that answers for no position, or for one this hospital does not have", async () => {
    expect((await refusal(draft({ coversPositions: [] }))).code).toBe("invalid_window");
    expect((await refusal(draft({ coversPositions: ["registrar"] }))).code).toBe("unknown_position");
  });

  it("records the actor type and marks a HUMAN draft as touched; a machine draft is not", async () => {
    const human = await draft();
    const [h] = await db.select().from(rosterPeriods).where(eq(rosterPeriods.id, human.periodId));
    expect(h!.origin).toBe("human");
    expect(h!.draftedByActorType).toBe("user");
    expect(h!.humanTouchedAt).not.toBeNull();

    const proposed = await withTx(db, (tx) => draftPeriod(tx, machine, {
      scopeType: "team", scopeId: "MED-U9", departmentId: MED, title: "October — proposed",
      coversPositions: ["ward_jr"], ...OCT,
    }));
    const [m] = await db.select().from(rosterPeriods).where(eq(rosterPeriods.id, proposed.periodId));
    expect(m!.origin).toBe("machine");
    expect(m!.humanTouchedAt).toBeNull();
  });

  /* ═══════════════════════════════ V8, where it bites ═══════════════════════════════ */

  it("a machine may fill its OWN draft and may NEVER touch one a human has touched", async () => {
    const proposed = await withTx(db, (tx) => draftPeriod(tx, machine, {
      scopeType: "team", scopeId: "MED-U9", departmentId: MED, title: "October — proposed",
      coversPositions: ["ward_jr"], ...OCT,
    }));
    // untouched by a person: the machine may fill it
    await expect(withTx(db, (tx) => assign(tx, machine, proposed.periodId, {
      userId: JR, positionKey: "ward_jr", departmentId: MED,
      startsAt: at("2026-10-02T08:00"), endsAt: at("2026-10-02T20:00"),
    }))).resolves.toBeDefined();

    // a person edits it — and from that instant the machine is locked out of it
    await withTx(db, (tx) => assign(tx, ms, proposed.periodId, {
      userId: JR2, positionKey: "ward_jr", departmentId: MED,
      startsAt: at("2026-10-03T08:00"), endsAt: at("2026-10-03T20:00"),
    }));
    const e = await refusal(withTx(db, (tx) => assign(tx, machine, proposed.periodId, {
      userId: JR, positionKey: "ward_jr", departmentId: MED,
      startsAt: at("2026-10-04T08:00"), endsAt: at("2026-10-04T20:00"),
    })));
    expect(e.code).toBe("act_not_available_to_actor");
    expect(e.detail).toMatchObject({ act: "edit_human_draft", actorType: "system" });
  });

  it("no machine publishes, whatever it holds", async () => {
    const p = await draft();
    await slot(p.periodId);
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, machine, p.periodId)))).code)
      .toBe("act_not_available_to_actor");
  });

  /* ═══════════════════════════════ filling ═══════════════════════════════ */

  it("refuses a position this roster does not answer for", async () => {
    const p = await draft();
    const e = await refusal(slot(p.periodId, { positionKey: "intern" }));
    expect(e.code).toBe("position_not_covered");
    expect(e.detail).toMatchObject({ positionKey: "intern", covers: ["unit_sr", "ward_jr"] });
  });

  it("refuses somebody who does not hold the role the position answers as — and allows a position with none", async () => {
    const p = await draft({ coversPositions: ["unit_sr", "intern"] });
    const e = await refusal(slot(p.periodId, { userId: MS, positionKey: "unit_sr" }));
    expect(e.code).toBe("position_ineligible");
    expect(e.detail).toMatchObject({ requiredRoleKey: "doctor" });
    // `intern` has no eligible role: a pre-registration intern is not a registered practitioner
    await expect(slot(p.periodId, { userId: MS, positionKey: "intern" })).resolves.toBeDefined();
  });

  it("accepts a VACANT slot — a declared hole the validator can see", async () => {
    const p = await draft();
    const { assignmentId } = await slot(p.periodId, { userId: null });
    const [row] = await db.select().from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId));
    expect(row!.userId).toBeNull();
  });

  it("refuses a duty starting outside the period, and accepts one that ENDS outside it", async () => {
    const p = await draft();
    expect((await refusal(slot(p.periodId, { startsAt: at("2026-09-30T20:00"), endsAt: at("2026-10-01T08:00") }))).code)
      .toBe("outside_period");
    // the night of the 31st ends in November, and splitting it would roster one person twice
    await expect(slot(p.periodId, { startsAt: at("2026-10-31T20:00"), endsAt: at("2026-11-01T08:00") }))
      .resolves.toBeDefined();
  });

  it("caps a presence window at the POSITION's own maximum, not a global one", async () => {
    const p = await draft();
    const e = await refusal(slot(p.periodId, { startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-13T09:00") }));
    expect(e.code).toBe("invalid_window");
    expect(e.detail).toMatchObject({ maxHours: 24, positionKey: "unit_sr" }); // 25 h against the SR's 24
    // and on-call is not capped by it
    await expect(slot(p.periodId, { mode: "call", startsAt: at("2026-10-14T08:00"), endsAt: at("2026-10-17T08:00") }))
      .resolves.toBeDefined();
  });

  it("a draft is scratch paper: unassign simply removes the row", async () => {
    const p = await draft();
    const { assignmentId } = await slot(p.periodId);
    await withTx(db, (tx) => unassign(tx, ms, assignmentId));
    expect((await periodWithAssignments(db, p.periodId)).assignments).toHaveLength(0);
  });

  /* ═══════════════════════════════ the publication gate ═══════════════════════════════ */

  it("refuses to publish a roster with nobody on it", async () => {
    const p = await draft();
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, p.periodId)))).code).toBe("empty_period");
  });

  /**
   * PHASE R (R10) — **V5, WHICH HAD NO TEST AND NO NAMED GUARD UNTIL THIS ONE.**
   *
   * `effective ⇔ period.status = 'published' ∧ live_to IS NULL`. The database holds one half
   * (`roster_assignments_effective_ck`, whose comment calls itself "the half a constraint can
   * hold"); a constraint cannot look through a foreign key at the PERIOD's status, so the other
   * half was guarded by nothing. A phase-R close review found it MISSING: no repair query, and no
   * test anywhere asserting that a draft's rows are not effective.
   *
   * Asserted across the three writers that touch the column, and then with drift DELIBERATELY
   * INJECTED — because zero drift on a database where nothing has happened is not evidence, and a
   * query that always returned 0 would pass every leg but the last.
   */
  it("V5: no row's `effective` disagrees with its period — across draft, publish, amend and supersede", async () => {
    // (1) a DRAFT's rows are not effective
    const p = await draft();
    const { assignmentId } = await slot(p.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    expect(await effectiveDrift(db)).toBe(0);

    // (2) a PUBLISHED period's live rows are
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    expect(await effectiveDrift(db)).toBe(0);

    // (3) an AMENDMENT closes one row and opens another, in one instant
    await withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "cover", reason: "Dr Rao called in sick at 19:40", requestedBy: SR,
      close: [assignmentId],
      open: [{
        userId: JR, positionKey: "ward_jr", departmentId: MED,
        startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00"),
        replacesAssignmentId: assignmentId,
      }],
    }));
    expect(await effectiveDrift(db)).toBe(0);

    // (4) a SUPERSEDE takes the old version out of effect
    const v2 = await draft({ basedOnPeriodId: p.periodId });
    await slot(v2.periodId, { startsAt: at("2026-10-14T20:00"), endsAt: at("2026-10-15T08:00") });
    await withTx(db, (tx) => publishPeriod(tx, ms, v2.periodId));
    expect(await effectiveDrift(db)).toBe(0);

    /**
     * (5) THE TWO HALVES, SHOWN SEPARATELY — and this is the division of labour the invariant
     * rests on.
     *
     * The DATABASE refuses one direction outright: making a SUPERSEDED row effective again trips
     * `roster_assignments_effective_ck`, so that drift is unrepresentable and needs no query.
     */
    await expect(db.execute(sql`
      update roster_assignments set effective = true where id = ${assignmentId}
    `)).rejects.toThrow(/roster_assignments_effective_ck/);

    /**
     * The other direction is perfectly representable — a LIVE row of a PUBLISHED period quietly
     * carrying `effective = false` satisfies every constraint in the schema, and a resolver would
     * answer "nobody is on" for a ward that is staffed. Nothing but this query can see it, which
     * is why V5 named a repair query and why its absence was worth finding.
     */
    const drifted = await db.execute(sql`
      update roster_assignments set effective = false
       where period_id = ${v2.periodId} and live_to is null
       returning id
    `);
    // The injection has to BITE, or the assertion below is about an update that changed nothing —
    // which is exactly how the first draft of this leg passed for the wrong reason.
    expect(drifted.rows.length).toBeGreaterThan(0);
    expect(await effectiveDrift(db)).toBe(drifted.rows.length);
  });

  /**
   * PHASE R (R10) — **V7's OTHER HALF.** "Nothing published is deleted" had one half proved (the
   * supersede leaves `updated_by` alone) and one half guarded by nothing anybody had executed: the
   * clause *"no `delete` on assignments outside `status='draft'`"*. A close review found that the
   * module's single delete site was never tested against a published period, and that no absence
   * test pinned the site list — though this module already uses that shape twice elsewhere.
   */
  it("V7: the module deletes assignments in exactly ONE place, and that place refuses a published roster", async () => {
    // (a) the absence test — the site list, walked rather than grepped in a comment.
    const SRC = resolve(__dirname, "..", "..");
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (/\.delete\(\s*rosterAssignments\s*\)/.test(readFileSync(full, "utf8"))) {
          sites.push(full.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    // ONE, and it is `unassign`. A second entry here is somebody deleting a duty somewhere that
    // has not asked whether the roster is still scratch paper.
    expect(sites.sort()).toEqual(["modules/roster/periods.ts"]);
    // …and the scanner FOUND something, or the census above is green because it looked at nothing.
    expect(sites.length).toBeGreaterThan(0);

    // (b) executed: the guard refuses on a PUBLISHED period rather than merely being written down.
    const p = await draft();
    const { assignmentId } = await slot(p.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    const e = await refusal(withTx(db, (tx) => unassign(tx, ms, assignmentId)));
    expect(e.code).toBe("period_not_draft");

    // and the row is still there — a refused delete must not be a partial one.
    const { assignments } = await periodWithAssignments(db, p.periodId);
    expect(assignments.some((a) => a.id === assignmentId)).toBe(true);
  });

  /**
   * PHASE R (R10) — **V6's UNASSERTED CLAUSE.** The invariant reads "…and no exported function
   * takes a `now` for a stamp". That clause was written down in three doc comments and asserted
   * nowhere; a close review pointed out that the one test claiming the DATABASE clock proves only
   * "a plausible instant" (`>= before - 60_000`, which a `new Date()` satisfies identically).
   *
   * The strong behavioural evidence already exists elsewhere — "an amendment closes and opens in
   * ONE instant" compares `liveTo` to `liveFrom` and can only hold for a transaction timestamp.
   * What was missing is the thing that keeps the NEXT writer honest, so this pins the exported
   * functions that take a clock at all, by name and with a reason.
   */
  it("V6: every exported function that takes a clock is named here, and none of them STAMPS with it", () => {
    const SRC = resolve(__dirname);
    /** Exported functions whose signature takes a `now`/`at`/`asOf`, each with why it is not a stamp. */
    const TAKES_A_CLOCK: Record<string, string> = {
      teamMembers: "an `at` — WHICH membership was live at that instant; a read",
      nightPoolFor: "an `at`, as `teamMembers`",
      officiatingAt: "an `at`; a read",
      delegationsInForce: "an `at`; a read",
      credentialsOf: "an `at`; a read",
      holdsCredential: "an `at`; a read",
      asKnownAt: "the KNOWLEDGE axis itself — the whole question is what the roster said at T",
      absentUserIds: "a window, not a stamp",
      expiringCredentials: "a window",
      periodsTouching: "a window",
      presenceClashes: "no clock; listed nowhere — see the assertion",
      sweepRosterWindows: "a `now` used as the HORIZON to extend to, never written to a column",
      runMonthlyProposals: "a `now` used to ask WHICH DAY it is; every stamp it causes comes from `dbNow` inside the transaction",
      takeGaps: "a window",
      departmentsWithTakeGaps: "a window",
      unitOnTake: "an `at`; a read",
      backupUnit: "an `at`; a read",
      whoIsOn: "an `at` — the question is who is on THEN",
      whoIsAt: "an `at`",
      dutiesOf: "a window",
      onDutyNow: "an `at`",
      calloutList: "an `at`",
      attendanceProjection: "a window",
      listAbsences: "a window",
      internYear: "the academic year's own dates",
      extensionPostings: "dates from the plan",
      crmiBlocks: "dates from the table",
      splitBlock: "dates",
      expandCycle: "PURE — dates in, windows out, no database and no clock of its own",
      extendWindows: "an IST DATE to extend from",
      materialiseWindows: "IST dates",
      addIstDays: "a date string",
      istMidnightUtc: "a date string",
      istDateOfInstant: "an instant, answering which DAY",
      istWeekday: "a date string",
      istMinutesOfInstant: "an instant, answering the clock face",
      fairnessOf: "rows in, counts out",
      hoursCarried: "a window",
      simulate: "no clock at all",
      validate: "no clock at all",
      publishCycle: "an IST date the cycle becomes effective from",
      declareHoliday: "an IST date",
      skeletonModeOn: "an IST date",
      modeDeclarations: "an IST date",
      seedUnits: "no clock",
      escalationRecipients: "an `at` — who to ring THEN; a read with no writer behind it",
      membershipsOf: "an `at`; a read",
      parentTeamOf: "an `at`; a read",
      rulesInForce: "an IST DATE — which parameters a department is under that day; a read",
    };

    const clocked: string[] = [];
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(SRC, file), "utf8");
      const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const [, name, params] = m;
        if (name === undefined || params === undefined) continue;
        if (/\b(now|at|asOf|istDate|from|to|onIstDate)\s*:/.test(params)) clocked.push(name);
      }
    }

    // The scan FOUND functions — otherwise the subset assertion below is vacuous.
    expect(clocked.length).toBeGreaterThan(5);

    // Every exported function that takes a clock-ish parameter must be named above WITH A REASON.
    // A new one appearing here is somebody adding a clock the invariant has not been asked about.
    const undeclared = clocked.filter((n) => !(n in TAKES_A_CLOCK)).sort();
    expect(undeclared).toEqual([]);

    // And the one thing none of them may do: take a clock and write it as a STAMP. `dbNow` is the
    // only source of `published_at`, `superseded_at`, `live_from`, `live_to` and `applied_at`.
    const periodsSrc = readFileSync(join(SRC, "periods.ts"), "utf8");
    expect(periodsSrc).toContain("select now() as \"now\"");
    expect(/publishedAt:\s*now\b/.test(periodsSrc)).toBe(true); // `now` here is dbNow's return
  });

  it("publishes: rows go live, the hash is stamped, and the stamps come from the DATABASE", async () => {
    const p = await draft();
    await slot(p.periodId);
    const before = new Date();
    const result = await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));

    const { period, assignments } = await periodWithAssignments(db, p.periodId);
    expect(period.status).toBe("published");
    expect(period.publishedBy).toBe(MS);
    expect(period.contentHash).toBe(result.contentHash);
    expect(period.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(assignments.every((a) => a.effective && a.liveTo === null)).toBe(true);
    // V6 — no exported function took a `now`, and the stamp is a real instant near this one
    expect(period.publishedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);
    expect(assignments[0]!.liveFrom).not.toBeNull();
  });

  it("refuses a second publish of the same version — a live roster is never re-published", async () => {
    const p = await draft();
    await slot(p.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, p.periodId)))).code).toBe("period_not_draft");
  });

  /* ═══════════════════ V4 — what the human reviewed is what goes live ═══════════════════ */

  it("refuses a publish whose content moved since the human read it, and accepts the hash they read", async () => {
    const p = await draft();
    await slot(p.periodId);
    const reviewed = await contentHash(db, p.periodId);

    // somebody adds a night after the head read the roster and before they pressed publish
    await slot(p.periodId, { userId: JR, positionKey: "ward_jr", startsAt: at("2026-10-14T20:00"), endsAt: at("2026-10-15T08:00") });

    const e = await refusal(withTx(db, (tx) => publishPeriod(tx, ms, p.periodId, { expectedContentHash: reviewed })));
    expect(e.code).toBe("draft_changed_since_review");
    expect(e.detail).toMatchObject({ expectedContentHash: reviewed });

    const now = await contentHash(db, p.periodId);
    expect(now).not.toBe(reviewed);
    await expect(withTx(db, (tx) => publishPeriod(tx, ms, p.periodId, { expectedContentHash: now }))).resolves.toBeDefined();
  });

  it("the hash is over the ANSWER, not the row ids: retyping an identical slot does not invalidate a review", async () => {
    const p = await draft();
    const { assignmentId } = await slot(p.periodId);
    const before = await contentHash(db, p.periodId);
    await withTx(db, (tx) => unassign(tx, ms, assignmentId));
    await slot(p.periodId); // same person, same position, same window — a different row id
    expect(await contentHash(db, p.periodId)).toBe(before);
  });

  /* ═══════════════════ V3 — the lost update (stress test S2(a)) ═══════════════════ */

  it("refuses to publish a draft whose base is no longer the live version — S2(a), as a refusal", async () => {
    // v1 goes live.
    const v1 = await draft();
    await slot(v1.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, v1.periodId));

    // The senior resident drafts v2 from v1. A swap drafts v3 from v1 and publishes it first.
    const v2 = await draft({ basedOnPeriodId: v1.periodId });
    const v3 = await draft({ basedOnPeriodId: v1.periodId });
    await slot(v3.periodId, { userId: JR, positionKey: "ward_jr", startsAt: at("2026-10-20T20:00"), endsAt: at("2026-10-21T08:00") });
    await withTx(db, (tx) => publishPeriod(tx, ms, v3.periodId));

    // Now the SR presses publish on v2. In T1 this SILENTLY DISCARDED v3's swap.
    const e = await refusal(withTx(db, (tx) => publishPeriod(tx, ms, v2.periodId)));
    expect(e.code).toBe("stale_base");
    expect(e.detail).toMatchObject({ basedOnPeriodId: v1.periodId, liveVersionId: v3.periodId });

    // v3's slot is still live, which is the thing the refusal protected.
    const live = await db.select().from(rosterAssignments).where(eq(rosterAssignments.periodId, v3.periodId));
    expect(live.every((a) => a.effective)).toBe(true);
  });

  it("refuses a FIRST publish that claims a base, and one that claims none when a version is live", async () => {
    const v1 = await draft();
    await slot(v1.periodId);
    // nothing live yet, and this draft names a base that is not live
    const bogus = await draft({ basedOnPeriodId: v1.periodId });
    await slot(bogus.periodId);
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, bogus.periodId)))).code).toBe("stale_base");

    await withTx(db, (tx) => publishPeriod(tx, ms, v1.periodId));
    // now something IS live and this draft names no base
    const orphan = await draft();
    await slot(orphan.periodId, { userId: JR, positionKey: "ward_jr", startsAt: at("2026-10-22T20:00"), endsAt: at("2026-10-23T08:00") });
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, orphan.periodId)))).code).toBe("stale_base");
  });

  /* ═══════════════════ V7 — a supersede is not an edit ═══════════════════ */

  it("superseding keeps every original value, and does NOT stamp the publisher over updated_by", async () => {
    const v1 = await draft();
    const { assignmentId } = await slot(v1.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, v1.periodId));
    // the senior resident is recorded as the author of the row
    await db.update(rosterAssignments).set({ updatedBy: SR, createdBy: SR }).where(eq(rosterAssignments.id, assignmentId));

    // Drafting FROM v1 copies its slots — so v2 already names Dr Rao that night, and adding her
    // again here would be a genuine double-booking rather than a new version.
    const v2 = await draft({ basedOnPeriodId: v1.periodId });
    expect(v2.copiedAssignments).toBe(1);
    await withTx(db, (tx) => publishPeriod(tx, ms, v2.periodId));

    const [old] = await db.select().from(rosterAssignments).where(eq(rosterAssignments.id, assignmentId));
    expect(old!.effective).toBe(false);
    expect(old!.liveTo).not.toBeNull();
    // The whole point: two years later this row still says who wrote the duty.
    expect(old!.updatedBy).toBe(SR);
    expect(old!.createdBy).toBe(SR);

    const [v1row] = await db.select().from(rosterPeriods).where(eq(rosterPeriods.id, v1.periodId));
    expect(v1row!.status).toBe("superseded");
    expect(v1row!.supersededByPeriodId).toBe(v2.periodId);
    expect(v1row!.supersededAt!.getTime()).toBeGreaterThanOrEqual(v1row!.publishedAt!.getTime());
  });

  /* ═══════════════════ V1 — one body, two rooms ═══════════════════ */

  it("refuses a publish that would put one person in two places, naming them", async () => {
    const p = await draft();
    await slot(p.periodId);
    await slot(p.periodId, { positionKey: "ward_jr", startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T06:00") });
    const e = await refusal(withTx(db, (tx) => publishPeriod(tx, ms, p.periodId)));
    expect(e.code).toBe("presence_overlap");
    expect(e.message).toContain("kavita.rao");
  });

  it("presenceClashes sees ACROSS rosters — the resident borrowed by a second unit", async () => {
    const med = await draft();
    await slot(med.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, med.periodId));

    const sur = await draft({ scopeId: "SUR-U1", departmentId: SUR, title: "October — Surgery Unit I" });
    await slot(sur.periodId, { departmentId: SUR, startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T04:00") });
    expect(await presenceClashes(db, [sur.periodId])).toHaveLength(1);
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, sur.periodId)))).code).toBe("presence_overlap");
  });

  /* ═══════════════════ S2(b) — the same-night cross-unit swap ═══════════════════ */

  it("the cross-unit swap cannot be published one roster at a time, IN EITHER ORDER, and can as a set", async () => {
    // Medicine has Rao on the 12th; Surgery has Yadav on the 12th. Both published.
    const med1 = await draft();
    await slot(med1.periodId, { userId: SR, startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    const sur1 = await draft({ scopeId: "SUR-U1", departmentId: SUR, title: "October — Surgery Unit I" });
    await slot(sur1.periodId, { userId: JR, positionKey: "ward_jr", departmentId: SUR, startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await withTx(db, (tx) => publishPeriods(tx, ms, [{ periodId: med1.periodId }, { periodId: sur1.periodId }]));

    // They swap that night. Each new version is drafted FROM the live one — which copies its
    // slots — so the swap is: take the copied person off, put the other one on.
    const med2 = await draft({ basedOnPeriodId: med1.periodId });
    const sur2 = await draft({ scopeId: "SUR-U1", departmentId: SUR, title: "October — Surgery Unit I", basedOnPeriodId: sur1.periodId });
    for (const [periodId, userId, positionKey, departmentId] of [
      [med2.periodId, JR, "ward_jr", MED], [sur2.periodId, SR, "unit_sr", SUR],
    ] as const) {
      const copied = (await periodWithAssignments(db, periodId)).assignments;
      expect(copied).toHaveLength(1);
      await withTx(db, (tx) => unassign(tx, ms, copied[0]!.id));
      await slot(periodId, { userId, positionKey, departmentId, startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    }

    // ONE AT A TIME, EITHER ORDER: each names somebody still live in the other unit's old roster.
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, med2.periodId)))).code).toBe("presence_overlap");
    expect((await refusal(withTx(db, (tx) => publishPeriod(tx, ms, sur2.periodId)))).code).toBe("presence_overlap");

    // AS A SET: every old version leaves effect before any new one is checked.
    const results = await withTx(db, (tx) => publishPeriods(tx, ms, [
      { periodId: med2.periodId }, { periodId: sur2.periodId },
    ]));
    expect(results.map((r) => r.periodId)).toEqual([med2.periodId, sur2.periodId]);
    const live = await db.select().from(rosterAssignments).where(eq(rosterAssignments.effective, true));
    expect(live).toHaveLength(2);
    expect(live.map((a) => a.userId).sort()).toEqual([SR, JR].sort());
  });

  /* ═══════════════════ amendments and the two time axes ═══════════════════ */

  it("an amendment closes and opens in ONE instant, and `asKnownAt` answers both questions", async () => {
    const p = await draft();
    const { assignmentId } = await slot(p.periodId, { startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00") });
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));

    const beforeAmendment = new Date();
    await new Promise((r) => setTimeout(r, 25));

    const result = await withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "cover", reason: "Dr Rao called in sick at 19:40", requestedBy: SR,
      close: [assignmentId],
      open: [{
        userId: JR, positionKey: "ward_jr", departmentId: MED,
        startsAt: at("2026-10-12T20:00"), endsAt: at("2026-10-13T08:00"),
        replacesAssignmentId: assignmentId,
      }],
    }));
    expect(result).toMatchObject({ supersededCount: 1, addedCount: 1 });

    const scope = { scopeType: "team" as const, scopeId: "MED-U2" };

    // AS CORRECTED — who is on that night, as we now believe
    const nowRows = await asKnownAt(db, scope, new Date());
    expect(nowRows.map((r) => r.userId)).toEqual([JR]);

    // AS KNOWN THAT NIGHT — what the roster said before the cover was recorded
    const thenRows = await asKnownAt(db, scope, beforeAmendment);
    expect(thenRows.map((r) => r.userId)).toEqual([SR]);

    // ONE instant: the closed row's live_to is the opened row's live_from.
    const rows = await db.select().from(rosterAssignments).where(eq(rosterAssignments.periodId, p.periodId));
    const closed = rows.find((r) => r.id === assignmentId)!;
    const opened = rows.find((r) => r.id !== assignmentId)!;
    expect(closed.liveTo!.toISOString()).toBe(opened.liveFrom.toISOString());
    // ...and the replacement carries the lineage of the duty it took over.
    expect(opened.lineageId).toBe(closed.lineageId);
    expect(opened.effective).toBe(true);
    expect(closed.effective).toBe(false);
  });

  it("an amendment records who asked, who allowed, and whether it was after the fact", async () => {
    const p = await draft();
    const { assignmentId } = await slot(p.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    const { amendmentId } = await withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "correction", reason: "the reliever did not come; Dr Yadav stayed the night", requestedBy: SR,
      close: [assignmentId], afterTheFact: true,
    }));
    const [row] = await db.execute(sql`select * from roster_amendments where id = ${amendmentId}`).then((r) => r.rows as Record<string, unknown>[]);
    expect(row!.requested_by).toBe(SR);
    expect(row!.approved_by).toBe(MS);
    expect(row!.after_the_fact).toBe(true);
    expect(row!.superseded_count).toBe(1);
  });

  it("refuses to amend a DRAFT — a draft is edited, not amended", async () => {
    const p = await draft();
    await slot(p.periodId);
    expect((await refusal(withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "swap", reason: "x", requestedBy: SR,
    })))).code).toBe("period_not_published");
  });

  it("refuses an amendment with no reason — everybody it touches is shown one", async () => {
    const p = await draft();
    await slot(p.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    expect((await refusal(withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "swap", reason: "   ", requestedBy: SR,
    })))).code).toBe("invalid_window");
  });

  it("an amendment that would put somebody in two places is refused and leaves the roster alone", async () => {
    const p = await draft();
    await slot(p.periodId, { startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-12T20:00") });
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));
    await refusal(withTx(db, (tx) => amend(tx, ms, p.periodId, {
      kind: "cover", reason: "second duty for the same person", requestedBy: SR,
      open: [{
        userId: SR, positionKey: "ward_jr", departmentId: MED,
        startsAt: at("2026-10-12T14:00"), endsAt: at("2026-10-12T22:00"),
      }],
    })));
    // the transaction rolled back: no amendment row, no new slot
    const rows = await db.select().from(rosterAssignments).where(eq(rosterAssignments.periodId, p.periodId));
    expect(rows).toHaveLength(1);
    expect((await db.execute(sql`select count(*)::int as n from roster_amendments`)).rows[0]).toMatchObject({ n: 0 });
  });

  /* ═══════════════════ the advisory lock, asserted rather than raced ═══════════════════ */

  it("publishing HOLDS the named advisory lock for the whole transaction", async () => {
    // A race test would flake on a busy box and prove nothing on an idle one (the
    // `bounds-sized-in-the-quiet-regime` trap). This asks Postgres, inside the transaction, whether
    // the lock is held — which is the property the race was a proxy for.
    const p = await draft();
    await slot(p.periodId);
    const held = await withTx(db, async (tx) => {
      await publishPeriod(tx, ms, p.periodId);
      const r = await tx.execute(sql`
        select count(*)::int as n from pg_locks
         where locktype = 'advisory' and pid = pg_backend_pid()
           and objid = (select hashtext('roster.publish')::bigint & 4294967295)`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(held).toBe(1);
  });

  /* ═══════════════════ what the log says ═══════════════════ */

  it("a publish emits the period event and ONE duty_changed per person, not one per slot", async () => {
    const p = await draft();
    await slot(p.periodId, { startsAt: at("2026-10-12T08:00"), endsAt: at("2026-10-12T20:00") });
    await slot(p.periodId, { startsAt: at("2026-10-14T08:00"), endsAt: at("2026-10-14T20:00") });
    await slot(p.periodId, { userId: JR, positionKey: "ward_jr", startsAt: at("2026-10-15T08:00"), endsAt: at("2026-10-15T20:00") });
    await withTx(db, (tx) => publishPeriod(tx, ms, p.periodId));

    const names = await eventNames();
    expect(names.filter((n) => n === "roster.period_drafted")).toHaveLength(1);
    expect(names.filter((n) => n === "roster.period_published")).toHaveLength(1);
    // three slots, TWO people
    expect(names.filter((n) => n === "roster.duty_changed")).toHaveLength(2);
  });

  it("a supersede says so on the log, in the same transaction as the publish that caused it", async () => {
    const v1 = await draft();
    await slot(v1.periodId);
    await withTx(db, (tx) => publishPeriod(tx, ms, v1.periodId));
    const v2 = await draft({ basedOnPeriodId: v1.periodId }); // copies v1's slot
    await withTx(db, (tx) => publishPeriod(tx, ms, v2.periodId));

    const names = await eventNames();
    expect(names.filter((n) => n === "roster.period_superseded")).toHaveLength(1);
    expect(names.indexOf("roster.period_superseded")).toBeLessThan(names.lastIndexOf("roster.period_published"));
  });
});
