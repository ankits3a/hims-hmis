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
import { approvalFlowDefinition } from "../src/kernel/approvals/flow";
import { registerApprovalType } from "../src/kernel/approvals/types";
import { approveRequest } from "../src/kernel/approvals/decisions";
import { createDraft, activateDefinition } from "../src/kernel/workflow/definitions";
import { withTx } from "../src/kernel/db/client";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { TARIFF_REVISION_APPROVAL_TYPE, tariffManifest, upsertGstCategory, upsertGstSettings } from "../src/modules/tariff";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

describe("tariff e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(tariffManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let adminToken: string;
  let drafterToken: string;
  let readerToken: string;
  let ownerActor: Actor;

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

    await createRole(db, "tariff_admin", "Tariff Admin");
    for (const p of tariffManifest.permissions) {
      await grantPermissionToRole(db, registry, "tariff_admin", p);
    }
    await createRole(db, "tariff_drafter", "Tariff Drafter");
    await grantPermissionToRole(db, registry, "tariff_drafter", "tariff.versions.draft");
    await grantPermissionToRole(db, registry, "tariff_drafter", "tariff.read");
    await createRole(db, "reader", "Reader");
    await grantPermissionToRole(db, registry, "reader", "tariff.read");
    await createRole(db, "owner", "Owner");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const admin = await mk("admin");
    const drafter = await mk("drafter");
    const reader = await mk("reader");
    const ownerUser = await mk("owner_user");
    adminToken = admin.token;
    drafterToken = drafter.token;
    readerToken = reader.token;
    const adminActor: Actor = { type: "user", id: admin.id };
    ownerActor = { type: "user", id: ownerUser.id };

    await assignRole(db, { userId: admin.id, roleKey: "tariff_admin", scopeType: "hospital" });
    await assignRole(db, { userId: drafter.id, roleKey: "tariff_drafter", scopeType: "hospital" });
    await assignRole(db, { userId: reader.id, roleKey: "reader", scopeType: "hospital" });
    await assignRole(db, { userId: ownerUser.id, roleKey: "owner", scopeType: "hospital" });

    // GST config: consultation exempt/1800 + pharmacy 1200 + settings (T5/context.test.ts precedent).
    await withTx(db, (tx) =>
      upsertGstCategory(tx, adminActor, {
        category: "consultation", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) =>
      upsertGstCategory(tx, adminActor, {
        category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null,
      }),
    );
    await withTx(db, (tx) => upsertGstSettings(tx, adminActor, { compositeHealthcareExempt: true, caSigned: false }));

    // Two-step tariff_revision type registration — exactly the T4 beforeEach block (merge.test.ts
    // precedent): builder -> Plan 03 draft -> activate (drafter != activator) -> registerApprovalType.
    const def = approvalFlowDefinition({
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      closureSlaMinutes: 1440,
    });
    const draftDef = await createDraft(db, ownerActor, def);
    await activateDefinition(db, adminActor, draftDef.definitionId);
    await registerApprovalType(db, adminActor, {
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      urgencyClass: "routine",
      actFirstAllowed: false,
    });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  it("the spine over HTTP: draft -> items -> submit -> approve -> activate", async () => {
    const svc1 = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "CONS-1", name: "Consultation", category: "consultation" }).expect(201);
    const svc2 = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "PHARM-1", name: "Drug A", category: "pharmacy" }).expect(201);
    const consId = svc1.body.serviceId as string;
    const drugId = svc2.body.serviceId as string;

    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;

    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 50000 }).expect(200);
    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${drugId}`).set(...auth(drafterToken))
      .send({ pricePaise: 20000 }).expect(200);

    // submit/activate/simulate are ACTIONS, not creations — @HttpCode(200) — the handler
    // annotation and this assertion are the SAME number by construction (§3.18).
    const submitted = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/submit`).set(...auth(drafterToken)).send({}).expect(200);
    const approvalId = submitted.body.approvalId as string;

    await approveRequest(db, ownerActor, { approvalId, note: "approved" });

    // Activator (admin) is a different user than the drafter — satisfies D5 SoD.
    const activated = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/activate`).set(...auth(adminToken))
      .send({ effectiveFrom: "2026-01-01T00:00:00.000Z" }).expect(200);
    expect(activated.body.versionNo).toBe(1);

    const detail = await request(app.getHttpServer())
      .get(`/tariff/versions/${versionId}`).set(...auth(adminToken)).expect(200);
    expect(detail.body.version.status).toBe("activated");
    expect(new Date(detail.body.version.effectiveFrom as string).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("simulate over HTTP: a draft revision priced and diffed against the active version", async () => {
    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "CONS-1", name: "Consultation", category: "consultation" }).expect(201);
    const consId = svc.body.serviceId as string;

    // Baseline: activated version, consultation @ 50000.
    const baseline = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const baselineId = baseline.body.versionId as string;
    await request(app.getHttpServer())
      .put(`/tariff/versions/${baselineId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 50000 }).expect(200);
    const baseSubmit = await request(app.getHttpServer())
      .post(`/tariff/versions/${baselineId}/submit`).set(...auth(drafterToken)).send({}).expect(200);
    await approveRequest(db, ownerActor, { approvalId: baseSubmit.body.approvalId as string, note: "approved" });
    await request(app.getHttpServer())
      .post(`/tariff/versions/${baselineId}/activate`).set(...auth(adminToken))
      .send({ effectiveFrom: "2026-01-01T00:00:00.000Z" }).expect(200);

    // Second draft (not activated): consultation @ 60000.
    const draft2 = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const draft2Id = draft2.body.versionId as string;
    await request(app.getHttpServer())
      .put(`/tariff/versions/${draft2Id}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 60000 }).expect(200);

    const sim = await request(app.getHttpServer())
      .post(`/tariff/versions/${draft2Id}/simulate`).set(...auth(drafterToken))
      .send({ lines: [{ lineId: "L1", serviceId: consId, qty: 1 }] }).expect(200);

    // Consultation is GST-exempt — taxes are zero on both sides (hand-derived).
    expect(sim.body.totals).toEqual({
      currentNetPaise: 50000, draftNetPaise: 60000, deltaPaise: 10000,
      currentTaxPaise: 0, draftTaxPaise: 0, taxDeltaPaise: 0,
    });
  });

  it("permission walls: no token is 401, wrong permission is 403", async () => {
    await request(app.getHttpServer()).get("/tariff/services").expect(401);
    await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(readerToken))
      .send({ code: "X", name: "X", category: "consultation" }).expect(403);
  });

  it("validation walls: qty, pricePaise, and effectiveFrom are checked before any domain logic runs", async () => {
    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;

    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/simulate`).set(...auth(drafterToken))
      .send({ lines: [{ lineId: "L1", serviceId: "whatever", qty: 1.5 }] }).expect(400);

    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/whatever`).set(...auth(drafterToken))
      .send({ pricePaise: -1 }).expect(400);

    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/activate`).set(...auth(adminToken))
      .send({ effectiveFrom: "not-a-date" }).expect(400);
  });

  it("state walls: activating before approval and editing items after submit both 409", async () => {
    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "CONS-1", name: "Consultation", category: "consultation" }).expect(201);
    const consId = svc.body.serviceId as string;

    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;
    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 50000 }).expect(200);

    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/submit`).set(...auth(drafterToken)).send({}).expect(200);

    // Not yet approved.
    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/activate`).set(...auth(adminToken))
      .send({ effectiveFrom: "2026-01-01T00:00:00.000Z" }).expect(409);

    // Submitted — items are locked (D5: writable only while draft).
    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 60000 }).expect(409);
  });

  it("SoD wall: the drafter, granted activate too, is blocked; a different eligible user succeeds", async () => {
    // The drafter EXPLICITLY holds tariff.versions.activate — so the 403 below can only be the
    // SoD check, never the permission guard (§3.14b: two mechanisms must not produce the same
    // observable).
    await grantPermissionToRole(db, registry, "tariff_drafter", "tariff.versions.activate");

    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "CONS-1", name: "Consultation", category: "consultation" }).expect(201);
    const consId = svc.body.serviceId as string;

    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;
    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 50000 }).expect(200);

    const submitted = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/submit`).set(...auth(drafterToken)).send({}).expect(200);

    // Approval GRANTED before the drafter's attempt — the ordering is the discriminator: the
    // refusal below cannot be "not yet approved", only SoD.
    await approveRequest(db, ownerActor, { approvalId: submitted.body.approvalId as string, note: "approved" });

    const blocked = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/activate`).set(...auth(drafterToken))
      .send({ effectiveFrom: "2026-01-01T00:00:00.000Z" }).expect(403);
    expect(JSON.stringify(blocked.body)).toContain("sod_drafter_activator");

    const activated = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/activate`).set(...auth(adminToken))
      .send({ effectiveFrom: "2026-01-01T00:00:00.000Z" }).expect(200);
    expect(activated.body.versionNo).toBe(1);
  });
});
