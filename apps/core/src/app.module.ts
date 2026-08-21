import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
import { workflowManifest } from "./kernel/workflow/manifest";
import { approvalsManifest } from "./kernel/approvals/manifest";
import { patientsManifest, PatientsModule } from "./modules/patients"; // ← added (imports the module's index — spec §4)
import { tariffManifest, TariffModule } from "./modules/tariff";
import { opdManifest, OpdModule } from "./modules/opd";
import { billingManifest, BillingModule } from "./modules/billing";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";
import { ApprovalsModule } from "./kernel/approvals/approvals.module";
import { RealtimeModule } from "./kernel/realtime/realtime.module";
import { AlertsModule } from "./kernel/alerts/alerts.module";
import { alertsManifest } from "./kernel/alerts/manifest";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule, PatientsModule, TariffModule, RealtimeModule, OpdModule, BillingModule, AlertsModule], // ← PatientsModule added; AlertsModule (Plan 08.5 D6)
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
        registry.install(patientsManifest); // ← added; syncPermissions mirrors it at boot — no new boot-time DB call
        registry.install(tariffManifest);
        registry.install(opdManifest);
        registry.install(billingManifest);
        // kernel/alerts is kernel code, but it carries a manifest for one reason: the §4
        // subscriptions seam. This is the first non-empty `subscriptions` declaration in the
        // repo. It mints NO permission (D6 — access is identity-scoped).
        registry.install(alertsManifest);
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
