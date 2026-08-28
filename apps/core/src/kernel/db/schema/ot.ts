import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  bigint, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { patients } from "./patients";
import { resources } from "./resources";

/**
 * PLAN 15 T1 — THE MINI-OT: the first tables in this system that know an OPERATION happened.
 *
 * ═══ WHAT WAS TRUE BEFORE THIS FILE ═══
 *
 * The hospital could register a patient, consult, prescribe, bill, and — since Plan 14 — hold a
 * consignment implant in a store. It could not operate on anyone. `grep -rli "daycare\|ot_cases"`
 * over `apps/core/src` returned nothing but a comment. This file is spec §11.16-A's day-care spine:
 * a booking that cannot skip its gates, a theatre that cannot be double-entered, counts that cannot
 * be typed as "correct", an implant scan that is a ledger fact, a bay that cannot be
 * double-assigned, and a bill composed from the ledger under a regulated clamp.
 *
 * ═══ TWELVE TABLES, NOT TEN (finding, T1) ═══
 *
 * The plan's T1 heading says "Ten tables" and its own Produces list names TWELVE. Twelve is what
 * ships and twelve is what `ot.test.ts` counts. The heading was the stale number.
 *
 * ═══ THE STATE OF A CASE AND OF A GATE IS THE WORKFLOW ENGINE'S, AND IS NOT MIRRORED HERE (DD4) ═══
 *
 * `ot_cases` and `ot_case_gates` each carry `workflow_instance_id` and NO status column. The plan's
 * T1 Produces list named a `state` column on `ot_case_gates` (and, consistently, none on
 * `ot_cases`); **the column is not built, and that is a disclosed correction rather than an
 * omission.** DD4 rules that a gate is a child workflow instance "so its history is the engine's,
 * not ours", and `transition()` (kernel/workflow/instances.ts:104) already performs the state move
 * as a single-winner conditional UPDATE on `workflow_instances.current_state` — which is what makes
 * two concurrent transitions impossible WITHOUT an optimistic-locking column. A mirrored copy here
 * would be a second answer to "is this gate satisfied" that no transaction updates atomically with
 * the first, on the one question this whole phase exists to make unskippable. Readers join
 * `workflow_instances` on the pinned id; there is exactly one truth.
 *
 * `daycare_encounters.status` IS a real column, and that is not the same trade: an ENCOUNTER has no
 * workflow instance in this phase (DD4's subjects are `ot_case` and `ot_gate`), so nothing else
 * holds that state.
 *
 * ═══ CROSS-MODULE REFERENCES ARE PLAIN TEXT; PATIENTS AND RESOURCES ARE REAL FKs ═══
 *
 * `item_id`, `batch_id`, `lot_id`, `service_code`, `receipt_id`, `opd_encounter_id`, `approval_id`
 * and `workflow_instance_id` are plain text with no FK — the house precedent stated in
 * `schema/billing.ts` for exactly this ("`encounter_id`, approval ids and service ids stay plain
 * text with no FK — the house precedent for cross-module references, §4 module isolation").
 *
 * `patient_id` and every `*_resource_id` DO carry a real FK, for billing's owner ruling R5 reason:
 * a clinical document must never be able to name a patient id that never existed or was merged
 * away, and a case must never name a theatre the registry does not have. Those two FKs are what put
 * this whole family into the big `patients`/`resources` statement in `test/helpers/db.ts` — §3.35's
 * rule is constraint EXISTENCE, never row counts.
 *
 * ═══ MONEY IS INTEGER PAISE; QUANTITIES ARE INTEGERS IN THE ITEM'S BASE UNIT ═══
 *
 * Plan 14 DD7, unchanged. `quote_paise` and `amount_paise` are `bigint` mode number; `qty_base` is
 * `integer` and is always in the item's OWN base unit, never "whatever unit the nurse had".
 *
 * ═══ THE FIVE TIMESTAMPS ARE WRITE-ONCE, AND THE MECHANISM IS A TRIGGER (DD8) ═══
 *
 * `wheel_in`, `induction`, `incision`, `closure`, `wheel_out` are set BY the transition that reaches
 * the state, never typed. `0035` carries a `BEFORE UPDATE` trigger — `ot_forbid_timestamp_rewrite`,
 * billing's `0012` precedent — that raises `ot_timestamp_immutable` when an UPDATE changes any of
 * the five from a non-null value. So DD8's assertion (A15/I4) is a DATABASE property provable by
 * running an UPDATE, not a grep over the controller DTOs.
 *
 * ═══ NO `active` BOOLEAN ANYWHERE (Plan 13 DD2) ═══
 *
 * The registry's status IS the state of a theatre or a bay; a definition's `status` is
 * draft/active/superseded; nothing in this module carries an `active` toggle to disagree with them.
 */

