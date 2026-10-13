import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E2.4 LINEN (issue #728, decision 0072) — three permissions.
 *   · `linen.view` — the supervisor board: wards below par, laundry out and in, infected batches, weekly loss.
 *   · `linen.handle` — the handler's phone: top up, soiled and infected returns, ward counts, laundry out and in,
 *     borrowing between wards, and raising a condemn request.
 *   · `linen.manage` — set a ward's par over the computed one, approve or reject a condemn request (never one's own).
 * No subscription and no worker job (the weekly variance is computed on read), so the manifest is installed in the API
 * only (the `tasks` shape).
 */
export const LINEN_VIEW = "linen.view";
export const LINEN_HANDLE = "linen.handle";
export const LINEN_MANAGE = "linen.manage";

export const linenManifest: ModuleManifest = {
  key: "linen",
  title: "Linen",
  menu: [
    { label: "Linen counts", path: "/linen/handle", permission: LINEN_HANDLE },
    { label: "Linen board", path: "/linen", permission: LINEN_VIEW },
  ],
  permissions: [LINEN_VIEW, LINEN_HANDLE, LINEN_MANAGE],
  subscriptions: [],
};
