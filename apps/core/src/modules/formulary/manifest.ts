import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The formulary module's declared surface (spec §1, plan DD10).
 *
 * ═══ THE THREE PERMISSIONS ARE DECLARED HERE, AHEAD OF EVERY ROUTE THAT GUARDS ON THEM ═══
 *
 * `scripts/seed-roles.ts` and `test/seed-roles.test.ts` hold a REACHABILITY INVARIANT — every
 * declared permission is granted to a role or entered in `NOT_YET_MODELLED` with a reason — plus a
 * census pin and a README parity table compared cell for cell, both directions. All three files
 * are named in T2's Files list and in NO later task's, so a permission first declared by T7 or T8
 * would fail the build for a task that is not allowed to fix it. Every `formulary.*` string this
 * phase needs is therefore here now. (That the Files list originally named none of those three is
 * finding F1 in the phase document; this comment is the other half of the fix.)
 *
 * ═══ WHO HOLDS THEM (DD10) ═══
 *
 *   · `formulary.read`           → `doctor` and `pharmacy`. The spec's words are *read for any
 *     prescriber*; T6's consult autocomplete cannot work without it, and a pharmacist who may not
 *     read the formulary cannot verify what they dispense.
 *   · `formulary.manage`         → `pharmacy`.
 *   · `formulary.staging.review` → `pharmacy`. The spec says *pharmacist-gated*, twice (§1.1).
 *
 * **This mints live authority to nobody today, and that is measured rather than hoped:**
 * `pharmacy` is one of the three roles `seed:roles` creates with grants and no holders. The grant
 * is a door that opens the day a pharmacist account exists.
 *
 * ═══ THE MENU ENTRY POINTS AT A ROUTE T7 MOUNTS, AND THAT IS SAFE FOR A NAMED REASON ═══
 *
 * The plan puts the entry in this task and the screen in T7, so between the two commits the link
 * exists and the route does not. It is invisible in that window: the entry is gated on
 * `formulary.manage`, whose only holder is a role with no humans in it. Recorded rather than
 * quietly reordered, because "a menu link that 404s" is worth being deliberate about.
 */
export const formularyManifest: ModuleManifest = {
  key: "formulary",
  title: "Formulary — medicines, moieties and interactions",
  menu: [
    // The path matches `apps/web/src/router.tsx`'s own route exactly (the `opsManifest`
    // convention), so the permission-gated link and the screen it opens cannot drift apart.
    { label: "Formulary", path: "/formulary/admin", permission: "formulary.manage" },
  ],
  permissions: ["formulary.read", "formulary.manage", "formulary.staging.review"],
  /**
   * EMPTY AND STAYING EMPTY THIS PHASE. The formulary is check-on-execute: `resolveDrugTexts` is
   * called by the prescription pipeline at issue time (T5), not driven by the event stream. A
   * subscription here would be a consumer with nothing to consume.
   */
  subscriptions: [],
  /**
   * The 11h search seam is DECLARED and empty. A medicine provider is a natural fit — a doctor
   * typing "Augmentin" into the palette — but search results are a read surface with its own RBAC
   * and audit rules, and nothing in this phase's spec asks for one. It is left as the named
   * extension point rather than built speculatively.
   */
  search: [],
};
