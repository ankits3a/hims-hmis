import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createFakeAbdmGateway } from "./helpers/abdm-fake-gateway";
import { HIP, SECRET } from "./helpers/abdm-hip";
import { HIU_ID, consentDetail, notifyBody, onFetchBody, onHiRequestBody, onInitBody, remoteBundles, seedHiuFixture } from "./helpers/abdm-hiu";
import { mkUser } from "./helpers/opd";
import { ABDM_FETCH, HIU_PATHS } from "../src/modules/abdm";
import { abdmExternalRecords, abdmMessages, opdDoctors, phiAccessLog } from "../src/kernel/db/schema";
import { CONFIG } from "../src/kernel/tokens";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { patientsManifest } from "../src/modules/patients";
import { opdManifest } from "../src/modules/opd";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import type { AppConfig } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { HiuFixture } from "./helpers/abdm-hiu";

/**
 * ABDM S3 — M3 through the REAL application: the doctor's routes behind `opd.consult` AND the consult's
 * treating-doctor guard; ABDM's JWT-signed HIU callbacks dispatching to the handlers the module
 * registered at boot (a retried callback handled once); the data push at our own `dataPushUrl`, which
 * carries NO Authorization (the NHA wrapper's HIP sends none) and is accepted on its address, its
 * transaction and our key; the read, PHI-audited; and REVOKED deleting what the read showed.
 */
jest.setTimeout(120_000);

const CB = "/abdm/callbacks/api/v3/hiu";

