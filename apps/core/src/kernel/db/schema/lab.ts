import { sql } from "drizzle-orm";
import {
  boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { invoiceLines, invoices } from "./billing";
import { orderItems, orders } from "./orders";
import { patients } from "./patients";
import { resources } from "./resources";
import { services } from "./tariff";

/**
 * PLAN 17 T1 — THE CENTRAL LAB. Fourteen tables, every one of them an EXTENSION of the order
 * envelope and none of them a column on it (phase 0 §8.1, this plan's §8.1).
 *
 * ═══ WHY THESE ARE `kernel/db/schema` FILES AND NOT A MODULE'S OWN ═══
 *
 * They are not kernel TABLES in the envelope's sense. Every drizzle table in this repository lives
 * under `kernel/db/schema` — `ot.ts`, `materials.ts`, `formulary.ts` are all module-owned tables in
 * this directory — because one `schema` object is what `drizzle(pool, { schema })` takes and what
 * `migrate()` diffs. The OWNERSHIP rule is the module boundary, not the file's directory: nothing
 * outside `modules/lab` writes these rows, and `billing-purity.test.ts`'s class of sweep is what
 * would catch it if something did.
 *
 * ═══ THE TWO-LEVEL CATALOGUE (DD1) IS THE ONE SHAPE TO READ FIRST ═══
 *
 * An ORDERABLE is what a doctor ticks and a counter bills: one `services` row, one `order_items`
 * row, one tariff line. An ANALYTE is what a bench measures and a report prints: haemoglobin, SGOT,
 * LDL. `lab_orderable_analytes` joins them in report order. A standalone CBC and a "Fever Profile"
 * containing CBC are two orderables sharing twenty analytes — which is exactly how the duplicate
 * detector sees a CBC inside a profile that `findRecentItems`' `service_id` equality cannot
 * (phase 0 §6A.3, closed here for the lab).
 *
 * ═══ AND THE RULE THAT KEEPS A PUBLISHED REPORT TRUE (DD2, DD13) ═══
 *
 * The reference range is RESOLVED at result entry and SNAPSHOTTED onto the result row. A range-book
 * edit must never rewrite a flag on a report a pathologist already signed: NABL wants the range the
 * report was signed AGAINST, not the current one. The two immutability triggers at the foot of the
 * migration are the same statement of the same rule, made by the database.
 */

/* ────────────────────────────── The catalogue (DD1, DD2, DD3) ────────────────────────────── */

/**
 * WHAT A DOCTOR ORDERS AND A COUNTER BILLS — keyed by `service_id`, which IS the primary key.
 *
 * There is no separate orderable id on purpose. One orderable is one `services` row is one tariff
 * line is one `order_items` row: giving it a second identity would create a mapping table with one
 * row per orderable and a class of bug where the two disagree about which test was billed. The
 * envelope's `order_items.service_id` therefore joins straight here (§2.54's prescription applied
 * before the drift: do not create the second copy).
 */
export const labOrderables = pgTable(
  "lab_orderables",
  {
    serviceId: text("service_id").primaryKey().references(() => services.id),
    /** The lab's own short code — `CBC`, `LFT`, `TSH`. Unique, and what a requisition slip prints. */
    code: text("code").notNull().unique(),
    nameEn: text("name_en").notNull(),
    /** DD21 — the report prints the patient's language beside the code; Hindi is not optional here. */
    nameHi: text("name_hi"),
    /** `haematology | biochemistry | serology | clinical_pathology | microbiology | histopathology`. */
    discipline: text("discipline").notNull(),
    specimenType: text("specimen_type").notNull(),
    container: text("container").notNull(),
    minVolumeMl: numeric("min_volume_ml", { precision: 6, scale: 2 }),
    /** DD17 — a `resources` row of kind `bench`. Plain text: the worklist resolves it, no FK. */
    benchKey: text("bench_key"),
    tatMinutesRoutine: integer("tat_minutes_routine").notNull(),
    tatMinutesStat: integer("tat_minutes_stat"),
    requiresFasting: boolean("requires_fasting").notNull().default(false),
    /**
     * DD14 — NACO/ICTC consent-class. The desk records consent BEFORE the item can be collected and
     * the item is placed `restricted: true` on the envelope, which is what makes the kernel reader
     * hide it from the ward clerk (phase 0 §6.6, `read.ts`'s `visibleItems`).
     */
    consentRequired: boolean("consent_required").notNull().default(false),
    /** DD14 — HIV, HBsAg, pregnancy, STI, genetic: `publish_channels` is forced to `in_person`. */
    sensitive: boolean("sensitive").notNull().default(false),
    /** 28a subscribes to `lab.notifiable_flagged` when it exists; the FLAG is this phase's. */
    notifiable: boolean("notifiable").notNull().default(false),
    /**
     * E33 / 02 E6 — PCPNDT. An orderable that would report foetal sex is refused by the catalogue
     * upsert, and the column exists so the refusal is a stored fact a register can be audited
     * against rather than a rule that lives only in a validator.
     */
    reportsFoetalSex: boolean("reports_foetal_sex").notNull().default(false),
    active: boolean("active").notNull().default(true),
    /** E41 — bumped on any unit/range/analyte-set change. Results keep the unit they were entered with. */
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_orderables_bench_idx").on(t.benchKey),
    index("lab_orderables_active_idx").on(t.active),
    check(
      "lab_orderables_discipline_ck",
      sql`${t.discipline} in ('haematology', 'biochemistry', 'serology', 'clinical_pathology', 'microbiology', 'histopathology')`,
    ),
    check("lab_orderables_tat_ck", sql`${t.tatMinutesRoutine} > 0`),
    /** E33 — the database refuses it too, so a direct insert cannot route around the upsert. */
    check("lab_orderables_no_foetal_sex_ck", sql`${t.reportsFoetalSex} = false`),
  ],
);

/**
 * WHAT A BENCH MEASURES AND A REPORT PRINTS. The resultable quantity, independent of who ordered it.
 *
 * `result_type` decides which of the three value columns `lab_results` may carry, and the CHECK
 * there is written from this column rather than from a per-row flag — one fact, one place.
 */
export const labAnalytes = pgTable(
  "lab_analytes",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    /** §1.3 — a NULLABLE column awaiting licensed content. This phase loads no LOINC. */
    loincCode: text("loinc_code"),
    nameEn: text("name_en").notNull(),
    nameHi: text("name_hi"),
    resultType: text("result_type").notNull(),
    unit: text("unit"),
    decimals: integer("decimals").notNull().default(1),
    /**
     * DD3 — a SMALL expression over SIBLING analyte codes of the SAME specimen (`+ - * /`, numbers,
     * codes). Evaluated by a guarded parser, never by `eval`. `formula_guard` is the precondition
     * whose failure yields TEXT (`'not calculable (TG ≥ 400)'`) and never a number: the wrong number
     * this engine can produce is silent and clinical, so an honest failure is the only failure.
     */
    formula: text("formula"),
    formulaGuard: text("formula_guard"),
    /** 02 H1 — the typo envelope. Outside it, entry is refused without a second holder's override. */
    absurdLow: numeric("absurd_low", { precision: 14, scale: 4 }),
    absurdHigh: numeric("absurd_high", { precision: 14, scale: 4 }),
    /** DD12 — the default critical band; a resolved range row may override it per age band. */
    criticalLow: numeric("critical_low", { precision: 14, scale: 4 }),
    criticalHigh: numeric("critical_high", { precision: 14, scale: 4 }),
    /**
     * 17d T1 / D1 — **WHO THIS TEST IS FOR AT ALL**, which is a different question from what its
     * range is. `lab_reference_ranges.sex` says a woman's haemoglobin reads lower than a man's;
     * these say a beta-hCG has nothing to report about a man in the first place. An absent row in
     * the range book falls back to `any` and footnotes itself (`pickBySex`) — right for a
     * potassium, and the one wrong answer in the module when an analyte is MEANINGLESS for this
     * patient rather than merely unranged.
     *
     * All three NULL = applies to everybody, which is every analyte seeded before this phase. The
     * age pair is half-open `[min, max)` in DAYS AT COLLECTION, the clock `resolveRange` already
     * bands on, so one reader answers both questions the same way.
     */
    appliesToSex: text("applies_to_sex"),
    appliesMinAgeDays: integer("applies_min_age_days"),
    appliesMaxAgeDays: integer("applies_max_age_days"),
    /** 02 H2 — delta check against the previous VERIFIED result for the CANONICAL patient. */
    deltaAbs: numeric("delta_abs", { precision: 14, scale: 4 }),
    deltaPct: numeric("delta_pct", { precision: 6, scale: 2 }),
    deltaWindowHours: integer("delta_window_hours"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lab_analytes_result_type_ck", sql`${t.resultType} in ('numeric', 'text', 'coded', 'formula')`),
    /** A formula analyte without a formula is a column nobody can compute. */
    check(
      "lab_analytes_formula_ck",
      sql`(${t.resultType} = 'formula') = (${t.formula} is not null)`,
    ),
    check("lab_analytes_absurd_ck", sql`${t.absurdLow} is null or ${t.absurdHigh} is null or ${t.absurdLow} <= ${t.absurdHigh}`),
    /**
     * 17d T1 — `male`/`female` only. `other` and `unknown` are administrative genders a PATIENT may
     * carry, never a claim an ANALYTE makes about who it is for, and a laboratory that refused
     * those patients' results would be withholding care on a data-entry default.
     */
    check("lab_analytes_applies_sex_ck", sql`${t.appliesToSex} is null or ${t.appliesToSex} in ('male', 'female')`),
    check(
      "lab_analytes_applies_age_ck",
      sql`${t.appliesMinAgeDays} is null or ${t.appliesMaxAgeDays} is null or ${t.appliesMinAgeDays} < ${t.appliesMaxAgeDays}`,
    ),
  ],
);

/** The join, in REPORT order. `position` is what a printed report reads down. */
export const labOrderableAnalytes = pgTable(
  "lab_orderable_analytes",
  {
    serviceId: text("service_id").notNull().references(() => labOrderables.serviceId),
    analyteId: text("analyte_id").notNull().references(() => labAnalytes.id),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.analyteId] }),
    index("lab_orderable_analytes_analyte_idx").on(t.analyteId),
  ],
);

