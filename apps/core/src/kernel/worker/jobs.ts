import type { Db } from "../db/client";
import type { ModuleRegistry } from "../modules/loader";
import type { Handler } from "../events/subscriptions";
import { SubscriptionBus } from "../events/subscriptions";
import { runDispatchCycle } from "../events/dispatcher";
import { runDueTimers } from "../workflow/timers";
import { sweepExpiredTempRoles } from "../auth/temp-roles";
import { sweepGuardianMajority } from "../../modules/patients/guardians";
import { sweepAppointmentNoShows } from "../../modules/opd/appointments";
import { runDailyClose } from "../../modules/billing/daily-close";
import { runNotifyPump } from "../notify/pump";
import { createEventPartitions } from "./partitions";
import { retentionSweep } from "../retention/sweep";
import { sweepInterfaceHeartbeats } from "../ops/interfaces";
import type { AppConfig } from "../config";
import type { Scheduler } from "./scheduler";

// D9/step 2: the daily jobs' clock instants are CODE CONSTANTS beside their registration, not
// deployment knobs — design decisions from the roadmap (2026-08-12 owner decision Q4), not
// config that an operator would tune.
const GUARDIAN_MAJORITY_IST = "00:05";
const APPOINTMENT_NO_SHOWS_IST = "23:55";
const DAILY_CLOSE_IST = "23:59";
// Plan 11a D5: ten past midnight IST, ten minutes after the IST month has actually rolled over —
// so the run that first needs a new month is the one that creates it, and it creates it before
// anything else on the daily grid touches `events`.
const CREATE_EVENT_PARTITIONS_IST = "00:15";
// Plan 11a D6: an hour after the new month's partitions exist and well inside the quiet window —
// a partition DROP takes ACCESS EXCLUSIVE on `events`, which is not a lock to take during a
// clinic. Like its neighbours it is a code constant, not a deployment knob: WHAT retention does
// is configurable (and off by default), WHEN it runs is a design decision.
const RETENTION_SWEEP_IST = "01:15";

/**
 * Amendment 6 (the plan's own resolution to the T2/T4 wave-order contradiction; spike
 * question D measured that this seam is not merely unbound but EMPTY — all seven shipped
 * manifests declare `subscriptions: []`, and nothing anywhere joins a declaration to a
 * handler). This IS that join: walk every installed manifest's declared subscriptions and
 * look each `consumer` key up in `consumers`. A declared subscription with NO matching
 * handler is a BOOT ERROR, never a silent skip — that is what makes the seam load-bearing in
 * BOTH directions (a module that declares a subscription it cannot serve must fail loudly,
 * not silently drop deliveries).
 *
 * THE SEAM IS NOW FILLED: `worker.module.ts` installs `alertsManifest` and `worker.ts` passes
 * `{ [ALERTS_CONSUMER]: alertsConsumer(db) }`. Those two edits are ONE edit and must never be
 * split — installing the manifest without passing the handler makes the `throw` below fire at
 * worker boot, by design. The reverse (a handler with no declaration) is harmless but dead.
 */
export function buildSubscriptionBus(
  registry: ModuleRegistry,
  consumers: Record<string, Handler>,
): SubscriptionBus {
  const bus = new SubscriptionBus();
  for (const manifest of registry.all()) {
    for (const sub of manifest.subscriptions) {
      const handler = consumers[sub.consumer];
      if (!handler) {
        throw new Error(
          `worker boot: module "${manifest.key}" declares a subscription to "${sub.event}" for ` +
            `consumer "${sub.consumer}", but no handler for that consumer was passed to registerAllJobs`,
        );
      }
      bus.on(sub.consumer, sub.event, handler);
    }
  }
  return bus;
}

