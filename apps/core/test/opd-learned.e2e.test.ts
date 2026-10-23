import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
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
import { formularyManifest } from "../src/modules/formulary";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import { cdsDoctorLearningResets, events, opdComplaintTermUsage } from "../src/kernel/db/schema";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ WHAT I TAUGHT IT, AND RESET — OVER HTTP (decision 0050 P4, #615) ═══
 *
 * `modules/opd/learned.test.ts` executes the reads and the reset. What only a booted application shows:
 * the routes ride `opd.consult`; the caller is always the subject (no doctor parameter exists); a user
 * with no OPD doctor row gets 404 `not_a_doctor`; a bad body is refused before anything is written.
 */
describe("learned about me — e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of [authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, formularyManifest]) registry.install(m);
  let dra: { doctorId: string; userId: string; token: string };
  let drb: { doctorId: string; userId: string; token: string };
  let consultNoDoctor: { id: string; token: string };
  let clerk: { id: string; token: string };

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
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const mkRole = async (key: string, permissions: string[]): Promise<void> => {
      await createRole(db, key, key);
      for (const p of permissions) await grantPermissionToRole(db, registry, key, p);
    };
    await mkRole("doc", ["opd.consult", "opd.visits.read"]);
    await mkRole("clerk", ["opd.visits.read"]);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
    await assignRole(db, { userId: drb.userId, roleKey: "doc", scopeType: "hospital" });
    consultNoDoctor = await mkUser(db, "nodoc", ["doc"]);
    clerk = await mkUser(db, "clerk", ["clerk"]);
    await db.insert(opdComplaintTermUsage).values([
      { doctorId: dra.doctorId, term: "fever", uses: 3 },
      { doctorId: drb.doctorId, term: "cough", uses: 2 },
    ] as never);
  });

  const get = (token: string) => request(app.getHttpServer()).get("/opd/consult/learned").set("Authorization", `Bearer ${token}`);
  const reset = (token: string, body: unknown) => request(app.getHttpServer()).post("/opd/consult/learned/reset").set("Authorization", `Bearer ${token}`).send(body as object);

  it("the caller reads only their own patterns", async () => {
    const res = await get(dra.token).expect(200);
    expect(res.body.complaints).toEqual([{ term: "fever", uses: 3 }]);
    expect(JSON.stringify(res.body)).not.toMatch(/cough|price|paise/i);
  });

  it("a reset is the caller's own, audited, and the other doctor's patterns are untouched", async () => {
    const r = await reset(dra.token, { surfaces: ["complaints"] }).expect(201);
    expect(r.body.surfaces).toEqual(["complaints"]);
    expect((await get(dra.token).expect(200)).body.complaints).toEqual([]);
    expect((await get(drb.token).expect(200)).body.complaints).toEqual([{ term: "cough", uses: 2 }]);
    const rows = await db.select().from(cdsDoctorLearningResets);
    expect(rows.map((x) => [x.userId, x.surface])).toEqual([[dra.userId, "complaints"]]);
    const audit = (await db.select().from(events)).filter((e) => e.name === "suggestions.learning_reset");
    expect(audit).toHaveLength(1);
  });

  it("refuses: no opd.consult 403, no doctor row 404 not_a_doctor, a bad body 400 with nothing written", async () => {
    await get(clerk.token).expect(403);
    await reset(clerk.token, { surfaces: "all" }).expect(403);
    const nd = await get(consultNoDoctor.token).expect(404);
    expect(nd.body.code).toBe("not_a_doctor");
    await reset(consultNoDoctor.token, { surfaces: "all" }).expect(404);
    await reset(dra.token, { surfaces: ["prices"] }).expect(400);
    await reset(dra.token, { surfaces: [] }).expect(400);
    expect(await db.select().from(cdsDoctorLearningResets)).toEqual([]);
  });
});
