import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { newId } from "@hmis/contracts";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { createUser } from "../../../kernel/auth/identity";
import { createSession } from "../../../kernel/auth/sessions";
import { withTx } from "../../../kernel/db/client";
import { copilotActs, copilotAsks, orgDepartments } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import { requireEnv } from "../../../kernel/config";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { testCfg } from "../../../../test/helpers/opd";
import { createShelf, listCategories, registerStoresItem, seedStoresMasters, setShelfPar, storesAuditPack } from "../index";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { CopilotStoresReorderPick } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1113, spec docs/specs/1113-stores-control-tower.md (owner APPROVED 2026-11-18): D16, through
 * the routes a phone and a desk use. Every concierge proposal and every confirmed act is in the copilot ledger with
 * the person, and the ticket's audit pack (#1112, `storesAuditPack`) lists the confirmed `stores.reorder` act with
 * that person. The rest of S3's server ids are in stores-s3-1113.test.ts.
 */
describe("spec #1113 D16 — the concierge's ledger and the audit pack (acceptance)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  type Who = { id: string; token: string };
  let incharge: Who;
  let head: Who;
  let shelfId: string;

  const http = () => request(app.getHttpServer());

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
    for (const [role, perms] of Object.entries({
      materials_head: ["stores.masters.manage", "stores.shelf.read", "stores.audit.read", "stores.tower.read"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
    })) {
      await createRole(db, role, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    const dept = newId();
    await db.insert(orgDepartments).values({ id: dept, code: "HSK", name: "Housekeeping", kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    const person = async (username: string, role: string, scope: { type: "hospital" } | { type: "department"; id: string }): Promise<Who> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      await assignRole(db, scope.type === "hospital" ? { userId: id, roleKey: role, scopeType: "hospital" } : { userId: id, roleKey: role, scopeType: "department", scopeId: scope.id });
      return { id, token: (await createSession(db, testCfg, id)).token };
    };
    head = await person("stores.head", "materials_head", { type: "hospital" });
    incharge = await person("incharge.hsk", "department_store_incharge", { type: "department", id: dept });
    const headActor = { type: "user" as const, id: head.id };
    const floor = (await withTx(db, (tx) => createResource(tx, headActor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    const { centralStoreId } = await seedStoresMasters(db, headActor);
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    const mop = (await registerStoresItem(db, headActor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    ({ shelfId } = await createShelf(db, headActor, { code: "HSK-F1", name: "Housekeeping F1", floorId: floor, departmentId: dept, suppliedBy: centralStoreId }));
    await setShelfPar(db, headActor, { shelfId, itemId: mop, minBase: 5, reorderBase: 10, maxBase: 40 });
  });

  it("spec #1113 D16: every concierge proposal and every confirmed act is in the copilot ledger with the confirming person, and the ticket's audit pack lists the confirmed stores.reorder act with that person", async () => {
    const asked = await http().post("/copilot/ask").set("Authorization", `Bearer ${incharge.token}`).send({ question: "reorder my shelf" }).expect(200);
    expect(asked.body).toMatchObject({ source: "phrasebook", intent: "stores.reorder", answer: { key: "copilot.answer.storesReorderPick" } });
    const pick = asked.body.answer.payload as CopilotStoresReorderPick;
    expect(pick.options.map((o) => o.shelfId)).toEqual([shelfId]);

    // The proposal is in the ask ledger with the asking person, before anything is written.
    const asks = await db.select().from(copilotAsks).where(eq(copilotAsks.actorId, incharge.id));
    expect(asks.map((a) => [a.intent, a.answerKey])).toEqual([["stores.reorder", "copilot.answer.storesReorderPick"]]);
    expect(await db.select().from(copilotActs)).toHaveLength(0);

    const done = await http().post("/copilot/confirm").set("Authorization", `Bearer ${incharge.token}`)
      .send({ proposal: asked.body.proposals[pick.options[0]!.proposal] }).expect(200);
    expect(done.body).toMatchObject({ outcome: "done", answer: { key: "copilot.answer.storesReorderSent" } });

    const [act] = await db.select().from(copilotActs);
    expect(act).toMatchObject({ tool: "stores.reorder", actorId: incharge.id, resultModule: "stores" });
    const pack = await storesAuditPack(db, { type: "user", id: head.id }, {
      ticketId: act!.resultRowId!, from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000),
    });
    const row = pack.rows.find((r) => r.what === "copilot_reorder");
    expect(row?.actor.id).toBe(incharge.id);
    expect(row?.after).toMatchObject({ tool: "stores.reorder", confirmId: act!.confirmId });
    expect(pack.rows.find((r) => r.what === "raise_ticket")?.actor.id).toBe(incharge.id);
  });
});
