import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { WorkerModule, shutdownWorker, workerConsumers } from "./kernel/worker/worker.module";
import { CONFIG, DB, DB_POOL, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { Scheduler, pgLocks } from "./kernel/worker/scheduler";
import { registerAllJobs } from "./kernel/worker/jobs";
import type { AppConfig } from "./kernel/config";
import type { Db } from "./kernel/db/client";
import type { ShutdownLog } from "./kernel/worker/worker.module";

/**
 * D1/FORK-A (resolved): a providers-only Nest APPLICATION CONTEXT, never an HTTP app.
 * WorkerModule has no controllers and no RealtimeModule, so this process structurally cannot
 * start the tail or the WS server (roadmap trap 2) — it only runs the six sweeps on a clock.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const cfg = app.get<AppConfig>(CONFIG);
  const db = app.get<Db>(DB);
  const pool = app.get<Pool>(DB_POOL);
  const registry = app.get<ModuleRegistry>(MODULE_REGISTRY);

  const scheduler = new Scheduler(db, pool, pgLocks(pool), cfg.workerDailyTickMs);
  // AMENDMENT 6, THE OTHER HALF OF WHICH IS THE `registry.install(...)` BLOCK IN
  // `worker.module.ts`. The two are ONE edit and must never be split: the manifests declare
  // `escalation.triggered -> kernel.alerts` and five events -> `kernel.notify`, and
  // `buildSubscriptionBus` makes a declaration with no matching handler a boot error. Without
  // these handlers the worker throws at startup; without the installs over there, this worker
  // heartbeats every 2 s and dispatches to nobody — which is exactly what it did for six
  // commits (12 events, 0 deliveries, 0 alerts).
  //
  // THE MAP ITSELF NOW LIVES IN `worker.module.ts` AS `workerConsumers(db)` (Plan 10 T5), for
  // the reason this file exists as a counter-example: `bootstrap()` runs at import, so nothing
  // can import THIS file to assert what it passes. That map can be imported, and it is.
  //
  // `cfg` (the whole AppConfig, already resolved above) satisfies `JobIntervals` structurally.
  // `registerAllJobs` no longer reads the environment itself — see its docstring.
  registerAllJobs(scheduler, db, registry, workerConsumers(db), cfg);
  scheduler.start();
  console.log(`worker started: jobs=${scheduler.jobs().join(",")}`);

  // Every Scheduler timer is deliberately unref()'d (a stray un-stopped Scheduler must never
  // hang a jest worker), and this process has no HTTP listener and opens no DB connection
  // until its first tick queries one — so with nothing else refed, node considers the event
  // loop empty and exits 0 within milliseconds of boot, before even the first 2 s dispatch
  // tick can fire (reproduced once on this server: the process was gone by the time a
  // follow-up `pgrep` ran a few seconds after "worker started" logged, no error, no signal).
  // This ref'd no-op interval is the daemon's OWN keep-alive anchor, independent of the
  // Scheduler's timers; the shutdown handler below clears it same as everything else.
  const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000);

  // Graceful shutdown: SIGTERM -> scheduler.stop() (awaits any in-flight run) -> context close
  // (WorkerModule.onModuleDestroy ends the pool once, guarded) -> pool end. Deliberately NOT
  // app.enableShutdownHooks(): that would let Nest close the context on its own signal
  // listener, racing scheduler.stop() and risking the pool ending mid-sweep.
  //
  // The sequence itself lives in `worker.module.ts` as `shutdownWorker` so that it can be
  // ASSERTED (this file boots on import, so nothing may import it). It attaches the `.catch`
  // that the inline `void (async () => { … })()` here did not have — §3.48 verbatim, in the
  // one path that runs while the process is already leaving. `shutdownWorker` never rejects;
  // a failure is reported through the logger below instead of escaping as an unowned
  // rejection, so `void` is safe here and says what it means.
  let shuttingDown = false;
  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    console.log("worker: SIGTERM received, stopping scheduler");
    void shutdownWorker(scheduler, app, CONSOLE_SHUTDOWN_LOG);
  });
}

const CONSOLE_SHUTDOWN_LOG: ShutdownLog = {
  log: (message) => { console.log(message); },
  error: (message, err) => { console.error(message, err); },
};

void bootstrap();
