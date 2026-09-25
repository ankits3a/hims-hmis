import { Inject, Module } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CONFIG, DB } from "../../kernel/tokens";
import { AbdmAbhaController } from "./abha.controller";
import { AbdmCallbackGuard } from "./callback.guard";
import { AbdmCallbacksController } from "./callbacks.controller";
import { callbackKind, registerAbdmCallbackHandler } from "./callbacks";
import { ABDM_CLOCK, ABDM_FETCH, AbdmRuntime, defaultAbdmFetch } from "./runtime";
import type { AbdmFetch } from "./gateway-client";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — the connector. A LEAF module: nothing imports it but `app.module.ts`; it imports the
 * kernel and — from S1 — the patients module's index (`getPatient`, `recordAbhaVerifiedByAbdm`).
 *
 * The global AuthGuard/PermissionGuard pair still runs on the callback routes (they are APP_GUARDs);
 * `@Public()` is what lets AuthGuard through, and `AbdmCallbackGuard` is what then authenticates.
 *
 * S1 — the counter's ABHA routes (`AbdmAbhaController`) ride EXISTING permissions
 * (`patients.register` for the steps, `patients.update` for the two links), so there is still no
 * manifest: this module declares no permission, menu or subscription of its own.
 *
 * S1 — THE SHARE HANDLER is registered when the module starts and ONLY when ABDM is configured. An
 * unconfigured deployment answers every callback 503 before dispatch, so it has nothing to handle;
 * and registering nothing there keeps S0's one-handler-per-kind rule from firing in the many test
 * apps that boot without ABDM. It is unregistered on shutdown, so a test that boots a second app
 * after closing the first can register again.
 */
@Module({
  controllers: [AbdmCallbacksController, AbdmAbhaController],
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
export class AbdmModule implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];

  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  onModuleInit(): void {
    const shares = this.runtime.shares;
    if (shares === null) return;
    this.unregister.push(
      registerAbdmCallbackHandler(callbackKind("/api/v3/hip/patient/share"), (m) => shares.handleProfileShare(m)),
    );
  }

  onModuleDestroy(): void {
    for (const u of this.unregister) u();
    this.unregister = [];
  }
}
