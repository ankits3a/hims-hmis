import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { createDb, Db } from "../../src/kernel/db/client";
import { requireEnv } from "../../src/kernel/config";

const DUPLICATE_DATABASE = "42P04";

function isDuplicateDatabaseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === DUPLICATE_DATABASE;
}

async function ensureWorkerDatabaseExists(maintenanceUrl: string, workerDbName: string): Promise<void> {
  const maintenancePool = new Pool({ connectionString: maintenanceUrl });
  try {
    const existing = await maintenancePool.query("select 1 from pg_database where datname = $1", [workerDbName]);
    if (existing.rowCount === 0) {
      try {
        await maintenancePool.query(`create database "${workerDbName}"`);
      } catch (error) {
        if (!isDuplicateDatabaseError(error)) {
          throw error;
        }
      }
    }
  } finally {
    await maintenancePool.end();
  }
}

export async function setupTestDb(): Promise<{ db: Db; pool: Pool; teardown(): Promise<void> }> {
  const baseUrl = requireEnv("TEST_DATABASE_URL");
  const workerId = process.env.JEST_WORKER_ID ?? "1";

  const parsed = new URL(baseUrl);
  const baseDbName = parsed.pathname.replace(/^\//, "");
  const workerDbName = `${baseDbName}_${workerId}`;

  const maintenanceUrl = new URL(parsed.toString());
  maintenanceUrl.pathname = "/postgres";
  await ensureWorkerDatabaseExists(maintenanceUrl.toString(), workerDbName);

  const workerUrl = new URL(parsed.toString());
  workerUrl.pathname = `/${workerDbName}`;

  const { db, pool } = createDb(workerUrl.toString());
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db, pool, teardown: async () => { await pool.end(); } };
}

