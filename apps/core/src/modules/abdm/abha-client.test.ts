import { constants, privateDecrypt } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { loadConfig } from "../../kernel/config";
import { ABHA_CERT_TTL_MS, ABHA_ENCRYPTION_NAME, AbhaClient, AbhaError } from "./abha-client";
import { AbdmGatewayClient, abdmSettingsFrom } from "./index";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S1 — the ABHA client against the fake ABHA service. The fake DECRYPTS every loginId and
 * otpValue with RSA-OAEP-SHA1 under its own key, so a client that used the wrong key or the wrong
 * padding is refused the way ABDM would refuse it.
 */
const SECRET = "Sbx-Secret-abha-client-never-stored";
const ABHA = "91-2345-6789-0123";

describe("AbhaClient", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    clock = Date.parse("2026-09-25T10:00:00.000Z");
  });

  const setup = () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock });
    fake.abha.addAccount({
      ABHANumber: ABHA, preferredAbhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", gender: "F",
      yearOfBirth: "1986", monthOfBirth: "3", dayOfBirth: "14", mobile: "******3210",
    });
    const settings = abdmSettingsFrom(loadConfig({
      DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_ABHA_BASE_URL: fake.abha.baseUrl,
      ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: "IN0000000001",
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
    }).abdm)!;
    const gateway = new AbdmGatewayClient(settings, { db, fetch: fake.fetch, now });
    return { fake, abha: new AbhaClient(gateway, { now }) };
  };

  const storedText = async (): Promise<string> =>
    ((await db.execute(sql`select coalesce(json_agg(m)::text, '') as t from abdm_messages m`)).rows[0] as { t: string }).t;

  it("encrypts with ABDM's published key and RSA-OAEP-SHA1 — the fake's private key opens it, and no other padding does", async () => {
    const { fake, abha } = setup();
    const c = await abha.encrypt("123456789012");
    const bytes = Buffer.from(c, "base64");
    expect(privateDecrypt({ key: fake.abha.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, bytes).toString()).toBe("123456789012");
    expect(() => privateDecrypt({ key: fake.abha.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, bytes)).toThrow();
    expect(ABHA_ENCRYPTION_NAME).toBe("RSA/ECB/OAEPWithSHA-1AndMGF1Padding");
    // OAEP is randomised: the same plaintext never encrypts twice to the same ciphertext.
    expect(await abha.encrypt("123456789012")).not.toBe(c);
  });

  it("caches the certificate, and fetches it again after its TTL", async () => {
    const { fake, abha } = setup();
    await abha.encrypt("a");
    await abha.encrypt("b");
    expect(fake.abha.certsServed()).toBe(1);
    clock += ABHA_CERT_TTL_MS + 1;
    await abha.encrypt("c");
    expect(fake.abha.certsServed()).toBe(2);
  });

  it("sends the ABHA calls with the gateway bearer, REQUEST-ID and TIMESTAMP, and NO X-CM-ID", async () => {
    const { fake, abha } = setup();
    const sent = await abha.requestLoginOtp({ kind: "abha_number", identifier: ABHA, otpSystem: "aadhaar", actorId: "clerk-1" });
    expect(sent.txnId).toMatch(/^[0-9a-f-]{36}$/);
    const req = fake.requests.find((r) => r.path === "/v3/profile/login/request/otp")!;
    expect(req.headers["authorization"]).toMatch(/^Bearer fake-access-/);
    expect(req.headers["request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.headers["timestamp"]).toMatch(/Z$/);
    expect(req.headers["x-cm-id"]).toBeUndefined();
    expect(req.body).toMatchObject({ scope: ["abha-login", "aadhaar-verify"], loginHint: "abha-number", otpSystem: "aadhaar" });
    // the loginId on the wire is ciphertext, and it decrypted to the ABHA number
    expect((req.body as { loginId: string }).loginId).not.toContain(ABHA);
    expect((req.body as { loginId: string }).loginId).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(fake.abha.decrypted).toContain(ABHA);
    // the stored row carries the clerk, and the ciphertext is redacted
    const [row] = (await db.execute(sql`select actor_id, body from abdm_messages where kind = 'abha.login.request_otp'`)).rows as Array<{ actor_id: string; body: { loginId: string } }>;
    expect(row).toMatchObject({ actor_id: "clerk-1", body: { loginId: "[redacted]" } });
  });

  it("an OTP ABDM refuses — with an answer that ECHOES the OTP — reaches no row and no error", async () => {
    const { fake, abha } = setup();
    const { txnId } = await abha.requestLoginOtp({ kind: "abha_number", identifier: ABHA, otpSystem: "abdm", actorId: "clerk-1" });
    fake.abha.otp = "271828";
    const err = await abha.verifyLoginOtp({ kind: "abha_number", otpSystem: "abdm", txnId, otp: "314159", actorId: "clerk-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbhaError);
    expect((err as AbhaError).code).toBe("abdm_refused");
    expect((err as AbhaError).message).not.toContain("314159");
    expect((err as AbhaError).message).toMatch(/incorrect/);
    expect(await storedText()).not.toContain("314159");
  });

  const sessionOf = (r: Awaited<ReturnType<AbhaClient["verifyLoginOtp"]>>) => {
    if (r.kind !== "session") throw new Error(`expected a session, got ${r.kind}`);
    return r.session;
  };

  it("a login answered with accounts and no refreshToken is a CHOICE; the account is picked through verify/user (T-TOKEN)", async () => {
    const { fake, abha } = setup();
    fake.abha.loginNeedsUserSelect = true;
    const { txnId } = await abha.requestLoginOtp({ kind: "abha_number", identifier: ABHA, otpSystem: "abdm", actorId: null });
    const r = await abha.verifyLoginOtp({ kind: "abha_number", otpSystem: "abdm", txnId, otp: "314159", actorId: null });
    if (r.kind !== "choose") throw new Error("expected a choice");
    expect(r.accounts).toEqual([{ abhaNumber: ABHA, abhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma" }]);
    const session = await abha.verifyUser({ tToken: r.tToken, txnId: r.txnId, abhaNumber: ABHA, actorId: null, patientId: null });
    const user = fake.requests.find((r) => r.path === "/v3/profile/login/verify/user")!;
    expect(user.headers["t-token"]).toMatch(/^Bearer fake-t-/);
    expect(user.body).toEqual({ ABHANumber: ABHA, txnId });
    expect(fake.abha.xTokensIssued()).toContain(session.xToken);
  });

  it("find by MOBILE (VRFY_ABHA_303): loginHint mobile, otpSystem abdm, the list, and no T-token in any row", async () => {
    const { fake, abha } = setup();
    fake.abha.addAccount({ ABHANumber: "91-1111-2222-3333", preferredAbhaAddress: "second@sbx", name: "Second Person", gender: "M", yearOfBirth: "1990", mobile: "******3210", mobileNumber: "9876543210" });
    fake.abha.addAccount({ ABHANumber: "91-4444-5555-6666", preferredAbhaAddress: "third@sbx", name: "Third Person", gender: "F", yearOfBirth: "1992", mobile: "******3210", mobileNumber: "9876543210" });
    const sent = await abha.requestLoginOtp({ kind: "mobile", identifier: "9876543210", otpSystem: "abdm", actorId: null });
    expect(sent.message).toMatch(/\*{6}3210/);
    expect(fake.requests.at(-1)!.body).toMatchObject({ scope: ["abha-login", "mobile-verify"], loginHint: "mobile", otpSystem: "abdm" });
    const r = await abha.verifyLoginOtp({ kind: "mobile", otpSystem: "abdm", txnId: sent.txnId, otp: "314159", actorId: null });
    if (r.kind !== "choose") throw new Error("expected a choice");
    expect(r.accounts.map((a) => a.abhaNumber).sort()).toEqual(["91-1111-2222-3333", "91-4444-5555-6666"]);
    const text = await storedText();
    for (const t of fake.abha.tTokensIssued()) expect(text).not.toContain(t);
  });

  it("find by AADHAAR (VRFY_ABHA_404): loginHint aadhaar — and a refusal that echoes the Aadhaar number leaves it nowhere", async () => {
    const { fake, abha } = setup();
    fake.abha.addAccount({ ABHANumber: "91-7777-8888-9999", preferredAbhaAddress: "aadhaar.person@sbx", name: "Aadhaar Person", gender: "F", yearOfBirth: "1985", mobile: "******4321", aadhaar: "555566667777" });
    const err = await abha.requestLoginOtp({ kind: "aadhaar", identifier: "1111 2222 3333", otpSystem: "aadhaar", actorId: "clerk-1" }).catch((e: unknown) => e);
    expect((err as AbhaError).code).toBe("abdm_refused");
    expect((err as Error).message).toMatch(/NO ABHA user registered/);
    expect((err as Error).message).not.toMatch(/111122223333|1111 2222 3333/);
    const sent = await abha.requestLoginOtp({ kind: "aadhaar", identifier: "555566667777", otpSystem: "aadhaar", actorId: "clerk-1" });
    expect(fake.requests.at(-1)!.body).toMatchObject({ scope: ["abha-login", "aadhaar-verify"], loginHint: "aadhaar", otpSystem: "aadhaar" });
    const session = sessionOf(await abha.verifyLoginOtp({ kind: "aadhaar", otpSystem: "aadhaar", txnId: sent.txnId, otp: "314159", actorId: "clerk-1" }));
    expect(fake.abha.xTokensIssued()).toContain(session.xToken);
    expect(await storedText()).not.toMatch(/111122223333|1111 2222 3333|555566667777|5555 6666 7777/);
  });

  it("after creation: a different mobile is checked by OTP (CRT_ABHA_109), then suggestions and a new ABHA address (CRT_ABHA_112)", async () => {
    const { fake, abha } = setup();
    const { txnId } = await abha.requestEnrolmentOtp({ aadhaar: "987654321098", actorId: null });
    const made = await abha.enrolByAadhaar({ txnId, otp: "314159", mobile: "9000011111", actorId: null });
    expect(made.profile.mobile).toBe("******5678"); // UIDAI's, not the one given
    const sent = await abha.requestEnrolmentMobileOtp({ txnId: made.txnId!, mobile: "9000011111", actorId: null });
    expect(fake.requests.at(-1)!.body).toMatchObject({ txnId: made.txnId, scope: ["abha-enrol", "mobile-verify"], loginHint: "mobile", otpSystem: "abdm" });
    await abha.verifyEnrolmentMobileOtp({ txnId: sent.txnId, otp: "314159", actorId: null });
    expect(fake.requests.at(-1)!.path).toBe("/v3/enrollment/auth/byAbdm");
    const list = await abha.addressSuggestions({ txnId: sent.txnId, actorId: null });
    expect(fake.requests.at(-1)!.headers["transaction_id"]).toBe(sent.txnId);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const created = await abha.createAbhaAddress({ txnId: sent.txnId, abhaAddress: list[0]!, actorId: null });
    expect(created.abhaAddress).toBe(`${list[0]!}@sbx`);
    fake.abha.takenAddresses.add("already.taken@sbx");
    await expect(abha.createAbhaAddress({ txnId: sent.txnId, abhaAddress: "already.taken", actorId: null })).rejects.toMatchObject({ message: "ABHA Address is already exist" });
    expect(await storedText()).not.toContain("314159");
  });

  it("the profile and the card: the X-token and the photograph never reach a row, and the card is bytes, not stored", async () => {
    const { fake, abha } = setup();
    const { txnId } = await abha.requestLoginOtp({ kind: "abha_number", identifier: ABHA, otpSystem: "aadhaar", actorId: null });
    const session = sessionOf(await abha.verifyLoginOtp({ kind: "abha_number", otpSystem: "aadhaar", txnId, otp: "314159", actorId: null }));
    const profile = await abha.profile(session.xToken, { actorId: null });
    expect(profile).toMatchObject({ ABHANumber: ABHA, name: "Sunita Sharma" });
    const card = await abha.card(session.xToken, { actorId: null });
    expect(card.contentType).toBe("image/png");
    expect(card.bytes.equals(fake.abha.cardBytes)).toBe(true);

    const text = await storedText();
    for (const t of fake.abha.xTokensIssued()) expect(text).not.toContain(t);
    expect(text).not.toContain(Buffer.from("a face, as ABDM would send it").toString("base64"));
    expect(text).not.toContain(fake.abha.cardBytes.toString("base64"));
    const [cardRow] = (await db.execute(sql`select response_body from abdm_messages where kind = 'abha.card'`)).rows as Array<{ response_body: unknown }>;
    expect(cardRow!.response_body).toEqual({ binary: true, contentType: "image/png", bytes: fake.abha.cardBytes.length });
  });

  it("an ABHA-address login goes through the PHR web login pair", async () => {
    const { fake, abha } = setup();
    const { txnId } = await abha.requestLoginOtp({ kind: "abha_address", identifier: "sunita.sharma@sbx", otpSystem: "abdm", actorId: null });
    const session = sessionOf(await abha.verifyLoginOtp({ kind: "abha_address", otpSystem: "abdm", txnId, otp: "314159", actorId: null }));
    expect(fake.requests.find((r) => r.path === "/v3/phr/web/login/abha/request/otp")!.body).toMatchObject({ scope: ["abha-address-login", "mobile-verify"], loginHint: "abha-address" });
    expect(fake.abha.xTokensIssued()).toContain(session.xToken);
  });

  it("the Aadhaar enrolment: ABDM's refusal that echoes the Aadhaar number AND the OTP leaves neither anywhere", async () => {
    const { fake, abha } = setup();
    const AADHAAR = "987654321098";
    const { txnId } = await abha.requestEnrolmentOtp({ aadhaar: AADHAAR, actorId: "clerk-1" });
    expect(fake.abha.enrolledAadhaar).toEqual([AADHAAR]);
    fake.abha.otp = "111111";
    const err = await abha.enrolByAadhaar({ txnId, otp: "222222", mobile: "9812345678", actorId: "clerk-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbhaError);
    expect(String((err as Error).message)).not.toMatch(/987654321098|9876 5432 1098|222222/);
    const text = await storedText();
    expect(text).not.toMatch(/987654321098|9876 5432 1098|9876-5432-1098|222222/);
    // and ABDM was really asked, with the fields Care sends
    const enrol = fake.requests.find((r) => r.path === "/v3/enrollment/enrol/byAadhaar")!;
    expect(enrol.body).toMatchObject({ consent: { code: "abha-enrollment", version: "1.4" }, authData: { authMethods: ["otp"], otp: { txnId, mobile: "9812345678" } } });
  });
});
