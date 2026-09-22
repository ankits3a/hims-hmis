import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROSTER_ACTOR_KINDS, ROSTER_ACTS, ROSTER_VIAS, rosterActMatrix, rosterActPolicy } from "./policy";
import { RosterError } from "./errors";
import type { RosterAct, RosterActorKind } from "./policy";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R1) — **INVARIANT V8, AND IT IS THE ONE THIS PHASE EXISTS TO MAKE CHECKABLE.**
 *
 * *"A machine actor never edits a draft a human has touched, never publishes, never overrides."*
 * Stress test §4 is a matrix; this file is that matrix, transcribed a second time, by hand, from
 * the document — **deliberately not imported from the source it checks.** A test that derives its
 * expectation from the code it tests can only ever say the code agrees with itself. Every cell
 * below was typed from the table in `brainstorms/2026-09-20-roster-units/01-STRESS-TEST.md §4`.
 *
 * Three legs, and the third is the one that will still be working in six months:
 *
 *   1. **the matrix agrees with the document**, cell by cell;
 *   2. **every `never` cell actually throws**, executed, for a real actor of that kind;
 *   3. **every exported function in this module is classified** as acting or not acting, and every
 *      acting one is proved to go through `rosterActPolicy`. R1 exports no acting function at all —
 *      so leg 3 is *vacuously* satisfied today and would stay green while R2 added `publishPeriod`
 *      with no policy call. That is exactly what the EXPORT CENSUS below prevents: the set of
 *      exports is pinned, so R2 cannot add one without coming here and saying which it is.
 */