/** DD2 §3A — the eight payer classes the deposit policy is keyed by. */
export const PAYER_CLASS_VALUES = [
  "self_pay", "insured_tpa", "govt_scheme", "fp_scheme",
  "corporate_credit", "membership_prepaid", "staff_dependant", "charity",
] as const;

/** DD2 — the day-care encounter's own lifecycle. `converted` and `absconded` are terminal outcomes. */
export const DAYCARE_STATUS_VALUES = [
  "booked", "checked_in", "in_theatre", "in_recovery",
  "discharged", "converted", "absconded", "cancelled", "deceased",
] as const;

/** DD5 — the nine gate kinds THIS PHASE ships. `mtp`, `form_f`, `sterile_set`, `implant_availability`,
 *  `blood` and `theatre_fit` are deliberately absent: 15b/15c/15d own them, and a gate kind that does
 *  not exist cannot be "pending" (DD18). */
export const OT_GATE_KIND_VALUES = [
  "anaesthesia_review", "consent_procedure", "consent_anaesthesia", "site_marking",
  "npo", "deposit", "escort", "privilege", "mlc",
] as const;

/** DD6 — the four kinds of governed definition data this phase publishes. */
export const OT_DEFINITION_KIND_VALUES = ["criteria", "privileges", "deposit_policy", "pacu_thresholds"] as const;

/** DD7 — the three WHO checklist phases, in order. */
export const OT_CHECKLIST_PHASE_VALUES = ["signin", "timeout", "signout"] as const;

/** DD7 — count rounds. `final` is the round `signed_out` is gated on. */
export const OT_COUNT_ROUND_VALUES = ["initial", "closing", "final"] as const;

/** DD9 / F24c — a plate bought outside on prescription is common and bills zero. */
export const IMPLANT_SOURCE_VALUES = ["consignment", "patient_supplied"] as const;

/**
 * DD9 — the implant row's own confirmation state, which is NOT a workflow instance and is not a
 * mirror of one. The materials consumer is ASYNCHRONOUS (Plan 14 T7): `deployImplant` appends
 * `consignment.deployed` in its own transaction and the ledger row arrives later, so the cockpit
 * must be able to show "scanned, not yet a ledger fact". `signOut` is refused while any row is
 * `deploying` (A18) — that refusal is the whole reason this column exists.
 */
export const IMPLANT_STATE_VALUES = ["deploying", "confirmed", "explanted"] as const;

/** R-3.12 — who the cancellation is attributable to; the matrix that charges for it is 15d's. */
export const CANCELLATION_ATTRIBUTION_VALUES = ["patient", "hospital", "surgeon", "payer", "clinical"] as const;

/** DD13 / R-3.22 — the OT-local incident family, until the quality module (28a). */
/**
 * ═══ CLOSE REVIEW (MINOR 14) — TWO DIFFERENT FACTS WERE FILED UNDER ONE KIND ═══
 *
 * The radiation dose log (`cockpit.ts`) and an absconded patient (`recovery.ts`) were both written
 * as `wrong_bay_score`, because the CHECK admitted only five kinds and neither of them was one. The
 * real kind survived inside `detail.kind` — so the incident register was readable only by opening
 * every row's jsonb, and any query grouped by `kind` reported a nonsense number. An incident
 * register nobody can read by kind is not a register.
 *
 * `0036` widens the constraint. The two are genuinely different: a dose log is a ROUTINE record
 * (resolved at insert, kept for the radiation-safety file) and an absconding is an open incident.
 */
