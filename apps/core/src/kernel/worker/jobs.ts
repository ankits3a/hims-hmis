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
import { loadConfig } from "../config";
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
 * not silently drop deliveries). `worker.module.ts` passes `{}` today; T4 adds the one
 * `"kernel.alerts"` entry once the alerts manifest declares its first subscription.
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
 * The six sweeps on the clock (D2/D9/step 2), transcribed exactly — do not invent cadences.
 * `runDispatchCycle` every WORKER_DISPATCH_INTERVAL_MS · `runDueTimers` every
 * WORKER_TIMERS_INTERVAL_MS · `sweepExpiredTempRoles` every WORKER_TEMP_ROLES_INTERVAL_MS ·
 * `sweepGuardianMajority` daily 00:05 IST · `sweepAppointmentNoShows` daily 23:55 IST ·
 * `runDailyClose` daily 23:59 IST, called as `runDailyClose(db, undefined, now)`.
 *
 * `runDispatchCycle` is called at its SHIPPED (pre-T3) signature — T2 runs before T3 in this
 * pipeline, so `dispatcher.ts` still reads `(db, bus, batchSize?)` with no `now` option; T3
 * owns that file and its rewrite (D4), not T2.
 */
export function registerAllJobs(
  scheduler: Scheduler,
  db: Db,
  registry: ModuleRegistry,
  consumers: Record<string, Handler>,
): void {
  const cfg = loadConfig();
  const bus = buildSubscriptionBus(registry, consumers);

  scheduler.register({
    name: "runDispatchCycle",
    every: cfg.workerDispatchIntervalMs,
    run: async () => { await runDispatchCycle(db, bus); },
  });
  scheduler.register({
    name: "runDueTimers",
    every: cfg.workerTimersIntervalMs,
    run: async (now) => { await runDueTimers(db, now); },
  });
  scheduler.register({
    name: "sweepExpiredTempRoles",
    every: cfg.workerTempRolesIntervalMs,
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
}
