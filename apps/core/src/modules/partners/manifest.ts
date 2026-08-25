import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The partners module's declared surface (spec §4).
 *
 * ═══ `subscriptions` IS EMPTY, AND EMPTYING IT IS NOT AN OVERSIGHT (§6.0 S2, DD7) ═══
 *
 * DD7 requires the accrual consumer to register ALWAYS — four events, unconditionally, so that a
 * later flag flip replays from a cursor that has been advancing all along rather than starting at
 * `now`. But `buildSubscriptionBus` (kernel/worker/jobs.ts) turns a DECLARED subscription with no
 * matching handler into a BOOT ERROR, and the handler lives in `workerConsumers` — a file this
 * task may not touch. Declaring the four here would stop the worker at startup for as long as it
 * took T6 to land.
 *
 * So the seam ships and the later task fills it (§2.47): **T6 adds the four subscriptions, the
 * handler, the worker install and the manifests census in ONE commit** — the Plan 10 D13 lesson —
 * and until then this manifest is installed APP-SIDE ONLY. `kernel/modules/manifests.test.ts`
 * records that in as many words, beside the two differences the worker's registry already has.
 *
 * ═══ THE SEVEN PERMISSIONS ARE ALL ENTERED IN `NOT_YET_MODELLED` (DD18) ═══
 *
 * Every one of them guards a partner-facing lane that ships structurally OFF pending the owner's
 * O-8 ruling, no role model for any of them is published anywhere, and the pilot's partners and
 * agreements are seeded by script rather than maintained by a human at a route (DD3). Granting
 * them now would mint authority nobody has asked for, on a trust hospital, for routes that refuse
 * to do anything. They are declared HERE, ahead of T6/T7/T8's routes, because `seed-roles.ts` and
 * its reachability invariant are named in T1's Files list and in no later task's (§6.0 S9).
 *
 * `menu` is filled by the tasks that ship screens (T7's receivables, T8's channel P&L).
 */
export const partnersManifest: ModuleManifest = {
  key: "partners",
  title: "Channel partners — agreements, commissions and receivables",
  menu: [],
  permissions: [
    "partners.counterparty.manage",
    "partners.agreement.manage",
    "partners.attribution.issue",
    "partners.ledger.read",
    "partners.statement.import",
    "partners.receivable.operate",
    "partners.pnl.read",
  ],
  // EMPTY UNTIL T6 — see the header. The four DD7 names land with their handler, never before it.
  subscriptions: [],
};
