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
  await db.execute(
    sql`truncate table alerts, break_glass_grants, temp_role_grants, user_totp, auth_sessions,
        role_assignments, role_permissions, agents, sod_pairs, permissions, roles, users`,
  );
  await db.execute(
    sql`truncate table opd_prescriptions, opd_vitals, opd_queue_entries, opd_encounters, opd_appointments,
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
}