/**
 * The FIVE interval cadences (D9, + Plan 10's pump, + Plan 11c's interface sweep), ONE WINDOW and
 * the retention trio — and nothing else `registerAllJobs` needs from config.
 *
 * IT IS A `Pick` OF `AppConfig`, DELIBERATELY, AND IT IS THE NARROWEST THING THAT WORKS.
 * `worker.ts` already holds the whole `AppConfig` (`app.get<AppConfig>(CONFIG)`) and passes it
 * unchanged — structural typing means production hands over what it already has, with no
 * adapter and no second source of truth for the key names. A TEST, meanwhile, supplies three
 * numbers and NOTHING ELSE: no `DATABASE_URL`, no `SECRET_KEY`, no ambient environment at all.
 * That asymmetry is the whole point of the parameter — see below.
 */
export type JobIntervals = Pick<
  AppConfig,
  | "workerDispatchIntervalMs"
  | "workerTimersIntervalMs"
  | "workerTempRolesIntervalMs"
  // Plan 10 D3: the notification pump's cadence (WORKER_NOTIFY_INTERVAL_MS, default 5 000).
  // WIDENING THIS `Pick` IS A TYPE EVENT, NOT A COSMETIC ONE (plan amendment 7): every
  // `JobIntervals` OBJECT LITERAL in the suite stops compiling until it carries the new key —
  // `CENSUS_INTERVALS` in `scheduler.test.ts` is the one that found it. Production is unaffected
  // because `worker.ts` passes the whole `AppConfig`, which satisfies the wider Pick structurally.
  | "workerNotifyIntervalMs"
  // Plan 11a R0-2: NOT a cadence — the pump's STUCK WINDOW (`NOTIFY_STUCK_AFTER_MS`, default
  // 300 000). config.ts:62 parsed it and config.ts:101 exposed `cfg.notifyStuckAfterMs`, and
  // NOBODY READ IT: the registration below said `runNotifyPump(db, { now })`, so the pump always
  // fell back to its own `DEFAULT_STUCK_AFTER_MS` and an operator who set the key got exactly
  // nothing (plan-10 gate report §7.2 — proved by execution, not argued). Amendment 7's
  // prediction directly above held to the letter when this key was added: `CENSUS_INTERVALS`
  // stopped compiling until it carried it.
  | "notifyStuckAfterMs"
  // Plan 11a D6/D7: THE RETENTION TRIO, and none of them is a cadence either — `retentionSweep`
  // is a `dailyIst` job whose instant is the code constant above. They are here because Global
  // Constraint 14 says a key that ships must DEMONSTRABLY take effect, and this registration is
  // the only place an `AppConfig` value can reach the sweep. `retentionEnabled` in particular is
  // the difference between a mechanism that is inert by design and one that is inert by accident:
  // drop it here and the sweep falls back to its own `DEFAULT_ENABLED = false` and the owner's
  // signed-off window silently does nothing — the `NOTIFY_STUCK_AFTER_MS` defect exactly, on a
  // surface where the failure mode is either "records never deleted" or, if the fallback had gone
  // the other way, "records deleted that nobody authorised". Book V9 is its mutant.
  | "retentionEnabled"
  | "retentionEventsMonths"
  | "notifyRetainDays"
  // Plan 11c D6: the TENTH job's cadence (`WORKER_INTERFACE_SWEEP_INTERVAL_MS`, default 60 000).
  // A real `every` cadence this time, not a window and not a flag — so amendment 7's warning
  // above applies in its original form: adding this key stopped all THREE `JobIntervals` object
  // literals in the suite compiling until each carried it (`CENSUS_INTERVALS` in
  // `scheduler.test.ts`, `INTERVALS` in `jobs.test.ts`, and the builder in
  // `retention/sweep.test.ts`). That is the typechecker announcing a new job to every census
  // literal, which is exactly what a widened `Pick` is for.
  | "workerInterfaceSweepIntervalMs"
>;

