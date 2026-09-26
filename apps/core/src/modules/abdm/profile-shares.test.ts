import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { abdmMessages, abdmProfileShares, patients, phiAccessLog, registrationConfig } from "../../kernel/db/schema";
import { loadConfig } from "../../kernel/config";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "../patients";
import { counterQrUrl, SHARE_TOKEN_EXPIRY_S } from "./profile-shares";
import { AbdmRuntime } from "./runtime";
import type { AbdmInboundMessage } from "./callbacks";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S1 — scan and share, at the handler: a shared profile becomes a pending share with today's
 * token, ABDM is told the token, a re-scan keeps it, and the counter links the share to a patient —
 * new or on file — with the ABHA stamped only through `recordAbhaVerifiedByAbdm`.
 */
const SECRET = "Sbx-Secret-shares-never-stored";
const HIP = "IN0000000001";
const clerk: Actor = { type: "user", id: "clerk-1" };

describe("ProfileShares", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    clock = Date.parse("2026-09-25T04:00:00.000Z"); // 09:30 IST
  });

  const setup = (env: Record<string, string> = {}) => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    const cfg = loadConfig({
      DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: HIP,
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks", ...env,
    });
    const runtime = new AbdmRuntime(cfg, db, fake.fetch, now);
    return { fake, runtime, shares: runtime.shares! };
  };

  /** What the callback route hands the handler — with the inbound row it would have written. */
  const inbound = async (fake: ReturnType<typeof createFakeAbdmGateway>, o: Parameters<typeof fake.shareProfileCallback>[0] = {}): Promise<AbdmInboundMessage> => {
    const cb = fake.shareProfileCallback(o);
    const messageId = newId();
    await db.insert(abdmMessages).values({
      id: messageId, direction: "in", kind: "callback.hip/patient/share", path: "/api/v3/hip/patient/share",
      requestId: cb.headers["REQUEST-ID"]!, headers: {}, body: cb.body, httpStatus: 202, dispatch: "pending",
    });
    return {
      messageId, kind: "callback.hip/patient/share", path: "/api/v3/hip/patient/share", requestId: cb.headers["REQUEST-ID"]!,
      correlationRequestId: null, hipId: HIP, hiuId: null, body: cb.body, claims: { exp: 0 },
    };
  };

  it("a share becomes a pending share with token 1, and ABDM is told the token (Care's on-share body)", async () => {
    const { fake, shares } = setup();
    const m = await inbound(fake, { context: "REG1" });
    await shares.handleProfileShare(m);

    const list = await shares.listPending();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      tokenNumber: 1, tokenDate: "2026-09-25", counterId: "REG1", status: "pending", ackStatus: "sent",
      profile: { abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", dob: "1986-03-14", gender: "female", mobile: "9876543210", pincode: "302015" },
    });
    expect(fake.onShares).toEqual([{
      acknowledgement: { status: "SUCCESS", abhaAddress: "sunita.sharma@sbx", profile: { context: "REG1", tokenNumber: "1", expiry: SHARE_TOKEN_EXPIRY_S } },
      response: { requestId: m.requestId },
    }]);
    const onShareReq = fake.requests.find((r) => r.path === "/patient-share/v3/on-share")!;
    expect(onShareReq.headers["x-cm-id"]).toBe("sbx");
    expect(onShareReq.headers["x-hip-id"]).toBeUndefined();
  });

  it("a RE-SCAN by the same ABHA address keeps its token; another patient gets the next one", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake));
    await shares.handleProfileShare(await inbound(fake));
    const other = { abhaNumber: null, abhaAddress: "ravi@sbx", name: "Ravi Kumar", gender: "M", yearOfBirth: "1990", phoneNumber: "9811111111" };
    await shares.handleProfileShare(await inbound(fake, { patient: other }));
    const list = await shares.listPending();
    expect(list.map((s) => [s.profile.abhaAddress, s.tokenNumber]).sort()).toEqual([["ravi@sbx", 2], ["sunita.sharma@sbx", 1]]);
    expect(fake.onShares.map((b) => (b as { acknowledgement: { profile: { tokenNumber: string } } }).acknowledgement.profile.tokenNumber)).toEqual(["1", "1", "2"]);
  });

  it("tokens start again at 1 on the next IST day", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake));
    clock = Date.parse("2026-09-25T19:00:00.000Z"); // 00:30 IST on the 26th
    await shares.handleProfileShare(await inbound(fake, { patient: { abhaAddress: "ravi@sbx", name: "Ravi", gender: "M", yearOfBirth: "1990" } }));
    const rows = await db.select().from(abdmProfileShares);
    expect(rows.map((r) => [r.tokenDate, r.tokenNumber]).sort()).toEqual([["2026-09-25", 1], ["2026-09-26", 1]]);
  });

  it("a share for another facility, or with no ABHA address, is answered with an error and stored nowhere", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake, { hipId: "IN9999999999" }));
    await shares.handleProfileShare(await inbound(fake, { patient: { name: "No Address", gender: "F", yearOfBirth: "1990" } }));
    expect(await db.select().from(abdmProfileShares)).toHaveLength(0);
    expect(fake.onShares.map((b) => (b as { error?: { code: string } }).error?.code)).toEqual(["ABDM-1000", "ABDM-1000"]);
  });

  it("an on-share ABDM refuses keeps the share (the patient is at the counter) but fails the message", async () => {
    const { fake, shares } = setup();
    fake.on("POST", "/patient-share/v3/on-share", () => new Response(JSON.stringify({ error: { code: "ABDM-9999", message: "down" } }), { status: 500 }));
    await expect(shares.handleProfileShare(await inbound(fake))).rejects.toThrow(/HTTP 500/);
    const [row] = await db.select().from(abdmProfileShares);
    expect(row).toMatchObject({ status: "pending", ackStatus: "failed" });
  });

  it("link to a NEW patient registered from the share: verified through recordAbhaVerifiedByAbdm, the message names them, PHI audited", async () => {
    const { fake, shares } = setup();
    const m = await inbound(fake);
    await shares.handleProfileShare(m);
    const [share] = await shares.listPending();
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, {
      name: share!.profile.name!, sex: "female", phone: share!.profile.mobile!, dob: new Date(`${share!.profile.dob!}T00:00:00.000Z`),
      abhaNumber: share!.profile.abhaNumber!, abhaAddress: share!.profile.abhaAddress!, abhaVerificationStatus: "self_declared",
    }));
    const res = await shares.link(clerk, share!.id, { patientId: patient.id });
    expect(res.share).toMatchObject({ status: "linked", patientId: patient.id });
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ abhaVerificationStatus: "verified", abhaNumber: "91-2345-6789-0123", updatedBy: "abdm" });
    const [msg] = await db.select().from(abdmMessages).where(eq(abdmMessages.id, m.messageId));
    expect(msg!.patientId).toBe(patient.id);
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.profile_share"))).toHaveLength(1);
    expect(await shares.listPending()).toHaveLength(0);
    await expect(shares.link(clerk, share!.id, { patientId: patient.id })).rejects.toMatchObject({ code: "share_not_pending" });
  });

  it("match to a patient ON FILE: differences are refused until ABDM's details are accepted, then taken (mobile kept)", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake));
    const [share] = await shares.listPending();
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Sunita S.", sex: "female", phone: "9811112222", ageYears: 40 }));
    const refused = await shares.link(clerk, share!.id, { patientId: patient.id }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "abha_profile_mismatch" });
    expect(((refused as { detail: { demographicsToApply: Array<{ field: string }> } }).detail.demographicsToApply).map((c) => c.field)).toEqual(["name", "dob"]);
    const res = await shares.link(clerk, share!.id, { patientId: patient.id, acceptAbdmDemographics: true });
    expect(res.demographicsApplied.map((c) => c.field)).toEqual(["name", "dob"]);
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row).toMatchObject({ name: "Sunita Sharma", dobEstimated: false, phone: "9811112222", abhaVerificationStatus: "verified" });
    expect(row!.dob?.toISOString().slice(0, 10)).toBe("1986-03-14");
  });

  it("ONE ABHA, ONE PATIENT: a share whose ABHA is already on a record says so in the list, and cannot link to another", async () => {
    const { fake, shares } = setup();
    const { patient: holder } = await withTx(db, (tx) => registerPatient(tx, clerk, {
      name: "Sunita Sharma", sex: "female", phone: "9876543210", abhaNumber: "91-2345-6789-0123", abhaVerificationStatus: "self_declared",
    }));
    await shares.handleProfileShare(await inbound(fake));
    const [share] = await shares.listPending(clerk);
    expect(share!.linkedElsewhere).toEqual({ uhid: null }); // this clerk holds no patients.read here
    const { patient: other } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Sunita Sharma", sex: "female", phone: "9876543211" }));
    // refused AS a duplicate — before, and instead of, asking for ABDM's details to be accepted
    await expect(shares.link(clerk, share!.id, { patientId: other.id })).rejects.toMatchObject({ code: "abha_already_linked" });
    await expect(shares.link(clerk, share!.id, { patientId: other.id, acceptAbdmDemographics: true })).rejects.toMatchObject({ code: "abha_already_linked" });
    // …and linking it to the record that holds it is fine (ABDM's birth date fills the blank one, accepted)
    await expect(shares.link(clerk, share!.id, { patientId: holder.id })).rejects.toMatchObject({ code: "abha_profile_mismatch" });
    await shares.link(clerk, share!.id, { patientId: holder.id, acceptAbdmDemographics: true });
    const [row] = await db.select().from(patients).where(eq(patients.id, holder.id));
    expect(row!.abhaVerificationStatus).toBe("verified");
  });

  it("a share with no ABHA number links the share and stamps nothing — there is no number to verify", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake, { patient: { abhaNumber: null, abhaAddress: "ravi@sbx", name: "Ravi Kumar", gender: "M", yearOfBirth: "1990", phoneNumber: "9811111111" } }));
    const [share] = await shares.listPending();
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Ravi Kumar", sex: "male", phone: "9811111111", ageYears: 36 }));
    const res = await shares.link(clerk, share!.id, { patientId: patient.id });
    expect(res.changed).toEqual([]);
    const [row] = await db.select().from(patients).where(eq(patients.id, patient.id));
    expect(row!.abhaVerificationStatus).toBe("none");
  });

  it("an expired share is not offered and cannot be linked; a dismissed one is gone", async () => {
    const { fake, shares } = setup();
    await shares.handleProfileShare(await inbound(fake));
    await shares.handleProfileShare(await inbound(fake, { patient: { abhaAddress: "ravi@sbx", name: "Ravi", gender: "M", yearOfBirth: "1990" } }));
    const list = await shares.listPending();
    const ravi = list.find((s) => s.profile.abhaAddress === "ravi@sbx")!;
    await shares.dismiss(ravi.id);
    expect((await shares.listPending()).map((s) => s.profile.abhaAddress)).toEqual(["sunita.sharma@sbx"]);
    const sunita = list.find((s) => s.profile.abhaAddress === "sunita.sharma@sbx")!;
    clock += SHARE_TOKEN_EXPIRY_S * 1000 + 1;
    expect(await shares.listPending()).toHaveLength(0);
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name: "Sunita Sharma", sex: "female", phone: "9876543210" }));
    await expect(shares.link(clerk, sunita.id, { patientId: patient.id })).rejects.toMatchObject({ code: "share_expired" });
  });

  it("the counter QR: Care's parameters on the sandbox host by default, or an operator's template", () => {
    const { runtime } = setup();
    expect(counterQrUrl(runtime.settings!, "REG1")).toBe("https://phrsbx.abdm.gov.in/share-profile?hf=IN0000000001&counter=REG1");
    const t = setup({ ABDM_SCAN_SHARE_URL: "https://phrsbx.abdm.gov.in/share-profile?hip-id={hipId}&counter-id={counterId}" });
    expect(counterQrUrl(t.runtime.settings!, "2")).toBe("https://phrsbx.abdm.gov.in/share-profile?hip-id=IN0000000001&counter-id=2");
    const prod = setup({ ABDM_CM_ID: "abdm" });
    expect(counterQrUrl(prod.runtime.settings!, "1")).toMatch(/^https:\/\/phr\.abdm\.gov\.in\/share-profile\?/);
    expect(() => counterQrUrl(runtime.settings!, "counter one!")).toThrow(/counter_invalid/);
  });
});
