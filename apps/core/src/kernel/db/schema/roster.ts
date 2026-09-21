import { sql } from "drizzle-orm";
import {
  boolean, check, date, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
    /** FK added by R7. */
    shiftDefId: text("shift_def_id").references((): AnyPgColumn => rosterShiftDefs.id),
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

/* ═════════════════════ PHASE R (R4) — ABSENCE, FOR EVERY MEMBER OF STAFF ═════════════════════ */

/**
 * ═══ THE SYSTEM OF RECORD FOR WHO IS AWAY, AND WHY IT COULD NOT BE `opd_doctor_leaves` ═══
 *
 * The validator "reads approved leave". Before this table the only leave in the building was
 * `opd_doctor_leaves`, keyed on an **OPD doctor** — so a junior resident, an intern, a staff nurse
 * and a pharmacist could not have a row at all (stress test S3). They are most of the people a
 * roster is about, and the hospital's answer to *"is anyone away that night?"* was silently
 * restricted to the consultants who happen to hold a clinic.
 *
 * And owner ruling RU-2 removed the HR SaaS that an earlier plan had given leave to. So this is
 * ours, it covers everybody, and `opd_doctor_leaves` becomes a PROJECTION of it: `scheduleLeave`
 * keeps its API and writes both rows in one transaction.
 *
 * ═══ THE REASON IS THE APPROVER'S, AND NOBODY ELSE'S (D6) ═══
 *
 * A leave reason is *"my father is in ICU"*, *"chemotherapy"*, *"court summons"*. It is the single
 * most sensitive free-text field this phase stores. The column is nullable, it never travels on an
 * event (V9), and the read helper nulls it for every reader who is neither the person nor the
 * person who decided it.
 *
 * ═══ `abstaining` AND `unauthorised` ARE ABSENCE KINDS, DELIBERATELY ═══
 *
 * A strike and a no-show are not leave, and a hospital that cannot represent them cannot roster
 * around them. Recording one is not a judgement about it; it is the difference between a ward
 * everybody believes is staffed and a ward somebody is sent to.
 */
export const STAFF_ABSENCE_KINDS = [
  "CL", "EL", "ML", "maternity", "paternity", "comp_off", "night_off", "duty_off",
  "deputation", "academic", "study", "abstaining", "unauthorised",
] as const;
export type StaffAbsenceKind = (typeof STAFF_ABSENCE_KINDS)[number];

export const STAFF_ABSENCE_STATUSES = ["requested", "approved", "rejected", "cancelled"] as const;
export type StaffAbsenceStatus = (typeof STAFF_ABSENCE_STATUSES)[number];

/**
 * What somebody must hold before they may be rostered to a position that needs it. `nmr`/`smr` are
 * the national and state medical registers; the rest are the certifications a ward actually asks
 * for before letting a person run a resuscitation, a ventilator or a chemotherapy round.
 */
export const STAFF_CREDENTIAL_KEYS = [
  "nmr", "smr", "nursing_council", "pharmacy_council",
  "bls", "acls", "nrp", "ventilator", "chemo",
  "pcpndt_registered", "aerb_rso",
] as const;
export type StaffCredentialKey = (typeof STAFF_CREDENTIAL_KEYS)[number];

export const staffAbsences = pgTable(
  "staff_absences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(), // exclusive
    status: text("status").notNull().default("requested"),
    requestedBy: text("requested_by").notNull().references(() => users.id),
    approvedBy: text("approved_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** D6 — THE APPROVER'S, AND NOBODY ELSE'S. See the header. */
    reason: text("reason"),
    /**
     * The biometric attendance system the Government requires a medical college to file against.
     * A leave approved here and not entered there is a discrepancy an inspection finds, so the
     * mark is a column rather than a habit.
     */
    aebasEnteredAt: timestamp("aebas_entered_at", { withTimezone: true }),
    aebasEnteredBy: text("aebas_entered_by").references(() => users.id),
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("staff_absences_user_window_idx").on(t.userId, t.startsAt),
    index("staff_absences_status_idx").on(t.status, t.startsAt),
    check("staff_absences_kind_ck", sql`${t.kind} in ('CL', 'EL', 'ML', 'maternity', 'paternity', 'comp_off', 'night_off', 'duty_off', 'deputation', 'academic', 'study', 'abstaining', 'unauthorised')`),
    check("staff_absences_status_ck", sql`${t.status} in ('requested', 'approved', 'rejected', 'cancelled')`),
    check("staff_absences_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("staff_absences_source_ck", sql`${t.source} in ('manual', 'import', 'opd', 'academic')`),
    /**
     * A decision has a decider and an instant, or it has not happened — and **a CANCELLED absence
     * keeps whatever decision it already had.**
     *
     * Written first as `(status in ('approved','rejected')) = (decided_at is not null)`, which is
     * the obvious reading and is wrong in the ordinary case: a consultant's approved leave is
     * called off, the status becomes `cancelled`, and the row still carries the name of whoever
     * approved it — as it must, because that approval happened and the record of it is the point.
     * The constraint refused the update. Found by the OPD projection test, whose cancel path
     * exercises an APPROVED row; `absences.test.ts` had only ever cancelled a REQUESTED one.
     */
    check(
      "staff_absences_decided_ck",
      sql`case
            when ${t.status} = 'requested' then ${t.decidedAt} is null
            when ${t.status} in ('approved', 'rejected') then ${t.decidedAt} is not null
            else true
          end
          and (${t.decidedAt} is null) = (${t.approvedBy} is null)`,
    ),
    /** Filed with the biometric system, or not — never half. */
    check("staff_absences_aebas_ck", sql`(${t.aebasEnteredAt} is null) = (${t.aebasEnteredBy} is null)`),
  ],
);

export const staffCredentials = pgTable(
  "staff_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    credentialKey: text("credential_key").notNull(),
    /** The register number, the certificate number — what an inspector asks to see. */
    reference: text("reference").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    verifiedBy: text("verified_by").references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("staff_credentials_user_idx").on(t.userId, t.credentialKey),
    check("staff_credentials_key_ck", sql`${t.credentialKey} in ('nmr', 'smr', 'nursing_council', 'pharmacy_council', 'bls', 'acls', 'nrp', 'ventilator', 'chemo', 'pcpndt_registered', 'aerb_rso')`),
    check("staff_credentials_window_ck", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
    check("staff_credentials_reference_ck", sql`length(btrim(${t.reference})) between 1 and 120`),
    /** Verified by somebody, at an instant — or not verified. A half-verified credential is not evidence. */
    check("staff_credentials_verified_ck", sql`(${t.verifiedBy} is null) = (${t.verifiedAt} is null)`),
  ],
);

/* ═══════════════════ PHASE R (R6) — WHERE AN ESCALATION GOES, AS CONFIGURATION ═══════════════════ */

/**
 * ═══ THE DESTINATION STOPS BEING A ROLE CONSTANT IN A KERNEL FILE ═══
 *
 * Before this, every escalation in the hospital went to the holder of a hard-coded RBAC role —
 * `DUTY_MANAGER_ROLE` written into `kernel/alerts/consumer.ts`, and a ladder rung's `toRole` written
 * into a workflow definition. Both answer *"who holds this role, anywhere"*, which is the S1 defect
 * one layer up: at 02:14 the hospital does not want whoever holds `duty_manager` on paper, it wants
 * **whoever is on duty as the duty manager tonight**.
 *
 * A row here says: *for this kind of alert, in this department, the person to reach is whoever is on
 * as this POSITION.* And because it is a row, a hospital changes it without a deploy.
 *
 * ═══ AND IT SHIPS INERT, WHICH IS THE WHOLE POINT ═══
 *
 * No row is seeded. With no row — and with `ROSTER_RESOLVER_ENABLED` off, and with a row whose
 * roster has published nothing — the recipients are **exactly** who they were before this phase:
 * `fallback_role_key`'s holders. A hospital opts in one alert kind at a time, and can see the
 * difference before it trusts it. The only thing that changes without a row is that the answer now
 * comes from one function instead of six copies of the same constant.
 *
 * ═══ `fallback_role_key` IS NOT OPTIONAL, AND THE DUTY MANAGER IS THE RUNG NEVER REMOVED ═══
 *
 * A configuration row that could point at a position and NOTHING else would let somebody configure
 * an alert into silence: a position nobody is rostered to, and the page simply never arrives. The
 * fallback is `NOT NULL` so that is unrepresentable.
 */
export const ROSTER_ESCALATION_KINDS = [
  "escalation.triggered", "notification.failed", "ops.mode_changed",
  "imaging.critical_overdue", "imaging.report_unread", "workflow.timer_rung",
] as const;
export type RosterEscalationKind = (typeof ROSTER_ESCALATION_KINDS)[number];

export const rosterEscalationTargets = pgTable(
  "roster_escalation_targets",
  {
    id: text("id").primaryKey(),
    alertKind: text("alert_kind").notNull(),
    /** Who to reach, as a DUTY rather than as an office: `duty_manager`, `night_sr_pool`… */
    positionKey: text("position_key").notNull().references(() => rosterPositions.key),
    /** NULL = this kind's hospital-wide default. A department row wins over it. */
    departmentId: text("department_id").references(() => orgDepartments.id),
    /** Where the answer comes from when no roster answers. NOT NULL: see the header. */
    fallbackRoleKey: text("fallback_role_key").notNull().references(() => roles.key),
    active: boolean("active").notNull().default(true),
    siteId: text("site_id").notNull().default("main"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One answer per (kind, department). Two rows for one question is two answers at 02:14. */
    uniqueIndex("roster_escalation_targets_kind_dept_ux")
      .on(t.siteId, t.alertKind, sql`coalesce(${t.departmentId}, '')`),
    check("roster_escalation_targets_kind_ck", sql`${t.alertKind} in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung')`),
  ],
);

/* ═══════════════════ PHASE R (R7) — THE CALENDAR A DEPARTMENT ACTUALLY RUNS ON ═══════════════════ */

/**
 * ═══ A TEACHING HOSPITAL'S WEEK IS A CYCLE, NOT A ROSTER TYPED OUT MONTH BY MONTH ═══
 *
 * Medicine's five units take emergencies in turn. Unit I takes Monday, does its post-take round on
 * Tuesday, theatre Wednesday, ward and teaching Thursday, and is back on take the following Monday.
 * That is a **five-day cycle anchored on a date**, and every unit's OPD, theatre and teaching hang
 * off it. Nobody types it: they type the cycle once, and the calendar produces the windows.
 *
 * So `roster_cycles` + `roster_cycle_entries` are the department's pattern, and
 * `roster_duty_windows` is what that pattern MATERIALISES to for a rolling ninety days. The
 * materialisation is not a cache: it is what the no-gap invariant (V11) is checked against, what a
 * screen reads, and what an inspection sees. `expandCycle()` is pure and is the ONLY generator, so
 * the materialised rows and the fallback answer can be compared instant by instant (V15).
 *
 * ═══ SUNDAY IS ITS OWN SEQUENCE, AND A DECLARED HOLIDAY DOES NOT ADVANCE IT ═══
 *
 * Sundays do not fit the weekday cycle — a five-day rotation would hand Sunday to a different unit
 * every week in a pattern nobody can remember, so departments keep a separate Sunday roster that
 * advances one step each Sunday. `roster_cycle_overlays` is that sequence.
 *
 * **And a holiday declared at 19:30 the night before must NOT advance it.** A bandh, a state
 * funeral, an unscheduled closure: the hospital runs the Sunday pattern for the day, and the unit
 * whose turn Sunday was still has that turn on Sunday. Getting this wrong shifts every unit's
 * Sunday for the rest of the year, silently, from one evening's decision. That is why
 * `overlay_index` is PERSISTED on the materialised window rather than recomputed from a date: the
 * sequence position is a fact about what happened, not a function of the calendar.
 */

export const ROSTER_ACTIVITIES = [
  "opd", "elective_ot", "ward_teaching", "take", "post_take", "backup", "minor_ot", "special_clinic",
] as const;
export type RosterActivity = (typeof ROSTER_ACTIVITIES)[number];

export const ROSTER_CYCLE_STATUSES = ["draft", "published", "superseded"] as const;

export const ROSTER_HOLIDAY_KINDS = ["gazetted", "restricted", "declared", "local"] as const;
export type RosterHolidayKind = (typeof ROSTER_HOLIDAY_KINDS)[number];

/**
 * What a holiday DOES to a department's day. Not every holiday closes the same things: a gazetted
 * holiday runs the Sunday pattern; a local one may shorten OPD and leave theatre alone; and the
 * common Indian-hospital case is **OPD off, emergency theatre proceeds** — an elective list is
 * cancelled and the take unit works exactly as it would on any night.
 */
export const ROSTER_HOLIDAY_PATTERNS = ["as_sunday", "opd_short", "opd_off_ot_proceeds"] as const;
export type RosterHolidayPattern = (typeof ROSTER_HOLIDAY_PATTERNS)[number];

export const ROSTER_WINDOW_SOURCES = ["cycle", "overlay", "amendment"] as const;

const calAudit = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const rosterShiftDefs = pgTable(
  "roster_shift_defs",
  {
    id: text("id").primaryKey(),
    /** `take`, `night`, `M`, `E`, `N`, `G` — what the ward whiteboard calls it. */
    code: text("code").notNull(),
    label: text("label").notNull(),
    /** NULL = the whole hospital's. A department may define its own `night` and mean something else. */
    departmentId: text("department_id").references(() => orgDepartments.id),
    /** Minutes from IST midnight. 08:00 is 480 — never a time string, never a UTC instant. */
    startMinute: integer("start_minute").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    /** The overlap at each end where both shifts are present and the ward is handed over. */
    handoverMinutes: integer("handover_minutes").notNull().default(0),
    /** Counts against "one night in three" and the night-rest rule (R8). */
    countsAsNight: boolean("counts_as_night").notNull().default(false),
    defaultMode: text("default_mode").notNull().default("presence"),
    maxPresenceHours: integer("max_presence_hours").notNull().default(12),
    siteId: text("site_id").notNull().default("main"),
    ...calAudit,
  },
  (t) => [
    uniqueIndex("roster_shift_defs_code_ux").on(t.siteId, sql`coalesce(${t.departmentId}, '')`, t.code),
    check("roster_shift_defs_start_ck", sql`${t.startMinute} between 0 and 1439`),
    check("roster_shift_defs_duration_ck", sql`${t.durationMinutes} between 1 and 2160`), // ≤ 36 h
    check("roster_shift_defs_handover_ck", sql`${t.handoverMinutes} between 0 and 240`),
    check("roster_shift_defs_mode_ck", sql`${t.defaultMode} in ('presence', 'call')`),
  ],
);

export const rosterCycles = pgTable(
  "roster_cycles",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    /** 5 for Medicine's five units; 2 for a two-unit department on alternate days. */
    cycleDays: integer("cycle_days").notNull(),
    /**
     * The IST DAY the cycle's day-zero falls on. A real calendar day declared by a human, which is
     * the one place in this phase a date column is right (§2's convention).
     */
    anchorIstDate: date("anchor_ist_date", { mode: "string" }).notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    /** E17 — a new version takes effect mid-period; the old one's windows stand until this instant. */
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    siteId: text("site_id").notNull().default("main"),
    ...calAudit,
  },
  (t) => [
    uniqueIndex("roster_cycles_dept_version_ux").on(t.siteId, t.departmentId, t.version),
    check("roster_cycles_days_ck", sql`${t.cycleDays} between 1 and 28`),
    check("roster_cycles_status_ck", sql`${t.status} in ('draft', 'published', 'superseded')`),
    check("roster_cycles_version_ck", sql`${t.version} >= 1`),
    check(
      "roster_cycles_published_ck",
      sql`(${t.status} = 'draft') = (${t.publishedAt} is null)
          and (${t.publishedAt} is null) = (${t.publishedBy} is null)
          and (${t.publishedAt} is null) = (${t.effectiveFrom} is null)`,
    ),
  ],
);

export const rosterCycleEntries = pgTable(
  "roster_cycle_entries",
  {
    id: text("id").primaryKey(),
    cycleId: text("cycle_id").notNull().references(() => rosterCycles.id),
    /** 0-based, `< cycle_days`. Day 0 is the anchor date. */
    dayIndex: integer("day_index").notNull(),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    activity: text("activity").notNull(),
    startMinute: integer("start_minute").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    ...calAudit,
  },
  (t) => [
    index("roster_cycle_entries_cycle_idx").on(t.cycleId, t.dayIndex),
    check("roster_cycle_entries_day_ck", sql`${t.dayIndex} >= 0`),
    check("roster_cycle_entries_activity_ck", sql`${t.activity} in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')`),
    check("roster_cycle_entries_start_ck", sql`${t.startMinute} between 0 and 1439`),
    check("roster_cycle_entries_duration_ck", sql`${t.durationMinutes} between 1 and 2880`),
  ],
);

/** The Sunday / holiday sequence, per department, advancing one position each time it is used. */
export const rosterCycleOverlays = pgTable(
  "roster_cycle_overlays",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    /** 0-based position in the sequence. */
    sequencePosition: integer("sequence_position").notNull(),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    activity: text("activity").notNull(),
    startMinute: integer("start_minute").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    /** The first IST day this sequence is counted from — its own anchor, not the cycle's. */
    anchorIstDate: date("anchor_ist_date", { mode: "string" }).notNull(),
    siteId: text("site_id").notNull().default("main"),
    ...calAudit,
  },
  (t) => [
    uniqueIndex("roster_cycle_overlays_position_ux").on(t.siteId, t.departmentId, t.sequencePosition, t.activity),
    check("roster_cycle_overlays_position_ck", sql`${t.sequencePosition} >= 0`),
    check("roster_cycle_overlays_activity_ck", sql`${t.activity} in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')`),
    check("roster_cycle_overlays_start_ck", sql`${t.startMinute} between 0 and 1439`),
    check("roster_cycle_overlays_duration_ck", sql`${t.durationMinutes} between 1 and 2880`),
  ],
);

export const rosterHolidays = pgTable(
  "roster_holidays",
  {
    istDate: date("ist_date", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    /** Which classes of staff it applies to — `['faculty','admin']`. Empty means everybody. */
    appliesTo: text("applies_to").array().notNull().default(sql`'{}'::text[]`),
    pattern: text("pattern").notNull().default("as_sunday"),
    declaredBy: text("declared_by").notNull().references(() => users.id),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    /** D3's two-step: each HOD confirms what their department will run, by this instant. */
    confirmationDueAt: timestamp("confirmation_due_at", { withTimezone: true }),
    siteId: text("site_id").notNull().default("main"),
    ...calAudit,
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.istDate] }),
    check("roster_holidays_kind_ck", sql`${t.kind} in ('gazetted', 'restricted', 'declared', 'local')`),
    check("roster_holidays_pattern_ck", sql`${t.pattern} in ('as_sunday', 'opd_short', 'opd_off_ot_proceeds')`),
  ],
);

