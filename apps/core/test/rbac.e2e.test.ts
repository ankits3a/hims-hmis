import { Test } from "@nestjs/testing";
import { Controller, Get, INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createAgent } from "../src/kernel/auth/agents";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("scope-test")
class ScopeTestController {
  @RequirePermission("auth.users.manage", "hospital")
  @Get("admin")
  admin(): { ok: boolean } { return { ok: true }; }

  @RequirePermission("auth.users.manage", "department")
  @Get("dept/:departmentId")
  dept(): { ok: boolean } { return { ok: true }; }
}

describe("rbac e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ScopeTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  async function userWithToken(username: string): Promise<{ userId: string; token: string }> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    return { userId: id, token };
  }

  it("denies without the permission, allows with a hospital-scope role", async () => {
    const { userId, token } = await userWithToken("asha");
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("Authorization", `Bearer ${token}`).expect(403);
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "admin", scopeType: "hospital" });
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("department scope binds to the route's departmentId", async () => {
    const { userId, token } = await userWithToken("ravi");
    await createRole(db, "dept-admin", "Dept Admin");
    await grantPermissionToRole(db, registry, "dept-admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "dept-admin", scopeType: "department", scopeId: "cardio" });
    await request(app.getHttpServer())
      .get("/scope-test/dept/cardio").set("Authorization", `Bearer ${token}`).expect(200);
    await request(app.getHttpServer())
      .get("/scope-test/dept/ortho").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("agents are denied on permission-guarded routes", async () => {
    const { apiKey } = await createAgent(db, "probe");
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("x-agent-key", apiKey).expect(403);
  });
});
