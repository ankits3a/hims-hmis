import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { roles, users } from "./auth";
import { orgDepartments } from "./org";
import { resources } from "./resources";

/**
 * PHASE R (R1) — **WHAT A PERSON ANSWERS AS, TONIGHT.** The roster's own vocabulary of duty.
 *
 * ═══ THE STRESS TEST'S FIRST FINDING, AND THIS TABLE IS THE ANSWER TO IT (S1) ═══
 *
 * Plan 20 T1 keyed an assignment on `role_key` — a foreign key to the **RBAC** role. RBAC has
 * `doctor`, `pharmacy`, `anaesthetist`. It has no junior resident, no senior resident, no casualty
 * medical officer, no staff nurse. Roster everybody as `doctor` and `whoIsOn("doctor", 02:14)`
 * returns *every doctor on any published roster in the building*. Three vocabularies had been
 * conflated:
 *
 *   · **cadre** — what payroll calls you (faculty, senior resident, intern, nurse);
 *   · **RBAC role** — what you may DO in this software (`doctor`, `cashier`, `lab_technician`);
 *   · **duty position** — what you ANSWER AS in a window (`night_jr_pool`, `casualty_mo`).
 *
 * `roster_positions` is the third of those, and only the third. It is the key an assignment carries
 * and the key the resolver is asked for.
 *
 * ═══ `eligible_role_key` IS THE ONLY LINK TO RBAC, AND IT IS A CHECK, NEVER A GRANT (D7) ═══
 *
 * Being on tonight's roster as `radiologist_on_call` does not make you a radiologist in this
 * software; it means the hospital expects to be able to reach you. The one thing this column does
 * is refuse an ASSIGNMENT of somebody who does not already hold the role — an eligibility test at
 * the moment of rostering, so a rota cannot quietly become an access-control system. The plan is
 * explicit that **the roster grants no permission**, and this is the column that would have been
 * the temptation.
 *
 * ═══ THE POSITION CARRIES THE DEFAULTS A SLOT INHERITS ═══
 *
 * `default_mode` (is this position normally physically present, or reachable?) and
 * `max_presence_hours` (what length of continuous presence is absurd for it?) live here rather
 * than as constants in code, because they differ by position and an institution changes them.
 * `counts_toward_requirements` is what makes a *supernumerary* slot (V16) representable: a position
 * that exists for training and does not fill a hole.
 *
 * ═══ NO `site_id` ═══
 *
 * `key` is the primary key and a position is a vocabulary word, not an instance: `unit_sr` means
 * the same thing at every site, and a per-site copy would give the resolver two keys for one
 * question. The tables that hold *instances* (teams, periods, assignments) carry `site_id`.
 */

export const ROSTER_CADRES = [
  "faculty", "senior_resident", "junior_resident", "intern", "medical_officer",
  "nurse", "technician", "pharmacist", "admin", "support",
] as const;
export type RosterCadre = (typeof ROSTER_CADRES)[number];

/**
 * `presence` = physically at a station; `call` = reachable. A consultant on 24-hour call who also
 * sits in OPD is not double-booked — that is what on-call MEANS — so only presence × presence is a
 * clash, and the exclusion constraint R2 adds is partial on this column.
 */
export const ROSTER_ASSIGNMENT_MODES = ["presence", "call"] as const;
export type RosterAssignmentMode = (typeof ROSTER_ASSIGNMENT_MODES)[number];