export const rosterDutyWindows = pgTable(
  "roster_duty_windows",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    teamId: text("team_id").notNull().references(() => rosterTeams.id),
    activity: text("activity").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    cycleId: text("cycle_id").references(() => rosterCycles.id),
    /**
     * WHICH POSITION OF THE OVERLAY SEQUENCE THIS DAY USED. Persisted, not derived: a declared
     * holiday runs the overlay pattern WITHOUT advancing the sequence, so the position is a fact
     * about what happened rather than a function of the date. See this section's header.
     */
    overlayIndex: integer("overlay_index"),
    source: text("source").notNull().default("cycle"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    siteId: text("site_id").notNull().default("main"),
    ...calAudit,
  },
  (t) => [
    index("roster_duty_windows_dept_idx").on(t.departmentId, t.startsAt),
    index("roster_duty_windows_live_idx").on(t.departmentId, t.activity, t.startsAt).where(sql`${t.supersededAt} is null`),
    check("roster_duty_windows_activity_ck", sql`${t.activity} in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')`),
    check("roster_duty_windows_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_duty_windows_source_ck", sql`${t.source} in ('cycle', 'overlay', 'amendment')`),
  ],
);

/**
 * PHASE R (R8) — **WHETHER A ROSTER IS ANY GOOD.** Requirements, rules, findings, and the dated
 * overrides a department is allowed for a season.
 *
 * ═══ THE DISTINCTION THIS WHOLE SECTION RESTS ON ═══
 *
 * R2's publish gate refuses what can never be right: a window that ends before it starts, a person
 * in two rooms, a publish that would silently undo somebody's work. **Everything here is different
 * in kind.** "Fewer than two junior residents on this unit" is not impossible — it is most Indian
 * teaching hospitals on most nights of the year, and a roster that says so is telling the truth.
 * So a rule produces a FINDING, a finding carries a severity, and a human with a name may accept a
 * `warn` with a reason that is kept. Only `block` stops a publish, and even a block is a rule row
 * somebody can see rather than a branch in code.
 *
 * ═══ WHY REQUIREMENTS ARE ROWS AND NOT CODE (R-067, R-182) ═══
 *
 * "A take window needs at least one SR and one JR present and a faculty on call" is a sentence that
 * changes per department, per day class, and per whatever the regulator said last. Written as code
 * it needs a developer and a deploy; written as rows it needs a HOD and an approval. Every
 * requirement therefore carries its own `authority` and `citation`, so a screen can always answer
 * *who says so* — and so that a requirement nobody can source is visibly an `institution` rule
 * rather than passing itself off as the NMC's.
 *
 * ═══ THE `state` AUTHORITY IS IN THE VOCABULARY AND HAS NO ROWS (owner, 2026-09-21) ═══
 *
 * The college is in Bihar. Knowing the State is not knowing the State's mandates, and a rule row
 * carrying a citation nobody has read is worse than an absent one — it would be enforced, shown to
 * a HOD as law, and believed. So `state` is a value this column must be able to hold, and R8 seeds
 * not one row with it. A hospital adds them when somebody has actually read them.
 */

