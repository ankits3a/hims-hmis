import {
  bigint, bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

// PLAN 11c — the six OPERATIONS tables: what mode the hospital is in, what the go-live gate last
// said, whether the devices are alive, and which paper serials were handed out when the screens
// went dark. One file, because the four concerns share exactly one property that matters: they
// must all still work when the rest of the platform does not.
//
// TWO CONVENTIONS ARE TRANSCRIBED HERE RATHER THAN ASSUMED, because getting either wrong is
// silent:
//
//   1. ORDERING RIDES A `bigserial seq`, NEVER `id` AND NEVER A TIMESTAMP (§3.26 / audit A1).
//      `newId()` is a plain `ulid()` — 80 bits of fresh randomness — so two ids minted in the
//      same millisecond sort by coin flip, and a mode declared twice inside one tick would read
//      back in the wrong order. Every table below that anything will ever list or take the
//      "latest" of carries a `seq`; `downtime_form_counters` does not, because it is a keyed
//      counter with one row per form kind and no order at all.
//
//   2. ACTOR REFERENCES ARE PLAIN TEXT, NOT FOREIGN KEYS — `events.actor_id` and
//      `retention_legal_holds.created_by` are the shipped precedent (the approvals.ts
//      convention). This is load-bearing for the test helper, not stylistic: Postgres refuses to
//      TRUNCATE a table any FK still POINTS AT — constraint EXISTENCE, never row counts and
//      never statement order (§3.35) — so an FK into `users` here would drag all six of these
//      names into the users-group truncate statement. The one FK this file declares is
//      `downtime_kit_ranges → downtime_kits`, and by §3.12 those two share ONE statement in
//      `test/helpers/db.ts`.

/**
 * The five operating modes (D1) — E-10's commissioning/ramp flag and map 1's downtime, one enum.
 *
 * It lives HERE, beside the columns whose domain it is, rather than in `kernel/ops/mode.ts`:
 * `kernel/ops/events.ts` needs it for `ops.mode_changed`'s payload schema and `mode.ts` needs it
 * for the transition matrix, and mode.ts already imports events.ts. Putting the constant in
 * either of those makes the two files import each other.
 *
 * `commissioning` is FIRST on purpose: it is what zero rows read as, and what a freshly-migrated
 * deployment IS until D-17's gate passes.
 */
export const OPERATING_MODES = ["commissioning", "ramp", "normal", "degraded", "downtime"] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

/**
 * THE MODE IS AN APPEND-ONLY LEDGER, NOT A ROW SOMEBODY UPDATES (D1). Current mode = the row with
 * the highest `seq`; history therefore comes free and cannot be edited away, which is the whole
 * point for a value that will be quoted back in an incident review.
 *
 * `report_id` is PLAIN TEXT rather than an FK into `config_validation_reports`, following the
 * house convention for a cross-concern reference (`invoices.encounter_id`,
 * `invoices.credit_approval_id`). It records WHICH validation report authorised leaving
 * commissioning — `changeOperatingMode` fills it from the report its own guard read, never from
 * the caller, so the row cannot claim an authorisation that never happened.
 */
export const operatingModeChanges = pgTable(
  "operating_mode_changes",
  {
    id: text("id").primaryKey(), // ULID via newId()
    // THE ORDERING COLUMN. `getOperatingMode` is one `ORDER BY seq DESC LIMIT 1` and nothing else.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    fromMode: text("from_mode").notNull(), // the mode being left; the first ever row leaves `commissioning`
    toMode: text("to_mode").notNull(),
    note: text("note"), // mandatory entering downtime/degraded (D2), null otherwise
    reportId: text("report_id"), // the config_validation_reports row the commissioning exit rode
    actorId: text("actor_id").notNull(), // plain text — the approvals.ts precedent, see the header
    at: timestamp("at", { withTimezone: true }).notNull(), // the injected `now`, never the wall clock
  },
  (t) => [index("operating_mode_changes_seq_idx").on(t.seq)],
);

/**
 * D-17's aggregate verdict, PERSISTED (D5). The commissioning exit reads the LATEST row of this
 * table by `seq` — not a value in memory, not any older ok row — which is what stops the go-live
 * gate from being a script nobody is forced to run.
 *
 * `scopes` is the per-validator detail as JSONB (`{ tariff: {...}, billing: {...} }`); `ok` is the
 * conjunction over all of them, denormalised so the guard is one indexed read rather than a JSON
 * traversal.
 */
export const configValidationReports = pgTable(
  "config_validation_reports",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    ok: boolean("ok").notNull(),
    scopes: jsonb("scopes").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("config_validation_reports_seq_idx").on(t.seq)],
);

