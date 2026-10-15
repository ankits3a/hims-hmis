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
import { phiAccessLog, registrationConfig } from "../src/kernel/db/schema";
import { eq } from "drizzle-orm";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/** Same fixture as `patients.e2e.test.ts` (and its 120 s hook budget, for the same reason). */
jest.setTimeout(120_000);

describe("#657 patient profile e2e", () => {
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

  /** A desk seat holding `patients.read` / `patients.register` but NOT `patients.confidential.read`. */
  const deskSeat = async (): Promise<string> => {
    await createRole(db, "desk_no_seal", "Desk without the sealed read");
    await grantPermissionToRole(db, registry, "desk_no_seal", "patients.read");
    await grantPermissionToRole(db, registry, "desk_no_seal", "patients.register");
    const { id } = await createUser(db, { username: "desk", fullName: "desk", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await assignRole(db, { userId: id, roleKey: "desk_no_seal", scopeType: "hospital" });
    return token;
  };
  const register = async (body: Record<string, unknown>): Promise<string> => {
    const res = await request(app.getHttpServer()).post("/patients").set(...auth(clerkToken))
      .send({ sex: "female", language: "hi", ageYears: 60, ...body }).expect(201);
    return res.body.patient.id as string;
  };
  const accessRows = async (patientId: string) =>
    (await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, patientId))).map((r) => ({ surface: r.surface, sealed: r.sealed }));

  it("GET /patients/:id/profile — a readable record: the full row, visits, one patient.detail access row", async () => {
    const id = await register({ name: "Open Record", phone: "9811100001" });
    const res = await request(app.getHttpServer()).get(`/patients/${id}/profile`).set(...auth(clerkToken)).expect(200);
    expect(res.body.view).toBe("full");
    expect(res.body.patient.phone).toBe("9811100001");
    expect(res.body.visits).toEqual({ count: 0, lastVisitOn: null });
    expect(await accessRows(id)).toEqual([{ surface: "patient.detail", sealed: false }]);
    await request(app.getHttpServer()).get(`/patients/${id}/profile`).set(...auth(randoToken)).expect(403);
  });

  it("GET /patients/:id/profile — a SEALED record to a desk without the grant: alias only, logged as patient.profile_alias", async () => {
    const desk = await deskSeat();
    const id = await register({ name: "Sealed Legal Name", phone: "9811100002", isConfidential: true, alias: "R-77", addressLine: "Hidden Road" });
    // The detail route still existence-hides it, exactly as before.
    await request(app.getHttpServer()).get(`/patients/${id}`).set(...auth(desk)).expect(404);
    const res = await request(app.getHttpServer()).get(`/patients/${id}/profile`).set(...auth(desk)).expect(200);
    expect(res.body.view).toBe("restricted");
    expect(res.body.patient.alias).toBe("R-77");
    const wire = JSON.stringify(res.body);
    for (const leak of ["Sealed Legal Name", "9811100002", "Hidden Road"]) expect(wire).not.toContain(leak);
    expect(await accessRows(id)).toEqual([{ surface: "patient.profile_alias", sealed: true }]);
    await request(app.getHttpServer()).get("/patients/01NOSUCH00000000000000000/profile").set(...auth(desk)).expect(404);
  });

  it("POST /patients/:id/mobile-shown — answers the numbers and writes one patient.profile_mobile row", async () => {
    const desk = await deskSeat();
    const id = await register({ name: "Caller", phone: "9811100003", altPhone: "9811100004" });
    const res = await request(app.getHttpServer()).post(`/patients/${id}/mobile-shown`).set(...auth(desk)).expect(200);
    expect(res.body).toEqual({ phone: "9811100003", altPhone: "9811100004" });
    expect(await accessRows(id)).toEqual([{ surface: "patient.profile_mobile", sealed: false }]);
    await request(app.getHttpServer()).post(`/patients/${id}/mobile-shown`).set(...auth(randoToken)).expect(403);
  });

  it("POST /patients/:id/mobile-shown — a sealed record the reader may not open is a 404 and logs nothing", async () => {
    const desk = await deskSeat();
    const id = await register({ name: "Sealed Caller", phone: "9811100005", isConfidential: true, alias: "R-78" });
    const res = await request(app.getHttpServer()).post(`/patients/${id}/mobile-shown`).set(...auth(desk));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("9811100005");
    expect(await accessRows(id)).toEqual([]);
  });
});
