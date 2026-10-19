import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { formularyGenerics } from "../src/kernel/db/schema";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { saveCrkEntry } from "../src/modules/formulary/crk-formulary";
import { saveMonograph } from "../src/modules/formulary/monographs";
import { ROLE_MODEL } from "../scripts/seed-roles";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * #618 / decision 0053 — WHO SIGNS WHAT, over HTTP, with the roles the SEEDED role model grants.
 *
 * Two different acts with two different holders: the Pharmacology department signs CRK formulary entries
 * (`formulary.crk.sign`); a physician reviews the pharmacy's drug monograph (`formulary.monograph.review`,
 * owner 2026-10-02). Neither holder may perform the other's act.
 */
describe("CRK formulary signing and the pharmacy monograph review are separate permissions", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
  const SCTID = "1201952000";
  const ENTRY = {
    sources: [{ ref: "fda1", kind: "openfda", title: "Aciclovir tablets label", url: null, asOf: null }],
    fields: { uses: [{ text: "Treats shingles.", source: "fda1" }] },
    combinationNote: null,
  };

  async function seededRole(roleKey: string): Promise<void> {
    await createRole(db, roleKey, roleKey);
    const grants = ROLE_MODEL.filter((r) => r.roleKey === roleKey).flatMap((r) => r.permissions);
    for (const p of grants.filter((g) => g.startsWith("formulary."))) await grantPermissionToRole(db, registry, roleKey, p);
  }

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  }, 120_000);

  afterAll(async () => { await app.close(); await teardown(); });

  let monographId: string;
  let entryId: string;
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await db.insert(formularyGenerics).values({
      id: newId(), sctid: SCTID, name: "Acyclovir 800 mg oral tablet", nameNormalized: "acyclovir 800 mg oral tablet",
      doseForm: "oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09", createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id,
    });
    ({ monographId } = await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, { genericSctid: SCTID, sourceVersion: "1.25", patient: { what_it_is: "An antiviral." } })));
    ({ entryId } = await withTx(db, (tx) => saveCrkEntry(tx, PHARMACIST, SCTID, ENTRY)));
    await seededRole("pharmacology_reviewer");
    await seededRole("medical_superintendent");
  });

  const post = (path: string, token: string, body: object = {}): request.Test =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body);
  const get = (path: string, token: string): request.Test =>
    request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  it("the Pharmacology reviewer signs a CRK entry and reads the worklist, and is refused the pharmacy monograph review", async () => {
    const reviewer = await mkUser(db, "crk_pharmacology", ["pharmacology_reviewer"]);
    await get("/formulary/crk/worklist", reviewer.token).expect(200);
    await get(`/formulary/crk/${SCTID}/review`, reviewer.token).expect(200);
    const signed = await post(`/formulary/crk/entries/${entryId}/sign`, reviewer.token, { designation: "Professor, Pharmacology" });
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({ status: "reviewed", renewal: false });
    await post(`/formulary/monographs/${monographId}/review`, reviewer.token).expect(403);
  });

  it("the Medical Superintendent reviews the pharmacy monograph, and is refused CRK signing and the CRK worklist", async () => {
    const ms = await mkUser(db, "crk_ms", ["medical_superintendent"]);
    await post(`/formulary/crk/entries/${entryId}/sign`, ms.token, { designation: "Medical Superintendent" }).expect(403);
    await get("/formulary/crk/worklist", ms.token).expect(403);
    await get(`/formulary/crk/${SCTID}/review`, ms.token).expect(403);
    const reviewed = await post(`/formulary/monographs/${monographId}/review`, ms.token);
    expect([200, 201]).toContain(reviewed.status);
  });
});
