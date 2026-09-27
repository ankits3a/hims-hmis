import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import {
  ABHA_ADDRESS, HIP, SECRET, VISIT_A, VISIT_B, hipConfig, hipRuntime, inbound, seedHipFixture,
} from "../../../test/helpers/abdm-hip";
import { abdmCareContexts, abdmLinkTokens, abdmMessages, imagingReports, imagingStudies } from "../../kernel/db/schema";
import { ABDM_CARE_CONTEXT_CONSUMER, careContextConsumer } from "./consumer";
import { GENERATE_TOKEN_DAILY_LIMIT } from "./care-contexts";
import { HIP_PATHS } from "./hip-client";
import type { HipFixture } from "../../../test/helpers/abdm-hip";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S2 — HIP-INITIATED LINKING against the fake gateway (FT HIP_INTI_LINK_501–505): a completed
 * visit of an ABDM-verified patient becomes a care context; the link token is asked for once,
 * stored sealed, used; the context is linked and ABDM is told what it carries — and a redelivered
 * event, a second callback or a second report sends NOTHING twice.
 */
describe("CareContexts — HIP-initiated linking and context notify", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);
  let fx: HipFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedHipFixture(db);
    clock = Date.parse("2026-09-25T11:00:00.000Z");
  });

  const setup = () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    const runtime = hipRuntime(db, fake, now);
    return { fake, runtime, cc: runtime.careContexts! };
  };
  const rowOf = async (encounterId: string) => (await db.select().from(abdmCareContexts).where(eq(abdmCareContexts.encounterId, encounterId)))[0];

  /** Run the whole HIP-initiated flow for visit A: visit completed → token → link → on_carecontext. */
  const linkVisitA = async (s: ReturnType<typeof setup>): Promise<string> => {
    await s.cc.onVisitCompleted(fx.encA);
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken)[0]!;
    const token = s.fake.hip.issueLinkToken(ABHA_ADDRESS);
    await s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: token, response: { requestId: gen.requestId } })));
    const link = s.fake.hip.calls(HIP_PATHS.addCareContexts)[0]!;
    await s.cc.handleOnCareContext(await inbound(db, "/api/v3/link/on_carecontext",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, status: "Successfully Linked care context", response: { requestId: link.requestId } })));
    return token;
  };

  it("a completed visit → ONE pending care context, and ONE generate-token (the wrapper's body: address, name, gender, year of birth)", async () => {
    const s = setup();
    await s.cc.onVisitCompleted(fx.encA);
    const row = await rowOf(fx.encA);
    expect(row).toMatchObject({
      status: "pending", referenceNumber: VISIT_A, patientReference: fx.uhid, abhaAddress: ABHA_ADDRESS,
      display: `OPD visit ${VISIT_A} · 2026-09-25 · General Medicine`,
      hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"],
    });
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken);
    expect(gen).toHaveLength(1);
    expect(gen[0]!.body).toEqual({ abhaAddress: ABHA_ADDRESS, name: "Sunita Sharma", gender: "F", yearOfBirth: 1986 });
    expect(gen[0]!.headers["x-hip-id"]).toBe(HIP);
    const [tok] = await db.select().from(abdmLinkTokens);
    expect(tok).toMatchObject({ status: "pending", requestId: gen[0]!.requestId, abhaAddress: ABHA_ADDRESS });

    // The event redelivered while the token is outstanding: no second context, no second request.
    await s.cc.onVisitCompleted(fx.encA);
    expect(await db.select().from(abdmCareContexts)).toHaveLength(1);
    expect(s.fake.hip.calls(HIP_PATHS.generateToken)).toHaveLength(1);
  });

  it("on-generate-token → the token is stored SEALED and used: add-care-contexts with X-LINK-TOKEN, grouped per HI type, the token's ABHA number", async () => {
    const s = setup();
    await s.cc.onVisitCompleted(fx.encA);
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken)[0]!;
    const token = s.fake.hip.issueLinkToken(ABHA_ADDRESS, "91-2345-6789-0123");
    await s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: token, response: { requestId: gen.requestId } })));

    const [tok] = await db.select().from(abdmLinkTokens);
    expect(tok!.status).toBe("received");
    expect(tok!.tokenSealed).not.toContain(token);
    expect(tok!.abhaNumber).toBe("91-2345-6789-0123");
    const link = s.fake.hip.calls(HIP_PATHS.addCareContexts);
    expect(link).toHaveLength(1);
    expect(link[0]!.headers["x-link-token"]).toBe(token);
    expect(link[0]!.body).toEqual({
      abhaNumber: "91-2345-6789-0123", abhaAddress: ABHA_ADDRESS,
      patient: ["OPConsultation", "Prescription", "DiagnosticReport"].map((hiType) => ({
        referenceNumber: fx.uhid, display: "Sunita Sharma",
        careContexts: [{ referenceNumber: VISIT_A, display: `OPD visit ${VISIT_A} · 2026-09-25 · General Medicine` }],
        hiType, count: 1,
      })),
    });
    expect((await rowOf(fx.encA))!).toMatchObject({ status: "linking", linkRequestId: link[0]!.requestId });

    // A second on-generate-token for the same request changes nothing and sends nothing.
    await s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: token, response: { requestId: gen.requestId } })));
    expect(s.fake.hip.calls(HIP_PATHS.addCareContexts)).toHaveLength(1);
  });

  it("on_carecontext → linked, then context/notify ONCE; a redelivered event, a second on_carecontext and a second notify trigger send nothing", async () => {
    const s = setup();
    await linkVisitA(s);
    expect((await rowOf(fx.encA))!).toMatchObject({ status: "linked", linkedVia: "hip", notifiedHiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"] });
    const notify = s.fake.hip.calls(HIP_PATHS.contextNotify);
    expect(notify).toHaveLength(1);
    expect(notify[0]!.body).toMatchObject({
      notification: {
        patient: { id: ABHA_ADDRESS },
        careContext: { patientReference: fx.uhid, careContextReference: VISIT_A },
        hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"],
        hip: { id: HIP },
      },
    });

    const link = s.fake.hip.calls(HIP_PATHS.addCareContexts)[0]!;
    await s.cc.handleOnCareContext(await inbound(db, "/api/v3/link/on_carecontext",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, status: "Successfully Linked care context", response: { requestId: link.requestId } })));
    await s.cc.onVisitCompleted(fx.encA);
    await s.cc.onReportPublished(VISIT_A);
    expect(s.fake.hip.calls(HIP_PATHS.contextNotify)).toHaveLength(1);
    expect(s.fake.hip.calls(HIP_PATHS.addCareContexts)).toHaveLength(1);
    expect(s.fake.hip.calls(HIP_PATHS.generateToken)).toHaveLength(1);
  });

  it("a report signed AFTER the link adds DiagnosticReport and notifies THAT type alone, once", async () => {
    const s = setup();
    // Visit B carries no report at completion.
    await s.cc.onVisitCompleted(fx.encB);
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken)[0]!;
    await s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: s.fake.hip.issueLinkToken(ABHA_ADDRESS), response: { requestId: gen.requestId } })));
    const link = s.fake.hip.calls(HIP_PATHS.addCareContexts)[0]!;
    await s.cc.handleOnCareContext(await inbound(db, "/api/v3/link/on_carecontext",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, status: "ok", response: { requestId: link.requestId } })));
    expect(s.fake.hip.calls(HIP_PATHS.contextNotify).map((c) => (c.body.notification as { hiTypes: string[] }).hiTypes)).toEqual([["OPConsultation", "Prescription"]]);

    // The chest X-ray is re-pointed at visit B and its report published.
    const [xr] = await db.select().from(imagingStudies).where(eq(imagingStudies.accessionNo, "RA260925001"));
    await db.update(imagingStudies).set({ encounterNo: VISIT_B }).where(eq(imagingStudies.id, xr!.id));
    await s.cc.onReportPublished(VISIT_B);
    await s.cc.onReportPublished(VISIT_B);
    expect(s.fake.hip.calls(HIP_PATHS.contextNotify).map((c) => (c.body.notification as { hiTypes: string[] }).hiTypes))
      .toEqual([["OPConsultation", "Prescription"], ["DiagnosticReport"]]);
    expect((await rowOf(fx.encB))!.hiTypes).toEqual(["OPConsultation", "Prescription", "DiagnosticReport"]);
    void imagingReports;
  });

  it("an ERRORED context on-notify forgets what was notified, so the next trigger notifies again", async () => {
    const s = setup();
    await linkVisitA(s);
    const sent = s.fake.hip.calls(HIP_PATHS.contextNotify)[0]!;
    await s.cc.handleContextOnNotify(await inbound(db, "/api/v3/links/context/on-notify",
      s.fake.signedCallback({ acknowledgement: { status: "ERRORED" }, error: { code: "ABDM-1006", message: "try later" }, response: { requestId: sent.requestId } })));
    expect((await rowOf(fx.encA))!).toMatchObject({ notifiedHiTypes: [], notifyError: "ABDM-1006 try later" });
    await s.cc.onReportPublished(VISIT_A);
    expect(s.fake.hip.calls(HIP_PATHS.contextNotify)).toHaveLength(2);
  });

  it("a patient whose ABHA is only SELF-DECLARED, and an OPEN visit, get no care context and send nothing", async () => {
    const s = setup();
    await s.cc.onVisitCompleted(fx.encOther);
    await s.cc.onVisitCompleted(fx.encC);
    expect(await db.select().from(abdmCareContexts)).toHaveLength(0);
    expect(s.fake.requests.filter((r) => r.path !== "/gateway/v3/sessions")).toHaveLength(0);
  });

  it(`at most ${GENERATE_TOKEN_DAILY_LIMIT} generate-token calls per ABHA address per IST day (FT FAQ Q31)`, async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) {
      await s.cc.onVisitCompleted(fx.encA);
      clock += 11 * 60_000; // past the wait for an unanswered request
    }
    expect(s.fake.hip.calls(HIP_PATHS.generateToken)).toHaveLength(GENERATE_TOKEN_DAILY_LIMIT);
    expect((await rowOf(fx.encA))!.lastError).toMatch(/generate-token limit/);
  });

  it("ABDM refuses the link token (ABDM-1038) → the contexts go back to pending, the token is not trusted again", async () => {
    const s = setup();
    await s.cc.onVisitCompleted(fx.encA);
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken)[0]!;
    await expect(s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: "not.a-token-the-fake-issued.x", response: { requestId: gen.requestId } }))))
      .rejects.toThrow(/HTTP 400/);
    expect((await rowOf(fx.encA))!).toMatchObject({ status: "pending", linkRequestId: null });
    const [tok] = await db.select().from(abdmLinkTokens);
    expect(tok!.expiresAt!.getTime()).toBeLessThanOrEqual(clock);
  });

  it("an on_carecontext error leaves the context 'failed' with ABDM's reason, and nothing is notified", async () => {
    const s = setup();
    await s.cc.onVisitCompleted(fx.encA);
    const gen = s.fake.hip.calls(HIP_PATHS.generateToken)[0]!;
    await s.cc.handleOnGenerateToken(await inbound(db, "/api/v3/hip/token/on-generate-token",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken: s.fake.hip.issueLinkToken(ABHA_ADDRESS), response: { requestId: gen.requestId } })));
    const link = s.fake.hip.calls(HIP_PATHS.addCareContexts)[0]!;
    await s.cc.handleOnCareContext(await inbound(db, "/api/v3/link/on_carecontext",
      s.fake.signedCallback({ abhaAddress: ABHA_ADDRESS, error: { code: "ABDM-1037", message: "count mismatch" }, response: { requestId: link.requestId } })));
    expect((await rowOf(fx.encA))!).toMatchObject({ status: "failed", lastError: "ABDM-1037 count mismatch" });
    expect(s.fake.hip.calls(HIP_PATHS.contextNotify)).toHaveLength(0);
  });

  it("THE LINK TOKEN IS IN NO MESSAGE ROW: the callback body keeps it redacted, the outbound header too", async () => {
    const s = setup();
    const token = await linkVisitA(s);
    const rows = await db.select().from(abdmMessages);
    expect(rows.length).toBeGreaterThan(5);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(token);
    expect(text).not.toContain(SECRET);
    const cb = rows.find((r) => r.kind === "callback.hip/token/on-generate-token")!;
    expect((cb.body as { linkToken: string }).linkToken).toBe("[redacted]");
    const out = rows.find((r) => r.kind === "gateway.hip.add_care_contexts")!;
    expect(out.headers["X-LINK-TOKEN"]).toBe("[redacted]");
  });

  it("the worker's consumer: `consultation.completed` → the same flow; without ABDM configured it does nothing", async () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    const handler = careContextConsumer(db, hipConfig(fake), fake.fetch, now);
    const event = {
      seq: 1, eventId: "E1", name: "consultation.completed", patientId: fx.patientId, correlationId: null, occurredAt: now(),
      payload: {
        encounterId: fx.encA, patientId: fx.patientId, departmentId: "d", doctorId: "doc", serviceDate: "2026-09-25", sessionId: "s1",
        roomId: null, tokenNo: 1, visitType: "new", followUpDays: 7, followUpExtended: false,
        admissionAdvised: false, referralIssued: false, prescriptionCount: 1, icd10Code: "A01.0",
      },
    };
    await careContextConsumer(db, null)(event);
    expect(await db.select().from(abdmCareContexts)).toHaveLength(0);
    await handler(event);
    await handler(event);
    expect(await db.select().from(abdmCareContexts)).toHaveLength(1);
    expect(fake.hip.calls(HIP_PATHS.generateToken)).toHaveLength(1);
    expect(ABDM_CARE_CONTEXT_CONSUMER).toBe("abdm.care_contexts");
  });
});