function workerDbUrl(): string {
  const url = new URL(requireEnv("TEST_DATABASE_URL"));
  url.pathname = `${url.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
  return url.toString();
}

describe("ABDM S3 e2e — the hospital as HIU", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let cfg: AppConfig;
  let fx: HiuFixture;
  const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, hipId: HIP });
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(opdManifest);
  let doctor: { id: string; token: string };
  let otherDoctor: { id: string; token: string };
  let clerk: { id: string; token: string };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({
      DATABASE_URL: workerDbUrl(), SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: HIP, ABDM_HIU_ID: HIU_ID,
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG).useValue(cfg)
      .overrideProvider(ABDM_FETCH).useValue(fake.fetch)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(nest);
    await nest.init();
    app = nest;
  });
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    fx = await seedHiuFixture(db);
    await createRole(db, "hiu_doc", "hiu_doc");
    await grantPermissionToRole(db, registry, "hiu_doc", "opd.consult");
    await createRole(db, "hiu_clerk", "hiu_clerk");
    await grantPermissionToRole(db, registry, "hiu_clerk", "patients.read");
    doctor = await mkUser(db, "hiu_doctor", ["hiu_doc"]);
    otherDoctor = await mkUser(db, "hiu_doctor2", ["hiu_doc"]);
    clerk = await mkUser(db, "hiu_clerk", ["hiu_clerk"]);
    await db.update(opdDoctors).set({ userId: doctor.id }).where(eq(opdDoctors.code, "DR001"));
    await db.update(opdDoctors).set({ userId: otherDoctor.id }).where(eq(opdDoctors.code, "DR002"));
  });

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const callback = (path: string, body: Record<string, unknown>, requestId?: string) => {
    const cb = fake.signedCallback(body, { hiuId: HIU_ID, ...(requestId === undefined ? {} : { requestId }) });
    return request(app.getHttpServer()).post(`${CB}${path}`).set(cb.headers).send(cb.body);
  };
  const last = (path: string) => fake.hiuGateway.calls(path).at(-1)!;

  it("the request route: 403 without opd.consult, 403 not_your_patient for another doctor, 201 for the treating doctor in an open consult", async () => {
    const before = fake.hiuGateway.calls(HIU_PATHS.consentInit).length;
    await request(app.getHttpServer()).post("/abdm/hiu/consent-requests").set(as(clerk.token)).send({ encounterId: fx.encC }).expect(403);
    const other = await request(app.getHttpServer()).post("/abdm/hiu/consent-requests").set(as(otherDoctor.token)).send({ encounterId: fx.encC }).expect(403);
    expect(other.body.code).toBe("not_your_patient");
    const closed = await request(app.getHttpServer()).post("/abdm/hiu/consent-requests").set(as(doctor.token)).send({ encounterId: fx.encA }).expect(409);
    expect(closed.body.code).toBe("consultation_not_open");
    expect(fake.hiuGateway.calls(HIU_PATHS.consentInit)).toHaveLength(before);
    const ok = await request(app.getHttpServer()).post("/abdm/hiu/consent-requests").set(as(doctor.token)).send({ encounterId: fx.encC }).expect(201);
    expect(ok.body).toMatchObject({ status: "requested", purposeCode: "CAREMGT" });
    expect(fake.hiuGateway.calls(HIU_PATHS.consentInit)).toHaveLength(before + 1);
    // the read is opd.consult too
    await request(app.getHttpServer()).get(`/abdm/hiu/patients/${fx.patientId}/records`).set(as(clerk.token)).expect(403);
  });

  it("JWT callbacks → the push over HTTP with NO Authorization → the read, grouped and audited → REVOKED deletes it; a retried callback is handled once", async () => {
    await request(app.getHttpServer()).post("/abdm/hiu/consent-requests").set(as(doctor.token)).send({ encounterId: fx.encC }).expect(201);
    await callback("/consent/request/on-init", onInitBody(last(HIU_PATHS.consentInit).requestId, "cr-e2e")).expect(202);
    const fetchesBefore = fake.hiuGateway.calls(HIU_PATHS.consentFetch).length;
    await callback("/consent/request/notify", notifyBody("GRANTED", "cr-e2e", ["artefact-e2e"]), "notify-once").expect(202);
    await callback("/consent/request/notify", notifyBody("GRANTED", "cr-e2e", ["artefact-e2e"]), "notify-once").expect(202); // ABDM's retry
    expect(fake.hiuGateway.calls(HIU_PATHS.consentFetch)).toHaveLength(fetchesBefore + 1);
    await callback("/consent/on-fetch", onFetchBody(last(HIU_PATHS.consentFetch).requestId, consentDetail(fake, { consentId: "artefact-e2e" }))).expect(202);
    const hi = last(HIU_PATHS.hiRequest);
    await callback("/health-information/on-request", onHiRequestBody(hi.requestId, "txn-e2e")).expect(202);
    // a callback without ABDM's JWT is refused at the guard
    await request(app.getHttpServer()).post(`${CB}/consent/request/notify`).set({ "REQUEST-ID": "forged" }).send(notifyBody("REVOKED", null, ["artefact-e2e"])).expect(401);

    const page = fake.remoteHip.push(hi.body, { transactionId: "txn-e2e", entries: remoteBundles(fake).map(({ careContextReference, bundle }) => ({ careContextReference, bundle })) });
    // The token rides the `pt` query parameter (the edge log redacts it), never a path segment.
    expect(page.path).toMatch(/^\/abdm\/callbacks\/hiu\/data-push\?pt=[A-Za-z0-9_-]{43}$/);
    const pushed = await request(app.getHttpServer()).post(page.path).send(page.body).expect(202);
    expect(pushed.body.code).toBe("received");
    await request(app.getHttpServer()).post("/abdm/callbacks/hiu/data-push?pt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").send(page.body).expect(404);
    // no token, a repeated one, and the REAL token in the old path form: none is an address of ours
    await request(app.getHttpServer()).post("/abdm/callbacks/hiu/data-push").send(page.body).expect(404);
    await request(app.getHttpServer()).post(`${page.path}&pt=${page.token}`).send(page.body).expect(404);
    await request(app.getHttpServer()).post(`/abdm/callbacks/hiu/data-push/${page.token}`).send(page.body).expect(404);
    expect(await db.select().from(abdmExternalRecords)).toHaveLength(4);

    const read = await request(app.getHttpServer()).get(`/abdm/hiu/patients/${fx.patientId}/records`).set(as(doctor.token)).expect(200);
    expect(read.body.hiuConfigured).toBe(true);
    expect(read.body.facilities).toHaveLength(1);
    expect(read.body.facilities[0]).toMatchObject({ hipId: "IN0810000123", hipName: "Fortis Escorts Jaipur" });
    expect(read.body.facilities[0].records).toHaveLength(4);
    expect(read.body.requests[0]).toMatchObject({ status: "granted" });
    expect((await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.external_records")))[0]).toMatchObject({ actorId: doctor.id, patientId: fx.patientId });
    // the push is in the log as a summary; the page's ciphertext is not
    const log = JSON.stringify(await db.select().from(abdmMessages));
    expect(log).toContain("hiu.data_push");
    expect(log).not.toContain((page.body.entries as { content: string }[])[0]!.content.slice(0, 40));
    expect(log).not.toContain(page.token);

    await callback("/consent/request/notify", notifyBody("REVOKED", null, ["artefact-e2e"])).expect(202);
    expect(await db.select().from(abdmExternalRecords)).toHaveLength(0);
    const after = await request(app.getHttpServer()).get(`/abdm/hiu/patients/${fx.patientId}/records`).set(as(doctor.token)).expect(200);
    expect(after.body.facilities).toEqual([]);
    expect(after.body.requests[0]).toMatchObject({ status: "revoked", artefacts: [{ status: "REVOKED", erasedCount: 4 }] });
  });
});
