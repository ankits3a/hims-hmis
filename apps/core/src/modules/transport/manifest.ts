import { TRANSPORT_MANAGE, TRANSPORT_REQUEST, TRANSPORT_WORK } from "./names";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E1.6 TRANSPORT (issue #723, decision 0072) — three permissions, two menu entries, no subscription.
 *   · `transport.request` — ask for a patient move, a sample run or a document run (front office, the nursing roles,
 *     the duty manager);
 *   · `transport.work` — the porter's transport details and acts beside "My tasks" (support staff);
 *   · `transport.manage` — the supervisor's transport board (services supervisor, duty manager).
 * API ONLY: the worker imports the module for its task kinds (the task clock needs their windows) but installs nothing.
 */
export { TRANSPORT_MANAGE, TRANSPORT_REQUEST, TRANSPORT_WORK };

export const transportManifest: ModuleManifest = {
  key: "transport",
  title: "Transport",
  // The authoritative pairing `apps/web/src/router.tsx`'s NAV copies (test/nav-parity.test.ts): the board, and the
  // request sheet.
  menu: [
    { label: "Transport", path: "/transport", permission: TRANSPORT_MANAGE },
    { label: "Request porter", path: "/transport/request", permission: TRANSPORT_REQUEST },
  ],
  permissions: [TRANSPORT_REQUEST, TRANSPORT_WORK, TRANSPORT_MANAGE],
  subscriptions: [],
};
