import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { registrationConfig } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

describe("patients e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let clerkToken: string;
  let randoToken: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Single-argument overload: TestingModule treats a first argument that is not an HTTP
    // adapter AS the options bag, so passing `undefined` first would silently drop them.
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "e2e" });
    await createRole(db, "reg_desk", "Registration Desk");
    for (const p of patientsManifest.permissions) {
      await grantPermissionToRole(db, registry, "reg_desk", p);
    }
    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const clerk = await mk("clerk");
    const rando = await mk("rando");
    clerkToken = clerk.token;
    randoToken = rando.token;
    await assignRole(db, { userId: clerk.id, roleKey: "reg_desk", scopeType: "hospital" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  it("401 without a token; 403 without the permission", async () => {
    await request(app.getHttpServer()).get("/patients/search").query({ q: "98765" }).expect(401);
    await request(app.getHttpServer()).get("/patients/search").query({ q: "98765" }).set(...auth(randoToken)).expect(403);
  });

  it("register → search → read → patch, with a valid UHID and events behind it", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients")
      .set(...auth(clerkToken))
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", language: "hi" })
      .expect(201);
    const patientId = reg.body.patient.id as string;
    expect(reg.body.patient.uhid).toMatch(/^HMS\d{8}$/);

    const found = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "98765" }).set(...auth(clerkToken)).expect(200);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].id).toBe(patientId);
    expect(found.body.items[0].hasPhoto).toBe(false);

    await request(app.getHttpServer()).get(`/patients/${patientId}`).set(...auth(clerkToken)).expect(200);
    const patched = await request(app.getHttpServer())
      .patch(`/patients/${patientId}`).set(...auth(clerkToken))
      .send({ language: "en" }).expect(200);
    expect(patched.body.changed).toEqual(["language"]);
    await request(app.getHttpServer()).get("/patients/01NOSUCH00000000000000000").set(...auth(clerkToken)).expect(404);
  });

  it("photo round-trips as base64 JSON — a ~300 kB body proves the parser bump", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Photo P", sex: "other" }).expect(201);
    const id = reg.body.patient.id as string;
    const bytes = Buffer.alloc(300_000, 7);
    await request(app.getHttpServer())
      .put(`/patients/${id}/photo`).set(...auth(clerkToken))
      .send({ imageBase64: bytes.toString("base64") }).expect(200);
    const got = await request(app.getHttpServer())
      .get(`/patients/${id}/photo`).set(...auth(clerkToken)).expect(200);
    expect(got.body.mimeType).toBe("image/jpeg");
    expect(Buffer.compare(Buffer.from(got.body.imageBase64, "base64"), bytes)).toBe(0);
    expect((await request(app.getHttpServer())
      .get("/patients/search").query({ q: "photo" }).set(...auth(clerkToken))).body.items[0].hasPhoto).toBe(true);
  });

  it("allergies and guardians ride their routes; guardians return computed effective authority", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Minor M", sex: "other", ageYears: 10, guardian: { name: "G", relationship: "mother" } })
      .expect(201);
    const id = reg.body.patient.id as string;

    const allergy = await request(app.getHttpServer())
      .post(`/patients/${id}/allergies`).set(...auth(clerkToken))
      .send({ substance: "penicillin", severity: "severe", source: "registration" }).expect(201);
    await request(app.getHttpServer())
      .post(`/patients/${id}/allergies/${allergy.body.allergyId}/entered-in-error`)
      .set(...auth(clerkToken)).send({ reason: "wrong record" }).expect(201);
    const list = await request(app.getHttpServer())
      .get(`/patients/${id}/allergies`).set(...auth(clerkToken)).expect(200);
    expect(list.body.items[0].status).toBe("entered_in_error");

    const guardians = await request(app.getHttpServer())
      .get(`/patients/${id}/guardians`).set(...auth(clerkToken)).expect(200);
    expect(guardians.body.items).toHaveLength(1);
    expect(guardians.body.items[0].effectiveAuthority).toEqual({
      messages: true, consents: true, dsr: false, bills: true,
    });
    await request(app.getHttpServer())
      .post(`/patients/${id}/guardians/${guardians.body.items[0].guardian.id}/end`)
      .set(...auth(clerkToken)).expect(201);
  });

  it("QR: card payload prints, verify resolves, tampering answers ok:false over HTTP 200 (route order proven)", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Card C", sex: "male", phone: "9000000001" }).expect(201);
    const id = reg.body.patient.id as string;

    const card = await request(app.getHttpServer())
      .get(`/patients/${id}/qr`).set(...auth(clerkToken)).expect(200);
    expect(card.body.payload.startsWith("q1.")).toBe(true);

    const ok = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload }).expect(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.patient.id).toBe(id);

    const bad = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload.slice(0, -2) + "xx" }).expect(200);
    expect(bad.body).toEqual({ ok: false, reason: "invalid_signature" });

    const re = await request(app.getHttpServer())
      .post(`/patients/${id}/qr/reissue`).set(...auth(clerkToken)).expect(201);
    expect(re.body.qrVersion).toBe(2);
    const stale = await request(app.getHttpServer())
      .post("/patients/qr/verify").set(...auth(clerkToken))
      .send({ payload: card.body.payload }).expect(200);
    expect(stale.body).toEqual({ ok: false, reason: "stale_version" });
  });

  it("merge routes 409 with a clear ApprovalError until the types are registered (the runbook step)", async () => {
    const a = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "A", sex: "male" }).expect(201);
    const b = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "B", sex: "male" }).expect(201);
    await request(app.getHttpServer())
      .post("/patients/merge-requests").set(...auth(clerkToken))
      .send({ winnerId: a.body.patient.id, loserId: b.body.patient.id, note: "dup" })
      .expect(409); // unknown approval type patient_merge — registration is go-live data, T10 exercises the full path
  });
});
