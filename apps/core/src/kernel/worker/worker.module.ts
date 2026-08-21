import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { INestApplicationContext } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "../db/client";
import { loadConfig, AppConfig } from "../config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "../tokens";
import { ModuleRegistry } from "../modules/loader";
import { alertsManifest } from "../alerts/manifest";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import type { Scheduler } from "./scheduler";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

/**
 * D1 (FORK-A, RESOLVED by spike question A — see the plan's Spike verdicts block):
 * `createApplicationContext(WorkerModule)` boots, resolves `DB`, runs a sweep, and closes
 * cleanly; `AppModule` as a headless context dies at boot
 * (`RealtimeGateway.onApplicationBootstrap` reads a null HTTP adapter — gateway.ts:71). So the
 * worker gets its OWN providers-only module rather than reusing `AppModule`'s: NO `imports`
 * array at all, NO controllers, NO `RealtimeModule` — the worker structurally cannot start the
 * HTTP tail or the WS server (roadmap trap 2). `DB_BUNDLE` is a module-local `Symbol`;
 * `app.module.ts`'s copy is not exported, so this module declares its own (measured, spike A).
 *
 * EVERY PROVIDER HERE INJECTS BY TOKEN (`@Inject(...)`), with no exceptions. `start:worker` is
 * `tsx src/worker.ts`, and esbuild (tsx's transformer) does not emit `design:paramtypes` — a
 * class-typed constructor injection would silently receive `undefined` and fail later and
 * elsewhere (spike A measured exactly that booting `AppModule` under `tsx`: it died inside
 * `OpdRealtimeRegistrar.onModuleInit`, not at the point of injection, because the same class
 * resolves fine under ts-jest). This module has no class-typed providers to get wrong, and it
 * must stay that way.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_BUNDLE,
      useFactory: (cfg: AppConfig): DbBundle => createDb(cfg.databaseUrl),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (b: DbBundle): Db => b.db, inject: [DB_BUNDLE] },
    { provide: DB_POOL, useFactory: (b: DbBundle): Pool => b.pool, inject: [DB_BUNDLE] },
    {
      provide: MODULE_REGISTRY,
      useFactory: (): ModuleRegistry => {
        const registry = new ModuleRegistry();
        registry.install(authManifest);
        registry.install(workflowManifest);
        registry.install(approvalsManifest);
        registry.install(patientsManifest);
        registry.install(tariffManifest);
        registry.install(opdManifest);
        registry.install(billingManifest);
        // AMENDMENT 6, THE OTHER HALF OF WHICH IS IN `worker.ts`. This line and
        // `worker.ts`'s `{ [ALERTS_CONSUMER]: alertsConsumer(db) }` are ONE edit: this
        // manifest is the only one in the build that declares a subscription, and
        // `buildSubscriptionBus` turns a declaration with no matching handler into a BOOT
        // ERROR by design (jobs.ts). Install it here without passing the handler there and
        // the worker throws at startup — behind a fully green suite, because every seam test
        // that came before built its own private registry rather than reading THIS one.
        registry.install(alertsManifest);
        return registry;
      },
    },
  ],
  exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY],
})
export class WorkerModule implements OnModuleDestroy {
  private poolClosed = false;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Own flag, not pg's pool.ended (missing from @types/pg): a double app.close() must stay
    // safe. Copied from AppModule's guard — the tail-vs-pool shutdown race gateway.ts:78-88
    // documents has no analogue here: no child module, no interval (spike A, measured).
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end();
  }
}

/** Where a shutdown says what it did. `console` in the daemon; a recorder in the assertions. */
export type ShutdownLog = {
  log(message: string): void;
  error(message: string, err: unknown): void;
};

/**
 * THE DAEMON'S SIGTERM SEQUENCE — stop the scheduler (which awaits any in-flight run), then
 * close the context (whose `onModuleDestroy` above ends the pool exactly once).
 *
 * IT LIVES HERE, NOT INLINE IN `worker.ts`, FOR ONE REASON: `worker.ts` calls `bootstrap()` at
 * import time, so a test cannot import the entry point without starting a real worker. That is
 * precisely why the shape below shipped unasserted — and unasserted it was
 * EXECUTION-LESSONS §3.48 verbatim: `void (async () => { … })()` with NO `catch`, in the one
 * path that runs while the process is already on its way out. A rejection from
 * `scheduler.stop()` or `ctx.close()` had nobody holding it; node would report it against
 * whatever happened to be running, or lose it in the exit.
 *
 * THE RETURNED PROMISE NEVER REJECTS. Every failure is caught and REPORTED through `logger`,
 * so the caller may `void` it and a shutdown that goes wrong says so instead of vanishing.
 */
export function shutdownWorker(
  scheduler: Pick<Scheduler, "stop">,
  ctx: Pick<INestApplicationContext, "close">,
  logger: ShutdownLog,
): Promise<void> {
  return (async (): Promise<void> => {
    await scheduler.stop();
    logger.log("worker: scheduler stopped, closing context");
    await ctx.close();
    logger.log("worker: context closed, exiting");
  })().catch((err: unknown) => {
    logger.error("worker: shutdown failed", err);
  });
}
