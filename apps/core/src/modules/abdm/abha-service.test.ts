import { and, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { events, patientIdentityVersions, patients, phiAccessLog, registrationConfig } from "../../kernel/db/schema";
import { loadConfig } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import { registerPatient, updatePatient } from "../patients";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { createUser } from "../../kernel/auth/identity";
import { authManifest } from "../../kernel/auth/manifest";
import { patientsManifest } from "../patients";
import type { FakeAbhaAccount } from "../../../test/helpers/abdm-fake-gateway";
import { ABHA_TXN_TTL_MS } from "./abha-transactions";
import { AbhaFlowError } from "./abha-service";
import { AbdmRuntime } from "./runtime";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S1 — the counter's ABHA flows, end to end against the fake: verify an existing ABHA by OTP,
 * see ABDM's profile beside ours, link it — and the patient becomes `verified` ONLY through
 * `recordAbhaVerifiedByAbdm` (the ABDM system actor, the Class I identity version). Plus the three
 * things that must never happen: a demographic overwritten, an Aadhaar number or OTP stored, and a
 * stale or foreign handle honoured.
 */
const SECRET = "Sbx-Secret-abha-service-never-stored";
const ABHA = "91-2345-6789-0123";
const clerk: Actor = { type: "user", id: "clerk-1" };
const otherClerk: Actor = { type: "user", id: "clerk-2" };

describe("AbhaService", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    clock = Date.parse("2026-09-25T10:00:00.000Z");
  });

  const setup = (env: Record<string, string> = {}) => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock });
    /* Held by reference in the fake: changing it is ABDM's record changing (a re-verification later). */
    const sunita: FakeAbhaAccount = {
      ABHANumber: ABHA, preferredAbhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", gender: "F",
      yearOfBirth: "1986", monthOfBirth: "3", dayOfBirth: "14", mobile: "******3210",
    };
    fake.abha.addAccount(sunita);
    const cfg = loadConfig({
      DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_ABHA_BASE_URL: fake.abha.baseUrl,
      ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: "IN0000000001",
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks", ...env,
    });
    const runtime = new AbdmRuntime(cfg, db, fake.fetch, now);
    return { fake, runtime, svc: runtime.abhaService, sunita };
  };

  /** Give `userId` (created here) `patients.read` — the grant that lets a refusal name the holder's UHID. */
  const grantRead = async (userId: string): Promise<void> => {
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "reader", "Reader");
    await grantPermissionToRole(db, registry, "reader", "patients.read");
    await assignRole(db, { userId, roleKey: "reader", scopeType: "hospital" });
  };

  const register = (over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => registerPatient(tx, clerk, {
      name: "Sunita Sharma", sex: "female", phone: "9876543210", dob: new Date("1986-03-14T00:00:00.000Z"), ...over,
    }));

  /** Every row of the tables an ABDM flow writes, as the text Postgres would hand anyone. */
  const everythingStored = async (): Promise<string> => {
    const q = async (t: string): Promise<string> =>
      ((await db.execute(sql.raw(`select coalesce(json_agg(x)::text, '') as t from ${t} x`))).rows[0] as { t: string }).t;
    return [await q("abdm_messages"), await q("abdm_profile_shares"), await q("events"), await q("phi_access_log"), await q("patients"), await q("patient_identity_versions")].join("\n");
  };

  it("verify → OTP → link: the patient becomes verified through recordAbhaVerifiedByAbdm, and the browser's view carries no ABDM secret", async () => {
    const { fake, svc } = setup();
    const { patient } = await register({ abhaNumber: ABHA, abhaVerificationStatus: "self_declared" });

    const started = await svc.startVerification(clerk, { identifier: "91 2345 6789 0123", method: "aadhaar_otp", patientId: patient.id });
    expect(started).toMatchObject({ stage: "otp_sent", purpose: "verify", kind: "abha_number", otpMethod: "aadhaar_otp", profile: null });
    expect(started.message).toMatch(/\*\*\*\*1234/);

    const done = await svc.submitOtp(clerk, started.transactionId, { otp: "314159" });
    expect(done.stage).toBe("authenticated");
    expect(done.profile).toMatchObject({ abhaNumber: ABHA, abhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", dob: "1986-03-14", gender: "female" });
    expect(done.comparison?.every((c) => c.result === "same")).toBe(true);

    // The view is what the browser gets: no txnId, no X-token, no refresh token.
    const viewText = JSON.stringify(done);
    const abdmTxnIds = fake.requests.flatMap((r) => (r.path === "/v3/profile/login/verify" ? [String((r.body as { authData: { otp: { txnId: string } } }).authData.otp.txnId)] : []));
    expect(abdmTxnIds).toHaveLength(1);
    expect(viewText).not.toContain(abdmTxnIds[0]!);
    for (const t of fake.abha.xTokensIssued()) expect(viewText).not.toContain(t);

    const linked = await svc.link(clerk, started.transactionId, { patientId: patient.id });
    expect(linked.changed.sort()).toEqual(["abhaAddress", "abhaVerificationStatus"]);
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: ABHA, abhaAddress: "sunita.sharma@sbx" });

    // ONLY via recordAbhaVerifiedByAbdm: the change is the ABDM system actor's, not the clerk's.
    const updates = await db.select().from(events).where(and(eq(events.name, "patient.updated"), eq(events.patientId, patient.id)));
    expect(updates.map((e) => [e.actorType, e.actorId])).toEqual([["system", "abdm"]]);
    // The PHI audit: the profile read (at the OTP) and the link, both for this patient.
    const phi = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.abha_profile"));
    expect(phi.length).toBeGreaterThanOrEqual(2);
    expect(new Set(phi.map((p) => p.patientId))).toEqual(new Set([patient.id]));
    // The log: every step, the clerk on each, the patient named.
    const out = (await db.execute(sql`select kind, actor_id, patient_id from abdm_messages where kind like 'abha.%' order by created_at`)).rows as Array<{ kind: string; actor_id: string | null; patient_id: string | null }>;
    expect(out.map((r) => r.kind)).toEqual(expect.arrayContaining(["abha.certificate", "abha.login.request_otp", "abha.login.verify", "abha.profile"]));
    expect(out.filter((r) => r.kind !== "abha.certificate").every((r) => r.actor_id === "clerk-1" && r.patient_id === patient.id)).toBe(true);

    // The handle is spent.
    await expect(svc.current(clerk, started.transactionId)).rejects.toMatchObject({ code: "abdm_transaction_not_found" });
  });

  it("DECIDED — differences are SHOWN, refused until the clerk accepts ABDM's details, then taken through the amendment path; mobile stays", async () => {
    const { svc } = setup();
    const { patient } = await register({ name: "Sunita Verma", phone: "9000000000", dob: new Date("1990-01-01T00:00:00.000Z") });
    const t = await svc.startVerification(clerk, { identifier: ABHA, method: "mobile_otp", patientId: patient.id });
    const shownView = await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
    // What the link will take, shown before it is taken
    expect(shownView.demographicsToApply).toEqual([
      { field: "name", from: "Sunita Verma", to: "Sunita Sharma" },
      { field: "dob", from: "1990-01-01", to: "1986-03-14" },
    ]);

    const refusal = await svc.link(clerk, t.transactionId, { patientId: patient.id }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AbhaFlowError);
    expect((refusal as AbhaFlowError).code).toBe("abha_profile_mismatch");
    const shown = (refusal as AbhaFlowError).detail as { comparison: Array<{ field: string; result: string }>; demographicsToApply: unknown[] };
    expect(shown.comparison.filter((c) => c.result === "differs").map((c) => c.field)).toEqual(["name", "dob", "mobile"]);
    expect(shown.demographicsToApply).toHaveLength(2);
    const [untouched] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(untouched).toMatchObject({ abhaVerificationStatus: "none", name: "Sunita Verma" });

    await svc.link(clerk, t.transactionId, { patientId: patient.id, acceptAbdmDemographics: true });
    const [after] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(after).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: ABHA, name: "Sunita Sharma", dobEstimated: false, phone: "9000000000" });
    expect(after!.dob?.toISOString().slice(0, 10)).toBe("1986-03-14");

    // THROUGH THE AMENDMENT PATH: the clerk's patient.updated for the demographics, ABDM's for the ABHA,
    // and a Class I version evidenced `abdm_verified`.
    const updates = await db.select().from(events).where(and(eq(events.name, "patient.updated"), eq(events.patientId, patient.id)));
    expect(updates.map((e) => [e.actorType, e.actorId]).sort()).toEqual([["system", "abdm"], ["user", "clerk-1"]]);
    const versions = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, patient.id));
    const byClerk = versions.find((v) => v.name === "Sunita Sharma" && v.abhaNumber === null)!;
    expect(byClerk).toMatchObject({ reasonClass: "document_correction", createdBy: "clerk-1" });
    expect(byClerk.evidenceRef).toMatch(/^abdm_verified \(M1 ABHA number verified by mobile OTP\)$/);
    expect(versions.find((v) => v.abhaNumber === ABHA)?.evidenceRef).toBe("ABDM M1 ABHA number verified by mobile OTP");
  });

  it("the LOCK: while verified, name / birth / gender refuse an amendment; mobile and address do not; re-verifying is the one way through", async () => {
    const { svc, sunita } = setup();
    const { patient } = await register();
    const t = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp", patientId: patient.id });
    await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
    await svc.link(clerk, t.transactionId, { patientId: patient.id });

    for (const change of [{ name: "Someone Else" }, { dob: new Date("1990-01-01T00:00:00.000Z") }, { administrativeGender: "male" as const }]) {
      await expect(withTx(db, (tx) => updatePatient(tx, clerk, patient.id, change, { reasonClass: "clerical_error" })))
        .rejects.toMatchObject({ code: "abha_demographics_locked" });
    }
    // Lowering the stamp IN THE SAME amendment does not unlock it — the record is verified as it begins.
    await expect(withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { name: "Someone Else", abhaVerificationStatus: "self_declared" }, { reasonClass: "clerical_error" })))
      .rejects.toMatchObject({ code: "abha_demographics_locked" });
    // Mobile and address stay the hospital's.
    const { changed } = await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { phone: "9811111111", addressLine: "New Colony" }));
    expect(changed.sort()).toEqual(["addressLine", "phone"]);

    // Re-verifying WHILE verified takes ABDM's (changed) name through the one door.
    sunita.name = "Sunita S. Sharma";
    const again = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp", patientId: patient.id });
    await svc.submitOtp(clerk, again.transactionId, { otp: "314159" });
    await svc.link(clerk, again.transactionId, { patientId: patient.id, acceptAbdmDemographics: true });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ name: "Sunita S. Sharma", abhaVerificationStatus: "verified", phone: "9811111111" });

    // A clerk may take the verification down (its own amendment) — and THEN the fields are theirs again.
    await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { abhaVerificationStatus: "self_declared" }));
    await withTx(db, (tx) => updatePatient(tx, clerk, patient.id, { name: "Sunita Sharma" }, { reasonClass: "clerical_error" }));
  });

  it("ONE ABHA, ONE PATIENT: a second record is refused at the link, naming the holder's UHID only to a user who may see it", async () => {
    const { svc } = setup();
    const { id: userId } = await createUser(db, { username: "desk", fullName: "Desk Clerk", password: "p1234567" });
    const me: Actor = { type: "user", id: userId };
    const { patient: first } = await register();
    const { patient: second } = await register({ phone: "9876543211", name: "Sunita Sharma" });
    const t1 = await svc.startVerification(me, { identifier: ABHA, method: "aadhaar_otp", patientId: first.id });
    await svc.submitOtp(me, t1.transactionId, { otp: "314159" });
    await svc.link(me, t1.transactionId, { patientId: first.id });

    const t2 = await svc.startVerification(me, { identifier: ABHA, method: "aadhaar_otp", patientId: second.id });
    const v2 = await svc.submitOtp(me, t2.transactionId, { otp: "314159" });
    // No patients.read grant yet — so the view says "elsewhere" and names nobody.
    expect(v2.linkedElsewhere).toEqual({ uhid: null });
    const refusal = await svc.link(me, t2.transactionId, { patientId: second.id }).catch((e: unknown) => e);
    expect((refusal as AbhaFlowError).code).toBe("abha_already_linked");
    expect((refusal as AbhaFlowError).detail).toEqual({ uhid: null });
    expect((refusal as Error).message).not.toContain(first.uhid);
    const [row] = await db.select().from(patients).where(eq(patients.id, second.id));
    expect(row!.abhaNumber).toBeNull();

    // THE ORDER OF REFUSALS: a duplicate is refused AS a duplicate before the clerk is asked to accept
    // ABDM's details — nobody should be walked through a demographics decision for a link that cannot happen.
    const { patient: third } = await register({ phone: "9876543212", name: "S. Sharma", dob: new Date("1990-01-01T00:00:00.000Z") });
    const t3 = await svc.startVerification(me, { identifier: ABHA, method: "aadhaar_otp", patientId: third.id });
    await svc.submitOtp(me, t3.transactionId, { otp: "314159" });
    await expect(svc.link(me, t3.transactionId, { patientId: third.id })).rejects.toMatchObject({ code: "abha_already_linked" });
    const [thirdRow] = await db.select().from(patients).where(eq(patients.id, third.id));
    expect(thirdRow).toMatchObject({ name: "S. Sharma", abhaNumber: null });

    // With the grant, the UHID is named ("already linked in HMIS with UHID X", VRFY_ABHA_303).
    await grantRead(userId);
    expect((await svc.current(me, t2.transactionId)).linkedElsewhere).toEqual({ uhid: first.uhid });
    await expect(svc.link(me, t2.transactionId, { patientId: second.id })).rejects.toMatchObject({ code: "abha_already_linked", detail: { uhid: first.uhid } });

    // The registration path refuses the same number too, in any spelling, before a UHID is spent —
    // and so does the database itself when the check is bypassed.
    await expect(withTx(db, (tx) => registerPatient(tx, me, { name: "Third", sex: "female", phone: "9876543299", abhaNumber: "91 2345 6789 0123", abhaVerificationStatus: "self_declared" })))
      .rejects.toMatchObject({ code: "abha_already_linked", detail: { uhid: first.uhid } });
    const constraintOf = (e: unknown): unknown =>
      (e as { constraint?: unknown }).constraint ?? (e as { cause?: { constraint?: unknown } }).cause?.constraint;
    expect(constraintOf(await db.execute(sql`update patients set abha_number = '91234567890123' where id = ${second.id}`).catch((e: unknown) => e))).toBe("patients_abha_number_ux");
    expect(constraintOf(await db.execute(sql`update patients set abha_address = ' SUNITA.SHARMA@SBX ' where id = ${second.id}`).catch((e: unknown) => e))).toBe("patients_abha_address_ux");
  });

  it("RESEND (CRT_ABHA_106): not before 60 s, at most twice, a new ABDM transaction each time", async () => {
    const { fake, svc } = setup();
    const t = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp" });
    expect(t.resend).toEqual({ availableAt: new Date(clock + 60_000).toISOString(), left: 2 });
    await expect(svc.resendOtp(clerk, t.transactionId)).rejects.toMatchObject({ code: "otp_resend_too_soon", detail: { retryAfterSeconds: 60 } });
    clock += 60_000;
    const r1 = await svc.resendOtp(clerk, t.transactionId);
    expect(r1.resend?.left).toBe(1);
    await expect(svc.resendOtp(clerk, t.transactionId)).rejects.toMatchObject({ code: "otp_resend_too_soon" });
    clock += 60_000;
    expect((await svc.resendOtp(clerk, t.transactionId)).resend?.left).toBe(0);
    clock += 60_000;
    await expect(svc.resendOtp(clerk, t.transactionId)).rejects.toMatchObject({ code: "otp_resend_limit" });
    expect(fake.requests.filter((r) => r.path === "/v3/profile/login/request/otp")).toHaveLength(3);
    // the OTP of the LAST send is the one that works
    await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
  });

  it("FIND BY MOBILE (VRFY_ABHA_301–305): an invalid mobile is refused; the found ABHAs are listed; one is chosen", async () => {
    const { fake, svc } = setup();
    fake.abha.addAccount({ ABHANumber: "91-1111-2222-3333", preferredAbhaAddress: "second@sbx", name: "Second Person", gender: "M", yearOfBirth: "1990", mobile: "******3210", mobileNumber: "9876543210" });
    await expect(svc.startVerification(clerk, { identifier: "1234567890", method: "mobile_otp" })).rejects.toMatchObject({ code: "mobile_invalid" });
    await expect(svc.startVerification(clerk, { identifier: "9000000000", method: "mobile_otp" })).rejects.toMatchObject({ code: "abdm_refused", message: expect.stringMatching(/ABHA Number not found/) });
    const t = await svc.startVerification(clerk, { identifier: "98765 43210", method: "aadhaar_otp" });
    expect(t).toMatchObject({ kind: "mobile", otpMethod: "mobile_otp" });
    const listed = await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
    expect(listed.stage).toBe("choose_account");
    expect(listed.accounts).toEqual([{ abhaNumber: "91-1111-2222-3333", abhaAddress: "second@sbx", name: "Second Person" }]);
    expect(JSON.stringify(listed)).not.toMatch(/fake-t-/);
    await expect(svc.chooseAccount(clerk, t.transactionId, { abhaNumber: ABHA })).rejects.toMatchObject({ code: "abha_account_not_offered" });
    const chosen = await svc.chooseAccount(clerk, t.transactionId, { abhaNumber: "91111122223333" });
    expect(chosen).toMatchObject({ stage: "authenticated", profile: { abhaNumber: "91-1111-2222-3333", name: "Second Person" } });
  });

  it("FIND BY AADHAAR (VRFY_ABHA_401–405): OFF with the create flag; on, it finds, re-sends only with the number typed again, and stores no Aadhaar", async () => {
    const off = setup();
    await expect(off.svc.startFindByAadhaar(clerk, { aadhaar: "555566667777", patientConsented: true })).rejects.toMatchObject({ code: "abha_find_by_aadhaar_disabled" });
    expect(off.fake.requests).toHaveLength(0);

    const { fake, svc } = setup({ ABDM_ABHA_CREATE_AADHAAR: "true" });
    fake.abha.addAccount({ ABHANumber: "91-7777-8888-9999", preferredAbhaAddress: "aadhaar.person@sbx", name: "Aadhaar Person", gender: "F", yearOfBirth: "1985", mobile: "******4321", aadhaar: "555566667777" });
    await expect(svc.startFindByAadhaar(clerk, { aadhaar: "555566667777", patientConsented: false })).rejects.toMatchObject({ code: "aadhaar_consent_required" });
    const bad = await svc.startFindByAadhaar(clerk, { aadhaar: "5555666677", patientConsented: true }).catch((e: unknown) => e);
    expect((bad as AbhaFlowError).code).toBe("aadhaar_invalid");
    expect((bad as Error).message).toMatch(/Aadhaar Number is not valid/);
    const t = await svc.startFindByAadhaar(clerk, { aadhaar: "5555 6666 7777", patientConsented: true });
    expect(t).toMatchObject({ kind: "aadhaar", resendNeedsAadhaar: true });
    clock += 60_000;
    await expect(svc.resendOtp(clerk, t.transactionId)).rejects.toMatchObject({ code: "aadhaar_invalid" });
    await svc.resendOtp(clerk, t.transactionId, { aadhaar: "555566667777" });
    const done = await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
    expect(done.profile?.abhaNumber).toBe("91-7777-8888-9999");
    expect(await everythingStored()).not.toMatch(/555566667777|5555 6666 7777|5555-6666-7777/);
  });
  it("an expired handle, an unknown one, and another clerk's are all refused — and a spent OTP step cannot run twice", async () => {
    const { svc } = setup();
    const t = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp" });
    await expect(svc.submitOtp(otherClerk, t.transactionId, { otp: "314159" })).rejects.toMatchObject({ code: "abdm_transaction_not_found" });
    await expect(svc.submitOtp(clerk, "00000000-0000-4000-8000-000000000000", { otp: "314159" })).rejects.toMatchObject({ code: "abdm_transaction_not_found" });

    const u = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp" });
    await svc.submitOtp(clerk, u.transactionId, { otp: "314159" });
    await expect(svc.submitOtp(clerk, u.transactionId, { otp: "314159" })).rejects.toMatchObject({ code: "abdm_transaction_wrong_step" });

    clock += ABHA_TXN_TTL_MS;
    await expect(svc.submitOtp(clerk, t.transactionId, { otp: "314159" })).rejects.toMatchObject({ code: "abdm_transaction_expired" });
    await expect(svc.current(clerk, u.transactionId)).rejects.toMatchObject({ code: "abdm_transaction_expired" });
  });

  it("a malformed OTP never reaches ABDM, and five wrong ones close the flow", async () => {
    const { fake, svc } = setup();
    const t = await svc.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp" });
    await expect(svc.submitOtp(clerk, t.transactionId, { otp: "12ab" })).rejects.toMatchObject({ code: "otp_invalid" });
    expect(fake.requests.filter((r) => r.path === "/v3/profile/login/verify")).toHaveLength(0);
    fake.abha.otp = "999999";
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.submitOtp(clerk, t.transactionId, { otp: "314159" })).rejects.toMatchObject({ code: "abdm_refused" });
    }
    await expect(svc.submitOtp(clerk, t.transactionId, { otp: "999999" })).rejects.toMatchObject({ code: "otp_attempts_exhausted" });
    await expect(svc.current(clerk, t.transactionId)).rejects.toMatchObject({ code: "abdm_transaction_not_found" });
  });

  it("an Aadhaar number typed into the ABHA box is refused before anything is sent", async () => {
    const { fake, svc } = setup();
    await expect(svc.startVerification(clerk, { identifier: "9876 5432 1098", method: "aadhaar_otp" })).rejects.toMatchObject({ code: "abha_identifier_invalid" });
    expect(fake.requests).toHaveLength(0);
  });

  it("CREATE is refused while the flag is off — and nothing about the Aadhaar number is sent or kept", async () => {
    const { fake, svc } = setup();
    const err = await svc.startCreate(clerk, { aadhaar: "9876 5432 1098", patientConsented: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbhaFlowError);
    expect((err as AbhaFlowError).code).toBe("abha_create_disabled");
    expect((err as Error).message).not.toMatch(/9876/);
    expect(fake.requests).toHaveLength(0);
    expect(await everythingStored()).not.toMatch(/9876/);
  });

  it("CREATE works on the fake when switched on — and the Aadhaar number and OTP appear in no stored row and no error", async () => {
    const { fake, svc } = setup({ ABDM_ABHA_CREATE_AADHAAR: "true" });
    const AADHAAR = "987654321098";
    await expect(svc.startCreate(clerk, { aadhaar: AADHAAR, patientConsented: false })).rejects.toMatchObject({ code: "aadhaar_consent_required" });
    const bad = await svc.startCreate(clerk, { aadhaar: "98765432109", patientConsented: true }).catch((e: unknown) => e);
    expect((bad as AbhaFlowError).code).toBe("aadhaar_invalid");
    expect((bad as Error).message).not.toContain("98765432109");

    const t = await svc.startCreate(clerk, { aadhaar: "9876 5432 1098", patientConsented: true });
    expect(t).toMatchObject({ purpose: "create", kind: "aadhaar_enrolment", stage: "otp_sent" });
    expect(fake.abha.enrolledAadhaar).toEqual([AADHAAR]);

    // A wrong OTP first — the fake's refusal ECHOES both the OTP and the Aadhaar number.
    fake.abha.otp = "424242";
    const wrong = await svc.submitOtp(clerk, t.transactionId, { otp: "535353", mobile: "9812345678" }).catch((e: unknown) => e);
    expect(String((wrong as Error).message)).not.toMatch(/987654321098|9876 5432 1098|535353/);

    const made = await svc.submitOtp(clerk, t.transactionId, { otp: "424242", mobile: "9812345678" });
    expect(made).toMatchObject({ stage: "authenticated", isNew: true, profile: { name: "Kamla Devi", dob: "1979-07-02", gender: "female" } });
    const { patient } = await register({ name: "Kamla Devi", phone: "9812345678", dob: new Date("1979-07-02T00:00:00.000Z") });
    await svc.link(clerk, t.transactionId, { patientId: patient.id });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: made.profile!.abhaNumber });

    const stored = await everythingStored();
    expect(stored).not.toMatch(/987654321098|9876 5432 1098|9876-5432-1098/);
    expect(stored).not.toMatch(/424242|535353/);
  });

  it("CREATE, then a DIFFERENT mobile (CRT_ABHA_109) and a new ABHA address (CRT_ABHA_112)", async () => {
    const { fake, svc } = setup({ ABDM_ABHA_CREATE_AADHAAR: "true" });
    const t = await svc.startCreate(clerk, { aadhaar: "987654321098", patientConsented: true });
    // the SAME mobile as Aadhaar's needs no check (CRT_ABHA_108) — tested in "CREATE works…"; this one differs
    const made = await svc.submitOtp(clerk, t.transactionId, { otp: "314159", mobile: "9000011111" });
    expect(made.mobileVerification).toBe("required");
    await expect(svc.verifyMobileOtp(clerk, t.transactionId, { otp: "314159" })).rejects.toMatchObject({ code: "abdm_transaction_wrong_step" });
    const sent = await svc.sendMobileOtp(clerk, t.transactionId);
    expect(sent).toMatchObject({ mobileVerification: "otp_sent", message: expect.stringMatching(/1111$/) });
    await expect(svc.sendMobileOtp(clerk, t.transactionId)).rejects.toMatchObject({ code: "otp_resend_too_soon" });
    fake.abha.otp = "000000";
    await expect(svc.verifyMobileOtp(clerk, t.transactionId, { otp: "123123" })).rejects.toMatchObject({ code: "abdm_refused" });
    fake.abha.otp = "314159";
    const verified = await svc.verifyMobileOtp(clerk, t.transactionId, { otp: "314159" });
    expect(verified).toMatchObject({ mobileVerification: "verified", profile: { mobile: "9000011111" } });

    const suggested = await svc.suggestAddresses(clerk, t.transactionId);
    expect(suggested.addressSuggestions!.length).toBeGreaterThanOrEqual(3);
    for (const bad of ["short", "has..two.dots", "._starts", "ends_", "a.b.c.d1234", "two__under", "way.too.long.address.here", "bad!chars12"]) {
      await expect(svc.createAddress(clerk, t.transactionId, { abhaAddress: bad })).rejects.toMatchObject({ code: "abha_address_invalid" });
    }
    const chosen = await svc.createAddress(clerk, t.transactionId, { abhaAddress: suggested.addressSuggestions![0]! });
    expect(chosen.profile?.abhaAddress).toBe(`${suggested.addressSuggestions![0]!}@sbx`);
    fake.abha.takenAddresses.add("kamla.devi22@sbx");
    await expect(svc.createAddress(clerk, t.transactionId, { abhaAddress: "kamla.devi22@sbx" })).rejects.toMatchObject({ code: "abdm_refused", message: "ABHA Address is already exist" });

    const { patient } = await register({ name: "Kamla Devi", phone: "9000011111", dob: new Date("1979-07-02T00:00:00.000Z") });
    await svc.link(clerk, t.transactionId, { patientId: patient.id });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaAddress: chosen.profile!.abhaAddress });
    expect(await everythingStored()).not.toMatch(/987654321098|9876 5432 1098|314159|123123/);
  });

  it("an ABHA address verifies through the PHR login and links the same way", async () => {
    const { svc } = setup();
    const { patient } = await register();
    const t = await svc.startVerification(clerk, { identifier: "sunita.sharma", method: "mobile_otp", patientId: patient.id });
    expect(t.kind).toBe("abha_address");
    const done = await svc.submitOtp(clerk, t.transactionId, { otp: "314159" });
    expect(done.profile?.abhaNumber).toBe(ABHA);
    await svc.link(clerk, t.transactionId, { patientId: patient.id });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row!.abhaVerificationStatus).toBe("verified");
  });

  it("ABDM off ⇒ every step answers abdm_not_configured", async () => {
    const runtime = new AbdmRuntime(loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! }), db, fetch, now);
    await expect(runtime.abhaService.startVerification(clerk, { identifier: ABHA, method: "aadhaar_otp" })).rejects.toMatchObject({ code: "abdm_not_configured" });
    await expect(runtime.abhaService.startCreate(clerk, { aadhaar: "987654321098", patientConsented: true })).rejects.toMatchObject({ code: "abdm_not_configured" });
    expect(runtime.shares).toBeNull();
  });
});
