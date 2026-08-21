import { Test } from "@nestjs/testing";
import { NestFactory } from "@nestjs/core";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { WebSocket } from "ws";
import { eq, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { WorkerModule } from "../src/kernel/worker/worker.module";
import { CONFIG, DB, DB_POOL, MODULE_REGISTRY } from "../src/kernel/tokens";
import { Scheduler, pgLocks } from "../src/kernel/worker/scheduler";
import { buildSubscriptionBus, registerAllJobs } from "../src/kernel/worker/jobs";
import { ALERTS_CONSUMER, alertsConsumer } from "../src/kernel/alerts/consumer";
import { alertsManifest } from "../src/kernel/alerts/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { runDueTimers } from "../src/kernel/workflow/timers";
import { runDispatchCycle } from "../src/kernel/events/dispatcher";
import { startInstance } from "../src/kernel/workflow/instances";
import { activateDefinition, createDraft } from "../src/kernel/workflow/definitions";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { withTx } from "../src/kernel/db/client";
import { setupTestDb, truncateAll } from "./helpers/db";
import { alerts, events, workflowTimers } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";
import type { SubscriptionBus } from "../src/kernel/events/subscriptions";

/**
 * THE RUNTIME LOOP, END TO END (Plan 08.5 T6 / Assertion Book L17). Three separate proofs:
 *
 *  (a) the worker's BOOT SHAPE — `createApplicationContext(WorkerModule)` boots and its Scheduler
 *      knows exactly six jobs, and the context closes with NO unhandled rejection;
 *  (b) the LOOP — an SLA breach becomes an escalation, becomes a dispatched event, becomes an
 *      alert row, becomes a `GET /alerts` body, becomes a WebSocket frame on ONE human's topic
 *      and on nobody else's;
 *  (c) the DRAIN — a backlog that accumulated while the worker never ran resolves when the sweeps
 *      are finally driven, and a second pass over the same instant fires nothing further.
 *
 * NO SCHEDULER AND NO SLEEPS ANYWHERE (Global Constraint 3, and Constraint 10's corollary that
 * nothing here gates on wall-clock time). Every sweep is called DIRECTLY with an EXPLICIT `now`,
 * which is what makes a "45 minutes later" assertion take milliseconds and never flake; the only
 * waits in this file are frame-arrival predicates with deadlines, which FAIL when the push never
 * comes — a sleep would turn the same miss into a silent pass.
 *
 * The worker context and the HTTP app are two independent Nest graphs over the SAME per-worker
 * database, which is exactly the production topology (D1: two processes, one build).
 */

const T6_SUPERVISOR_ROLE = "t6_front_office_supervisor";
const WAITING_SLA_MINUTES = 45;
const LADDER_RUNG_0_MINUTES = 15;

/**
 * An OPD-SHAPED fixture definition, not the shipped OPD one: `waiting` carries an ACTIVE 45-minute
 * SLA with a one-rung ladder at +15 minutes to a role a single fixture user holds. Class C so it
 * activates with zero approvals (the drafter still may not activate their own draft — SoD), which
 * keeps this suite's arrange about the runtime loop rather than about definition governance.
 */
const T6_DEF = {
  key: "t6_opd_wait",
  title: "T6 OPD wait (fixture)",
  changeClass: "C",
  initialState: "waiting",
  states: [
    {
      name: "waiting",
      sla: {
        minutes: WAITING_SLA_MINUTES,
        alerting: "active",
        escalation: [{ afterMinutes: LADDER_RUNG_0_MINUTES, toRole: T6_SUPERVISOR_ROLE }],
      },
    },
    { name: "seen", terminal: true },
  ],
  transitions: [{ from: "waiting", to: "seen", roles: ["doctor"] }],
};

/** The six jobs `registerAllJobs` must register, in registration order — the census (L17/flag ①). */
const THE_SIX = [
  "runDispatchCycle",
  "runDueTimers",
  "sweepExpiredTempRoles",
  "sweepGuardianMajority",
  "sweepAppointmentNoShows",
  "runDailyClose",
];

type Frame = { type: string } & Record<string, unknown>;

/**
 * One socket's frames, asserted by PREDICATE with a deadline (the `opd-lifecycle` precedent).
 * `expect` REJECTS when the frame never arrives, so a push that does not happen fails the test.
 * A matched frame is CONSUMED. `unconsumed` is the ABSENCE half: it reads what is still buffered,
 * and it is only meaningful behind a barrier — see the `ping`/`pong` barrier in the WS leg.
 */
class FrameStream {
  private readonly buffered: Frame[] = [];
  private waiter: { match: (f: Frame) => boolean; deliver: (f: Frame) => void } | null = null;

  push(frame: Frame): void {
    const waiting = this.waiter;
    if (waiting !== null && waiting.match(frame)) {
      this.waiter = null;
      waiting.deliver(frame);
      return;
    }
    this.buffered.push(frame);
  }

  expect(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const buffered = this.buffered.findIndex(match);
    if (buffered >= 0) return Promise.resolve(this.buffered.splice(buffered, 1)[0]!);
    return new Promise<Frame>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`no frame matched within ${timeoutMs} ms; buffered: ${JSON.stringify(this.buffered)}`));
      }, timeoutMs);
      this.waiter = { match, deliver: (frame) => { clearTimeout(deadline); resolve(frame); } };
    });
  }

  unconsumed(match: (f: Frame) => boolean): Frame[] {
    return this.buffered.filter(match);
  }
}

