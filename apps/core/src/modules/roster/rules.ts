import { and, eq, gte, lte } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";
import { rosterRuleProfiles, rosterRules } from "../../kernel/db/schema/roster";
import type {
  RosterCadre, RosterRuleAuthority, RosterRuleSeverity,
} from "../../kernel/db/schema/roster";
import type { SeedCount } from "./masters";

/**
 * PHASE R (R8) — **THE RULE BOOK, AS ROWS.**
 *
 * ═══ WHY EVERY NUMBER IN HERE IS A PARAMETER AND NOT A LITERAL ═══
 *
 * "One night in three" is not a constant of nature. It is a figure that moves when the NMC revises
 * a regulation, when a court rules, and — for a named department between two dates — when a HOD
 * gets an exception approved for an exam month. A rule whose numbers live in `params` can absorb
 * all three without a developer; a rule with `if (nights > 3)` in it needs a release for each.
 *
 * ═══ SEVERITY IS A CLAIM ABOUT WHAT THE HOSPITAL CAN DO, NOT ABOUT HOW BAD IT IS ═══
 *
 * **The severities here are not mine to choose freely — two are rulings already on the register,**
 * and an earlier draft of this file got both wrong by reasoning from first principles instead of
 * reading them:
 *
 *   - **R-067** — *"staffing ratios are roster gates, a violating roster does not publish, a breach
 *     never blocks an admission."* So `requirement_shortfall` BLOCKS. Stress test S3 records that
 *     this ruling had "no row to be violated"; `roster_requirements` is that row.
 *   - **doc 10 §3.9** — post-night rest ≥ 12 h is a **hard block with an evented HOD override**.
 *     So `rest_after_duty` BLOCKS.
 *
 * The objection that talked me out of this the first time — *a short-staffed department could then
 * never publish a roster at all* — is answered by the override rather than by softening the rule.
 * `acceptFinding` lets a named human take responsibility, with a reason kept forever and an event
 * emitted. That IS the "HOD override evented" the ruling asks for, and it is a better record than a
 * warning nobody had to sign for.
 *
 * Two more block because publishing the roster is itself the harm:
 *
 *   - **`slot_over_24h`** — a single planned duty, present on site, longer than a day.
 *   - **`credential_expired`** — on duty in a post whose requirement names a credential the holder
 *     no longer has. Not short staffing: unlawful, with the hospital's signature on the rota.
 *
 * The rest warn, and a named human may accept any of them with a reason that is kept.
 *
 * ═══ THE TWO RULINGS ALREADY INSIDE THIS BOOK (plan §0, owner) ═══
 *
 * **74 h / 24 h is `nmc_recommended`** — a recommendation, and rendered as one.
 * **12 h / 48 h is `central_directive` and WARNS**, because it is sub judice: the Supreme Court
 * hears *United Doctors Front* on 27.10.2026. A hospital that blocked on it today would be
 * enforcing a rule that may not survive the year; one that omitted it would be ignoring a live
 * directive. A warn carrying its citation is the only honest rendering of "this is real and it is
 * not settled".
 *
 * **And no rule here carries `authority: 'state'`** — see the schema header. Bihar's own mandates
 * are not in this book because nobody has read them yet.
 */

export type RosterRuleSeed = {
  readonly key: string;
  readonly label: string;
  readonly severity: RosterRuleSeverity;
  readonly authority: RosterRuleAuthority;
  readonly citation: string | null;
  /** Empty = the rule speaks about everybody. */
  readonly appliesTo: readonly RosterCadre[];
  readonly params: Readonly<Record<string, number | string | boolean>>;
};

