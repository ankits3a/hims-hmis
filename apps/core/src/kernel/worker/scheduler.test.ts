import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { Scheduler, type Locks } from "./scheduler";
import { registerAllJobs, type JobIntervals } from "./jobs";
import { ModuleRegistry } from "../modules/loader";
import { requireEnv } from "../config";
import * as schema from "../db/schema";
import { events, schedulerHeartbeats } from "../db/schema";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import * as dispatcherMod from "../events/dispatcher";
import * as timersMod from "../workflow/timers";
import * as tempRolesMod from "../auth/temp-roles";
import * as guardiansMod from "../../modules/patients/guardians";
import * as appointmentsMod from "../../modules/opd/appointments";
import * as dailyCloseMod from "../../modules/billing/daily-close";
import * as notifyPumpMod from "../notify/pump";
import type { Db } from "../db/client";

// D3/halt condition 7: no test in this file ever observes the advisory lock. Every test below
// injects this always-true stub instead — the lock is proven separately (spike B2, quoted in
// the report) and no sweep's correctness depends on it (every sweep is already idempotent and
// multi-process-safe on its own claim).
const stubLocks = (): Locks => ({ tryLock: async () => true, unlock: async () => {} });

/**
 * Fakes `Date` and NOTHING ELSE: `doNotFake` is jest's complete fakeable-API set MINUS `Date`,
 * verbatim from the spike report's question E and already in use in
 * `test/opd-lifecycle.e2e.test.ts`. Under it `new Date()` returns the pin while every socket,
 * every pg timer and every `setTimeout` stays REAL — which is what a test that pins an IST
 * instant AND talks to a live database needs.
 */
function pinDateOnly(now: Date): void {
  jest.useFakeTimers({
    now,
    doNotFake: [
      "hrtime", "nextTick", "performance", "queueMicrotask",
      "requestAnimationFrame", "cancelAnimationFrame",
      "requestIdleCallback", "cancelIdleCallback",
      "setImmediate", "clearImmediate",
      "setInterval", "clearInterval",
      "setTimeout", "clearTimeout",
    ],
  });
}

/**
 * A dedicated connection to the SAME per-worker test database `setupTestDb()` already
 * migrated, but with `idleTimeoutMillis: 0`. The L14 census test below fakes ALL timers
 * (`setInterval` included, to compress 25 h into a fast advance) — and `pg`'s own Pool runs
 * its idle-connection eviction on a REAL `setTimeout` internally, which jest's fake timers
 * intercept too. Advancing 25 FAKE hours in a few real milliseconds makes that eviction timer
 * think every pooled connection has sat idle for hours and close it — reproduced once as
 * dozens of leaked `Connection terminated` errors on the SHARED pool, fixed by giving this one
 * test its own pool with eviction disabled. The suite's shared `pool`/`db` (used by the other
 * two tests, which run under real timers) is left untouched.
 */
/**
 * Global Constraint 3: jest runs sweeps DIRECTLY, never through the scheduler. Both census
 * tests below call the REAL `registerAllJobs` (so the job names, the D9 cadences, the IST
 * daily semantics and the amendment-6 bus-building are all real and unmodified) but replace
 * the seven underlying sweep functions with recording stubs on their own modules — so no real
 * sweep body ever runs inside jest, only the scheduling machinery around it.
 *
 * THE SEVENTH SPY IS NOT BOOKKEEPING (Plan 10, amendment 7). `runNotifyPump` is the send path:
 * un-stubbed, a REAL pump body would run inside jest against a live per-worker database on a
 * 25-fake-hour advance, claiming rows with `FOR UPDATE SKIP LOCKED` and handing them to the
 * console adapter — which Global Constraint 8 forbids (jest drives the pump DIRECTLY, in
 * `notify/pump.test.ts`, never through the Scheduler).
 *
 * Names are pushed in invocation ORDER, and duplicates are kept: "fired exactly once across
 * five ticks" is a claim a `Set` cannot make.
 */
