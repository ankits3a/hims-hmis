import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { asc } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { createAgent } from "../src/kernel/auth/agents";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { copilotAsks } from "../src/kernel/db/schema";
import * as router from "../src/kernel/copilot/router";
import { IdentifierLeak } from "../src/kernel/copilot/mask";
import { ROLE_MODEL } from "../scripts/seed-roles";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkPatient, mkUser, seedOpdBase } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * E0.1 — THE COPILOT LEDGER OVER HTTP (decision 0064; spec /opt/hmis-context/SPEC-copilot-ledger-2026-10-10.md).
 *
 * Done-means 1, 2, 3, 7 and 8, and the owner's notice ruling (2026-10-10: notice first). The rows
 * are counted against the asks SENT, refusals and errors included, because G6(a) reconciles this
 * table against the edge's count of POST /copilot/ask and a ledger that drops the odd refusal
 * cannot be reconciled with anything.
 */
describe("E0.1 — every copilot ask leaves one ledger row", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: { id: string; token: string };
  let stranger: { id: string; token: string };
  let patient: { id: string; uhid: string };

  const http = () => request(app.getHttpServer());
  const ask = (token: string, body: unknown): request.Test =>
    http().post("/copilot/ask").set("Authorization", `Bearer ${token}`).send(body as object);
  const rows = () => db.select().from(copilotAsks).orderBy(asc(copilotAsks.seq));

  /** A role holding exactly what the seeded role model grants it under `copilot.*` — the real model, not a test grant. */
  async function seededRole(roleKey: string): Promise<void> {
    await createRole(db, roleKey, roleKey);
    const grants = ROLE_MODEL.find((r) => r.roleKey === roleKey)?.permissions ?? [];
    for (const p of grants.filter((g) => g.startsWith("copilot."))) await grantPermissionToRole(db, registry, roleKey, p);
  }

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
    jest.restoreAllMocks();
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await createRole(db, "desk", "Desk");
    for (const p of ["patients.read", "opd.visits.read", "opd.queue.read"]) await grantPermissionToRole(db, registry, "desk", p);
    await createRole(db, "nobody", "Nobody");
    clerk = await mkUser(db, "ledger_clerk", ["desk"]);
    stranger = await mkUser(db, "ledger_stranger", ["nobody"]);
    patient = await mkPatient(db, { type: "user", id: clerk.id }, { name: "Asha Devi" });
  });

  it("D1: N asks → N rows — answered, notUnderstood, notPermitted, IdentifierLeak, a non-user actor and an invalid body", async () => {
    await ask(clerk.token, { question: `has ${patient.uhid} been seen by doctor?` }).expect(200);
    await ask(clerk.token, { question: "what colour is the canteen wall" }).expect(200);
    await ask(stranger.token, { question: `has ${patient.uhid} been seen by doctor?` }).expect(200);
    jest.spyOn(router, "routeQuestion").mockRejectedValueOnce(new IdentifierLeak("test"));
    await ask(clerk.token, { question: "something the scrubber catches" }).expect(200);
    const { apiKey } = await createAgent(db, "ledger-agent");
    await http().post("/copilot/ask").set("x-agent-key", apiKey).send({ question: "kitna wait hai" }).expect(403);
    await ask(clerk.token, { question: "" }).expect(400);

    const got = await rows();
    expect(got).toHaveLength(6);
    expect(got.map((r) => r.outcome)).toEqual([
      "answered", "notUnderstood", "notPermitted", "identifierLeak", "refusedActor", "badRequest",
    ]);
    expect(got.map((r) => r.actorType)).toEqual(["user", "user", "user", "user", "agent", "user"]);
    expect(got[0]!.actorId).toBe(clerk.id);
    expect(got.every((r) => r.ms >= 0)).toBe(true);
  });

  it("D2: no row holds the raw question — a UHID is stored as its placeholder, a scrubbed question not at all", async () => {
    await ask(clerk.token, { question: `has ${patient.uhid} been seen by doctor?`, screen: "opd" }).expect(200);
    jest.spyOn(router, "routeQuestion").mockRejectedValueOnce(new IdentifierLeak("test"));
    await ask(clerk.token, { question: "a question the scrubber refused" }).expect(200);
    await ask(clerk.token, { question: "" }).expect(400);

    const [answered, leaked, bad] = await rows();
    expect(answered!.maskedQuestion).toBe("has <<P1>> been seen by doctor?");
    expect(answered!.screen).toBe("opd");
    expect(answered!.intent).toBe("visit_status");
    expect(JSON.stringify(await rows())).not.toContain(patient.uhid);
    expect(leaked!.maskedQuestion).toBeNull();
    expect(bad!.maskedQuestion).toBeNull();
  });

  it("D3: each row names the route that answered — a chooser answer is recorded as `chooser`, not `model`", async () => {
    await ask(clerk.token, { question: `has ${patient.uhid} been seen by doctor?` }).expect(200);
    jest.spyOn(router, "routeQuestion").mockResolvedValueOnce({
      intent: "visit_status", slot: null, source: "model", via: "chooser", cues: [],
    });
    const res = await ask(clerk.token, { question: "andar gaye ya nahi" }).expect(200);
    expect(res.body.source).toBe("model"); // the web's shape is unchanged
    await ask(clerk.token, { question: "what colour is the canteen wall" }).expect(200);
    expect((await rows()).map((r) => r.route)).toEqual(["phrasebook", "chooser", "none"]);
  });

  it("D7 + D8: the health read answers owner, admin and quality_manager, refuses a doctor and a cashier, and names nobody", async () => {
    for (const r of ["owner", "admin", "quality_manager", "doctor", "cashier"]) await seededRole(r);
    await ask(clerk.token, { question: `has ${patient.uhid} been seen by doctor?` }).expect(200);
    await ask(clerk.token, { question: "what colour is the canteen wall" }).expect(200);

    for (const r of ["owner", "admin", "quality_manager"]) {
      const u = await mkUser(db, `h_${r}`, [r]);
      const res = await http().get("/copilot/health").set("Authorization", `Bearer ${u.token}`).expect(200);
      expect(res.body.asks).toBe(2);
      expect(res.body.byOutcome.notUnderstood).toBe(1);
      expect(Object.keys(res.body).sort()).toEqual(
        // E0.3/E0.5 added the cost meter, the cap and the halt switch — still nothing that names a person.
        ["acts", "askers", "asks", "byOutcome", "byRoute", "capInr", "capped", "cappedAsks", "date", "halts", "modelCalls",
          "notUnderstoodShare", "spendInr"],
      );
      expect(JSON.stringify(res.body)).not.toContain(clerk.id);
      expect(JSON.stringify(res.body)).not.toContain("ledger_clerk");
    }
    for (const r of ["doctor", "cashier"]) {
      const u = await mkUser(db, `h_${r}`, [r]);
      await http().get("/copilot/health").set("Authorization", `Bearer ${u.token}`).expect(403);
    }
  });

  it("notice: unseen before the first ask, seen for good after dismissing — and the ask is recorded either way", async () => {
    const seen = () => http().get("/copilot/notice").set("Authorization", `Bearer ${clerk.token}`).expect(200);
    expect((await seen()).body).toEqual({ seen: false });
    await ask(clerk.token, { question: "what colour is the canteen wall" }).expect(200);
    await http().post("/copilot/notice").set("Authorization", `Bearer ${clerk.token}`).expect(204);
    expect((await seen()).body).toEqual({ seen: true });
    expect((await http().get("/copilot/notice").set("Authorization", `Bearer ${stranger.token}`).expect(200)).body)
      .toEqual({ seen: false });
    await ask(clerk.token, { question: "what colour is the canteen wall" }).expect(200);
    expect(await rows()).toHaveLength(2);
  });
});
