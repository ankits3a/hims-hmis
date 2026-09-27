import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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
import { ABDM_FETCH } from "../src/modules/abdm";
import { abdmMessages, abdmProfileShares, patients, registrationConfig } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { CONFIG } from "../src/kernel/tokens";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { AppConfig } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ABDM S1 — ABHA at the counter, through the REAL application: the global guards, the existing
 * `patients.register` / `patients.update` permissions, the S0 callback route and the S1 handler.
 *
 *   · verify an ABHA by OTP → link it → the patient is `verified`, and no response the browser saw
 *     carried ABDM's txnId or the patient's X-token;
 *   · create is 403 `abha_create_disabled` while the owner has not ruled — and the Aadhaar number in
 *     the body never reaches ABDM or a row;
 *   · scan and share: ABDM's signed callback → a pending share → the counter's list → the ordinary
 *     `POST /patients` pre-filled from it → the link; a retried REQUEST-ID is one share, one reply.
 */
jest.setTimeout(120_000);

const SECRET = "e2e-abha-secret-never-stored";
const HIP = "IN0000000001";
const ABHA = "91-2345-6789-0123";
const SHARE = "/abdm/callbacks/api/v3/hip/patient/share";

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

async function seedDesk(db: Db, cfg: AppConfig): Promise<{ clerk: string; outsider: string }> {
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  await seedSodPairs(db);
  await syncPermissions(db, registry);
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "e2e" });
  await createRole(db, "reg_desk", "Registration Desk");
  for (const p of ["patients.read", "patients.register", "patients.update"]) await grantPermissionToRole(db, registry, "reg_desk", p);
  const { id } = await createUser(db, { username: "clerk", fullName: "clerk", password: "p1234567" });
  await assignRole(db, { userId: id, roleKey: "reg_desk", scopeType: "hospital" });
  const { id: nobody } = await createUser(db, { username: "nobody", fullName: "nobody", password: "p1234567" });
  return { clerk: (await createSession(db, cfg, id)).token, outsider: (await createSession(db, cfg, nobody)).token };
}

