import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E1.7 BIO-MEDICAL WASTE (issue #724, decision 0072) — three permissions.
 *   · `bmw.view` — the supervisor board: bags on the premises with their 48-hour clocks, today's generation, disputes.
 *   · `bmw.handle` — the handler's phone: generate a bag (prints its label), weigh, collect, store.
 *   · `bmw.manage` — hand bags over on a manifest, record the facility's weights, close disputes, the legal reports.
 * No subscription. The storage clock (`sweepBmwStorage`) rides the task clock's job and needs no permission, so the
 * manifest is installed in the API only (the `tasks` shape).
 */
export const BMW_VIEW = "bmw.view";
export const BMW_HANDLE = "bmw.handle";
export const BMW_MANAGE = "bmw.manage";

export const bmwManifest: ModuleManifest = {
  key: "bmw",
  title: "Bio-medical waste",
  menu: [
    { label: "Waste bags", path: "/bmw/handle", permission: BMW_HANDLE },
    { label: "Waste board", path: "/bmw", permission: BMW_VIEW },
    { label: "Waste reports", path: "/bmw/reports", permission: BMW_MANAGE },
  ],
  permissions: [BMW_VIEW, BMW_HANDLE, BMW_MANAGE],
  subscriptions: [],
};