export const OT_INCIDENT_KIND_VALUES = [
  "identity_mismatch", "timeout_halted", "count_mismatch", "death_on_table", "wrong_bay_score",
  "dose_log", "absconded",
] as const;

/** F24b — PACU thresholds are keyed by ANAESTHESIA TECHNIQUE, not one PADSS for everybody. */
export const ANAESTHESIA_TYPE_VALUES = ["general", "spinal", "regional", "local_sedation"] as const;

/**
 * One CHECK-constraint shape, one owner: `col in ('a', 'b', …)` built from the exported array above
 * it, so a value list and its constraint cannot drift (§2.54 applied before the drift, not after).
 *
 * **`sql.raw`, and it is not an optimisation.** `sql\`${v}\`` makes v a BOUND PARAMETER, and
 * drizzle-kit renders a bound parameter into DDL as `$1` — the first `pnpm db:generate` of this file
 * emitted `CHECK (... in ($1, $2, $3, …))`, a constraint that constrains nothing and would have
 * shipped a `payer_class` column with no enforcement at all. Caught by READING the generated SQL
 * before applying it, which is the only reason DD17 says the generated file is read and quoted.
 *
 * The literals are this file's own compile-time constants, never caller input; the guard below is
 * belt for the day somebody passes something else.
 */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. The encounter — DD2. `D2608280001`, and the id every downstream fact carries.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ═══ CLOSE REVIEW (MINOR 17) — DD2 SAYS "THE `encounterId` EVERY DOWNSTREAM FACT CARRIES", AND THE
 * TWO DOWNSTREAM TABLES CARRY DIFFERENT KEYS FOR IT ═══
 *
 * Both are the same day-care encounter and each side is self-consistent with its own module's
 * convention, but they cannot be joined to each other:
 *
 *   · `invoices.encounter_id`     ← `encounter_no`  (`D2609020001`) — billing's convention; OPD
 *                                   passes its `V` number the same way.
 *   · `stock_ledger.encounter_id` ← `id`            (the ULID)      — materials' convention, which
 *                                   Plan 14 froze before this module existed.
 *
 * `composeDischargeBill` is correct because it reads each side with the key that side uses. The
 * cost is a trap for the NEXT reader: a report joining an invoice to the stock it consumed by
 * `encounter_id` will return nothing and look like a data problem. Recorded here rather than
 * "fixed" at close — changing either side is a data migration across two modules' frozen
 * interfaces, and neither convention is wrong on its own. **Carried to 15b.**
 */
