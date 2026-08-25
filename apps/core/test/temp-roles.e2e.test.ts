import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
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
    await createRole(db, "night_cover", "Night cover");
    await grantPermissionToRole(db, registry, "night_cover", "auth.break_glass.use");
    // The role the ceiling exists to refuse. `auth.roles.manage` is the sharp one: its holder can
    // write a PERMANENT `role_assignments` row, so the escalation outlives the twelve-hour TTL.
    await createRole(db, "escalating", "Escalating");
    await grantPermissionToRole(db, registry, "escalating", "auth.roles.manage");
    await createRole(db, "elevation_reviewer", "Elevation reviewer");
    await grantPermissionToRole(db, registry, "elevation_reviewer", "auth.elevation.review");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("temp-role grants need the permission; emergency elevation is open and takes effect", async () => {
    const { id } = await createUser(db, { username: "night", fullName: "N", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);

    await request(app.getHttpServer())
      .post("/auth/temp-roles").set("Authorization", `Bearer ${token}`)
      .send({ userId: "someone", roleKey: "night_cover", reason: "cover", ttlMinutes: 30 }).expect(403);

    await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "night_cover", reason: "duty manager unreachable", ttlMinutes: 30 }).expect(201);

    // The elevated role's permission now passes on a guarded route:
    await request(app.getHttpServer())
      .post("/auth/break-glass").set("Authorization", `Bearer ${token}`)
      .send({ reason: "ER, record needed now" }).expect(201);
  });

  /**
   * THE ESCALATION, REPLAYED END TO END OVER HTTP — this is the test the fix exists for.
   *
   * Before the ceiling this exact sequence returned 201 and then let the elevated clerk write a
   * PERMANENT `admin` assignment for an account of their own making. The 403 is the whole change.
   */
  it("REFUSES self-elevation into authority over access, over HTTP, leaving the caller powerless", async () => {
    const { id } = await createUser(db, { username: "clerk", fullName: "C", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);

    const refused = await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "escalating", reason: "nobody is answering the phone", ttlMinutes: 720 })
      .expect(403);
    expect(refused.body.code).toBe("role_not_temporarily_grantable");

    // And the authority genuinely did not land: the route `auth.roles.manage` guards still refuses.
    await request(app.getHttpServer())
      .post(`/admin/users/${id}/roles`).set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "escalating", scopeType: "hospital" }).expect(403);

    // A role nobody seeded is a 404 with a sentence, not the foreign-key 500 it used to be.
    await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "adminn", reason: "fat finger", ttlMinutes: 30 }).expect(404);
  });

  it("the review queue is permission-gated, lists the elevation, and closes it once", async () => {
    const { id } = await createUser(db, { username: "night2", fullName: "N", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "night_cover", reason: "duty manager unreachable", ttlMinutes: 30 }).expect(201);

    // The person who took the authority cannot review it: `auth.elevation.review` is not on
    // ELEVATABLE_AUTH_PERMISSIONS, so no elevation can ever reach this queue's own gate.
    await request(app.getHttpServer())
      .get("/auth/emergency-elevations/pending").set("Authorization", `Bearer ${token}`).expect(403);

    const { id: msId } = await createUser(db, { username: "ms", fullName: "MS", password: "p1234567" });
    await assignRole(db, { userId: msId, roleKey: "elevation_reviewer", scopeType: "hospital" });
    const { token: msToken } = await createSession(db, cfg, msId);

    const pending = await request(app.getHttpServer())
      .get("/auth/emergency-elevations/pending").set("Authorization", `Bearer ${msToken}`).expect(200);
    expect(pending.body.items).toHaveLength(1);
    const grantId = pending.body.items[0].id;
    expect(pending.body.items[0]).toMatchObject({ userId: id, roleKey: "night_cover" });

    await request(app.getHttpServer())
      .post(`/auth/emergency-elevations/${grantId}/review`).set("Authorization", `Bearer ${msToken}`)
      .send({ note: "justified — ER, MS informed" }).expect(204);

    const after = await request(app.getHttpServer())
      .get("/auth/emergency-elevations/pending").set("Authorization", `Bearer ${msToken}`).expect(200);
    expect(after.body.items).toHaveLength(0);

    await request(app.getHttpServer())
      .post(`/auth/emergency-elevations/${grantId}/review`).set("Authorization", `Bearer ${msToken}`)
      .send({ note: "again" }).expect(409);
  });
});
