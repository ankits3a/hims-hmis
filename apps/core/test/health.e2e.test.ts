import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { requireEnv } from "../src/kernel/config";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = requireEnv("TEST_DATABASE_URL");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("reports ok with db connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });
});
