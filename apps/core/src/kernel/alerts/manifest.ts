import type { ModuleManifest } from "../modules/manifest";

/**
 * The §4 manifest seam, finally consumed. Spike question D measured that this seam is not
 * merely unbound but EMPTY — all seven shipped manifests declare `subscriptions: []` and
 * `subscriptionsFor` has zero production callers — so THIS is the first declaration the
 * worker's `buildSubscriptionBus` (jobs.ts) will ever find.
 *
 * `permissions` is deliberately EMPTY (D6). Alerts are yours BY IDENTITY, not by role: minting
 * an `alerts.read` permission would oblige every seeded role to hold it, which is exactly the
 * trap that produced "the cashier holds no tariff.read". The routes carry neither @Public nor
 * @RequirePermission and are authenticated-only.
 */
export const alertsManifest: ModuleManifest = {
  key: "alerts",
  title: "Alerts",
  menu: [], // the bell lives in the Shell header, not the menu (T5)
  permissions: [],
  subscriptions: [{ event: "escalation.triggered", consumer: "kernel.alerts" }],
};
