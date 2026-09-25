import { Test } from "@nestjs/testing";
import { Controller, Get, INestApplication, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { Public } from "../src/kernel/auth/decorators";
import { setupTestDb } from "./helpers/db";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * A route that fails the two ways a real handler does — a CODED refusal the app wrote, and an
 * unexpected throw — so the legs below can prove the generic-body filter leaves the app's own
 * errors exactly as they were. `@Public` so no session is needed to reach it.
 */
@Controller("hardening-probe")
class HardeningProbeController {
  @Public()
  @Get("coded-404")
  coded(): never {
    throw new NotFoundException({ code: "thing_not_found", message: "no such thing, and here is why" });
  }

  @Public()
  @Get("boom")
  boom(): never {
    throw new Error("internal detail that must not reach the wire");
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA L-01 + L-09 — WHAT EVERY API RESPONSE SAYS ABOUT CACHING, AND ABOUT ITSELF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Built through `configureApp`, the one place main.ts and every e2e app take their HTTP settings
 * from, so what is asserted here is what production serves.
 */
describe("WASA L-01 / L-09 — HTTP hardening", () => {
  let app: INestApplication;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [HardeningProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  describe("L-01 — no API response may be kept by a shared terminal's browser", () => {
    it("a public 200, a 401 and a 404 all carry Cache-Control: no-store and Pragma: no-cache", async () => {
      for (const path of ["/health", "/auth/me", "/no-such-route"]) {
        const res = await request(app.getHttpServer()).get(path);
        expect([path, res.headers["cache-control"], res.headers["pragma"]]).toEqual([path, "no-store", "no-cache"]);
      }
    });
  });

  describe("L-09 — no framework fingerprint in headers or bodies", () => {
    it("sends no X-Powered-By", async () => {
      const res = await request(app.getHttpServer()).get("/health");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("an unrouted path is a bare 404 — no `Cannot GET /path`, no echo of what was asked", async () => {
      const res = await request(app.getHttpServer()).get("/metrics").expect(404);
      expect(res.body).toEqual({ statusCode: 404, message: "Not Found" });
      expect(res.text).not.toMatch(/Cannot|metrics/);
    });

    it("malformed JSON is a bare 400 — the parser's own sentence is not echoed", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .set("content-type", "application/json")
        .send("{bad json")
        .expect(400);
      expect(res.body).toEqual({ statusCode: 400, message: "Bad Request" });
      expect(res.text).not.toMatch(/JSON|position|property/i);
    });

    it("an oversized body is a bare 413", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .set("content-type", "application/json")
        .send(JSON.stringify({ username: "x".repeat(1_200_000), password: "y" }))
        .expect(413);
      expect(res.body).toEqual({ statusCode: 413, message: "Payload Too Large" });
    });

    it("the app's OWN coded errors are untouched — a routed 404 keeps its code and sentence", async () => {
      const res = await request(app.getHttpServer()).get("/hardening-probe/coded-404").expect(404);
      expect(res.body).toEqual({ code: "thing_not_found", message: "no such thing, and here is why" });
    });

    it("a routed validation refusal still names its issues (the 400s every screen relies on)", async () => {
      const res = await request(app.getHttpServer()).post("/auth/login").send({}).expect(400);
      expect(Array.isArray(res.body.message)).toBe(true);
    });

    it("a routed 401 keeps its shape", async () => {
      const res = await request(app.getHttpServer()).get("/auth/me").expect(401);
      expect(res.body).toEqual({ statusCode: 401, message: "Unauthorized" });
    });

    it("an unexpected throw is a generic 500 that carries none of the error's text", async () => {
      const res = await request(app.getHttpServer()).get("/hardening-probe/boom").expect(500);
      expect(res.body).toEqual({ statusCode: 500, message: "Internal server error" });
      expect(res.text).not.toMatch(/internal detail/);
    });
  });
});