/**
 * §11.14's interface heartbeat registry (D6). `status` is a COLUMN, not a workflow instance:
 * device liveness is monitoring state, not an SLA-bearing work lifecycle — the same §10.2
 * reasoning D2 records for the mode itself.
 *
 * `stale_after_ms` is PER DEVICE because a label printer and a lab analyser do not go quiet on
 * the same schedule; the sweep compares each row against its own column, never a global constant.
 * `last_seen_at` NULL means NEVER SEEN, and that is a distinct state from `down`: a device that
 * has never reported has nothing to lose and downing it would be noise (D6 / Book V10).
 */
export const interfaces = pgTable(
  "interfaces",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(), // listing order — never ORDER BY id
    kind: text("kind").notNull(), // printer | scanner | other
    name: text("name").notNull(),
    location: text("location"),
    staleAfterMs: integer("stale_after_ms").notNull().default(180_000),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }), // null = never seen
    status: text("status").notNull().default("unknown"), // unknown | up | down
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interfaces_status_active_idx").on(t.status, t.active)],
);

/**
 * A downtime kit: one generation event, one desk set, one bundle of paper (D7). The kit is the
 * unit a duty manager hands over and later reconciles against.
 */
export const downtimeKits = pgTable(
  "downtime_kits",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(), // newest-first listing order
    note: text("note"),
    generatedBy: text("generated_by").notNull(), // actor id, plain text — see the header
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("downtime_kits_seq_idx").on(t.seq)],
);

/**
 * THE ONE FOREIGN KEY IN THIS FILE, and it is deliberate: a range that names a kit which does not
 * exist is paper nobody can reconcile, which is the exact failure the serials exist to prevent.
 * By §3.12 this table therefore shares `downtime_kits`' truncate statement.
 *
 * Serials are a RECONCILIATION KEY, NOT A DOCUMENT NUMBER (D7) — recovery backfills real invoices
 * with real, per-FY, GST-consecutive numbers from billing's own `document_series`, which this
 * table never touches. `[start_serial, end_serial]` is inclusive.
 */
export const downtimeKitRanges = pgTable(
  "downtime_kit_ranges",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    kitId: text("kit_id").notNull().references(() => downtimeKits.id),
    desk: text("desk").notNull(),
    formKind: text("form_kind").notNull(), // registration | consultation | receipt
    startSerial: bigint("start_serial", { mode: "number" }).notNull(),
    endSerial: bigint("end_serial", { mode: "number" }).notNull(), // inclusive
  },
  (t) => [
    uniqueIndex("downtime_kit_ranges_kit_desk_kind_ux").on(t.kitId, t.desk, t.formKind),
    index("downtime_kit_ranges_kit_idx").on(t.kitId),
  ],
);

/**
 * The kit's OWN counters — billing's `document_series` is never touched (D7). One row per form
 * kind, advanced by a single-winner `UPDATE … RETURNING` (the OPD token / document-series
 * precedent), which is what makes concurrent generations yield DISJOINT ranges.
 *
 * A `bigserial` cannot serve here for the same reason it cannot serve `document_series`: the
 * allocation must be readable and settable as data, and a generation reserves a BLOCK at a time
 * rather than a row at a time.
 */
export const downtimeFormCounters = pgTable("downtime_form_counters", {
  formKind: text("form_kind").primaryKey(),
  nextSerial: bigint("next_serial", { mode: "number" }).notNull().default(1),
});
