import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule, DB_POOL } from "../src/app.module";
import { requireEnv } from "../src/kernel/config";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = requireEnv("TEST_DATABASE_URL");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { try { await app.close(); } catch { /* already closed by the pool test */ } });

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