const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const rosterPositions = pgTable(
  "roster_positions",
  {
    /** `unit_sr`, `night_jr_pool`, `casualty_mo` — stable, quoted in rules and requirements. */
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    cadre: text("cadre").notNull(),
    /**
     * Where this position sits when a call has to go up: 1 is the first person rung, higher is
     * further up. The ladder phase consumes it; the validator uses it to say "no rung above this".
     */
    ladderRank: integer("ladder_rank").notNull(),
    /** The RBAC role a person must ALREADY hold to be assignable here. NULL = no RBAC test. */
    eligibleRoleKey: text("eligible_role_key").references(() => roles.key),
    defaultMode: text("default_mode").notNull().default("presence"),
    /** The longest continuous PRESENCE this position may be planned for. The 24-hour take is 24. */
    maxPresenceHours: integer("max_presence_hours").notNull(),
    /** False for a training or shadowing slot: it is filled, and it still leaves the hole open (V16). */
    countsTowardRequirements: boolean("counts_toward_requirements").notNull().default(true),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("roster_positions_label_ux").on(t.label),
    check("roster_positions_cadre_ck", sql`${t.cadre} in ('faculty', 'senior_resident', 'junior_resident', 'intern', 'medical_officer', 'nurse', 'technician', 'pharmacist', 'admin', 'support')`),
    check("roster_positions_default_mode_ck", sql`${t.defaultMode} in ('presence', 'call')`),
    check("roster_positions_ladder_rank_ck", sql`${t.ladderRank} >= 1`),
    /**
     * 36 hours is the DB's outer absurdity bound, not a rule: the 24-hour take plus a morning
     * handover is legitimate in this country's teaching hospitals and the rules engine (R8) is
     * where 74 h/week, 12 h rest and 1-in-3 are argued. A number here that encoded a policy would
     * put the policy somewhere no citation can reach it.
     */
    check("roster_positions_max_presence_ck", sql`${t.maxPresenceHours} between 1 and 36`),
  ],
);

/* ═════════════════════════════ PHASE R (R2) — PERIODS, SLOTS, AMENDMENTS ═════════════════════════════ */

/**
 * ═══ A ROSTER IS A DRAFT UNTIL IT IS PUBLISHED; A RE-PUBLISH IS A NEW VERSION (D3) ═══
 *
 * `ot_lists` is the precedent, and the tariff versions before it: a half-entered roster that
 * silently started answering "who is on call" is worse than no roster. Only a PUBLISHED period's
 * assignments are `effective`, and only effective rows are ever read by a resolver.
 *
 * ═══ AND A SMALL CHANGE IS A ROW-LEVEL AMENDMENT, NOT A NEW VERSION (stress test S2) ═══
 *
 * Plan 20 T1 amended a published roster by copying all of it into v2 and re-publishing. Three
 * things break, and all three are ordinary nights in a hospital:
 *
 *   **(a) the lost update.** The SR drafts v2 from v1; a swap drafts v3 from v1 and publishes; the
 *   SR publishes v2 — and *v3's swap silently vanishes*, with no error anywhere. The
 *   evening-before holiday amends twenty-six unit rosters at 19:30, so every open draft in the
 *   building becomes that trap on the same evening.
 *
 *   **(b) the same-night swap cannot be published in either order.** Two units exchange a resident
 *   for one night. Whichever version is published first names somebody who is still live in the
 *   other unit's old one, and the presence constraint refuses it. There is no order that works —
 *   which is why `publishPeriods` takes a LIST.
 *
 *   **(c) scale.** A nurse floated from 3B to ICU at 02:00 copies ~20,000 rows and holds one lock
 *   the whole department queues behind: ~14 M rows a year instead of ~0.7 M.
 *
 * So the model is HYBRID. Whole-period versions stay for the BULK acts — a first publish, a re-plan
 * of the rest of a month. **Every small change is a row-level supersede inside the live period**: a
 * `roster_amendments` row carrying the reason and the approver, and on each assignment `live_from`,
 * `live_to`, `amendment_id` and `lineage_id`. "As known at T" becomes a filter on the row rather
 * than a hunt through versions, and a cross-unit swap is one transaction.
 *
 * ═══ TWO TIME AXES, AND CONFUSING THEM IS THE DEFECT THIS SHAPE EXISTS TO PREVENT ═══
 *
 *   · `[starts_at, ends_at)` — WHEN THE DUTY IS. What a resolver asks about.
 *   · `[live_from, live_to)` — WHEN THE ROSTER SAID SO. What an inquiry two years later asks about.
 *
 * The question a court asks is *"who was rostered at 03:10 that night, as it was known that night"*,
 * and it is answered by intersecting both. Nothing published is ever edited or deleted: a superseded
 * row keeps every original value except `live_to` and `effective`.
 */

export const ROSTER_PERIOD_STATUSES = ["draft", "published", "superseded"] as const;
export type RosterPeriodStatus = (typeof ROSTER_PERIOD_STATUSES)[number];

