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
import { copilotAsks, events } from "../src/kernel/db/schema";
import { ROLE_MODEL } from "../scripts/seed-roles";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, seedOpdBase } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * E0.3 HALT SWITCH + E0.5 SPEND CAP OVER HTTP (plan E0.3/E0.5, decision 0064; spec
 * /opt/hmis-context/SPEC-copilot-halt-and-cap-2026-10-11.md — built overnight 2026-10-11, awaiting
 * owner review).
 *
 * The chat model is CONFIGURED here (a fake base URL) and `fetch` is spied, so "zero model calls"
 * is a count of real outbound requests, not of a mocked router. The cap is set to ₹0.01 so ONE
 * model call reaches it: 900 in + 80 out tokens at the default gpt-oss-120b price is ₹0.016104.
 */
const ENV = {
  COPILOT_BASE_URL: "http://model.invalid/v1", COPILOT_API_KEY: "test-key", COPILOT_DAILY_CAP_INR: "0.01",
} as const;

describe("E0.3 + E0.5 — the copilot halt switch and the daily AI spend cap", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: { id: string; token: string };
  let owner: { id: string; token: string };
  let duty: { id: string; token: string };
  let modelCalls: number;

  const http = () => request(app.getHttpServer());
  const ask = (q: string) => http().post("/copilot/ask").set("Authorization", `Bearer ${clerk.token}`).send({ question: q });
  const halt = (token: string, scope: string) => http().post("/copilot/halt").set("Authorization", `Bearer ${token}`).send({ scope, reason: "drill" });
  const clear = (token: string, scope: string) => http().post("/copilot/halt/clear").set("Authorization", `Bearer ${token}`).send({ scope });
  const health = (token: string) => http().get("/copilot/health").set("Authorization", `Bearer ${token}`).expect(200);
  const rows = () => db.select().from(copilotAsks).orderBy(asc(copilotAsks.seq));

  /** A role holding exactly what the seeded role model grants it under `copilot.*`. */
  async function seededRole(roleKey: string): Promise<void> {
    await createRole(db, roleKey, roleKey);
    const grants = ROLE_MODEL.find((r) => r.roleKey === roleKey)?.permissions ?? [];
    for (const p of grants.filter((g) => g.startsWith("copilot."))) await grantPermissionToRole(db, registry, roleKey, p);
  }

  beforeAll(async () => {
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    // No chooser: the only outbound call is the chat model's, so `fetch` counts exactly the model calls.
    for (const k of ["COPILOT_TYPESAFE_API_KEY", "HMIS_OPENAI_KEY_FILE"]) saved[k] = process.env[k];
    delete process.env.COPILOT_TYPESAFE_API_KEY;
    process.env.HMIS_OPENAI_KEY_FILE = ""; // blank, not absent: a .env file cannot refill it
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await teardown();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    modelCalls = 0;
    jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      modelCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"tool\":\"queue_depth\",\"slot\":\"\"}" } }],
        usage: { prompt_tokens: 900, completion_tokens: 80 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await createRole(db, "desk", "Desk");
    for (const p of ["patients.read", "opd.visits.read", "opd.queue.read"]) await grantPermissionToRole(db, registry, "desk", p);
    for (const r of ["owner", "duty_manager"]) await seededRole(r);
    clerk = await mkUser(db, "halt_clerk", ["desk"]);
    owner = await mkUser(db, "halt_owner", ["owner"]);
    duty = await mkUser(db, "halt_duty", ["duty_manager"]);
  });

  it("done-means 2/3/4: the duty manager halts and clears act, cannot clear global; the owner can; every change is an event naming who", async () => {
    await halt(clerk.token, "act").expect(403);
    await halt(duty.token, "act").expect(200);
    await clear(duty.token, "act").expect(200);
    await halt(duty.token, "global").expect(200);
    await clear(duty.token, "global").expect(403);
    expect((await health(owner.token)).body.halts.map((h: { scope: string }) => h.scope)).toEqual(["global"]);
    await clear(clerk.token, "global").expect(403);
    await clear(owner.token, "global").expect(200);
    expect((await health(duty.token)).body.halts).toEqual([]);

    const evs = (await db.select().from(events).orderBy(asc(events.seq))).filter((e) => e.name.startsWith("copilot.halt"));
    expect(evs.map((e) => [e.name, (e.payload as { scope: string }).scope, e.actorId])).toEqual([
      ["copilot.halt_set", "act", duty.id],
      ["copilot.halt_cleared", "act", duty.id],
      ["copilot.halt_set", "global", duty.id],
      ["copilot.halt_cleared", "global", owner.id],
    ]);
  });

  it("done-means 5: a halted read path answers 'paused', reaches no model, and is ledgered `halted`; an act halt leaves reads answering", async () => {
    await halt(owner.token, "read").expect(200);
    const res = await ask("kitna wait hai").expect(200);
    expect(res.body.answer.key).toBe("copilot.answer.paused");
    await ask("what colour is the canteen wall").expect(200);
    expect(modelCalls).toBe(0);
    expect((await rows()).map((r) => [r.outcome, r.answerKey, r.modelCalls])).toEqual([
      ["halted", "copilot.answer.paused", 0], ["halted", "copilot.answer.paused", 0],
    ]);

    await clear(owner.token, "read").expect(200);
    await halt(owner.token, "act").expect(200);
    const read = await ask("kitna wait hai").expect(200);
    expect(read.body.answer.key).not.toBe("copilot.answer.paused");
    expect((await rows())[2]!.outcome).not.toBe("halted");
  });

  it("done-means 6/7: a model call is recorded with tokens and ₹; at the cap the next ask makes ZERO model calls and health says capped", async () => {
    expect((await health(owner.token)).body).toMatchObject({ capInr: 0.01, capped: false, modelCalls: 0, spendInr: 0 });

    const first = await ask("what colour is the canteen wall").expect(200);
    expect(first.body.intent).toBe("queue_depth"); // the (fake) model routed it
    expect(modelCalls).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ route: "model", modelCalls: 1, costMicroInr: 16_104, capped: false });
    expect(row!.modelUsage).toEqual([{
      provider: "chat", model: "openai/gpt-oss-120b", kind: "model", inTok: 900, outTok: 80, microInr: 16_104, ok: true, tokens: "usage",
    }]);

    const second = await ask("what colour is the canteen wall").expect(200);
    expect(modelCalls).toBe(1); // capped: nothing left the box
    expect(second.body.answer.key).toBe("copilot.answer.notUnderstood");
    expect((await rows())[1]).toMatchObject({ capped: true, modelCalls: 0, costMicroInr: 0, route: "none" });
    // The phrasebook still answers what it knows.
    expect((await ask("kitna wait hai").expect(200)).body.source).toBe("phrasebook");
    expect(modelCalls).toBe(1);

    expect((await health(owner.token)).body).toMatchObject({ capped: true, modelCalls: 1, spendInr: 0.02, cappedAsks: 2 });
  });
});
