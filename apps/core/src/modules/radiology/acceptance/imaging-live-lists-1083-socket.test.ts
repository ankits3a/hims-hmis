import { Test } from "@nestjs/testing";
import { WebSocket } from "ws";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { createUser } from "../../../kernel/auth/identity";
import { createSession } from "../../../kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { loadConfig, requireEnv } from "../../../kernel/config";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1083, spec docs/specs/1083-imaging-live-lists.md (owner APPROVED 2026-11-14), the
 * gate: the floor topic is permission-gated at the REAL socket, through the module registration the app
 * boots with — not through a space a test registered for itself.
 *
 * The holder is the non-vacuity leg: a refusal proves nothing unless the same subscription is accepted
 * for someone who holds `radiology.worklist.read`. The refused user holds `radiology.reports.read`, the
 * grant a ward doctor carries (they read the REPORT, never the department's worklist).
 */
type Frame = { type: string } & Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("imaging lists go live — the floor topic's gate (spec #1083)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let port: number;
  const sockets: WebSocket[] = [];
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  const waitFor = async (frames: Frame[], pred: (f: Frame) => boolean, ms = 5000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`no matching frame within ${ms} ms; saw ${JSON.stringify(frames)}`);
      await sleep(20);
    }
  };

  /** Connect, authenticate with `token`, subscribe to `topics`, and return the first answer to the subscribe. */
  const subscribeAs = async (token: string, topics: string[]): Promise<Frame> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("message", (raw) => { frames.push(JSON.parse(String(raw)) as Frame); });
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(frames, (f) => f.type === "authed");
    ws.send(JSON.stringify({ type: "subscribe", topics }));
    return waitFor(frames, (f) => f.type === "subscribed" || (f.type === "error" && f.code === "forbidden_topic"));
  };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    while (sockets.length > 0) sockets.pop()!.terminate();
    await app.close();
    await teardown();
  });

  it("spec #1083 D2 — a user without radiology.worklist.read cannot subscribe to imaging:floor", async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "R", menu: [], subscriptions: [],
      permissions: ["radiology.worklist.read", "radiology.reports.read"],
    });
    await syncPermissions(db, registry);
    await createRole(db, "d2_floor", "Imaging floor");
    await grantPermissionToRole(db, registry, "d2_floor", "radiology.worklist.read");
    await createRole(db, "d2_doctor", "Ward doctor");
    await grantPermissionToRole(db, registry, "d2_doctor", "radiology.reports.read");
    const mk = async (username: string, roleKey: string): Promise<string> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
      return (await createSession(db, cfg, id)).token;
    };
    const holder = await mk("d2holder", "d2_floor");
    const doctor = await mk("d2doctor", "d2_doctor");

    // NON-VACUITY: the same subscription is accepted for a holder of the grant.
    expect(await subscribeAs(holder, ["imaging:floor"])).toEqual({ type: "subscribed", topics: ["imaging:floor"] });
    // THE CHECK: without it, the floor topic is refused.
    expect(await subscribeAs(doctor, ["imaging:floor"])).toEqual({ type: "error", code: "forbidden_topic", topics: ["imaging:floor"] });
  });
});
