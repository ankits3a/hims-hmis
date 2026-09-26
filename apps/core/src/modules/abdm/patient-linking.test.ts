import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import {
  ABHA_ADDRESS, ABHA_NUMBER, HIP, SECRET, VISIT_A, VISIT_B, hipRuntime, inbound, seedHipFixture,
} from "../../../test/helpers/abdm-hip";
import { abdmCareContexts, abdmLinkRequests, abdmMessages } from "../../kernel/db/schema";
import { HIP_PATHS } from "./hip-client";
import { LINK_OTP_MAX_ATTEMPTS, LoggingOtpSender } from "./patient-linking";
import type { OtpSender } from "./patient-linking";
import type { HipFixture } from "../../../test/helpers/abdm-hip";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S2 — PATIENT-INITIATED LINKING against the fake (FT USER_INIT_LINK_603–607): discovery by a
 * VERIFIED ABHA and agreeing demographics, the HOSPITAL's OTP on init, the constant-time check on
 * confirm — and the OTP in no stored row.
 */
describe("PatientLinking — discover, init (our OTP), confirm", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const clock = Date.parse("2026-09-25T11:00:00.000Z");
  const now = (): Date => new Date(clock);
  let fx: HipFixture;
  let sent: { mobile: string; otp: string }[];
  const capture: OtpSender = { name: "capture", send: async (to, otp) => { sent.push({ mobile: to.mobile, otp }); } };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedHipFixture(db);
    sent = [];
  });

  const setup = (otpSender: OtpSender = capture) => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    return { fake, linking: hipRuntime(db, fake, now, { otpSender }).linking! };
  };
  const discoverBody = (over: Record<string, unknown> = {}) => ({
    transactionId: "txn-1",
    patient: {
      id: ABHA_ADDRESS, name: "SUNITA  sharma", gender: "F", yearOfBirth: 1986,
      verifiedIdentifiers: [{ type: "MOBILE", value: "9876543210" }, { type: "ABHA_NUMBER", value: ABHA_NUMBER }],
      unverifiedIdentifiers: [], ...over,
    },
  });
  const initBody = (refs: string[]) => ({
    transactionId: "txn-1", abhaAddress: ABHA_ADDRESS,
    patient: [{ referenceNumber: fx.uhid, careContexts: refs.map((referenceNumber) => ({ referenceNumber })), hiType: "OPConsultation", count: refs.length }],
  });

  it("DISCOVER: a verified ABHA with agreeing demographics → the completed, unlinked visits, grouped per HI type; the open visit is not offered", async () => {
    const s = setup();
    const m = await inbound(db, "/api/v3/hip/patient/care-context/discover", s.fake.signedCallback(discoverBody()));
    await s.linking.handleDiscover(m);
    const [call] = s.fake.hip.calls(HIP_PATHS.onDiscover);
    expect(call!.body.transactionId).toBe("txn-1");
    expect(call!.body.matchedBy).toEqual(["ABHA_ADDRESS"]);
    expect(call!.body.response).toEqual({ requestId: m.requestId });
    const groups = call!.body.patient as { hiType: string; referenceNumber: string; careContexts: { referenceNumber: string }[] }[];
    expect(groups.map((g) => [g.hiType, g.careContexts.map((c) => c.referenceNumber)])).toEqual([
      ["OPConsultation", [VISIT_B, VISIT_A]], ["Prescription", [VISIT_B, VISIT_A]], ["DiagnosticReport", [VISIT_A]],
    ]);
    expect(groups.every((g) => g.referenceNumber === fx.uhid)).toBe(true);
    expect(JSON.stringify(call!.body)).not.toContain("V2609250009");
  });

  it("DISCOVER refuses a near miss (ABDM-1010): a different year of birth, a different name, a different gender, an unverified ABHA", async () => {
    const s = setup();
    for (const over of [{ yearOfBirth: 1987 }, { name: "Sunita Verma" }, { gender: "M" }]) {
      await s.linking.handleDiscover(await inbound(db, "/api/v3/hip/patient/care-context/discover", s.fake.signedCallback(discoverBody(over))));
    }
    await s.linking.handleDiscover(await inbound(db, "/api/v3/hip/patient/care-context/discover",
      s.fake.signedCallback(discoverBody({ id: "ravi@sbx", name: "Ravi Kumar", gender: "M", yearOfBirth: 1990, verifiedIdentifiers: [] }))));
    const calls = s.fake.hip.calls(HIP_PATHS.onDiscover);
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => (c.body.error as { code: string }).code)).toEqual(["ABDM-1010", "ABDM-1010", "ABDM-1010", "ABDM-1010"]);
    expect(calls.every((c) => c.body.patient === undefined)).toBe(true);
  });

  it("INIT sends OUR OTP to the patient's mobile and answers on-init with the link reference (MEDIATE, the masked mobile); CONFIRM with the right OTP links", async () => {
    const s = setup();
    const init = await inbound(db, "/api/v3/hip/link/care-context/init", s.fake.signedCallback(initBody([VISIT_A, VISIT_B])));
    await s.linking.handleLinkInit(init);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mobile).toBe("9876543210");
    expect(sent[0]!.otp).toMatch(/^\d{6}$/);
    const [onInit] = s.fake.hip.calls(HIP_PATHS.onInit);
    const link = onInit!.body.link as { referenceNumber: string; authenticationType: string; meta: Record<string, string> };
    expect(link).toMatchObject({ authenticationType: "MEDIATE", meta: { communicationMedium: "MOBILE", communicationHint: "******3210" } });
    expect(onInit!.body.response).toEqual({ requestId: init.requestId });

    const confirm = await inbound(db, "/api/v3/hip/link/care-context/confirm",
      s.fake.signedCallback({ confirmation: { linkRefNumber: link.referenceNumber, token: sent[0]!.otp } }));
    await s.linking.handleLinkConfirm(confirm);
    const rows = await db.select().from(abdmCareContexts);
    expect(rows.map((r) => [r.referenceNumber, r.status, r.linkedVia]).sort()).toEqual([[VISIT_B, "linked", "patient"], [VISIT_A, "linked", "patient"]].sort());
    const [onConfirm] = s.fake.hip.calls(HIP_PATHS.onConfirm);
    expect(onConfirm!.body.error).toBeUndefined();
    expect((onConfirm!.body.patient as { hiType: string }[]).map((p) => p.hiType)).toEqual(["OPConsultation", "Prescription", "DiagnosticReport"]);

    // A repeated confirm answers the same list and links nothing twice; the linked visits are no
    // longer offered by discovery.
    await s.linking.handleLinkConfirm(await inbound(db, "/api/v3/hip/link/care-context/confirm",
      s.fake.signedCallback({ confirmation: { linkRefNumber: link.referenceNumber, token: sent[0]!.otp } })));
    expect(await db.select().from(abdmCareContexts)).toHaveLength(2);
    expect(s.fake.hip.calls(HIP_PATHS.onConfirm)[1]!.body.patient).toEqual(onConfirm!.body.patient);
    await s.linking.handleDiscover(await inbound(db, "/api/v3/hip/patient/care-context/discover", s.fake.signedCallback(discoverBody())));
    expect((s.fake.hip.calls(HIP_PATHS.onDiscover)[0]!.body.error as { message: string }).message).toMatch(/Care Contexts not found/);
  });

  it(`a WRONG OTP is ABDM-1035 and links nothing; after ${LINK_OTP_MAX_ATTEMPTS} wrong tries even the right one is refused`, async () => {
    const s = setup();
    await s.linking.handleLinkInit(await inbound(db, "/api/v3/hip/link/care-context/init", s.fake.signedCallback(initBody([VISIT_A]))));
    const ref = (s.fake.hip.calls(HIP_PATHS.onInit)[0]!.body.link as { referenceNumber: string }).referenceNumber;
    const wrong = sent[0]!.otp === "000000" ? "111111" : "000000";
    for (let i = 0; i < LINK_OTP_MAX_ATTEMPTS; i += 1) {
      await s.linking.handleLinkConfirm(await inbound(db, "/api/v3/hip/link/care-context/confirm",
        s.fake.signedCallback({ confirmation: { linkRefNumber: ref, token: wrong } })));
    }
    await s.linking.handleLinkConfirm(await inbound(db, "/api/v3/hip/link/care-context/confirm",
      s.fake.signedCallback({ confirmation: { linkRefNumber: ref, token: sent[0]!.otp } })));
    const codes = s.fake.hip.calls(HIP_PATHS.onConfirm).map((c) => (c.body.error as { code: string } | undefined)?.code);
    expect(codes.slice(0, LINK_OTP_MAX_ATTEMPTS)).toEqual(Array(LINK_OTP_MAX_ATTEMPTS).fill("ABDM-1035"));
    expect(codes[LINK_OTP_MAX_ATTEMPTS]).toBe("ABDM-1000");
    expect(await db.select().from(abdmCareContexts)).toHaveLength(0);
    const [req] = await db.select().from(abdmLinkRequests);
    expect(req).toMatchObject({ status: "failed", attempts: LINK_OTP_MAX_ATTEMPTS });
  });

  it("INIT refuses a care context that is not this patient's, not completed, or unknown — and sends no OTP", async () => {
    const s = setup();
    for (const refs of [["V2609250005"], ["V2609250009"], ["V9999999999"]]) {
      await s.linking.handleLinkInit(await inbound(db, "/api/v3/hip/link/care-context/init", s.fake.signedCallback(initBody(refs))));
    }
    expect(sent).toHaveLength(0);
    expect(s.fake.hip.calls(HIP_PATHS.onInit).map((c) => (c.body.error as { code: string }).code)).toEqual(["ABDM-1000", "ABDM-1000", "ABDM-1000"]);
    expect(await db.select().from(abdmLinkRequests)).toHaveLength(0);
  });

  it("THE LOGGING OTP SENDER REFUSES IN PRODUCTION: on-init answers an error, nothing can be confirmed", async () => {
    const s = setup(new LoggingOtpSender("abdm"));
    await s.linking.handleLinkInit(await inbound(db, "/api/v3/hip/link/care-context/init", s.fake.signedCallback(initBody([VISIT_A]))));
    const [onInit] = s.fake.hip.calls(HIP_PATHS.onInit);
    expect((onInit!.body.error as { message: string }).message).toMatch(/could not send the OTP: no SMS sender is configured/);
    expect(onInit!.body.link).toBeUndefined();
    const [req] = await db.select().from(abdmLinkRequests);
    expect(req).toMatchObject({ status: "otp_unsent", otpHash: null });
    // Sandbox, but no operator opt-in: refused — an OTP in a server log is a credential in a log.
    await expect(new LoggingOtpSender("sbx").send({ mobile: "9876543210", patientId: "p" }, "123456", "t")).rejects.toThrow(/ABDM_SANDBOX_OTP_TO_LOG/);
    await expect(new LoggingOtpSender("sbx", true).send({ mobile: "9876543210", patientId: "p" }, "123456", "t")).resolves.toBeUndefined();
  });

  it("THE OTP IS IN NO STORED ROW: the confirm callback's token is redacted, the link request keeps only an HMAC", async () => {
    const s = setup();
    await s.linking.handleLinkInit(await inbound(db, "/api/v3/hip/link/care-context/init", s.fake.signedCallback(initBody([VISIT_A]))));
    const ref = (s.fake.hip.calls(HIP_PATHS.onInit)[0]!.body.link as { referenceNumber: string }).referenceNumber;
    await s.linking.handleLinkConfirm(await inbound(db, "/api/v3/hip/link/care-context/confirm",
      s.fake.signedCallback({ confirmation: { linkRefNumber: ref, token: sent[0]!.otp } })));
    const otp = sent[0]!.otp;
    const messages = await db.select().from(abdmMessages);
    const confirmRow = messages.find((r) => r.kind === "callback.hip/link/care-context/confirm")!;
    expect((confirmRow.body as { confirmation: { token: string } }).confirmation.token).toBe("[redacted]");
    for (const r of messages) {
      // The six digits may occur by chance inside a UUID or a timestamp; they may not occur as a VALUE.
      expect(JSON.stringify(r.body)).not.toContain(`"${otp}"`);
      expect(JSON.stringify(r.responseBody)).not.toContain(`"${otp}"`);
    }
    const [req] = await db.select().from(abdmLinkRequests).where(eq(abdmLinkRequests.linkRefNumber, ref));
    expect(req!.otpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(req)).not.toContain(`"${otp}"`);
  });
});
