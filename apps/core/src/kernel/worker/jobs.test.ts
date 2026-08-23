import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { buildSubscriptionBus, registerAllJobs, type JobIntervals } from "./jobs";
import { Scheduler, type Locks } from "./scheduler";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { requireEnv } from "../config";
import * as schema from "../db/schema";
import { notifications, patients, events } from "../db/schema";
import * as interfacesMod from "../ops/interfaces";
import { ModuleRegistry } from "../modules/loader";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import type { Handler, SubscriptionBus } from "../events/subscriptions";
import type { ModuleManifest } from "../modules/manifest";
import type { JobSpec } from "./scheduler";
import type { Db } from "../db/client";

// Flattens a bus into (consumer, event) pairs for comparison. A consumer may in principle
// carry more than one event name (SubscriptionBus.on adds to the same entry), so this is a
// proper flatMap, not an assumption of one event per consumer.
function busPairs(bus: SubscriptionBus): [string, string][] {
  return bus.consumers().flatMap((c) => c.events.map((e): [string, string] => [c.consumer, e]));
}

const noopHandler: Handler = async () => {};

describe("buildSubscriptionBus (amendment 6 seam)", () => {
  // Leg (a) — THE DISCRIMINATING LEG. Spike question D measured that all seven shipped
  // manifests declare `subscriptions: []` today, so an assertion against the real registry
  // alone is `[] === []` and proves nothing (EXECUTION-LESSONS 3.14's class). A synthetic
  // manifest with a matching stub handler gives the bus something non-empty to get wrong.
  it("wires exactly the registry's declared subscriptions to their handlers", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic",
      title: "Synthetic",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    const bus = buildSubscriptionBus(registry, { "synthetic.consumer": noopHandler });

    expect(busPairs(bus)).toEqual([["synthetic.consumer", "synthetic.happened"]]);
  });

  it("throws — a boot error, not a silent skip — when a declared subscription has no matching handler", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic2",
      title: "Synthetic2",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    expect(() => buildSubscriptionBus(registry, {})).toThrow(/synthetic\.consumer/);
  });

  // Leg (b) — the honest empty pin, AND A CORRECTED CLAIM ABOUT ITSELF. This leg used to say
  // it would become load-bearing "once amendment 6's alertsManifest joins this same registry".
  // IT NEVER COULD: "this same registry" is a literal list inside this test file, so nothing
  // that happens to the WORKER's registry can ever change what this assertion sees. That is
  // precisely how a worker that installed no alerts manifest — and therefore dispatched
  // `escalation.triggered` to nobody — passed six tasks and two gates with a green suite:
  // `jobs.test.ts`, `alerts/consumer.test.ts` and `worker-runtime.e2e.test.ts` each built a
  // PRIVATE ModuleRegistry, so no assertion anywhere read the one production builds.
  //
  // The assertion that CAN see it boots the worker context and reads `MODULE_REGISTRY` out of
  // it: `test/worker-runtime.e2e.test.ts`, "(a) the worker's OWN registry". This leg keeps its
  // real job — pinning that the seven non-alerts manifests declare nothing, so leg (a)'s
  // synthetic manifest is what gives the seam its teeth here (EXECUTION-LESSONS 3.14: shipping
  // only this leg would be an assertion that starts and ends at `[] === []`).
  it("the real registry's union equals the real bus — EMPTY for the seven non-alerts manifests (all declare subscriptions: [])", () => {
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(workflowManifest);
    registry.install(approvalsManifest);
    registry.install(patientsManifest);
    registry.install(tariffManifest);
    registry.install(opdManifest);
    registry.install(billingManifest);

    const bus = buildSubscriptionBus(registry, {});

    expect(busPairs(bus)).toEqual([]);
  });
});

