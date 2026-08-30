import { eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { labItems, labResults, orderItems, workflowInstances } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { transition, WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, cashThresholdBlocked, issueCreditNote } from "../billing";
import { deskOrder } from "./desk";
import { LabError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { OrderItemOrigin } from "../../kernel/db/schema/orders";
import type { DeskOrderInput, DeskOrderResult } from "./desk";

/**
 * PLAN 17b T7 / DD7, DD6 — **THE MONEY**, and it is the reviewer's first file for that reason.
 *
 * Two rules live here and nothing else does:
 *
 *   1. **What a cancelled lab test costs** (DD7 / 02 O-4), read from `order_items.cancelled_from`
 *      and the existence of a result row — the two facts 17a's F30 recorded as written-but-unread.
 *   2. **The §269ST cash refusal reaches the audit log** (17a §9.2 F27), which it does not today
 *      through `deskOrder`'s cast, and which is this phase's to fix because this phase wires the
 *      receipt path.
 *
 * ═══ DD7, IN THREE LINES, AND THE MIDDLE ONE IS THE MONEY CLAIM ═══
 *
 *   · cancelled from `placed`      → the tube was never drawn      → CREDIT NOTE for that line
 *   · cancelled from `in_progress`, a result EXISTS → the lab did the work → **NO credit note**
 *   · cancelled from `in_progress`, no result       → nothing was produced → CREDIT NOTE
 *
 * The legacy rule an Indian laboratory works to is *"no pathology refund once the result is
 * saved"*, and the mutant that ignores `cancelled_from` refunds all three. That is not a rounding
 * difference: it hands back the price of every test the laboratory actually ran and then had
 * withdrawn, silently, on the ordinary clinical path.
 *
 * ═══ AND ONE PLACE THIS RULE IS WRITTEN TWICE, DISCLOSED RATHER THAN SILENTLY LEFT (§9.2 F35) ═══
 *
 * `sweeps.ts`'s seven-day non-return sweep issues its own credit note inline (17a T5). Its items
 * are always at `recollection_pending` with no result row, so it is a strict SUBSET of leg 3 and
 * the two agree today — but they are two copies of one rule (§2.54's mechanism) and `sweeps.ts` is
 * frozen for this phase (§8). Every path this phase adds goes through `refundOnCancel`.
 */

export type LabChargeReason = "lab_desk" | "lab_reflex" | "lab_addon" | "lab_walkin" | "package";

/**
 * The `lab_items.charge_reason` an item is created with, from the ENVELOPE's own origin.
 *
 * It exists as a named function rather than as four literals at four call sites because 26's
 * package is written against `charge_reason = 'package'` meaning *"DD7's refund rule is not
 * yours"* — and a fifth writer that spelled the string inline would silently opt a package line
 * into a refund policy it does not have.
 */
export function chargeReasonFor(origin: OrderItemOrigin, walkIn = false): LabChargeReason {
  if (origin === "reflex") return "lab_reflex";
  if (origin === "addon") return "lab_addon";
  return walkIn ? "lab_walkin" : "lab_desk";
}

export type RefundOutcome = {
  orderItemId: string;
  cancelledFrom: string;
  /** True when the laboratory had already produced a number, which is what stops the refund. */
  workDone: boolean;
  creditNoteId: string | null;
  creditedPaise: number;
  reason: string;
};

/**
 * DD7 — WHAT COMES BACK WHEN A LAB TEST IS CALLED OFF.
 *
 * Runs on the CALLER'S transaction and is invoked SYNCHRONOUSLY by every lab cancel path this
 * phase adds — never by a subscription to `order_item.cancelled`. The lab is the only writer that
 * cancels lab items, so a subscription would be a second answer to a question this function
 * already answers, and it would answer it after the cancel had committed: an item cancelled and a
 * refund that failed afterwards is money the patient is owed and nobody can see.
 */
export async function refundOnCancel(
  tx: Tx,
  actor: Actor,
  orderItemId: string,
  now: Date = new Date(),
): Promise<RefundOutcome> {
  const [item] = await tx
    .select({
      status: orderItems.status,
      cancelledFrom: orderItems.cancelledFrom,
      cancelReason: orderItems.cancelReason,
      invoiceId: labItems.invoiceId,
      invoiceLineId: labItems.invoiceLineId,
      chargeReason: labItems.chargeReason,
    })
    .from(orderItems)
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .where(eq(orderItems.id, orderItemId));
  if (!item) throw new LabError("unknown_item", `no lab order item ${orderItemId}`);

  /**
   * THE REFUND IS A CONSEQUENCE OF A CANCELLATION, NOT AN INSTRUMENT OF ITS OWN. Called against a
   * live item it would credit a line the laboratory is still working on, so it refuses by name
   * rather than returning "nothing to do" — a caller that reached here in error must find out.
   */
  if (item.status !== "cancelled" || item.cancelledFrom === null) {
    throw new LabError(
      "item_not_cancellable",
      `order item ${orderItemId} is ${item.status} — DD7's refund is what a CANCELLATION costs, ` +
        "and there has not been one",
    );
  }

  /**
   * ═══ 26's PACKAGE IS NOT DD7's, AND IT SAYS SO ON THE ROW ═══
   *
   * A package line is billed as one document covering many tests; crediting one of its lines would
   * refund a fraction of a price nobody charged that way. Plan 26 owns that rule and this function
   * declines to invent it.
   */
  if (item.chargeReason === "package") {
    return {
      orderItemId, cancelledFrom: item.cancelledFrom, workDone: false,
      creditNoteId: null, creditedPaise: 0,
      reason: "a package line's refund is Plan 26's rule, not DD7's",
    };
  }

  /**
   * ═══ THE FACT THAT DECIDES IT: DOES A RESULT ROW EXIST FOR THIS ITEM? ═══
   *
   * ANY row, verified or not. The laboratory consumed the reagent and ran the sample the moment a
   * number was keyed; a signature is a separate act about releasing it. Counting only VERIFIED rows
   * would refund every test cancelled between the bench and the pathologist, which is the window
   * an argumentative patient is most likely to be standing in.
   */
  const produced = item.cancelledFrom === "in_progress"
    ? await tx.select({ id: labResults.id }).from(labResults)
        .where(eq(labResults.orderItemId, orderItemId)).limit(1)
    : [];
  const workDone = produced.length > 0;

  if (workDone) {
    return {
      orderItemId, cancelledFrom: item.cancelledFrom, workDone: true,
      creditNoteId: null, creditedPaise: 0,
      reason: "the laboratory had already produced a result — the charge stands (02 O-4)",
    };
  }
  if (!item.invoiceId || !item.invoiceLineId) {
    return {
      orderItemId, cancelledFrom: item.cancelledFrom, workDone: false,
      creditNoteId: null, creditedPaise: 0,
      reason: "the item carries no invoice line — nothing was charged for it",
    };
  }

  /**
   * `issueCreditNote` is `Db`-first and opens its own `withTx`; on a `Tx` that is a SAVEPOINT, so
   * the note participates in the caller's transaction and an outer rollback takes it with the
   * cancellation (17a §9.2 F7, proved by execution there). The cast is the shipped house pattern.
   */
  const note = await issueCreditNote(tx as unknown as Db, actor, {
    kind: "refund",
    invoiceId: item.invoiceId,
    reason: `lab test cancelled from ${item.cancelledFrom}: ${item.cancelReason ?? "no reason recorded"}`,
    lines: [{ invoiceLineId: item.invoiceLineId, qty: 1 }],
  }, now);

  return {
    orderItemId, cancelledFrom: item.cancelledFrom, workDone: false,
    creditNoteId: note.creditNoteId, creditedPaise: note.netPaise,
    reason: item.cancelledFrom === "placed"
      ? "cancelled before the tube was drawn"
      : "cancelled after the tube reached the bench, with no result produced",
  };
}

export type CancelLabItemInput = { orderItemId: string; reason: string };

/**
 * CANCEL AND REFUND AS ONE ATOM — the desk's cancel and the pathologist's cancel both come here.
 *
 * The two halves are deliberately not separable at the API. 17a's `sweeps.ts` records at length
 * what happened when they were: the cancel committed and the credit note was attempted afterwards,
 * so any throw between them left the item *"cancelled, unrefunded, and invisible to every
 * subsequent run"*. `advanceOrderItem` performs the authorisation (it is the envelope's own
 * writer), so there is no second permission check here — a cancel that was allowed and a refund
 * that was refused is the failure mode this shape exists to make unrepresentable.
 */
export async function cancelLabItem(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: CancelLabItemInput,
  now: Date = new Date(),
): Promise<{ cancelledFrom: string; labInstanceState: string | null; refund: RefundOutcome }> {
  /**
   * ═══ THE PERMISSION GATE IS HERE BECAUSE `advanceOrderItem` DELIBERATELY HAS NONE FOR A USER ═══
   *
   * `assertActorMayAdvance` gates `agent` and `patient` actors by TYPE and lets every `user`
   * through — the kernel's own comment says "staff and the application's own automated moves", and
   * the surface is expected to gate. 17a mounted no surface, so this is the first lab writer that
   * has to; leaving it to T8's controller alone would mean the one caller that forgot became the
   * hole, which is 22c-A's C1 in a different costume.
   */
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not cancel a lab test`);
  }
  if (!(await hasPermission(tx as unknown as Db, actor.id, "orders.cancel", "hospital"))) {
    throw new LabError("permission_denied", "cancelling a lab test requires orders.cancel");
  }

  const moved = await advanceOrderItem(tx, actor, decls, input.orderItemId, "cancelled", {
    reason: input.reason, at: now,
  });

  /**
   * ═══ THE LAB'S OWN MACHINE FOLLOWS THE ENVELOPE WHERE IT CAN — AND §9.2 F37 IS WHERE IT CANNOT ═══
   *
   * `LAB_ITEM_DEFINITION_JSON` declares a `→ cancelled` edge from `ordered`, `awaiting_collection`,
   * `collected`, `accessioned`, `in_analysis` and `recollection_pending` — and from **neither
   * `resulted` nor `verified`**. So DD7's own middle leg, *cancelled from `in_progress` with a
   * result already keyed*, is a state the lab machine cannot legally leave.
   *
   * `workflow-def.ts` is 17a's and §8 freezes it: *"a needed change there is a finding"*. This is
   * that finding (F37), and the behaviour it forces is stated rather than hidden:
   *
   *   · the ENVELOPE is cancelled and DD7's money rule is applied — both unconditionally;
   *   · the lab instance moves when the PINNED definition allows it, and is left where it stands
   *     when it does not, with the state RETURNED so no caller has to infer it.
   *
   * **Nothing reads a stale instance in isolation**: every worklist and every sweep in this module
   * keys off `order_items.status`, so an item whose envelope says `cancelled` is invisible to all
   * of them. The instance is untidy, not dangerous — and the phase that may edit `workflow-def.ts`
   * adds `resulted → cancelled` and `verified → cancelled`.
   *
   * The `catch` is narrow on purpose: `transition` validates the declared edge BEFORE it writes
   * anything, so an `unknown_transition` leaves the transaction untouched. Every other
   * `WorkflowError` — `role_denied`, `stale_transition`, `instance_not_active` — is rethrown.
   */
  const [instance] = await tx
    .select({ id: labItems.instanceId, state: workflowInstances.currentState })
    .from(labItems)
    .innerJoin(workflowInstances, eq(workflowInstances.id, labItems.instanceId))
    .where(eq(labItems.orderItemId, input.orderItemId));
  let labInstanceState = instance?.state ?? null;
  if (instance && instance.state !== "cancelled") {
    try {
      const { state } = await transition(tx, instance.id, "cancelled", actor, { note: input.reason });
      labInstanceState = state;
    } catch (e) {
      if (!(e instanceof WorkflowError) || e.code !== "unknown_transition") throw e;
    }
  }

  const refund = await refundOnCancel(tx, actor, input.orderItemId, now);
  return { cancelledFrom: moved.from, labInstanceState, refund };
}

/* ══════════════════ F27 — THE §269ST REFUSAL REACHES THE AUDIT LOG ══════════════════ */

/**
 * ═══ THE DEFECT 17a REPORTED AND COULD NOT FIX, AND THIS IS THE PHASE THAT WIRES THE PATH ═══
 *
 * `issueInvoice` appends `billing.cash_threshold_blocked` in its OWN `catch`, on
 * `withTx(db, …)` — and its own comment says why: *"the refusal rolls its own transaction back by
 * construction, so the C-2 audit event is appended in a transaction of its own AFTER it."* That is
 * correct when `db` is a `Db`. Through the desk it is not: `deskOrder` hands `issueInvoice` its own
 * `tx as unknown as Db`, so `withTx` opens a SAVEPOINT **inside the transaction that is about to
 * roll back**, and a refusal of ₹2,10,000 in cash leaves no record anywhere.
 *
 * `modules/billing/*` is frozen for this phase (§8) and the fix does not need it: the lab is the
 * caller, the lab holds the real `Db`, and this function is where the desk's receipt path runs. The
 * shape is `printLabels`' (17a F20) — take a `Db` as well as a `Tx`, and write the audit lane on
 * the `Db`.
 *
 * **The event is billing's own, emitted by the lab, and that is deliberate.** F1 refused to put a
 * `partners.*` name in the lab's manifest for a fact partners never declared; this is the opposite
 * case — billing DECLARED this event and INTENDED to append it, and the only thing missing was a
 * handle it did not have. Re-declaring it as `lab.cash_threshold_blocked` would give one refusal
 * two names and leave billing's own reconciliation blind to the counter that actually took the
 * money. **The permanent repair is `issueInvoice` taking a `Db` beside its `Tx`**, and it belongs
 * to the next phase that may edit `modules/billing` (§9.2 F27, carried forward).
 */
type CashThresholdDetail = { episodeCashPaise?: number; thresholdPaise?: number };

export async function deskOrderAtCounter(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: DeskOrderInput,
  now: Date = new Date(),
): Promise<DeskOrderResult> {
  /**
   * THE WALK-IN'S CHARGE REASON IS DECIDED HERE, WHICH IS WHY `chargeReasonFor` IS NOT DEAD CODE.
   *
   * `deskOrder` defaults `charge_reason` to `lab_desk` for anything the caller does not name, so a
   * walk-in placed under `external_prescription` authority was being stored as a counter order —
   * and DD6's four reasons exist so 26 and 24a can tell those two apart on the row.
   */
  const withReason: DeskOrderInput = {
    ...input,
    chargeReason: input.chargeReason
      ?? (chargeReasonFor(input.itemOrigin ?? "direct", input.authority === "external_prescription") as
          DeskOrderInput["chargeReason"]),
  };
  try {
    return await withTx(db, (tx) => deskOrder(tx, actor, decls, withReason, now));
  } catch (e) {
    if (e instanceof BillingError && e.code === "cash_threshold_blocked") {
      const detail = (e.detail ?? {}) as CashThresholdDetail;
      await withTx(db, (audit) => appendEvent(audit, cashThresholdBlocked.make({
        actor,
        patientId: input.patientId,
        encounterId: input.encounterNo,
        payload: {
          patientId: input.patientId,
          episodeCashPaise: detail.episodeCashPaise ?? 0,
          thresholdPaise: detail.thresholdPaise ?? 0,
        },
      })));
    }
    throw e;
  }
}

/** The lab items on one order, with the invoice each was billed on — `interlock.ts`'s input. */
export async function billedLabLines(
  exec: Db | Tx,
  orderId: string,
): Promise<{ orderItemId: string; invoiceId: string | null; invoiceLineId: string | null; status: string }[]> {
  return (exec as Db)
    .select({
      orderItemId: labItems.orderItemId,
      invoiceId: labItems.invoiceId,
      invoiceLineId: labItems.invoiceLineId,
      status: orderItems.status,
    })
    .from(labItems)
    .innerJoin(orderItems, eq(orderItems.id, labItems.orderItemId))
    .where(eq(orderItems.orderId, orderId));
}
