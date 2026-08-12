import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG } from "./kernel/tokens";
import { HealthController } from "./health/health.controller";

export { DB, DB_POOL, CONFIG } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
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
  ],
  exports: [DB, DB_POOL, CONFIG],
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
