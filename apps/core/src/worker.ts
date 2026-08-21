import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { WorkerModule } from "./kernel/worker/worker.module";
import { CONFIG, DB, DB_POOL, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { Scheduler, pgLocks } from "./kernel/worker/scheduler";
import { registerAllJobs } from "./kernel/worker/jobs";
import type { AppConfig } from "./kernel/config";
import type { Db } from "./kernel/db/client";

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
  // T4 (amendment 6) adds the one live entry here: { "kernel.alerts": alertsConsumer(db) }.
  registerAllJobs(scheduler, db, registry, {});
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
  let shuttingDown = false;
  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    console.log("worker: SIGTERM received, stopping scheduler");
    void (async () => {
      await scheduler.stop();
      console.log("worker: scheduler stopped, closing context");
      await app.close();
      console.log("worker: context closed, exiting");
    })();
  });
}

void bootstrap();
