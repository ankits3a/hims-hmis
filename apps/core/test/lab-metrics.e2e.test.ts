import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { ROLE_MODEL } from "../scripts/seed-roles";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * LAB NUMBERS (owner 2026-10-13, #768) — `GET /lab/metrics` over HTTP: who may read it, and the
 * refusal for everyone else. The roles hold what the SEEDED role model grants them under `lab.*`,
 * so a grant missing from `seed-roles.ts` reddens this file rather than a test grant hiding it.
 * The figures themselves are `modules/lab/metrics.test.ts`'s subject.
 */
describe("GET /lab/metrics — lab.metrics.read", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  async function seededRole(roleKey: string): Promise<void> {
    await createRole(db, roleKey, roleKey);
    const grants = ROLE_MODEL.find((r) => r.roleKey === roleKey)?.permissions ?? [];
    for (const p of grants.filter((g) => g.startsWith("lab."))) await grantPermissionToRole(db, registry, roleKey, p);
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

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
  });

  const get = (token: string, query = "from=2026-03-10&to=2026-03-10"): request.Test =>
    request(app.getHttpServer()).get(`/lab/metrics?${query}`).set("Authorization", `Bearer ${token}`);

  it("answers the owner, admin and the pathologist", async () => {
    for (const r of ["owner", "admin", "pathologist"]) {
      await seededRole(r);
      const u = await mkUser(db, `m_${r}`, [r]);
      const res = await get(u.token).expect(200);
      expect(res.body.totals).toEqual({ orders: 0, tests: 0, published: 0, delivered: 0 });
      expect(res.body.bySource.map((s: { source: string }) => s.source)).toEqual(["opd", "ipd", "walk_in"]);
    }
  });

  it("refuses a lab technician, the lab counter and a login with no role — 403, like every lab route", async () => {
    for (const r of ["lab_technician", "lab_reception"]) {
      await seededRole(r);
      const u = await mkUser(db, `m_${r}`, [r]);
      await get(u.token).expect(403);
    }
    const nobody = await mkUser(db, "m_nobody", []);
    await get(nobody.token).expect(403);
  });

  it("any role granted lab.metrics.read reads it — the grant, not the role key, is the door", async () => {
    await createRole(db, "lab_incharge_local", "Lab in-charge");
    await grantPermissionToRole(db, registry, "lab_incharge_local", "lab.metrics.read");
    const u = await mkUser(db, "m_incharge", ["lab_incharge_local"]);
    await get(u.token).expect(200);
  });

  it("refuses a malformed or backwards range with 400", async () => {
    await seededRole("owner");
    const u = await mkUser(db, "m_owner", ["owner"]);
    await get(u.token, "from=2026-03-10").expect(400);
    await get(u.token, "from=2026-03-11&to=2026-03-10").expect(400);
    await get(u.token, "from=2026-01-01&to=2026-12-31").expect(400);
  });
});
