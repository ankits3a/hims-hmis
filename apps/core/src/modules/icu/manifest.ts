import { ICU_CARE, ICU_DECIDE, ICU_MANAGE, ICU_REQUEST, ICU_VIEW } from "./permissions";
import type { ModuleManifest } from "../../kernel/modules/manifest";

export { ICU_CARE, ICU_DECIDE, ICU_MANAGE, ICU_REQUEST, ICU_VIEW };

/**
 * ICU IC-1 (#984, decision 0090) — five permissions, five menu entries, no subscription. Dark behind `HMIS_MODULES_ON`
 * (decision 0085) like the rest of the IPD train. The worker's one job (`sweepIcuAlarms`, every 10 s: the alarm ladder,
 * feed gaps, links whose stay ended, bundles due, partitions) is registered in `kernel/worker/jobs.ts` and needs no
 * manifest in the worker, so the manifest is installed in the API only (the `bmw` shape).
 */
export const icuManifest: ModuleManifest = {
  key: "icu",
  title: "ICU",
  // The authoritative pairing `apps/web/src/router.tsx`'s NAV copies (test/nav-parity.test.ts).
  menu: [
    { label: "ICU station", path: "/icu", permission: ICU_VIEW },
    { label: "ICU my beds", path: "/icu/my-beds", permission: ICU_CARE },
    { label: "ICU requests", path: "/icu/requests", permission: ICU_VIEW },
    { label: "ICU night view", path: "/icu/night", permission: ICU_DECIDE },
    { label: "ICU in-charge", path: "/icu/incharge", permission: ICU_MANAGE },
  ],
  permissions: [ICU_VIEW, ICU_REQUEST, ICU_DECIDE, ICU_CARE, ICU_MANAGE],
  subscriptions: [],
};
