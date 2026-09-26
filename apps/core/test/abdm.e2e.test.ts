import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createFakeAbdmGateway } from "./helpers/abdm-fake-gateway";
import type { FakeAbdmGateway } from "./helpers/abdm-fake-gateway";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { patientsManifest } from "../src/modules/patients";
import { ABDM_FETCH, registerAbdmCallbackHandler } from "../src/modules/abdm";
import type { AbdmInboundMessage } from "../src/modules/abdm";
import { abdmMessages, registrationConfig } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { CONFIG } from "../src/kernel/tokens";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { AppConfig } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ABDM S0 — the callback routes, through the REAL application: the global AuthGuard/PermissionGuard
 * pair, `@Public()`, the ABDM JWT guard, the message log and the handler registry.
 *
 * The routes are NOT behind the app's user authentication (ABDM holds no HMIS session) and ARE
 * behind ABDM's RS256 JWT. Both halves are asserted: a gateway-signed token with no HMIS session
 * gets in, and a perfectly good HMIS session with no ABDM token does not.
 */
jest.setTimeout(120_000);

const SECRET = "e2e-secret-7d1a-never-stored";
const SHARE = "/abdm/callbacks/api/v3/hip/patient/share";
/**
 * S1 — the scan-and-share kind now HAS a handler (the abdm module registers it when ABDM is
 * configured), so the registry assertions below run against a kind no slice handles yet.
 *
 * S2 — and so, now, does every HIP kind but the deep-link SMS acknowledgement (not built), so that
 * is the generic kind; the "nobody handles it" and "a handler that throws" cases below moved to
 * HIU kinds, which S3 owns.
 */
const GENERIC = "/abdm/callbacks/api/v3/patients/sms/on-notify";
const GENERIC_KIND = "callback.patients/sms/on-notify";

