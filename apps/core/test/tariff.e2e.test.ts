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

    // THE OPENING: the simulate route now runs on tariff.read (owner decision — a read-only
    // user must be able to run a pricing impact simulation). loadPricingContext needs an
    // ACTIVATED baseline to resolve "current" pricing (context.ts: version_not_active), so —
    // same shape as the "simulate over HTTP" test — the drafter/admin stand up an activated
    // baseline first, then a second priced draft, before the reader calls simulate.
    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "CONS-1", name: "Consultation", category: "consultation" }).expect(201);
    const consId = svc.body.serviceId as string;

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

    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;
    await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/${consId}`).set(...auth(drafterToken))
      .send({ pricePaise: 60000 }).expect(200);

    const sim = await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/simulate`).set(...auth(readerToken))
      .send({ lines: [{ lineId: "L1", serviceId: consId, qty: 1 }] }).expect(200);
    // A well-formed ImpactReport: { lines, totals, byService } — not just a 200, an actual body.
    expect(sim.body).toEqual(expect.objectContaining({
      lines: expect.any(Array),
      totals: expect.objectContaining({
        currentNetPaise: expect.any(Number),
        draftNetPaise: expect.any(Number),
        deltaPaise: expect.any(Number),
      }),
      byService: expect.any(Array),
    }));

    // THE WALLS THAT MUST STILL HOLD: tariff.read is not a blanket grant. The same reader is
    // still refused on a tariff.services.manage route (asserted above) and on a
    // tariff.config.manage route, and simulate is still 401 with no token at all — proving the
    // 200 above is attributable to the specific permission move, not to an over-granted fixture
    // (§3.14b: two mechanisms must not produce the same observable).
    await request(app.getHttpServer())
      .put("/tariff/gst/settings").set(...auth(readerToken))
      .send({ caSigned: true }).expect(403);
    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/simulate`)
      .send({ lines: [{ lineId: "L1", serviceId: consId, qty: 1 }] }).expect(401);
  });

  it("validation walls: qty, pricePaise, and effectiveFrom are checked before any domain logic runs", async () => {
    const draft = await request(app.getHttpServer())
      .post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versionId = draft.body.versionId as string;

    await request(app.getHttpServer())
      .post(`/tariff/versions/${versionId}/simulate`).set(...auth(drafterToken))
      .send({ lines: [{ lineId: "L1", serviceId: "whatever", qty: 1.5 }] }).expect(400);

    const bad = await request(app.getHttpServer())
      .put(`/tariff/versions/${versionId}/items/whatever`).set(...auth(drafterToken))
      .send({ pricePaise: -1 }).expect(400);
    // Two mechanisms answer 400 on this route — the zod DTO and the domain's invalid_paise. The
    // zod ISSUE SHAPE in the body proves the DTO refused it before any domain code ran (§3.14b);
    // the domain path would carry the string "invalid_paise: …" instead.
    expect(bad.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "too_small", path: ["pricePaise"] })]),
    );

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

  it("config routes over HTTP: rules and GST config round-trip, updates visible on re-read", async () => {
    // POST /tariff/rules creates…
    const created = await request(app.getHttpServer())
      .post("/tariff/rules").set(...auth(adminToken))
      .send({ ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap",
              params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 } }).expect(201);
    expect(typeof created.body.id).toBe("string");

    const listed = await request(app.getHttpServer()).get("/tariff/rules").set(...auth(readerToken)).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].ruleKey).toBe("CAP-CHARITY");

    // …and UPDATES through the same route (shipped upsert semantics; the M7 branch over HTTP).
    await request(app.getHttpServer())
      .post("/tariff/rules").set(...auth(adminToken))
      .send({ ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap v2",
              params: { discountCategory: "charity", maxBps: 3000, approvalAboveBps: 1000 } }).expect(201);
    const relisted = await request(app.getHttpServer()).get("/tariff/rules").set(...auth(readerToken)).expect(200);
    expect(relisted.body.items).toHaveLength(1);
    expect(relisted.body.items[0].title).toBe("Charity cap v2");
    expect(relisted.body.items[0].params).toEqual({ discountCategory: "charity", maxBps: 3000, approvalAboveBps: 1000 });

    // GET /tariff/gst returns both halves (beforeEach seeded consultation + pharmacy + settings).
    const gst0 = await request(app.getHttpServer()).get("/tariff/gst").set(...auth(readerToken)).expect(200);
    expect(gst0.body.settings).toEqual({ compositeHealthcareExempt: true, caSigned: false });
    expect(gst0.body.categories.find((c: { category: string }) => c.category === "consultation").rateBps).toBe(1800);

    // PUT /tariff/gst/config/:category updates in place; PUT /tariff/gst/settings SUCCESS path
    // (previously only its 403 was asserted). specialRule/thresholdPaise are nullable-but-required
    // in the DTO — sent explicitly as null.
    await request(app.getHttpServer())
      .put("/tariff/gst/config/consultation").set(...auth(adminToken))
      .send({ sacCode: "999312", exempt: true, rateBps: 2000, specialRule: null, thresholdPaise: null }).expect(200);
    await request(app.getHttpServer())
      .put("/tariff/gst/settings").set(...auth(adminToken))
      .send({ caSigned: true }).expect(200);

    const gst1 = await request(app.getHttpServer()).get("/tariff/gst").set(...auth(readerToken)).expect(200);
    expect(gst1.body.categories.find((c: { category: string }) => c.category === "consultation").rateBps).toBe(2000);
    expect(gst1.body.settings.caSigned).toBe(true);
  });

  it("service and gazette routes over HTTP: patch visible, regulated rows append and list newest-first", async () => {
    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "DRUG-1", name: "Drug One", category: "pharmacy", regulated: true }).expect(201);
    const drugId = svc.body.serviceId as string;

    await request(app.getHttpServer())
      .patch(`/tariff/services/${drugId}`).set(...auth(adminToken))
      .send({ name: "Drug One (renamed)" }).expect(200);
    const services = await request(app.getHttpServer()).get("/tariff/services").set(...auth(readerToken)).expect(200);
    expect(services.body.items.find((s: { id: string }) => s.id === drugId).name).toBe("Drug One (renamed)");

    // Gazette ingestion — the ONLY door C-3 data enters through, never before called by a test —
    // plus the same-date correction path, listed newest-first (T3's deterministic order, over HTTP).
    const r1 = await request(app.getHttpServer())
      .post(`/tariff/services/${drugId}/regulated-prices`).set(...auth(adminToken))
      .send({ mrpPaise: 10000, ceilingPaise: 8000, effectiveFrom: "2026-04-01T00:00:00.000Z", gazetteRef: "GZ-1" }).expect(201);
    const r2 = await request(app.getHttpServer())
      .post(`/tariff/services/${drugId}/regulated-prices`).set(...auth(adminToken))
      .send({ mrpPaise: 10000, ceilingPaise: 6000, effectiveFrom: "2026-04-01T00:00:00.000Z", gazetteRef: "GZ-1-corr" }).expect(201);

    const history = await request(app.getHttpServer())
      .get(`/tariff/services/${drugId}/regulated-prices`).set(...auth(readerToken)).expect(200);
    expect(history.body.items).toHaveLength(2);
    expect(history.body.items.map((r: { id: string }) => r.id)).toEqual([r2.body.id, r1.body.id]);
    expect(history.body.items[0].ceilingPaise).toBe(6000);

    // GET /tariff/versions lists what exists.
    const v = await request(app.getHttpServer()).post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versions = await request(app.getHttpServer()).get("/tariff/versions").set(...auth(readerToken)).expect(200);
    expect(versions.body.items.map((x: { id: string }) => x.id)).toContain(v.body.versionId);
  });
});
