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
import * as partitionsMod from "./partitions";
import * as retentionMod from "../retention/sweep";
import * as interfacesMod from "../ops/interfaces";
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
 * A HANDLE TO THE REAL EVENT LOOP, captured at module load while the timers are still real.
 * The L14 census below fakes EVERY timer — it has to, compressing hours of fake clock is the
 * whole technique — which leaves it no way to yield actual wall-clock time to the REAL database
 * round-trips its own ticks are waiting on: `setTimeout`, `setImmediate` and `queueMicrotask`
 * all belong to the fake clock by then. This reference does not.
 */
const realSetTimeout = setTimeout;

/**
 * Yields `turns` REAL event-loop turns — timers phase, then poll phase, `turns` times over, at
 * ≥1 ms apiece because node clamps a 0 ms timeout to 1 ms. The poll phase is the point: it is
 * where `pg`'s socket data actually arrives, so an outstanding `isDailyDue` read — and the
 * heartbeat writes of whatever run it starts — can finish while fake time stands still.
 *
 * A FIXED COUNT rather than a real-time budget, deliberately: on a starved container each turn
 * takes LONGER, so the same count buys proportionally more real time exactly where more of it is
 * needed. It is a sequencing wait, not a timing assertion (Global Constraint 10) — it asserts
 * nothing and cannot fail; a census that settles and still comes back short fails on its SET.
 */
async function settleRealTurns(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      realSetTimeout(() => { resolve(); }, 0);
    });
  }
}

/**
 * Yields REAL event-loop turns UNTIL `done()` is true, or until `maxTurns` have passed. Returns
 * whether the condition was met.
 *
 * THIS REPLACES A FIXED TURN COUNT AS THE INSTRUMENT, AND THE REASON IS MEASURED. R0-2 settled a
 * fixed 50 turns at each instant and argued that "on a starved container each turn takes LONGER,
 * so the same count buys proportionally more real time". THAT IS FALSE when the thing being
 * waited on is ONE database round-trip rather than accumulated event-loop work: 50 turns of an
 * otherwise idle loop is ~50 ms whatever the load, while a heartbeat write on a contended CI
 * container can take several times that. CI proved it TWICE - `e81219d` and `de668ad` both came
 * back with `runNotifyPump` and `sweepExpiredTempRoles` missing, the two LAST jobs to fire, and
 * the census took 37.6 s there against 2.9 s on the build host. The 2026-08-23 remediation that
 * walked every interval instant with a 50-turn settle did NOT fix it; it went green on CI once,
 * which is what a 25%-ish failure rate looks like when you read one run as confirmation.
 *
 * Waiting on the CONDITION is self-scaling: it costs one turn when the work is already done and
 * as many as the machine needs when it is not. It cannot hang the suite (`maxTurns` bounds it)
 * and it cannot make a broken census pass, because the assertion that follows is unchanged.
 */