/** `block` stops a publish. `warn` may be accepted by a named human with a reason. `info` never stops anything. */
export const ROSTER_RULE_SEVERITIES = ["block", "warn", "info"] as const;
export type RosterRuleSeverity = (typeof ROSTER_RULE_SEVERITIES)[number];

/**
 * WHO SAYS SO. Ordered loosely by how hard it is to argue with, and kept separate from
 * `ROSTER_AUTHORITIES` (which is about what one person may let another DO, not about where a rule
 * comes from). `nmc_recommended` and `central_directive` are deliberately distinct from `nmc` and
 * `central_law`: the 74 h/24 h figure is a recommendation, and the 12 h/48 h one is sub judice —
 * both are real, neither is settled, and a screen that renders them identically is lying by layout.
 */
export const ROSTER_RULE_AUTHORITIES = [
  "nmc", "nmc_recommended", "central_law", "central_directive", "court", "accreditation",
  "state", "institution",
] as const;
export type RosterRuleAuthority = (typeof ROSTER_RULE_AUTHORITIES)[number];

export const ROSTER_REQUIREMENT_SCOPES = ["location", "team", "department"] as const;
export type RosterRequirementScope = (typeof ROSTER_REQUIREMENT_SCOPES)[number];

/**
 * A requirement that holds on a weekday need not hold on a Sunday, and a declared holiday runs the
 * Sunday pattern (R7). `any` is the escape for a requirement that never varies — a lone-worker rule
 * does not care what day it is.
 */
