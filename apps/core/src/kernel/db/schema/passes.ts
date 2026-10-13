import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { resources } from "./resources";

/**
 * E1.3 (#720) — ATTENDANT AND VISITOR PASSES (modules/passes; SPEC-ipd-companions §8).
 *
 * `passes` is one row per printed pass. `token` is the QR's whole payload: random, unique, never PHI. The holder is an
 * attendant or visitor, not staff — a name, an optional phone and the relation. `ward_id` is the ward the pass opens
 * (moved by a transfer; the baby's NICU for a mother's pass). A pass ends `revoked` (lost, damaged, police custody) with
 * `replaced_by` naming its reissue, or `expired` (the admission ended) with the reason; `paused` is a doctor's visitor
 * ban or a manager's pause, and `resume` puts it back.
 *
 * `pass_events` is the append-only story of every pass (trigger refuses UPDATE and DELETE); `pass_scans` is every scan
 * at a door with its one answer. `pass_admission_flags` holds the two facts about an admission the passes module owns:
 * police custody and the visitor ban.
 *
 * The literal lists are retyped from `packages/contracts/src/passes.ts` because drizzle-kit loads this file without
 * the workspace packages; `modules/passes/schema-parity.test.ts` holds them equal.
 */
export const PASS_KIND_VALUES = ["attendant", "visitor", "parent_stay", "nicu_mother", "police_guard", "lounge"] as const;
export const PASS_STATE_VALUES = ["active", "revoked", "expired", "paused"] as const;
export const PASS_SCAN_RESULT_VALUES = ["valid", "wrong_ward", "outside_hours", "expired", "revoked", "paused", "unknown"] as const;
const list = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

export const passes = pgTable(
  "passes",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    /** `nicu_mother`: the baby's admission (typed in by hand). Its end expires the pass too. */
    linkedAdmissionId: text("linked_admission_id").references(() => ipdAdmissions.id),
    kind: text("kind").notNull(),
    holderName: text("holder_name").notNull(),
    holderPhone: text("holder_phone"),
    holderRelation: text("holder_relation").notNull(),
    token: text("token").notNull(),
    wardId: text("ward_id").references(() => resources.id),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    state: text("state").notNull(),
    endReason: text("end_reason"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    pauseReason: text("pause_reason"),
    replacedBy: text("replaced_by"),
    replaces: text("replaces"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("passes_token_ux").on(t.token),
    index("passes_admission_idx").on(t.admissionId, t.state),
    index("passes_linked_admission_idx").on(t.linkedAdmissionId).where(sql`${t.linkedAdmissionId} is not null`),
    check("passes_kind_ck", sql`${t.kind} in (${list(PASS_KIND_VALUES)})`),
    check("passes_state_ck", sql`${t.state} in (${list(PASS_STATE_VALUES)})`),
    check("passes_ended_ck", sql`(${t.state} in ('revoked', 'expired')) = (${t.endedAt} is not null)`),
    check("passes_token_len_ck", sql`length(${t.token}) >= 20`),
  ],
);

export const passEvents = pgTable(
  "pass_events",
  {
    id: text("id").primaryKey(),
    passId: text("pass_id").references(() => passes.id),
    admissionId: text("admission_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    actorId: text("actor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("pass_events_pass_idx").on(t.passId),
    index("pass_events_admission_idx").on(t.admissionId, t.at),
    check("pass_events_kind_ck", sql`${t.kind} in ('issued', 'revoked', 'expired', 'paused', 'resumed', 'moved', 'custody_set', 'custody_cleared')`),
  ],
);

export const passScans = pgTable(
  "pass_scans",
  {
    id: text("id").primaryKey(),
    /** Null when the token is no pass (`unknown`). */
    passId: text("pass_id").references(() => passes.id),
    result: text("result").notNull(),
    wardId: text("ward_id"),
    gate: text("gate"),
    scannedBy: text("scanned_by").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("pass_scans_pass_idx").on(t.passId, t.at),
    index("pass_scans_at_idx").on(t.at),
    check("pass_scans_result_ck", sql`${t.result} in (${list(PASS_SCAN_RESULT_VALUES)})`),
  ],
);

export const passAdmissionFlags = pgTable(
  "pass_admission_flags",
  {
    admissionId: text("admission_id").primaryKey().references(() => ipdAdmissions.id),
    policeCustody: boolean("police_custody").notNull().default(false),
    custodyNote: text("custody_note"),
    visitorBanReason: text("visitor_ban_reason"),
    /** `visitors` (a doctor's ban) or `all` (a manager paused every pass): only passes.manage lifts `all`. */
    visitorBanScope: text("visitor_ban_scope"),
    visitorBanBy: text("visitor_ban_by"),
    visitorBanAt: timestamp("visitor_ban_at", { withTimezone: true }),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
);