describe("ABDM S1 e2e — configured, create OFF", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, hipId: HIP });
  fake.abha.addAccount({
    ABHANumber: ABHA, preferredAbhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", gender: "F",
    yearOfBirth: "1986", monthOfBirth: "3", dayOfBirth: "14", mobile: "******3210",
  });
  let cfg: AppConfig;
  let clerk: string;
  let outsider: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({
      DATABASE_URL: workerDbUrl(), SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_ABHA_BASE_URL: fake.abha.baseUrl,
      ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: HIP,
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
    });
    app = await boot(cfg, fake);
  });
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    ({ clerk, outsider } = await seedDesk(db, cfg));
    fake.onShares.length = 0;
  });

  const as = (token: string) => ({
    get: (p: string) => request(app.getHttpServer()).get(p).set("Authorization", `Bearer ${token}`),
    post: (p: string, body: object = {}) => request(app.getHttpServer()).post(p).set("Authorization", `Bearer ${token}`).send(body),
  });

  it("the capability says verify ON, create OFF, scan-and-share ON", async () => {
    const res = await as(clerk).get("/patients/abha/capability").expect(200);
    expect(res.body).toMatchObject({ configured: true, canRecord: true, canVerify: true, canCreate: false, canScanShare: true });
  });

  it("verify → OTP → link over HTTP: verified, and no response carried ABDM's txnId or the X-token", async () => {
    const reg = await as(clerk).post("/patients", { name: "Sunita Sharma", sex: "female", phone: "9876543210", dob: "1986-03-14" }).expect(201);
    const patientId = reg.body.patient.id as string;
    const seen: string[] = [];

    const start = await as(clerk).post("/abdm/abha/verify", { identifier: ABHA, method: "aadhaar_otp", patientId }).expect(201);
    seen.push(JSON.stringify(start.body));
    expect(start.body).toMatchObject({ stage: "otp_sent", kind: "abha_number" });
    const id = start.body.transactionId as string;

    const otp = await as(clerk).post(`/abdm/abha/transactions/${id}/otp`, { otp: "314159" }).expect(200);
    seen.push(JSON.stringify(otp.body));
    expect(otp.body.profile).toMatchObject({ abhaNumber: ABHA, name: "Sunita Sharma" });
    expect(otp.body.comparison.map((c: { result: string }) => c.result)).toEqual(["same", "same", "same", "same"]);

    const card = await as(clerk).get(`/abdm/abha/transactions/${id}/card`).expect(200);
    expect(card.body.mimeType).toBe("image/png");
    expect(Buffer.from(card.body.imageBase64 as string, "base64").equals(fake.abha.cardBytes)).toBe(true);
    // CRT_ABHA_114 — the card as a FILE: streamed with a download disposition, cached nowhere, stored nowhere.
    const file = await as(clerk).get(`/abdm/abha/transactions/${id}/card/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(file.headers["content-type"]).toMatch(/^image\/png/);
    expect(file.headers["content-disposition"]).toBe('attachment; filename="ABHA-card-0123.png"');
    expect(file.headers["cache-control"]).toBe("no-store");
    expect((file.body as Buffer).equals(fake.abha.cardBytes)).toBe(true);
    const stored = ((await db.execute(sql`select coalesce(json_agg(m)::text, '') as t from abdm_messages m`)).rows[0] as { t: string }).t;
    expect(stored).not.toContain(fake.abha.cardBytes.toString("base64"));

    // Linking writes an existing record: a clerk WITHOUT the grants is refused at the guard.
    await as(outsider).post(`/abdm/abha/transactions/${id}/link`, { patientId }).expect(403);
    const link = await as(clerk).post(`/abdm/abha/transactions/${id}/link`, { patientId }).expect(200);
    seen.push(JSON.stringify(link.body));
    const [row] = await db.select().from(patients).where(eq(patients.id, patientId));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: ABHA });

    const txnIds = fake.requests.flatMap((r) => {
      const b = r.body as { txnId?: string; authData?: { otp?: { txnId?: string } } } | undefined;
      return [b?.txnId, b?.authData?.otp?.txnId].filter((x): x is string => typeof x === "string" && x !== "");
    });
    expect(txnIds.length).toBeGreaterThan(0);
    const all = seen.join("\n");
    for (const t of txnIds) expect(all).not.toContain(t);
    for (const t of fake.abha.xTokensIssued()) expect(all).not.toContain(t);
  });

  it("a difference comes back as 409 abha_profile_mismatch with the comparison, and links only when ABDM's details are accepted", async () => {
    const reg = await as(clerk).post("/patients", { name: "Sunita Verma", sex: "female", phone: "9000000000", ageYears: 30 }).expect(201);
    const patientId = reg.body.patient.id as string;
    const start = await as(clerk).post("/abdm/abha/verify", { identifier: ABHA, method: "mobile_otp" }).expect(201);
    await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/otp`, { otp: "314159" }).expect(200);
    const refused = await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/link`, { patientId }).expect(409);
    expect(refused.body.code).toBe("abha_profile_mismatch");
    expect(refused.body.detail.comparison.filter((c: { result: string }) => c.result === "differs").map((c: { field: string }) => c.field)).toEqual(["name", "dob", "mobile"]);
    expect(refused.body.detail.demographicsToApply.map((c: { field: string }) => c.field)).toEqual(["name", "dob"]);
    await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/link`, { patientId, acceptAbdmDemographics: true }).expect(200);
    const [row] = await db.select().from(patients).where(eq(patients.id, patientId));
    // DECIDED: ABDM's name and birth are taken once accepted; the mobile stays the hospital's.
    expect(row).toMatchObject({ name: "Sunita Sharma", phone: "9000000000", abhaVerificationStatus: "verified" });
    // …and now they are locked: the ordinary PATCH refuses them, and still takes the phone.
    const locked = await request(app.getHttpServer()).patch(`/patients/${patientId}`).set("Authorization", `Bearer ${clerk}`)
      .send({ name: "Someone Else", reasonClass: "clerical_error" }).expect(409);
    expect(locked.body.code).toBe("abha_demographics_locked");
    await request(app.getHttpServer()).patch(`/patients/${patientId}`).set("Authorization", `Bearer ${clerk}`).send({ phone: "9811111111" }).expect(200);
  });

  it("an unknown handle is 404, a bad OTP shape is 400, a refused OTP is 422 without the OTP in it", async () => {
    await as(clerk).post("/abdm/abha/transactions/00000000-0000-4000-8000-000000000000/otp", { otp: "314159" }).expect(404);
    const start = await as(clerk).post("/abdm/abha/verify", { identifier: ABHA, method: "aadhaar_otp" }).expect(201);
    const bad = await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/otp`, { otp: "12" }).expect(400);
    expect(bad.body.code).toBe("otp_invalid");
    fake.abha.otp = "000001";
    const wrong = await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/otp`, { otp: "777777" }).expect(422);
    fake.abha.otp = "314159";
    expect(wrong.body.code).toBe("abdm_refused");
    expect(JSON.stringify(wrong.body)).not.toContain("777777");
    // the route needs the registration permission
    await as(outsider).post("/abdm/abha/verify", { identifier: ABHA, method: "aadhaar_otp" }).expect(403);
  });

  it("CREATE is 403 abha_create_disabled — and the Aadhaar number in the body reaches neither ABDM nor a row", async () => {
    const before = fake.requests.length;
    const res = await as(clerk).post("/abdm/abha/create", { aadhaar: "987654321098", patientConsented: true }).expect(403);
    expect(res.body.code).toBe("abha_create_disabled");
    expect(JSON.stringify(res.body)).not.toContain("987654321098");
    expect(fake.requests.length).toBe(before);
    const text = ((await db.execute(sql`select coalesce(json_agg(m)::text, '') as t from abdm_messages m`)).rows[0] as { t: string }).t;
    expect(text).not.toContain("987654321098");
  });

  it("find-by-Aadhaar is 403 while the Aadhaar switch is off; a re-send too soon is 429 with the wait; the Aadhaar never reaches a row", async () => {
    const off = await as(clerk).post("/abdm/abha/find-by-aadhaar", { aadhaar: "555566667777", patientConsented: true }).expect(403);
    expect(off.body.code).toBe("abha_find_by_aadhaar_disabled");
    const start = await as(clerk).post("/abdm/abha/verify", { identifier: ABHA, method: "aadhaar_otp" }).expect(201);
    const soon = await as(clerk).post(`/abdm/abha/transactions/${start.body.transactionId as string}/resend`, {}).expect(429);
    expect(soon.body).toMatchObject({ code: "otp_resend_too_soon", detail: { retryAfterSeconds: expect.any(Number) } });
    const text = ((await db.execute(sql`select coalesce(json_agg(m)::text, '') as t from abdm_messages m`)).rows[0] as { t: string }).t;
    expect(text).not.toContain("555566667777");
  });

  it("ONE ABHA, ONE PATIENT over HTTP: registering a second patient with a linked ABHA is 409 abha_already_linked naming the UHID", async () => {
    const first = await as(clerk).post("/patients", { name: "Sunita Sharma", sex: "female", phone: "9876543210", abhaNumber: ABHA, abhaVerificationStatus: "self_declared" }).expect(201);
    const second = await as(clerk).post("/patients", { name: "Another Person", sex: "female", phone: "9876543211", abhaNumber: "91234567890123", abhaVerificationStatus: "self_declared" }).expect(409);
    expect(second.body).toMatchObject({ code: "abha_already_linked", detail: { uhid: first.body.patient.uhid } });
  });

  it("scan and share: signed callback → pending share + token reply → the counter registers from it → link → verified", async () => {
    const cb = fake.shareProfileCallback({ context: "REG1" });
    const post = () => request(app.getHttpServer()).post(SHARE).set(cb.headers).send(cb.body);
    expect((await post()).status).toBe(202);
    // ABDM retries — the same REQUEST-ID is one share and one on-share, not two.
    expect((await post()).status).toBe(202);
    expect(await db.select().from(abdmProfileShares)).toHaveLength(1);
    expect(fake.onShares).toHaveLength(1);
    expect(fake.onShares[0]).toMatchObject({ acknowledgement: { status: "SUCCESS", profile: { context: "REG1", tokenNumber: "1" } }, response: { requestId: cb.headers["REQUEST-ID"] } });
    const [msg] = await db.select().from(abdmMessages).where(eq(abdmMessages.requestId, cb.headers["REQUEST-ID"]!));
    expect(msg!.dispatch).toBe("handled");

    const qr = await as(clerk).get("/abdm/scan-share/qr?counter=REG1").expect(200);
    expect(qr.body.url).toBe(`https://phrsbx.abdm.gov.in/share-profile?hf=${HIP}&counter=REG1`);

    const list = await as(clerk).get("/abdm/scan-share/shares").expect(200);
    expect(list.body.shares).toHaveLength(1);
    const share = list.body.shares[0] as { id: string; tokenNumber: number; profile: Record<string, string | null> };
    expect(share.tokenNumber).toBe(1);

    // The EXISTING registration route, pre-filled from the share — the counter's own flow.
    const reg = await as(clerk).post("/patients", {
      name: share.profile.name, sex: "female", phone: share.profile.mobile, dob: share.profile.dob,
      abhaNumber: share.profile.abhaNumber, abhaAddress: share.profile.abhaAddress, abhaVerificationStatus: "self_declared",
      addressLine: share.profile.addressLine, pincode: share.profile.pincode,
    }).expect(201);
    const patientId = reg.body.patient.id as string;
    await as(outsider).post(`/abdm/scan-share/shares/${share.id}/link`, { patientId }).expect(403);
    await as(clerk).post(`/abdm/scan-share/shares/${share.id}/link`, { patientId }).expect(200);
    const [row] = await db.select().from(patients).where(eq(patients.id, patientId));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: ABHA, abhaAddress: "sunita.sharma@sbx" });
    expect((await as(clerk).get("/abdm/scan-share/shares").expect(200)).body.shares).toHaveLength(0);
  });
});

