import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

describe("temp roles e2e", () => {
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("temp-role grants need the permission; emergency elevation is open and takes effect", async () => {
    const { id } = await createUser(db, { username: "night", fullName: "N", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);

    await request(app.getHttpServer())
      .post("/auth/temp-roles").set("Authorization", `Bearer ${token}`)
      .send({ userId: "someone", roleKey: "reviewer", reason: "cover", ttlMinutes: 30 }).expect(403);

    await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "reviewer", reason: "duty manager unreachable", ttlMinutes: 30 }).expect(201);

    // The elevated role's permission now passes on a guarded route:
    await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(200);
  });
});
