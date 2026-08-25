import type { ModuleManifest } from "../../kernel/modules/manifest";
import { PARTNERS_ACCRUAL_CONSUMER } from "./consumer";

/**
 * The partners module's declared surface (spec §4).
 *
 * ═══ THE FOUR SUBSCRIPTIONS, LANDED BY T6 WITH THEIR HANDLER IN ONE COMMIT (§6.0 S2, DD7) ═══
 *
 * DD7 requires the accrual consumer to register ALWAYS — four events, unconditionally — so that a
 * later flag flip replays from a cursor that has been advancing all along rather than starting at
 * `now`. Registering conditionally is check-on-execute wearing a manifest's clothes, and it is
 * silently lossy: a subscription that never registered has no `event_cursors` row, so everything
 * before the flip is gone. The flag decides only whether the handler WRITES (`consumer.ts`).
 *
 * T1 shipped this manifest with `subscriptions: []` and installed it APP-SIDE ONLY, because
 * `buildSubscriptionBus` (kernel/worker/jobs.ts) turns a DECLARED subscription with no matching
 * handler into a BOOT ERROR and the handler lives in `workerConsumers` — a file T1 could not
 * touch. **T6 lands the other half as ONE commit** — these four names, the handler in
 * `workerConsumers(db)`, the worker's `registry.install(partnersManifest)` and the
 * `kernel/modules/manifests.test.ts` census — which is the Plan 10 D13 lesson: ship the install
 * without the handler and the worker throws at startup; ship the handler without the install and
 * the lane hears nothing at all, behind a fully green suite.
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
  /**
   * DD7's FOUR names, and §3 Q4 is why it is four rather than two. `reverseAllocation` and
   * `markEnteredInError` both emit `allocation.reversed` and NEITHER emits a refund event, so a
   * consumer subscribed to the two payment names accrues on a payment and never gives it back when
   * that payment is reversed — measured, not predicted. `credit_note.issued` changes what is
   * SETTLEABLE, which moves the ratio DD12's base is built on. Under delta-to-target the handler
   * does not branch on which one arrived: all four re-read the invoice and append the difference.
   */
  subscriptions: [
    { event: "payment.received", consumer: PARTNERS_ACCRUAL_CONSUMER },
    { event: "payment.refunded", consumer: PARTNERS_ACCRUAL_CONSUMER },
    { event: "allocation.reversed", consumer: PARTNERS_ACCRUAL_CONSUMER },
    { event: "credit_note.issued", consumer: PARTNERS_ACCRUAL_CONSUMER },
  ],
};
