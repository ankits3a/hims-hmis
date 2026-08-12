import { Test } from "@nestjs/testing";
import { Controller, Get, INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { useBreakGlass } from "../src/kernel/auth/break-glass";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("record-test")
class RecordTestController {
  @RequirePermission("auth.users.manage", "hospital", { breakGlassBypass: true })
  @Get("patient/:patientId")
  read(): { ok: boolean } { return { ok: true }; }
}

describe("break-glass e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RecordTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("active grant bypasses a missing permission for that patient only", async () => {
    const { id } = await createUser(db, { username: "er1", fullName: "ER", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await request(app.getHttpServer())
      .get("/record-test/patient/P1").set("Authorization", `Bearer ${token}`).expect(403);
    await useBreakGlass(db, cfg, { type: "user", id }, { patientId: "P1", reason: "emergency" });
    await request(app.getHttpServer())
      .get("/record-test/patient/P1").set("Authorization", `Bearer ${token}`).expect(200);
    await request(app.getHttpServer())
      .get("/record-test/patient/P2").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("the endpoint needs auth.break_glass.use; review needs auth.break_glass.review", async () => {
    const { id } = await createUser(db, { username: "er2", fullName: "ER", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await request(app.getHttpServer())
      .post("/auth/break-glass").set("Authorization", `Bearer ${token}`)
      .send({ patientId: "P1", reason: "emergency" }).expect(403);

    await createRole(db, "er-staff", "ER Staff");
    await grantPermissionToRole(db, registry, "er-staff", "auth.break_glass.use");
    await assignRole(db, { userId: id, roleKey: "er-staff", scopeType: "hospital" });
    const res = await request(app.getHttpServer())
      .post("/auth/break-glass").set("Authorization", `Bearer ${token}`)
      .send({ patientId: "P1", reason: "emergency" }).expect(201);
    expect(res.body.grantId).toHaveLength(26);

    await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(403);
    await grantPermissionToRole(db, registry, "er-staff", "auth.break_glass.review");
    const pending = await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(200);
    expect(pending.body.items).toHaveLength(1);
    await request(app.getHttpServer())
      .post(`/auth/break-glass/${res.body.grantId}/review`)
      .set("Authorization", `Bearer ${token}`).send({ note: "justified" }).expect(204);
  });
});
