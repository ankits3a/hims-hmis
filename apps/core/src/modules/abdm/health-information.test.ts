import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { IgChecker, loadSlimIg } from "../../../test/helpers/fhir-ig";
import {
  ABHA_ADDRESS, HIP, SECRET, VISIT_A, VISIT_B, hipRuntime, inbound, seedHipFixture,
} from "../../../test/helpers/abdm-hip";
import {
  abdmCareContexts, abdmConsents, abdmHealthInfoRequests, abdmMessages, events, phiAccessLog,
} from "../../kernel/db/schema";
import { FideliusKeyPair } from "./fidelius";
import { HIP_PATHS } from "./hip-client";
import type { HipFixture } from "../../../test/helpers/abdm-hip";
import type { FakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import type { AbdmRuntime } from "./runtime";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S2 — CONSENT AND THE HEALTH-INFORMATION TRANSFER (FT HIP_INIT_GRANT/REVOKE/EXPIRE_CONSENT,
 * HIP_INIT_SHARE_CARECONTEXT), against the fake gateway and a fake HIU that DECRYPTS what arrives:
 *
 *   · a request inside the artefact → the bundles for exactly its care contexts, HI types and dates,
 *     each passing the IG check, none carrying a restricted, unverified, superseded or unsigned record;
 *   · a request OUTSIDE it — another care context, another HI type, other dates, an expired, revoked
 *     or unknown consent, another HIU, bad key material, a plain-HTTP push URL — releases NOTHING;
 *   · a second delivery of one transaction releases nothing again; `manual` holds;
 *   · every release is in abdm_messages, phi_access_log and the event spine — and our private key
 *     and the plaintext are in no stored row.
 */
describe("Consents + HealthInformation", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);
  let fx: HipFixture;
  const checker = new IgChecker(loadSlimIg());
  const OWN_PRIVATE = "AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4="; // the fidelius-cli README sender key — a KNOWN key, so the test can look for it
  const OWN_NONCE = "lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y=";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedHipFixture(db);
    clock = Date.parse("2026-09-26T06:00:00.000Z");
  });

  const setup = (env: Record<string, string> = {}): { fake: FakeAbdmGateway; rt: AbdmRuntime } => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    const rt = hipRuntime(db, fake, now, { keyPair: () => FideliusKeyPair.fromPrivateKey(OWN_PRIVATE, OWN_NONCE) }, env);
    return { fake, rt };
  };

  /** Both visits linked to the patient's ABHA (as HIP-initiated linking leaves them). */
  const linkBoth = async (): Promise<void> => {
    for (const [encounterId, ref] of [[fx.encA, VISIT_A], [fx.encB, VISIT_B]] as const) {
      await db.insert(abdmCareContexts).values({
        id: `cc-${ref}`, patientId: fx.patientId, encounterId, hipId: HIP, referenceNumber: ref, patientReference: fx.uhid,
        display: ref, hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"], abhaAddress: ABHA_ADDRESS,
        status: "linked", linkedVia: "hip", linkedAt: now(),
      });
    }
  };

  const consentBody = (over: { consentId?: string; hiTypes?: string[]; careContexts?: string[]; from?: string; to?: string; eraseAt?: string; hipId?: string; status?: string } = {}) => ({
    notification: {
      status: over.status ?? "GRANTED",
      consentId: over.consentId ?? "consent-1",
      consentDetail: {
        schemaVersion: "v3", consentId: over.consentId ?? "consent-1", createdAt: "2026-09-26T05:59:00.000Z",
        patient: { id: ABHA_ADDRESS },
        careContexts: (over.careContexts ?? [VISIT_A, VISIT_B]).map((careContextReference) => ({ patientReference: fx.uhid, careContextReference })),
        purpose: { text: "Care Management", code: "CAREMGT", refUri: "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse" },
        hip: { id: over.hipId ?? HIP },
        hiu: { id: "FAKE-HIU-001" },
        consentManager: { id: "sbx" },
        requester: { name: "Dr. Requester", identifier: { value: "R1", type: "REGNO", system: "https://www.mciindia.org" } },
        hiTypes: over.hiTypes ?? ["OPConsultation", "Prescription", "DiagnosticReport"],
        permission: {
          accessMode: "VIEW",
          dateRange: { from: over.from ?? "2026-09-01T00:00:00.000Z", to: over.to ?? "2026-09-30T23:59:59.000Z" },
          dataEraseAt: over.eraseAt ?? "2026-10-26T00:00:00.000Z",
          frequency: { unit: "HOUR", value: 1, repeats: 0 },
        },
      },
      signature: "fake-signature",
      grantAcknowledgement: false,
    },
  });
  const grant = async (s: { fake: FakeAbdmGateway; rt: AbdmRuntime }, over: Parameters<typeof consentBody>[0] = {}) => {
    await s.rt.consents!.handleNotify(await inbound(db, "/api/v3/consent/request/hip/notify", s.fake.signedCallback(consentBody(over))));
  };
  const hiBody = (over: { transactionId?: string; consentId?: string; from?: string; to?: string; dataPushUrl?: string; keyMaterial?: Record<string, unknown>; extra?: Record<string, unknown> } = {}, fake?: FakeAbdmGateway) => ({
    transactionId: over.transactionId ?? "txn-1",
    hiRequest: {
      consent: { id: over.consentId ?? "consent-1" },
      dateRange: { from: over.from ?? "2026-09-01T00:00:00.000Z", to: over.to ?? "2026-09-30T23:59:59.000Z" },
      dataPushUrl: over.dataPushUrl ?? fake!.hiu.dataPushUrl(over.consentId ?? "consent-1"),
      keyMaterial: over.keyMaterial ?? fake!.hiu.keyMaterial(),
      ...(over.extra ?? {}),
    },
  });
  const request = async (s: { fake: FakeAbdmGateway; rt: AbdmRuntime }, over: Parameters<typeof hiBody>[0] = {}, headers: { hiuId?: string } = {}) => {
    const m = await inbound(db, "/api/v3/hip/health-information/request", s.fake.signedCallback(hiBody(over, s.fake), headers));
    await s.rt.healthInformation!.handleRequest(m);
    return m;
  };
  const bundlesOf = (fake: FakeAbdmGateway): { ref: string; profile: string; bundle: Record<string, unknown> }[] =>
    fake.hiu.received.map((r) => ({
      ref: r.careContextReference,
      profile: String(((r.bundle.entry as { resource: { meta: { profile: string[] } } }[])[0]!.resource.meta.profile[0])).split("/").pop()!,
      bundle: r.bundle,
    }));

  it("CONSENT NOTIFY: the artefact is stored and acknowledged OK (within the request); a repeat updates the one row", async () => {
    const s = setup();
    await grant(s);
    await grant(s);
    const rows = await db.select().from(abdmConsents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consentId: "consent-1", status: "GRANTED", hipId: HIP, patientId: fx.patientId, hiuId: "FAKE-HIU-001", purposeCode: "CAREMGT",
      hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"],
    });
    expect(rows[0]!.dataEraseAt!.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    const acks = s.fake.hip.calls(HIP_PATHS.consentOnNotify);
    expect(acks.map((a) => a.body.acknowledgement)).toEqual([{ status: "OK", consentId: "consent-1" }, { status: "OK", consentId: "consent-1" }]);
  });

  it("a GRANTED artefact for ANOTHER HIP is refused and stored nowhere; a REVOKE is recorded and a late GRANTED does not bring it back", async () => {
    const s = setup();
    await grant(s, { hipId: "IN9999999999" });
    expect(await db.select().from(abdmConsents)).toHaveLength(0);
    expect(s.fake.hip.calls(HIP_PATHS.consentOnNotify)[0]!.body.error).toMatchObject({ code: "ABDM-1000" });
    await grant(s);
    await s.rt.consents!.handleNotify(await inbound(db, "/api/v3/consent/request/hip/notify",
      s.fake.signedCallback({ notification: { status: "REVOKED", consentId: "consent-1" } })));
    await grant(s);
    const [row] = await db.select().from(abdmConsents);
    expect(row!.status).toBe("REVOKED");
  });

  it("IN SCOPE: ACKNOWLEDGED, then every bundle of both visits pushed ENCRYPTED; the HIU decrypts each, every one passes the IG check, checksums match", async () => {
    const s = setup();
    await linkBoth();
    await grant(s);
    const m = await request(s);
    const [ack] = s.fake.hip.calls(HIP_PATHS.hiOnRequest);
    expect(ack!.body).toEqual({ hiRequest: { transactionId: "txn-1", sessionStatus: "ACKNOWLEDGED" }, response: { requestId: m.requestId } });

    const got = bundlesOf(s.fake);
    expect(got.map((g) => `${g.ref}:${g.profile}`).sort()).toEqual([
      `${VISIT_A}:DiagnosticReportRecord`, `${VISIT_A}:DiagnosticReportRecord`, `${VISIT_A}:OPConsultRecord`, `${VISIT_A}:PrescriptionRecord`,
      `${VISIT_B}:OPConsultRecord`, `${VISIT_B}:PrescriptionRecord`,
    ].sort());
    for (const g of got) expect(checker.checkBundle(g.bundle)).toEqual([]);
    expect(s.fake.hiu.received.every((r) => r.checksumOk)).toBe(true);
    const page = s.fake.hiu.pushes[0]!.body as { pageNumber: number; pageCount: number; transactionId: string; keyMaterial: { dhPublicKey: { keyValue: string }; nonce: string } };
    expect(page).toMatchObject({ pageNumber: 0, pageCount: 1, transactionId: "txn-1" });
    expect(page.keyMaterial.nonce).toBe(OWN_NONCE);
    expect(s.fake.hiu.pushes[0]!.headers.authorization).toBeUndefined();

    const [notify] = s.fake.hip.calls(HIP_PATHS.hiNotify);
    expect(notify!.body.notification).toMatchObject({
      consentId: "consent-1", transactionId: "txn-1", notifier: { type: "HIP", id: HIP },
      statusNotification: { sessionStatus: "TRANSFERRED", hipId: HIP },
    });
    const statuses = (notify!.body.notification as { statusNotification: { statusResponses: { careContextReference: string; hiStatus: string }[] } }).statusNotification.statusResponses;
    expect(statuses.map((st) => [st.careContextReference, st.hiStatus]).sort()).toEqual([[VISIT_B, "DELIVERED"], [VISIT_A, "DELIVERED"]]);
    const [row] = await db.select().from(abdmHealthInfoRequests);
    expect(row).toMatchObject({ status: "transferred", entryCount: 6, patientId: fx.patientId });
  });

  it("NOTHING HELD BACK REACHES THE HIU: no restricted test or study, no unverified or superseded value, no draft, no superseded prescription, no internal note", async () => {
    const s = setup();
    await linkBoth();
    await grant(s);
    await request(s);
    const plaintext = s.fake.hiu.received.map((r) => r.plaintext).join("\n");
    expect(plaintext).toContain("Haemoglobin");
    expect(plaintext).toContain("Paracetamol 650 mg tablet");
    for (const held of Object.values(fx.heldBack)) expect(plaintext).not.toContain(held);
    expect(plaintext).not.toContain("HIV");
    // Imaging text rides base64 — decode every attachment and look there too.
    const attachments = s.fake.hiu.received.flatMap((r) => (r.bundle.entry as { resource: { resourceType: string; content?: { attachment: { data: string } }[] } }[])
      .filter((e) => e.resource.resourceType === "DocumentReference")
      .map((e) => Buffer.from(e.resource.content![0]!.attachment.data, "base64").toString("utf8")));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toContain("No active lung lesion.");
    for (const a of attachments) for (const held of Object.values(fx.heldBack)) expect(a).not.toContain(held);
    expect(attachments[0]).not.toContain("RESTRICTED-IMPRESSION");
    expect(attachments[0]).not.toContain("DRAFT-IMPRESSION");
  });

  it("ONLY the artefact's care contexts, HI types and dates: another care context, another type, records outside the range are not released", async () => {
    const s = setup();
    await linkBoth();
    await grant(s, { consentId: "only-b", careContexts: [VISIT_B] });
    await request(s, { transactionId: "t-b", consentId: "only-b" });
    expect(new Set(bundlesOf(s.fake).map((g) => g.ref))).toEqual(new Set([VISIT_B]));

    s.fake.hiu.received.length = 0;
    await grant(s, { consentId: "only-rx", hiTypes: ["Prescription"] });
    await request(s, { transactionId: "t-rx", consentId: "only-rx" });
    expect(bundlesOf(s.fake).map((g) => g.profile)).toEqual(["PrescriptionRecord", "PrescriptionRecord"]);

    s.fake.hiu.received.length = 0;
    await grant(s, { consentId: "only-late-sept", from: "2026-09-20T00:00:00.000Z" });
    await request(s, { transactionId: "t-late", consentId: "only-late-sept", from: "2026-09-20T00:00:00.000Z" });
    expect(new Set(bundlesOf(s.fake).map((g) => g.ref))).toEqual(new Set([VISIT_A]));

    // A request narrower than the artefact: only the records inside the REQUEST's range.
    s.fake.hiu.received.length = 0;
    await request(s, { transactionId: "t-narrow", consentId: "only-late-sept", from: "2026-09-25T09:30:00.000Z", to: "2026-09-25T23:00:00.000Z" });
    expect(bundlesOf(s.fake).map((g) => g.profile)).toEqual(["DiagnosticReportRecord"]); // the X-ray, signed 10:00
  });

  describe("a request OUTSIDE the artefact releases NOTHING (on-request error, no push, no notify, no audit)", () => {
    const cases: [string, (s: { fake: FakeAbdmGateway; rt: AbdmRuntime }) => Promise<unknown>, RegExp][] = [
      ["an unknown consent", (s) => request(s, { consentId: "nope" }), /not known/],
      ["dates beyond the consented range", (s) => request(s, { to: "2026-10-05T00:00:00.000Z" }), /outside the consented range/],
      ["dates before the consented range", (s) => request(s, { from: "2026-08-01T00:00:00.000Z" }), /outside the consented range/],
      ["a care context the consent does not name", (s) => request(s, { extra: { careContexts: [{ patientReference: "HMS00000013", careContextReference: "V2609250005" }] } }), /care context the consent does not/],
      ["an HI type the consent does not name", async (s) => {
        await grant(s, { consentId: "consent-1", hiTypes: ["Prescription"] });
        return request(s, { extra: { hiTypes: ["OPConsultation"] } });
      }, /HI type the consent does not/],
      ["another HIU", (s) => request(s, {}, { hiuId: "SOMEONE-ELSE" }), /not the consent's HIU/],
      ["a plain-HTTP push URL", (s) => request(s, { dataPushUrl: "http://fake-hiu.test/hiu/data/push/consent-1" }), /HTTPS/],
      ["key material that is not a Curve25519 point", (s) => request(s, { keyMaterial: { cryptoAlg: "ECDH", curve: "Curve25519", dhPublicKey: { keyValue: Buffer.alloc(65, 4).toString("base64") }, nonce: Buffer.alloc(32, 1).toString("base64") } }), /invalid key material/],
    ];
    for (const [name, act, reason] of cases) {
      it(name, async () => {
        const s = setup();
        await linkBoth();
        await grant(s);
        await act(s);
        const acks = s.fake.hip.calls(HIP_PATHS.hiOnRequest);
        expect(acks).toHaveLength(1);
        expect((acks[0]!.body.error as { message: string }).message).toMatch(reason);
        expect(s.fake.hiu.pushes).toHaveLength(0);
        expect(s.fake.hip.calls(HIP_PATHS.hiNotify)).toHaveLength(0);
        expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.health_information"))).toHaveLength(0);
        const [row] = await db.select().from(abdmHealthInfoRequests);
        expect(row).toMatchObject({ status: "refused", entryCount: 0 });
      });
    }

    it("after the consent EXPIRES (dataEraseAt), and once it is REVOKED", async () => {
      const s = setup();
      await linkBoth();
      await grant(s, { eraseAt: "2026-09-26T07:00:00.000Z" });
      clock = Date.parse("2026-09-26T07:00:01.000Z");
      await request(s, { transactionId: "t-expired" });
      clock = Date.parse("2026-09-26T06:00:00.000Z");
      await grant(s, { consentId: "consent-2" });
      await s.rt.consents!.handleNotify(await inbound(db, "/api/v3/consent/request/hip/notify",
        s.fake.signedCallback({ notification: { status: "REVOKED", consentId: "consent-2" } })));
      await request(s, { transactionId: "t-revoked", consentId: "consent-2" });
      const errors = s.fake.hip.calls(HIP_PATHS.hiOnRequest).map((a) => (a.body.error as { message: string }).message);
      expect(errors).toEqual(["consent has expired (dataEraseAt)", "consent is REVOKED"]);
      expect(s.fake.hiu.pushes).toHaveLength(0);
    });

    it("a care context not linked here to the consenting patient is not released, and if it is the only one, nothing is", async () => {
      const s = setup();
      await linkBoth();
      await grant(s, { consentId: "other", careContexts: ["V2609250005"] });
      await request(s, { consentId: "other" });
      expect((s.fake.hip.calls(HIP_PATHS.hiOnRequest)[0]!.body.error as { message: string }).message).toMatch(/no care context of this consent/);
      expect(s.fake.hiu.pushes).toHaveLength(0);
    });
  });

  it("a SECOND DELIVERY of the same transaction (a new REQUEST-ID) releases nothing again", async () => {
    const s = setup();
    await linkBoth();
    await grant(s);
    await request(s);
    await request(s);
    expect(s.fake.hiu.pushes).toHaveLength(1);
    expect(s.fake.hip.calls(HIP_PATHS.hiOnRequest)).toHaveLength(1);
    expect(await db.select().from(abdmHealthInfoRequests)).toHaveLength(1);
  });

  it("MANUAL release policy: acknowledged and HELD — nothing is built or pushed", async () => {
    const s = setup({ ABDM_CONSENT_RELEASE: "manual" });
    await linkBoth();
    await grant(s);
    await request(s);
    expect(s.fake.hip.calls(HIP_PATHS.hiOnRequest)[0]!.body.hiRequest).toEqual({ transactionId: "txn-1", sessionStatus: "ACKNOWLEDGED" });
    expect(s.fake.hiu.pushes).toHaveLength(0);
    expect((await db.select().from(abdmHealthInfoRequests))[0]!.status).toBe("held");
  });

  it("EVERY RELEASE IS LOGGED: the push in abdm_messages (summary only), a PHI row per visit, one event", async () => {
    const s = setup();
    await linkBoth();
    await grant(s);
    await request(s);
    const push = (await db.select().from(abdmMessages).where(eq(abdmMessages.kind, "hiu.data_push")))[0]!;
    expect(push).toMatchObject({ direction: "out", patientId: fx.patientId, httpStatus: 202 });
    expect(JSON.stringify(push.body)).not.toContain("\"content\"");
    const phi = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.health_information"));
    expect(phi.map((p) => p.encounterId).sort()).toEqual([fx.encA, fx.encB].sort());
    expect(phi.every((p) => p.patientId === fx.patientId && p.actorId === "abdm")).toBe(true);
    const ev = await db.select().from(events).where(eq(events.name, "abdm.health_information_released"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ transactionId: "txn-1", consentId: "consent-1", hiuId: "FAKE-HIU-001", entryCount: 6 });
  });

  it("OUR PRIVATE KEY, THE CLIENT SECRET AND THE PLAINTEXT ARE IN NO abdm_messages ROW (every row read back)", async () => {
    const s = setup();
    await linkBoth();
    await grant(s);
    await request(s);
    const rows = await db.select().from(abdmMessages);
    expect(rows.length).toBeGreaterThan(5);
    const d = BigInt(`0x${Buffer.from(OWN_PRIVATE, "base64").toString("hex")}`);
    const text = JSON.stringify(rows);
    for (const secret of [OWN_PRIVATE, d.toString(), d.toString(16), SECRET]) expect(text).not.toContain(secret);
    expect(text).not.toContain("Haemoglobin");
    expect(text).not.toContain("Paracetamol");
    // The public half is there, as it must be (it travels in the push).
    expect(text).toContain(FideliusKeyPair.fromPrivateKey(OWN_PRIVATE, OWN_NONCE).publicKeyX509());
  });
});