function spyOnTheSeven(invoked: string[]): jest.SpyInstance[] {
  return [
    jest.spyOn(dispatcherMod, "runDispatchCycle").mockImplementation(async () => {
      invoked.push("runDispatchCycle");
      return 0;
    }),
    jest.spyOn(timersMod, "runDueTimers").mockImplementation(async () => {
      invoked.push("runDueTimers");
      return 0;
    }),
    jest.spyOn(tempRolesMod, "sweepExpiredTempRoles").mockImplementation(async () => {
      invoked.push("sweepExpiredTempRoles");
      return 0;
    }),
    jest.spyOn(guardiansMod, "sweepGuardianMajority").mockImplementation(async () => {
      invoked.push("sweepGuardianMajority");
      return 0;
    }),
    jest.spyOn(appointmentsMod, "sweepAppointmentNoShows").mockImplementation(async () => {
      invoked.push("sweepAppointmentNoShows");
      return 0;
    }),
    jest.spyOn(dailyCloseMod, "runDailyClose").mockImplementation(
      (async () => {
        invoked.push("runDailyClose");
      }) as unknown as typeof dailyCloseMod.runDailyClose,
    ),
    jest.spyOn(notifyPumpMod, "runNotifyPump").mockImplementation(async () => {
      invoked.push("runNotifyPump");
      return 0;
    }),
  ];
}

const THE_SEVEN = [
  "runDispatchCycle",
  "runDueTimers",
  "sweepExpiredTempRoles",
  "sweepGuardianMajority",
  "sweepAppointmentNoShows",
  "runDailyClose",
  "runNotifyPump",
];

/**
 * The seven manifests that declare NO subscription, so both censuses can pass `{}` for the
 * handler map and stay about the CLOCK. `alertsManifest` is deliberately absent here: it is the
 * one manifest that declares a subscription, and the assertion that the WORKER'S OWN registry
 * carries it lives in `test/worker-runtime.e2e.test.ts`, against the registry
 * `createApplicationContext(WorkerModule)` actually builds. A private registry assembled inside
 * a test file — like this one — structurally cannot make that claim, which is exactly how a
 * worker that dispatched to nobody survived six tasks and two gates.
 */
function censusRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  registry.install(tariffManifest);
  registry.install(opdManifest);
  registry.install(billingManifest);
  return registry;
}