function workerDbUrl(): string {
  const url = new URL(requireEnv("TEST_DATABASE_URL"));
  url.pathname = `${url.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
  return url.toString();
}

async function boot(cfg: AppConfig, fake: FakeAbdmGateway | null): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CONFIG).useValue(cfg);
  if (fake !== null) builder = builder.overrideProvider(ABDM_FETCH).useValue(fake.fetch);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

describe("ABDM callbacks e2e — configured", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET });
  let cfg: AppConfig;
  let seen: AbdmInboundMessage[];
  let unregister: Array<() => void> = [];

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({
      DATABASE_URL: workerDbUrl(),
      SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl,
      ABDM_CLIENT_ID: "SBX_0001",
      ABDM_CLIENT_SECRET: SECRET,
      ABDM_HIP_ID: "IN0000000001",
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
    });
    app = await boot(cfg, fake);
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    seen = [];
    unregister = [registerAbdmCallbackHandler(GENERIC_KIND, async (m) => { seen.push(m); })];
  });
  afterEach(() => { for (const u of unregister) u(); });

  const post = (path: string, token: string | null, requestId: string | null, body: unknown = {}) => {
    let r = request(app.getHttpServer()).post(path).set("TIMESTAMP", new Date().toISOString()).set("X-HIP-ID", "IN0000000001");
    if (token !== null) r = r.set("Authorization", `Bearer ${token}`);
    if (requestId !== null) r = r.set("REQUEST-ID", requestId);
    return r.send(body as object);
  };

  it("accepts a gateway-signed callback with NO HMIS session: 202, logged, dispatched once", async () => {
    const body = { acknowledgement: { status: "SUCCESS" }, response: { requestId: "corr-1" } };
    const res = await post(GENERIC, fake.signCallbackJwt(), "11111111-1111-4111-8111-111111111111", body);
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: GENERIC_KIND, requestId: "11111111-1111-4111-8111-111111111111", hipId: "IN0000000001", body });
    const rows = await db.select().from(abdmMessages).where(eq(abdmMessages.direction, "in"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: GENERIC_KIND, path: "/api/v3/patients/sms/on-notify", httpStatus: 202,
      requestId: "11111111-1111-4111-8111-111111111111", correlationRequestId: "corr-1", dispatch: "handled", body,
    });
    // The inbound JWT is ABDM's credential and is not kept.
    expect((rows[0]!.headers as Record<string, string>)["authorization"]).toBe("Bearer [redacted]");
  });

  it("a RETRY with the same REQUEST-ID answers 202 and is not dispatched again", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect((await post(GENERIC, fake.signCallbackJwt(), id)).status).toBe(202);
    expect((await post(GENERIC, fake.signCallbackJwt(), id)).status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(await db.select().from(abdmMessages).where(eq(abdmMessages.direction, "in"))).toHaveLength(1);
  });

  it("a valid HMIS user session is NOT an ABDM token", async () => {
    const { id } = await createUser(db, { username: "clerk", fullName: "clerk", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    expect((await post(GENERIC, token, "33333333-3333-4333-8333-333333333333")).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses no token, a wrong key, alg none and HS256 — and logs none of them", async () => {
    expect((await post(SHARE, null, "44444444-4444-4444-8444-444444444441")).status).toBe(401);
    expect((await post(SHARE, fake.signCallbackJwt({}, { key: "wrong" }), "44444444-4444-4444-8444-444444444442")).status).toBe(401);
    expect((await post(SHARE, fake.unsignedJwt(), "44444444-4444-4444-8444-444444444443")).status).toBe(401);
    expect((await post(SHARE, fake.hs256Jwt(fake.publicKeyPem()), "44444444-4444-4444-8444-444444444444")).status).toBe(401);
    expect((await post(SHARE, fake.signCallbackJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }), "44444444-4444-4444-8444-444444444445")).status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(await db.select().from(abdmMessages).where(eq(abdmMessages.direction, "in"))).toHaveLength(0);
  });

  it("an authenticated callback without a REQUEST-ID is a 400", async () => {
    expect((await post(SHARE, fake.signCallbackJwt(), null)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("a kind nobody handles yet is logged and still 202", async () => {
    const res = await post("/abdm/callbacks/api/v3/hiu/consent/request/on-init", fake.signCallbackJwt(), "55555555-5555-4555-8555-555555555555");
    expect(res.status).toBe(202);
    const [row] = await db.select().from(abdmMessages).where(eq(abdmMessages.requestId, "55555555-5555-4555-8555-555555555555"));
    expect(row).toMatchObject({ kind: "callback.hiu/consent/request/on-init", dispatch: "unhandled" });
  });

  it("a handler that throws is recorded as failed, and ABDM still gets 202", async () => {
    unregister.push(registerAbdmCallbackHandler("callback.hiu/health-information/on-request", async () => { throw new Error("handler broke"); }));
    const res = await post("/abdm/callbacks/api/v3/hiu/health-information/on-request", fake.signCallbackJwt(), "66666666-6666-4666-8666-666666666666");
    expect(res.status).toBe(202);
    const [row] = await db.select().from(abdmMessages).where(eq(abdmMessages.requestId, "66666666-6666-4666-8666-666666666666"));
    expect(row).toMatchObject({ dispatch: "failed", error: "handler broke" });
  });

  it("a path ABDM does not call is not a route", async () => {
    expect((await post("/abdm/callbacks/api/v3/not/a/callback", fake.signCallbackJwt(), "77777777-7777-4777-8777-777777777777")).status).toBe(404);
  });

  it("registering a second handler for one kind is refused", () => {
    expect(() => registerAbdmCallbackHandler(GENERIC_KIND, async () => undefined)).toThrow(/already/);
    // S1 — and the share kind is taken by the module itself while ABDM is configured; S2 — so are the M2 kinds.
    expect(() => registerAbdmCallbackHandler("callback.hip/patient/share", async () => undefined)).toThrow(/already/);
    expect(() => registerAbdmCallbackHandler("callback.hip/health-information/request", async () => undefined)).toThrow(/already/);
  });
});

describe("ABDM e2e — NOT configured", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let cfg: AppConfig;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  let clerkToken: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({ DATABASE_URL: workerDbUrl(), SECRET_KEY: process.env.SECRET_KEY! });
    expect(cfg.abdm.configured).toBe(false);
    app = await boot(cfg, null);
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "e2e" });
    await createRole(db, "reg_desk", "Registration Desk");
    for (const p of patientsManifest.permissions) await grantPermissionToRole(db, registry, "reg_desk", p);
    const { id } = await createUser(db, { username: "clerk", fullName: "clerk", password: "p1234567" });
    clerkToken = (await createSession(db, cfg, id)).token;
    await assignRole(db, { userId: id, roleKey: "reg_desk", scopeType: "hospital" });
  });

  it("every callback route answers 503 ABDM not configured — whatever it carries", async () => {
    const fake = createFakeAbdmGateway({ clientId: "x", clientSecret: "y" });
    const res = await request(app.getHttpServer()).post(SHARE)
      .set("Authorization", `Bearer ${fake.signCallbackJwt()}`).set("REQUEST-ID", "88888888-8888-4888-8888-888888888888").send({});
    expect(res.status).toBe(503);
    expect(res.body.message).toBe("ABDM not configured");
    expect(await db.select().from(abdmMessages)).toHaveLength(0);
  });

  it("POST /patients refuses a client-sent verified with 400 abha_verified_only_by_abdm", async () => {
    const res = await request(app.getHttpServer()).post("/patients").set("Authorization", `Bearer ${clerkToken}`)
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", abhaNumber: "12-3456-7890-1234", abhaVerificationStatus: "verified" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("abha_verified_only_by_abdm");
    expect(res.body.message).toMatch(/^abha_verified_only_by_abdm:/);
  });

  it("PATCH /patients/:id refuses a move to verified with the same 400", async () => {
    const reg = await request(app.getHttpServer()).post("/patients").set("Authorization", `Bearer ${clerkToken}`)
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", abhaNumber: "12-3456-7890-1234", abhaVerificationStatus: "self_declared" })
      .expect(201);
    const res = await request(app.getHttpServer()).patch(`/patients/${reg.body.patient.id as string}`)
      .set("Authorization", `Bearer ${clerkToken}`).send({ abhaVerificationStatus: "verified" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("abha_verified_only_by_abdm");
  });
});
