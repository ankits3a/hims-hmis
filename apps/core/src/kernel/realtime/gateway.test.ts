import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { WebSocket } from "ws";
import { AppModule } from "../../app.module";
import { configureApp } from "../../app.bootstrap";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser, deactivateUser, setPassword } from "../auth/identity";
import { createSession, findLiveSession } from "../auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { ModuleRegistry } from "../modules/loader";
import { loadConfig, requireEnv } from "../config";
import { appendEvent } from "../events/append";
import { createDb, withTx } from "../db/client";
import { alertRaised } from "../alerts/events";
import { RealtimeGateway } from "./gateway";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import type { Db } from "../db/client";

type Frame = { type: string } & Record<string, unknown>;

const mkInput = (name: string, patientId: string) => ({
  name,
  version: 1,
  occurredAt: new Date(),
  actor: { type: "system" as const, id: "ws-test" },
  module: "opd",
  payload: { patientId },
  siteId: "main",
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("RealtimeGateway", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let dbB: Db;
  let poolB: Pool;
  let port: number;
  let gateway: RealtimeGateway;

  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let readerId: string;
  let readerToken: string;
  let randoId: string;
  let randoToken: string;
  const sockets: WebSocket[] = [];

  const connect = async (): Promise<{ ws: WebSocket; frames: Frame[] }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("message", (raw) => { frames.push(JSON.parse(String(raw)) as Frame); });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    return { ws, frames };
  };

  const send = (ws: WebSocket, msg: unknown): void => { ws.send(JSON.stringify(msg)); };

  const waitFor = async (frames: Frame[], pred: (f: Frame) => boolean, ms = 3000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`no matching frame within ${ms} ms; saw ${JSON.stringify(frames)}`);
      await sleep(20);
    }
  };

  const waitClosed = async (ws: WebSocket, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (ws.readyState !== WebSocket.CLOSED) {
      if (Date.now() > deadline) throw new Error(`socket still in readyState ${ws.readyState} after ${ms} ms`);
      await sleep(20);
    }
  };

  const authed = async (token: string): Promise<{ ws: WebSocket; frames: Frame[] }> => {
    const c = await connect();
    send(c.ws, { type: "auth", token });
    await waitFor(c.frames, (f) => f.type === "authed");
    return c;
  };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    // Pool B is "another process": a second connection pool onto the same worker database.
    ({ db: dbB, pool: poolB } = createDb(workerUrl.toString()));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    gateway = app.get(RealtimeGateway);
    gateway.registerTopicSpace({ prefix: "t", permission: "patients.read" });
    gateway.registerRouter({
      names: ["patient.registered", "queue.called"],
      topicsFor: (e) => [`t:${(e.payload as { patientId?: string }).patientId ?? "x"}`],
    });
  });

  afterAll(async () => { await app.close(); await poolB.end(); await teardown(); });

  beforeEach(async () => {
    gateway.configure({ authTimeoutMs: 5000 });
    await truncateAll(db);
    // The app's tail is live and per-process: `restart identity` puts max(seq) below its cursor,
    // and the reset that clears the cursor and the dedupe set happens on the NEXT tick (300 ms).
    // Wait for it, so what each test observes is this test's appends and nothing carried over.
    await sleep(700);

    await syncPermissions(db, registry);
    await createRole(db, "ws_reader", "WS Reader");
    await grantPermissionToRole(db, registry, "ws_reader", "patients.read");
    const mk = async (username: string): Promise<{ id: string; token: string }> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      const { token } = await createSession(db, cfg, id);
      return { id, token };
    };
    const reader = await mk("wsreader");
    const rando = await mk("wsrando");
    readerId = reader.id;
    readerToken = reader.token;
    randoId = rando.id;
    randoToken = rando.token;
    await assignRole(db, { userId: reader.id, roleKey: "ws_reader", scopeType: "hospital" });
  });

  afterEach(() => {
    while (sockets.length > 0) sockets.pop()!.terminate();
  });

  it("PLAN 11e (CLOSE M7) — a DEACTIVATED user and a MUST-CHANGE user are both refused at the socket", async () => {
    /**
     * D1 makes two claims about this gateway and, until this leg, neither was executed here.
     * `sessions.test.ts` asserts `findLiveSession`'s CONTRACT — which is where the deactivated
     * half comes from for free, since the join makes that session resolve to null — but the
     * must-change branch is this file's own line and a mutant deleting it survived the whole
     * suite. Found by the 11e independent reviewer (M7).
     */
    const { id } = await createUser(db, { username: "socket_user", fullName: "S", password: "s3cret-pass" });
    const { token } = await createSession(db, cfg, id);

    // NON-VACUITY FIRST: this exact token authenticates today.
    const ok = await authed(token);
    expect(ok.frames.some((f) => f.type === "authed")).toBe(true);

    // (a) MUST-CHANGE — the session still RESOLVES (that is D1's design, so the change can be made
    // on it over HTTP); the socket refuses it anyway, because a person mid-credential-reset has no
    // business streaming a hospital's event fabric.
    await setPassword(db, id, "issued-by-the-admin", { mustChangePassword: true });
    expect(await findLiveSession(db, token)).not.toBeNull();
    const mustChange = await connect();
    send(mustChange.ws, { type: "auth", token });
    expect(await waitFor(mustChange.frames, (f) => f.type === "error")).toEqual({
      type: "error", code: "unauthorized",
    });
    await waitClosed(mustChange.ws);

    // (b) DEACTIVATED — the free half, asserted rather than assumed: the join in `findLiveSession`
    // is what closes this socket, with no branch in this file at all.
    await setPassword(db, id, "chosen-by-the-human", { mustChangePassword: false });
    await deactivateUser(db, id);
    const gone = await connect();
    send(gone.ws, { type: "auth", token });
    expect(await waitFor(gone.frames, (f) => f.type === "error")).toEqual({
      type: "error", code: "unauthorized",
    });
    await waitClosed(gone.ws);
  });

  it("refuses a subscribe before auth and a bad token, and closes a socket that never authenticates", async () => {
    // (a) protocol order, then a token that verifies to nothing
    const early = await connect();
    send(early.ws, { type: "subscribe", topics: ["t:p1"] });
    expect(await waitFor(early.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "unauthorized" });

    const bad = await connect();
    send(bad.ws, { type: "auth", token: "not-a-live-token" });
    expect(await waitFor(bad.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "unauthorized" });
    await waitClosed(bad.ws);

    // (b) the auth deadline closes a socket that says nothing at all
    gateway.configure({ authTimeoutMs: 300 });
    const silent = await connect();
    expect(await waitFor(silent.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "auth_timeout" });
    await waitClosed(silent.ws);
  });

  it("authenticates, subscribes inside a registered topic space, and refuses an unregistered prefix", async () => {
    const c = await authed(readerToken);
    expect(c.frames.find((f) => f.type === "authed")).toEqual({ type: "authed", userId: readerId });

    send(c.ws, { type: "subscribe", topics: ["t:p1"] });
    expect(await waitFor(c.frames, (f) => f.type === "subscribed")).toEqual({ type: "subscribed", topics: ["t:p1"] });

    send(c.ws, { type: "subscribe", topics: ["zzz:1"] });
    expect(await waitFor(c.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "forbidden_topic", topics: ["zzz:1"] });
  });

  it("refuses a topic whose space permission the subscriber does not hold", async () => {
    const c = await authed(randoToken);
    send(c.ws, { type: "subscribe", topics: ["t:p1"] });
    expect(await waitFor(c.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "forbidden_topic", topics: ["t:p1"] });
    expect(c.frames.some((f) => f.type === "subscribed")).toBe(false);
  });

  it("pushes an event to the subscribers of its topic and to nobody else", async () => {
    const c = await authed(readerToken);
    send(c.ws, { type: "subscribe", topics: ["t:p1"] });
    await waitFor(c.frames, (f) => f.type === "subscribed");

    const appended = await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered", "p1")));
    const pushed = await waitFor(c.frames, (f) => f.type === "event");
    expect(pushed).toEqual({
      type: "event",
      topic: "t:p1",
      name: "patient.registered",
      seq: appended.seq,
      occurredAt: expect.any(String),
      payload: { patientId: "p1" },
    });

    await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered", "p2")));
    await sleep(1000);
    expect(c.frames.filter((f) => f.type === "event")).toHaveLength(1);
  });

  it("pushes an event appended through ANOTHER connection — fan-out reads the events table", async () => {
    const c = await authed(readerToken);
    send(c.ws, { type: "subscribe", topics: ["t:p1"] });
    await waitFor(c.frames, (f) => f.type === "subscribed");

    const appended = await withTx(dbB, (tx) => appendEvent(tx, mkInput("queue.called", "p1")));
    const pushed = await waitFor(c.frames, (f) => f.type === "event");
    expect(pushed).toMatchObject({ type: "event", topic: "t:p1", name: "queue.called", seq: appended.seq });
  });

  it("stops pushing after unsubscribe — while a second socket still receives — and answers ping with pong", async () => {
    const leaver = await authed(readerToken);
    send(leaver.ws, { type: "subscribe", topics: ["t:p1"] });
    await waitFor(leaver.frames, (f) => f.type === "subscribed");

    const stayer = await authed(readerToken);
    send(stayer.ws, { type: "subscribe", topics: ["t:p1"] });
    await waitFor(stayer.frames, (f) => f.type === "subscribed");

    send(leaver.ws, { type: "unsubscribe", topics: ["t:p1"] });
    expect(await waitFor(leaver.frames, (f) => f.type === "unsubscribed")).toEqual({ type: "unsubscribed", topics: ["t:p1"] });

    await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered", "p1")));
    await waitFor(stayer.frames, (f) => f.type === "event"); // the tail DID deliver it

    send(leaver.ws, { type: "ping" });
    expect(await waitFor(leaver.frames, (f) => f.type === "pong")).toEqual({ type: "pong" });
    expect(leaver.frames.some((f) => f.type === "event")).toBe(false);
  });

  it("registers a space that declares exactly one of permission | authorize, and refuses one that declares neither or both", () => {
    // NOT-OVER-BROAD first (§3.44): a new guard is only correct if the adjacent legitimate
    // cases still pass. Both shipped shapes must still register.
    expect(() => gateway.registerTopicSpace({ prefix: "spaceok1", permission: "patients.read" })).not.toThrow();
    expect(() => gateway.registerTopicSpace({ prefix: "spaceok2", authorize: () => true })).not.toThrow();

    expect(() => gateway.registerTopicSpace({ prefix: "spacebad1" })).toThrow(/exactly one of permission \| authorize/);
    expect(() =>
      gateway.registerTopicSpace({ prefix: "spacebad2", permission: "patients.read", authorize: () => true }),
    ).toThrow(/exactly one of permission \| authorize/);
  });

  it("L10: alerts:<userId> is subscribable only by that user, and an alert frame reaches that user and nobody else", async () => {
    const a = await authed(readerToken);
    const b = await authed(randoToken);

    // DIRECTION 1 — the subscribe REPLY is gated. Wait for whichever reply comes back, never
    // for the refusal alone: a mutant that ACCEPTS the subscribe would otherwise hang the test
    // out to its timeout and prove nothing (§2.45). This way the mutant fails an assertion.
    send(b.ws, { type: "subscribe", topics: [`alerts:${readerId}`] });
    const reply = await waitFor(b.frames, (f) => f.type === "error" || f.type === "subscribed");
    expect(reply).toEqual({ type: "error", code: "forbidden_topic", topics: [`alerts:${readerId}`] });

    // Each socket now holds its OWN topic. B's silence below is then discriminating rather
    // than vacuous — a dead socket would be silent too.
    send(a.ws, { type: "subscribe", topics: [`alerts:${readerId}`] });
    expect(await waitFor(a.frames, (f) => f.type === "subscribed")).toEqual({ type: "subscribed", topics: [`alerts:${readerId}`] });
    send(b.ws, { type: "subscribe", topics: [`alerts:${randoId}`] });
    expect(await waitFor(b.frames, (f) => f.type === "subscribed")).toEqual({ type: "subscribed", topics: [`alerts:${randoId}`] });

    // DIRECTION 2 — the FRAME path, which a refusal alone does not prove. One fanOut serves
    // every client, so by the time A's frame has arrived a leak to B would already be in B's
    // buffer.
    const forA = await withTx(db, (tx) =>
      appendEvent(
        tx,
        alertRaised.make({
          actor: { type: "system", id: "kernel-alerts" },
          payload: {
            alertId: "alert-for-a", userId: readerId, kind: "escalation",
            refType: "workflow_instance", refId: "wf-a", sourceEventId: "evt-a",
          },
        }),
      ),
    );
    const frameA = await waitFor(a.frames, (f) => f.type === "event");
    expect(frameA).toMatchObject({ type: "event", topic: `alerts:${readerId}`, name: "alert.raised", seq: forA.seq });
    expect(b.frames.filter((f) => f.type === "event")).toHaveLength(0);

    // And B's own subscription really is live: the silence was about the TOPIC, not the socket.
    await withTx(db, (tx) =>
      appendEvent(
        tx,
        alertRaised.make({
          actor: { type: "system", id: "kernel-alerts" },
          payload: {
            alertId: "alert-for-b", userId: randoId, kind: "escalation",
            refType: "workflow_instance", refId: "wf-b", sourceEventId: "evt-b",
          },
        }),
      ),
    );
    const frameB = await waitFor(b.frames, (f) => f.type === "event");
    expect(frameB).toMatchObject({ type: "event", topic: `alerts:${randoId}`, name: "alert.raised" });
    expect(a.frames.filter((f) => f.type === "event")).toHaveLength(1);
  });

  it("answers an unparseable frame with bad_message and keeps the socket open", async () => {
    const c = await authed(readerToken);
    c.ws.send("{not json");
    expect(await waitFor(c.frames, (f) => f.type === "error")).toEqual({ type: "error", code: "bad_message" });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);

    send(c.ws, { type: "ping" });
    expect(await waitFor(c.frames, (f) => f.type === "pong")).toEqual({ type: "pong" });
  });
});
