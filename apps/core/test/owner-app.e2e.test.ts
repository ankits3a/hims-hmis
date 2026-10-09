import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { addDayIso, istDayOf } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkUser } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { requireEnv } from "../src/kernel/config";
import { ROLE_MODEL } from "../scripts/seed-roles";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * THE OWNER'S SCREENS IN THE STAFF APP (owner 2026-10-09) — WHO REACHES WHICH READ, with the grants
 * production's roles really hold (`ROLE_MODEL`, not a role cut for the test). The owner's ruling:
 * "Medical Superintendent too but Money page for owner alone."
 *
 * No permission was added for this. The money read sits on `billing.reports.read` — the day book's
 * gate, which the Medical Superintendent's role has never held — and the others on the report and
 * roster reads both roles already hold. A doctor and a cashier reach none of them.
 */
describe("owner app — the reads behind the seven tiles", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  type Who = "owner" | "ms" | "doctor" | "cashier";
  let token: Record<Who, string>;
  const TODAY = istDayOf(Date.now());

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
    const roleOf: Record<Who, string> = { owner: "owner", ms: "medical_superintendent", doctor: "doctor", cashier: "cashier" };
    const out = {} as Record<Who, string>;
    for (const who of Object.keys(roleOf) as Who[]) {
      const grants = ROLE_MODEL.find((r) => r.roleKey === roleOf[who])!;
      await ensureRole(db, grants.roleKey);
      for (const p of grants.permissions) await grantPermissionToRole(db, registry, grants.roleKey, p);
      out[who] = (await mkUser(db, `oa_${who}`, [grants.roleKey])).token;
    }
    token = out;
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const get = (path: string, who: Who) => http().get(path).set("Authorization", `Bearer ${token[who]}`);

  const READS: [path: string, refusedBy: string, statuses: Record<Who, number>][] = [
    ["/billing/reports/owner-money", "billing.reports.read", { owner: 200, ms: 403, doctor: 403, cashier: 403 }],
    ["/opd/reports/appointments-summary", "opd.reports.read", { owner: 200, ms: 200, doctor: 403, cashier: 403 }],
    ["/opd/reports/learning", "opd.reports.read", { owner: 200, ms: 200, doctor: 403, cashier: 403 }],
    ["/pharmacy/office/reports/owner-summary", "staff.reports.read", { owner: 200, ms: 200, doctor: 403, cashier: 403 }],
    ["/roster/staff-today", "staff.reports.read", { owner: 200, ms: 200, doctor: 403, cashier: 403 }],
  ];

  it("the owner reads all five; the Medical Superintendent all but money; a doctor and a cashier none", async () => {
    for (const [path, permission, statuses] of READS) {
      for (const who of Object.keys(statuses) as Who[]) {
        const res = await get(path, who);
        expect({ path, who, status: res.status }).toEqual({ path, who, status: statuses[who] });
        if (statuses[who] === 403) {
          /* A cashier holds no roster read at all, so the roster's own guard names its permission first. */
          const named = path === "/roster/staff-today" && who === "cashier" ? "roster.read" : permission;
          expect({ path, who, message: res.body.message }).toEqual({ path, who, message: `missing permission ${named}` });
        }
      }
    }
  });

  it("the pharmacy read gives the Medical Superintendent every count and no rupee", async () => {
    const owner = (await get("/pharmacy/office/reports/owner-summary", "owner").expect(200)).body;
    const ms = (await get("/pharmacy/office/reports/owner-summary", "ms").expect(200)).body;
    expect(owner).toMatchObject({ from: TODAY, to: TODAY, bills: 0, salesPaise: 0, refundsPaise: 0, prescriptions: { reached: 0, served: 0 } });
    expect(ms).toMatchObject({ bills: 0, salesPaise: null, refundsPaise: null, prescriptions: { reached: 0, served: 0 } });
    /* The counter's store is not set up here: the stock lines are absent, never a made-up zero. */
    expect(owner.stock).toBeNull();
  });

  it("learning is read-only: neither role may take a nickname back, and the existing gate still says so", async () => {
    const owner = (await get("/opd/reports/learning", "owner").expect(200)).body;
    expect(owner).toEqual({ on: false, mayUndo: false, nicknames: [], tapped: null, misses: 0 });
    const undo = await http().post("/opd/consult/nicknames/x/undo").set("Authorization", `Bearer ${token.ms}`);
    expect({ status: undo.status, message: undo.body.message }).toEqual({ status: 403, message: "missing permission opd.masters.manage" });
  });

  it("a range is at most 92 days, in order, and never in the future — on every read that takes one", async () => {
    const far = addDayIso(TODAY, -92), tomorrow = addDayIso(TODAY, 1), yesterday = addDayIso(TODAY, -1);
    for (const path of ["/billing/reports/owner-money", "/opd/reports/appointments-summary", "/pharmacy/office/reports/owner-summary", "/opd/reports/recording"]) {
      const bad = [
        `from=${far}&to=${TODAY}`, `from=${TODAY}&to=${tomorrow}`, `from=${TODAY}&to=${yesterday}`, `from=nonsense&to=${TODAY}`,
        `from=${TODAY}&to=${TODAY}&cfrom=${TODAY}&cto=${tomorrow}`,
      ];
      for (const qs of path === "/opd/reports/recording" ? bad.slice(0, 4) : bad) {
        const res = await get(`${path}?${qs}`, "owner");
        expect({ path, qs, status: res.status, code: res.body.code }).toEqual({ path, qs, status: 400, code: "invalid_range" });
      }
      const ok = await get(`${path}?from=${addDayIso(TODAY, -91)}&to=${TODAY}`, "owner");
      expect({ path, status: ok.status, from: ok.body.from, to: ok.body.to }).toEqual({ path, status: 200, from: addDayIso(TODAY, -91), to: TODAY });
    }
  });

  it("the recording count takes spelt-out days and keeps its own rules about who sees what", async () => {
    const from = addDayIso(TODAY, -6);
    const owner = (await get(`/opd/reports/recording?from=${from}&to=${TODAY}`, "owner").expect(200)).body;
    expect(owner).toMatchObject({ from, to: TODAY, anchor: TODAY, period: "month", scope: "hospital", doctors: [] });
    const one = (await get(`/opd/reports/recording?from=${TODAY}&to=${TODAY}`, "owner").expect(200)).body;
    expect(one).toMatchObject({ from: TODAY, to: TODAY, period: "day" });
    /* A cashier is still told nothing, whatever days are asked for; with no days asked it is today, as before. */
    const cashier = (await get(`/opd/reports/recording?from=${from}&to=${TODAY}`, "cashier").expect(200)).body;
    expect(cashier).toMatchObject({ scope: "none", totals: null, doctors: null });
    const plain = (await get("/opd/reports/recording", "owner").expect(200)).body;
    expect(plain).toMatchObject({ from: TODAY, to: TODAY, period: "day" });
  });
});
