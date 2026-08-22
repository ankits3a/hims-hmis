import type { ModuleManifest } from "../modules/manifest";

/**
 * The `ops` §4 manifest. `kernel/ops` is kernel code that carries a manifest for the same reason
 * `kernel/alerts` does — the §4 seam is where permissions and menu entries are DECLARED, and a
 * route guarding on a permission no manifest declares is a route `syncPermissions` leaves
 * unreachable by every role forever (no `permissions` row → `grantPermissionToRole` refuses it
 * outright).
 *
 * ALL THREE PERMISSIONS ARE DECLARED NOW, INCLUDING THE TWO THIS TASK'S ROUTES DO NOT YET USE.
 * `ops.downtime.generate` guards T4's kit routes and `ops.interface.manage` guards T3's
 * registration routes, in LATER waves of this same plan. Declaring them here is not speculation:
 * they are named in the plan's own task sections, and the alternative — each wave editing the
 * manifest again — buys nothing and risks exactly the unreachable-permission failure above if a
 * wave forgets. `syncPermissions` mirrors this at boot; no new boot-time DB call.
 *
 * `subscriptions` IS EMPTY, and that is not an oversight. The one ops event a consumer listens for
 * is `ops.mode_changed`, and its subscription belongs to `alertsManifest` (T1, D4) because the
 * SUBSCRIBER declares subscriptions — `{ event, consumer }` names the consumer, and the consumer
 * is `kernel.alerts`. Declaring it here as well would deliver every mode change twice.
 *
 * THE MENU IS TWO ENTRIES, both `ops.mode.set`-and-`ops.downtime.generate`-gated respectively.
 * `GET /ops/mode` mints NO read permission: every screen's banner reads the current mode, so a
 * read permission would have to be held by every seeded role — the exact trap `alerts/manifest.ts`
 * records ("the cashier holds no tariff.read"). The mode read is authenticated-only.
 */
export const OPS_MODE_SET = "ops.mode.set";
export const OPS_DOWNTIME_GENERATE = "ops.downtime.generate";
export const OPS_INTERFACE_MANAGE = "ops.interface.manage";

export const opsManifest: ModuleManifest = {
  key: "ops",
  title: "Operations — operating mode, interfaces, downtime kit",
  menu: [
    { label: "Operating mode", path: "/ops/mode", permission: OPS_MODE_SET },
    { label: "Downtime kit", path: "/ops/downtime-kit", permission: OPS_DOWNTIME_GENERATE },
  ],
  permissions: [OPS_MODE_SET, OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE],
  subscriptions: [],
};