/**
 * DD2 — THE RANGE BOOK. Resolution takes the patient's age AT COLLECTION in IST days and their
 * `administrative_gender`, with `sex='any'` as the fallback.
 *
 * `age_min_days` is INCLUSIVE and `age_max_days` is EXCLUSIVE, which is what makes a band boundary
 * decidable at midnight (E17 / 02 B8): a child who turns one at 00:30 IST on the collection day is
 * in the infant band, and a resolver that computed the age in UTC would put them in the neonate
 * band with a different `ref_high`. That is T3 A1.
 */
export const labReferenceRanges = pgTable(
  "lab_reference_ranges",
  {
    id: text("id").primaryKey(),
    analyteId: text("analyte_id").notNull().references(() => labAnalytes.id),
    sex: text("sex").notNull(),
    ageMinDays: integer("age_min_days").notNull(),
    ageMaxDays: integer("age_max_days").notNull(),
    low: numeric("low", { precision: 14, scale: 4 }),
    high: numeric("high", { precision: 14, scale: 4 }),
    /** A non-numeric range — "Negative", "< 1:80". Carried onto the result as `ref_text`. */
    text: text("text"),
    /** DD12 — the age-band override that BEATS the analyte's default critical band (T3 A8). */
    criticalLow: numeric("critical_low", { precision: 14, scale: 4 }),
    criticalHigh: numeric("critical_high", { precision: 14, scale: 4 }),
    /** The kit insert, the textbook, the local study. NABL asks where a range came from. */
    source: text("source").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_reference_ranges_analyte_idx").on(t.analyteId, t.sex, t.ageMinDays),
    check("lab_reference_ranges_sex_ck", sql`${t.sex} in ('male', 'female', 'other', 'any')`),
    check("lab_reference_ranges_age_ck", sql`${t.ageMinDays} <= ${t.ageMaxDays}`),
    /** A range that carries neither a number nor text says nothing at all. */
    check(
      "lab_reference_ranges_value_ck",
      sql`${t.low} is not null or ${t.high} is not null or ${t.text} is not null`,
    ),
  ],
);