/**
 * The TEN jobs on the clock (D2/D9/step 2 + Plan 10 D3 + Plan 11a D5/D6 + Plan 11c D6),
 * transcribed exactly — do not invent cadences.
 * `runDispatchCycle` every `workerDispatchIntervalMs` · `runDueTimers` every
 * `workerTimersIntervalMs` · `sweepExpiredTempRoles` every `workerTempRolesIntervalMs` ·
 * `sweepGuardianMajority` daily 00:05 IST · `sweepAppointmentNoShows` daily 23:55 IST ·
 * `runDailyClose` daily 23:59 IST, called as `runDailyClose(db, undefined, now)` ·
 * `runNotifyPump` every `workerNotifyIntervalMs` (Plan 10 D3) · `createEventPartitions` daily
 * 00:15 IST (Plan 11a D5) · `retentionSweep` daily 01:15 IST (Plan 11a D6/D7) ·
 * `sweepInterfaceHeartbeats` every `workerInterfaceSweepIntervalMs` (Plan 11c D6).
 *
 * `runDispatchCycle` takes T3's SHIPPED signature — `(db, bus, opts?: { batchSize?, lookback?,
 * maxAttempts?, now? })` since `39e520d` — and this registration THREADS `now` through it, the
 * same as the other five. It is `now` that reaches the dispatcher's backoff arithmetic
 * (`next_attempt_at = now + min(2^attempts, 60) s`), so dropping it here silently handed
 * production a different clock from the one the scheduler heartbeats with.
 *
 * THIS FUNCTION READS NO ENVIRONMENT. It used to call `loadConfig()`, which parses
 * `process.env` through a zod schema in which `DATABASE_URL` is REQUIRED with no default — so
 * a fake-clock unit test that touches no database still hard-failed wherever `DATABASE_URL`
 * was unset. CI sets only `TEST_DATABASE_URL`; the build host happens to carry `DATABASE_URL`
 * in `apps/core/.env` because it doubles as a dev machine. The result was a test that was
 * green on exactly one machine in the world and red on CI for six consecutive commits. The
 * caller resolves config; this function is handed the three numbers it actually uses.
 */
