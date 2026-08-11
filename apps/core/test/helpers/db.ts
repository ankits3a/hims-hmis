import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDb, Db } from "../../src/kernel/db/client";
import type { Pool } from "pg";

export async function setupTestDb(): Promise<{ db: Db; pool: Pool; teardown(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_test";
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db, pool, teardown: async () => { await pool.end(); } };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table events restart identity`);
}
