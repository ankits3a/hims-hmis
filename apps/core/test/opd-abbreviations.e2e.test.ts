import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { medicineAbbreviations } from "../src/modules/opd/alias-store";
import { formularyManifest } from "../src/modules/formulary";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import { opdMedicineAbbreviations } from "../src/kernel/db/schema";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * SPEC #613 — THE PHARMACIST SIGNS THE ABBREVIATION LIST OVER HTTP. Reading needs `opd.masters.read`,
 * signing or switching off needs `opd.masters.manage`, and a signed row is what the pipeline reads as
 * signed (`medicineAbbreviations`). Nobody else can sign.
 */
describe("the abbreviation list — e2e (spec #613)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, formularyManifest]) registry.install(m);
  let admin: { id: string; token: string };
  let reader: { id: string; token: string };

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
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    await mkRole("opd_admin", ["opd.masters.read", "opd.masters.manage"]);
    await mkRole("opd_reader", ["opd.masters.read"]);
    admin = await mkUser(db, "opdadmin", ["opd_admin"]);
    reader = await mkUser(db, "opdreader", ["opd_reader"]);
    await db.insert(opdMedicineAbbreviations).values({ id: "abbr_t1", abbreviation: "amox", moiety: "amoxicillin" });
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());

  it("lists the row unsigned; only opd.masters.manage signs it; the pipeline then reads it as signed", async () => {
    const before = (await http().get("/opd/consult/abbreviations").set(...auth(reader.token)).expect(200)).body.items as { id: string; signed: boolean; active: boolean }[];
    expect(before).toEqual([expect.objectContaining({ id: "abbr_t1", abbreviation: "amox", moiety: "amoxicillin", active: true, signed: false, signedAt: null })]);
    expect((await medicineAbbreviations(db))[0]).toMatchObject({ signed: false });

    await http().put("/opd/consult/abbreviations/abbr_t1").set(...auth(reader.token)).send({ active: true }).expect(403);
    expect((await medicineAbbreviations(db))[0]).toMatchObject({ signed: false });

    await http().put("/opd/consult/abbreviations/abbr_t1").set(...auth(admin.token)).send({ active: true }).expect(200);
    expect((await medicineAbbreviations(db))[0]).toEqual({ abbreviation: "amox", moiety: "amoxicillin", active: true, signed: true });

    await http().put("/opd/consult/abbreviations/abbr_t1").set(...auth(admin.token)).send({ active: false }).expect(200);
    expect((await medicineAbbreviations(db))[0]).toMatchObject({ active: false });
    await http().put("/opd/consult/abbreviations/nope").set(...auth(admin.token)).send({ active: true }).expect(400);
  });
});
