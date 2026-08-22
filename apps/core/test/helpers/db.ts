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
  await db.execute(
    sql`truncate table retention_legal_holds, notifications, opd_prescriptions, opd_vitals, opd_queue_entries, opd_encounters, opd_appointments,
        opd_queue_sessions, opd_doctor_leaves, opd_doctor_schedules, opd_doctors, opd_rooms, opd_departments,
        opd_config, allocations, receipt_tenders, receipts, credit_note_lines, credit_notes, invoice_lines,
        invoices, refund_vouchers, cashier_sessions, entered_in_error_marks, recon_batches, daily_closes,
        idempotency_keys, document_series, billing_config, patient_merge_requests, patient_guardians, patient_allergies,
        patient_photos, patients, registration_config`,
  );
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
