import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { formularyManifest, normalizeDrugName } from "../src/modules/formulary";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import { cdsAliases, events, formularyMedicineSalts, formularyMedicines, formularySalts, opdSuggestionEvents, opdTermMisses } from "../src/kernel/db/schema";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ MEDICINE NICKNAMES OVER HTTP (decisions 0051, 0055; owner 2026-10-08) ═══
 *
 * `modules/opd/alias-live.test.ts` executes the rules. What only a booted application shows:
 *
 *   · the WIRING — the formulary's search asks a lookup the OPD module registers at init. Drop that
 *     registration and every service test stays green while no nickname is ever offered;
 *   · the switch is the SERVER's setting (`ALIAS_PIPELINE_ENABLED`), read at boot;
 *   · the owner's list and its undo ride `opd.masters.manage`, and nobody without it gets in.
 */
describe.each([["on", "true"], ["off", "false"]] as const)("medicine nicknames — e2e, pipeline %s", (mode, flag) => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, formularyManifest]) registry.install(m);
  let admin: { id: string; token: string };
  let scribe: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };
  let aliasId: string;
  const NOW = new Date();

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    process.env.ALIAS_PIPELINE_ENABLED = flag;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { delete process.env.ALIAS_PIPELINE_ENABLED; await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    await mkRole("doc", ["opd.consult", "opd.visits.read", "formulary.read", "opd.masters.read"]);
    await mkRole("opd_admin", ["opd.masters.read", "opd.masters.manage"]);
    /* The desk scribe's production shape, cut to what these routes read: it types the doctor's paper and holds no `opd.consult`. */
    await mkRole("scribe", ["opd.prescription.transcribe", "opd.visits.read", "formulary.read"]);
    admin = await mkUser(db, "opdadmin", ["opd_admin"]);
    scribe = await mkUser(db, "scribe", ["scribe"]);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });

    await db.insert(formularySalts).values({ id: "s_panto", name: "Pantoprazole", nameNormalized: "pantoprazole", createdBy: "t", updatedBy: "t" } as never);
    const brand = "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet";
    await db.insert(formularyMedicines).values({ id: "m_pan40", brandName: brand, nameNormalized: normalizeDrugName(brand), form: "Gastro-resistant oral tablet", strengthLabel: "40 mg/", scheduleFlag: "H", createdBy: "t", updatedBy: "t" } as never);
    await db.insert(formularyMedicineSalts).values({ medicineId: "m_pan40", saltId: "s_panto", source: "curated" } as never);
    aliasId = "01NICKNAMEPANFORTY00000000";
    await db.insert(cdsAliases).values({
      id: aliasId, kind: "medicine", term: "pan forty", termKey: "pan 40", medicineId: "m_pan40", state: "suggestion", reviewerAnswer: "yes", ruleResult: "pass",
      createdAt: NOW, updatedAt: NOW, auditedAt: NOW,
    });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());

  it(mode === "on"
    ? "THE WIRING: a prescribing search for the nickname returns its medicine, marked — on the web's route and the phone's; any other search does not"
    : "SWITCHED OFF: every search is the catalogue's own answer", async () => {
    const rx = (await http().get("/formulary/medicines/search?q=pan%20forty&limit=10&for=rx").set(...auth(dra.token)).expect(200)).body.items as { id: string; name: string; alias?: unknown }[];
    const plain = (await http().get("/formulary/medicines/search?q=pan%20forty&limit=10").set(...auth(dra.token)).expect(200)).body.items as unknown[];
    const phone = (await http().get("/opd/consult/medicines?q=pan%20forty&limit=8").set(...auth(dra.token)).expect(200)).body.items as { id: string; alias?: unknown }[];
    expect(plain).toEqual([]);
    if (mode === "off") {
      expect(rx).toEqual([]);
      expect(phone).toEqual([]);
      return;
    }
    expect(rx).toHaveLength(1);
    expect(rx[0]).toMatchObject({ id: "m_pan40", name: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", alias: { id: aliasId, state: "suggestion", lasaGuard: false } });
    expect(phone[0]).toMatchObject({ id: "m_pan40", alias: { id: aliasId, state: "suggestion" } });
    await http().get("/formulary/medicines/search?q=pan&for=pharmacy").set(...auth(dra.token)).expect(400);
  });

  it("the owner's list and its undo need opd.masters.manage — 403 for a doctor and for the scribe — and open whether the pipeline is on or off", async () => {
    for (const who of [dra, scribe]) {
      await http().get("/opd/consult/nicknames").set(...auth(who.token)).expect(403);
      await http().post(`/opd/consult/nicknames/${aliasId}/undo`).set(...auth(who.token)).expect(403);
      await http().post(`/opd/consult/nicknames/${aliasId}/restore`).set(...auth(who.token)).expect(403);
    }
    await http().get("/opd/consult/nicknames").expect(401);
    expect((await db.select().from(cdsAliases))[0]?.state).toBe("suggestion");

    const list = (await http().get("/opd/consult/nicknames").set(...auth(admin.token)).expect(200)).body as { on: boolean; counts: unknown; items: { id: string; nickname: string; medicine: string; state: string }[] };
    expect(list.on).toBe(mode === "on");
    expect(list.counts).toEqual({ suggested: 1, trusted: 0, removed: 0 });
    expect(list.items).toEqual([expect.objectContaining({ id: aliasId, nickname: "pan forty", medicine: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", detail: "40 mg · Gastro-resistant oral tablet", state: "suggested" })]);

    await http().post(`/opd/consult/nicknames/${aliasId}/undo`).set(...auth(admin.token)).expect(201);
    expect((await db.select().from(cdsAliases))[0]).toMatchObject({ state: "undone", undoneBy: admin.id });
    expect((await db.select().from(events)).filter((e) => e.name === "alias.undone")[0]).toMatchObject({ actorType: "user", actorId: admin.id });
    expect((await http().get("/formulary/medicines/search?q=pan%20forty&for=rx").set(...auth(dra.token)).expect(200)).body.items).toEqual([]);
    expect((await http().get("/opd/consult/nicknames?all=1").set(...auth(admin.token)).expect(200)).body.items[0]).toMatchObject({ state: "removed", removedBy: "owner" });
    await http().post(`/opd/consult/nicknames/${aliasId}/restore`).set(...auth(admin.token)).expect(201);
    expect((await db.select().from(cdsAliases))[0]).toMatchObject({ state: "suggestion", undoneBy: null });
    await http().post("/opd/consult/nicknames/nope/undo").set(...auth(admin.token)).expect(404);
  });

  it("a word nothing matched and a cross on a nickname's row are logged by the doctor AND by the desk scribe typing the doctor's paper", async () => {
    for (const who of [dra, scribe]) {
      await http().post("/opd/consult/signals").set(...auth(who.token))
        .send({ misses: [{ kind: "medicine", term: "Dolo Six Fifty", stage: "search" }], suggestions: [{ kind: "alias", source: "search", outcome: "dismissed", surface: who === dra ? "consult_web" : "scribe", itemKey: aliasId }] })
        .expect(201);
    }
    expect((await db.select().from(opdTermMisses)).map((m) => [m.kind, m.term]).sort()).toEqual([["medicine", "dolo six fifty"], ["medicine", "dolo six fifty"]]);
    expect((await db.select().from(opdSuggestionEvents)).filter((e) => e.kind === "alias" && e.outcome === "dismissed")).toHaveLength(2);
    /* Two crosses by two people are not three: the nickname stands. */
    expect((await db.select().from(cdsAliases).where(eq(cdsAliases.id, aliasId)))[0]?.state).toBe("suggestion");
  });
});
