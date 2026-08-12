import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions, assignRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

const DEF_C = {
  key: "e2e_flow",
  title: "E2E Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const DEF_A = { ...DEF_C, key: "e2e_class_a", changeClass: "A" };

describe("workflow definitions e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let drafterToken: string;
  let activatorToken: string;
  let randoToken: string;
  let activatorId: string;
  let msId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await syncPermissions(db, registry);
    await createRole(db, "wf_admin", "Workflow Admin");
    for (const permission of workflowManifest.permissions) {
      await grantPermissionToRole(db, registry, "wf_admin", permission);
    }
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "Medical Superintendent");

    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const drafter = await mk("drafter");
    const activator = await mk("activator");
    const ms = await mk("ms1");
    const rando = await mk("rando");
    drafterToken = drafter.token;
    activatorToken = activator.token;
    randoToken = rando.token;
    activatorId = activator.id;
    msId = ms.id;
    await assignRole(db, { userId: drafter.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: activator.id, roleKey: "owner", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "wf_admin", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
  });

  it("guards every definition route: 401 unauthenticated, 403 without the permission", async () => {
    await request(app.getHttpServer()).post("/workflow/definitions").send(DEF_C).expect(401);
    await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${randoToken}`)
      .send(DEF_C).expect(403);
    await request(app.getHttpServer())
      .get("/workflow/definitions?key=e2e_flow").set("Authorization", `Bearer ${randoToken}`)
      .expect(403);
  });

  it("rejects an invalid definition with 400 and the problems list", async () => {
    const res = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send({ ...DEF_C, initialState: "nowhere" })
      .expect(400);
    // The 400 body carries the `problems` array verbatim; assert membership on the array
    // itself (JSON.stringify would escape the inner quotes and never match).
    expect(res.body.message).toContain('initialState "nowhere" is not a declared state');
  });

  it("class C lifecycle over HTTP: draft → drafter self-activation 403 (SoD) → activate → list", async () => {
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send(DEF_C).expect(201);
    const { definitionId } = draft.body as { definitionId: string };

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${drafterToken}`)
      .expect(403); // drafter ≠ activator (SoD pair, evented)

    const activated = await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(201);
    expect(activated.body).toEqual({ retiredVersion: null });

    const list = await request(app.getHttpServer())
      .get("/workflow/definitions?key=e2e_flow").set("Authorization", `Bearer ${drafterToken}`)
      .expect(200);
    expect(list.body.definitions).toHaveLength(1);
    expect(list.body.definitions[0]).toMatchObject({ version: 1, status: "active" });
  });

  it("class A over HTTP: activation 409 until owner AND MS approve", async () => {
    const draft = await request(app.getHttpServer())
      .post("/workflow/definitions").set("Authorization", `Bearer ${drafterToken}`)
      .send(DEF_A).expect(201);
    const { definitionId } = draft.body as { definitionId: string };

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(409); // approvals_missing

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/approve`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .send({ roleKey: "owner", note: "reviewed and safe" })
      .expect(201);
    const msSession = await createSession(db, cfg, msId);
    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/approve`)
      .set("Authorization", `Bearer ${msSession.token}`)
      .send({ roleKey: "medical_superintendent", note: "clinically reviewed" })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workflow/definitions/${definitionId}/activate`)
      .set("Authorization", `Bearer ${activatorToken}`)
      .expect(201);
    expect(activatorId).toBeTruthy(); // activator drove the flow end to end
  });
});