export async function truncateAll(db: Db): Promise<void> {
  // event_deliveries and event_dead_letters ride the EVENTS statement. No FK forces it — they
  // reference nothing (the trade recorded in schema/worker.ts) — but `restart identity` resets
  // events.seq, and a stale claim row against a reset sequence would silently SUPPRESS
  // deliveries in the next test: the dispatcher would read seq 1 back, LEFT-JOIN a leftover
  // `done` claim, and drop the row with no error anywhere. Same statement, by design.
  //
  // `events` IS PARTITIONED since migration 0016 and this statement is UNCHANGED, deliberately:
  // TRUNCATE on a partitioned PARENT empties every partition, and `restart identity` still finds
  // `events_seq_seq` because 0016 runs `ALTER SEQUENCE … OWNED BY events.seq` on the new parent
  // before dropping the old table. Both halves are asserted by execution in
  // `kernel/worker/partitions.test.ts` rather than assumed here.
  await db.execute(sql`truncate table events, event_deliveries, event_dead_letters restart identity`);
  await db.execute(sql`truncate table event_cursors`);
  await db.execute(sql`truncate table event_idempotency`);
  // No FK and no coupling to any other group: its own statement.
  await db.execute(sql`truncate table scheduler_heartbeats`);
  // PLAN 11g / DD4 — `auth_throttle` is keyed on the SUBMITTED username, deliberately not on
  // `users.id`, so it holds no FK in either direction and by §3.35/§3.12 has no claim on any
  // existing group's statement. Its own, therefore — and it MUST be here: a leftover backoff row
  // from one test would 429 the next test's perfectly good login.
  await db.execute(sql`truncate table auth_throttle`);
  // PLAN 11h T5 — `search_audit` holds NO foreign key in either direction (its `actor_id` is plain
  // text, deliberately — see schema/search.ts), so by §3.35/§3.12 it has no claim on any existing
  // group's statement and takes its own. It MUST be here: a leftover audit row from one test makes
  // the next test's "exactly one row was written" assertion read two.
  await db.execute(sql`truncate table search_audit`);
  // PLAN 07a T2 — `phi_access_log`, for exactly the reason above and by the same rules. Its
  // `actor_id`, `patient_id` and `encounter_id` are all plain text with NO foreign key in either
  // direction (schema/phi-access.ts: an audit log must outlive the record it describes), so it has
  // no claim on any existing group's statement and takes its own. It MUST be here: a leftover row
  // from one test makes the next test's "exactly one access was recorded" assertion read two.
  await db.execute(sql`truncate table phi_access_log`);
  /**
   * PLAN 07c T8 — `user_day_facts`, and it is here because a suite CAUGHT its absence rather than
   * because the rule was remembered.
   *
   * It is a per-user daily CACHE with no foreign key in either direction (schema/desk.ts: it is
   * rebuildable from the primary tables, so an FK would couple a projection to their lifecycle), so
   * by §3.35/§3.12 it has no claim on any existing group's statement and takes its own.
   *
   * The failure it prevents was observed, not predicted: the rollup suite's "the nightly roll never
   * writes today" assertion came back with 26 rows spanning four dates, because three earlier tests
   * in the same file had each rolled 2026-08-17 and nothing cleared them. A leftover roll is
   * particularly nasty in this table — it is a CACHE, so a stale row does not look like leftover
   * test data, it looks like an answer.
   */
  await db.execute(sql`truncate table user_day_facts`);
  // The V/A/L/S/R/P daily counters. NO foreign key in either direction — the table is keyed by a
  // series-key STRING and a date, precisely so lab, radiology and pharmacy need no schema change
  // to join the grammar — so by §3.35/§3.12 it has no claim on any existing group's statement and
  // takes its own. It MUST be here, and the failure it prevents is not subtle: a counter left
  // standing from one test makes the next test's first visit `V2608250006` instead of
  // `V2608250001`, which is exactly how this line came to be written.
  await db.execute(sql`truncate table episode_series`);
  // PLAN 16a T1 — the formulary is a CLOSED ISLAND in the FK graph, and that is what makes ONE
  // statement both necessary and sufficient. `formulary_medicine_salts` and `formulary_interactions`
  // point at `formulary_medicines` / `formulary_salts` and at nothing outside the module; NOTHING
  // outside points in, because `formulary_staging.medicine_id` and `formulary_medicines.staging_id`
  // are deliberately plain text rather than a mutual FK pair (schema/formulary.ts says why). So by
  // §3.35 the whole island must ride one statement — constraint EXISTENCE decides — and by §3.12 it
  // makes no claim on the users or patients groups. It MUST be here rather than in the formulary
  // suite alone: a moiety left standing from one test is a moiety the next test's resolver finds.
  //
  // PLAN 14 T1 — **THE FORMULARY IS NO LONGER AN ISLAND, AND ITS STATEMENT HAS MOVED.** The five
  // names above now ride the big `patients`/`opd`/`resources` statement further down this function,
  // and the paragraph there says why. In one sentence: `items.formulary_medicine_id` REFERENCES
  // `formulary_medicines` (Plan 14 DD3), so by the §3.35 rule this comment already states —
  // constraint EXISTENCE decides the group — `items` must be named in any statement that truncates
  // `formulary_medicines`; `items` drags in the other fifteen materials tables; and six of THOSE
  // reference `resources`, which lives in the big statement. The closure of the three former groups
  // is one group. **This is not a preference: `truncate table formulary_medicines, …` without
  // `items` is REFUSED OUTRIGHT by Postgres** — `cannot truncate a table referenced in a foreign
  // key constraint`, a STATIC check that does not care whether `items` holds a single row.
  // Measured on this host before the change, against a two-table scratch pair, rather than assumed.
  await db.execute(sql`truncate table approvals, approval_types`);
  await db.execute(
    sql`truncate table approvals, workflow_timers, workflow_transitions, workflow_instances,
        workflow_definition_approvals, workflow_definitions`,
  );
  // `alerts` joins THIS statement — the same command that truncates `users` — because
  // alerts.user_id references users.id. Two ledger rules, transcribed verbatim:
  //   "Postgres checks whether an FK constraint POINTS AT the table being truncated —
  //    constraint existence, never row counts and never statement order" (§3.35)
  //   "When a plan adds a table that FKs into an existing truncate group, that group's
  //    statement must gain the new table's name; a separate earlier statement does not
  //    satisfy Postgres" (§3.12)
  //
  // `notifications` (Plan 10) is named in TWO statements — this one AND the patients group
  // below — because it FKs into BOTH `users` and `patients`. That is not redundancy: by the
  // two rules above, each group's OWN statement must carry the name, and the second truncate
  // of an already-empty table is a no-op. Precedent: `approvals` sits in two statements above.
  await db.execute(
    // PLAN 18a T1 — `pcpndt_registered_persons.user_id` REFERENCES `users.id`, the only foreign key
    // this phase points at that table, so §3.35/§3.12 put it in THIS statement — and `pcpndt_form_f`
    // comes with it because `pcpndt_form_f.person_id` points AT the person row. The
    // `notifications`/`approvals` precedent of a name in two statements, for the same reason.
    //
    // The registered PERSON is an FK and the registration's IN-CHARGE is deliberately not: the
    // person row answers "may this login acquire this scan" at `startAcquisition`, and a dangling
    // id there is a scan attributed to nobody. The in-charge is a stewardship record, and an FK
    // would turn deactivating a leaver into a foreign-key problem on a statutory row.
    sql`truncate table pcpndt_form_f, pcpndt_registered_persons,
        notifications, alerts, break_glass_grants, temp_role_grants, user_totp, auth_sessions,
        role_assignments, role_permissions, agents, sod_pairs, permissions, roles, users`,
  );
  // `retention_legal_holds` (Plan 11a D6) joins THIS statement and only this one: its single FK
  // is `patient_id → patients.id`, and by the two rules above the group whose table it points at
  // must carry its name. `created_by` is plain actor text (the approvals.ts precedent), so it has
  // no claim on the users statement.
  // ────────────── Plan 09 — SIXTEEN of the seventeen new tables join THIS statement ──────────────
  //
  // §3.12 AND §3.35 APPLIED, AND GETTING IT WRONG IS NOT A FLAKE: it is every suite that touches a
  // patient or an invoice failing with `cannot truncate a table referenced in a foreign key
  // constraint`, from the very first `truncateAll`. The two rules transcribed above hold here
  // unchanged — constraint EXISTENCE decides, never row counts and never statement order, and a
  // table that FKs into an existing group must be named in THAT group's OWN statement.
  //
  // EIGHT of the new tables point straight into this group: `membership_instances`,
  // `covered_members`, `patient_match_queue` and `attribution_ids` at `patients`;
  // `entitlement_movements`, `coupon_redemptions`, `commission_accruals` and
  // `commission_accrual_subjects` at `invoices` / `invoice_lines`.
  //
  // THE OTHER EIGHT ARE DRAGGED IN BY THE SAME RULE ONE HOP OUT, and this is the half that is easy
  // to get wrong: truncating a table requires every table that POINTS AT IT to be in the same
  // statement too. `membership_plans`, `coupon_definitions` and `holder_book_imports` are pointed
  // at by `membership_instances`; `entitlement_counters` by `entitlement_movements`;
  // `counterparties` by almost everything on the partner side; `partner_agreements` by the two
  // accrual tables; and `partner_ref_map` and `receivable_expectations` point at `counterparties`
  // and `attribution_ids`, which are in. The closure is therefore the whole membership + partner
  // graph minus `import_quarantine` — exactly the shape `billing`'s fourteen names took, and for
  // exactly the same reason.
  //
  // PLAN 13 T1 — `resources` and `resource_status_history` join THIS statement now rather than in
  // T6, and joining early is the correct call at BOTH moments rather than a convenience at one.
  // §3.35/§3.12 govern which group a new table joins and 16a's F2 adds the island case: a table
  // absent from this function altogether is NEVER EMPTIED AT ALL, and the suite that discovers it
  // is a later phase's. At T1 `resources` points nowhere and nothing points in — an island, which
  // by F2 would take a statement of its own. But at T6 it becomes the PARENT of
  // `opd_queue_sessions.room_id` and `opd_doctor_schedules.room_id`, and truncating a parent
  // requires every table that points at it in the SAME statement. Putting both names here today
  // costs one edit instead of two and is never wrong in between. They took the place `opd_rooms`
  // held in this statement, which T7 removed in the same commit as `0033`: a table named here after
  // it has been dropped makes EVERY suite throw `relation "opd_rooms" does not exist` on its first
  // `beforeEach` (A13), which is the loudest possible failure and the reason this line is not
  // something a Files list may forget.
  //
  // NO `restart identity`, deliberately. This statement has never carried one, the billing tables
  // in it have `seq` bigserials of their own, and adding it now would silently change what every
  // shipped test reading a billing `seq` observes. Plan 09's own tests assert seq ORDER, not seq
  // VALUES, which is what makes that safe rather than merely convenient.
  //
  // ─────────────────── PLAN 14 T1 — SIXTEEN MATERIALS TABLES, AND THE FORMULARY WITH THEM ────
  //
  // **The plan said fifteen tables joined this statement. It is SIXTEEN, and the formulary's five
  // come too — both corrections are recorded as findings F1 and F2 in the phase document's CLOSE
  // rather than made silently**, because 16a's F2 is exactly the rule that a table absent from this
  // function is NEVER EMPTIED AT ALL and the suite that discovers it belongs to a later phase.
  //
  // WHY THEY ARE HERE AND NOT IN A STATEMENT OF THEIR OWN, which is the §3.35 question this file
  // asks of every new table. Six materials tables reference `resources` — `stock_ledger`,
  // `stock_balances`, `stock_reservations`, `consignment_lots`, `grns` and `transfers` (twice) —
  // because every stock location IS a registry resource of kind `store` (DD2). Truncating a parent
  // requires every table that points at it in the SAME statement, so `resources` and these six
  // cannot be separated. The other ten ride in by the same rule one hop further: `items` is pointed
  // at by `item_uoms`, `item_barcodes`, `item_price_regulations`, `stock_batches`, `stock_ledger`,
  // `stock_balances`, `grn_lines` and `consignment_lots`; `vendors` by `vendor_documents`,
  // `vendor_bank_changes`, `stock_batches`, `consignment_lots` and `grns`; `stock_batches` by six of
  // them; `transfers` by `transfer_lines` and `grns` by `grn_lines`.
  //
  // AND THE FORMULARY'S FIVE, WHICH IS THE HALF THE PLAN DID NOT SEE (F1). `items.formulary_medicine_id`
  // references `formulary_medicines` (DD3), so `formulary_medicines` acquired an inbound FK from
  // outside its own island for the first time and its private statement — which stood, correctly,
  // from 16a T1 until this commit — became one Postgres refuses to run. The closure of
  // {formulary island} ∪ {materials} ∪ {resources group} is a single group, and one group is one
  // statement.
  //
  // ───────────────────── PLAN 15 T1 — THE TWELVE MINI-OT TABLES JOIN THIS STATEMENT ────────────
  //
  // Same two rules, third phase running: §3.35 (constraint EXISTENCE decides the group, never row
  // counts and never statement order) and §3.12 (the group's OWN statement must carry the name).
  //
  // `daycare_encounters`, `ot_cases` and `ot_specimens` reference `patients.id`; `ot_cases`,
  // `ot_lists`, `pacu_scores` and `daycare_encounters.bay_resource_id` reference `resources.id`.
  // Both parents are in this statement, so all twelve must be too — and the other eight are dragged
  // in one hop by the same rule: `ot_case_gates`, `ot_checklist_runs`, `ot_counts`,
  // `ot_case_implants`, `ot_specimens`, `pacu_scores` and `ot_incidents` point at `ot_cases`, and
  // `ot_deposit_holds`, `ot_case_implants`, `ot_specimens`, `pacu_scores` and `ot_incidents` point
  // at `daycare_encounters`.
  //
  // NO materials table is dragged in by them, and that is DD9's plain-text ruling paying for
  // itself: `ot_case_implants.item_id / batch_id / lot_id` are plain text with no FK (the
  // `schema/billing.ts` cross-module precedent), so this family adds nothing to the materials
  // closure it sits beside.
  //
  // AND THE `users` STATEMENT NEEDS NO CHANGE: every actor column here — `created_by`,
  // `updated_by`, `scrub_by`, `circulating_by`, `deployed_by`, `scored_by`, `published_by` — is
  // plain text, the `approvals.ts` precedent, so no FK in these twelve points at `users`.
  //
  // CHILD-BEFORE-PARENT ORDERING IS IRRELEVANT INSIDE ONE `truncate` and the names are nonetheless
  // written child-first, matching the style of every group above it: what Postgres requires is
  // PRESENCE, not order, and writing them in dependency order is how the next reader checks presence
  // without running anything.
  //
  // NO `restart identity` for these either, for the reason the paragraph below gives: `stock_ledger`
  // and `item_price_regulations` carry `seq` bigserials, and this phase's tests assert seq ORDER,
  // never seq VALUES.
  //
  // AND THE `users` STATEMENT ABOVE NEEDS NO CHANGE AT ALL. That is DD17 paying for itself: every
  // actor column in this phase — `coupon_redemptions.actor_id`, `entitlement_movements.actor_id`,
  // `patient_match_queue.resolved_by`, `holder_book_imports.imported_by`,
  // `attribution_ids.issued_by`, `receivable_expectations.updated_by` — is PLAIN TEXT, so no FK
  // anywhere in these seventeen tables points at `users`, and seventeen tables cost that statement
  // nothing.
  await db.execute(
    sql`truncate table patient_match_queue, covered_members, entitlement_movements, entitlement_counters,
        coupon_redemptions, coupon_definitions, membership_instances, membership_plans, holder_book_imports,
        commission_accruals, commission_accrual_subjects, receivable_expectations, partner_ref_map,
        attribution_ids, partner_agreements, counterparties,
        retention_legal_holds, notifications, opd_prescriptions, opd_vitals, opd_queue_entries, opd_encounters, opd_appointments,
        opd_queue_sessions, opd_doctor_leaves, opd_doctor_schedules, opd_doctors, opd_departments,
        grn_lines, grns, transfer_lines, transfers, stock_reservations, stock_balances, stock_ledger,
        consignment_lots, stock_batches, vendor_bank_changes, vendor_documents, vendors,
        item_price_regulations, item_barcodes, item_uoms, items,
        formulary_medicine_salts, formulary_interactions, formulary_medicines, formulary_salts, formulary_staging,
        resource_status_history, resources,
        ot_incidents, ot_deposit_holds, ot_definitions, pacu_scores, ot_specimens, ot_case_implants,
        ot_counts, ot_checklist_runs, ot_case_gates, ot_lists, ot_cases, daycare_encounters,
        imaging_critical_findings, imaging_reports, imaging_bill_decisions, imaging_safety_screenings,
        imaging_studies, pcpndt_form_f, pcpndt_form_f_serials, pcpndt_registered_machines,
        order_item_transitions, order_items, orders,
        lab_sla_breaches, lab_critical_calls, lab_report_deliveries, lab_reports,
        lab_results, lab_specimen_items, lab_specimens, lab_items,
        opd_config, allocations, receipt_tenders, receipts, credit_note_lines, credit_notes, invoice_lines,
        invoices, refund_vouchers, cashier_sessions, entered_in_error_marks, recon_batches, daily_closes,
        idempotency_keys, document_series, billing_config, patient_merge_requests, patient_guardians, patient_allergies,
        patient_photos, patient_identity_versions, patients, registration_config`,
  );
  // PLAN 09 — `import_quarantine` is the SEVENTEENTH table and the only one with no foreign key in
  // either direction: its `batch_id` is plain text because it names a `holder_book_imports.id`
  // today and a partner statement's own reference when T7 lands, and a column that must point at
  // two different parents can carry an FK to neither (see schema/membership.ts). By §3.35/§3.12 it
  // therefore has no claim on any group's statement and takes its own — the `search_audit` and
  // `auth_throttle` precedents above, for the same reason. It MUST be here: a leftover quarantined
  // row from one import test makes the next test's "this drop quarantined exactly two rows"
  // assertion read four.
  await db.execute(sql`truncate table import_quarantine`);
  // ───────── PLAN 17 PHASE 0 T1 — THE ENVELOPE IS NAMED IN **TWO** STATEMENTS, AND MUST BE ─────────
  //
  // §3.35/§3.12, third and fourth application in this file: `orders.patient_id` references
  // `patients.id` (so all three tables join the big statement above, child-first) AND
  // `order_items.service_id` references `services.id` (DD10 — the only tariff link the envelope
  // has), so `order_items` must ALSO be named in the statement that truncates `services`.
  // `order_item_transitions` comes with it because it points at `order_items`.
  //
  // This is the `notifications` precedent, which is named in two statements for exactly this
  // reason — each group's OWN statement must carry the name, and the second truncate of an
  // already-empty table is a no-op. Naming `order_items` only above is REFUSED OUTRIGHT by
  // Postgres here: `cannot truncate a table referenced in a foreign key constraint`, a STATIC
  // check that does not care whether the table holds a single row.
  //
  // `orders` is deliberately NOT in this statement: nothing in the tariff group points at it, and
  // truncating a table requires the tables that POINT AT it, never its own parents.
  //
  // ───────── PLAN 18a T1 — THE STUDY IS NAMED IN **THREE** STATEMENTS, AND MUST BE ─────────
  //
  // §3.35/§3.12 again, and `imaging_studies` is the most connected table this repository has:
  // `patient_id` → `patients`, `order_id`/`order_item_id` → the envelope, `device_resource_id` →
  // `resources` and `invoice_line_id` → `billing.invoice_lines` (all four in the big statement
  // above) AND `service_id` → `services`, which is HERE. So it is named in both, and the four
  // tables that point AT it — reports, screenings, bill decisions, and critical findings via
  // reports — are named wherever it is.
  //
  // The second truncate of an already-empty table is a no-op. A MISSING name is
  // `cannot truncate a table referenced in a foreign key constraint` — a STATIC check that does not
  // care whether either table holds a row, so it breaks every suite in the workspace from the first
  // `truncateAll` rather than leaking one fixture into one test.
  await db.execute(
    sql`truncate table order_item_transitions, order_items,
        imaging_critical_findings, imaging_reports, imaging_bill_decisions,
        imaging_safety_screenings, imaging_studies,
        lab_sla_breaches, lab_critical_calls, lab_report_deliveries, lab_reports,
        lab_results, lab_specimen_items, lab_specimens, lab_items,
        lab_orderable_analytes, lab_reflex_rules, lab_orderables,
        tariff_items, regulated_prices, adjustment_rules, gst_config, gst_settings,
        tariff_versions, services`,
  );
  // ───────── PLAN 18a T1 — the PCPNDT register's own group, and `imaging_definitions` alone ─────────
  //
  // `pcpndt_registrations` is pointed at by the machine and person lists and by nothing else, so the
  // register is its own group — and every table that points into it, transitively, is named here:
  // machines and persons at the registration, serials and forms at the machine, forms at the person.
  //
  // `imaging_definitions` references NOTHING and nothing references it: `approval_id`, `drafted_by`
  // and `published_by` are plain text (the `ot_definitions` precedent), so by §3.35 it has no claim
  // on any group's statement and takes its own — the `search_audit` / `import_quarantine` pattern.
  // It MUST be here: a leftover ACTIVE `study_types` version would make the next suite's
  // `activeDefinition` return a body that test never wrote, and
  // `imaging_definitions_one_active_ux` would refuse that suite's own publish.
  await db.execute(
    sql`truncate table pcpndt_form_f, pcpndt_form_f_serials, pcpndt_registered_machines,
        pcpndt_registered_persons, pcpndt_registrations`,
  );
  await db.execute(sql`truncate table imaging_definitions`);
  // ───────── PLAN 17 T1 — THE ANALYTE ISLAND, AND WHY IT NEEDS ITS OWN STATEMENT ─────────
  //
  // §3.35/§3.12 again, and this is the 16a F2 case rather than the `order_items` one above.
  // `lab_analytes` and `lab_reference_ranges` point at NOTHING that any statement above truncates —
  // the catalogue's measurable quantities are a master of their own — so no group has a claim on
  // them and they take their own statement.
  //
  // The four names that ride WITH them are Postgres's PRESENCE rule, not a second truncate of the
  // same rows: `lab_orderable_analytes`, `lab_results` and `lab_reflex_rules` all carry an
  // `analyte_id` FK, and `lab_critical_calls` points at `lab_results`, so `truncate lab_analytes`
  // is REFUSED OUTRIGHT ("cannot truncate a table referenced in a foreign key constraint") unless
  // every one of them is named in the SAME statement. All four are already empty by the time this
  // runs — the second truncate of an empty table is a no-op, exactly as `notifications` and
  // `order_items` are named twice above for the same reason.
  await db.execute(
    sql`truncate table lab_critical_calls, lab_results, lab_orderable_analytes, lab_reflex_rules,
        lab_reference_ranges, lab_analytes`,
  );
  // ───────────────────────── Plan 11c — the six ops tables, three statements ─────────────────────
  //
  // NONE of them joins a statement above, and that is a property of the SCHEMA rather than an
  // accident: every actor column in `schema/ops.ts` is plain text (`events.actor_id` /
  // `retention_legal_holds.created_by` precedent), so no FK anywhere in this group POINTS AT
  // `users`, `patients` or anything else already truncated. By the two rules transcribed above
  // (§3.35 constraint EXISTENCE, §3.12 the group's OWN statement must carry the name), a table
  // with no inbound FK from an existing group has no claim on that group's statement.
  //
  // The ops group: `operating_mode_changes` carries `report_id` as PLAIN TEXT rather than an FK
  // into `config_validation_reports`, so these two need not share a statement — they do anyway,
  // because they are one concern and `restart identity` on both keeps `seq` comparable between
  // tests that assert ordering.
  await db.execute(sql`truncate table operating_mode_changes, config_validation_reports restart identity`);
  // No FK in either direction: its own statement.
  await db.execute(sql`truncate table interfaces restart identity`);
  // THE KIT GROUP IS ONE STATEMENT AND THE FK RIDES IT (§3.12): `downtime_kit_ranges.kit_id`
  // references `downtime_kits.id`, so truncating `downtime_kits` in a statement that does not
  // also name `downtime_kit_ranges` is refused by Postgres outright. `downtime_form_counters`
  // has no FK at all and joins for cohesion — a kit test that reset the ranges but not the
  // counters would inherit the previous test's serials and its "contiguous, no gap" assertion
  // would be measuring the wrong thing.
  await db.execute(
    sql`truncate table downtime_kit_ranges, downtime_kits, downtime_form_counters restart identity`,
  );
}