export const ROSTER_DAY_CLASSES = ["weekday", "saturday", "sunday", "holiday", "any"] as const;
export type RosterDayClass = (typeof ROSTER_DAY_CLASSES)[number];

/**
 * `fixed` is a count. `per_occupied_bed` is a RATIO — one nurse per `ratio_n` occupied beds — and
 * it is the reason `min_count` alone cannot express a nursing requirement: the number needed on a
 * ward tonight is a function of who is in the beds tonight.
 */
export const ROSTER_REQUIREMENT_BASES = ["fixed", "per_occupied_bed"] as const;
export type RosterRequirementBasis = (typeof ROSTER_REQUIREMENT_BASES)[number];

const ruleAudit = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * HOW MANY OF WHAT, WHERE, ON WHICH KIND OF DAY — and who says so.
 *
 * `scope_id` is deliberately NOT a foreign key: it names a location, a team or a department
 * depending on `scope_type`, and the three live in different tables. The validator resolves it;
 * a bad id produces a finding naming the requirement rather than a constraint violation nobody
 * can read.
 */
export const rosterRequirements = pgTable(
  "roster_requirements",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    positionKey: text("position_key").notNull().references(() => rosterPositions.key),
    /** NULL = the requirement holds across the whole day rather than inside one named shift. */
    shiftDefId: text("shift_def_id").references(() => rosterShiftDefs.id),
    dayClass: text("day_class").notNull().default("any"),
    minCount: integer("min_count").notNull(),
    /** NULL = no ceiling. A ceiling exists for teaching ratios, not for safety. */
    maxCount: integer("max_count"),
    /** NULL = the position alone is enough. Otherwise the holder must also hold this credential. */
    credentialKey: text("credential_key"),
    basis: text("basis").notNull().default("fixed"),
    /** Only for `per_occupied_bed`: one per this many occupied beds. */
    ratioN: integer("ratio_n"),
    authority: text("authority").notNull(),
    citation: text("citation"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    active: boolean("active").notNull().default(true),
    siteId: text("site_id").notNull().default("main"),
    ...ruleAudit,
  },
  (t) => [
    index("roster_requirements_scope_idx").on(t.scopeType, t.scopeId).where(sql`${t.active}`),
    check("roster_requirements_scope_ck", sql`${t.scopeType} in ('location', 'team', 'department')`),
    check("roster_requirements_day_class_ck", sql`${t.dayClass} in ('weekday', 'saturday', 'sunday', 'holiday', 'any')`),
    check("roster_requirements_basis_ck", sql`${t.basis} in ('fixed', 'per_occupied_bed')`),
    check("roster_requirements_authority_ck", sql`${t.authority} in ('nmc', 'nmc_recommended', 'central_law', 'central_directive', 'court', 'accreditation', 'state', 'institution')`),
    check("roster_requirements_min_ck", sql`${t.minCount} >= 0`),
    check("roster_requirements_max_ck", sql`${t.maxCount} is null or ${t.maxCount} >= ${t.minCount}`),
    /** A ratio basis without a divisor is a requirement that cannot be evaluated at all. */
    check("roster_requirements_ratio_ck", sql`(${t.basis} = 'fixed' and ${t.ratioN} is null) or (${t.basis} = 'per_occupied_bed' and ${t.ratioN} > 0)`),
    check("roster_requirements_validity_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/**
 * THE RULE BOOK. Keyed by a stable code because a finding, a refusal and a screen all name the rule
 * by that code; `params` holds the numbers so that changing "one night in three" to "one night in
 * four" is a row edit and not a release.
 */
export const rosterRules = pgTable(
  "roster_rules",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    severity: text("severity").notNull(),
    authority: text("authority").notNull(),
    citation: text("citation"),
    /** Which cadres the rule speaks about. Empty = everybody. */
    appliesTo: text("applies_to").array().notNull().default(sql`'{}'::text[]`),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    ...ruleAudit,
  },
  (t) => [
    check("roster_rules_severity_ck", sql`${t.severity} in ('block', 'warn', 'info')`),
    check("roster_rules_authority_ck", sql`${t.authority} in ('nmc', 'nmc_recommended', 'central_law', 'central_directive', 'court', 'accreditation', 'state', 'institution')`),
  ],
);

/**
 * A DEPARTMENT'S DATED EXCEPTION — the "lean period" of the stress test.
 *
 * Exam month, a ward closed for renovation, four residents at a conference: the rule does not
 * change, its PARAMETERS do, for a named department between two dates, approved once by somebody
 * who answers for it. Kept as rows rather than as an edit to `roster_rules` so that the book still
 * says what the hospital's standing position is, and so that the exception expires by itself.
 */
export const rosterRuleProfiles = pgTable(
  "roster_rule_profiles",
  {
    id: text("id").primaryKey(),
    departmentId: text("department_id").notNull().references(() => orgDepartments.id),
    ruleKey: text("rule_key").notNull().references(() => rosterRules.key),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    reason: text("reason").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    approvedBy: text("approved_by").notNull().references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    siteId: text("site_id").notNull().default("main"),
    ...ruleAudit,
  },
  (t) => [
    index("roster_rule_profiles_dept_idx").on(t.departmentId, t.ruleKey, t.validFrom),
    /** An exception with no end date is a rule change wearing a disguise. */
    check("roster_rule_profiles_validity_ck", sql`${t.validTo} >= ${t.validFrom}`),
  ],
);

/**
 * WHAT THE VALIDATOR SAID, AND WHAT A HUMAN DID ABOUT IT.
 *
 * A finding is not an error log: it is the record that a named person saw "Dr Rao is on her third
 * night in a row" and published anyway, at a stated time, for a stated reason. That record is the
 * entire point of letting a warn be accepted at all — `accepted_by` is the answer to "who decided
 * this was alright", two years later, when somebody asks.
 *
 * `cleared_at` is for a finding the next draft no longer produces: it is closed, not deleted,
 * because the history of what a roster USED to be wrong about is how a department learns.
 */
export const rosterFindings = pgTable(
  "roster_findings",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id").notNull().references(() => rosterPeriods.id),
    /**
     * The slot the finding is about, when it is about one — **deliberately NOT a foreign key.**
     *
     * A draft's slots are mutable: `unassign` deletes them outright, which is the whole point of a
     * draft. An FK here made that impossible the moment a head recorded findings — the delete was
     * refused by the constraint, so reviewing a roster locked the roster against being fixed, which
     * is precisely backwards. Found by the "cleared, not deleted" test.
     *
     * A dangling id is the honest outcome: the finding records what was true when it was evaluated,
     * and the next `recordFindings` clears it, because a key naming a slot that no longer exists is
     * not in the newly computed set. Keeping the id also keeps `findingKey` stable, which is what
     * lets an ACCEPTANCE survive re-evaluation.
     */
    assignmentId: text("assignment_id"),
    /** The person the finding is about, when it is about one. */
    userId: text("user_id").references(() => users.id),
    ruleKey: text("rule_key").notNull(),
    /** Copied from the rule AT EVALUATION, because a rule's severity may change afterwards. */
    severity: text("severity").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    acceptedBy: text("accepted_by").references(() => users.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptReason: text("accept_reason"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    siteId: text("site_id").notNull().default("main"),
    ...ruleAudit,
  },
  (t) => [
    index("roster_findings_period_idx").on(t.periodId).where(sql`${t.clearedAt} is null`),
    index("roster_findings_user_idx").on(t.userId, t.ruleKey),
    check("roster_findings_severity_ck", sql`${t.severity} in ('block', 'warn', 'info')`),
    /**
     * AN ACCEPTANCE IS THREE FACTS OR NONE. A finding accepted by nobody, or at no time, or for no
     * stated reason is not an acceptance — it is a finding somebody cleared without answering for
     * it, and this check is what stops that being representable.
     */
    check("roster_findings_acceptance_ck", sql`(${t.acceptedBy} is null and ${t.acceptedAt} is null and ${t.acceptReason} is null) or (${t.acceptedBy} is not null and ${t.acceptedAt} is not null and ${t.acceptReason} is not null)`),
  ],
);

/**
 * PHASE R (R8) — **SKELETON MODE: THE DAY THE HOSPITAL RUNS ON WHAT IT HAS.**
 *
 * A strike, a bandh, a mass casualty, a night when half the residents have flu. The rota on the
 * wall stops describing the building, and somebody senior has to say so out loud.
 *
 * ═══ A DECLARATION IS FOR ONE DAY AND EXPIRES BY ITSELF (D4) ═══
 *
 * `ist_date` is the whole of it: there is no "until further notice", and no end date somebody has
 * to remember to come back and set. A hospital that is still on skeleton cover tomorrow declares it
 * again tomorrow, by somebody who is awake and answerable for that. **The failure this shape exists
 * to prevent is the one every such flag has**: declared during a crisis at 02:00, never withdrawn,
 * and six months later the escalation ladder is still quietly rooted somewhere nobody intended.
 * Expiring daily makes the cost of forgetting one day instead of forever.
 *
 * ═══ WITHDRAWAL IS A ROW, NOT A DELETE ═══
 *
 * The question afterwards is never "is it on now" — it is *"who said the hospital was on skeleton
 * cover that Tuesday, and when did they say it stopped?"* So a withdrawal stamps the row rather
 * than removing it, and the day's declarations are the checklist somebody walks at handover.
 *
 * ═══ WHAT THIS DOES NOT DO ═══
 *
 * It does not mark anybody absent. Bulk abstention is `staff_absences` with kind `abstaining`,
 * which R4 already built and guards — the mode says the hospital is short, the absences say who is
 * not coming, and conflating them would let one declaration silently mark a department away.
 */
export const ROSTER_MODES = ["skeleton"] as const;
export type RosterMode = (typeof ROSTER_MODES)[number];

export const rosterModeDeclarations = pgTable(
  "roster_mode_declarations",
  {
    id: text("id").primaryKey(),
    /** NULL = the whole hospital. A department may be on skeleton cover while the rest is not. */
    departmentId: text("department_id").references(() => orgDepartments.id),
    mode: text("mode").notNull().default("skeleton"),
    /** The ONE day this declaration speaks about. See the header: there is no open end. */
    istDate: date("ist_date").notNull(),
    reason: text("reason").notNull(),
    declaredBy: text("declared_by").notNull().references(() => users.id),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnBy: text("withdrawn_by").references(() => users.id),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawReason: text("withdraw_reason"),
    siteId: text("site_id").notNull().default("main"),
    ...ruleAudit,
  },
  (t) => [
    index("roster_mode_declarations_day_idx").on(t.istDate, t.departmentId)
      .where(sql`${t.withdrawnAt} is null`),
    check("roster_mode_declarations_mode_ck", sql`${t.mode} in ('skeleton')`),
    /** A withdrawal is two facts or none — as an acceptance is three. */
    check(
      "roster_mode_declarations_withdrawal_ck",
      sql`(${t.withdrawnAt} is null and ${t.withdrawnBy} is null)
          or (${t.withdrawnAt} is not null and ${t.withdrawnBy} is not null)`,
    ),
  ],
);
