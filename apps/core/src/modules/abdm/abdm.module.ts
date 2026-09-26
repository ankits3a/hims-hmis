import { Module } from "@nestjs/common";
import { CONFIG, DB } from "../../kernel/tokens";
import { AbdmCallbackGuard } from "./callback.guard";
import { AbdmCallbacksController } from "./callbacks.controller";
import { ABDM_CLOCK, ABDM_FETCH, AbdmRuntime, defaultAbdmFetch } from "./runtime";
import type { AbdmFetch } from "./gateway-client";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — the connector. A LEAF module: nothing imports it but `app.module.ts`, and it imports the
 * kernel only. It has no manifest yet because it declares no permission, menu or subscription — its
 * only routes are ABDM's callbacks, which no HMIS user calls. S1 adds the manifest with the first
 * route a clerk calls (the ABHA verification flow) and the permission that guards it.
 *
 * The global AuthGuard/PermissionGuard pair still runs on the callback routes (they are APP_GUARDs);
 * `@Public()` is what lets AuthGuard through, and `AbdmCallbackGuard` is what then authenticates.
 */
@Module({
  controllers: [AbdmCallbacksController],
  providers: [
    { provide: ABDM_FETCH, useValue: defaultAbdmFetch },
    { provide: ABDM_CLOCK, useValue: (): Date => new Date() },
    {
      provide: AbdmRuntime,
      useFactory: (cfg: AppConfig, db: Db, fetchImpl: AbdmFetch, now: () => Date): AbdmRuntime =>
        new AbdmRuntime(cfg, db, fetchImpl, now),
      inject: [CONFIG, DB, ABDM_FETCH, ABDM_CLOCK],
    },
    AbdmCallbackGuard,
  ],
  exports: [AbdmRuntime],
})
export class AbdmModule {}
