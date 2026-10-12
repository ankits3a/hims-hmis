import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";

/**
 * E1.7 BIO-MEDICAL WASTE (issue #724, decision 0072) — bags from the ward to the common treatment
 * facility (CBWTF), the handover manifests, the weight disputes, and every bag's append-only history.
 * Read and written only by `modules/bmw`. No patient column anywhere: a bag belongs to a place.
 *
 * `version` is the bag's optimistic-concurrency counter AND its history's sequence (the `tasks` shape):
 * every change bumps it by one in the transaction that appends `bmw_bag_events` with `seq = version`.
 * The bar code's serial comes from the standalone sequence `bmw_bag_serial` (migration `*_bmw.sql`).
 */
export const bmwManifests = pgTable(
  "bmw_manifests",
  {
    id: text("id").primaryKey(),
    manifestNo: text("manifest_no").notNull(),
    /** The facility's name as on its authorisation — free text, not a staff record. */
    cbwtfName: text("cbwtf_name").notNull(),
    vehicleNo: text("vehicle_no").notNull(),
    operatorName: text("operator_name"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }).notNull(),
    handedOverBy: text("handed_over_by").notNull(),
    bagCount: integer("bag_count").notNull(),
    /** Per category: `{ bags, deptGrams, centralGrams }` at handover. Derived from the bags, kept as the signed slip. */
    totals: jsonb("totals").$type<Record<string, { bags: number; deptGrams: number; centralGrams: number }>>().notNull(),
    cbwtfRecordedAt: timestamp("cbwtf_recorded_at", { withTimezone: true }),
    cbwtfRecordedBy: text("cbwtf_recorded_by"),
    /** Per category grams the facility weighed. */
    cbwtfTotals: jsonb("cbwtf_totals").$type<Record<string, number>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bmw_manifests_no_uq").on(t.manifestNo),
    index("bmw_manifests_at_idx").on(t.handedOverAt),
    check("bmw_manifests_counts_ck", sql`${t.bagCount} > 0`),
  ],
);

export const bmwBags = pgTable(
  "bmw_bags",
  {
    id: text("id").primaryKey(),
    barcode: text("barcode").notNull(),
    category: text("category").notNull(),
    cytotoxic: boolean("cytotoxic").notNull().default(false),
    placeResourceId: text("place_resource_id").notNull().references(() => resources.id),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    generatedBy: text("generated_by").notNull(),
    deptWeightGrams: integer("dept_weight_grams"),
    deptWeighedAt: timestamp("dept_weighed_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    collectedBy: text("collected_by"),
    centralWeightGrams: integer("central_weight_grams"),
    storageInAt: timestamp("storage_in_at", { withTimezone: true }),
    storedBy: text("stored_by"),
    state: text("state").notNull().default("generated"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    manifestId: text("manifest_id").references(() => bmwManifests.id),
    cbwtfWeightGrams: integer("cbwtf_weight_grams"),
    treatedAt: timestamp("treated_at", { withTimezone: true }),
    source: text("source").notNull().default("person"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("bmw_bags_barcode_uq").on(t.barcode),
    index("bmw_bags_on_site_idx").on(t.state, t.generatedAt).where(sql`${t.state} in ('generated', 'collected', 'stored')`),
    index("bmw_bags_generated_idx").on(t.generatedAt),
    index("bmw_bags_place_idx").on(t.placeResourceId, t.generatedAt),
    index("bmw_bags_manifest_idx").on(t.manifestId),
    check("bmw_bags_category_ck", sql`${t.category} in ('yellow', 'red', 'white_translucent', 'blue')`),
    check("bmw_bags_cytotoxic_ck", sql`not ${t.cytotoxic} or ${t.category} = 'yellow'`),
    check("bmw_bags_state_ck", sql`${t.state} in ('generated', 'collected', 'stored', 'handed_over', 'treated', 'disputed')`),
    check("bmw_bags_weights_ck", sql`coalesce(${t.deptWeightGrams}, 1) > 0 and coalesce(${t.centralWeightGrams}, 1) > 0 and coalesce(${t.cbwtfWeightGrams}, 1) > 0`),
    // Once handed over, a bag is on exactly one manifest — the second handover has nowhere to go.
    check("bmw_bags_manifest_ck", sql`(${t.state} in ('handed_over', 'treated', 'disputed')) = (${t.manifestId} is not null)`),
    check("bmw_bags_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import')`),
    check("bmw_bags_version_ck", sql`${t.version} >= 1`),
  ],
);

/** Append-only (a trigger refuses UPDATE and DELETE). `seq` equals the bag's `version` after the act. */
export const bmwBagEvents = pgTable(
  "bmw_bag_events",
  {
    bagId: text("bag_id").notNull().references(() => bmwBags.id),
    seq: integer("seq").notNull(),
    act: text("act").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.bagId, t.seq] }),
    index("bmw_bag_events_at_idx").on(t.at),
    check("bmw_bag_events_act_ck", sql`${t.act} in ('generated', 'dept_weighed', 'collected', 'stored', 'handed_over', 'cbwtf_weighed', 'treated', 'disputed', 'resolved')`),
    check("bmw_bag_events_source_ck", sql`${t.source} in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system')`),
  ],
);

/** A weight gap of ≥ 6 % between the department's and the CBWTF's weight, per manifest and category. */
export const bmwDisputes = pgTable(
  "bmw_disputes",
  {
    id: text("id").primaryKey(),
    manifestId: text("manifest_id").notNull().references(() => bmwManifests.id),
    category: text("category").notNull(),
    deptGrams: integer("dept_grams").notNull(),
    cbwtfGrams: integer("cbwtf_grams").notNull(),
    gapBasisPoints: integer("gap_basis_points").notNull(),
    state: text("state").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    openedBy: text("opened_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    uniqueIndex("bmw_disputes_manifest_category_uq").on(t.manifestId, t.category),
    index("bmw_disputes_open_idx").on(t.state).where(sql`${t.state} = 'open'`),
    check("bmw_disputes_state_ck", sql`${t.state} in ('open', 'resolved')`),
    check("bmw_disputes_category_ck", sql`${t.category} in ('yellow', 'red', 'white_translucent', 'blue')`),
    check("bmw_disputes_resolved_ck", sql`(${t.state} = 'resolved') = (${t.resolvedAt} is not null)`),
  ],
);
