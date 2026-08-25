import { instrumentSearchProvider } from "./search-providers";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The membership module's declared surface (spec §4).
 *
 * ═══ THE SEVEN PERMISSIONS ARE THE WHOLE PHASE'S, DECLARED HERE AHEAD OF THEIR ROUTES ═══
 *
 * `scripts/seed-roles.ts` and `test/seed-roles.test.ts` hold a REACHABILITY INVARIANT — every
 * declared permission is granted to a role or entered in `NOT_YET_MODELLED` with its reason — and
 * both files are named in T1's Files list and in no other task's (§6.0 S9). So a permission
 * declared later in this phase would fail the build for a task that is not allowed to fix it.
 * Every `membership.*` string this phase will need is therefore declared NOW, and T3's and T5's
 * routes guard on strings that already exist.
 *
 * DD18 rules who holds them: the counter's three go to the desks that already register patients
 * and issue invoices, the approval goes with the role that already approves every other billing
 * exception, and the catalog/import/queue three are entered as not-yet-modelled — no role model
 * for them is published anywhere, the pilot's catalogs are seeded by script rather than maintained
 * by a human at a route (DD3), and granting them now would mint authority nobody has asked for on
 * a trust hospital.
 *
 * `menu` is filled by the tasks that ship screens — T3's counter surface and T5's reconcile queue,
 * both below — and `search` likewise: T3 registers the `membership.instrument` provider on the 11h
 * seam, which is why `membership.instrument.read` was declared before anything read it.
 *
 * `subscriptions` is empty and stays empty: this module is check-on-execute. The dispatcher
 * consumer in this phase belongs to `partners` (DD7).
 */
export const membershipManifest: ModuleManifest = {
  key: "membership",
  title: "Memberships, packages and coupons",
  menu: [
    // The path matches `apps/web/src/router.tsx`'s own route exactly, so a permission-gated menu
    // link and the screen it opens can never drift apart (the `opsManifest` convention).
    { label: "Card recognition", path: "/counter/instruments", permission: "membership.instrument.read" },
    // PLAN 09 T5 — the holder-book reconcile queue. `membership.reconcile.operate` is in
    // NOT_YET_MODELLED (DD18), so this entry is reachable by NOBODY until the owner grants the
    // permission: minimum authority, exactly as ruled, and T8's runbook names it beside the flags.
    { label: "Card reconcile", path: "/counter/reconcile", permission: "membership.reconcile.operate" },
  ],
  permissions: [
    // Granted by DD18 — the counter cannot function without these.
    "membership.instrument.read",
    "membership.instrument.recognise",
    "membership.grace_honor.request",
    "membership.grace_honor.approve",
    // Entered in NOT_YET_MODELLED with their reasons — see scripts/seed-roles.ts.
    "membership.catalog.manage",
    "membership.import.run",
    "membership.reconcile.operate",
  ],
  // PLAN 09 T3 — cards by code, holder phone, holder name (both scripts) or linked patient, on
  // `membership.instrument.read`. The sealed gate lives in the provider's own SQL (C1).
  search: [instrumentSearchProvider],
  subscriptions: [],
};
