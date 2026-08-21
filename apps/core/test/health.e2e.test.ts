import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule, DB_POOL } from "../src/app.module";
import { setupTestDb } from "./helpers/db";
import { requireEnv } from "../src/kernel/config";
import { schedulerHeartbeats } from "../src/kernel/db/schema/worker";
import type { Db } from "../src/kernel/db/client";

describe("GET /health", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    // AuthModule.onModuleInit mirrors the registry into `permissions` at boot, so the
    // app needs a migrated database: use this worker's migrated DB, as the other e2es do.
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  // The worker field is decided entirely by the heartbeat rows, so start every test from none.
  // (This suite deliberately does not truncateAll: the app's boot-time permission mirror is live.)
  beforeEach(async () => { await db.delete(schedulerHeartbeats); });
  afterAll(async () => {
    try { await app.close(); } catch { /* already closed by the pool test */ }
    await teardown();
  });

  it("reports ok with db connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", db: "ok", worker: "not_running" });
  });

  // L16. WORKER_STALE_AFTER_MS defaults to 60 000 (D9), and the AGED ROW is the fixture field
  // that makes staleness appear (§3.14): without a heartbeat older than that window nothing
  // here could separate a correct reader from a broken one.
  it("reports the worker not_running, then stale (degraded), then ok as heartbeats arrive", async () => {
    // Zero rows is NOT a fault: a deployment without a worker is not something the API can
    // diagnose, so the status stays ok.
    const notRunning = await request(app.getHttpServer()).get("/health").expect(200);
    expect(notRunning.body).toEqual({ status: "ok", db: "ok", worker: "not_running" });

    await db.insert(schedulerHeartbeats).values({
      job: "runDispatchCycle",
      lastStartedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min back, against a 60 s window
    });
    const stale = await request(app.getHttpServer()).get("/health").expect(200);
    expect(stale.body).toEqual({ status: "degraded", db: "ok", worker: "stale" });

    // A second, FRESH job leaves the aged row in place: the freshest heartbeat decides.
    await db.insert(schedulerHeartbeats).values({ job: "runDueTimers", lastStartedAt: new Date() });
    const ok = await request(app.getHttpServer()).get("/health").expect(200);
    expect(ok.body).toEqual({ status: "ok", db: "ok", worker: "ok" });
    expect(await db.select().from(schedulerHeartbeats).where(eq(schedulerHeartbeats.job, "runDispatchCycle")))
      .toHaveLength(1);

    // Never "down", in ANY worker state: the worker is never load-bearing for a human flow
    // (Global Constraint 1), so it can only ever degrade this endpoint.
    for (const res of [notRunning, stale, ok]) {
      expect(res.body.status).not.toBe("down");
    }
  });

  it("closes the pg pool when the app closes", async () => {
    const pool = app.get<Pool>(DB_POOL);
    await app.close();
    // pg rejects any use after end() with exactly this error — proves end() ran.
    // (Do NOT assert on pool.ended: the runtime property exists but is absent from @types/pg.)
    await expect(pool.query("select 1")).rejects.toThrow(/after calling end/i);
  });
});