export const ROSTER_RULES: readonly RosterRuleSeed[] = [
  /* ── the two that stop a publish ── */
  {
    /**
     * PRESENCE only — see `slotOver24h` in `validator.ts`. On-call is exempt by design, because a
     * 24-hour consultant call is the normal shape of cover here and R2's own refusal already says
     * "on-call may be longer".
     */
    key: "slot_over_24h",
    label: "a single planned duty, present on site, longer than 24 hours",
    severity: "block",
    authority: "institution",
    citation: null,
    appliesTo: [],
    params: { maxHours: 24 },
  },
  {
    key: "credential_expired",
    label: "on duty in a post that needs a credential the holder no longer holds",
    severity: "block",
    authority: "central_law",
    citation: "Indian Medical Council Act 1956 / NMC Act 2019 — registration must be current",
    appliesTo: [],
    params: {},
  },

  /* ── hours and rest ── */
  {
    /**
     * A HARD BLOCK, and not my judgement: **doc 10 §3.9 rules post-night rest ≥ 12 h a hard block
     * with an evented HOD override.** The override is `acceptFinding`, which records who allowed it
     * and why and emits `roster.finding_accepted` — which is what "evented" asks for.
     */
    key: "rest_after_duty",
    label: "at least 12 hours off after a duty period",
    severity: "block",
    authority: "nmc_recommended",
    citation: "NMC PGMER 2023 — rest after duty; doc 10 §3.9 (hard block, HOD override evented)",
    appliesTo: ["junior_resident", "senior_resident", "intern"],
    params: { minHours: 12 },
  },
  {
    key: "weekly_hours_74",
    label: "not more than 74 hours in a week, nor 24 at a stretch",
    severity: "warn",
    authority: "nmc_recommended",
    citation: "NMC PGMER 2023 Sch. — 74 hours per week, 24-hour maximum continuous duty",
    appliesTo: ["junior_resident", "senior_resident", "intern"],
    params: { maxWeekHours: 74, maxStretchHours: 24 },
  },
  {
    /**
     * SUB JUDICE, AND THE CITATION SAYS SO. Kept in the book, kept at `warn`, and kept distinct
     * from the 74 h rule above so a screen can show both figures with their different weights
     * rather than averaging them into one number nobody can source.
     */
    key: "shift_12h_week_48h",
    label: "12-hour shifts and a 48-hour week",
    severity: "warn",
    authority: "central_directive",
    citation: "MoHFW directive; sub judice — United Doctors Front, Supreme Court, listed 27.10.2026",
    appliesTo: ["junior_resident", "senior_resident", "intern"],
    params: { maxShiftHours: 12, maxWeekHours: 48 },
  },
  {
    key: "night_one_in_three",
    label: "not more than one night in three",
    severity: "warn",
    authority: "nmc",
    citation: "NMC PGMER 2023 — night duty frequency",
    appliesTo: ["junior_resident", "senior_resident", "intern"],
    params: { oneInN: 3 },
  },
  {
    /**
     * A WARN WITH A REASON, NEVER A BLOCK — and the citation is why. PGMER grants the weekly off
     * "subject to exigencies of work", which is the regulation itself saying a hospital may
     * sometimes not manage it. A block here would refuse to publish the very rota that the
     * exigency produced.
     */
    key: "weekly_off",
    label: "one day off in seven",
    severity: "warn",
    authority: "nmc_recommended",
    citation: "NMC PGMER 2023 — one weekly off, subject to exigencies of work",
    appliesTo: ["junior_resident", "senior_resident", "intern"],
    params: { perDays: 7, minOff: 1 },
  },

  /* ── who a unit needs on it ── */
  {
    key: "unit_min_jr",
    label: "at least two junior residents on a unit",
    severity: "warn",
    authority: "nmc",
    citation: "NMC UG-MSR 2023 / PGMER — unit staffing",
    appliesTo: ["junior_resident"],
    params: { minCount: 2 },
  },
  {
    key: "unit_min_sr",
    label: "at least one senior resident on a unit",
    severity: "warn",
    authority: "nmc",
    citation: "NMC UG-MSR 2023 / PGMER — unit staffing",
    appliesTo: ["senior_resident"],
    params: { minCount: 1 },
  },
  {
    key: "pg_theatre_days",
    label: "a surgical postgraduate gets two theatre days a week",
    severity: "warn",
    authority: "nmc_recommended",
    citation: "NMC PGMER 2023 — training exposure",
    appliesTo: ["junior_resident"],
    params: { minDaysPerWeek: 2 },
  },

  /* ── the roster against the hospital's own requirement rows ── */
  {
    /**
     * **R-067, AND IT IS A GATE.** The ruling on the register reads *"staffing ratios are roster
     * gates, a violating roster does not publish, a breach never blocks an admission"*, and stress
     * test S3 records that it had *"no row to be violated"* — which is exactly what
     * `roster_requirements` now supplies. So a shortfall against a requirement the hospital has
     * declared BLOCKS, and the HOD's override is `acceptFinding`, recorded and evented.
     *
     * Note what is NOT gated: a breach never blocks an admission. This refuses a ROSTER, never a
     * patient, and nothing in this module is on the admission path.
     *
     * The finding copies the requirement's own authority and citation into `params`, so a shortfall
     * against an NMC requirement and one against a house rule read differently to the person
     * signing for it.
     */
    key: "requirement_shortfall",
    label: "fewer on duty than a requirement the hospital has declared",
    severity: "block",
    authority: "institution",
    citation: "R-067 — staffing ratios are roster gates",
    appliesTo: [],
    params: {},
  },
  {
    key: "credential_expiring",
    label: "a credential expires during this roster",
    severity: "warn",
    authority: "institution",
    citation: null,
    appliesTo: [],
    params: { withinDays: 30 },
  },
  {
    /**
     * NAMED BY `periods.ts`'S OWN HEADER as one of the things the validator owns — "rest after a
     * night, one night in three, weekly off, staffing ratios, **leave clashes**". A warn rather
     * than a block because the clash has two honest resolutions and the roster cannot tell which
     * the department wants: the leave is withdrawn, or the duty is given to somebody else.
     */
    key: "rostered_while_absent",
    label: "rostered for duty during approved leave",
    severity: "warn",
    authority: "institution",
    citation: null,
    appliesTo: [],
    params: {},
  },
  {
    key: "lone_worker",
    label: "a location left to one person alone",
    severity: "warn",
    authority: "institution",
    citation: null,
    appliesTo: [],
    params: { minPresent: 2 },
  },
  {
    /**
     * FEASIBILITY IS A PROPERTY OF THE ESTABLISHMENT, NOT OF THE MONTH. It answers the question a
     * HOD actually asks — *"can this unit cover nights at all with the residents I have?"* — in
     * hours per week and residents per unit, before anybody drafts anything. Stress test S4 is the
     * case it exists for: three JRs covering their own unit's nights is arithmetically red; the
     * same three in a pooled night rota is green, and the difference is the whole argument for
     * pooling.
     */
    key: "template_infeasible",
    label: "this pattern cannot be staffed at this strength without breaking the hours rules",
    severity: "warn",
    authority: "institution",
    citation: null,
    appliesTo: [],
    params: {},
  },
] as const;

