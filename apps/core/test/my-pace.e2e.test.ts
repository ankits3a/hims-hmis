import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkDoctor, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { events } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { paceWindow } from "../src/modules/opd/pace";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * MY PACE OVER HTTP (owner 2026-10-09) — what only the route can show: the door is the login, the
 * period is a closed word, a desk user is answered with nothing rather than refused, and — like
 * `/me/brief` — the read writes no event. The figures themselves are `pace.test.ts`'s.
 */
describe("GET /me/performance", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  let doctor: Awaited<ReturnType<typeof mkDoctor>>;
  let desk: Awaited<ReturnType<typeof mkUser>>;

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
    await seedOpdBase(db);
    const m = await seedOpdMasters(db);
    doctor = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId });
    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.visits.open");
    desk = await mkUser(db, "desk", ["desk_clerk"]);
  });

  const get = (path: string, token: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  it("needs a login, takes only the three periods, and defaults to 30 days", async () => {
    await request(app.getHttpServer()).get("/me/performance").expect(401);
    await get("/me/performance?period=year", doctor.token).expect(400);
    const before = (await db.select().from(events)).length;
    const r = await get("/me/performance", doctor.token).expect(200);
    // The window is read off the same helper with the clock of this moment — no date is pinned here.
    expect(r.body).toMatchObject({ period: "30d", to: paceWindow("30d", new Date()).to, vitals: null });
    expect(r.body.consultation).toEqual({
      own: { enough: false, meanMin: null, medianMin: null, n: 0 },
      department: { enough: false, meanMin: null, medianMin: null },
      all: { enough: false, meanMin: null, medianMin: null },
      excluded: { paper: 0, abandoned: 0, outOfBounds: 0 },
    });
    expect((await get("/me/performance?period=7d", doctor.token).expect(200)).body.period).toBe("7d");
    expect((await get("/me/performance?period=today", doctor.token).expect(200)).body.period).toBe("today");
    expect((await db.select().from(events)).length).toBe(before);
  });

  it("answers a desk user with nothing, not with a refusal", async () => {
    const r = await get("/me/performance?period=30d", desk.token).expect(200);
    expect(r.body).toMatchObject({ period: "30d", consultation: null, vitals: null });
  });
});