export function registerAllJobs(
  scheduler: Scheduler,
  db: Db,
  registry: ModuleRegistry,
  consumers: Record<string, Handler>,
  intervals: JobIntervals,
): void {
  const bus = buildSubscriptionBus(registry, consumers);

  scheduler.register({
    name: "runDispatchCycle",
    every: intervals.workerDispatchIntervalMs,
    run: async (now) => { await runDispatchCycle(db, bus, { now }); },
  });
  scheduler.register({
    name: "runDueTimers",
    every: intervals.workerTimersIntervalMs,
    run: async (now) => { await runDueTimers(db, now); },
  });
  scheduler.register({
    name: "sweepExpiredTempRoles",
    every: intervals.workerTempRolesIntervalMs,
    run: async (now) => { await sweepExpiredTempRoles(db, now); },
  });
  scheduler.register({
    name: "sweepGuardianMajority",
    dailyIst: GUARDIAN_MAJORITY_IST,
    run: async (now) => { await sweepGuardianMajority(db, now); },
  });
  scheduler.register({
    name: "sweepAppointmentNoShows",
    dailyIst: APPOINTMENT_NO_SHOWS_IST,
    run: async (now) => { await sweepAppointmentNoShows(db, now); },
  });
  scheduler.register({
    name: "runDailyClose",
    dailyIst: DAILY_CLOSE_IST,
    run: async (now) => { await runDailyClose(db, undefined, now); },
  });
  // Plan 10 D3: the notification pump. It threads `now` through exactly as the other six do —
  // `now` is what reaches the expiry gate, the quiet-hours window and the backoff arithmetic, so
  // dropping it here would hand production a different clock from the one the scheduler
  // heartbeats with. Correctness never rests on the advisory lock: the pump's own
  // `FOR UPDATE SKIP LOCKED` claim carries it (D2/D3).
  //
  // Plan 11a R0-2: `stuckAfterMs` is threaded HERE, and this line is the whole fix. This is the
  // one place an `AppConfig` value can reach the pump, because `worker.ts` hands this function
  // the whole config and the pump is constructed nowhere else. A wiring test in `jobs.test.ts`
  // registers through this exact call with a distinct value and asserts a stale `sending` row
  // flips under this job's own `run(now)` (Book R2) — asserting that config PARSES the key
  // would discharge nothing, which is what the dead key looked like for a whole plan.
  scheduler.register({
    name: "runNotifyPump",
    every: intervals.workerNotifyIntervalMs,
    run: async (now) => {
      await runNotifyPump(db, { now, stuckAfterMs: intervals.notifyStuckAfterMs });
    },
  });
  // Plan 11a D5: THE EIGHTH JOB, and it needs no interval key — `dailyIst` registrations take
  // their instant from a code constant above, which is why this one does NOT widen `JobIntervals`
  // and no `JobIntervals` object literal had to change for it. What DID have to change are the
  // two CENSUSES (`scheduler.test.ts` and `test/worker-runtime.e2e.test.ts`): 7 → 8.
  //
  // `events` is RANGE-partitioned by IST month since 0016, and a month nobody created sends live
  // appends to the DEFAULT partition — the one partition the dispatcher's floor can never prune.
  // This job is what stops that happening, and it is idempotent (`create table if not exists`),
  // so a run that finds every month already there is a no-op rather than an error.
  scheduler.register({
    name: "createEventPartitions",
    dailyIst: CREATE_EVENT_PARTITIONS_IST,
    run: async (now) => { await createEventPartitions(db, now); },
  });
  // Plan 11a D6/D7: THE NINTH JOB. Unlike the eighth it DID widen `JobIntervals`, because all
  // three of its keys are values an operator sets and the plan requires each to demonstrably
  // reach this call (Global Constraint 14) — so this time the typechecker does announce the new
  // job to every `JobIntervals` object literal. The two CENSUSES still had to move by hand: 8 → 9
  // in `scheduler.test.ts` and in `test/worker-runtime.e2e.test.ts`.
  //
  // THE SWEEP IS INERT UNLESS `retentionEnabled` IS TRUE (Global Constraint 5). Registering it
  // unconditionally is deliberate: the job exists, heartbeats, and appears in the census on every
  // deployment, so an operator can see that retention is scheduled and doing nothing — which is a
  // very different thing from retention not being there at all.
  scheduler.register({
    name: "retentionSweep",
    dailyIst: RETENTION_SWEEP_IST,
    run: async (now) => {
      await retentionSweep(db, {
        now,
        enabled: intervals.retentionEnabled,
        eventsMonths: intervals.retentionEventsMonths,
        notifyRetainDays: intervals.notifyRetainDays,
      });
    },
  });
  // Plan 11c D6: THE TENTH JOB, and it is an `every` job whose cadence is a real operator key —
  // so unlike the eighth it widened `JobIntervals` (see the Pick above), and unlike the ninth the
  // key it added is an actual CADENCE rather than a value the run body reads. All three
  // `JobIntervals` object literals therefore stopped compiling until each admitted it, and the
  // three CENSUSES still had to move by hand: 9 → 10 in `scheduler.test.ts`, in
  // `test/worker-runtime.e2e.test.ts`, and in `test/alerts-parity.test.ts`'s count pin — the last
  // of which also mirrors this registration into `docker/prod/prometheus/alerts.yml`, so a tenth
  // job that nobody added to the alert rules is a RED TEST rather than a silent monitoring hole.
  //
  // `intervals.workerInterfaceSweepIntervalMs` is passed as `every` and NOT as an argument to the
  // sweep: the cadence is how often the registry is inspected, while how long each device may stay
  // quiet is that device's OWN `stale_after_ms` column (D6). Confusing the two would replace a
  // per-device window with a global one, which is the mutant Book V9 kills.
  scheduler.register({
    name: "sweepInterfaceHeartbeats",
    every: intervals.workerInterfaceSweepIntervalMs,
    run: async (now) => { await sweepInterfaceHeartbeats(db, now); },
  });
}