/**
 * DD8 — REFLEX RULES. "TSH > 6 ⇒ add FT4." Matched at VERIFICATION, placed synchronously in the
 * verifying transaction, and only when the parent item carries order-time consent.
 *
 * The rule set ships with three rows and `active` is the switch. `version` is bumped rather than
 * edited so a placed reflex order can name the rule VERSION that placed it.
 */
export const labReflexRules = pgTable(
  "lab_reflex_rules",
  {
    id: text("id").primaryKey(),
    analyteId: text("analyte_id").notNull().references(() => labAnalytes.id),
    comparator: text("comparator").notNull(),
    threshold: numeric("threshold", { precision: 14, scale: 4 }).notNull(),
    addsServiceId: text("adds_service_id").notNull().references(() => labOrderables.serviceId),
    active: boolean("active").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_reflex_rules_analyte_idx").on(t.analyteId, t.active),
    check("lab_reflex_rules_comparator_ck", sql`${t.comparator} in ('gt', 'gte', 'lt', 'lte')`),
  ],
);

/* ─────────────────────────── The pipeline (DD4, DD5, DD6, DD10) ─────────────────────────── */

/**
 * THE LAB'S SIDE OF ONE ORDER ITEM — keyed `order_item_id`, which IS the primary key (phase 0 §6.3).
 *
 * One envelope item, one lab item, one workflow instance, one invoice line. The money columns live
 * HERE and not on the envelope, which holds no money at all (phase 0 DD10): `invoice_id` /
 * `invoice_line_id` are what `deliveryAllowed` follows to a settlement, and `charge_reason` is what
 * tells a package (26) that `refundOnCancel` is not its rule.
 */