/** What a period's roster covers. `hospital` carries no `scope_id`; the others must. */
export const ROSTER_SCOPE_TYPES = ["hospital", "department", "team", "location"] as const;
export type RosterScopeType = (typeof ROSTER_SCOPE_TYPES)[number];

/** Who drafted it. `machine` periods are the proposer's (R9) and a human publishes them, or nobody does. */
export const ROSTER_ORIGINS = ["human", "machine"] as const;
export type RosterOrigin = (typeof ROSTER_ORIGINS)[number];

export const ROSTER_ASSIGNMENT_KINDS = ["duty", "teaching", "off"] as const;
export type RosterAssignmentKind = (typeof ROSTER_ASSIGNMENT_KINDS)[number];

/**
 * Weekly off, night off, duty off, compensatory off, public holiday, restricted holiday. A declared
 * OFF is a row on the roster and not an absence: the person is not away, they are not on duty, and
 * the requirement checker must be able to see the difference.
 */
export const ROSTER_OFF_KINDS = ["WO", "NO", "DO", "CO", "PH", "RH"] as const;
export type RosterOffKind = (typeof ROSTER_OFF_KINDS)[number];

/**
 * HOW FAR A SLOT'S COVER REACHES (stress test S4). The owner's night rule — 12-hour nights, 12
 * hours' rest, one night in three — is infeasible staffed unit by unit: a unit with three JRs has
 * one on night, one resting, one for ward, OPD and theatre, and nobody on that one's weekly off.
 * What AIIMS, PGIMER, CMC, KEM and the state colleges actually do is POOL the night at DEPARTMENT
 * level, and T1 could not represent it because a slot carried one unit. `department` is the shipped
 * default for nights; `team` is the default for everything else.
 */
export const ROSTER_COVER_SCOPES = ["team", "department", "location", "hospital"] as const;
export type RosterCoverScope = (typeof ROSTER_COVER_SCOPES)[number];

export const ROSTER_ASSIGNMENT_SOURCES = ["manual", "import", "proposer", "academic"] as const;
export type RosterAssignmentSource = (typeof ROSTER_ASSIGNMENT_SOURCES)[number];

export const ROSTER_AMENDMENT_KINDS = ["swap", "cover", "float", "withdrawal", "correction", "hold_over"] as const;
export type RosterAmendmentKind = (typeof ROSTER_AMENDMENT_KINDS)[number];

/** The actor kinds the envelope has. Recorded so "did a machine write this?" is answerable from the row. */
export const ROSTER_ACTOR_TYPES = ["user", "agent", "system", "patient"] as const;