describe("roster — who may do what (V8, stress test §4)", () => {
  const actor = (type: Actor["type"]): Actor => ({ type, id: `${type}-1` });

  /* ═══════════════════ leg 1: the matrix, transcribed from the document ═══════════════════ */

  /**
   * `y` = permitted (a grant is then checked, or the actor is a named system job);
   * `n` = `never` — refused for this KIND of actor, whatever it holds.
   *
   * Where §4 reads *"later (needs agent grants)"* the cell is `n`: agent grants live in
   * `kernel/auth`, which this plan freezes (§5/§7), and a cell that anticipates a grant nobody can
   * issue is a cell that is wrong today. When that phase lands it changes this table first.
   */
  const EXPECTED: Record<RosterAct, Record<RosterActorKind, "y" | "n">> = {
    //                      user copilot agent system patient
    read: { user: "y", copilot: "y", agent: "y", system: "y", patient: "n" },
    draft_machine_period: { user: "y", copilot: "n", agent: "n", system: "y", patient: "n" },
    edit_human_draft: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
    propose: { user: "y", copilot: "y", agent: "n", system: "y", patient: "n" },
    accept_warning: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
    publish: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
    declare: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
    acknowledge: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
    nag: { user: "y", copilot: "n", agent: "y", system: "y", patient: "n" },
    // R4's own row. NOT from §4 — see the note on `request_absence` in `policy.ts`.
    request_absence: { user: "y", copilot: "n", agent: "n", system: "n", patient: "n" },
  };

  it("every act × every actor kind is DECLARED — no cell falls through", () => {
    const matrix = rosterActMatrix();
    expect(Object.keys(matrix).sort()).toEqual([...ROSTER_ACTS].sort());
    for (const act of ROSTER_ACTS) {
      expect(Object.keys(matrix[act]).sort()).toEqual([...ROSTER_ACTOR_KINDS].sort());
    }
  });

  it("the matrix agrees with stress test §4, cell for cell", () => {
    const matrix = rosterActMatrix();
    const actual = {} as Record<RosterAct, Record<RosterActorKind, "y" | "n">>;
    for (const act of ROSTER_ACTS) {
      const row = {} as Record<RosterActorKind, "y" | "n">;
      for (const kind of ROSTER_ACTOR_KINDS) row[kind] = matrix[act][kind] === "never" ? "n" : "y";
      actual[act] = row;
    }
    expect(actual).toEqual(EXPECTED);
  });

  /* ═══════════════════ leg 2: `never` refuses, executed ═══════════════════ */

  const cells = ROSTER_ACTS.flatMap((act) =>
    ROSTER_ACTOR_KINDS.map((kind) => [act, kind, EXPECTED[act][kind]] as const));

  it.each(cells.filter(([, , v]) => v === "n"))(
    "%s is refused to a %s, with act_not_available_to_actor",
    (act, kind) => {
      const a = kind === "copilot" ? actor("user") : actor(kind as Actor["type"]);
      const via = kind === "copilot" ? "copilot" : "direct";
      let thrown: unknown;
      try { rosterActPolicy(a, act, via); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(RosterError);
      expect((thrown as RosterError).code).toBe("act_not_available_to_actor");
      // The refusal must carry WHAT was refused and to WHOM — a bare 403 is unreportable.
      expect((thrown as RosterError).detail).toEqual({ act, actorType: a.type, via });
    },
  );

  it.each(cells.filter(([, , v]) => v === "y"))(
    "%s is available to a %s",
    (act, kind) => {
      const a = kind === "copilot" ? actor("user") : actor(kind as Actor["type"]);
      const via = kind === "copilot" ? "copilot" : "direct";
      expect(() => rosterActPolicy(a, act, via)).not.toThrow();
    },
  );

  /* ═══════════════════ the three that are the whole point ═══════════════════ */

  it("NOTHING but a person publishes — not an agent, not a system job, not the user's own copilot", () => {
    for (const type of ["agent", "system"] as const) {
      expect(() => rosterActPolicy(actor(type), "publish")).toThrow(RosterError);
    }
    // The copilot is the SAME user: the refusal is about the channel, not the identity, which is
    // why the same human passes a line later by doing it themselves.
    expect(() => rosterActPolicy(actor("user"), "publish", "copilot")).toThrow(RosterError);
    expect(() => rosterActPolicy(actor("user"), "publish", "direct")).not.toThrow();
  });

  it("a machine may DRAFT its own proposal and may never touch a draft a human has", () => {
    expect(() => rosterActPolicy(actor("system"), "draft_machine_period")).not.toThrow();
    expect(() => rosterActPolicy(actor("system"), "edit_human_draft")).toThrow(RosterError);
  });

  it("a copilot proposes and never confirms — the act that makes it useful and the one that does not", () => {
    expect(() => rosterActPolicy(actor("user"), "propose", "copilot")).not.toThrow();
    for (const act of ["publish", "accept_warning", "declare", "acknowledge"] as const) {
      expect(() => rosterActPolicy(actor("user"), act, "copilot")).toThrow(RosterError);
    }
  });

  it("`direct` is the default: a caller that forgets `via` gets the STRICTER answer for a copilot, never the looser", () => {
    // The default must be the one a mistake is safe under. A caller that omits `via` is a caller
    // acting as the user themselves, and a copilot integration that forgets to pass it gets MORE
    // than it should — so the check that matters is that `copilot` is never widened by omission.
    for (const act of ROSTER_ACTS) {
      if (EXPECTED[act].copilot === "n" && EXPECTED[act].user === "y") {
        expect(() => rosterActPolicy(actor("user"), act)).not.toThrow();
        expect(() => rosterActPolicy(actor("user"), act, "copilot")).toThrow(RosterError);
      }
    }
    expect(ROSTER_VIAS).toEqual(["direct", "copilot"]);
  });

  /* ═══════════════════ leg 3: the export census ═══════════════════ */

  /**
   * EVERY EXPORTED FUNCTION IN `modules/roster`, CLASSIFIED. An export missing from both lists
   * fails this test, which is the friction: R2 cannot land `publishPeriod` without deciding, here,
   * in writing, that it acts — and an acting function is then PROVED to reach `rosterActPolicy`.
   */
  /**
   * Each acting export names **how it reaches the policy** — either by calling it, or by
   * delegating to another acting export that does. The second leg below follows those edges to a
   * fixpoint, so "reaches it eventually" is proved rather than assumed; a delegation that stops
   * short of a real check fails.
   */
  const ACTING: Record<string, { reaches: string; why: string }> = {
    draftPeriod: { reaches: "requireRosterAct(", why: "a machine drafting is `draft_machine_period`; a person is `propose`" },
    assign: { reaches: "requireRosterAct(", why: "`edit_human_draft` once a person has touched the draft — V8's central clause" },
    unassign: { reaches: "requireRosterAct(", why: "as `assign`" },
    publishPeriods: { reaches: "requireRosterAct(", why: "the governed act; per period, at its own department's scope" },
    publishPeriod: { reaches: "publishPeriods(", why: "a one-element call of the list form, so the two can never drift apart" },
    amend: { reaches: "requireRosterAct(", why: "amending a live roster is `publish` — it changes who is on tonight" },
    // R3 — the establishment, and who may act for whom.
    createTeam: { reaches: "requireRosterAct(", why: "a unit is an establishment decision, at its department's scope" },
    confirmTeam: { reaches: "requireRosterAct(", why: "the HOD ratifying our arithmetic as their establishment" },
    closeTeam: { reaches: "requireRosterAct(", why: "as `createTeam`" },
    addMembership: { reaches: "requireRosterAct(", why: "who is in a unit decides who a resolver can return" },
    endMembership: { reaches: "requireRosterAct(", why: "as `addMembership`" },
    importMemberships: { reaches: "addMembership(", why: "resolves and validates the whole file, then writes through the checked path" },
    recordOfficiating: { reaches: "requireRosterAct(", why: "who is standing in decides whose phone is rung" },
    endOfficiating: { reaches: "requireRosterAct(", why: "as `recordOfficiating`" },
    recordDelegation: { reaches: "requireRosterAct(", why: "and then checks, separately, that the DELEGATOR holds what is being handed on" },
    // R4 — being away, and what you hold.
    requestAbsence: { reaches: "requireRosterAct(", why: "`request_absence`; and the function itself enforces the part the matrix cannot — your OWN, or the manage permission" },
    cancelAbsence: { reaches: "requireRosterAct(", why: "as `requestAbsence`" },
    approveAbsence: { reaches: "decide(", why: "the shared decision path, which takes `publish` — approving a leave decides whether a ward has somebody in it" },
    rejectAbsence: { reaches: "decide(", why: "as `approveAbsence`" },
    recordAbsence: { reaches: "requireRosterAct(", why: "the CHECKED front door onto `recordAbsenceUnchecked`" },
    recordAbsences: { reaches: "recordAbsence(", why: "a bulk act cannot be a way round the checks a single one goes through" },
    // R8 — the one act in the validator's half of the phase. Everything else there READS.
    declareSkeletonMode: { reaches: "requireRosterAct(", why: "`declare` — the same act a holiday goes through. NO machine may put a hospital on skeleton cover however sure it is: the whole content of the declaration is that a person is answerable for it" },
    withdrawSkeletonMode: { reaches: "requireRosterAct(", why: "standing it down is the same authority as declaring it, at the same scope" },
    // R9 — the proposer. It ACTS, and the act is the one the matrix grants a machine.
    proposeMonth: { reaches: "draftPeriod(", why: "`draft_machine_period` — a machine may draft a roster OF ITS OWN, and `assign` then judges every slot edit as `propose` or, once a human has touched the draft, `edit_human_draft`, which no machine may do" },
    runMonthlyProposals: { reaches: "proposeMonth(", why: "the scheduled entry point; it decides only WHICH units need next month, and every write goes through the checked path above" },
    acceptFinding: { reaches: "requireRosterAct(", why: "`accept_warning` — a person takes responsibility for a finding, and the whole value of the record is that a HUMAN can be asked about it later. No agent, no job, no copilot" },
    markAebasEntered: { reaches: "requireRosterAct(", why: "the biometric filing mark is a governed record" },
    recordCredential: { reaches: "requireRosterAct(", why: "what somebody holds decides what they may be rostered to" },
    verifyCredential: { reaches: "requireRosterAct(", why: "as `recordCredential`" },
    // R6 — where an escalation goes.
    setEscalationTarget: { reaches: "requireRosterAct(", why: "deciding who gets woken is the same kind of act as publishing the rota that decides it" },
    // R7 — the calendar.
    publishCycle: { reaches: "requireRosterAct(", why: "a department's cycle decides who admits on every day of the quarter" },
    materialiseWindows: { reaches: "requireRosterAct(", why: "writing the windows IS the calendar; at the department's own scope" },
    declareHoliday: { reaches: "requireRosterAct(", why: "`declare` — the MS's act, or a delegate's" },
    extendWindows: { reaches: "materialiseWindows(", why: "the nightly roll-forward, through the checked writer" },
    sweepRosterWindows: { reaches: "extendWindows(", why: "the scheduler's entry point; see MATERIALISER_ACTOR on why a job is not a `system` actor here" },
    draftCycleFromTemplate: { reaches: "requireRosterAct(", why: "applying a pattern writes the department's own cycle, as a draft" },
  };
  /**
   * ═══ THE READS TAKE NO ACTOR, AND THAT IS A DELIBERATE BOUNDARY FOR THIS TASK ═══
   *
   * R2 ships no route and no controller: the module seam is inert (`roster.module.ts`). These are
   * domain reads called only from tests and from the acting functions above, all of which have
   * already been through the policy. **R5 owns the guarded read model** (`whoIsOn`, `dutiesOf`,
   * `onDutyNow`) and the permission check that goes with it. Anything that mounts one of these on
   * an HTTP route before then is adding an unguarded read, and this list is where that shows up.
   */
  const NOT_ACTING: Record<string, string> = {
    rosterActPolicy: "IS the policy",
    rosterActMatrix: "renders the policy; decides nothing",
    requireRosterAct: "calls the policy and then the permission read — the one acting wrapper",
    rosterHttpStatus: "maps a refusal code to a status",
    seedOrgDepartments: "a deploy seed, run by `seed:roster` under the operator's own shell — there is no Actor",
    seedRosterPositions: "a deploy seed, as above",
    listOrgDepartments: "a read",
    orgDepartmentByCode: "a read",
    listRosterPositions: "a read",
    rosterMasterCounts: "a read, for the census",
    contentHash: "a pure read: hashes the slots a human is about to review",
    presenceClashes: "a read the validator (R8) shows as findings long before anybody publishes",
    asKnownAt: "a read — see the note above; R5 gives the read model its guard",
    periodWithAssignments: "a read — see the note above",
    periodsTouching: "a read — see the note above",
    // R3
    seedUnits: "a deploy seed, run by an operator's own shell — there is no Actor",
    teamByCode: "a read",
    listTeams: "a read",
    unconfirmedTeams: "a read, for the census",
    teamMembers: "a read — R5's resolver is the guarded reader of it",
    nightPoolFor: "a read — as `teamMembers`",
    membershipsOf: "a read",
    parentTeamOf: "a read",
    officiatingAt: "a read",
    delegationsInForce: "a read, and the one `requireRosterAct` itself performs",
    splitBlock: "pure arithmetic over the CRMI table — no database, no actor",
    crmiBlocks: "pure, as above",
    crmiWeeksTotal: "pure, as above",
    internYear: "pure: generates a plan. WRITING one is a membership, and that goes through `addMembership`",
    extensionPostings: "pure, as above",
    // R4
    recordAbsenceUnchecked: "**DELIBERATELY UNCHECKED, and the name is the control.** `modules/opd`'s leave screen has held `opd.masters.manage` since long before the roster existed; requiring `roster.periods.publish` as well would break an act an OPD admin has always been allowed to perform, and the realistic repair would be granting them every rota in the hospital. `absences.test.ts` pins its call sites BY NAME so a third cannot appear quietly",
    redactReason: "pure: decides who may read a reason, and mutates nothing",
    listAbsences: "a read — and the one that applies D6, so the caller that forgets cannot be the one that renders it",
    absentUserIds: "a read",
    livePeriodCount: "a read — how many rosters COVER an instant. Deliberately not `status = published`, which a roster keeps for ever once published; see the function",
    departmentsWithoutPublishedCycle: "a read — the departments that run units and have no cycle, which is the hole `departmentsWithTakeGaps` structurally cannot see",
    effectiveDrift: "a read — V5's repair query. It counts rows whose `effective` disagrees with their period's status, which is the half of the biconditional no constraint can see through a foreign key to hold",
    attendanceProjection: "a read, and a FINDING rather than a refusal",
    credentialsOf: "a read",
    holdsCredential: "a read",
    expiringCredentials: "a read",
    // R5 — the resolvers. ALL reads, and all of them take the caller's clock rather than reading one.
    resolverEnabled: "reads an environment flag; decides nothing about a person",
    whoIsOn: "THE read. Guarded by its callers (R6's consumers run as the kernel, with their own authority); the S-series screen that exposes it is where a permission check on a read belongs",
    whoIsAt: "a read — as `whoIsOn`",
    dutiesOf: "a read — and `My duties` is a screen about yourself, so its guard is the route's",
    calloutList: "a read — the ladder phase consumes it",
    onDutyNow: "a read — the board's, and it carries `source` so an unpublished department cannot be rendered as an empty staffed one",
    // R6
    escalationRecipients: "a read, called from the worker's own consumers, which run as the kernel and carry their own authority — there is no Actor at 02:14 and inventing one would be the wrong shape",
    escalationTarget: "a read",
    listEscalationTargets: "a read",
    // R7 — pure arithmetic and reads.
    istMidnightUtc: "pure: the one place a calendar day becomes an instant",
    expandCycle: "PURE, and the only generator (V15) — no database, no clock, no actor",
    unitOnTake: "a read",
    backupUnit: "a read",
    takeGaps: "a read — V11's other half, which cannot be a constraint because absence is not a row",
    departmentsWithTakeGaps: "a read, for the census",
    publishedCycleCount: "a read — how many cycles the hospital works to at all",
    cycleTemplate: "pure: looks a pattern up in the gallery",
    // R8 — the validator and the what-if. NOT ONE OF THEM WRITES, and that is exactly why a
    // machine may run them: R9's proposer evaluates its own drafts hundreds of times, and an
    // evaluation that could write would make the harness's own runs part of the hospital's record.
    istMinutesOfInstant: "pure: minutes past IST midnight. It lives in `calendar.ts` because `ist-clock-parity` pins how many places carry the IST offset, and a copy of it inside a rule evaluator is the drift that census refuses",
    istDateOfInstant: "pure: the inverse of `istMidnightUtc`, and the hospital's one opinion about where a day begins",
    templateFeasibility: "PURE arithmetic — hours per week from an establishment, answerable before anybody drafts anything",
    validate: "a read that returns findings. It does not persist them, takes no `now` it could stamp with, and the publish gate computes its refusal from the returned array rather than from a table it has just written",
    simulate: "a what-if. Applies its deltas to an in-memory COPY and writes nothing — asserted by a row count before and after, rather than merely intended",
    rulesInForce: "a read: the rule book as it applies to one department on one day",
    seedRosterRules: "a deploy seed, as above",
    listFindings: "a read",
    acceptedFindingKeys: "a read — the set the publish gate honours, shared with it so the gate and the screen cannot disagree about what `accepted` means",
    fairnessOf: "PURE: counts nights, Sundays and holidays from rows it is handed. It reads no database and is the same answer for a roster somebody typed by hand as for one the proposer drafted",
    skeletonModeOn: "a read — and it answers `mine OR the whole hospital's`, because a department cannot be off skeleton cover on a day the hospital is on it",
    modeDeclarations: "a read: the day's checklist, withdrawn rows included",
    recordFindings: "brings the STORED findings into line with what `validate()` computed. It writes, and it is deliberately NOT an acting function: it decides nothing, grants nothing and refuses nothing — the judgement is `acceptFinding`, which is guarded. A proposer may record what it found; it may not accept it",
  };

  const MODULE_DIR = __dirname;
  const sourceFiles = readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(MODULE_DIR, f), "utf8")] as const);

  /** Every function in the module, exported or not — the population the fixpoint walks. */
  const allFunctions = (): { name: string; file: string; body: string }[] =>
    scanFunctions(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g);

  const exportedFunctions = (): { name: string; file: string; body: string }[] =>
    scanFunctions(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g);

  const scanFunctions = (re0: RegExp): { name: string; file: string; body: string }[] => {
    const out: { name: string; file: string; body: string }[] = [];
    for (const [file, src] of sourceFiles) {
      const re = new RegExp(re0.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const name = m[1];
        if (name === undefined) continue;
        // The function's own text, to the next top-level `export` or the end of the file.
        const from = m.index;
        const nextExport = src.indexOf("\nexport ", from + 1);
        out.push({ name, file, body: src.slice(from, nextExport === -1 ? undefined : nextExport) });
      }
    }
    return out;
  };

  it("every exported function of this module is classified as acting or not acting", () => {
    const found = exportedFunctions().map((f) => f.name).sort();
    const classified = [...Object.keys(ACTING), ...Object.keys(NOT_ACTING)].sort();
    // Read a failure here as: *a function was added and nobody said whether a machine may run it.*
    expect(found).toEqual(classified);
  });

  it("every ACTING export contains the reach it declares", () => {
    const acting = exportedFunctions().filter((f) => f.name in ACTING);
    expect(acting.map((f) => f.name).sort()).toEqual(Object.keys(ACTING).sort());
    for (const fn of acting) {
      const declared = ACTING[fn.name]!.reaches;
      expect(`${fn.name} contains "${declared}": ${fn.body.includes(declared)}`)
        .toBe(`${fn.name} contains "${declared}": true`);
    }
  });

  it("…and every one of them reaches a REAL check by following those declarations to a fixpoint", () => {
    // A declaration of "I delegate to X" proves nothing unless X itself ends at a check. This
    // follows the edges until nothing new is reachable, and names anything left dangling.
    /**
     * The population is EVERY function in the module, not only the exported ones: `approveAbsence`
     * delegates to a private `decide`, and a fixpoint that could only see exports would call that
     * dangling when it is in fact the strictest path in the file.
     */
    const all = allFunctions();
    const bodyOf = (name: string): string => all.find((f) => f.name === name)?.body ?? "";
    const direct = (name: string): boolean => /rosterActPolicy\(|requireRosterAct\(/.test(bodyOf(name));
    const guarded = new Set(all.map((f) => f.name).filter(direct));
    for (let pass = 0; pass < all.length; pass += 1) {
      for (const [name, { reaches }] of Object.entries(ACTING)) {
        const target = reaches.replace("(", "");
        if (!guarded.has(name) && guarded.has(target)) guarded.add(name);
      }
    }
    const dangling = Object.keys(ACTING).filter((n) => !guarded.has(n));
    expect(dangling).toEqual([]);
  });

  it("the scanner FINDS functions — the census cannot be green because it looked at nothing", () => {
    // Leg 3's two tests above are satisfiable by an empty scan. This is the one that is not: if the
    // regex, the directory or the file filter ever stops working, THIS goes red rather than the
    // whole census quietly certifying nothing.
    const found = exportedFunctions();
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(NOT_ACTING).length);
    expect(found.map((f) => f.name)).toContain("rosterActPolicy");
    expect(found.some((f) => f.file === "access.ts")).toBe(true);
  });
});
