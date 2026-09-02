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

/**
 * Empties every table a test can have dirtied — WITHOUT a hand-maintained table list.
 *
 * HISTORY. Until 2026-09-02 this function was ~350 lines: thirty hand-ordered `truncate`
 * statements grouped by foreign-key constraint, with a paragraph per group explaining why each
 * name had to sit in that exact statement. Every plan that added a table edited it (15 edits in
 * the last 400 commits), and a missed name failed with `cannot truncate a table referenced in a
 * foreign key constraint` at the first `beforeEach` of an unrelated suite.
 *
 * MEASURED 2026-09-02 on the build host against a freshly migrated scratch database (162 tables):
 *   hand-listed version, 30 statements ........ ~1,020 ms per call
 *   one statement naming all 157 parents ...... ~800 ms per call
 *   catalog scan for NON-EMPTY tables ......... ~15 ms, then truncate only those
 * Postgres pays TRUNCATE per relation (new relfilenode + fsync) whether or not it holds rows, and
 * this runs in `beforeEach` — ~3,000 times per full suite, so the old cost was ~50 minutes of
 * the run. A test dirties a handful of tables; that is all this truncates.
 *
 * SEMANTICS KEPT. `cascade` reaches every FK dependant, which is what the hand-built groups
 * were reproducing by hand. Partitions are excluded from the list — truncating the partitioned
 * parent (`events`) empties them, as `kernel/worker/partitions.test.ts` asserts. Every `seq`
 * bigserial in `public` is reset on every call, uniformly: the old code reset some groups and
 * deliberately not others, and its own comments record that shipped tests assert seq ORDER,
 * never seq VALUES, which is exactly what makes a uniform reset safe. The drizzle migrations
 * table lives in its own schema and is never touched.
 */
const baseTablesByDb = new WeakMap<Db, Promise<string[]>>();

function baseTables(db: Db): Promise<string[]> {
  let cached = baseTablesByDb.get(db);
  if (!cached) {
    cached = db
      .execute(
        sql`select c.relname as name
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relkind in ('r', 'p')
               and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
             order by c.relname`,
      )
      .then((r) => (r.rows as { name: string }[]).map((row) => row.name));
    baseTablesByDb.set(db, cached);
  }
  return cached;
}

export async function truncateAll(db: Db): Promise<void> {
  const tables = await baseTables(db);
  const scan = tables
    .map((t) => `select '${t}' as t where exists (select 1 from "${t}" limit 1)`)
    .join(" union all ");
  const dirty = (await db.execute(sql.raw(scan))).rows.map((row) => (row as { t: string }).t);
  if (dirty.length > 0) {
    await db.execute(sql.raw(`truncate table ${dirty.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
  }
  // Only sequences OWNED BY a column (the `seq` bigserials) are reset. A standalone sequence such
  // as `uhid_seq` is a business counter a migration positioned deliberately (above the reserved
  // UHID band) — the old hand list never touched those, and resetting one halts registration.
  await db.execute(
    sql`select setval(s.oid, 1, false)
          from pg_class s
          join pg_depend d on d.objid = s.oid and d.deptype = 'a'
          join pg_sequences ps on ps.schemaname = 'public' and ps.sequencename = s.relname
         where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace
           and ps.last_value is not null`,
  );
}
