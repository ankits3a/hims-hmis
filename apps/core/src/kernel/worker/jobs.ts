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
import type { AppConfig } from "../config";
import type { Scheduler } from "./scheduler";

// D9/step 2: the daily jobs' clock instants are CODE CONSTANTS beside their registration, not
// deployment knobs — design decisions from the roadmap (2026-08-12 owner decision Q4), not
// config that an operator would tune.
const GUARDIAN_MAJORITY_IST = "00:05";
const APPOINTMENT_NO_SHOWS_IST = "23:55";
const DAILY_CLOSE_IST = "23:59";

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
 * The FOUR interval cadences (D9, + Plan 10's pump) — and nothing else `registerAllJobs` needs
 * from config.
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
>;

/**
 * The SEVEN jobs on the clock (D2/D9/step 2 + Plan 10 D3), transcribed exactly — do not invent
 * cadences.
 * `runDispatchCycle` every `workerDispatchIntervalMs` · `runDueTimers` every
 * `workerTimersIntervalMs` · `sweepExpiredTempRoles` every `workerTempRolesIntervalMs` ·
 * `sweepGuardianMajority` daily 00:05 IST · `sweepAppointmentNoShows` daily 23:55 IST ·
 * `runDailyClose` daily 23:59 IST, called as `runDailyClose(db, undefined, now)` ·
 * `runNotifyPump` every `workerNotifyIntervalMs` (Plan 10 D3).
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
  scheduler.register({
    name: "runNotifyPump",
    every: intervals.workerNotifyIntervalMs,
    run: async (now) => { await runNotifyPump(db, { now }); },
  });
}
