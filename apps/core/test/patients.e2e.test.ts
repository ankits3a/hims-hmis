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
import { registrationConfig, patientIdentityVersions, events, patients, patientAllergies, patientGuardians } from "../src/kernel/db/schema";
import { eq } from "drizzle-orm";
import { resolveIdentityAt } from "../src/modules/patients/identity";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 22c-A — THE HOOK BUDGET, raised to the `ot.e2e.test.ts` precedent (120s).
 *
 * This suite's `beforeEach` truncates ~100 tables, seeds the SoD pairs, syncs the permission
 * catalogue, grants EVERY `patients.*` string to a role, and creates two users with sessions —
 * for each of eighteen tests. jest's project default is `testTimeout: 15000`
 * (`jest.config.cjs:14`), and that budget covers the ASSERTIONS, not a fixture of this weight.
 *
 * 22c-A grew the suite from twelve tests to eighteen and pushed it over: the hook timed out under
 * load, and the next test then died on `registration_config_pkey` because the truncate it depended
 * on had never finished — one slow fixture reported as two unrelated failures. The tests are not
 * wrong and neither is the fixture; fifteen seconds was the wrong number for it, and it was the
 * wrong number before this phase too. `ot.e2e.test.ts:47` reached the same conclusion first.
 */
jest.setTimeout(120_000);

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
      .send({ name: "Asha Devi", sex: "female", phone: "9876543210", language: "hi", ageYears: 34 })
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

  /**
   * ═══ FD-8 — REGISTRATION ENDS AT THE UHID, SO THIS ROUTE NEEDED THE WALK-IN'S WARNING ═══
   *
   * Desk One registers and seats as two stages, which makes `POST /patients` the front desk's way of
   * creating a patient. It had NO duplicate check, while `POST /opd/walk-in` — until now the
   * counter's only creating route — has had one since 07b. Moving to the authorised flow without
   * this would have silently deleted the near-match warning FD-7 T1 had just made readable.
   *
   * DD8's rule is carried over exactly: a WARNING a human may override, never a gate.
   */
  it("FD-8: a second registration matching an existing patient is REFUSED with the candidates, and can be acknowledged", async () => {
    const first = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Ramesh Kale", sex: "male", phone: "9876540002", ageYears: 45 })
      .expect(201);

    // Same person again: 409, and the body carries what the clerk needs to TELL THEM APART.
    const clash = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Ramesh Kale", sex: "male", phone: "9876540002", ageYears: 45 })
      .expect(409);
    expect(clash.body.code).toBe("duplicate_suspected");
    const candidates = clash.body.detail.candidates as { id: string; phone: string; matchedOn: string[] }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(first.body.patient.id);
    expect(candidates[0]!.phone).toBe("9876540002");
    // FD-7 T1's union: this row matched on BOTH probes, and both are reported.
    expect([...candidates[0]!.matchedOn].sort()).toEqual(["mobile", "name"]);

    // THE WAY THROUGH (DD8). A real second Ramesh Kale on a shared family phone must be registrable.
    const acknowledged = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Ramesh Kale", sex: "male", phone: "9876540002", ageYears: 45, acknowledgedDuplicates: true })
      .expect(201);
    expect(acknowledged.body.patient.id).not.toBe(first.body.patient.id);
  });

  it("FD-8: a first-of-their-name registration is not refused", async () => {
    await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Nobody Alike", sex: "female", phone: "9812345678", ageYears: 29 })
      .expect(201);
  });

  /**
   * WASA N-01 — REGISTRATION REFUSES A KEY IT DOES NOT KNOW, as the amendment body has since C1.
   * zod strips unknown keys by default, so `blood_group` in snake_case (a plausible integration) or
   * a stray `isVip` came back 201 with that value silently gone. Silence on an unknown key is the
   * wrong default for the route that creates a person's record: the caller learns nothing was kept
   * only weeks later, from the record.
   */
  it("N-01: an unknown key is a 400 that names it, and nothing is registered", async () => {
    for (const extra of [{ blood_group: "B+" }, { isVip: true }, { balanceOverride: 0 }]) {
      const res = await request(app.getHttpServer())
        .post("/patients").set(...auth(clerkToken))
        .send({ name: "Stray Key", sex: "female", phone: "9812300001", ...extra })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(Object.keys(extra)[0]);
    }
    const found = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "9812300001" }).set(...auth(clerkToken)).expect(200);
    expect(found.body.items).toHaveLength(0);
  });

  it("N-01: the keys the Desk One form sends are all still accepted", async () => {
    // `apps/web/src/screens/desk-one/session.ts` `registerBodyOf` — every scalar it can emit.
    await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({
        name: "Full Form", sex: "female", phone: "9812300002", ageYears: 34, addressLine: "12 Civil Lines",
        altPhone: "9812300003", title: "Mrs", fatherHusbandName: "Ravi Kumar", maritalStatus: "married",
        bloodGroup: "B+", language: "hi", district: "Kanpur Nagar", stateName: "Uttar Pradesh", pincode: "208001",
        abhaNumber: "12-3456-7890-1234", abhaAddress: "full.form@abdm", abhaVerificationStatus: "self_declared",
        nationality: "Indian", nationalIdType: "aadhaar", nationalIdMasked: "1234", religion: "Hindu",
        occupation: "Teacher", monthlyIncomePaise: 2_500_000, legacyUhid: "OLD-778", promotionalOptIn: true,
        referredBySource: "doctor", referredByName: "Dr Mehta", referredByPhone: "9812300004",
        referredBySpeciality: "Cardiology", acknowledgedDuplicates: true,
      })
      .expect(201);
  });

  /*
    DESK-FIXES E (2026-09-28 walk) — a registration with no age and no date of birth was accepted
    and the slip printed "Age: —". DECIDED (standard Indian hospital practice): age OR date of birth
    is mandatory at registration; an estimated age (`ageYears`) is allowed.
  */
  it("DESK-FIXES E: neither age nor date of birth is a 400 that names the rule, and nothing is registered", async () => {
    const res = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Ageless Person", sex: "male", phone: "9812300077" })
      .expect(400);
    expect(res.body.code).toBe("age_or_dob_required");
    const found = await request(app.getHttpServer())
      .get("/patients/search").query({ q: "9812300077" }).set(...auth(clerkToken)).expect(200);
    expect(found.body.items).toHaveLength(0);
    // Either one satisfies it — an estimated age is ordinary at an Indian counter.
    await request(app.getHttpServer()).post("/patients").set(...auth(clerkToken))
      .send({ name: "Mohan Lal Verma", sex: "male", phone: "7012300078", ageYears: 60 }).expect(201);
    await request(app.getHttpServer()).post("/patients").set(...auth(clerkToken))
      .send({ name: "Kamla Bai Joshi", sex: "female", phone: "8123400079", dob: "1990-01-02" }).expect(201);
  });

  /*
    DESK-FIXES F (2026-09-28 walk) — every patient without a photo logged a red 404 in the console
    (18 on one walk). "No photo" is an ordinary answer, so it is 204 No Content. A patient the reader
    cannot see (unknown, or sealed without the grant) is STILL 404, so the route confirms nothing.
  */
  it("DESK-FIXES F: no photo on file is 204, not an error; an unknown patient is still 404", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Faceless F", sex: "other", ageYears: 40 }).expect(201);
    const none = await request(app.getHttpServer())
      .get(`/patients/${reg.body.patient.id as string}/photo`).set(...auth(clerkToken));
    expect(none.status).toBe(204);
    expect(none.text).toBe("");
    await request(app.getHttpServer())
      .get("/patients/01NOSUCH00000000000000000/photo").set(...auth(clerkToken)).expect(404);
    await request(app.getHttpServer())
      .get(`/patients/${reg.body.patient.id as string}/photo`).set(...auth(randoToken)).expect(403);
  });

  it("photo round-trips as base64 JSON — a ~300 kB body proves the parser bump", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Photo P", sex: "other", ageYears: 30 }).expect(201);
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

  /**
   * ═══ WASA L-05 — A CHILD ROUTE ACTS ONLY ON A CHILD OF THE PATIENT IN ITS PATH ═══
   *
   * `POST :id/allergies/:allergyId/entered-in-error`, `PATCH :id/guardians/:guardianId` and
   * `POST :id/guardians/:guardianId/end` used to act on the child id alone — `:id` was never read —
   * so patient A's URL could correct patient B's allergy, and the sealed-record gate the READS run
   * was skipped. Now the parent is resolved through `getPatient` first (merge chain + the sealed
   * gate) and a child of anybody else is a 404, with nothing written.
   */
  describe("WASA L-05 — nested routes are bound to their parent", () => {
    async function aMinor(name: string): Promise<{ id: string; allergyId: string; guardianId: string }> {
      const reg = await request(app.getHttpServer())
        .post("/patients").set(...auth(clerkToken))
        .send({ name, sex: "other", ageYears: 10, guardian: { name: `${name} parent`, relationship: "mother" } })
        .expect(201);
      const id = reg.body.patient.id as string;
      const allergy = await request(app.getHttpServer())
        .post(`/patients/${id}/allergies`).set(...auth(clerkToken))
        .send({ substance: "penicillin", severity: "severe", source: "registration" }).expect(201);
      const guardians = await request(app.getHttpServer())
        .get(`/patients/${id}/guardians`).set(...auth(clerkToken)).expect(200);
      return { id, allergyId: allergy.body.allergyId as string, guardianId: guardians.body.items[0].guardian.id as string };
    }
    const allergyStatus = async (id: string): Promise<string> =>
      (await db.select().from(patientAllergies).where(eq(patientAllergies.id, id)))[0]!.status;
    const guardianRow = async (id: string) =>
      (await db.select().from(patientGuardians).where(eq(patientGuardians.id, id)))[0]!;

    it("allergy entered-in-error under ANOTHER patient's id is a 404 and the allergy stays active", async () => {
      const a = await aMinor("Parent Path A");
      const b = await aMinor("Child Owner B");
      const res = await request(app.getHttpServer())
        .post(`/patients/${a.id}/allergies/${b.allergyId}/entered-in-error`)
        .set(...auth(clerkToken)).send({ reason: "wrong record" });
      expect(res.status).toBe(404);
      expect(await allergyStatus(b.allergyId)).toBe("active");
    });

    it("guardian PATCH under ANOTHER patient's id is a 404 and the guardian is unchanged; under its own it succeeds", async () => {
      const a = await aMinor("Parent Path C");
      const b = await aMinor("Child Owner D");
      const before = await guardianRow(b.guardianId);
      const res = await request(app.getHttpServer())
        .patch(`/patients/${a.id}/guardians/${b.guardianId}`)
        .set(...auth(clerkToken)).send({ dsr: true });
      expect(res.status).toBe(404);
      expect(await guardianRow(b.guardianId)).toEqual(before);

      await request(app.getHttpServer())
        .patch(`/patients/${b.id}/guardians/${b.guardianId}`)
        .set(...auth(clerkToken)).send({ dsr: true }).expect(200);
      expect((await guardianRow(b.guardianId)).authorityDsr).toBe(true);
    });

    it("guardian END under ANOTHER patient's id is a 404 and the guardian stays active", async () => {
      const a = await aMinor("Parent Path E");
      const b = await aMinor("Child Owner F");
      const res = await request(app.getHttpServer())
        .post(`/patients/${a.id}/guardians/${b.guardianId}/end`)
        .set(...auth(clerkToken));
      expect(res.status).toBe(404);
      expect((await guardianRow(b.guardianId)).status).toBe("active");
    });

    it("the SEALED-record gate runs first: an updater without the confidential grant gets 404 and writes nothing", async () => {
      const sealed = await aMinor("Sealed Patient G");
      await db.update(patients).set({ isConfidential: true }).where(eq(patients.id, sealed.id));
      await createRole(db, "reg_update_only", "Updates, no sealed read");
      await grantPermissionToRole(db, registry, "reg_update_only", "patients.update");
      await grantPermissionToRole(db, registry, "reg_update_only", "patients.read");
      const { id: userId } = await createUser(db, { username: "updater", fullName: "updater", password: "p1234567" });
      const { token } = await createSession(db, cfg, userId);
      await assignRole(db, { userId, roleKey: "reg_update_only", scopeType: "hospital" });

      const allergy = await request(app.getHttpServer())
        .post(`/patients/${sealed.id}/allergies/${sealed.allergyId}/entered-in-error`)
        .set(...auth(token)).send({ reason: "wrong record" });
      expect(allergy.status).toBe(404);
      const patch = await request(app.getHttpServer())
        .patch(`/patients/${sealed.id}/guardians/${sealed.guardianId}`)
        .set(...auth(token)).send({ dsr: true });
      expect(patch.status).toBe(404);
      const end = await request(app.getHttpServer())
        .post(`/patients/${sealed.id}/guardians/${sealed.guardianId}/end`)
        .set(...auth(token));
      expect(end.status).toBe(404);
      expect(await allergyStatus(sealed.allergyId)).toBe("active");
      expect(await guardianRow(sealed.guardianId)).toMatchObject({ status: "active", authorityDsr: false });
    });
  });

  it("QR: card payload prints, verify resolves, tampering answers ok:false over HTTP 200 (route order proven)", async () => {
    const reg = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken))
      .send({ name: "Card C", sex: "male", phone: "9000000001", ageYears: 50 }).expect(201);
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
      .post("/patients").set(...auth(clerkToken)).send({ name: "A", sex: "male", ageYears: 40 }).expect(201);
    const b = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "B", sex: "male", ageYears: 40 }).expect(201);
    await request(app.getHttpServer())
      .post("/patients/merge-requests").set(...auth(clerkToken))
      .send({ winnerId: a.body.patient.id, loserId: b.body.patient.id, note: "dup" })
      .expect(409); // unknown approval type patient_merge — registration is go-live data, T10 exercises the full path
  });

  /*
    UX-AUDIT 2026-09-28 · BOARD (merge review) — the two new reads are reached, not swallowed by
    `@Get(":id")` (which would read `merge-requests` / `merge-visits` as a patient id and 404).
  */
  it("BOARD: the merge-requests list and merge-visits reads answer on their own routes", async () => {
    const list = await request(app.getHttpServer())
      .get("/patients/merge-requests").set(...auth(clerkToken)).expect(200);
    expect(list.body).toEqual({ items: [] });
    const a = await request(app.getHttpServer())
      .post("/patients").set(...auth(clerkToken)).send({ name: "Visit Count", sex: "male", ageYears: 40 }).expect(201);
    const visits = await request(app.getHttpServer())
      .get(`/patients/merge-visits?ids=${String(a.body.patient.id)}`).set(...auth(clerkToken)).expect(200);
    expect(visits.body).toEqual({ items: [{ patientId: a.body.patient.id, visits: 0, lastVisitOn: null }] });
    await request(app.getHttpServer()).get("/patients/merge-visits").set(...auth(clerkToken)).expect(400);
    await request(app.getHttpServer()).get("/patients/merge-requests").set(...auth(randoToken)).expect(403);
  });

  /**
   * PLAN 22c-A T7 — THE AMENDMENT SURFACE, END TO END: register → amend → resolve as of the
   * moment the first document would have been issued. This is the phase's whole promise in one
   * test, taken over HTTP rather than against the service, because the reason-class requirement
   * lives on the route.
   */
  describe("22c-A T7 — the amendment surface", () => {
    async function registerAsha(): Promise<string> {
      const reg = await request(app.getHttpServer())
        .post("/patients").set(...auth(clerkToken))
        .send({ name: "Asha Devi", sex: "female", phone: "9811111111", language: "hi", ageYears: 34 })
        .expect(201);
      return reg.body.patient.id as string;
    }

    /* OWNER RULING 2026-09-29 (law) — the wire half: a date of death without the certificate number
       is a 400 whose body names the code and says what is missing in a sentence the screen can show. */
    it("REFUSES recording a death without the death certificate number, and accepts it with one", async () => {
      const id = await registerAsha();
      const res = await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ deceasedAt: "2026-09-28T10:00:00.000Z" })
        .expect(400);
      expect(res.body).toMatchObject({ code: "death_certificate_required" });
      expect(String(res.body.message)).toMatch(/death certificate number/);
      const ok = await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ deceasedAt: "2026-09-28T10:00:00.000Z", deathCertificateNo: "MCCD/2026/0412" })
        .expect(200);
      expect(ok.body.patient).toMatchObject({ deathCertificateNo: "MCCD/2026/0412" });
    });

    it("REFUSES a Class I amendment that does not say why", async () => {
      const id = await registerAsha();
      const res = await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ name: "Asha Sharma" })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/reason_required/);
    });

    it("ACCEPTS a Class II edit with no reason — the desk does not justify a typo fix", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ phone: "9822222222" })
        .expect(200);
    });

    it("REFUSES an unknown reason class rather than storing free text", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ name: "Asha Sharma", reasonClass: "because I said so" })
        .expect(400);
    });

    it("register → amend → the document as of issue still shows the ORIGINAL name", async () => {
      const id = await registerAsha();

      // What a document issued now would resolve to.
      const atIssue = new Date();
      const before = await resolveIdentityAt(db, id, atIssue);
      expect(before!.name).toBe("Asha Devi");

      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ name: "Asha Sharma", reasonClass: "legal_change", evidenceRef: "GAZETTE-2026-1187" })
        .expect(200);

      // The live record moved…
      const read = await request(app.getHttpServer())
        .get(`/patients/${id}`).set(...auth(clerkToken)).expect(200);
      expect(read.body.patient.name).toBe("Asha Sharma");

      // …and the document does not. This is the Medanta failure, not reproduced.
      const stillAsIssued = await resolveIdentityAt(db, id, atIssue);
      expect(stillAsIssued!.name).toBe("Asha Devi");
      expect(stillAsIssued!.version).toBe(1);
    });

    /**
     * CLOSE REVIEW C1 — THE ROUND-TRIP THAT WAS MISSING, and its absence is why a CRITICAL shipped.
     * Every other test amends `administrativeGender` by calling `updatePatient` directly; the wire
     * was never exercised, and the wire was where the field was being silently dropped.
     */
    it("C1 — PATCHing administrative gender over HTTP actually writes it and mints a version", async () => {
      const id = await registerAsha();
      const res = await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ administrativeGender: "other", reasonClass: "legal_change", evidenceRef: "NALSA-2026-42" })
        .expect(200);
      // The old defect returned 200 with `changed: []` and wrote nothing.
      expect(res.body.changed).toEqual(["administrativeGender"]);

      const read = await request(app.getHttpServer())
        .get(`/patients/${id}`).set(...auth(clerkToken)).expect(200);
      expect(read.body.patient.administrativeGender).toBe("other");

      const versions = await db.select().from(patientIdentityVersions)
        .where(eq(patientIdentityVersions.patientId, id));
      expect(versions).toHaveLength(2);
      expect(versions.find((v) => v.version === 2)!.administrativeGender).toBe("other");
      expect(versions.find((v) => v.version === 2)!.reasonClass).toBe("legal_change");
    });

    it("C1 — and it still refuses to change gender without a reason", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ administrativeGender: "other" })
        .expect(400);
    });

    it("M2 — `evidencedAt` alone cannot hold the stamp; it needs the reference too", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .post(`/patients/${id}/assurance`).set(...auth(clerkToken))
        .send({ toLevel: "abha_verified", evidenceRef: "ABHA-11-2222-3333-4444" }).expect(201);

      // A bare claim, with nothing named as evidence, must NOT hold abha_verified.
      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ name: "Different Person", reasonClass: "clerical_error", evidencedAt: "abha_verified" })
        .expect(200);
      const read = await request(app.getHttpServer())
        .get(`/patients/${id}`).set(...auth(clerkToken)).expect(200);
      expect(read.body.patient.identityAssurance).toBe("staff_verified");
    });

    it("M3 — an assurance UPGRADE writes an event naming who vouched and against what", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .post(`/patients/${id}/assurance`).set(...auth(clerkToken))
        .send({ toLevel: "id_verified", evidenceRef: "AADHAAR-XXXX-1234" }).expect(201);
      const evts = await db.select().from(events).where(eq(events.name, "patient.identity_assurance_changed"));
      expect(evts).toHaveLength(1);
      expect(evts[0]!.payload).toMatchObject({
        from: "staff_verified", to: "id_verified", reason: "upgrade", evidenceRef: "AADHAAR-XXXX-1234",
      });
    });

    it("m8 — a privacy-write denial is 403, not 400", async () => {
      // `reg_desk` holds every patients permission in this harness, so a second actor without the
      // new string is what exercises the refusal.
      const { id: plainId } = await createUser(db, { username: "plainclerk", fullName: "Plain", password: "p1234567" });
      const { token: plainToken } = await createSession(db, cfg, plainId);
      await createRole(db, "update_only", "Update only");
      for (const p of ["patients.register", "patients.read", "patients.update"]) {
        await grantPermissionToRole(db, registry, "update_only", p);
      }
      await assignRole(db, { userId: plainId, roleKey: "update_only", scopeType: "hospital" });
      const id = await registerAsha();
      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(plainToken))
        .send({ isConfidential: true, alias: "P-4821" })
        .expect(403);
    });

    it("m9 — REGISTERING a confidential patient still needs only `patients.register` (RULED)", async () => {
      /**
       * THIS TEST ASSERTED 403 UNTIL THE SECOND CLOSE REVIEW CALLED IT, and it was the clearest
       * kind of defect: I gated registration in response to the first review's m9, saw the gate
       * break eight shipped tests, reverted the gate — and left this test behind asserting the
       * behaviour I had just decided against. A test that outlives the decision it encodes does
       * not merely fail; it documents the opposite of the ruling to whoever reads it next.
       *
       * The ruling, restated where it is now enforced: `POST /patients` accepts `isConfidential`
       * under `patients.register` alone, because marking a VIP or a staff-as-patient confidential
       * AT THE COUNTER is an ordinary front-office act. DD7's permission governs changing an
       * EXISTING patient's privacy flag — a decision about a record others may already have seen.
       */
      const { id: plainId } = await createUser(db, { username: "regonly", fullName: "Reg", password: "p1234567" });
      const { token: plainToken } = await createSession(db, cfg, plainId);
      await createRole(db, "register_only", "Register only");
      for (const p of ["patients.register", "patients.read"]) {
        await grantPermissionToRole(db, registry, "register_only", p);
      }
      await assignRole(db, { userId: plainId, roleKey: "register_only", scopeType: "hospital" });
      const res = await request(app.getHttpServer())
        .post("/patients").set(...auth(plainToken))
        .send({ name: "VIP", sex: "male", isConfidential: true, alias: "P-9001", language: "hi", ageYears: 55 })
        .expect(201);
      expect(res.body.patient.isConfidential).toBe(true);

      // …and the SAME actor cannot change that flag afterwards. This is the asymmetry, in one test.
      await request(app.getHttpServer())
        .patch(`/patients/${res.body.patient.id as string}`).set(...auth(plainToken))
        .send({ isConfidential: false })
        .expect(403);
    });

    it("the assurance route raises the stamp, and an unevidenced amendment drops it again (DD5)", async () => {
      const id = await registerAsha();
      const up = await request(app.getHttpServer())
        .post(`/patients/${id}/assurance`).set(...auth(clerkToken))
        .send({ toLevel: "id_verified", evidenceRef: "AADHAAR-XXXX-1234" })
        .expect(201);
      expect(up.body).toEqual({ from: "staff_verified", to: "id_verified" });

      await request(app.getHttpServer())
        .patch(`/patients/${id}`).set(...auth(clerkToken))
        .send({ name: "Asha Sharma", reasonClass: "patient_request" })
        .expect(200);

      const read = await request(app.getHttpServer())
        .get(`/patients/${id}`).set(...auth(clerkToken)).expect(200);
      // The amendment succeeded and the stamp told the truth about itself, which is DD5's whole
      // argument: refusing would have pushed the clerk into re-registering the patient.
      expect(read.body.patient.identityAssurance).toBe("staff_verified");
    });

    it("REFUSES a downgrade through the assurance route", async () => {
      const id = await registerAsha();
      await request(app.getHttpServer())
        .post(`/patients/${id}/assurance`).set(...auth(clerkToken))
        .send({ toLevel: "self_declared" })
        .expect(409);
    });
  });
});