const isEvent = (name: string, topic?: string) => (f: Frame): boolean =>
  f.type === "event" && f.name === name && (topic === undefined || f.topic === topic);

describe("worker runtime e2e (boot shape + the loop + the drain)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let port: number;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  let supervisor: { id: string; token: string };
  let other: { id: string; token: string };
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    // setupTestDb FIRST: it creates and MIGRATES this worker's database, and AppModule's realtime
    // tail reads `select max(seq) from events` at boot. Then the per-worker DATABASE_URL — which
    // is also what `WorkerModule`'s own `loadConfig()` picks up when a test boots the worker
    // context — and only then the module compile.
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    // listen(0), not init(): a real ws client needs a real port.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => { await app.close(); await teardown(); });

  afterEach(() => {
    while (sockets.length > 0) sockets.pop()!.terminate();
  });

  const mk = async (username: string, roleKeys: string[] = []): Promise<{ id: string; token: string }> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    for (const key of roleKeys) {
      await createRole(db, key, key);
      await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
    }
    const { token } = await createSession(db, cfg, id);
    return { id, token };
  };

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    supervisor = await mk("t6sup", [T6_SUPERVISOR_ROLE]);
    other = await mk("t6other");
    const drafter = await mk("t6drafter");
    const act = await mk("t6activator");
    // Class C activates with zero approvals, but the drafter still may not activate their own
    // draft (SoD) — two users, as the go-live runbook does it.
    const drafterActor: Actor = { type: "user", id: drafter.id };
    const activator: Actor = { type: "user", id: act.id };
    const { definitionId } = await createDraft(db, drafterActor, T6_DEF);
    await activateDefinition(db, activator, definitionId);
  });

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];
  const http = () => request(app.getHttpServer());

  /**
   * The bus the worker's dispatch job builds, built the same way it builds it: walk a registry's
   * DECLARED subscriptions and look each `consumer` key up in the handler map
   * (`buildSubscriptionBus`, the §4 seam). A local registry is used rather than the worker
   * context's, because `worker.module.ts` does not install `alertsManifest` yet — that one edit
   * is the plan's amendment 6, it lands on two of T2's files, and both are frozen to this task.
   * Building the bus explicitly is what the T4 gate's inbox finding prescribes, and it proves the
   * declaration→handler join rather than assuming it.
   */
  const alertsBus = (): SubscriptionBus => {
    const registry = new ModuleRegistry();
    registry.install(alertsManifest);
    return buildSubscriptionBus(registry, { [ALERTS_CONSUMER]: alertsConsumer(db) });
  };

  /** Starts one instance of the fixture definition and returns its id plus its own T. */
  const startWaiting = async (): Promise<{ instanceId: string; T: Date }> => {
    const { instanceId } = await withTx(db, (tx) =>
      startInstance(tx, T6_DEF.key, { type: "t6_visit", id: newId() }),
    );
    // `startInstance` stamps `stateEnteredAt` from its own clock and schedules the SLA timer
    // 45 minutes later. T is READ BACK from that row rather than guessed, so every `now` this
    // suite passes downstream is anchored on the writer's own instant (§3.41: a pinned date must
    // reach the writer — here the writer's date reaches the assertions instead).
    const timers = await db.select().from(workflowTimers).where(eq(workflowTimers.instanceId, instanceId));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.kind).toBe("sla");
    return { instanceId, T: new Date(timers[0]!.dueAt.getTime() - WAITING_SLA_MINUTES * 60_000) };
  };

  const at = (T: Date, minutes: number): Date => new Date(T.getTime() + minutes * 60_000);

  const eventsNamed = async (name: string): Promise<{ payload: unknown; eventId: string }[]> =>
    db.select({ payload: events.payload, eventId: events.eventId }).from(events).where(eq(events.name, name));

  /** An authenticated socket. The subscribe REPLY is returned rather than asserted, so the refused leg can read it. */
  const openSocket = async (token: string, topics: string[]): Promise<{ ws: WebSocket; stream: FrameStream }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const stream = new FrameStream();
    ws.on("message", (raw) => { stream.push(JSON.parse(String(raw)) as Frame); });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    ws.send(JSON.stringify({ type: "auth", token }));
    await stream.expect((f) => f.type === "authed");
    ws.send(JSON.stringify({ type: "subscribe", topics }));
    return { ws, stream };
  };

  // ——————————————————————————————— (a) the boot proof ———————————————————————————————

  it("(a) boots the worker context, and its Scheduler names EXACTLY the six jobs", async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    try {
      const workerDb = ctx.get<Db>(DB);
      const pool = ctx.get<Pool>(DB_POOL);
      const config = ctx.get<AppConfig>(CONFIG);
      const registry = ctx.get<ModuleRegistry>(MODULE_REGISTRY);

      // The graph is LIVE, not merely constructed: a sweep runs through the context's own DB
      // provider. Called DIRECTLY, never through the scheduler (Global Constraint 3).
      expect(await runDueTimers(workerDb, new Date())).toBe(0);

      const scheduler = new Scheduler(workerDb, pool, pgLocks(pool), config.workerDailyTickMs);
      registerAllJobs(scheduler, workerDb, registry, { [ALERTS_CONSUMER]: alertsConsumer(workerDb) });

      // THE CENSUS. `toEqual` on the whole array is the point: it is exactly these six, in
      // registration order — not "at least", not "these among others".
      expect(scheduler.jobs()).toEqual(THE_SIX);
      // The scheduler was never started, so nothing was scheduled and nothing needs stopping.
      expect(scheduler.leakedErrors()).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("(a) closes the worker context with NO unhandled rejection, and the close is real", async () => {
    // §3.30: `boots` and `closes cleanly` are TWO claims, so they are two assertions in two tests.
    //
    // THE MECHANISM IS SOURCE CAPTURE, NOT A PROCESS LISTENER (§2.17). `jest-environment-node`
    // hands this file a SANDBOXED `process` while node emits `unhandledRejection` on the real
    // one, so a listener installed here observes nothing while looking installed — a probe in an
    // earlier plan logged 0 deliveries with `listenerCount === 1`. The capture is therefore a
    // `.catch` attached where a leak would ORIGINATE, the same choice `Scheduler.leakedErrors()`
    // makes one layer down.
    const leaked: unknown[] = [];
    const sink = <T>(p: Promise<T>): Promise<T> => {
      p.catch((e: unknown) => { leaked.push(e); });
      return p;
    };

    // The sink is proven to record BEFORE anything is concluded from its emptiness (§3.14: an
    // absence assertion over a mechanism that cannot fire is not evidence).
    const probe = new Error("sink probe");
    sink(Promise.reject(probe));
    await Promise.resolve();
    expect(leaked).toEqual([probe]);
    leaked.length = 0;

    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    const workerDb = ctx.get<Db>(DB);
    const pool = ctx.get<Pool>(DB_POOL);
    const config = ctx.get<AppConfig>(CONFIG);
    const registry = ctx.get<ModuleRegistry>(MODULE_REGISTRY);
    const scheduler = new Scheduler(workerDb, pool, pgLocks(pool), config.workerDailyTickMs);
    registerAllJobs(scheduler, workerDb, registry, { [ALERTS_CONSUMER]: alertsConsumer(workerDb) });
    // Real work through the context's own pool first, so the close below is closing a pool that
    // has actually been used rather than an untouched one.
    await runDueTimers(workerDb, new Date());

    // THE SHIPPED SHUTDOWN SHAPE, verbatim from `worker.ts`'s SIGTERM handler: a `void`-ed async
    // IIFE that stops the scheduler and then closes the context. §3.48 is exactly this shape — a
    // rejection inside one has nobody holding it, and jest bills it to whichever file happens to
    // be running. The OUTCOME is captured rather than awaited-as-rejects (§2.45: a hang recorded
    // as a timeout is a non-kill wearing a kill's clothes).
    const shutdown = sink((async (): Promise<void> => {
      await scheduler.stop();
      await ctx.close();
    })());
    expect(await shutdown.then(() => "resolved" as const, () => "rejected" as const)).toBe("resolved");
    expect(leaked).toEqual([]);
    expect(scheduler.leakedErrors()).toEqual([]);

    // THE CLOSE WAS REAL — the fixture proof for the absence above. If `onModuleDestroy` had not
    // ended the pool, "no rejection was recorded" would be true of a context that never shut down.
    const afterClose = await (async (): Promise<string> => {
      try {
        await workerDb.execute(sql`select 1 as one`);
        return "resolved";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(afterClose).toMatch(/pool after calling end on the pool/);

    // And a SECOND close is still clean: the `poolClosed` guard means a double shutdown — two
    // SIGTERMs, or Nest's own hooks racing the handler — resolves instead of rejecting.
    const again = sink(ctx.close());
    expect(await again.then(() => "resolved" as const, () => "rejected" as const)).toBe("resolved");
    expect(leaked).toEqual([]);
  });

  // ——————————————————————————————— (b) the loop ———————————————————————————————

  it("(b) L17: breach → escalation → dispatch → alert row → GET /alerts → a WS frame on ONE human's topic", async () => {
    const { instanceId, T } = await startWaiting();

    // The sockets open BEFORE anything fires, so the frame under test is a live push and not a
    // replay. B holds its OWN working subscription as well as the foreign one it is refused, so
    // silence on the foreign topic later is discriminating rather than a dead socket.
    const a = await openSocket(supervisor.token, [`alerts:${supervisor.id}`]);
    expect((await a.stream.expect((f) => f.type === "subscribed")).topics).toEqual([`alerts:${supervisor.id}`]);

    const b = await openSocket(other.token, [`alerts:${supervisor.id}`, `alerts:${other.id}`]);
    // ONE subscribe message, BOTH directions: the foreign topic is refused and B's own is
    // accepted. The second half is the NOT-OVER-BROAD companion (§3.44) — no mutant in this set
    // catches an `authorize` that refuses everybody.
    expect((await b.stream.expect((f) => f.type === "subscribed")).topics).toEqual([`alerts:${other.id}`]);
    const refusal = await b.stream.expect((f) => f.type === "error");
    expect(refusal.code).toBe("forbidden_topic");
    expect(refusal.topics).toEqual([`alerts:${supervisor.id}`]);

    // ——— the breach. 46 minutes in, the 45-minute SLA timer is due.
    expect(await runDueTimers(db, at(T, 46))).toBe(1);
    const breached = await eventsNamed("sla.breached");
    expect(breached).toHaveLength(1);
    expect(breached[0]!.payload).toMatchObject({
      instanceId, defKey: T6_DEF.key, state: "waiting", slaMinutes: WAITING_SLA_MINUTES, alerting: "active",
    });
    // `sla.breached` is RECORD-ONLY by design (spec §10.3): the ladder's rung 0 is the first
    // human-facing moment, so nothing has escalated and nothing has been alerted yet.
    expect(await eventsNamed("escalation.triggered")).toHaveLength(0);
    expect(await db.select().from(alerts)).toEqual([]);

    // ——— the escalation. The ladder anchors on the SLA's dueAt (T+45), so rung 0 is due at T+60.
    expect(await runDueTimers(db, at(T, 61))).toBe(1);
    const escalated = await eventsNamed("escalation.triggered");
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.payload).toMatchObject({
      instanceId,
      state: "waiting",
      rung: 0,
      role: T6_SUPERVISOR_ROLE,
      resolvedUserIds: [supervisor.id], // resolved from the role, not from the fixture's variable
      fallback: false,
      fallbackExhausted: false,
    });

    // ——— the dispatch. One event, one consumer, one delivery.
    const bus = alertsBus();
    expect(await runDispatchCycle(db, bus, { now: at(T, 61) })).toBe(1);

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(supervisor.id);
    expect(rows[0]!.refId).toBe(instanceId);
    expect(rows[0]!.sourceEventId).toBe(escalated[0]!.eventId);
    expect(rows[0]!.readAt).toBeNull();

    // ——— the human's own read surface, over HTTP, as the supervisor.
    const list = await http().get("/alerts").set(...auth(supervisor.token)).expect(200);
    expect(list.body.unreadCount).toBe(1);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(rows[0]!.id);
    expect(list.body.items[0].readAt).toBeNull();
    expect(list.body.items[0].refId).toBe(instanceId);
    // And it is HERS ALONE — the other authenticated user's list is empty over the same route.
    const otherList = await http().get("/alerts").set(...auth(other.token)).expect(200);
    expect(otherList.body.items).toEqual([]);
    expect(otherList.body.unreadCount).toBe(0);

    // ——— the push. The API process's tail fans `alert.raised` to `alerts:<userId>`.
    const frame = await a.stream.expect(isEvent("alert.raised", `alerts:${supervisor.id}`));
    expect(frame.payload).toMatchObject({
      alertId: rows[0]!.id, userId: supervisor.id, kind: "escalation", refId: instanceId,
    });

    // ——— AND IT REACHED NOBODY ELSE. The frame demonstrably EXISTED and was fanned (asserted one
    // line up), so B's silence is silence that could have been noise (§3.14). The barrier is a
    // ping/pong round-trip, not a sleep: WebSocket delivery is ordered per connection, so any
    // frame the gateway had already written to B's socket arrives BEFORE the pong.
    b.ws.send(JSON.stringify({ type: "ping" }));
    await b.stream.expect((f) => f.type === "pong");
    expect(b.stream.unconsumed(isEvent("alert.raised"))).toEqual([]);
  }, 30_000);

  // ——————————————————————————————— (c) the drain ———————————————————————————————

  it("(c) the drain: a backlog built while the worker NEVER ran resolves, and a second pass at the same instant fires ZERO", async () => {
    // This is the test README.md's "When the worker is down, nothing blocks" section cites by
    // file name. Global Constraint 1: nothing a human does blocks on the worker; while it is down
    // timers, escalations and deliveries simply ACCUMULATE, and they all drain on restart.
    const started = [await startWaiting(), await startWaiting(), await startWaiting()];
    const T = started[0]!.T;

    // NOTHING HAS RUN. No Scheduler exists in this test, so there is nothing to stop — the
    // backlog is three unfired SLA timers, exactly as a stopped worker would leave them.
    const pending = await db.select().from(workflowTimers).where(isNull(workflowTimers.firedAt));
    expect(pending).toHaveLength(3);

    // Restart, conceptually: one pass over the backlog at a single instant well past every due
    // time. Each pass fires the timers its OWN opening scan saw, so the rung-0 escalation timers
    // that pass 1 schedules are drained by pass 2 — at the SAME `now`, with no clock advance.
    expect(await runDueTimers(db, at(T, 62))).toBe(3);
    expect(await eventsNamed("sla.breached")).toHaveLength(3);
    expect(await runDueTimers(db, at(T, 62))).toBe(3);
    expect(await eventsNamed("escalation.triggered")).toHaveLength(3);

    // THE DRAIN IS COMPLETE: a second pass over the same instant fires ZERO. The claims are what
    // hold — every timer was claimed by a conditional `UPDATE … RETURNING`, so a re-run cannot
    // re-fire one, and the ladder has no further rung to schedule.
    expect(await runDueTimers(db, at(T, 62))).toBe(0);
    expect(await eventsNamed("sla.breached")).toHaveLength(3);
    expect(await eventsNamed("escalation.triggered")).toHaveLength(3);
    expect(await db.select().from(workflowTimers).where(isNull(workflowTimers.firedAt))).toEqual([]);

    // And the deliveries drain the same way: the backlog of three escalations becomes three
    // alerts for the one supervisor, and a second cycle over the same window delivers nothing
    // further (the per-(consumer, seq) claim, D4) and raises no duplicate alert.
    const bus = alertsBus();
    expect(await runDispatchCycle(db, bus, { now: at(T, 62) })).toBe(3);
    expect(await runDispatchCycle(db, bus, { now: at(T, 62) })).toBe(0);
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.userId === supervisor.id)).toBe(true);
    expect(new Set(rows.map((r) => r.refId))).toEqual(new Set(started.map((s) => s.instanceId)));
    expect(await eventsNamed("alert.raised")).toHaveLength(3);
  }, 30_000);
});