/**
 * THE BOUND MUST SIT BELOW jest's `testTimeout`, AND MINE DID NOT — corrected 2026-08-23 after CI
 * showed the cost. `jest.config.cjs` sets `testTimeout: 15000`, node clamps a 0 ms timeout to 1 ms,
 * so a 20 000-turn bound is ~20 s and can only ever be reached by blowing the test timeout first.
 * That defeated this helper's whole point: `settleUntil` is written to RETURN on a bound hit so the
 * set-equality assertion below runs and fails NAMING THE MISSING JOBS, which is a far better
 * failure than a bare "Exceeded timeout of 15000 ms". Commit `e31538b` on CI is the specimen — the
 * census reported a timeout rather than a diagnosis.
 *
 * 5 000 turns is ~5 s, leaving ~10 s of the budget for the walk itself. It is generous for what is
 * actually being waited on (a handful of real heartbeat round-trips), and the honest limit is
 * stated rather than papered over: **on a container so starved that the WALK alone exceeds 15 s,
 * nothing in this test can produce a clean failure** — the timeout is then a fact about the
 * harness, not about the census, and no bound here changes that.
 *
 * THE "~10 s FOR THE WALK" HALF OF THAT PARAGRAPH IS NO LONGER THE ARITHMETIC — Plan 11d, D11,
 * 2026-08-24. The bound was right; the BUDGET was not. `jest.config.cjs`'s `testTimeout: 15000`
 * is one workspace-wide number, and the census is the single test in 144 suites that drives real
 * database round-trips through a 9 h 5 min fake-clock walk. So it now carries a budget of its own
 * as jest's THIRD ARGUMENT to `it(...)` — `CENSUS_TIMEOUT_MS` below — and `jest.config.cjs` is
 * deliberately untouched: raising the global would stretch every genuine hang across all 144
 * suites from 15 s to two minutes and buy nothing anywhere else.
 *
 * WHERE 120 000 COMES FROM — measured, not chosen (build host, isolated, at `58e0e61`):
 *   · the census walk costs 3 082 ms on this box, and CI has measured 37.6 s for the same walk
 *     against this box's 2.9 s — a 12.97x ratio, so today's walk projects to ~40 s on CI;
 *   · one settle turn costs 1.11 ms — a scratch copy with the bound forced to 20 000 turns took
 *     25 348 ms against the 3 082 ms walk, so the extra 20 000 turns bought 22 266 ms — which
 *     puts a FULL 5 000-turn bound hit at ~5.6 s;
 *   · walk plus full bound hit is therefore ~46 s at CI's measured worst, and 120 000 ms clears
 *     that by 2.6x. CI has to get 2.6x slower than the slowest this census has ever been
 *     measured before the budget is the binding constraint again.
 *
 * WHAT A BOUND HIT NOW PRODUCES, which is the entire point of the number. Measured BOTH ways
 * against a scratch copy that reproduces `e31538b`: its census is made UNSATISFIABLE (two of the
 * ten jobs never recorded, the same two CI lost) and its bound forced to 20 000 turns so the poll
 * actually runs to it.
 *   · under the OLD 15 s budget — `thrown: "Exceeded timeout of 15000 ms for a test."`, pointing
 *     at the `it(...)` line and naming NOTHING. The `console.warn` further down does eventually
 *     print, but only after teardown, next to a `Jest environment ... torn down` ReferenceError;
 *   · under this budget — `settleUntil` returns on the bound hit, the set assertion runs, and the
 *     failure is `expect(received).toEqual(expected)` listing `"runNotifyPump"` and
 *     `"sweepExpiredTempRoles"` by name. A diagnosis instead of a stopwatch.
 * A 1-turn bound, which is how the Assertion Book first wrote this mutant, discriminates nothing
 * and in fact fails nothing: on a healthy box every job has already been recorded by the time
 * `settleUntil` is reached, so `done()` is true on turn 0 and the bound is never touched.
 *
 * The honest limit above survives all of this, restated at the new number: on a container so
 * starved that the WALK ALONE exceeds 120 s, the timeout is still a fact about the harness and
 * not about the census, and no budget here changes that either.
 */
const SETTLE_BOUND_TURNS = 5_000;
const CENSUS_TIMEOUT_MS = 120_000;

