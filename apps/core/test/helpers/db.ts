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

/**
 * Any constant works: an advisory lock is scoped to the database it is taken in, so every worker DB
 * has its own. Only `migrateTestDb` takes it.
 */
const MIGRATE_LOCK_KEY = 7_402_2026;

/** `TEST_DATABASE_URL`'s database name plus `_<workerId>`, the per-worker DB naming lanes rely on. */
function workerDbUrls(workerId: string): { maintenanceUrl: string; workerDbName: string; workerUrl: string } {
  const parsed = new URL(requireEnv("TEST_DATABASE_URL"));
  const baseDbName = parsed.pathname.replace(/^\//, "");
  const workerDbName = `${baseDbName}_${workerId}`;
  const maintenanceUrl = new URL(parsed.toString());
  maintenanceUrl.pathname = "/postgres";
  const workerUrl = new URL(parsed.toString());
  workerUrl.pathname = `/${workerDbName}`;
  return { maintenanceUrl: maintenanceUrl.toString(), workerDbName, workerUrl: workerUrl.toString() };
}

/**
 * Migrates a worker DB, holding a session advisory lock in THAT database for the whole run.
 *
 * WHY THE LOCK (CI run 36750365736, main 4b300060, core shard 1): a cold migrate overran the 15 s
 * `beforeAll` budget. Jest abandons a timed-out hook but cannot stop it, so the orphaned migrate kept
 * running while the worker's NEXT suite started a second migrate on the same `<db>_<id>`. Both issued
 * the same CREATE TYPE and one died on `pg_type_typname_nsp_index`, which failed 6 suites and 115 tests
 * that had nothing wrong with them. With the lock, the second caller waits, and drizzle then skips
 * every migration the first one applied.
 */
async function migrateTestDb(db: Db, pool: Pool): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    try {
      await migrate(db, { migrationsFolder: "./drizzle" });
    } finally {
      await lockClient.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

/**
 * Creates and migrates worker DB `<db>_<workerId>`. `test/helpers/global-setup.ts` calls this for every
 * worker id before the first suite starts, so the cold migrate (165+ migrations) is paid outside any
 * hook timeout, and `setupTestDb`'s own migrate is a no-op check.
 */
export async function prepareWorkerDb(workerId: string): Promise<void> {
  const { maintenanceUrl, workerDbName, workerUrl } = workerDbUrls(workerId);
  await ensureWorkerDatabaseExists(maintenanceUrl, workerDbName);
  const { db, pool } = createDb(workerUrl);
  try {
    await migrateTestDb(db, pool);
  } finally {
    await pool.end();
  }
}

export async function setupTestDb(): Promise<{ db: Db; pool: Pool; teardown(): Promise<void> }> {
  const workerId = process.env.JEST_WORKER_ID ?? "1";
  const { maintenanceUrl, workerDbName, workerUrl } = workerDbUrls(workerId);
  await ensureWorkerDatabaseExists(maintenanceUrl, workerDbName);

  const { db, pool } = createDb(workerUrl);
  await migrateTestDb(db, pool);
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
