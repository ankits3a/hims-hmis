import type { ModuleManifest } from "../modules/manifest";
import { OBLIGATIONS_CONSUMER } from "./consumer";

/**
 * ═══ PHASE O T1 — WORKER-ONLY, AND IT IS THE `notify` SHAPE RATHER THAN THE `alerts` ONE ═══
 *
 * This manifest declares a subscription and NOTHING else: no permission, no menu, no route. Its
 * whole purpose today is to wire one consumer in the worker process, so it is installed there
 * and is deliberately ABSENT from `ALL_MANIFESTS` — exactly as `notify` is, and for the same
 * reason `manifests.test.ts` states about `notify`: the handler for `kernel.obligations` exists
 * only in `worker.module.ts`'s `workerConsumers`, and `buildSubscriptionBus` makes a declared
 * subscription with no matching handler a BOOT ERROR by design.
 *
 * It joins `ALL_MANIFESTS` when it gains something the api serves — T5's `obligations.chains.manage`
 * and T6's ledger routes are the first such things. Putting it there now would install a module
 * with an empty permission set and no route into the api's registry, and would make
 * `manifests.test.ts`'s enumerated difference say something untrue about what each process does.
 *
 * THE ONE-EDIT RULE: this declaration, `obligationsConsumer`'s `alert.acknowledged` branch, the
 * `registry.install` in `worker.module.ts` and its `workerConsumers` entry are ONE commit.
 */
export const obligationsManifest: ModuleManifest = {
  key: "obligations",
  title: "Obligations",
  menu: [],
  permissions: [],
  subscriptions: [
    // An acknowledgement stops the respond clock — and only the respond clock.
    { event: "alert.acknowledged", consumer: OBLIGATIONS_CONSUMER },
  ],
};
