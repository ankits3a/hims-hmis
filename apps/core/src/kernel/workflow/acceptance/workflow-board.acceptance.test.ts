import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { createUser } from "../../auth/identity";
import { createSession } from "../../auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../auth/permissions";
import { authManifest } from "../../auth/manifest";
import { ModuleRegistry } from "../../modules/loader";
import { loadConfig, requireEnv } from "../../config";
import { workflowManifest } from "../manifest";
import { createDraft } from "../definitions";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../../db/client";

/**
 * ═══ GO-LIVE SCREENS — `GET /workflow/definitions/board` (acceptance) ═══
 *
 * Done means: a holder of `workflow.definitions.read` gets 200 and the drafted definition with its missing roles;
 * a caller without it gets 403.
 */
describe("GET /workflow/definitions/board", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
  let holder: string;
  let other: string;

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
    await createRole(db, "wf_reader", "Workflow reader");
    await grantPermissionToRole(db, registry, "wf_reader", "workflow.definitions.read");
    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { id, token: (await createSession(db, cfg, id)).token };
    };
    const h = await mk("holder");
    const o = await mk("other");
    await assignRole(db, { userId: h.id, roleKey: "wf_reader", scopeType: "hospital" });
    holder = h.token; other = o.token;
    await createDraft(db, { type: "system", id: "drafter" }, {
      key: "board_case", title: "Board case", changeClass: "A", initialState: "a",
      states: [{ name: "a", sla: { minutes: 30, alerting: "active" } }, { name: "b", terminal: true }],
      transitions: [{ from: "a", to: "b", roles: ["front_office"] }],
    });
  });

  it("200 for a holder of workflow.definitions.read, with the draft and its missing roles", async () => {
    const res = await request(app.getHttpServer()).get("/workflow/definitions/board").set("Authorization", `Bearer ${holder}`).expect(200);
    expect(res.body.definitions).toEqual([expect.objectContaining({
      defKey: "board_case", status: "draft", missingRoles: ["owner", "medical_superintendent"],
    })]);
    expect(res.body.viewer).toEqual({ policyRoles: [] });
  });

  it("403 for a caller without it", async () => {
    await request(app.getHttpServer()).get("/workflow/definitions/board").set("Authorization", `Bearer ${other}`).expect(403);
  });
});
