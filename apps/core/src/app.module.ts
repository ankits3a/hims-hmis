import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
import { workflowManifest } from "./kernel/workflow/manifest";
import { approvalsManifest } from "./kernel/approvals/manifest";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";
import { ApprovalsModule } from "./kernel/approvals/approvals.module";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule],
  controllers: [HealthController],
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
        // Later plans install their module manifests here.
        return registry;
      },
    },
  ],
  exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY],
})
export class AppModule implements OnModuleDestroy {
  private poolClosed = false;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Own flag, not pg's pool.ended: that runtime property is missing from @types/pg
    // (typecheck failure), and a double app.close() must stay safe.
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end();
  }
}