async function settleUntil(done: () => boolean, maxTurns = SETTLE_BOUND_TURNS): Promise<boolean> {
  for (let i = 0; i < maxTurns; i += 1) {
    if (done()) return true;
    await new Promise<void>((resolve) => {
      realSetTimeout(() => { resolve(); }, 0);
    });
  }
  return done();
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
 * the TEN underlying sweep functions with recording stubs on their own modules — so no real
 * sweep body ever runs inside jest, only the scheduling machinery around it.
 *
 * THE SEVENTH SPY IS NOT BOOKKEEPING (Plan 10, amendment 7). `runNotifyPump` is the send path:
 * un-stubbed, a REAL pump body would run inside jest against a live per-worker database on a
 * 25-fake-hour advance, claiming rows with `FOR UPDATE SKIP LOCKED` and handing them to the
 * console adapter — which Global Constraint 8 forbids (jest drives the pump DIRECTLY, in
 * `notify/pump.test.ts`, never through the Scheduler).
 *
 * THE EIGHTH (Plan 11a D5) IS DDL. Un-stubbed, `createEventPartitions` would issue
 * `create table … partition of events` against the per-worker database from inside a fake-clock
 * unit test — idempotent, but still schema mutation driven by the Scheduler rather than by the
 * test. It is driven DIRECTLY in `partitions.test.ts`, which is where its behaviour is asserted.
 *
 * THE NINTH (Plan 11a D6) IS DDL THAT DESTROYS DATA. `retentionSweep` DROPS whole `events`
 * partitions; the shipped registration passes `enabled: intervals.retentionEnabled`, which these
 * censuses leave at the inert default, so un-stubbed it would do nothing today — and that is
 * exactly the reason to stub it rather than to rely on it. The census is about the CLOCK, and a
 * job whose harmlessness here depends on one config key being false is not a job to leave live
 * inside a 25-fake-hour advance. Its behaviour is asserted DIRECTLY in `retention/sweep.test.ts`.
 *
 * Names are pushed in invocation ORDER, and duplicates are kept: "fired exactly once across
 * five ticks" is a claim a `Set` cannot make.
 */
function spyOnTheTen(invoked: string[]): jest.SpyInstance[] {
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
    jest.spyOn(partitionsMod, "createEventPartitions").mockImplementation(async () => {
      invoked.push("createEventPartitions");
      return [];
    }),
    jest.spyOn(retentionMod, "retentionSweep").mockImplementation(async () => {
      invoked.push("retentionSweep");
      return {
        dropped: [], blocked: [], notificationsDeleted: 0,
        idempotencyDeleted: 0, deliveriesDeleted: 0, deadLettersDeleted: 0,
        searchAuditDeleted: 0, // Plan 11h T5 — the sweep's result gained a leg
      };
    }),
    // THE TENTH (Plan 11c D6) IS THE ONLY SPY HERE THAT GUARDS AN EVENT APPEND. Un-stubbed,
    // `sweepInterfaceHeartbeats` would read the `interfaces` registry and, for any row a previous
    // test left `up` and stale, flip it and append `interface.down` — inside a fake-clock unit
    // test that is about the CLOCK. Its behaviour is asserted DIRECTLY in `kernel/ops/interfaces.test.ts`.
    jest.spyOn(interfacesMod, "sweepInterfaceHeartbeats").mockImplementation(async () => {
      invoked.push("sweepInterfaceHeartbeats");
      return [];
    }),
  ];
}

