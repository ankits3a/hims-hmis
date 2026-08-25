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
    sql`truncate table notifications, alerts, break_glass_grants, temp_role_grants, user_totp, auth_sessions,
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
  // NO `restart identity`, deliberately. This statement has never carried one, the billing tables
  // in it have `seq` bigserials of their own, and adding it now would silently change what every
  // shipped test reading a billing `seq` observes. Plan 09's own tests assert seq ORDER, not seq
  // VALUES, which is what makes that safe rather than merely convenient.
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
        opd_queue_sessions, opd_doctor_leaves, opd_doctor_schedules, opd_doctors, opd_rooms, opd_departments,
        opd_config, allocations, receipt_tenders, receipts, credit_note_lines, credit_notes, invoice_lines,
        invoices, refund_vouchers, cashier_sessions, entered_in_error_marks, recon_batches, daily_closes,
        idempotency_keys, document_series, billing_config, patient_merge_requests, patient_guardians, patient_allergies,
        patient_photos, patients, registration_config`,
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
  await db.execute(
    sql`truncate table tariff_items, regulated_prices, adjustment_rules, gst_config, gst_settings,
        tariff_versions, services`,
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
