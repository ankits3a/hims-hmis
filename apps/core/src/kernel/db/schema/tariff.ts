import {
  bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Plan 06 — tariff/pricing master data (spec §7, C-3, D-3, D-8, §11.11).
 * Money is integer PAISE (bigint mode number — never floats), the Plan 04 precedent.
 * This is ONE self-contained FK group: nothing here references any table outside this file,
 * and tariff_versions.approval_id is deliberately plain text with NO FK (§3.12 precedent:
 * patient_merge_requests.approval_id) so the group truncates in a single statement.
 */

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(), // ULID via newId()
    code: text("code").notNull(), // human-facing service code (printed on invoices)
    name: text("name").notNull(),
    category: text("category").notNull(), // keys gst_config + adjustment scoping (consultation/procedure/room_rent/pharmacy/device/…)
    regulated: boolean("regulated").notNull().default(false), // C-3: min(tariff, MRP, ceiling) applies
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("services_code_ux").on(t.code), index("services_category_idx").on(t.category)],
);

export const tariffVersions = pgTable(
  "tariff_versions",
  {
    id: text("id").primaryKey(),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"), // 'draft'|'submitted'|'activated'|'rejected' (§11.11)
    notes: text("notes"),
    approvalId: text("approval_id"), // plain text, NO FK — see file comment
    effectiveFrom: timestamp("effective_from", { withTimezone: true }), // set at activation; strictly monotone across activated versions
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    activatedBy: text("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tariff_versions_no_ux").on(t.versionNo),
    index("tariff_versions_status_idx").on(t.status),
    // D5's strict monotonicity means two ACTIVATED versions can never share an effective date.
    // This partial unique index IS that invariant at the database layer — the structural
    // backstop behind the activation serializer (the workflow_definitions_one_active_ux /
    // patient_merge_requests_pending_loser_ux precedent).
    uniqueIndex("tariff_versions_activated_effective_ux")
      .on(t.effectiveFrom)
      .where(sql`${t.status} = 'activated'`),
  ],
);

export const tariffItems = pgTable(
  "tariff_items",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id").notNull().references(() => tariffVersions.id),
    serviceId: text("service_id").notNull().references(() => services.id),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(), // integer PAISE
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tariff_items_version_service_ux").on(t.versionId, t.serviceId)],
);

// C-3 regulated-price attributes. APPEND-ONLY: a revision (NPPA gazette, new MRP) is a new
// effective-dated row, never an UPDATE — the master-data change-control trail is the row history.
export const regulatedPrices = pgTable(
  "regulated_prices",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull().references(() => services.id),
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    ceilingPaise: bigint("ceiling_paise", { mode: "number" }), // DPCO/NPPA notified ceiling
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    gazetteRef: text("gazette_ref"), // provenance for the NPPA revision watch (C-3)
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("regulated_prices_service_idx").on(t.serviceId, t.effectiveFrom)],
);

export const adjustmentRules = pgTable(
  "adjustment_rules",
  {
    id: text("id").primaryKey(),
    ruleKey: text("rule_key").notNull(),
    sourceKey: text("source_key").notNull(), // 'rule' (standing rules) | 'manual' (D-8 cap rows); Plan 09 adds 'coupon','membership'
    title: text("title").notNull(),
    params: jsonb("params").notNull(), // zod-validated per sourceKey (rules.ts owns the schemas)
    serviceCategory: text("service_category"), // scope: null = all categories
    serviceId: text("service_id"), // scope: null = all services; plain text, no FK (config may pre-date the service row in a bulk load)
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("adjustment_rules_key_ux").on(t.ruleKey), index("adjustment_rules_source_idx").on(t.sourceKey)],
);

// D-3 GST config — CA-configured DATA, never engine literals (§19 gate). For exempt categories
// rate_bps holds the WOULD-BE rate deliberately: golden fixtures use it to distinguish
// "exempt flag honored" from "rate happens to be zero" (ledger §3.14 defense).
export const gstConfig = pgTable("gst_config", {
  category: text("category").primaryKey(),
  sacCode: text("sac_code").notNull(), // SAC for services, HSN for goods — one column, reporting-friendly
  exempt: boolean("exempt").notNull(),
  rateBps: integer("rate_bps").notNull(), // basis points: 500 = 5%
  specialRule: text("special_rule"), // 'room_rent_daily_threshold' | null (D-3 ₹5k/day line)
  thresholdPaise: bigint("threshold_paise", { mode: "number" }), // per-day, for the room-rent rule
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single audited row id='main' (registration_config precedent). ca_signed flips only via the
// §19 CA sign-off runbook step; D-17's validation report quotes it.
export const gstSettings = pgTable("gst_settings", {
  id: text("id").primaryKey(),
  compositeHealthcareExempt: boolean("composite_healthcare_exempt").notNull().default(true), // D-3 composite supply
  caSigned: boolean("ca_signed").notNull().default(false),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