export const labItems = pgTable(
  "lab_items",
  {
    orderItemId: text("order_item_id").primaryKey().references(() => orderItems.id),
    /** The `lab_item` workflow instance (DD4). The definition's stages, not the envelope's four. */
    instanceId: text("instance_id").notNull(),
    serviceId: text("service_id").notNull().references(() => labOrderables.serviceId),
    /** DD6 — written in the SAME statement as the placement at the desk; null only until invoiced. */
    invoiceId: text("invoice_id").references(() => invoices.id),
    invoiceLineId: text("invoice_line_id").references(() => invoiceLines.id),
    /** `lab_desk | lab_reflex | lab_addon | lab_walkin | package` — DD6/DD7 and CONTRACT 6. */
    chargeReason: text("charge_reason").notNull(),
    /** DD14 — consent-class tests cannot be COLLECTED until these are set (02 E1). */
    consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }),
    consentRecordedBy: text("consent_recorded_by"),
    /** DD8 — order-time consent for reflex. A rule fires only when the parent item carries it. */
    reflexConsentedAt: timestamp("reflex_consented_at", { withTimezone: true }),
    priority: text("priority").notNull().default("routine"),
    /** E49 / 24a — `opd | ward | home | camp | external`. 24a adds `home` collections, not a column. */
    collectionSite: text("collection_site").notNull().default("opd"),
    /** DD10 / 02 A2 — an unscanned ward collection cannot reach `received` without this. */
    identityRecheckBy: text("identity_recheck_by"),
    /** THE TAT CLOCK STARTS AT RECEIVE (T5 A7) — not at placement and not at collection. */
    tatStartedAt: timestamp("tat_started_at", { withTimezone: true }),
    tatStoppedAt: timestamp("tat_stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_items_instance_idx").on(t.instanceId),
    index("lab_items_service_idx").on(t.serviceId),
    index("lab_items_invoice_idx").on(t.invoiceId),
    check("lab_items_priority_ck", sql`${t.priority} in ('routine', 'urgent', 'stat')`),
    check(
      "lab_items_charge_reason_ck",
      sql`${t.chargeReason} in ('lab_desk', 'lab_reflex', 'lab_addon', 'lab_walkin', 'package')`,
    ),
    check(
      "lab_items_collection_site_ck",
      sql`${t.collectionSite} in ('opd', 'ward', 'home', 'camp', 'external')`,
    ),
    /** DD14 — consent is a PAIR: a recorded instant with no recorder names nobody. */
    check(
      "lab_items_consent_ck",
      sql`(${t.consentRecordedAt} is null) = (${t.consentRecordedBy} is null)`,
    ),
    /** An invoice line without its invoice is a line nobody can settle. */
    check(
      "lab_items_invoice_pair_ck",
      sql`${t.invoiceLineId} is null or ${t.invoiceId} is not null`,
    ),
  ],
);

/**
 * DD5 — THE TUBE. One `S` number per physical container, minted from `lab_specimen`'s daily counter.
 *
 * A specimen serves N items and an item is served by its CURRENT specimen: a haemolysed tube is
 * REJECTED and a new tube is drawn for the same items without cancelling the order, which is
 * `series.ts`'s own header ("one order, several tubes; one tube, several tests") turned into rows.
 */