function freshWorkerDb(): { db: Db; pool: Pool; close: () => Promise<void> } {
  const baseUrl = requireEnv("TEST_DATABASE_URL");
  const workerId = process.env.JEST_WORKER_ID ?? "1";
  const parsed = new URL(baseUrl);
  const baseDbName = parsed.pathname.replace(/^\//, "");
  const workerUrl = new URL(parsed.toString());
  workerUrl.pathname = `/${baseDbName}_${workerId}`;
  const dedicatedPool = new Pool({ connectionString: workerUrl.toString(), idleTimeoutMillis: 0 });
  const db = drizzle(dedicatedPool, { schema });
  return { db, pool: dedicatedPool, close: () => dedicatedPool.end() };
}

describe("Scheduler", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    await teardown();
  });

  it("starts and stops cleanly with no jobs registered", async () => {
    const scheduler = new Scheduler(db, pool, stubLocks());
    expect(scheduler.jobs()).toEqual([]);
    scheduler.start();
    await scheduler.stop();
    expect(scheduler.leakedErrors()).toEqual([]);
  });

  // L14 — the registration census. Two tests, because there are two claims: that all seven jobs
  // are registered and reached at their cadences, and that the DAILY three are keyed on the IST
  // calendar rather than the UTC one. The first cannot make the second — see M-S2 below.
  describe("the registration census (L14)", () => {
    // THE CADENCES ARE A PARAMETER NOW, NOT THE ENVIRONMENT. This block used to override four
    // `process.env` keys and let `registerAllJobs` re-read them through `loadConfig()` — which
    // parses the WHOLE environment through a zod schema where `DATABASE_URL` is required with
    // no default. A fake-clock unit test that touches no database therefore hard-required a
    // database URL, and `main` was CI-red on exactly this test for six consecutive commits
    // (CI sets only `TEST_DATABASE_URL`; the build host has `DATABASE_URL` in `apps/core/.env`
    // because it doubles as a dev machine). The values below are the same intent as the old
    // override: with the shipped D9 defaults (2 s / 20 s / 60 s) a 25-fake-hour advance would
    // fire the three interval jobs tens of thousands of times, each doing a REAL heartbeat
    // write. The 25-hour span itself cannot shrink — the daily jobs need it to cross an IST day
    // boundary.
    const CENSUS_INTERVALS: JobIntervals = {
      workerDispatchIntervalMs: 4 * 60 * 60 * 1000,
      workerTimersIntervalMs: 6 * 60 * 60 * 1000,
      workerTempRolesIntervalMs: 9 * 60 * 60 * 1000,
      // Plan 10, amendment 7: this is a `JobIntervals` object LITERAL, so widening the `Pick` in
      // jobs.ts stops it compiling until the new key is here — which is exactly how a seventh
      // job that nothing else in this file mentions announces itself to a typechecker. Hours,
      // like its three neighbours, for the same reason: at the shipped 5 s default a
      // 25-fake-hour advance would tick the pump 18 000 times.
      workerNotifyIntervalMs: 8 * 60 * 60 * 1000,
    };

    // The SHIPPED default (D9), passed explicitly. `isDailyDue()` gates its (only) DB read
    // behind a cheap in-memory hour/minute check, so the ticker's granularity is nearly free —
    // but only nearly: guardians' window (00:05 IST) is open ~23.9 h of every day, so across a
    // 25-hour advance this grid costs ~3 000 real reads and a tighter one costs proportionally
    // more. FINDING, disclosed rather than silently changed: the old `OVERRIDE` block set
    // `WORKER_DAILY_TICK_MS: 5000` and its comment explains at length why 5 s beats 30 s for
    // `runDailyClose`'s one-IST-minute window — but the value was NEVER IN EFFECT. The
    // Scheduler takes its tick from its CONSTRUCTOR (4th argument, default 30 000) and this
    // test never passed one, so the env key it set was read by nobody. The margin the comment
    // claims (~12 ticks) has always actually been 2. Made visible here instead of quietly
    // altered: changing it is a runtime/flake trade for the plan that owns this test.
    const CENSUS_DAILY_TICK_MS = 30_000;

    // THE B1 REGRESSION GUARD, and it is the whole point of the parameter above. `loadEnv()`
    // has already run (jest's `setupFiles`), and it is idempotent by a module-level flag, so
    // deleting the key here is not undone by anything downstream: for the duration of these
    // tests this process looks EXACTLY like CI. If `registerAllJobs` ever reaches for the
    // environment again, these tests go red HERE rather than only on a machine nobody in the
    // pipeline can run.
    let savedDatabaseUrl: string | undefined;
    beforeEach(() => {
      savedDatabaseUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
    });
    afterEach(() => {
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabaseUrl;
    });

    it("invokes all seven jobs within a faked 25 hours advanced from a pinned instant", async () => {
      expect(process.env.DATABASE_URL).toBeUndefined(); // CI's environment, reproduced here
      const invoked: string[] = [];
      const spies = spyOnTheSeven(invoked);
      const registry = censusRegistry();
      const fresh = freshWorkerDb();
      jest.useFakeTimers({ now: new Date("2026-08-21T12:00:00.000Z") });
      try {
        const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks(), CENSUS_DAILY_TICK_MS);
        registerAllJobs(scheduler, fresh.db, registry, {}, CENSUS_INTERVALS);
        expect(scheduler.jobs()).toEqual(THE_SEVEN);

        scheduler.start();
        await jest.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
        await scheduler.stop();

        expect(new Set(invoked)).toEqual(new Set(THE_SEVEN));
        expect(scheduler.leakedErrors()).toEqual([]);
      } finally {
        jest.useRealTimers();
        for (const s of spies) s.mockRestore();
        await fresh.close();
      }
    });

    /**
     * M-S2's GRAVE — the mutant that survived the census above, and the reason this second test
     * exists at all. M-S2 computes `istDayIndex`/`istHourMinute` from the UTC calendar instead
     * of `+IST_OFFSET_MS`. The 25-hour census cannot see it: it asserts only the SET of six
     * names, and all three daily jobs fire within any 25-hour span under EITHER calendar.
     *
     * The Assertion Book's own stated discriminating input does not separate them either — it
     * names the tick window containing `2026-08-21T18:35:00Z` and predicts the UTC mutant fires
     * guardians ~5.5 h late, but `isDailyDue`'s `pastInstant` is a `>=`, so at 18:35 UTC the
     * mutant sees hour 18 > 0 and fires guardians in that very window too. Both predictions
     * were hand-walks; both were wrong (rule 21's whole argument).
     *
     * WHAT ACTUALLY DISCRIMINATES IS THE DAY INDEX AGAINST AN EXISTING HEARTBEAT, and it needs
     * an instant where the two calendars disagree about which day it is:
     *
     *   now          2026-08-21T19:00:00Z  =  IST 2026-08-22 00:30  ·  UTC day Aug 21
     *   last_ok_at   2026-08-21T10:00:00Z  =  IST 2026-08-21 15:30  ·  UTC day Aug 21
     *
     * `pastInstant` is true for BOTH implementations (IST hour 0 ≥ 00:05 by the minute; UTC
     * hour 19 > 0), so the guard that decides is `istDay(last_ok_at) < istDay(now)`:
     *   · SHIPPED — Aug 21 IST < Aug 22 IST → DUE. The job ran this afternoon, IST has since
     *     rolled over, today's 00:05 run is owed. Fires.
     *   · M-S2    — Aug 21 UTC < Aug 21 UTC is FALSE → not due. Never fires.
     * The other two daily jobs (23:55 / 23:59 IST) are correctly NOT due at 00:30 IST, and the
     * three interval jobs are hours apart so a sub-second window cannot reach them.
     *
     * `Date` — AND ONLY `Date` — IS FAKED HERE, on the `doNotFake` list the spike measured
     * (question E) and `opd-lifecycle.e2e.test.ts` already uses. The census above compresses 25
     * hours with `advanceTimersByTimeAsync`, which cannot be done here: `isDailyDue` awaits a
     * REAL database round-trip, fake time advances in no real time at all, and the first draft
     * of this test therefore called `stop()` while every tick was still suspended mid-query —
     * whereupon the shutdown latch (correctly) bailed them all out and the job never ran. Real
     * timers, a pinned `Date`, and a bounded poll for the invocation: the poll is a sequencing
     * wait, not a timing assertion (Global Constraint 10), and when the job never comes it
     * exhausts its iterations and FAILS, which is exactly what a mutant needs it to do.
     */
    it("a daily job that last succeeded earlier the same UTC day but a PREVIOUS IST day is due (M-S2)", async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      const NOW = new Date("2026-08-21T19:00:00.000Z"); // IST 2026-08-22 00:30
      const LAST_OK = new Date("2026-08-21T10:00:00.000Z"); // IST 2026-08-21 15:30 — same UTC day
      const invoked: string[] = [];
      const spies = spyOnTheSeven(invoked);
      const registry = censusRegistry();
      const fresh = freshWorkerDb();
      try {
        await fresh.db.insert(schedulerHeartbeats).values({
          job: "sweepGuardianMajority",
          lastStartedAt: LAST_OK,
          lastOkAt: LAST_OK,
        });

        pinDateOnly(NOW);
        try {
          const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks(), 10);
          registerAllJobs(scheduler, fresh.db, registry, {}, CENSUS_INTERVALS);
          scheduler.start();
          for (let i = 0; i < 400 && !invoked.includes("sweepGuardianMajority"); i += 1) {
            await new Promise((r) => setTimeout(r, 5)); // REAL setTimeout — only Date is faked
          }
          await scheduler.stop();
        } finally {
          jest.useRealTimers();
        }

        // EXACTLY ONCE across every tick that fitted, not once per tick: the run writes its own
        // `last_ok_at` at the pinned instant, whose IST day now EQUALS today's, so the same
        // guard that made it due immediately makes it not-due again.
        expect(invoked.filter((n) => n === "sweepGuardianMajority")).toEqual(["sweepGuardianMajority"]);
        // And the ones whose IST instant has NOT passed at 00:30 IST stayed put.
        expect(invoked).not.toContain("sweepAppointmentNoShows");
        expect(invoked).not.toContain("runDailyClose");

        // The heartbeat moved to the pinned instant — the run went through the real machinery
        // (lock → heartbeat → run → last_ok_at), it was not merely counted.
        const [hb] = await fresh.db
          .select()
          .from(schedulerHeartbeats)
          .where(eq(schedulerHeartbeats.job, "sweepGuardianMajority"));
        expect(hb?.lastOkAt?.getTime()).toBe(NOW.getTime());
      } finally {
        for (const s of spies) s.mockRestore();
        await fresh.close();
      }
    });
  });

  // Flag 9 — stop() must await the in-flight run, and no rejection may leak. A deliberately
  // slow stub job (gated on a manually-controlled promise, not a real sleep) so the test
  // controls exactly when the run completes relative to stop().
  // D8/Global Constraint 11: sweep.failed is appended when a run THROWS, and there is NO
  // per-tick event on an ordinary successful run — the heartbeat row is the UPDATE. A stub
  // job that throws on its first invocation and succeeds afterwards proves both halves in one
  // test: exactly one sweep.failed row, never re-appended by the later successful ticks.
  it("appends sweep.failed when a job throws, and nothing per successful tick", async () => {
    const scheduler = new Scheduler(db, pool, stubLocks());
    let attempts = 0;
    scheduler.register({
      name: "throwing-stub",
      every: 5,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stub failure for sweep.failed");
      },
    });

    scheduler.start();
    try {
      const deadline = Date.now() + 2000;
      while (attempts < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(attempts).toBeGreaterThanOrEqual(3); // at least one failing tick, then successful ones
    } finally {
      await scheduler.stop();
    }

    const failed = await db.select().from(events).where(eq(events.name, "sweep.failed"));
    expect(failed).toHaveLength(1); // the one throw — NOT one per tick
    const payload = failed[0]!.payload as { job: string; error: string; durationMs: number };
    expect(payload.job).toBe("throwing-stub");
    expect(payload.error).toBe("stub failure for sweep.failed");
    expect(typeof payload.durationMs).toBe("number");

    const [hb] = await db
      .select()
      .from(schedulerHeartbeats)
      .where(eq(schedulerHeartbeats.job, "throwing-stub"));
    expect(hb?.lastOkAt).not.toBeNull(); // a later successful tick cleared the error state
    expect(hb?.lastError).toBeNull();
  });

  it("stop() awaits an in-flight run before resolving, and leaks no rejection", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduler = new Scheduler(db, pool, stubLocks());
    scheduler.register({
      name: "slow-stub",
      every: 5,
      run: async () => {
        order.push("start");
        await gate;
        order.push("end");
      },
    });

    try {
      scheduler.start();

      // Real timers here — no jest.useFakeTimers active in this test. Poll for the tick to
      // have actually started; this is a sequencing wait, not a timing assertion (Global
      // Constraint 10 forbids gating on wall-clock mean/median, not on "has X happened yet").
      const deadline = Date.now() + 2000;
      while (!order.includes("start") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(order).toContain("start");

      let stopped = false;
      const stopPromise = scheduler.stop().then(() => {
        stopped = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(false); // the run is still gated — stop() must not have resolved yet

      order.push("release");
      release();
      await stopPromise;

      expect(stopped).toBe(true);
      expect(order).toEqual(["start", "release", "end"]);
      expect(scheduler.leakedErrors()).toEqual([]);
    } finally {
      await scheduler.stop();
    }
  });

  /**
   * Flag ⑨'s OTHER HALF. `stop()` awaiting an in-flight run (asserted above) is NOT the same
   * guarantee as no job STARTING afterwards, and only the first was ever true.
   *
   * `dailyTick()` awaits a heartbeat READ inside `isDailyDue()`, and NOTHING holds that tick:
   * `runTick()` is what records a job's `inFlight`, and this tick has not reached it. So
   * `stop()` sees nothing in flight and RESOLVES — after which `worker.ts` closes the context
   * and `WorkerModule.onModuleDestroy` ends the pool — and only THEN does the read settle and
   * start a sweep, against a pool that is already gone.
   *
   * The gate is on that one READ. `gatedDb` delegates every other call — the heartbeat write,
   * the sweep, `withTx` — to the real database, and intercepts exactly the
   * `select().from().where()` chain `isDailyDue` uses. Nothing here sleeps or polls the wall
   * clock: the test chooses the interleaving rather than racing it.
   */
  it("no job STARTS after stop() resolves — a daily tick suspended on its heartbeat read finds the latch", async () => {
    let readEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => { readEntered = resolve; });
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });

    type SelectChain = { from: (t: unknown) => { where: (p: unknown) => Promise<unknown> } };
    const realSelect = db.select.bind(db) as unknown as (f: unknown) => SelectChain;
    const gatedDb = {
      select: (fields: unknown) => ({
        from: (table: unknown) => ({
          where: async (predicate: unknown) => {
            readEntered();
            await gate;
            return realSelect(fields).from(table).where(predicate);
          },
        }),
      }),
      insert: db.insert.bind(db),
      update: db.update.bind(db),
      transaction: db.transaction.bind(db),
    } as unknown as Db;

    const started: string[] = [];
    // `dailyIst: "00:00"` is past at every instant of every day, so the job's only remaining
    // gate is the heartbeat read this test suspends — and there is no heartbeat row, so an
    // un-latched Scheduler runs it the moment the read settles.
    const scheduler = new Scheduler(gatedDb, pool, stubLocks(), 5);
    scheduler.register({
      name: "latch-stub",
      dailyIst: "00:00",
      run: async () => { started.push("latch-stub"); },
    });

    try {
      scheduler.start();
      await entered; // a daily tick is now suspended INSIDE isDailyDue's read

      let stopResolved = false;
      await scheduler.stop().then(() => { stopResolved = true; });
      expect(stopResolved).toBe(true); // nothing was in flight, so stop() is already done

      releaseRead();
      // GIVE AN UN-LATCHED SCHEDULER EVERY CHANCE TO START THE JOB. The resumed tick still has
      // two REAL round-trips ahead of it — the heartbeat read it was suspended on, then the
      // heartbeat write — so a couple of microtask turns is not a wait, it is a head start for
      // the absence. (Measured: the first draft of this test yielded twice and the un-latched
      // mutant SURVIVED, passing for no reason at all.) This bounded poll exits the instant the
      // job starts, so against the mutant it costs milliseconds; against the shipped Scheduler
      // it spends its whole budget proving the job never comes.
      for (let i = 0; i < 200 && started.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(started).toEqual([]); // the sweep never started, though its tick had already begun
      expect(scheduler.leakedErrors()).toEqual([]);
    } finally {
      releaseRead();
      await scheduler.stop();
    }
  });
});
