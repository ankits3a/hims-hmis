import { Test } from "@nestjs/testing";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { createUser } from "../../../kernel/auth/identity";
import { createSession } from "../../../kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { loadConfig, requireEnv } from "../../../kernel/config";
import { events, services } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { activateVersionDirectly, createDraftVersion, createService, setTariffItem, tariffManifest, updateService } from "..";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ═══ GO-LIVE SCREENS — "SWITCH ON N SERVICES" (acceptance) ═══
 *
 * Done means:
 *  (i)   a request naming ANY service with no price in the version in force is refused, and NOTHING is switched on;
 *  (ii)  a priced request switches every named service on and writes ONE `tariff.service_switched_on` event per service;
 *  (iii) a caller without `tariff.services.manage` is refused (403) and nothing changes;
 *  (iv)  a price that exists only in a DRAFT or a FUTURE-dated version is not a price in force: refused;
 *  (v)   a zero price is refused;
 *  (vi)  an unknown id answers 404;
 *  (vii) each event carries the in-force version's number and that version's price;
 *  (viii) a service already on is skipped without the price check (an idempotent retry);
 *  (ix)  the bulk door takes IPD_ codes only (`not_ipd_service`);
 *  (x)   `GET /tariff/versions` names the drafter and submitter only to `tariff.versions.draft` / `.activate` holders.
 */
