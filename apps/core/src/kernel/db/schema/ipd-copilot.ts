import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ipdAdmissions } from "./ipd";
import { patients } from "./patients";

/**
 * E5.3 (#740), E5.4 (#741) — COPILOT DRAFTS FOR AN ADMISSION: the reworded "Since yesterday" lines (kept per admission
 * and IST day so the page does not ask a model twice), the nurse's SBAR draft and the discharge summary draft. A row is
 * what was SHOWN, with its provenance: `source` (`template` = rendered from records only; `model` = a model wrote some of
 * the free text), the model id and the prompt version, when it was built and for whom. Rows are only ever added; the
 * newest row of a (admission, kind, scope) is the current draft. A draft is never a record: a shift handover or a
 * discharge summary exists only when a named person signs, and it then names the draft (`draft_id`).
 *
 * `facts_hash` is the fingerprint of the records the draft was built from: a kept "Since yesterday" row is re-verified
 * against today's records on every read, so a line whose source changed after drafting is never shown (§4.10 edge 13).
 * No money in `content` (decision 0058). Its words are the record's own: a quoted nursing note says what the note says.
 * What a MODEL was sent is never kept here (it was masked first — `modules/ipd/copilot-model.ts`).
 */
export const ipdCopilotDrafts = pgTable(
  "ipd_copilot_drafts",
  {
    id: text("id").primaryKey(),
    admissionId: text("admission_id").notNull().references(() => ipdAdmissions.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    kind: text("kind").notNull(),
    /** `since_yesterday`: the IST day; `sbar`: the IST day and shift; `discharge`: empty. */
    scopeKey: text("scope_key").notNull(),
    source: text("source").notNull(),
    modelId: text("model_id"),
    promptVersion: text("prompt_version").notNull(),
    factsHash: text("facts_hash").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    /** Why a model was not used, or why its words were dropped (`sealed`, `model_down`, `over_budget`, `rejected`…). */
    fallbackReason: text("fallback_reason"),
    builtBy: text("built_by").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
    /** How long the model was waited for, in milliseconds (0 when none was asked). */
    modelMs: integer("model_ms").notNull().default(0),
  },
  (t) => [
    index("ipd_copilot_drafts_current_idx").on(t.admissionId, t.kind, t.scopeKey, t.builtAt),
    check("ipd_copilot_drafts_kind_ck", sql`${t.kind} in ('since_yesterday', 'sbar', 'discharge')`),
    check("ipd_copilot_drafts_source_ck", sql`${t.source} in ('template', 'model')`),
    // A model's words always carry the model's id; a template draft never claims one.
    check("ipd_copilot_drafts_model_ck", sql`(${t.source} = 'model') = (${t.modelId} is not null)`),
    check("ipd_copilot_drafts_ms_ck", sql`${t.modelMs} >= 0`),
  ],
);