export const ROSTER_RULE_COUNT = ROSTER_RULES.length;

/** The rule keys that stop a publish when a finding of theirs is not accepted. */
export const BLOCKING_RULE_KEYS: readonly string[] =
  ROSTER_RULES.filter((r) => r.severity === "block").map((r) => r.key);

export async function seedRosterRules(exec: Db | Tx, by = "seed"): Promise<SeedCount> {
  let added = 0;
  for (const r of ROSTER_RULES) {
    const inserted = await (exec as Db)
      .insert(rosterRules)
      .values({
        key: r.key,
        label: r.label,
        severity: r.severity,
        authority: r.authority,
        citation: r.citation,
        appliesTo: [...r.appliesTo],
        params: r.params as Record<string, unknown>,
        createdBy: by,
        updatedBy: by,
      })
      .onConflictDoNothing()
      .returning({ key: rosterRules.key });
    added += inserted.length;
  }
  return { added, present: ROSTER_RULES.length - added };
}

export type EffectiveRule = {
  readonly key: string;
  readonly label: string;
  readonly severity: RosterRuleSeverity;
  readonly authority: RosterRuleAuthority;
  readonly citation: string | null;
  readonly appliesTo: readonly string[];
  readonly params: Record<string, unknown>;
  /** The profile that moved the parameters, when one did. Null when the book's own numbers stand. */
  readonly profileId: string | null;
};

/**
 * THE BOOK AS IT APPLIES TO ONE DEPARTMENT ON ONE DAY.
 *
 * A profile does not replace a rule, it moves its numbers: the merge is per key, so a lean-period
 * profile that raises `oneInN` from 3 to 4 leaves the rule's label, severity, authority and
 * citation exactly as the book has them. A department reading its own roster still sees *who says
 * so*, and sees that the number in force is not the standing one.
 */
export async function rulesInForce(
  exec: Db | Tx, departmentId: string | null, onIstDate: string,
): Promise<EffectiveRule[]> {
  const book = await (exec as Db).select().from(rosterRules).where(eq(rosterRules.active, true));

  const profiles = departmentId === null ? [] : await (exec as Db)
    .select().from(rosterRuleProfiles)
    .where(and(
      eq(rosterRuleProfiles.departmentId, departmentId),
      lte(rosterRuleProfiles.validFrom, onIstDate),
      gte(rosterRuleProfiles.validTo, onIstDate),
    ));

  return book.map((r) => {
    const p = profiles.find((x) => x.ruleKey === r.key);
    return {
      key: r.key,
      label: r.label,
      severity: r.severity as RosterRuleSeverity,
      authority: r.authority as RosterRuleAuthority,
      citation: r.citation,
      appliesTo: r.appliesTo,
      params: p === undefined ? r.params : { ...r.params, ...p.params },
      profileId: p?.id ?? null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}
