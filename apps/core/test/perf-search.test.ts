import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { registrationConfig } from "../src/kernel/db/schema";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { searchAll } from "../src/kernel/search/registry";
import { parseSearchQuery } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

const SEED_ROWS = 200_000;
const FEDERATED_BUDGET_MS = 300; // §15, and the plan's DD8 contract for the first group

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * THE GATE IS THE FASTEST RUN, for the reason `perf-patient-search.test.ts` records at length:
 * contention only ever ADDS time, so the minimum is the least-noisy estimator of the work the
 * database actually does, while a median carries whatever load the runner was under. Plan 11f
 * retired this suite's last single-sample wall-clock assertion for exactly this reason, and Plan
 * 11h T1 reintroduced one by accident and had to be corrected — see that fix's commit.
 */
function fastest(xs: number[]): number {
  return Math.min(...xs);
}

/** Every "Node Type" in an EXPLAIN (FORMAT JSON) plan tree. */
function nodeTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) nodeTypes(n, out);
  } else if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec["Node Type"] === "string") out.push(rec["Node Type"] as string);
    for (const v of Object.values(rec)) nodeTypes(v, out);
  }
  return out;
}

describe("federated search performance (Plan 11h T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let registry: ModuleRegistry;
  let userId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "perf" });

    registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await createRole(db, "perf_all", "Perf");
    // Everything, so the fan-out actually fans out — a caller holding one permission would time
    // one provider and call it a federated budget.
    for (const p of registry.allPermissions()) await grantPermissionToRole(db, registry, "perf_all", p);
    const u = await createUser(db, { username: "perfuser", fullName: "Perf", password: "correct horse battery" });
    userId = u.id;
    await assignRole(db, { userId, roleKey: "perf_all", scopeType: "hospital" });

    await db.execute(sql`
      insert into patients (id, uhid, name, phone, sex, language, status, created_by, updated_by)
      select
        'PERF' || lpad(gs::text, 22, '0'),
        'PRF' || lpad(gs::text, 7, '0') || '0',
        'Perf Patient ' || gs::text,
        '9' || lpad((100000000 + gs)::text, 9, '0'),
        'other', 'hi', 'active', 'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(SEED_ROWS))}) gs
    `);
    /**
     * A HANDFUL OF DISTINCTIVE NAMES AMONG THE 200,000, and they are what makes the index
     * assertion meaningful. Every bulk row is "Perf Patient <n>", so a fuzzy query resembling THAT
     * matches essentially the whole table and a Seq Scan is genuinely the cheaper plan — the
     * planner is right and the test would be measuring nothing. A real desk searches for one
     * person among many, which is the selectivity a trigram index exists to serve.
     */
    await db.execute(sql`
      insert into patients (id, uhid, name, phone, sex, language, status, created_by, updated_by)
      values
        ('PERFNAME0000000000000001', 'PRF90000010', 'Zephyrine Qadir', '9200000001', 'other', 'hi', 'active', 'perf-seed', 'perf-seed'),
        ('PERFNAME0000000000000002', 'PRF90000020', 'Anantharaman Balasubramanian', '9200000002', 'other', 'hi', 'active', 'perf-seed', 'perf-seed')
    `);
    await db.execute(sql`analyze patients`);
    await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("9100050", 20)); // warm
  }, 180_000);

  afterAll(async () => {
    await truncateAll(db); // never leave 200k rows for the next suite's truncate to pay for
    await teardown();
  });

  it(`the federated fan-out is under ${FEDERATED_BUDGET_MS} ms at ${SEED_ROWS} rows`, async () => {
    const queries = ["9100050", "9100123", "9100199", "9100001", "9100175"];
    const times: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery(q, 20));
      times.push(performance.now() - t0);
      expect(res.groups.some((g) => g.hits.length > 0)).toBe(true);
      // A provider that quietly timed out would make this budget meaningless.
      expect(res.groups.every((g) => !g.timedOut && !g.errored)).toBe(true);
    }
    console.log(`federated timings ms: ${times.map((t) => t.toFixed(1)).join(", ")} (median ${median(times).toFixed(1)}, fastest ${fastest(times).toFixed(1)})`);
    expect(fastest(times)).toBeLessThan(FEDERATED_BUDGET_MS);
  });

  it("THE TRIGRAM INDEX IS ACTUALLY USED — a fuzzy match must not be a sequential scan", async () => {
    /**
     * The assertion migration 0021's own comment asks for. A GIN index that Postgres declines to
     * use is invisible: the query still returns the right rows, just by reading 200,000 of them,
     * and nothing fails until a desk waits four seconds. This reads the PLAN rather than the clock,
     * so it cannot be passed by a fast machine.
     */
    const plan = await db.execute(sql`
      explain (format json)
      select id from patients
      where status = 'active'
        and lower(name) % 'zephyrin qadr'
        and similarity(lower(name), 'zephyrin qadr') > 0.3
      limit 5
    `);
    const types = nodeTypes((plan as unknown as { rows: unknown[] }).rows ?? plan);
    expect(types.join(",")).toMatch(/Bitmap Index Scan|Index Scan/);
    expect(types).not.toContain("Seq Scan");
  });

  it("the server's similarity threshold is at its default, so the code's 0.3 is the effective bar", async () => {
    // `%` honours the GUC and the code pins 0.3 explicitly, so the effective threshold is
    // max(GUC, 0.3). They coincide only while the server is at its default — and a server raising
    // it would make patients quietly harder to find, which is the kind of change that should fail
    // a test rather than surface as a complaint from a desk.
    const shown = await db.execute(sql`show pg_trgm.similarity_threshold`);
    const rows = (shown as unknown as { rows: Record<string, string>[] }).rows ?? [];
    expect(Number(Object.values(rows[0] ?? {})[0])).toBeCloseTo(0.3, 5);
  });
});