export const rosterPeriods = pgTable(
  "roster_periods",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    title: text("title").notNull(), // "October 2026 — Orthopaedics Unit II": what a human calls it
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(), // exclusive
    /** Monotonic per (scope, starts_at) — a re-publish is a NEW version, never an edit. */
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    /** Which department answers for this roster. NULL only for a hospital-wide one. */
    departmentId: text("department_id").references(() => orgDepartments.id),
    /** The clinical unit or ward team, when the roster is one team's. FK added by R3. */
    teamId: text("team_id").references((): AnyPgColumn => rosterTeams.id),
    /**
     * THE POSITIONS THIS PERIOD ANSWERS FOR, and it is what makes the fallback safe (V14). A
     * resolver asked about a position this period does not declare must NOT read "nobody is on" off
     * a roster that was never about that position — it falls back to the RBAC answer. Without this
     * column the difference between "declared and empty" and "not this roster's business" is
     * unrepresentable, and the first is a silent hole while the second is normal.
     */
    coversPositions: text("covers_positions").array().notNull(),
    /**
     * V3 — the version this draft was made from. `publishPeriod` refuses if it is no longer the
     * live one: that is the lost update of S2(a), turned into a refusal a human can act on.
     */
    basedOnPeriodId: text("based_on_period_id").references((): AnyPgColumn => rosterPeriods.id),
    /**
     * V4 — SHA-256 of the canonical slot list, stamped AT PUBLISH. The publisher passes the hash
     * they reviewed; if the draft moved underneath them the publish is refused. "What the human
     * reviewed is what goes live" is otherwise an intention rather than a property.
     */
    contentHash: text("content_hash"),
    origin: text("origin").notNull().default("human"),
    /** The actor TYPE that drafted it, so V8's "a machine never publishes" is auditable from rows. */
    draftedByActorType: text("drafted_by_actor_type").notNull().default("user"),
    /**
     * When a human last touched this draft. A machine must never be the second writer on a draft a
     * person is working in — it cannot see what they meant, only what they typed.
     */
    humanTouchedAt: timestamp("human_touched_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByPeriodId: text("superseded_by_period_id").references((): AnyPgColumn => rosterPeriods.id),
    siteId: text("site_id").notNull().default("main"), // `events.site_id` / `resources.site_id`, DD3
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roster_periods_scope_start_version_ux")
      .on(t.siteId, t.scopeType, sql`coalesce(${t.scopeId}, '')`, t.startsAt, t.version),
    index("roster_periods_status_window_idx").on(t.status, t.startsAt, t.endsAt),
    index("roster_periods_based_on_idx").on(t.basedOnPeriodId),
    check("roster_periods_status_ck", sql`${t.status} in ('draft', 'published', 'superseded')`),
    check("roster_periods_scope_type_ck", sql`${t.scopeType} in ('hospital', 'department', 'team', 'location')`),
    check("roster_periods_scope_id_ck", sql`(${t.scopeType} = 'hospital') = (${t.scopeId} is null)`),
    check("roster_periods_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_periods_version_ck", sql`${t.version} >= 1`),
    check("roster_periods_origin_ck", sql`${t.origin} in ('human', 'machine')`),
    check("roster_periods_actor_type_ck", sql`${t.draftedByActorType} in ('user', 'agent', 'system', 'patient')`),
    /**
     * A roster that answers for no position answers nothing, and would read as a hole everywhere.
     *
     * `coalesce` is load-bearing and was bought by a red run: `array_length('{}', 1)` is **NULL**,
     * not 0, and a CHECK whose expression is NULL PASSES. Written the obvious way, this constraint
     * accepted exactly the row it exists to refuse.
     */
    check("roster_periods_covers_ck", sql`coalesce(array_length(${t.coversPositions}, 1), 0) >= 1`),
    /** The publication pair: both, or neither — and published/superseded rows always carry them. */
    check(
      "roster_periods_published_ck",
      sql`(${t.status} = 'draft') = (${t.publishedAt} is null) and (${t.publishedAt} is null) = (${t.publishedBy} is null)`,
    ),
    check("roster_periods_superseded_ck", sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`),
    /** V6 — a version cannot stop answering before it started. Both stamps come from the DB clock. */
    check("roster_periods_supersede_order_ck", sql`${t.supersededAt} is null or ${t.supersededAt} >= ${t.publishedAt}`),
    /** V4 — the hash is stamped at publish and kept for ever after; a draft has none. */
    check("roster_periods_hash_ck", sql`(${t.status} = 'draft') = (${t.contentHash} is null)`),
  ],
);

export const rosterAmendments = pgTable(
  "roster_amendments",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id").notNull().references(() => rosterPeriods.id),
    kind: text("kind").notNull(),
    /** Why. Shown to everybody the change touches — a swap with no reason is a swap nobody accepts. */
    reason: text("reason").notNull(),
    requestedBy: text("requested_by").notNull().references(() => users.id),
    approvedBy: text("approved_by").notNull().references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    /**
     * The reliever did not come and the evening nurse stayed the night; the roster is corrected at
     * 09:00 the next day. That is not the same act as planning a change, and a register that cannot
     * tell them apart cannot be audited.
     */
    afterTheFact: boolean("after_the_fact").notNull().default(false),
    /** V6 — the DATABASE's clock, and the instant every row this amendment closes and opens shares. */
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    supersededCount: integer("superseded_count").notNull().default(0),
    addedCount: integer("added_count").notNull().default(0),
    /**
     * The four audit columns, as every table here carries them. They are NOT duplicates of
     * `requested_by` / `approved_by`: those two are DOMAIN facts — who asked and who allowed — and
     * `created_by` is the actor that wrote the row, which for a machine-drafted cover is not a person.
     */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("roster_amendments_period_idx").on(t.periodId, t.appliedAt),
    check("roster_amendments_kind_ck", sql`${t.kind} in ('swap', 'cover', 'float', 'withdrawal', 'correction', 'hold_over')`),
    check("roster_amendments_reason_ck", sql`length(btrim(${t.reason})) between 1 and 500`),
    check("roster_amendments_counts_ck", sql`${t.supersededCount} >= 0 and ${t.addedCount} >= 0`),
  ],
);

export const rosterAssignments = pgTable(
  "roster_assignments",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id").notNull().references(() => rosterPeriods.id),
    /**
     * NULLABLE, and that is the S3 fix: a VACANT slot is a hole the requirement checker can see.
     * A roster that can only express filled slots cannot say "this unit is short a JR tonight",
     * and the validator's whole job is to say exactly that.
     */
    userId: text("user_id").references(() => users.id),
    /**
     * WHAT THIS PERSON ANSWERS AS — the key `whoIsOn` takes, and the S1 fix. T1 had `role_key`
     * pointing at RBAC, so every resident rostered as `doctor` answered every doctor's question.
     */
    positionKey: text("position_key").notNull().references(() => rosterPositions.key),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(), // exclusive
    /**
     * NULL exactly when this is an OFF row: a day off is neither presence nor call. It still
     * DEFAULTS to `presence`, so an ordinary insert from an importer or a repair script lands on
     * the common case rather than tripping `off_ck` with a message about days off.
     */
    mode: text("mode").default("presence"),
    kind: text("kind").notNull().default("duty"),
    offKind: text("off_kind"),
    /** Whose work this duty is done for. Always known: a slot belongs to a department even when pooled. */
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    teamId: text("team_id").references((): AnyPgColumn => rosterTeams.id),
    coverScope: text("cover_scope").notNull().default("team"),
    /** 1 is the first person rung. NULL where the slot is presence and there is no ladder to climb. */
    callTier: smallint("call_tier"),
    /** V16 — a training slot that is filled and still leaves the requirement unmet. */
    supernumerary: boolean("supernumerary").notNull().default(false),
    /** FK arrives with R7's `roster_shift_defs`. */
    shiftDefId: text("shift_def_id"),
    locationResourceId: text("location_resource_id").references(() => resources.id),
    batchRef: text("batch_ref"),
    topic: text("topic"),
    swapOfId: text("swap_of_id").references((): AnyPgColumn => rosterAssignments.id),
    source: text("source").notNull().default("manual"),
    note: text("note"),
    /**
     * V5 — TRUE exactly while this row's period is PUBLISHED and this row has not been superseded.
     * Denormalised because the one invariant that must be unrepresentable — ONE PERSON PHYSICALLY IN
     * TWO PLACES — is an EXCLUDE constraint, and a constraint cannot look through a foreign key.
     * Three writers and no others: `publishPeriod`, `amend`, `supersede`.
     */
    effective: boolean("effective").notNull().default(false),
    /** The KNOWLEDGE axis. When the roster began saying this, and when it stopped. */
    liveFrom: timestamp("live_from", { withTimezone: true }).notNull().defaultNow(),
    liveTo: timestamp("live_to", { withTimezone: true }),
    amendmentId: text("amendment_id").references(() => rosterAmendments.id),
    /**
     * The slot's IDENTITY across every amendment of it. A row copied by an amendment keeps it; a
     * genuinely new slot sets it to its own id. "Show me this duty's whole history" is one query.
     */
    lineageId: text("lineage_id").notNull(),
    proposedByActorType: text("proposed_by_actor_type").notNull().default("user"),
    proposedByActorId: text("proposed_by_actor_id").notNull(),
    /** The proposer run that drafted this slot, so a bad run is findable and reversible as a set. */
    proposalRunId: text("proposal_run_id"),
    /** Who confirmed a machine's proposal. A machine-proposed slot nobody confirmed is not live. */
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("roster_assignments_period_idx").on(t.periodId),
    index("roster_assignments_user_window_idx").on(t.userId, t.startsAt),
    index("roster_assignments_lineage_idx").on(t.lineageId),
    check("roster_assignments_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_assignments_mode_ck", sql`${t.mode} is null or ${t.mode} in ('presence', 'call')`),
    check("roster_assignments_kind_ck", sql`${t.kind} in ('duty', 'teaching', 'off')`),
    check("roster_assignments_source_ck", sql`${t.source} in ('manual', 'import', 'proposer', 'academic')`),
    check("roster_assignments_cover_scope_ck", sql`${t.coverScope} in ('team', 'department', 'location', 'hospital')`),
    check("roster_assignments_off_kind_ck", sql`${t.offKind} is null or ${t.offKind} in ('WO', 'NO', 'DO', 'CO', 'PH', 'RH')`),
    /**
     * An OFF row names a PERSON (nobody is vacantly off) and has no mode; every other row has a
     * mode and no off-kind. Both directions, because either half alone leaves the other expressible.
     */
    check(
      "roster_assignments_off_ck",
      sql`case when ${t.kind} = 'off' then ${t.mode} is null and ${t.userId} is not null and ${t.offKind} is not null
                else ${t.mode} is not null and ${t.offKind} is null end`,
    ),
    check("roster_assignments_call_tier_ck", sql`${t.callTier} is null or ${t.callTier} >= 1`),
    /** A presence window longer than this is a typing error (a wrong month, a wrong year), not a duty. */
    check("roster_assignments_presence_hours_ck", sql`${t.mode} is distinct from 'presence' or ${t.endsAt} - ${t.startsAt} <= interval '36 hours'`),
    /** And nothing at all is a single window of more than five weeks: a month plus its spill, at most. */
    check("roster_assignments_window_cap_ck", sql`${t.endsAt} - ${t.startsAt} <= interval '35 days'`),
    check("roster_assignments_live_ck", sql`${t.liveTo} is null or ${t.liveTo} > ${t.liveFrom}`),
    /** V5, the half a constraint can hold: a superseded row is never effective. */
    check("roster_assignments_effective_ck", sql`not ${t.effective} or ${t.liveTo} is null`),
    check("roster_assignments_confirmed_ck", sql`(${t.confirmedByUserId} is null) = (${t.confirmedAt} is null)`),
    check("roster_assignments_actor_type_ck", sql`${t.proposedByActorType} in ('user', 'agent', 'system', 'patient')`),
  ],
);

/* ═════════════════════════ PHASE R (R3) — TEAMS, PEOPLE, AND WHO STANDS IN ═════════════════════════ */

/**
 * ═══ THE UNIT IS THE THING THE WHOLE TEACHING HOSPITAL IS ORGANISED AROUND ═══
 *
 * A "unit" in an Indian medical college is a standing team — a professor, an associate, an
 * assistant, a senior resident, its junior residents and its interns — that owns beds, takes
 * emergency admissions on its own day, runs its own OPD and teaches its own students. UG-MSR 2023's
 * implied establishment for 150 seats is 5/5/3/3/4/2/2/1/1 plus Respiratory Medicine: **27 units.**
 *
 * ═══ AND IT IS GENERALISED, BECAUSE NURSES ARE THE LARGER WORKFORCE (stress test S3) ═══
 *
 * A ward's nursing team, a service like the blood bank, and a department's night POOL are the same
 * shape: a standing group of people with positions in it. So the table is `roster_teams` with a
 * `kind`, not `clinical_units` — the alternative was a second set of tables for nursing, and the
 * stress test's whole S3 finding is that the second set never gets written and the ward gets no
 * roster.
 *
 * ═══ A MEMBERSHIP IS DATED, AND JUDGED AT THE SLOT'S START ═══
 *
 * People move: a JR rotates to another unit for three months, an intern for two weeks, a nurse is
 * floated for one night. `starts_at`/`ends_at` make that representable, and the resolver asks
 * *"who was a member when this duty began"* rather than *"who is a member now"* — otherwise
 * yesterday's roster changes when somebody transfers today.
 *
 *   · **`parent`** — where you belong. Exactly one at a time, and the EXCLUDE says so.
 *   · **`rotation`** — where you are posted for a while. The district residency, the intern's
 *     two weeks in ENT, the PG's stint in ICU.
 *   · **`float`** — one night's cover somewhere else, and you are still your own unit's.
 *
 * **`retains_parent_nights`** is the one that surprises people: a resident on rotation usually
 * still takes their parent unit's nights, because the night pool is a department's and the rotation
 * is within it. Getting this wrong empties a night pool silently.
 */

export const ROSTER_TEAM_KINDS = ["clinical_unit", "ward_team", "service", "pool"] as const;
export type RosterTeamKind = (typeof ROSTER_TEAM_KINDS)[number];

export const ROSTER_MEMBERSHIP_KINDS = ["parent", "rotation", "float"] as const;
export type RosterMembershipKind = (typeof ROSTER_MEMBERSHIP_KINDS)[number];

export const ROSTER_TEAM_ROLES = ["head", "faculty", "senior_resident", "junior_resident", "intern", "member", "lead"] as const;
export type RosterTeamRole = (typeof ROSTER_TEAM_ROLES)[number];

/** What payroll and the NMC return call somebody. Distinct from POSITION (what they answer as). */
export const ROSTER_GRADES = [
  "professor", "associate_professor", "assistant_professor", "senior_resident",
  "jr1", "jr2", "jr3", "intern", "medical_officer",
  "nursing_superintendent", "ward_sister", "staff_nurse", "technician", "pharmacist", "admin", "support",
] as const;
export type RosterGrade = (typeof ROSTER_GRADES)[number];

/** Someone standing in for a head who is away. The head's own membership is untouched. */
export const ROSTER_OFFICIATING_ROLES = ["head", "hod", "lead"] as const;
export type RosterOfficiatingRole = (typeof ROSTER_OFFICIATING_ROLES)[number];

/**
 * What one person may let another do in their absence. Deliberately a SHORT list, and deliberately
 * not "everything": a delegation is how a HOD going on leave keeps their department running, not a
 * way to hand over an identity. `rosterActPolicy`'s `never` column is unaffected — a delegation
 * moves a PERMISSION between people and never makes a machine into a person.
 */
export const ROSTER_AUTHORITIES = [
  "publish", "approve_swap", "override_rule", "approve_leave", "declare_holiday", "declare_mode",
] as const;
export type RosterAuthority = (typeof ROSTER_AUTHORITIES)[number];

const teamAudit = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const rosterTeams = pgTable(
  "roster_teams",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    /** `MED-U2`, `WARD-3B`, `MED-NIGHT` — what a human says out loud and a duty roster prints. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The ward or theatre this team is normally found in. NULL for a pool, which is everywhere. */
    homeLocationResourceId: text("home_location_resource_id").references(() => resources.id),
    leadUserId: text("lead_user_id").references(() => users.id),
    /** Unit II's `2`. Ordering for a screen and for the take sequence, not an identifier. */
    unitNumber: integer("unit_number"),
    /** What the NMC return says this unit holds. The bed ALLOTMENT table says which beds. */
    sanctionedBeds: integer("sanctioned_beds"),
    /**
     * FALSE until a head of department confirms the unit exists as seeded. 20-U §2 is explicit that
     * the 5/5/3/3/4/2/2/1/1 establishment is **ours, not a regulator's number** — UG-MSR 2023
     * dropped the units table entirely — so the seed is a DRAFT a human ratifies, and
     * `standup:check` lists what is still unconfirmed rather than letting a screen present our
     * arithmetic as the NMC's.
     */
    active: boolean("active").notNull().default(false),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    siteId: text("site_id").notNull().default("main"),
    ...teamAudit,
  },
  (t) => [
    uniqueIndex("roster_teams_code_ux").on(t.siteId, t.code),
    index("roster_teams_department_idx").on(t.departmentId, t.active),
    check("roster_teams_kind_ck", sql`${t.kind} in ('clinical_unit', 'ward_team', 'service', 'pool')`),
    check("roster_teams_validity_ck", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
    check("roster_teams_unit_number_ck", sql`${t.unitNumber} is null or ${t.unitNumber} >= 1`),
    check("roster_teams_beds_ck", sql`${t.sanctionedBeds} is null or ${t.sanctionedBeds} >= 0`),
  ],
);

export const rosterTeamMemberships = pgTable(
  "roster_team_memberships",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    userId: text("user_id").notNull().references(() => users.id),
    /** What they answer as in this team — the same vocabulary a slot carries. */
    positionKey: text("position_key").notNull().references(() => rosterPositions.key),
    grade: text("grade").notNull(),
    roleInTeam: text("role_in_team").notNull(),
    kind: text("kind").notNull().default("parent"),
    /** A rotation usually still takes the PARENT department's nights. Getting this wrong empties a pool. */
    retainsParentNights: boolean("retains_parent_nights").notNull().default(false),
    /** Until this instant they are extra, and do not fill a requirement (V16). */
    supernumeraryUntil: timestamp("supernumerary_until", { withTimezone: true }),
    /** Where this person sits in a rotating pattern — the proposer's (R9) balance point. */
    patternOffset: integer("pattern_offset"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    source: text("source").notNull().default("manual"),
    ...teamAudit,
  },
  (t) => [
    index("roster_team_memberships_team_idx").on(t.teamId, t.startsAt),
    index("roster_team_memberships_user_idx").on(t.userId, t.startsAt),
    check("roster_team_memberships_kind_ck", sql`${t.kind} in ('parent', 'rotation', 'float')`),
    check("roster_team_memberships_role_ck", sql`${t.roleInTeam} in ('head', 'faculty', 'senior_resident', 'junior_resident', 'intern', 'member', 'lead')`),
    check("roster_team_memberships_grade_ck", sql`${t.grade} in ('professor', 'associate_professor', 'assistant_professor', 'senior_resident', 'jr1', 'jr2', 'jr3', 'intern', 'medical_officer', 'nursing_superintendent', 'ward_sister', 'staff_nurse', 'technician', 'pharmacist', 'admin', 'support')`),
    check("roster_team_memberships_window_ck", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("roster_team_memberships_source_ck", sql`${t.source} in ('manual', 'import', 'academic')`),
    /** Only a PARENT membership has a night-retention question; a float is one night by definition. */
    check("roster_team_memberships_retains_ck", sql`not ${t.retainsParentNights} or ${t.kind} = 'rotation'`),
  ],
);

export const rosterOfficiating = pgTable(
  "roster_officiating",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    reason: text("reason").notNull(),
    approvedBy: text("approved_by").notNull().references(() => users.id),
    ...teamAudit,
  },
  (t) => [
    index("roster_officiating_team_idx").on(t.teamId, t.role, t.startsAt),
    check("roster_officiating_role_ck", sql`${t.role} in ('head', 'hod', 'lead')`),
    check("roster_officiating_window_ck", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("roster_officiating_reason_ck", sql`length(btrim(${t.reason})) between 1 and 500`),
  ],
);

export const rosterDelegations = pgTable(
  "roster_delegations",
  {
    id: text("id").primaryKey(),
    delegatorUserId: text("delegator_user_id").notNull().references(() => users.id),
    delegateUserId: text("delegate_user_id").notNull().references(() => users.id),
    authority: text("authority").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    ...teamAudit,
  },
  (t) => [
    index("roster_delegations_delegate_idx").on(t.delegateUserId, t.startsAt, t.endsAt),
    check("roster_delegations_authority_ck", sql`${t.authority} in ('publish', 'approve_swap', 'override_rule', 'approve_leave', 'declare_holiday', 'declare_mode')`),
    check("roster_delegations_scope_ck", sql`${t.scopeType} in ('hospital', 'department', 'team', 'location')`),
    check("roster_delegations_scope_id_ck", sql`(${t.scopeType} = 'hospital') = (${t.scopeId} is null)`),
    /**
     * A delegation ALWAYS ends. An open-ended one is a transfer of authority nobody reviews, which
     * is the thing a delegation is meant not to be — so `ends_at` is NOT NULL here, unlike every
     * other window in this file.
     */
    check("roster_delegations_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_delegations_reason_ck", sql`length(btrim(${t.reason})) between 1 and 500`),
    /** Delegating to yourself is not a delegation. */
    check("roster_delegations_distinct_ck", sql`${t.delegateUserId} <> ${t.delegatorUserId}`),
  ],
);

/**
 * Which beds a unit holds. NMC's return asks for it, and a new admission's default placement uses
 * it — nothing else. The BED itself is a `resources` row; this table only says whose it is, when.
 */
export const rosterBedAllotments = pgTable(
  "roster_bed_allotments",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ...teamAudit,
  },
  (t) => [
    index("roster_bed_allotments_team_idx").on(t.teamId, t.startsAt),
    check("roster_bed_allotments_window_ck", sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
  ],
);
