import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { roles } from "./auth";

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
