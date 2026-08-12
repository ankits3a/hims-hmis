import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule, DB_POOL } from "../src/app.module";
import { setupTestDb } from "./helpers/db";
import { requireEnv } from "../src/kernel/config";

describe("GET /health", () => {
  let app: INestApplication;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    // AuthModule.onModuleInit mirrors the registry into `permissions` at boot, so the
    // app needs a migrated database: use this worker's migrated DB, as the other e2es do.
    ({ teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    try { await app.close(); } catch { /* already closed by the pool test */ }
    await teardown();
  });

  it("reports ok with db connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });

  it("closes the pg pool when the app closes", async () => {
    const pool = app.get<Pool>(DB_POOL);
    await app.close();
    // pg rejects any use after end() with exactly this error — proves end() ran.
    // (Do NOT assert on pool.ended: the runtime property exists but is absent from @types/pg.)
    await expect(pool.query("select 1")).rejects.toThrow(/after calling end/i);
  });
});