const THE_TEN = [
  "runDispatchCycle",
  "runDueTimers",
  "sweepExpiredTempRoles",
  "sweepGuardianMajority",
  "sweepAppointmentNoShows",
  "runDailyClose",
  "runNotifyPump",
  "createEventPartitions",
  "retentionSweep",
  "sweepInterfaceHeartbeats",
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

  // L14 — the registration census. Two tests, because there are two claims: that all ten jobs
  // are registered and reached at their cadences, and that the DAILY four are keyed on the IST
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
      // Plan 11a R0-2, and it is deliberately NOT hours. This one is a WINDOW, not a cadence: it
      // gates which `sending` rows a cycle recovers and it never causes an invocation, so the
      // 25-fake-hour reasoning that sets its four neighbours does not apply and copying it here
      // would be cargo cult. The SHIPPED DEFAULT, passed explicitly — these two census tests spy
      // the eight jobs out, so the value is inert for them; `jobs.test.ts` is where a DISTINCT
      // value is asserted to actually reach the pump (Book R2).
      notifyStuckAfterMs: 300_000,
      // Plan 11a T5, and the same reasoning one more time: these three are not cadences either.
      // THE SHIPPED DEFAULTS, PASSED EXPLICITLY — `retentionEnabled: false` above all, because
      // these two census tests spy the ninth job out and a census must never be the thing that
      // decides whether a sweep that drops partitions is live. Where a NON-default value is
      // asserted to reach the sweep is `retention/sweep.test.ts` (Book V9, Global Constraint 14).
      retentionEnabled: false,
      retentionEventsMonths: 120,
      notifyRetainDays: 180,
      // PLAN 11c D6 — THE TENTH JOB, and this value is BINDING rather than arbitrary (the spike's
      // question-A measurement, written into D6). It is a real `every` cadence, so unlike its five
      // predecessors above it must actually FIRE inside this census: `CENSUS_SPAN_MS` below is
      // 9 h 05 m, so a cadence at or above that span would never be reached and the set-equality
      // assertion would go red naming this job. 7 h sits inside the span and, like its four
      // interval neighbours, is hours rather than the shipped 60 s default — at 60 s a nine-hour
      // advance would tick this sweep ~545 times, each doing a REAL heartbeat write.
      workerInterfaceSweepIntervalMs: 7 * 60 * 60 * 1000,
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

    // ── Plan 11c R0-2 / D12: THE ADVANCE IS WALKED, NOT JUMPED ────────────────────────────
    //
    // Gate report §3a measured this test red on ~16% of CI runs — and red TWICE CONSECUTIVELY,
    // so one re-run was never a clearing procedure — always with an empty or partial `invoked`
    // set. §7.9 refused the obvious fix, a finer `CENSUS_DAILY_TICK_MS`, and it stays refused:
    // `runDailyClose`'s window is ONE IST minute, the 30 s grid above samples it exactly twice
    // (the finding beside that constant), and a 5 s grid would multiply the REAL database reads
    // sixfold on the container that is already too slow to keep up.
    //
    // THE FAILURE IS A QUEUE, NOT A SAMPLE. A single `advanceTimersByTimeAsync(25 h)` fires
    // ~3 000 daily ticks back to back with one event-loop turn between them, and every tick
    // awaits a real heartbeat read for each daily job whose IST instant has already passed —
    // three of the five nearly always, since guardians' 00:05 window alone is open ~23.9 h of
    // every day. That is ~9 000 queries queued against a ten-client pool while fake time races
    // to the end of the sweep. `stop()` then latches `stopped` with the reads issued INSIDE the
    // one-minute window still in that queue, and `dailyTick`'s post-await re-check
    // (`scheduler.ts:193-199`) drops the runs they would have started. That re-check is
    // CORRECT — it is what stops a job starting against a pool the caller is about to end, and
    // the test at the bottom of this file exists to keep it. A fast box drains the queue before
    // `stop()`; a starved one does not, and the set comes back short.
    //
    // So the advance is WALKED: hour-sized chunks, each followed by real event-loop turns, keep
    // the queue shallow instead of letting 9 000 reads pile up behind fake time; and each of the
    // five daily instants is ARRIVED AT — one second past it, so the tick that lands ON the
    // instant has fired — then crossed in tick-sized advances, every one of them settled. Every
    // `isDailyDue` an open window issues has resolved, and every run it starts has reached its
    // spy, before the clock leaves that window and long before `stop()` is called.
    //
    // AND THE SPAN SHRANK, 25 h → 9 h 05 m, which is the runtime half of §7.9's trade: the five
    // daily instants all fall within 7 h 45 m of the pin (below) and the longest cadence in
    // `CENSUS_INTERVALS` is `workerTempRolesIntervalMs` at 9 h, so 9 h 05 m is the entire span
    // this census has ever needed. The old 25 h was sized to "cross an IST day boundary" without
    // computing where the boundary actually is (18:30 UTC, 6 h 30 m in). ~1 090 daily ticks
    // instead of ~3 000. **A FUTURE `every` JOB CENSUSED AT A CADENCE LONGER THAN THIS SPAN WILL
    // NEVER FIRE** — and the set-equality assertion below then goes red naming it, which is the
    // only reason a bare constant is safe here rather than a computed maximum.

    const MINUTE_MS = 60_000;
    const HOUR_MS = 60 * MINUTE_MS;

    /** 2026-08-21T12:00:00Z is 17:30 IST on 2026-08-21 — the pin every offset below counts from. */
    const CENSUS_PIN = new Date("2026-08-21T12:00:00.000Z");

    /**
     * The five daily instants as offsets from the pin, ASCENDING — one per `dailyIst`
     * registration in `jobs.ts:20-31`, and this list is a transcription of those constants, not
     * a fixture. Three of them (00:05, 00:15, 01:15 IST) are already `pastInstant` at 17:30 IST
     * with no heartbeat, so they fire on the very first tick and fire AGAIN once IST rolls over
     * at 18:30 UTC; the walk visits them regardless, so the list stays a transcription of the
     * registrations rather than a record of which ones today's pin happens to make interesting.
     */
    const DAILY_INSTANTS_MS = [
      6 * HOUR_MS + 25 * MINUTE_MS, // 18:25Z = 23:55 IST 08-21 · sweepAppointmentNoShows (5-min window)
      6 * HOUR_MS + 29 * MINUTE_MS, // 18:29Z = 23:59 IST 08-21 · runDailyClose (ONE-minute window — the flake)
      6 * HOUR_MS + 35 * MINUTE_MS, // 18:35Z = 00:05 IST 08-22 · sweepGuardianMajority
      6 * HOUR_MS + 45 * MINUTE_MS, // 18:45Z = 00:15 IST 08-22 · createEventPartitions
      7 * HOUR_MS + 45 * MINUTE_MS, // 19:45Z = 01:15 IST 08-22 · retentionSweep
    ];

    /** Total fake time advanced: past the last daily instant AND past the 9 h longest cadence. */
    const CENSUS_SPAN_MS = 9 * HOUR_MS + 5 * MINUTE_MS;
    /** The largest single advance taken anywhere — the queue-depth bound. */
    const WALK_CHUNK_MS = HOUR_MS;
    /** Tick-sized advances taken at each instant after arriving just past it. */
    const TICKS_PER_INSTANT = 3;
    /** Real turns after an ordinary walk chunk: queue control, nothing is due. */
    const WALK_SETTLE_TURNS = 10;
    /** Real turns at an instant, where a window is open and a run must reach its spy. */
    const INSTANT_SETTLE_TURNS = 50;

    /**
     * Every `every(ms)` cadence in `CENSUS_INTERVALS` that can actually CAUSE an invocation.
     * Only the five real cadences: `notifyStuckAfterMs` is a WINDOW and the three retention keys
     * are values, so none of them fires anything and walking to one would stop where nothing
     * happens.
     */
    const INTERVAL_CADENCES_MS = [
      CENSUS_INTERVALS.workerDispatchIntervalMs,
      CENSUS_INTERVALS.workerTimersIntervalMs,
      CENSUS_INTERVALS.workerTempRolesIntervalMs,
      CENSUS_INTERVALS.workerNotifyIntervalMs,
      CENSUS_INTERVALS.workerInterfaceSweepIntervalMs,
    ];

    /**
     * EVERY instant at which ANY job fires, ascending and de-duplicated — the five daily instants
     * AND every interval multiple inside the span. Each one is walked to and settled, which is
     * what the daily instants already got and the interval jobs did not.
     *
     * THE SPAN REDUCTION MADE THIS NECESSARY AND R0-2 MISSED IT. Across the old 25 h sweep the
     * 8 h pump fired three times and the 9 h temp-roles sweep twice, so a firing whose real
     * heartbeat write had not settled before `stop()` was covered by a later one. Inside
     * 9 h 05 m each fires EXACTLY ONCE — both in the tail walk, which settled only
     * `WALK_SETTLE_TURNS`, and temp-roles fires five fake minutes before the end. The redundancy
     * that used to hide the unsettled write is gone.
     *
     * CI PROVED IT, and nothing on the build host could: commit `e81219d` came back red with
     * `runNotifyPump` and `sweepExpiredTempRoles` missing from the invoked set and every other
     * job present. That is the same queue-starvation mechanism R0-2 fixed for daily jobs, moved
     * to the interval jobs at the tail.
     */
    const FIRE_INSTANTS: { atMs: number; daily: boolean }[] = (() => {
      const byMs = new Map<number, boolean>();
      for (const ms of DAILY_INSTANTS_MS) byMs.set(ms, true);
      for (const cadence of INTERVAL_CADENCES_MS) {
        for (let t = cadence; t <= CENSUS_SPAN_MS; t += cadence) {
          if (!byMs.has(t)) byMs.set(t, false);
        }
      }
      return [...byMs.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([atMs, daily]) => ({ atMs, daily }));
    })();

    it("invokes all ten jobs across a stepwise advance from a pinned instant", async () => {
      expect(process.env.DATABASE_URL).toBeUndefined(); // CI's environment, reproduced here
      const invoked: string[] = [];
      const spies = spyOnTheTen(invoked);
      const registry = censusRegistry();
      const fresh = freshWorkerDb();
      jest.useFakeTimers({ now: CENSUS_PIN });
      try {
        const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks(), CENSUS_DAILY_TICK_MS);
        registerAllJobs(scheduler, fresh.db, registry, {}, CENSUS_INTERVALS);
        expect(scheduler.jobs()).toEqual(THE_TEN);

        // Fake milliseconds advanced so far, measured from the pin. The walk only moves forward,
        // so a target already behind the cursor is a no-op rather than a rewind.
        let cursorMs = 0;
        const walkTo = async (targetMs: number): Promise<void> => {
          while (cursorMs < targetMs) {
            const step = Math.min(WALK_CHUNK_MS, targetMs - cursorMs);
            await jest.advanceTimersByTimeAsync(step);
            cursorMs += step;
            await settleRealTurns(WALK_SETTLE_TURNS);
          }
        };

        scheduler.start();
        for (const fire of FIRE_INSTANTS) {
          await walkTo(fire.atMs + 1_000); // one second PAST it: the tick landing on the instant has fired
          await settleRealTurns(INSTANT_SETTLE_TURNS);
          // Only a DAILY instant needs its due window crossed tick by tick; an interval job has
          // already fired by the time we are one second past its multiple.
          if (fire.daily) {
            for (let i = 0; i < TICKS_PER_INSTANT; i += 1) {
              await jest.advanceTimersByTimeAsync(CENSUS_DAILY_TICK_MS);
              cursorMs += CENSUS_DAILY_TICK_MS;
              await settleRealTurns(INSTANT_SETTLE_TURNS);
            }
          }
        }
        await walkTo(CENSUS_SPAN_MS); // the tail: nothing daily is left, the interval cadences need it

        // WAIT FOR THE CONDITION, NOT FOR A COUNT. Every job's timer has fired under fake time by
        // now; what remains is REAL async work - a heartbeat write per invocation - and how long
        // that takes is a property of the machine, not of this test. `stop()` latches `stopped`,
        // and the post-await re-check then correctly drops any run whose read had not come back,
        // so calling it too early is exactly how this census came back short on CI twice while
        // being green on the build host every single time.
        const settled = await settleUntil(() => new Set(invoked).size >= THE_TEN.length);
        await scheduler.stop();
        // Reported, not asserted: on a bound hit the assertion below fails on its own SET and
        // names the missing jobs, which is a better failure message than a bare timeout.
        if (!settled) {
          // eslint-disable-next-line no-console
          console.warn(
            `census: settleUntil hit its bound with ${new Set(invoked).size}/${THE_TEN.length} invoked`,
          );
        }

        expect(new Set(invoked)).toEqual(new Set(THE_TEN));
        expect(scheduler.leakedErrors()).toEqual([]);
      } finally {
        jest.useRealTimers();
        for (const s of spies) s.mockRestore();
        await fresh.close();
      }
    }, CENSUS_TIMEOUT_MS);

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
      const spies = spyOnTheTen(invoked);
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
        // And the ones whose IST instant has NOT passed at 00:30 IST stayed put. Plan 11a's
        // eighth job is deliberately not among them: `createEventPartitions` is 00:15 IST, so at
        // the pinned 00:30 it is legitimately due and firing — which is why this absence list
        // names the two 23:5x jobs and not "everything except guardians". The NINTH is 01:15 IST
        // and so is legitimately NOT due at 00:30 — it is left out of this list all the same,
        // because this test's claim is about the two jobs whose UTC/IST reading differs, and a
        // longer absence list would quietly turn it into a second census.
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