describe("ABDM S1 e2e — NOT configured", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let cfg: AppConfig;
  let clerk: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({ DATABASE_URL: workerDbUrl(), SECRET_KEY: process.env.SECRET_KEY! });
    app = await boot(cfg, null);
  });
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    ({ clerk } = await seedDesk(db, cfg));
  });

  it("every counter ABDM route answers 503 abdm_not_configured, and the capability hides it all", async () => {
    const auth = { Authorization: `Bearer ${clerk}` };
    const s = app.getHttpServer();
    // Thunks, not requests: a supertest request starts its server when BUILT, and four built at once
    // share one ephemeral listener that the first to finish closes under the other three.
    for (const r of [
      () => request(s).post("/abdm/abha/verify").set(auth).send({ identifier: ABHA, method: "aadhaar_otp" }),
      () => request(s).post("/abdm/abha/create").set(auth).send({ aadhaar: "987654321098", patientConsented: true }),
      () => request(s).get("/abdm/scan-share/qr").set(auth),
      () => request(s).get("/abdm/scan-share/shares").set(auth),
    ]) {
      const res = await r();
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 503, code: "abdm_not_configured" });
    }
    const cap = await request(s).get("/patients/abha/capability").set(auth).expect(200);
    expect(cap.body).toMatchObject({ configured: false, canVerify: false, canCreate: false, canScanShare: false });
  });
});
