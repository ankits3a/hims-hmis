import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";
import { ModuleRegistry } from "./kernel/modules/loader";
import { ALL_MANIFESTS } from "./kernel/modules/manifests"; // ← PLAN 11d D2: the ONE manifest list
import { PatientsModule } from "./modules/patients"; // ← imports the module's index — spec §4
import { TariffModule } from "./modules/tariff";
import { OpdModule } from "./modules/opd";
import { BillingModule } from "./modules/billing";
import { MembershipModule } from "./modules/membership";
import { PartnersModule } from "./modules/partners";
import { FormularyModule } from "./modules/formulary/formulary.module";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./kernel/auth/auth.module";
import { WorkflowModule } from "./kernel/workflow/workflow.module";
import { ApprovalsModule } from "./kernel/approvals/approvals.module";
import { RealtimeModule } from "./kernel/realtime/realtime.module";
import { AlertsModule } from "./kernel/alerts/alerts.module";
import { OpsModule } from "./kernel/ops/ops.module";
import { SearchModule } from "./kernel/search/search.module";
import { DeskModule } from "./kernel/desk/desk.module";
import { InferenceModule } from "./kernel/inference/inference.module";
import { ResourcesModule } from "./kernel/resources/resources.module";
import { MaterialsModule } from "./modules/materials/materials.module";
import { OtModule } from "./modules/ot/ot.module";
import { collectResourceKinds } from "./kernel/resources/kinds";
import { collectOrderKinds } from "./kernel/orders/kinds";

export { DB, DB_POOL, CONFIG, MODULE_REGISTRY } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule, PatientsModule, TariffModule, RealtimeModule, OpdModule, BillingModule, AlertsModule, OpsModule, SearchModule, DeskModule, InferenceModule, MembershipModule, PartnersModule, FormularyModule, ResourcesModule, MaterialsModule, OtModule], // ← OtModule (Plan 15 T2 — no controller yet: T8 mounts the four, the MaterialsModule precedent); ← MaterialsModule (Plan 14 T2 — no controller yet: T8 mounts it, the ResourcesModule/MembershipModule precedent); ← ResourcesModule (Plan 13 T2 — no controller yet: T5 mounts it, the MembershipModule/PartnersModule precedent); ← MembershipModule/PartnersModule (Plan 09 T1 — no controllers yet: T3/T5 and T7/T8 mount them); InferenceModule (Plan 11h T9, inert); SearchModule (Plan 11h T1); PatientsModule added; AlertsModule (Plan 08.5 D6); OpsModule (Plan 11c T2)
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
        // PLAN 11d D2 — THE NINE `registry.install(...)` CALLS THAT STOOD HERE ARE NOW
        // `ALL_MANIFESTS` (kernel/modules/manifests.ts). They were one of FOUR hand-maintained
        // copies of 'which manifests exist' — this file, worker.module.ts, seed-admin.ts and
        // seed-ops.ts — and §2.54 is the ledger entry that says two copies of one fact drift by
        // construction. The drift between THIS list (nine) and `scripts/seed-admin.ts`'s
        // ONE-manifest registry IS the mechanism of MAJOR 4: that script grants
        // `registry.allPermissions()` to `admin`, which meant six strings, so on the live box
        // `admin` held 9 of the 59 declared permissions and fifty were held by nobody at all.
        //
        // A LATER PLAN ADDS ITS MANIFEST TO THAT LIST, NEVER TO THIS FILE.
        // `kernel/modules/manifests.test.ts` (V4) fails the build on a manifest installed here
        // and absent there, and it states the worker's deliberately different set in as many
        // words so that difference can never be read as drift.
        for (const manifest of ALL_MANIFESTS) registry.install(manifest);
        // PLAN 13 CLOSE / M2 — THE KIND SEAM'S BOOT REFUSALS, ACTUALLY AT BOOT.
        // `kinds.ts` promises in capitals that a kind two manifests claim, or a declaration naming
        // a status outside its own vocabulary, is a BOOT error rather than a write-time one —
        // "finding out at the first admission is worse than finding out at startup". The collector
        // shipped with no caller outside its own test, so neither refusal existed in the running
        // system and a duplicate-`bed` deployment would have booted fine. `collectProviders`, the
        // precedent `kinds.ts` cites, IS called from a live path (kernel/search/registry.ts); this
        // line is what makes the citation true. The return value is deliberately discarded — the
        // THROW is the whole point, and the write surface takes its declarations as a parameter
        // (see registry.ts's header on why that is a parameter and not a global).
        collectResourceKinds(registry);
        /**
         * PLAN 17 PHASE 0 T2 — THE ORDER-KIND SEAM'S BOOT REFUSALS, IN BOTH PROCESSES FROM THE
         * FIRST COMMIT.
         *
         * Plan 13 shipped `collectResourceKinds` with no caller at all, so neither of ITS refusals
         * existed in the running system and a duplicate-`bed` deployment would have booted fine;
         * the line above is that gap closed, and Plan 14 had to close it a second time in the
         * worker. This collector is wired into both processes in the commit that creates it, which
         * is the whole lesson applied rather than re-learned. The return value is deliberately
         * discarded — the THROW is the point, and `placeOrder` takes its declarations as a
         * parameter (kinds.ts's header on why that is a parameter and not a global).
         */
        collectOrderKinds(registry);
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
