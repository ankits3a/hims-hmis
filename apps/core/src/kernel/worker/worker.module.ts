import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "../db/client";
import { loadConfig, AppConfig } from "../config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "../tokens";
import { ModuleRegistry } from "../modules/loader";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";

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
        // T4 (amendment 6) adds: registry.install(alertsManifest);
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
