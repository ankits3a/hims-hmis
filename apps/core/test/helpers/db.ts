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
  await db.execute(sql`truncate table events restart identity`);
  await db.execute(sql`truncate table event_cursors`);
  await db.execute(sql`truncate table event_idempotency`);
  await db.execute(
    sql`truncate table workflow_timers, workflow_transitions, workflow_instances,
        workflow_definition_approvals, workflow_definitions`,
  );
  await db.execute(
    sql`truncate table break_glass_grants, temp_role_grants, user_totp, auth_sessions,
        role_assignments, role_permissions, agents, sod_pairs, permissions, roles, users`,
  );
}
