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
 * HOSPITAL NUMBERS (owner 2026-10-13, #777) — `GET /radiology/metrics` and `GET /pharmacy/metrics`
 * over HTTP: who may read each, the refusal for everyone else, and the pharmacy margin that rides
 * only with `pharmacy.reports.margin`. Roles hold what the SEEDED role model grants them under the
 * module's prefix, so a grant missing from `seed-roles.ts` reddens this file rather than a test grant
 * hiding it. The figures are `modules/{radiology,pharmacy}/metrics.test.ts`'s subject.
 */
describe("GET /radiology/metrics and /pharmacy/metrics — the metrics reads", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  async function seededRole(roleKey: string, prefix: string): Promise<void> {
    await createRole(db, roleKey, roleKey);
    const grants = ROLE_MODEL.filter((r) => r.roleKey === roleKey).flatMap((r) => r.permissions);
    for (const p of grants.filter((g) => g.startsWith(prefix))) await grantPermissionToRole(db, registry, roleKey, p);
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

  const get = (path: string, token: string, query = "from=2026-03-10&to=2026-03-10"): request.Test =>
    request(app.getHttpServer()).get(`${path}?${query}`).set("Authorization", `Bearer ${token}`);

  describe("imaging — radiology.metrics.read", () => {
    it("answers the owner, admin and the radiologist", async () => {
      for (const r of ["owner", "admin", "radiologist"]) {
        await seededRole(r, "radiology.");
        const u = await mkUser(db, `rm_${r}`, [r]);
        const res = await get("/radiology/metrics", u.token).expect(200);
        expect(res.body.totals).toEqual({ orders: 0, studies: 0, signed: 0, delivered: 0 });
        expect(res.body.bySource.map((s: { source: string }) => s.source)).toEqual(["opd", "ipd", "walk_in"]);
      }
    });

    it("refuses the technologist, the imaging desk and a login with no role — 403", async () => {
      for (const r of ["radiographer", "radiology_receptionist"]) {
        await seededRole(r, "radiology.");
        const u = await mkUser(db, `rm_${r}`, [r]);
        await get("/radiology/metrics", u.token).expect(403);
      }
      const nobody = await mkUser(db, "rm_nobody", []);
      await get("/radiology/metrics", nobody.token).expect(403);
    });

    it("any role granted radiology.metrics.read reads it, and a backwards or too-long range is a 400", async () => {
      await createRole(db, "imaging_manager_local", "Imaging manager");
      await grantPermissionToRole(db, registry, "imaging_manager_local", "radiology.metrics.read");
      const u = await mkUser(db, "rm_manager", ["imaging_manager_local"]);
      await get("/radiology/metrics", u.token).expect(200);
      await get("/radiology/metrics", u.token, "from=2026-03-11&to=2026-03-10").expect(400);
      await get("/radiology/metrics", u.token, "from=2026-01-01&to=2026-12-31").expect(400);
    });
  });

  describe("pharmacy — pharmacy.metrics.read, margin only with pharmacy.reports.margin", () => {
    it("answers the owner (with margin), admin and the pharmacist in charge (no margin for admin)", async () => {
      const bodies: Record<string, Record<string, unknown>> = {};
      for (const r of ["owner", "admin", "pharmacy_incharge"]) {
        await seededRole(r, "pharmacy.");
        const u = await mkUser(db, `pm_${r}`, [r]);
        const res = await get("/pharmacy/metrics", u.token).expect(200);
        expect(res.body).toMatchObject({ bills: 0, salesPaise: 0, returnsPaise: 0, netPaise: 0, prescriptions: { received: 0, full: 0, part: 0, none: 0 }, purchases: { grns: 0, valuePaise: 0 } });
        bodies[r] = res.body as Record<string, unknown>;
      }
      expect(bodies["owner"]!["margin"]).toEqual({ revenuePaise: 0, costPaise: 0, profitPaise: 0, marginBps: null });
      expect(bodies["pharmacy_incharge"]!["margin"]).toBeDefined();
      expect("margin" in bodies["admin"]!).toBe(false);
    });

    it("refuses the counter pharmacist and a login with no role — 403", async () => {
      await seededRole("pharmacy", "pharmacy.");
      const u = await mkUser(db, "pm_counter", ["pharmacy"]);
      await get("/pharmacy/metrics", u.token).expect(403);
      const nobody = await mkUser(db, "pm_nobody", []);
      await get("/pharmacy/metrics", nobody.token).expect(403);
    });

    it("a role granted pharmacy.metrics.read alone reads it without margin; a backwards range is a 400", async () => {
      await createRole(db, "pharmacy_viewer_local", "Pharmacy viewer");
      await grantPermissionToRole(db, registry, "pharmacy_viewer_local", "pharmacy.metrics.read");
      const u = await mkUser(db, "pm_viewer", ["pharmacy_viewer_local"]);
      const res = await get("/pharmacy/metrics", u.token).expect(200);
      expect("margin" in res.body).toBe(false);
      await get("/pharmacy/metrics", u.token, "from=2026-03-11&to=2026-03-10").expect(400);
    });
  });
});