/**
 * ASSERTION BOOK R2 (Plan 11a Phase 0, R0-2) — `NOTIFY_STUCK_AFTER_MS` REACHES THE PUMP, and it
 * reaches it THROUGH THE PRODUCTION REGISTRATION.
 *
 * The key was dead for a whole plan: `config.ts:62` parsed it, `config.ts:101` exposed
 * `cfg.notifyStuckAfterMs`, and nothing read it, because the registration said
 * `runNotifyPump(db, { now })` and the pump fell back to its own `DEFAULT_STUCK_AFTER_MS`
 * (plan-10 gate report §7.2). What made that survivable for so long is the shape of the test
 * that looked like protection: `config.test.ts:38-43` asserts these keys PARSE. Parsing was
 * never in doubt. So this test asserts the only thing that was: that the value TAKES EFFECT.
 *
 * The discriminator is arithmetic, not a wait. The row is two minutes stale. At the registered
 * `notifyStuckAfterMs: 1000` the cutoff is `now - 1 s`, the row is older than it, and the D2
 * sweep flips it to `undeliverable(stuck_sending)`. At the module fallback of 300 000 the cutoff
 * is `now - 5 min`, the row is NEWER than it, and it stays `sending` — which is exactly what the
 * gate report executed against production's call shape. Time is a parameter here (Global
 * Constraint 9/10): nothing below sleeps or measures a clock.
 */
describe("registerAllJobs threads NOTIFY_STUCK_AFTER_MS to the pump (Book R2)", () => {
  const NOON = new Date("2026-08-21T06:00:00.000Z");
  const PATIENT = "01HR02JOBSPATIENT00000001";
  const STUCK_ROW = "01HR02JOBSSTUCKROW0000001";

  /**
   * `Scheduler` is a class with `private` members, so it is compared NOMINALLY and a structural
   * recorder cannot be passed to `registerAllJobs` without this cast (AGENT-RULES §2.61). The
   * cast buys the thing the real class cannot give: `Scheduler.jobs()` returns `string[]`, so a
   * real instance hands back job NAMES and never the `run` closure this assertion has to invoke.
   * `registerAllJobs` itself is the REAL production function — that is what is under test.
   */
  function recordingScheduler(specs: JobSpec[]): Scheduler {
    return {
      register(spec: JobSpec): void {
        specs.push(spec);
      },
    } as unknown as Scheduler;
  }

  /** The three D9 cadences plus the pump's, with the stuck window set to a DISTINCT value. */
  const INTERVALS: JobIntervals = {
    workerDispatchIntervalMs: 2000,
    workerTimersIntervalMs: 20_000,
    workerTempRolesIntervalMs: 60_000,
    workerNotifyIntervalMs: 5000,
    // 1 000, chosen so it cannot be confused with the pump's own 300 000 fallback: if this test
    // passes, no fallback could have produced the result.
    notifyStuckAfterMs: 1000,
    // Plan 11a T5, and this literal is here BECAUSE the type event fired: widening the
    // `JobIntervals` Pick with the three retention keys stopped this object compiling
    // (`TS2739 ... is missing the following properties from type 'JobIntervals':
    // retentionEnabled, retentionEventsMonths, notifyRetainDays`), exactly as the Pick's own
    // comment in jobs.ts promises it will. THE SHIPPED DEFAULTS, PASSED EXPLICITLY: this block is
    // about the pump, `retentionEnabled: false` keeps the ninth job inert here, and where a
    // NON-default retention value is asserted to reach the sweep is
    // `kernel/retention/sweep.test.ts` (Book V9, Global Constraint 14).
    retentionEnabled: false,
    retentionEventsMonths: 120,
    notifyRetainDays: 180,
    // Plan 11c D6, and the type event fired one more time: widening the `Pick` with
    // `workerInterfaceSweepIntervalMs` stopped THIS literal compiling until it carried the key.
    // THE SHIPPED DEFAULT, PASSED EXPLICITLY — this block is about the pump; where a DISTINCT
    // value is asserted to reach the tenth job is the V12 block at the bottom of this file.
    workerInterfaceSweepIntervalMs: 60_000,
  };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      phone: "9876500001", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(notifications).values({
      id: STUCK_ROW, audience: "patient", patientId: PATIENT, templateKey: "patient_welcome",
      params: { uhid: "HMS-00000001-5" }, dedupeKey: "n:r2:stuck:1", occurredAt: NOON,
      expiresAt: new Date(NOON.getTime() + 24 * 3600_000), status: "sending",
      updatedAt: new Date(NOON.getTime() - 2 * 60_000), // claimed two minutes ago
    });
  });

  const registeredPump = (): JobSpec => {
    const specs: JobSpec[] = [];
    registerAllJobs(recordingScheduler(specs), db, new ModuleRegistry(), {}, INTERVALS);
    const pump = specs.find((s) => s.name === "runNotifyPump");
    if (pump === undefined) throw new Error("registerAllJobs registered no runNotifyPump job");
    return pump;
  };

  const stuckRow = async (): Promise<typeof notifications.$inferSelect> =>
    (await db.select().from(notifications).where(eq(notifications.id, STUCK_ROW)))[0]!;

  it("a 'sending' row two minutes stale flips under the job's OWN run(now) — the operator's key takes effect", async () => {
    expect((await stuckRow()).status).toBe("sending"); // the precondition, not an assumption

    await registeredPump().run(NOON);

    const row = await stuckRow();
    // Reachable ONLY through the registered value: at the 300 000 fallback this row is younger
    // than the cutoff and is left alone. This single assertion is what the dead key failed.
    expect(row.status).toBe("undeliverable");
    expect(row.sentAt).toBeNull();

    const failed = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.name, "notification.failed"));
    expect(failed).toHaveLength(1);
    expect((failed[0]!.payload as { reason: string }).reason).toBe("stuck_sending");
  });

  it("registers the pump on its own cadence — the widened Pick did not disturb the seventh job", () => {
    const pump = registeredPump();
    expect(pump).toEqual(expect.objectContaining({ name: "runNotifyPump", every: 5000 }));
  });
});

