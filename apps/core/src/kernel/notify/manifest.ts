import type { ModuleManifest } from "../modules/manifest";

/**
 * The gateway's half of the §4 manifest seam (Plan 10, D13). It is the SECOND manifest in the
 * build to declare anything — `alertsManifest` was the first — and the two are now the whole of
 * what `buildSubscriptionBus` finds.
 *
 * THE FIVE ROWS BELOW ARE ONE EDIT WITH `consumer.ts` AND WITH `worker.module.ts`'s
 * `workerConsumers`, AND THEY MAY NEVER SHIP APART. Amendment 6 made a declared subscription
 * with no matching handler a BOOT ERROR (`jobs.ts`), so installing this manifest without the
 * `kernel.notify` entry in the consumers map stops the worker at startup — by design, and
 * loudly, rather than dispatching to nobody the way the alerts wire silently did for six
 * commits.
 *
 * `permissions` and `menu` are deliberately EMPTY. There is no notification-center UI in this
 * plan (D14) and nothing here is reached by a route: the outbox is worker-side machinery, and
 * minting a permission no seeded role holds is the trap D6-08.5 already named.
 *
 * The consumer key is the LITERAL `"kernel.notify"` rather than an import of `NOTIFY_CONSUMER`,
 * exactly as `alertsManifest` carries `"kernel.alerts"`: a manifest is a declaration and must
 * stay free of the db/schema graph its consumer pulls in. `consumer.test.ts` asserts the literal
 * and the constant agree, so the duplication cannot drift silently.
 */
export const notifyManifest: ModuleManifest = {
  key: "notify",
  title: "Notifications",
  menu: [],
  permissions: [],
  subscriptions: [
    { event: "appointment.booked", consumer: "kernel.notify" },
    { event: "appointment.cancelled", consumer: "kernel.notify" },
    { event: "appointment.rescheduled", consumer: "kernel.notify" },
    { event: "escalation.triggered", consumer: "kernel.notify" },
    { event: "patient.registered", consumer: "kernel.notify" },
  ],
};
