import { consultationCompleted } from "../opd";
import { encounterNoOfLabOrder, labReportPublished } from "../lab";
import { imagingReportPublished } from "../radiology";
import { CareContexts } from "./care-contexts";
import { AbdmGatewayClient } from "./gateway-client";
import { HipClient } from "./hip-client";
import { defaultAbdmFetch } from "./runtime";
import { abdmSettingsFrom } from "./settings";
import type { AbdmFetch } from "./gateway-client";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/**
 * ═══ ABDM S2 — THE WORKER'S CONSUMER: A VISIT OR A REPORT BECOMES (OR ENRICHES) A CARE CONTEXT ═══
 *
 * `abdmManifest` declares three subscriptions to this one consumer; `workerConsumers` (worker.module.ts)
 * supplies it, and the two are one edit (`buildSubscriptionBus` makes a declaration without its
 * handler a BOOT ERROR).
 *
 *   · `consultation.completed` → `CareContexts.onVisitCompleted` (record, then link / notify).
 *   · `lab.report_published` and `imaging.report_published` → `onReportPublished` (the visit's care
 *     context gains DiagnosticReport; a linked one is notified of it).
 *
 * The worker builds ITS OWN gateway client (one session per process) from the config it was handed.
 * With no config, or ABDM not configured, the handler does nothing and returns — the cursor still
 * advances, so switching ABDM on later does not replay a year of visits (FT's "legacy records" are
 * reached by patient-initiated discovery instead, which lists every completed visit).
 *
 * Idempotent: every step is decided by stored state (`care-contexts.ts` says how), so the
 * dispatcher's at-least-once delivery and its retries send nothing twice. A transport failure throws,
 * and the dispatcher retries with backoff — which is also the retry the link step wants.
 */
export const ABDM_CARE_CONTEXT_CONSUMER = "abdm.care_contexts";

export function careContextConsumer(
  db: Db, cfg: AppConfig | null, fetchImpl: AbdmFetch = defaultAbdmFetch, now: () => Date = () => new Date(),
): Handler {
  let careContexts: CareContexts | null = null;
  const service = (): CareContexts => {
    if (careContexts !== null) return careContexts;
    const settings = cfg === null ? null : abdmSettingsFrom(cfg.abdm);
    const client = settings === null ? null : new AbdmGatewayClient(settings, { db, fetch: fetchImpl, now });
    const hip = settings === null || client === null ? null : new HipClient(client, settings, { db, fetch: fetchImpl, now });
    careContexts = new CareContexts({ db, settings, hip, secretKey: cfg?.secretKey ?? Buffer.alloc(32), now });
    return careContexts;
  };
  return async (e: DispatchedEvent): Promise<void> => {
    if (cfg === null || !cfg.abdm.configured) return;
    if (e.name === consultationCompleted.name) {
      const p = consultationCompleted.payloadSchema.safeParse(e.payload);
      if (p.success) await service().onVisitCompleted(p.data.encounterId);
      return;
    }
    if (e.name === imagingReportPublished.name) {
      const p = imagingReportPublished.payloadSchema.safeParse(e.payload);
      if (p.success) await service().onReportPublished(p.data.encounterNo);
      return;
    }
    if (e.name === labReportPublished.name) {
      const p = labReportPublished.payloadSchema.safeParse(e.payload);
      if (!p.success) return;
      const encounterNo = await encounterNoOfLabOrder(db, p.data.orderId);
      if (encounterNo !== null) await service().onReportPublished(encounterNo);
    }
  };
}
