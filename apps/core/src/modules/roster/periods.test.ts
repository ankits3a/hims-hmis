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
     * (5) THE DIRECTIONS, SHOWN SEPARATELY — and the first draft of this leg overclaimed.
     *
     * It said "the database REFUSES one direction outright". What the constraint
     * (`not effective or live_to is null`) actually refuses is narrower: making a SUPERSEDED row
     * effective again. It says nothing about a DRAFT period's row being effective with
     * `live_to` null — which is legal in the schema, invisible to every constraint, and would put
     * a draft's slots into the one-body-two-rooms EXCLUDE and into every resolver read. A second
     * reviewer pointed out that the biconditional was shipped but only one implication pinned, so
     * a mutant dropping `p.status = 'published'` would have survived. Both are injected below.
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
    /**
     * DIRECTION A — a DRAFT's row marked effective. Representable, constraint-legal, and the one
     * a mutant that forgot the period's status would sail past.
     */
    // A draft of its OWN series with nobody else's window — drafting FROM a base copies the base's
    // slots, and marking those effective collides with the live version's copies in the
    // one-body-two-rooms EXCLUDE, which is the constraint doing its job rather than the drift
    // this leg is about.
    const draftV3 = await draft({ scopeId: "MED-U9" });
    await slot(draftV3.periodId, {
      userId: JR2, positionKey: "ward_jr",
      startsAt: at("2026-10-20T20:00"), endsAt: at("2026-10-21T08:00"),
    });
    const inDraft = await db.execute(sql`
      update roster_assignments set effective = true
       where period_id = ${draftV3.periodId} and live_to is null
       returning id
    `);
    expect(inDraft.rows.length).toBeGreaterThan(0);
    expect(await effectiveDrift(db)).toBe(inDraft.rows.length);
    await db.execute(sql`
      update roster_assignments set effective = false where period_id = ${draftV3.periodId}
    `);
    expect(await effectiveDrift(db)).toBe(0);

    /** DIRECTION B — a LIVE row of a PUBLISHED period quietly not effective. */
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
        // Count OCCURRENCES, not files: pushing the path once per file would let a second delete
        // inside `periods.ts` — in a function with no `assertDraft` — leave this list unchanged.
        const hits = readFileSync(full, "utf8").match(/\.delete\(\s*rosterAssignments\s*\)/g) ?? [];
        for (const _ of hits) sites.push(full.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    // ONE, and it is `unassign`. A second entry here is somebody deleting a duty somewhere that
    // has not asked whether the roster is still scratch paper.
    // Exactly ONE occurrence, in `unassign`. The `toEqual` pins non-emptiness by itself, so no
    // separate anti-vacuity leg is needed here — a scanner that found nothing fails this line.
    expect(sites.sort()).toEqual(["modules/roster/periods.ts"]);

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
   * PHASE R (R10) — **V6's UNASSERTED CLAUSE, and the second attempt at guarding it.**
   *
   * The invariant reads "…and no exported function takes a `now` for a stamp". That clause lived in
   * three doc comments and was asserted nowhere; the one test claiming the DATABASE clock proved
   * only "a plausible instant" (`>= before - 60_000`, which a `new Date()` satisfies identically).
   *
   * **The first census written for it was itself broken**, and a second reviewer measured it: its
   * filter keyed on PARAMETER NAMES (`now|at|asOf|…`), so it saw 29 functions while its map
   * declared 49 — twenty dead entries — and it was blind to this module's own conventions
   * (`knownAt`, `termStart`, `fromIstDate`, and every `export const`). A guard that cannot see the
   * thing it guards is worse than none, because it reports success.
   *
   * This one keys on TYPE (`: Date`) plus the IST-date string convention, matches `export const`
   * as well as `export function`, and is **bidirectional** — a dead entry fails it just as a new
   * undeclared function does. `policy.test.ts` one file away already used that shape.
   */
  it("V6: every exported function that takes a clock is declared here, with a reason, both ways", () => {
    const SRC = resolve(__dirname);
    /**
     * Every exported function of this module that takes an instant or an IST date, and why taking
     * one is not STAMPING with one. A new entry is somebody being asked the question; a dead entry
     * is a function that stopped taking a clock and should stop being listed.
     */
    const TAKES_A_CLOCK: Record<string, string> = {
      absentUserIds: "a window — who is away between two instants",
      asKnownAt: "`knownAt`: the KNOWLEDGE axis itself, which is the whole question",
      attendanceProjection: "a term's two dates",
      backupUnit: "an `at`; a read",
      calloutList: "an `at`; a read",
      closeTeam: "the date a unit stops existing — a fact about the establishment, not a stamp",
      credentialsOf: "an `at`; a read",
      delegationsInForce: "an `at`; a read",
      departmentsWithTakeGaps: "a window",
      draftCycleFromTemplate: "the IST date a pattern is anchored on",
      dutiesOf: "a window",
      endMembership: "the date a posting ends",
      endOfficiating: "the date somebody stops standing in",
      escalationRecipients: "an `at` — who to ring THEN",
      expandCycle: "PURE: dates in, windows out, no database and no clock of its own (V15)",
      expiringCredentials: "a window",
      extendWindows: "the IST date to extend the horizon FROM",
      fairnessOf: "rows in, counts out",
      holdsCredential: "an `at`; a read",
      hoursCarried: "a window",
      istDateOfInstant: "an instant, answering which DAY",
      istMidnightUtc: "a date string, answering which INSTANT",
      istMinutesOfInstant: "an instant, answering the clock face",
      livePeriodCount: "an `at` — which rosters COVER it",
      materialiseWindows: "IST dates bounding what is written",
      membershipsOf: "an `at`; a read",
      modeDeclarations: "an IST date — the day's declarations",
      nightPoolFor: "an `at`; a read",
      officiatingAt: "an `at`; a read",
      onDutyNow: "an `at` — the board's question",
      parentTeamOf: "an `at`; a read",
      periodsTouching: "a window",
      publishCycle: "the IST date a cycle becomes effective from — a DECISION's date, and the row's own `published_at` still comes from the database",
      rulesInForce: "an IST date — which parameters a department is under that day",
      runMonthlyProposals: "a `now` used to ask WHICH DAY it is; every stamp it causes comes from `dbNow` inside the transaction",
      skeletonModeOn: "an IST date",
      sweepRosterWindows: "a `now` used as the HORIZON to extend to, never written to a column",
      takeGaps: "a window",
      teamMembers: "an `at` — which membership was live then",
      unitOnTake: "an `at`; a read",
      whoIsAt: "an `at`",
      whoIsOn: "an `at` — who is on THEN",
    };

    const clocked: string[] = [];
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(SRC, file), "utf8");
      for (const re of [
        /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*:/g,
        /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*\(([\s\S]*?)\)\s*:/g,
      ]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const [, name, params] = m;
          if (name === undefined || params === undefined) continue;
          // BY TYPE, not by parameter name — the mistake the first version made.
          if (/:\s*Date\b/.test(params) || /IstDate\s*:|istDate\s*:/.test(params)) clocked.push(name);
        }
      }
    }

    // BOTH WAYS. An undeclared function is somebody adding a clock nobody was asked about; a dead
    // entry is a census describing a module that no longer exists.
    expect([...new Set(clocked)].sort()).toEqual(Object.keys(TAKES_A_CLOCK).sort());
    // …and the scanner found a realistic number, so a regex that broke cannot pass by matching none.
    expect(new Set(clocked).size).toBeGreaterThan(30);
  });

  /**
   * The other half of V6, and a NEGATIVE scan rather than a positive grep. The first attempt
   * asserted that `select now()` and `publishedAt: now` were PRESENT in `periods.ts` — two checks
   * that can only fail if somebody deletes the text, and which would pass unchanged against a
   * `publishPeriods(…, now: Date)` that stamped a caller's clock.
   */
  it("V6: no STAMP column is ever assigned from anything but the database's own clock", () => {
    const SRC = resolve(__dirname);
    const STAMPS = [
      "publishedAt", "supersededAt", "liveFrom", "liveTo", "appliedAt", "declaredAt",
      "acceptedAt", "clearedAt", "withdrawnAt", "decidedAt",
    ];
    const offenders: string[] = [];
    let assignments = 0;

    /**
     * ONLY INSIDE `.set({…})` AND `.values({…})` — the two places a COLUMN is written.
     *
     * The first version of this scan looked everywhere and reported thirteen offenders, every one
     * of them correct code: `instant()` in an event SCHEMA, `iso(now)` in an event PAYLOAD,
     * `row.decidedAt!.toISOString()` in a refusal's `detail`. Instants are SUPPOSED to travel as
     * ISO strings in payloads — V9 requires it. The invariant is about what reaches a column, so
     * the scan has to be about that too, or it is a nuisance that trains people to ignore it.
     */
    const writeBlocks = (src: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/\.(?:set|values)\(\s*\{/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth += 1;
          else if (src[i] === "}") depth -= 1;
          i += 1;
        }
        out.push(src.slice(m.index! + m[0].length, i));
      }
      return out;
    };

    for (const file of readdirSync(SRC)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      for (const block of writeBlocks(readFileSync(join(SRC, file), "utf8"))) {
        for (const stamp of STAMPS) {
          for (const m of block.matchAll(new RegExp(`\\b${stamp}:\\s*([^,\n]+)`, "g"))) {
            const rhs = (m[1] ?? "").trim();
            assignments += 1;
            // `now` is `dbNow(tx)`'s return — `select now()`, the transaction's own instant.
            // `sql\`now()\`` is the database saying it inline. `null` clears a stamp.
            if (!/^(now\b|sql`now\(\)`|null\b)/.test(rhs)) {
              offenders.push(`${file}: ${stamp} <- ${rhs.slice(0, 50)}`);
            }
          }
        }
      }
    }

    // The scan found column writes at all — otherwise it passes by looking at nothing.
    expect(assignments).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
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