/**
 * ASSERTION BOOK V12 (Plan 11c D6, Global Constraint 10) — `WORKER_INTERFACE_SWEEP_INTERVAL_MS`
 * REACHES THE TENTH JOB, and it reaches it THROUGH THE PRODUCTION REGISTRATION.
 *
 * This is the `NOTIFY_STUCK_AFTER_MS` scar one surface over (Book R2 above). `config.test.ts`
 * asserting that a key PARSES is not protection — that is precisely the shape under which a key
 * parsed, was exposed on `AppConfig`, and reached nothing at all for a whole plan. So the claim
 * here is not "the value parses" and not even "the value is stored": it is that the SCHEDULER
 * ACTUALLY INVOKES THE SWEEP ON THE CADENCE THE OPERATOR SET.
 *
 * THE DISCRIMINATOR IS ARITHMETIC, NOT A WAIT (GC8/GC10 — nothing below sleeps or measures a
 * clock). The registered cadence is 7 000 ms and the whole advance is 28 000 fake ms — LESS than
 * the shipped 60 000 default. A registration that hardcoded the default, or that reached for the
 * environment instead of its parameter, fires ZERO times inside that window; the shipped one fires
 * on every 7 000 ms boundary in it. No fallback could produce a non-empty `invoked`.
 *
 * The four OTHER interval cadences are set to nine hours and the daily ticker to nine hours too,
 * so this window belongs to the tenth job alone — the census in `scheduler.test.ts` is where all
 * ten firing together is asserted, and a second copy of that here would only add flake surface.
 * `sweepInterfaceHeartbeats` itself is SPIED OUT (Global Constraint 3: jest runs sweeps directly,
 * never through the scheduler; its behaviour is asserted in `kernel/ops/interfaces.test.ts`).
 */