describe("POST /tariff/services/switch-on — the bulk switch-on", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(tariffManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
  const system: Actor = { type: "user", id: "test-setup" };
  let managerToken: string;
  let readerToken: string;
  let priced: string[];
  let unpriced: string;
  let zero: string;
  let onUnpriced: string;
  let consult: string;
  let inForce: { versionId: string; versionNo: number };
  let drafterToken: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "svc_manager", "Service manager");
    await grantPermissionToRole(db, registry, "svc_manager", "tariff.services.manage");
    await grantPermissionToRole(db, registry, "svc_manager", "tariff.read");
    await createRole(db, "reader", "Reader");
    await grantPermissionToRole(db, registry, "reader", "tariff.read");
    await createRole(db, "drafter", "Drafter");
    await grantPermissionToRole(db, registry, "drafter", "tariff.read");
    await grantPermissionToRole(db, registry, "drafter", "tariff.versions.draft");
    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { id, token: (await createSession(db, cfg, id)).token };
    };
    const manager = await mk("manager");
    const reader = await mk("reader");
    await assignRole(db, { userId: manager.id, roleKey: "svc_manager", scopeType: "hospital" });
    await assignRole(db, { userId: reader.id, roleKey: "reader", scopeType: "hospital" });
    const drafter = await mk("drafter");
    await assignRole(db, { userId: drafter.id, roleKey: "drafter", scopeType: "hospital" });
    managerToken = manager.token;
    readerToken = reader.token;
    drafterToken = drafter.token;

    // Three inactive services; a version in force prices two of them.
    const ids = await withTx(db, async (tx) => {
      const out: string[] = [];
      for (const code of ["IPD_ROOM_GENERAL", "IPD_NURSING_GENERAL", "IPD_RMO_GENERAL"]) {
        const { serviceId } = await createService(tx, system, { code, name: code, category: "ipd_care" });
        await updateService(tx, system, serviceId, { active: false });
        out.push(serviceId);
      }
      return out;
    });
    priced = ids.slice(0, 2);
    unpriced = ids[2]!;
    const more = await withTx(db, async (tx) => {
      const z = (await createService(tx, system, { code: "IPD_VISIT_GENERAL", name: "zero", category: "ipd_care" })).serviceId;
      await updateService(tx, system, z, { active: false });
      const on = (await createService(tx, system, { code: "IPD_VISIT_ICU", name: "already on, unpriced", category: "ipd_care" })).serviceId;
      const c = (await createService(tx, system, { code: "OPD-CONSULT", name: "consult", category: "ipd_care" })).serviceId;
      await updateService(tx, system, c, { active: false });
      return { z, on, c };
    });
    zero = more.z; onUnpriced = more.on; consult = more.c;
    const v = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, system, { notes: "test" });
      await setTariffItem(tx, system, d.versionId, priced[0]!, 100000);
      await setTariffItem(tx, system, d.versionId, priced[1]!, 40000);
      await setTariffItem(tx, system, d.versionId, zero, 0);
      await setTariffItem(tx, system, d.versionId, consult, 50000);
      return d;
    });
    await activateVersionDirectly(db, system, v.versionId, new Date(Date.now() - 86_400_000), "test version in force");
    inForce = v;
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  // `IPD_VISIT_ICU` is on from the start (case viii): count only the services this suite switches.
  const activeCount = async (): Promise<number> =>
    (await db.select().from(services).where(eq(services.active, true))).filter((r) => r.id !== onUnpriced).length;
  const switchEvents = async () => (await db.select().from(events)).filter((e) => e.name === "tariff.service_switched_on");

  it("(i) refuses when ANY named service is unpriced, naming it, and switches NOTHING on", async () => {
    const res = await request(app.getHttpServer()).post("/tariff/services/switch-on").set(...auth(managerToken))
      .send({ serviceIds: [...priced, unpriced] }).expect(409);
    expect(JSON.stringify(res.body)).toContain("IPD_RMO_GENERAL");
    expect(await activeCount()).toBe(0);
    expect(await switchEvents()).toHaveLength(0);
  });

  it("(ii) switches every priced service on, one event per service; a repeat writes nothing more", async () => {
    const res = await request(app.getHttpServer()).post("/tariff/services/switch-on").set(...auth(managerToken))
      .send({ serviceIds: priced }).expect(200);
    expect(res.body.switchedOn).toEqual(["IPD_NURSING_GENERAL", "IPD_ROOM_GENERAL"]);
    expect(await activeCount()).toBe(2);
    const ev = await switchEvents();
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => (e.payload as { serviceId: string }).serviceId).sort()).toEqual([...priced].sort());

    const again = await request(app.getHttpServer()).post("/tariff/services/switch-on").set(...auth(managerToken))
      .send({ serviceIds: priced }).expect(200);
    expect(again.body.switchedOn).toEqual([]);
    expect(await switchEvents()).toHaveLength(2);
  });

  it("(iii) refuses a caller without tariff.services.manage, and nothing changes", async () => {
    await request(app.getHttpServer()).post("/tariff/services/switch-on").set(...auth(readerToken))
      .send({ serviceIds: priced }).expect(403);
    expect(await activeCount()).toBe(0);
    expect(await switchEvents()).toHaveLength(0);
  });

  const post = (ids: string[]) => request(app.getHttpServer()).post("/tariff/services/switch-on").set(...auth(managerToken)).send({ serviceIds: ids });

  it("(iv) a price only in a DRAFT version, or only in a FUTURE-dated version, is not in force: refused", async () => {
    const d = await withTx(db, async (tx) => {
      const x = await createDraftVersion(tx, system, { notes: "draft prices the rmo", copyFromVersionId: inForce.versionId });
      await setTariffItem(tx, system, x.versionId, unpriced, 20000);
      return x;
    });
    await post([unpriced]).expect(409);
    await activateVersionDirectly(db, system, d.versionId, new Date(Date.now() + 7 * 86_400_000), "future-dated");
    const res = await post([unpriced]).expect(409);
    expect(JSON.stringify(res.body)).toContain("service_unpriced");
    expect(await activeCount()).toBe(0);
  });

  it("(v) a zero price is refused", async () => {
    const res = await post([zero]).expect(409);
    expect(JSON.stringify(res.body)).toContain("IPD_VISIT_GENERAL");
    expect(await activeCount()).toBe(0);
  });

  it("(vi) an unknown id answers 404 and nothing changes", async () => {
    await post([priced[0]!, "01NOSUCHSERVICE0000000000"]).expect(404);
    expect(await activeCount()).toBe(0);
  });

  it("(vii) each event carries the in-force version's number and its price", async () => {
    await post(priced).expect(200);
    const ev = await switchEvents();
    const byService = new Map(ev.map((e) => [(e.payload as { serviceId: string }).serviceId, e.payload as { versionNo: number; versionId: string; pricePaise: number }]));
    expect(byService.get(priced[0]!)).toMatchObject({ versionNo: inForce.versionNo, versionId: inForce.versionId, pricePaise: 100000 });
    expect(byService.get(priced[1]!)).toMatchObject({ versionNo: inForce.versionNo, versionId: inForce.versionId, pricePaise: 40000 });
  });

  it("(viii) a service already on is skipped without the price check — an idempotent retry", async () => {
    const res = await post([priced[0]!, onUnpriced]).expect(200);
    expect(res.body).toMatchObject({ switchedOn: ["IPD_ROOM_GENERAL"], alreadyOn: ["IPD_VISIT_ICU"] });
    expect(await switchEvents()).toHaveLength(1);
  });

  it("(ix) the bulk door takes IPD_ codes only", async () => {
    const res = await post([priced[0]!, consult]).expect(409);
    expect(JSON.stringify(res.body)).toContain("not_ipd_service");
    expect(await activeCount()).toBe(0);
  });

  it("(x) GET /tariff/versions names the drafter only to a tariff.versions.draft / .activate holder", async () => {
    const asReader = await request(app.getHttpServer()).get("/tariff/versions").set(...auth(readerToken)).expect(200);
    const asDrafter = await request(app.getHttpServer()).get("/tariff/versions").set(...auth(drafterToken)).expect(200);
    const pick = (b: { items: { id: string; createdBy?: unknown; createdByName?: unknown }[] }) => b.items.find((v) => v.id === inForce.versionId)!;
    expect(pick(asReader.body).createdByName ?? null).toBeNull();
    expect(pick(asReader.body).createdBy ?? null).toBeNull();
    expect(pick(asDrafter.body).createdBy).toBe("test-setup");
  });
});
