import { PHONE_PUSH_CONSUMER } from "./consumer";
import type { ModuleManifest } from "../modules/manifest";

/**
 * MOBILE M6b (owner 2026-10-06) — THE BELL, ON A PHONE THAT IS IN A POCKET.
 *
 * Every row the web bell shows ends in `alert.raised`. This manifest subscribes ONE consumer to
 * that one event and relays it to the person's signed-in phones (`phone-push.ts`).
 *
 * WORKER-ONLY, the `notify` / `obligations` shape: one subscription, no permission, no menu, no
 * route of its own (the phone's routes live under `/auth/phone/…` and the administrator's test
 * under `/admin/users/…`, on permissions those modules already own). So it is installed in
 * `worker.module.ts` and deliberately NOT in `ALL_MANIFESTS`.
 *
 * ITS OWN MANIFEST AND ITS OWN CONSUMER KEY, not a ninth line on `alertsManifest`: the cursor, the
 * retries and the dead letters are then its own, so Firebase being down can never hold up a bell
 * row — and a registry that installs `alertsManifest` alone (most of the suite) is not obliged to
 * know that phones exist.
 *
 * THE ONE-EDIT RULE: this declaration, the `registry.install` in `worker.module.ts` and the
 * `workerConsumers` entry are ONE commit (`buildSubscriptionBus` makes a declared subscription
 * with no handler a boot error).
 */
export const phonePushManifest: ModuleManifest = {
  key: "phone_push",
  title: "Phone notifications",
  menu: [],
  permissions: [],
  subscriptions: [{ event: "alert.raised", consumer: PHONE_PUSH_CONSUMER }],
};
