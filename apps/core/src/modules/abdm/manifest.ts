import { consultationCompleted } from "../opd";
import { labReportPublished } from "../lab";
import { imagingReportPublished } from "../radiology";
import { ABDM_CARE_CONTEXT_CONSUMER } from "./consumer";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * ABDM S2 — the connector's manifest, and it exists for ONE reason: the worker's care-context
 * consumer (`consumer.ts`). No permission (the counter's ABHA routes ride `patients.*`, S1; the
 * callback routes are ABDM's, guarded by its JWT), no menu, no job.
 *
 * INSTALLED IN THE WORKER ONLY — the `notify` / `obligations` shape (`manifests.test.ts` (2)): its
 * only declarations are subscriptions whose handler exists solely in `workerConsumers`, so installing
 * it in `app.module.ts` would stop the api at startup, and the api has nothing to read from it.
 */
export const abdmManifest: ModuleManifest = {
  key: "abdm",
  title: "ABDM connector",
  menu: [],
  permissions: [],
  subscriptions: [
    { event: consultationCompleted.name, consumer: ABDM_CARE_CONTEXT_CONSUMER },
    { event: labReportPublished.name, consumer: ABDM_CARE_CONTEXT_CONSUMER },
    { event: imagingReportPublished.name, consumer: ABDM_CARE_CONTEXT_CONSUMER },
  ],
};
