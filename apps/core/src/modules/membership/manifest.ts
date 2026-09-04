import { instrumentSearchProvider } from "./search-providers";
import { membershipSchemesDeskProvider } from "./desk-provider";
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
  /*
    FD-11 — the three scheme counts the dashboard's "Schemes in play" band renders. Declared here
    beside the permission that guards them, like every other desk provider: the kernel refuses a
    card gated on a permission this manifest does not declare (`collectDeskProviders`).
  */
  desk: [membershipSchemesDeskProvider],
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
    /**
     * RC-2 T4 / D5 — THE OTHER HALF OF THE COUNTER'S AUTHORITY.
     *
     * `recognise` is APPLY and the clerk holds it. This is ENROL, and the clerk must not: the
     * Registration Counter handoff rules that "this seat applies membership benefits and cannot
     * enrol — enrolment is the front-office manager", and calls it a ruling rather than a UX
     * nicety. Granted to `front_office_supervisor` and `membership_admin` ONLY.
     *
     * It guards a real route (`POST /membership/instruments/enrol`) which refuses on
     * `MEMBERSHIP_SALES_ENABLED` while owner ruling O-15 is open — a locked door, which is a
     * different thing from `membership.catalog.manage`'s no door at all.
     */
    "membership.instrument.enrol",
    "membership.grace_honor.request",
    "membership.grace_honor.approve",
    /**
     * PLAN 09 CLOSE, 2026-08-26 — TWO OF THESE GUARD NO ROUTE, AND THAT IS RECORDED RATHER THAN
     * QUIETLY TIDIED.
     *
     * Found by the roles/access lane's standing check (its relay §2: *a permission is the last
     * mile of something, and four times it was the only mile*). Measured here by grepping each
     * string across `apps/core/src` excluding this file and tests:
     *
     *   · `membership.catalog.manage`     — 0 occurrences. There is no catalog-management route in
     *     Plan 09 AT ALL, and that is DD3 working as intended: plans, coupons, partners and
     *     agreements are DATA seeded at commissioning, not a screen. The permission names a
     *     surface a later phase builds. It sits in NOT_YET_MODELLED, so nobody holds it.
     *   · `membership.grace_honor.approve` — 0 occurrences, and this one is GRANTED by DD18. The
     *     grace-honor decision is actually gated by the approvals engine, whose
     *     `membership_grace_honor` type names `billing_manager` as `approverRole` — so this string
     *     is a second gate that no route consults. **It mints authority that unlocks nothing.**
     *
     * NEITHER IS REMOVED HERE. Removing a declared permission moves seven censuses, the README
     * parity pairs and the role model, and this phase's independent review has not run yet — a
     * close remediation is not the moment to churn the thing the reviewer is about to read.
     * Both are named in the phase document's CLOSE as routed work.
     */
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