describe("registerAllJobs threads WORKER_INTERFACE_SWEEP_INTERVAL_MS to the tenth job (Book V12, GC10)", () => {
  /** 7 000 ms — distinct from the shipped 60 000 default and smaller than the advance below. */
  const INTERFACE_SWEEP_EVERY_MS = 7_000;
  const NINE_HOURS_MS = 9 * 60 * 60 * 1000;
  /** 4 x 7 000 = 28 000 fake ms — deliberately SHORTER than the 60 000 default. */
  const ADVANCE_STEPS = 4;

  const V12_PIN = new Date("2026-08-21T12:00:00.000Z");

  /** D3/halt condition 7: no test here observes the advisory lock — the census's own stub. */
  const stubLocks = (): Locks => ({ tryLock: async () => true, unlock: async () => {} });

  /**
   * A dedicated pool on the SAME per-worker database `setupTestDb()` already migrated, with
   * `idleTimeoutMillis: 0`. This test fakes ALL timers, and `pg`'s Pool runs its idle-connection
   * eviction on a real `setTimeout` that the fake clock would intercept — advancing 28 fake
   * seconds in a few real milliseconds makes that eviction close live connections. Verbatim the
   * reason `scheduler.test.ts`'s census carries the same helper.
   */
  function freshWorkerDb(): { db: Db; pool: Pool; close: () => Promise<void> } {
    const baseUrl = requireEnv("TEST_DATABASE_URL");
    const workerId = process.env.JEST_WORKER_ID ?? "1";
    const parsed = new URL(baseUrl);
    const baseDbName = parsed.pathname.replace(/^\//, "");
    const workerUrl = new URL(parsed.toString());
    workerUrl.pathname = `/${baseDbName}_${workerId}`;
    const dedicatedPool = new Pool({ connectionString: workerUrl.toString(), idleTimeoutMillis: 0 });
    return { db: drizzle(dedicatedPool, { schema }), pool: dedicatedPool, close: () => dedicatedPool.end() };
  }

  /** A handle to the REAL event loop, captured while the timers in this file are still real. */
  const realSetTimeout = setTimeout;

  /**
   * Yields `turns` REAL event-loop turns so the heartbeat writes each tick issues can actually
   * finish while fake time stands still. It asserts nothing and cannot fail — a sequencing wait,
   * not a timing assertion (GC8/GC10).
   */
  async function settleRealTurns(turns: number): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
      await new Promise<void>((resolve) => {
        realSetTimeout(() => { resolve(); }, 0);
      });
    }
  }

  /** Every other cadence pushed out of the window; only the tenth job can fire in 28 seconds. */
  const V12_INTERVALS: JobIntervals = {
    workerDispatchIntervalMs: NINE_HOURS_MS,
    workerTimersIntervalMs: NINE_HOURS_MS,
    workerTempRolesIntervalMs: NINE_HOURS_MS,
    workerNotifyIntervalMs: NINE_HOURS_MS,
    notifyStuckAfterMs: 300_000,
    retentionEnabled: false,
    retentionEventsMonths: 120,
    notifyRetainDays: 180,
    workerInterfaceSweepIntervalMs: INTERFACE_SWEEP_EVERY_MS,
  };

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("registers the sweep as the TENTH job, on the cadence it was handed — not on the 60 000 default", () => {
    const specs: JobSpec[] = [];
    registerAllJobs(
      { register: (spec: JobSpec): void => { specs.push(spec); } } as unknown as Scheduler,
      db,
      new ModuleRegistry(),
      {},
      V12_INTERVALS,
    );

    expect(specs).toHaveLength(10);
    expect(specs[9]).toEqual(
      expect.objectContaining({ name: "sweepInterfaceHeartbeats", every: INTERFACE_SWEEP_EVERY_MS }),
    );
  });

  it("V12: the REAL Scheduler invokes it inside a window shorter than the default — the operator's key takes effect", async () => {
    const invoked: string[] = [];
    const spy = jest
      .spyOn(interfacesMod, "sweepInterfaceHeartbeats")
      .mockImplementation(async () => {
        invoked.push("sweepInterfaceHeartbeats");
        return [];
      });
    const fresh = freshWorkerDb();
    jest.useFakeTimers({ now: V12_PIN });
    try {
      // The daily ticker is pushed out of the window too: this test is about ONE cadence.
      const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks(), NINE_HOURS_MS);
      registerAllJobs(scheduler, fresh.db, new ModuleRegistry(), {}, V12_INTERVALS);
      expect(scheduler.jobs()).toContain("sweepInterfaceHeartbeats");

      scheduler.start();
      for (let i = 0; i < ADVANCE_STEPS; i += 1) {
        await jest.advanceTimersByTimeAsync(INTERFACE_SWEEP_EVERY_MS);
        await settleRealTurns(50);
      }
      await scheduler.stop();

      // At the 60 000 default this window contains NO tick at all, so a single invocation is only
      // reachable through the registered value. The bound is `>= 1` rather than `=== 4`
      // deliberately: a starved container may not drain every tick's real database round-trips,
      // and this assertion is about WHICH CADENCE fired, not about how many times it did.
      expect(invoked.length).toBeGreaterThanOrEqual(1);
      expect(new Set(invoked)).toEqual(new Set(["sweepInterfaceHeartbeats"]));
      expect(scheduler.leakedErrors()).toEqual([]);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
      await fresh.close();
    }
  });
});