export const daycareEncounters = pgTable(
  "daycare_encounters",
  {
    id: text("id").primaryKey(),
    encounterNo: text("encounter_no").notNull(), // EPISODE_SERIES.daycare = "D"
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** The advising consult. Plain text, no FK: `opd_encounters` is another module's table (§4). */
    opdEncounterId: text("opd_encounter_id"),
    payerClass: text("payer_class").notNull(),
    /** Pre-auth id, TMS id, or FP claim id. Nullable — `self_pay` has none. */
    schemeRef: text("scheme_ref"),
    status: text("status").notNull().default("booked"),
    bayResourceId: text("bay_resource_id").references(() => resources.id),
    /**
     * DD2 — `{name, relation, phone, idType, idLast4, notifyOk, verifiedAt, verifiedBy}`, written
     * twice (check-in and discharge, DD10). `notifyOk` is captured even though DD20's ping is not
     * built (Spike Q7): the consent exists the day the channel does.
     */
    escort: jsonb("escort"),
    /**
     * N14 — "two Sunita Devis, one is the other's escort". When the escort HAS a UHID it is named
     * here and the CHECK below makes A7 a database property rather than only a service rule.
     */
    escortPatientId: text("escort_patient_id").references(() => patients.id),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    dischargedAt: timestamp("discharged_at", { withTimezone: true }),
    /** R-3.6 / F9 — THE BILLING BOUNDARY. The composer bills nothing after this instant. */
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    outcome: text("outcome"), // 'discharged' | 'converted' | 'absconded' | 'deceased' | 'cancelled'
    handoffDocumentId: text("handoff_document_id"),
    /** R-3.22 — death on table puts a legal hold on the record; nothing in this phase clears it. */
    legalHold: boolean("legal_hold").notNull().default(false),
    /** A5 — set by the `patient.merged` consumer; the cockpit makes the nurse re-verify identity. */
    reVerifyIdentity: boolean("re_verify_identity").notNull().default(false),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("daycare_encounters_no_ux").on(t.encounterNo),
    index("daycare_encounters_patient_idx").on(t.patientId),
    index("daycare_encounters_status_idx").on(t.status),
    check("daycare_encounters_payer_class_ck", inList(t.payerClass, PAYER_CLASS_VALUES)),
    check("daycare_encounters_status_ck", inList(t.status, DAYCARE_STATUS_VALUES)),
    /**
     * A7 / R-3.24 — a patient cannot escort themselves. `IS DISTINCT FROM` rather than `<>` so a
     * NULL escort patient (the ordinary case: the escort has no UHID) passes.
     */
    check("daycare_encounters_escort_not_self_ck", sql`${t.escortPatientId} is distinct from ${t.patientId}`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. The case, and 3. the list — one encounter may own SEVERAL cases (N8 bilateral, N13 return).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otCases = pgTable(
  "ot_cases",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    theatreResourceId: text("theatre_resource_id").notNull().references(() => resources.id),
    listDate: date("list_date", { mode: "string" }).notNull(), // IST calendar date, never an instant
    /**
     * Position on the day's list. NO unique index, deliberately: `resequence` rewrites every case
     * on a list in one transaction and a non-deferrable unique would refuse the intermediate state
     * of any swap. Uniqueness is `lists.ts`'s post-condition and its test's assertion.
     */
    seq: integer("seq").notNull(),
    procedureCode: text("procedure_code").notNull(),
    procedureClass: text("procedure_class").notNull(), // whitelisted by the ACTIVE `criteria` definition
    laterality: text("laterality"), // null for a non-lateral class; A3's triple-equality operand
    surgeonId: text("surgeon_id").notNull(),
    /** F18/F24g — `publishList` refuses a case without one, and `signIn`'s actor must be this user. */
    anaesthetistId: text("anaesthetist_id"),
    anaesthesiaType: text("anaesthesia_type"), // F24b — keys the PACU threshold set
    asaGrade: integer("asa_grade"),
    /** DD6/F8 — the `daycare_package` tariff service for this procedure class. */
    packageServiceCode: text("package_service_code").notNull(),
    /** B10 — pinned at BOOKING with the tariff version that produced it; never re-priced at read. */
    quotePaise: bigint("quote_paise", { mode: "number" }).notNull(),
    tariffVersionId: text("tariff_version_id").notNull(),
    payerClass: text("payer_class").notNull(), // snapshot at booking; the encounter's may change
    workflowInstanceId: text("workflow_instance_id").notNull(), // THE state (see the file header)
    // ── DD8: the five, write-once, set by their transitions, protected by 0035's trigger ─────────
    wheelIn: timestamp("wheel_in", { withTimezone: true }),
    induction: timestamp("induction", { withTimezone: true }),
    incision: timestamp("incision", { withTimezone: true }),
    closure: timestamp("closure", { withTimezone: true }),
    wheelOut: timestamp("wheel_out", { withTimezone: true }),
    woundClass: text("wound_class"),
    cancellationReason: text("cancellation_reason"),
    cancellationAttribution: text("cancellation_attribution"), // R-3.12
    /** N13 — a same-day return to theatre is a NEW case linked to the original, no second deposit. */
    returnOfCaseId: text("return_of_case_id"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ot_cases_encounter_idx").on(t.encounterId),
    index("ot_cases_list_idx").on(t.listDate, t.theatreResourceId, t.seq),
    index("ot_cases_instance_idx").on(t.workflowInstanceId),
    check("ot_cases_payer_class_ck", inList(t.payerClass, PAYER_CLASS_VALUES)),
    check("ot_cases_laterality_ck", sql`${t.laterality} is null or ${t.laterality} in ('left', 'right', 'bilateral')`),
    check("ot_cases_anaesthesia_type_ck", sql`${t.anaesthesiaType} is null or ${inList(t.anaesthesiaType, ANAESTHESIA_TYPE_VALUES)}`),
    check("ot_cases_cancellation_attribution_ck", sql`${t.cancellationAttribution} is null or ${inList(t.cancellationAttribution, CANCELLATION_ATTRIBUTION_VALUES)}`),
    check("ot_cases_quote_ck", sql`${t.quotePaise} >= 0`),
    check("ot_cases_seq_ck", sql`${t.seq} > 0`),
  ],
);

export const otLists = pgTable(
  "ot_lists",
  {
    id: text("id").primaryKey(),
    listDate: date("list_date", { mode: "string" }).notNull(),
    theatreResourceId: text("theatre_resource_id").notNull().references(() => resources.id),
    /** Monotonic per (date, theatre) — a re-publish is a NEW version, never an edit (C2). */
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"), // 'draft' | 'published' | 'superseded'
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ot_lists_date_theatre_version_ux").on(t.listDate, t.theatreResourceId, t.version),
    check("ot_lists_status_ck", sql`${t.status} in ('draft', 'published', 'superseded')`),
    check("ot_lists_version_ck", sql`${t.version} > 0`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. The gates — DD5. One row per required kind per case; the STATE is the child instance's.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otCaseGates = pgTable(
  "ot_case_gates",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => otCases.id),
    kind: text("kind").notNull(),
    workflowInstanceId: text("workflow_instance_id").notNull(), // THE state (see the file header)
    /** Whether this kind may be WAIVED at all, snapshotted from the criteria definition at booking. */
    waivable: boolean("waivable").notNull().default(false),
    /** Per-kind evidence: the NPO pair, the consent shape, the marking's laterality, the ASA grade. */
    evidence: jsonb("evidence"),
    satisfiedBy: text("satisfied_by"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    /** DD5 — `{surgeonId, anaesthetistId, reason}`; two DISTINCT actor ids, both role-checked. */
    override: jsonb("override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ot_case_gates_case_kind_ux").on(t.caseId, t.kind),
    index("ot_case_gates_instance_idx").on(t.workflowInstanceId),
    check("ot_case_gates_kind_ck", inList(t.kind, OT_GATE_KIND_VALUES)),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. WHO checklist runs and 6. counts — DD7. "Correct" is DERIVED from rows, never typed (H8).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otChecklistRuns = pgTable(
  "ot_checklist_runs",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => otCases.id),
    phase: text("phase").notNull(),
    items: jsonb("items").notNull(), // [{key, answer, note?}] — the printed sheet's own rows
    /** A8 — `timeOut` needs >= 2 DISTINCT ids here. One id listed twice is one person. */
    participants: jsonb("participants").notNull(),
    halted: boolean("halted").notNull().default(false),
    haltReason: text("halt_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ot_checklist_runs_case_idx").on(t.caseId, t.phase),
    check("ot_checklist_runs_phase_ck", inList(t.phase, OT_CHECKLIST_PHASE_VALUES)),
    /** A halted run has a reason and no completion; a completed run has neither halt nor reason. */
    check("ot_checklist_runs_halt_ck", sql`(${t.halted} = false and ${t.haltReason} is null) or (${t.halted} = true and ${t.haltReason} is not null and ${t.completedAt} is null)`),
  ],
);

export const otCounts = pgTable(
  "ot_counts",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => otCases.id),
    round: text("round").notNull(),
    itemType: text("item_type").notNull(), // 'swab' | 'instrument' | 'sharp' | 'needle' | …
    expected: integer("expected").notNull(),
    counted: integer("counted").notNull(),
    scrubBy: text("scrub_by").notNull(),
    circulatingBy: text("circulating_by").notNull(),
    /** B4 — optimistic; a stale write is a 409, never a merge. */
    version: integer("version").notNull().default(1),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ot_counts_case_round_item_ux").on(t.caseId, t.round, t.itemType),
    /**
     * DD7 / F4 — THE TWO-PERSON RULE AT THE DATABASE. The kernel's SoD engine compares two ACTORS
     * at a call site; this CHECK is the half that survives raw SQL and a future migration. The
     * matching `scrub_circulating` pair is seeded into `SOD_PAIR_SEED` in the same commit.
     */
    check("ot_counts_two_person_ck", sql`${t.scrubBy} <> ${t.circulatingBy}`),
    check("ot_counts_round_ck", inList(t.round, OT_COUNT_ROUND_VALUES)),
    check("ot_counts_nonneg_ck", sql`${t.expected} >= 0 and ${t.counted} >= 0`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. Implants — DD9. The scan is ONE transaction; the ledger half is asynchronous.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otCaseImplants = pgTable(
  "ot_case_implants",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => otCases.id),
    /** Denormalised from the case so the composer's `consumptionsFor(encounterId)` join is one hop. */
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    itemId: text("item_id"), // plain text — materials' grain (see the file header)
    batchId: text("batch_id"),
    lotId: text("lot_id"),
    serial: text("serial"),
    stickerRef: text("sticker_ref"),
    /** § 4A-2 — the item is the LEDGER's grain, the service is the BILL's. Chosen at scan. */
    serviceCode: text("service_code").notNull(),
    qtyBase: integer("qty_base").notNull(),
    source: text("source").notNull().default("consignment"),
    state: text("state").notNull().default("deploying"),
    /** Stamped by `implantConfirmedConsumer` when `material.consumed` arrives (DD9). */
    ledgerEntryId: text("ledger_entry_id"),
    eventId: text("event_id"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
    deployedBy: text("deployed_by").notNull(),
    /** H3 — a MANUALLY typed UDI needs a second actor. Null when the barcode was scanned. */
    verifiedBy: text("verified_by"),
    explantedAt: timestamp("explanted_at", { withTimezone: true }),
    explantReason: text("explant_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ot_case_implants_case_idx").on(t.caseId),
    index("ot_case_implants_encounter_idx").on(t.encounterId),
    /**
     * H10 / A17 — THE DUPLICATE-SCAN GUARD, and it is an INDEX rather than a service check on
     * purpose: the consumer's idempotency is by EVENT ID (`consumption.ts`), so a second event for
     * the same serial would decrement the lot twice and the consumer could not tell. The insert
     * happens BEFORE the event is appended, in one transaction, so this index refuses the second
     * scan before any event exists.
     */
    uniqueIndex("ot_case_implants_case_serial_ux").on(t.caseId, t.serial).where(sql`${t.serial} is not null`),
    uniqueIndex("ot_case_implants_case_lot_sticker_ux").on(t.caseId, t.lotId, t.stickerRef).where(sql`${t.stickerRef} is not null`),
    check("ot_case_implants_source_ck", inList(t.source, IMPLANT_SOURCE_VALUES)),
    check("ot_case_implants_state_ck", inList(t.state, IMPLANT_STATE_VALUES)),
    check("ot_case_implants_qty_ck", sql`${t.qtyBase} > 0`),
    /**
     * F24c — a consignment deployment has a lot to deploy FROM; a patient-supplied plate has none
     * and emits no `consignment.deployed`. Both directions, because a consignment row without a lot
     * is a ledger fact with nothing behind it and a patient-supplied row WITH one is a lot being
     * decremented for stock the hospital never owned.
     */
    check("ot_case_implants_source_lot_ck", sql`(${t.source} = 'consignment') = (${t.lotId} is not null)`),
    /** An explanted row has its reason and its instant together, or has neither (D8's bill filter). */
    check("ot_case_implants_explant_ck", sql`(${t.explantedAt} is null) = (${t.explantReason} is null)`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. Specimens — R-3.21. The manual chain until Plan 17. The LABEL NUMBER is the `S` series (F17).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otSpecimens = pgTable(
  "ot_specimens",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => otCases.id),
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** F17 — `EPISODE_SERIES.lab_specimen` = "S". One specimen, one number, when Plan 17 lands. */
    specimenNo: text("specimen_no").notNull(),
    site: text("site").notNull(),
    container: text("container").notNull(),
    dispatchDestination: text("dispatch_destination"), // in-house lab | a named outsourced lab
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchedBy: text("dispatched_by"),
    receivedAck: text("received_ack"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ot_specimens_no_ux").on(t.specimenNo),
    index("ot_specimens_case_idx").on(t.caseId),
    check("ot_specimens_dispatch_ck", sql`(${t.dispatchedAt} is null) = (${t.dispatchedBy} is null)`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 9. Recovery scoring — DD10. `discharge_ready` is COMPUTED, never typed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const pacuScores = pgTable(
  "pacu_scores",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    caseId: text("case_id").notNull().references(() => otCases.id),
    scale: text("scale").notNull(), // 'padss' | 'padss_spinal' — the ACTIVE definition's key
    values: jsonb("values").notNull(), // {itemKey: score}
    total: integer("total").notNull(),
    scoredBy: text("scored_by").notNull(),
    bayResourceId: text("bay_resource_id").notNull().references(() => resources.id),
    /**
     * B7/F25 — THE SCORE CLOCK IS `occurred_at`, TYPED. The "two scores 30 minutes apart" rule is
     * computed from this and not from `recorded_at`: a nurse charting both scores at the end of a
     * busy hour must not be able to satisfy a 30-minute rule with two rows written 4 seconds apart,
     * and a downtime backfill must not fail it.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pacu_scores_encounter_idx").on(t.encounterId, t.occurredAt),
    check("pacu_scores_total_ck", sql`${t.total} >= 0`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 10. Governed definition data — DD6. ONE versioned table, published through the approvals engine.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otDefinitions = pgTable(
  "ot_definitions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    status: text("status").notNull().default("draft"),
    draftedBy: text("drafted_by").notNull(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The GRANTED `ot_definition_publish` approval. Plain text — approvals are another module. */
    approvalId: text("approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ot_definitions_kind_version_ux").on(t.kind, t.version),
    /** A2 — ONE ACTIVE VERSION PER KIND, a database invariant. The engine's own precedent. */
    uniqueIndex("ot_definitions_one_active_ux").on(t.kind).where(sql`${t.status} = 'active'`),
    check("ot_definitions_kind_ck", inList(t.kind, OT_DEFINITION_KIND_VALUES)),
    check("ot_definitions_status_ck", sql`${t.status} in ('draft', 'active', 'superseded')`),
    check("ot_definitions_version_ck", sql`${t.version} > 0`),
    /** An active or superseded row was PUBLISHED by somebody, at some instant, under an approval. */
    check("ot_definitions_published_ck", sql`${t.status} = 'draft' or (${t.publishedBy} is not null and ${t.publishedAt} is not null)`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 11. Deposit holds — DD12 / F3. Advances are per PATIENT; a surgery's deposit is per ENCOUNTER.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otDepositHolds = pgTable(
  "ot_deposit_holds",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    /** The billing receipt whose UNALLOCATED balance this hold earmarks. Plain text (§4). */
    receiptId: text("receipt_id").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** §3A third-party rule — `{name, relation, phone}`; the refund voucher's payee (Spike Q6). */
    paidBy: jsonb("paid_by"),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull().defaultNow(),
    heldBy: text("held_by").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedReason: text("released_reason"),
  },
  (t) => [
    index("ot_deposit_holds_encounter_idx").on(t.encounterId),
    index("ot_deposit_holds_receipt_idx").on(t.receiptId),
    check("ot_deposit_holds_amount_ck", sql`${t.amountPaise} > 0`),
    check("ot_deposit_holds_release_ck", sql`(${t.releasedAt} is null) = (${t.releasedReason} is null)`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 12. Incidents — the OT-local near-miss / hard-stop record, until the quality module (28a).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const otIncidents = pgTable(
  "ot_incidents",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => daycareEncounters.id),
    caseId: text("case_id").references(() => otCases.id),
    kind: text("kind").notNull(),
    detail: jsonb("detail").notNull(),
    reportedBy: text("reported_by").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
  },
  (t) => [
    index("ot_incidents_encounter_idx").on(t.encounterId),
    index("ot_incidents_kind_idx").on(t.kind, t.reportedAt),
    check("ot_incidents_kind_ck", inList(t.kind, OT_INCIDENT_KIND_VALUES)),
    check("ot_incidents_resolution_ck", sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`),
  ],
);
