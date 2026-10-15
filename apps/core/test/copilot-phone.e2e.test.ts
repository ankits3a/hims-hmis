import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { asc } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { copilotAskFeedback, copilotAsks } from "../src/kernel/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, seedOpdBase } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * E1.3 — THE PHONE'S HALF OF THE LEDGER (decision 0064; spec /opt/hmis-context/SPEC-copilot-phone-2026-10-11.md).
 *
 * The phone tells the server whether a question came from a chip or was typed (goal G1 per source),
 * and a "Wrong" tap on an answer card writes one feedback row (goal G3b) — for the asker's own
 * question only. The ask id the tap names comes back in the ask's own response.
 */
describe("E1.3 — chip vs typed, and the wrong tap", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let nurse: { id: string; token: string };
  let other: { id: string; token: string };

  const http = () => request(app.getHttpServer());
  const ask = (token: string, body: unknown): request.Test =>
    http().post("/copilot/ask").set("Authorization", `Bearer ${token}`).send(body as object);
  const wrong = (token: string, body: unknown): request.Test =>
    http().post("/copilot/feedback").set("Authorization", `Bearer ${token}`).send(body as object);

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
    await createRole(db, "ward", "Ward");
    await grantPermissionToRole(db, registry, "ward", "opd.queue.read");
    nurse = await mkUser(db, "phone_nurse", ["ward"]);
    other = await mkUser(db, "phone_other", ["ward"]);
  });

  it("records source=chip for a chip and source=typed for a typed question, and returns the row's id as askId", async () => {
    const a = await ask(nurse.token, { question: "shortest line", screen: "phone", source: "chip" }).expect(200);
    const b = await ask(nurse.token, { question: "kitni der lagegi line mein", screen: "phone", source: "typed" }).expect(200);
    await ask(nurse.token, { question: "shortest line" }).expect(200); // the web sends none
    const rows = await db.select().from(copilotAsks).orderBy(asc(copilotAsks.seq));
    expect(rows.map((r) => [r.source, r.screen, r.intent])).toEqual([
      ["chip", "phone", "queue_depth"], ["typed", "phone", "queue_depth"], [null, null, "queue_depth"],
    ]);
    expect(a.body.askId).toBe(rows[0]!.id);
    expect(b.body.askId).toBe(rows[1]!.id);
  });

  it("refuses a source that is neither chip nor typed (and still records the ask)", async () => {
    await ask(nurse.token, { question: "shortest line", source: "widget" }).expect(400);
    expect((await db.select().from(copilotAsks)).map((r) => r.outcome)).toEqual(["badRequest"]);
  });

  it("a wrong tap on my own answer writes one feedback row; a second tap writes nothing more", async () => {
    const { body } = await ask(nurse.token, { question: "shortest line", source: "chip" }).expect(200);
    await wrong(nurse.token, { askId: body.askId, wrong: true }).expect(204);
    await wrong(nurse.token, { askId: body.askId, wrong: true }).expect(204);
    const fb = await db.select().from(copilotAskFeedback);
    expect(fb.map((r) => [r.askId, r.userId, r.verdict])).toEqual([[body.askId, nurse.id, "wrong"]]);
  });

  it("another person's ask id, or one that does not exist, is 404 and writes nothing", async () => {
    const { body } = await ask(nurse.token, { question: "shortest line", source: "chip" }).expect(200);
    await wrong(other.token, { askId: body.askId, wrong: true }).expect(404);
    await wrong(other.token, { askId: "no-such-ask", wrong: true }).expect(404);
    await wrong(nurse.token, { askId: body.askId }).expect(400);
    expect(await db.select().from(copilotAskFeedback)).toEqual([]);
  });

  it("signed out cannot tap wrong", async () => {
    await http().post("/copilot/feedback").send({ askId: "x", wrong: true }).expect(401);
  });
});
