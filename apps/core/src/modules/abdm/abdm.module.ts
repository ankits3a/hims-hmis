import { Inject, Module } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { CONFIG, DB } from "../../kernel/tokens";
import { AbdmAbhaController } from "./abha.controller";
import { AbdmCallbackGuard } from "./callback.guard";
import { AbdmCallbacksController } from "./callbacks.controller";
import { callbackKind, registerAbdmCallbackHandler } from "./callbacks";
import { AbdmHiuController, AbdmHiuPushController } from "./hiu.controller";
import { HIU_SWEEP_INTERVAL_MS, purgeExpiredExternalRecords } from "./hiu";
import type { AbdmInboundMessage } from "./callbacks";
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
 *
 * S2 — the M2 handlers join it on the same terms: registered only when configured, unregistered on
 * shutdown. The connector's MANIFEST (`manifest.ts`) is installed in the WORKER only — its one purpose
 * is the care-context consumer — so the api still installs no ABDM manifest.
 *
 * S3 — the M3 (HIU) handlers join on the same terms, and only when an HIU id is configured. The doctor's
 * routes ride `opd.consult` (no new permission, still no api manifest). THE EXPIRY SWEEP: while the HIU
 * is on, the api erases records past their consent's `dataEraseAt` every 10 minutes (`unref`'d, and
 * stopped on shutdown) — DECIDED here rather than as a worker job, because a job is a kernel edit
 * (`kernel/worker/jobs.ts` and its censuses) this slice does not own; the read also sweeps first, so
 * an expired record is never SHOWN between sweeps. A worker job is owed.
 */
@Module({
  controllers: [AbdmCallbacksController, AbdmAbhaController, AbdmHiuController, AbdmHiuPushController],
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
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(AbdmRuntime) private readonly runtime: AbdmRuntime) {}

  onModuleInit(): void {
    const { shares, careContexts, linking, consents, healthInformation, hiu } = this.runtime;
    if (shares === null || careContexts === null || linking === null || consents === null || healthInformation === null) return;
    const on = (path: string, handler: (m: AbdmInboundMessage) => Promise<void>): void => {
      this.unregister.push(registerAbdmCallbackHandler(callbackKind(path), handler));
    };
    if (hiu !== null) {
      // S3 — M3, the hospital as HIU.
      on("/api/v3/hiu/consent/request/on-init", (m) => hiu.handleOnInit(m));
      on("/api/v3/hiu/consent/request/on-status", (m) => hiu.handleOnStatus(m));
      on("/api/v3/hiu/consent/request/notify", (m) => hiu.handleNotify(m));
      on("/api/v3/hiu/consent/on-fetch", (m) => hiu.handleOnFetch(m));
      on("/api/v3/hiu/health-information/on-request", (m) => hiu.handleOnHiRequest(m));
      const { db, now } = this.runtime;
      this.sweep = setInterval(() => { void purgeExpiredExternalRecords(db, now()).catch(() => undefined); }, HIU_SWEEP_INTERVAL_MS);
      this.sweep.unref();
    }
    on("/api/v3/hip/patient/share", (m) => shares.handleProfileShare(m));
    // S2 — M2, the hospital as HIP. `patients/sms/on-notify` (deep-link SMS) stays unhandled: not built.
    on("/api/v3/hip/token/on-generate-token", (m) => careContexts.handleOnGenerateToken(m));
    on("/api/v3/link/on_carecontext", (m) => careContexts.handleOnCareContext(m));
    on("/api/v3/links/context/on-notify", (m) => careContexts.handleContextOnNotify(m));
    on("/api/v3/hip/patient/care-context/discover", (m) => linking.handleDiscover(m));
    on("/api/v3/hip/link/care-context/init", (m) => linking.handleLinkInit(m));
    on("/api/v3/hip/link/care-context/confirm", (m) => linking.handleLinkConfirm(m));
    on("/api/v3/consent/request/hip/notify", (m) => consents.handleNotify(m));
    on("/api/v3/hip/health-information/request", (m) => healthInformation.handleRequest(m));
  }

  onModuleDestroy(): void {
    for (const u of this.unregister) u();
    this.unregister = [];
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
  }
}
