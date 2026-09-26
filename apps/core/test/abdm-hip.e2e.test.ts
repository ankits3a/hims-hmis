import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createFakeAbdmGateway } from "./helpers/abdm-fake-gateway";
import { IgChecker, loadSlimIg } from "./helpers/fhir-ig";
import { ABHA_ADDRESS, HIP, SECRET, VISIT_A, VISIT_B, seedHipFixture } from "./helpers/abdm-hip";
import { ABDM_FETCH, HIP_PATHS } from "../src/modules/abdm";
import { abdmCareContexts, abdmHealthInfoRequests, abdmMessages } from "../src/kernel/db/schema";
import { CONFIG } from "../src/kernel/tokens";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { AppConfig } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";
import type { HipFixture } from "./helpers/abdm-hip";

/**
 * ABDM S2 — M2 through the REAL application: the S0 callback routes (ABDM's JWT, the de-duplicating
 * log) dispatching to the S2 handlers the module registered at boot.
 *
 *   · consent notify → HI request → the push the fake HIU decrypts, every bundle passing the IG check;
 *   · a RETRY of the HI request with the same REQUEST-ID is 202 and releases nothing again;
 *   · the route stores a link-confirm OTP and an on-generate-token link token REDACTED.
 */
jest.setTimeout(120_000);

const BASE = "/abdm/callbacks/api/v3";

function workerDbUrl(): string {
  const url = new URL(requireEnv("TEST_DATABASE_URL"));
  url.pathname = `${url.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
  return url.toString();
}

describe("ABDM S2 e2e — the hospital as HIP", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let cfg: AppConfig;
  let fx: HipFixture;
  const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, hipId: HIP });
  const checker = new IgChecker(loadSlimIg());

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    cfg = loadConfig({
      DATABASE_URL: workerDbUrl(), SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl, ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: HIP,
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
    fx = await seedHipFixture(db);
    fake.hiu.received.length = 0;
    fake.hiu.pushes.length = 0;
    for (const [encounterId, ref] of [[fx.encA, VISIT_A], [fx.encB, VISIT_B]] as const) {
      await db.insert(abdmCareContexts).values({
        id: `cc-${ref}`, patientId: fx.patientId, encounterId, hipId: HIP, referenceNumber: ref, patientReference: fx.uhid,
        display: ref, hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"], abhaAddress: ABHA_ADDRESS,
        status: "linked", linkedVia: "hip", linkedAt: new Date(),
      });
    }
  });

  const post = (path: string, cb: { headers: Record<string, string>; body: Record<string, unknown> }) =>
    request(app.getHttpServer()).post(`${BASE}${path}`).set(cb.headers).send(cb.body);

  it("consent notify → HI request → the push the HIU decrypts; a retry of the SAME REQUEST-ID releases nothing again", async () => {
    const now = Date.now();
    const consent = fake.signedCallback({
      notification: {
        status: "GRANTED", consentId: "c-e2e", signature: "sig",
        consentDetail: {
          consentId: "c-e2e", patient: { id: ABHA_ADDRESS }, hip: { id: HIP }, hiu: { id: fake.hiu.id },
          careContexts: [{ patientReference: fx.uhid, careContextReference: VISIT_A }],
          purpose: { code: "CAREMGT" }, hiTypes: ["OPConsultation", "DiagnosticReport"],
          permission: { accessMode: "VIEW", dateRange: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.000Z" }, dataEraseAt: new Date(now + 86_400_000).toISOString() },
        },
      },
    });
    expect((await post("/consent/request/hip/notify", consent)).status).toBe(202);
    expect(fake.hip.calls(HIP_PATHS.consentOnNotify).at(-1)!.body.acknowledgement).toEqual({ status: "OK", consentId: "c-e2e" });

    const hi = fake.signedCallback({
      transactionId: "t-e2e",
      hiRequest: {
        consent: { id: "c-e2e" }, dateRange: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.000Z" },
        dataPushUrl: fake.hiu.dataPushUrl("c-e2e"), keyMaterial: fake.hiu.keyMaterial(),
      },
    }, { hiuId: fake.hiu.id });
    expect((await post("/hip/health-information/request", hi)).status).toBe(202);
    expect((await post("/hip/health-information/request", hi)).status).toBe(202); // ABDM's retry

    expect(fake.hiu.pushes).toHaveLength(1);
    const profiles = fake.hiu.received.map((r) => String(((r.bundle.entry as { resource: { meta: { profile: string[] } } }[])[0]!.resource.meta.profile[0])).split("/").pop());
    expect(profiles.sort()).toEqual(["DiagnosticReportRecord", "DiagnosticReportRecord", "OPConsultRecord"]);
    for (const r of fake.hiu.received) {
      expect(r.careContextReference).toBe(VISIT_A);
      expect(checker.checkBundle(r.bundle)).toEqual([]);
    }
    const inbound = await db.select().from(abdmMessages).where(eq(abdmMessages.kind, "callback.hip/health-information/request"));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.dispatch).toBe("handled");
    expect((await db.select().from(abdmHealthInfoRequests))[0]).toMatchObject({ status: "transferred", entryCount: 3 });
  });

  it("the ROUTE stores a link-confirm OTP and an on-generate-token link token REDACTED (the handler still ran)", async () => {
    expect((await post("/hip/link/care-context/confirm", fake.signedCallback({ confirmation: { linkRefNumber: "no-such-ref", token: "482913" } }))).status).toBe(202);
    const linkToken = fake.hip.issueLinkToken(ABHA_ADDRESS);
    expect((await post("/hip/token/on-generate-token", fake.signedCallback({ abhaAddress: ABHA_ADDRESS, linkToken, response: { requestId: "no-such-request" } }))).status).toBe(202);
    const rows = await db.select().from(abdmMessages);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("482913");
    expect(text).not.toContain(linkToken);
    const confirm = rows.find((r) => r.kind === "callback.hip/link/care-context/confirm")!;
    expect(confirm.body).toEqual({ confirmation: { linkRefNumber: "no-such-ref", token: "[redacted]" } });
    expect(confirm.dispatch).toBe("handled"); // answered on-confirm with "Unknown link reference"
    expect((fake.hip.calls(HIP_PATHS.onConfirm).at(-1)!.body.error as { message: string }).message).toBe("Unknown link reference");
    const gen = rows.find((r) => r.kind === "callback.hip/token/on-generate-token")!;
    expect((gen.body as { linkToken: string }).linkToken).toBe("[redacted]");
    expect(gen.dispatch).toBe("failed"); // it answers no request of ours
  });
});