export const labSpecimens = pgTable(
  "lab_specimens",
  {
    id: text("id").primaryKey(),
    /** `S2608290001` — from `nextEpisodeNo(tx, 'lab_specimen', serviceDate)` (S6). Never an order no. */
    specimenNo: text("specimen_no").notNull().unique(),
    /** The clinical act this tube belongs to; several orders may share it (phase 0 DD2). */
    orderGroupId: text("order_group_id").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    specimenType: text("specimen_type").notNull(),
    container: text("container").notNull(),
    status: text("status").notNull().default("labelled"),
    /** E20 / 02 C3 — `downtime_kit` is the pre-printed kit used when the label printer is down. */
    labelSource: text("label_source").notNull().default("printer"),
    /** The kit serial, mapped to this tube at accession when `label_source = 'downtime_kit'`. */
    downtimeKitSerial: text("downtime_kit_serial"),
    collectedBy: text("collected_by"),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    /** DD10 / 02 A2 — false on a ward draw forces an identity re-check at accession. */
    wristbandScanned: boolean("wristband_scanned").notNull().default(false),
    /** E5 — `external` is an outside-collected sample and carries a report footnote. */
    collectionSite: text("collection_site").notNull().default("opd"),
    receivedBy: text("received_by"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    /** Whose fault, for the quality register 28a will build over these rows. */
    attributableTo: text("attributable_to"),
    /** The tube this one replaces. A rejection creates a NEW specimen for the SAME items (DD5). */
    recollectionOfSpecimenId: text("recollection_of_specimen_id"),
    storedAt: timestamp("stored_at", { withTimezone: true }),
    /** E14 / 02 B4 — once disposed, an add-on on this tube is refused and a recollection opens. */
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_specimens_patient_idx").on(t.patientId, t.collectedAt),
    index("lab_specimens_status_date_idx").on(t.status, t.serviceDate),
    index("lab_specimens_group_idx").on(t.orderGroupId),
    check(
      "lab_specimens_status_ck",
      sql`${t.status} in ('labelled', 'collected', 'in_transit', 'received', 'rejected', 'stored', 'disposed')`,
    ),
    check("lab_specimens_label_source_ck", sql`${t.labelSource} in ('printer', 'downtime_kit')`),
    check(
      "lab_specimens_collection_site_ck",
      sql`${t.collectionSite} in ('opd', 'ward', 'home', 'camp', 'external')`,
    ),
    /** The closed rejection list — a free-text reason is a quality register nobody can total. */
    check(
      "lab_specimens_rejection_reason_ck",
      sql`${t.rejectionReason} is null or ${t.rejectionReason} in ('haemolysed', 'clotted', 'insufficient', 'wrong_container', 'unlabelled', 'mislabelled', 'leaked', 'contaminated', 'delayed_transport', 'temperature_excursion')`,
    ),
    check(
      "lab_specimens_attributable_ck",
      sql`${t.attributableTo} is null or ${t.attributableTo} in ('collection', 'transport', 'lab', 'patient')`,
    ),
    /** A rejected tube names WHY and WHOSE; a tube that is not rejected names neither. */
    check(
      "lab_specimens_rejected_ck",
      sql`(${t.status} = 'rejected') = (${t.rejectionReason} is not null)`,
    ),
    /** A downtime kit is identified by its serial; a printer label is not. */
    check(
      "lab_specimens_downtime_ck",
      sql`(${t.labelSource} = 'downtime_kit') or (${t.downtimeKitSerial} is null)`,
    ),
  ],
);

/**
 * DD5 — WHICH TESTS ARE ON WHICH TUBE, and which tube is an item's CURRENT one.
 *
 * The partial UNIQUE on `(order_item_id) WHERE active` is the whole invariant: an item has at most
 * ONE live tube at any instant. A rejection flips the old row's `active` to false and inserts a new
 * one for the replacement specimen, so the history of which tubes a test rode is kept rather than
 * overwritten — E8's "two open orders, two tubes" is answered by reading this table, never by
 * guessing from the patient.
 */
export const labSpecimenItems = pgTable(
  "lab_specimen_items",
  {
    specimenId: text("specimen_id").notNull().references(() => labSpecimens.id),
    orderItemId: text("order_item_id").notNull().references(() => orderItems.id),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.specimenId, t.orderItemId] }),
    uniqueIndex("lab_specimen_items_active_ux").on(t.orderItemId).where(sql`active`),
  ],
);

/* ──────────────────────────── Results, reports, criticals (DD11–DD13) ──────────────────────────── */

/**
 * ONE MEASURED VALUE. Immutable once verified, by a database trigger (DD13).
 *
 * ═══ THE RANGE IS SNAPSHOTTED, NOT REFERENCED (DD2) ═══
 *
 * `ref_low` / `ref_high` / `ref_text` / `ref_range_id` are all written at ENTRY. Reading the range
 * at report time instead would mean an edit to the range book silently re-flags a value a
 * pathologist already signed — T6 A6's mutant is exactly that, and the assertion is that moving
 * `ref_high` afterwards changes nothing on this row.
 *
 * ═══ AND `verification_status` IS THE COLUMN THE TRIGGER WATCHES ═══
 *
 * `unverified → verified` is the one UPDATE this table permits, and it is permitted because the
 * trigger fires on the OLD row's status. A correction after verification is a NEW row carrying
 * `supersedes_result_id`, and a new report version with it — never an edit (02 H8, E40).
 */
export const labResults = pgTable(
  "lab_results",
  {
    id: text("id").primaryKey(),
    orderItemId: text("order_item_id").notNull().references(() => orderItems.id),
    analyteId: text("analyte_id").notNull().references(() => labAnalytes.id),
    specimenId: text("specimen_id").references(() => labSpecimens.id),
    valueNumeric: numeric("value_numeric", { precision: 14, scale: 4 }),
    valueText: text("value_text"),
    valueCoded: text("value_coded"),
    unit: text("unit"),
    flag: text("flag"),
    refLow: numeric("ref_low", { precision: 14, scale: 4 }),
    refHigh: numeric("ref_high", { precision: 14, scale: 4 }),
    refText: text("ref_text"),
    refRangeId: text("ref_range_id").references(() => labReferenceRanges.id),
    /** DD2 — "reference range: unspecified sex", "date of birth estimated" (02 H4/H5). */
    refNote: text("ref_note"),
    deltaFlag: boolean("delta_flag").notNull().default(false),
    deltaPrevResultId: text("delta_prev_result_id"),
    /** 02 H1 — who let an absurd value through. Null means it was never outside the envelope. */
    absurdOverriddenBy: text("absurd_overridden_by"),
    /**
     * 17d T1 — its twin: who vouched that a value impossible for this patient's sex or age is
     * nonetheless theirs. Null means the applicability rule never fired for this row — which is a
     * different fact from "somebody declined to override it", a state that leaves no row at all.
     */
    impossibleOverriddenBy: text("impossible_overridden_by"),
    enteredByType: text("entered_by_type").notNull(),
    enteredById: text("entered_by_id").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    /** `interface` does not exist until 17-E; `manual_from_printout` is E19's core-down path. */
    entryMode: text("entry_mode").notNull(),
    analyzerId: text("analyzer_id"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** DD11 — night mode released it; the pathologist's morning queue is keyed on this. */
    pathologistReviewPending: boolean("pathologist_review_pending").notNull().default(false),
    rerunOf: text("rerun_of"),
    supersedesResultId: text("supersedes_result_id"),
    remarks: text("remarks"),
  },
  (t) => [
    index("lab_results_item_analyte_idx").on(t.orderItemId, t.analyteId),
    index("lab_results_specimen_idx").on(t.specimenId),
    /** DD11 — the pathologist's queue: everything entered and not yet verified. */
    index("lab_results_unverified_idx").on(t.verificationStatus, t.enteredAt),
    check("lab_results_flag_ck", sql`${t.flag} is null or ${t.flag} in ('L', 'H', 'LL', 'HH', 'A', 'N')`),
    check("lab_results_entry_mode_ck", sql`${t.entryMode} in ('manual', 'manual_from_printout', 'interface')`),
    check(
      "lab_results_verification_status_ck",
      sql`${t.verificationStatus} in ('unverified', 'verified', 'autoverified')`,
    ),
    check("lab_results_entered_by_type_ck", sql`${t.enteredByType} in ('user', 'agent', 'system', 'patient')`),
    /**
     * EXACTLY ONE VALUE COLUMN CARRIES THE ANSWER. A result with two values is a result whose
     * report depends on which one the renderer happens to read first, and a result with none is a
     * row that says a test was done and not what it found.
     */
    check(
      "lab_results_one_value_ck",
      sql`(case when ${t.valueNumeric} is null then 0 else 1 end
         + case when ${t.valueText} is null then 0 else 1 end
         + case when ${t.valueCoded} is null then 0 else 1 end) = 1`,
    ),
    /** A verification is a PAIR: an instant with no verifier names nobody (DD11's SoD record). */
    check(
      "lab_results_verified_pair_ck",
      sql`(${t.verifiedAt} is null) = (${t.verifiedBy} is null)`,
    ),
    /** An unverified row has no verifier; a verified one has one. */
    check(
      "lab_results_verified_status_ck",
      sql`(${t.verificationStatus} = 'unverified') = (${t.verifiedBy} is null)`,
    ),
  ],
);

/**
 * DD13 — THE REPORT, AS A VERSIONED SIGNED SNAPSHOT. Immutable once published, by trigger.
 *
 * `snapshot` is the whole rendered document as data: the results with the ranges and flags they
 * were signed against, the patient's identity AS IT WAS (E4 — a merge afterwards does not rewrite a
 * printed report), the signatory block. An amendment is version n+1 with `prior_version_id` and the
 * old version becomes `superseded`; there is no edit endpoint and there must not be one.
 */
export const labReports = pgTable(
  "lab_reports",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => orders.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    snapshot: jsonb("snapshot").notNull(),
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** DD14 — forced to `{in_person}` for a `sensitive` orderable (02 J3). */
    publishChannels: text("publish_channels").array().notNull().default(sql`'{}'::text[]`),
    printCount: integer("print_count").notNull().default(0),
    /** R-018 — a reason CATEGORY, never free text on a re-notification. */
    amendmentReasonCode: text("amendment_reason_code"),
    priorVersionId: text("prior_version_id"),
    /** 02 D7 — a package-style partial publish at 24 h; the rest follows as a later version. */
    partial: boolean("partial").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lab_reports_order_version_ux").on(t.orderId, t.version),
    index("lab_reports_status_idx").on(t.status, t.publishedAt),
    check("lab_reports_status_ck", sql`${t.status} in ('draft', 'published', 'amended', 'superseded')`),
    check("lab_reports_version_ck", sql`${t.version} >= 1`),
    /** A published report is SIGNED and has an instant; a draft is neither. */
    check(
      "lab_reports_published_ck",
      sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`,
    ),
    check(
      "lab_reports_signed_ck",
      sql`(${t.signedAt} is null) = (${t.signedBy} is null)`,
    ),
    /** Version 1 supersedes nothing; every later version names its predecessor. */
    check(
      "lab_reports_prior_ck",
      sql`(${t.version} = 1) = (${t.priorVersionId} is null)`,
    ),
  ],
);

/**
 * THE RELEASE REGISTER (02 J2, T7 A9). Who took the report away, on which channel, under whose
 * approval when the interlock was overridden.
 *
 * `approval_id` is plain text holding an `approvals.id` — the actor-column precedent (phase 0
 * DD17): a NULL means the delivery was allowed on its own merits, not that an approval is missing.
 */
export const labReportDeliveries = pgTable(
  "lab_report_deliveries",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull().references(() => labReports.id),
    channel: text("channel").notNull(),
    deliveredBy: text("delivered_by").notNull(),
    /** 02 J2 — WHO collected it, named. A cashier printing for a friend is E42. */
    collectorIdentity: text("collector_identity"),
    approvalId: text("approval_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lab_report_deliveries_report_idx").on(t.reportId),
    check(
      "lab_report_deliveries_channel_ck",
      sql`${t.channel} in ('print', 'whatsapp', 'in_person', 'doctor_screen')`,
    ),
    /** A physical hand-over names its collector; a screen read and a message do not. */
    check(
      "lab_report_deliveries_collector_ck",
      sql`${t.channel} not in ('print', 'in_person') or ${t.collectorIdentity} is not null`,
    ),
  ],
);

/**
 * DD12 — THE CALL LADDER. Opened at ENTRY (not at verify — the 15-minute clinical need is the call,
 * not the signature) and closed only by a READ-BACK, which is the whole of 02 §3.6.
 *
 * `attempts` is an append-only JSON array of `{at, by, contact, outcome}`; the row closes when
 * `readback_text` is non-empty. A call with three failed attempts and no read-back is an OPEN call,
 * and the partial index on `closed_at IS NULL` is what a shift handover reads.
 */
export const labCriticalCalls = pgTable(
  "lab_critical_calls",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id").notNull().references(() => labResults.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedBy: text("opened_by").notNull(),
    attempts: jsonb("attempts").notNull().default(sql`'[]'::jsonb`),
    readbackText: text("readback_text"),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("lab_critical_calls_open_idx").on(t.openedAt).where(sql`closed_at is null`),
    index("lab_critical_calls_result_idx").on(t.resultId),
    /** A CLOSED call has a read-back, a closer and an instant — all three, or it is not closed. */
    check(
      "lab_critical_calls_closed_ck",
      sql`(${t.closedAt} is null) = (${t.readbackText} is null) and (${t.closedAt} is null) = (${t.closedBy} is null)`,
    ),
  ],
);

/**
 * DD20 — SLA BREACHES, one row per (item, stage), written once by the sweep and never again.
 *
 * The UNIQUE on `(order_item_id, stage)` is what makes T5 A8 true without the sweep keeping state:
 * a second sweep over the same breached item conflicts and writes nothing, so the alert fires once
 * however often the worker runs.
 */
export const labSlaBreaches = pgTable(
  "lab_sla_breaches",
  {
    id: text("id").primaryKey(),
    orderItemId: text("order_item_id").notNull().references(() => orderItems.id),
    stage: text("stage").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    breachedAt: timestamp("breached_at", { withTimezone: true }).notNull().defaultNow(),
    notified: boolean("notified").notNull().default(false),
  },
  (t) => [
    uniqueIndex("lab_sla_breaches_item_stage_ux").on(t.orderItemId, t.stage),
  ],
);

/**
 * ═══ PLAN 17-E T1 — THE INSTRUMENTS ON THE BENCH, AND HOW EACH ONE NAMES A SAMPLE ═══
 *
 * The machine itself is a `resources` row of kind `analyzer` — declared in `lab/kinds.ts` since
 * Plan 17 T2 with a seven-word status vocabulary and, until now, no writer. That is where its STATE
 * lives (`available`, `interface_down`, …) and where `resource_status_history` keeps it. This table
 * is the lab's own half: the facts the kernel has no opinion about.
 *
 * ═══ `sample_id_mode` IS THE WHOLE DESIGN, COMPRESSED INTO ONE COLUMN ═══
 *
 * `Instruments.dc.html` describes nine machines and they differ in exactly one way that matters to
 * software: **how the instrument names the sample it just measured.** A chemistry analyser reads the
 * tube's barcode. A Zybio Z3 takes an id typed at the keypad. An EL-120 knows only a sequence
 * number and needs a run sheet built by scanning. An ELISA reader knows only a WELL and needs a
 * plate map. Everything else about the interface — the block splitting, the parking, the rerun rule
 * — falls out of which of those four applies.
 *
 * `connection` is documentation and nothing reads it. RS-232 versus HL7-over-LAN is the bridge's
 * problem (D1: the bridge is out of this repository), and a column the server branches on would be
 * a lie about where that decision is made.
 */
export const labInstruments = pgTable(
  "lab_instruments",
  {
    id: text("id").primaryKey(),
    /** The machine as a resource. ONE instrument row per resource, enforced below. */
    resourceId: text("resource_id").notNull().references(() => resources.id),
    sampleIdMode: text("sample_id_mode").notNull(),
    /** Free text, for a human reading the register. Nothing branches on it — see the header. */
    connection: text("connection"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    /**
     * TWO instrument rows against one machine would give it two code maps and two sample-id modes,
     * and an ingest resolving through "the" instrument would pick by row order. The machine is the
     * identity; this table is an attribute of it.
     */
    uniqueIndex("lab_instruments_resource_ux").on(t.resourceId),
    check(
      "lab_instruments_sample_id_mode_ck",
      sql`${t.sampleIdMode} in ('barcode', 'typed_id', 'run_sheet', 'plate_map')`,
    ),
  ],
);

/**
 * ═══ EACH INSTRUMENT'S OWN TEST CODES, MAPPED ONCE, PER INSTRUMENT ═══
 *
 * The board's rule: *"Codes and units are mapped once. Each instrument's test code and unit map to
 * ours PER INSTRUMENT."* Not globally — a global table would become ambiguous the day two machines
 * use the same word for different tests, which is the ordinary case rather than the exotic one
 * (`GLU` is a serum glucose on the chemistry analyser and a urine strip pad on the U120).
 *
 * `factor` converts the instrument's unit to ours, applied once at attachment. An unmapped code
 * PARKS the result rather than guessing (D4), so this table's absences are as load-bearing as its
 * rows.
 */
export const labInstrumentCodes = pgTable(
  "lab_instrument_codes",
  {
    instrumentId: text("instrument_id").notNull().references(() => labInstruments.id),
    /** The string the machine sends, verbatim and case-sensitive — it is the machine's word. */
    instrumentCode: text("instrument_code").notNull(),
    analyteId: text("analyte_id").notNull().references(() => labAnalytes.id),
    /** The instrument's unit, for the record. OUR unit is the analyte's. */
    unit: text("unit"),
    factor: numeric("factor", { precision: 14, scale: 6 }).notNull().default("1"),
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.instrumentCode] }),
    index("lab_instrument_codes_analyte_idx").on(t.analyteId),
    /**
     * A FACTOR OF ZERO IS THE QUIET CATASTROPHE this check exists for: it does not fail, it reports
     * every value on that channel as 0 — a plausible-looking potassium of zero on a live patient.
     * Negative is refused for the same reason a concentration cannot be negative.
     */
    check("lab_instrument_codes_factor_ck", sql`${t.factor} > 0`),
  ],
);
