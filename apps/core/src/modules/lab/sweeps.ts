import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labItems, labOrderables, labSlaBreaches, labSpecimenItems, labSpecimens, orderItems,
  workflowInstances,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { getActiveDefinition } from "../../kernel/workflow/definitions";
import { transition } from "../../kernel/workflow/instances";
import { issueCreditNote } from "../billing";
import { labSlaBreached } from "./events";
import { LAB_ITEM_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 17a T5 / DD20 — THE TWO WORKER SWEEPS.
 *
 * ═══ NEITHER SWEEP PLACES AN ORDER, AND THAT IS DD8's WHOLE ARGUMENT ═══
 *
 * Both call `advanceOrderItem` and emit; neither resolves an encounter and neither calls
 * `placeOrder`. Phase 0 §6A.1 records that the worker process registers NO encounter resolver, so
 * a placement from here would fail with `unknown_encounter` for a visit that plainly exists — the
 * right failure, and not one to route around by registering a resolver in the worker so that a
 * sweep can order blood tests on its own authority.
 *
 * ═══ BOTH TAKE `(db, now)`, WHICH IS THE SHIPPED SCHEDULER CONTRACT (S10) ═══
 *
 * `scheduler.ts` types a job as `JobRun = (now: Date) => Promise<void>` and `sweepBatchExpiry` is
 * `(db, now)`. So A4's seven-day boundary is TWO CALLS WITH TWO INSTANTS rather than a wait or a
 * test-only clock — §2.127's warning does not apply, because the seam is the signature.
 *
 * ═══ THE SYSTEM ACTOR, AND WHY IT IS ALLOWED THROUGH THE ROLE CHECK ═══
 *
 * `transition` lets a `system` actor bypass the transition's declared roles (S4) and denies an
 * `agent` outright. A sweep is the archetypal `system` caller: there is no person, and requiring
 * one would mean either a service account with a pathologist's rights or a sweep that cannot run.
 */

/** The `system` identity both sweeps act as. Distinct names, so an audit row says which sweep. */
export const LAB_NON_RETURN_ACTOR: Actor = { type: "system", id: "lab-non-return-sweep" };
export const LAB_SLA_ACTOR: Actor = { type: "system", id: "lab-sla-sweep" };

const DAY_MS = 24 * 60 * 60 * 1000;
/** DD20 — how long a patient has to come back for a redraw before the order is withdrawn. */
export const NON_RETURN_DAYS = 7;

export type NonReturnSweepReport = {
  cancelled: { orderItemId: string; specimenNo: string }[];
  creditNotes: { orderItemId: string; creditNoteId: string }[];
};

/**
 * THE SEVEN-DAY NON-RETURN SWEEP (T5 A4).
 *
 * A tube was rejected, a replacement was labelled, and the patient never came back. After seven
 * days the item is cancelled with `cancel_reason='no_recollection'` and — DD7 — the money is
 * returned, because the hospital charged for a test at the desk (DD6) and is not going to do it.
 *
 * **The boundary is measured from `state_entered_at` on the `recollection_pending` state**, which
 * is the instant `reject` moved the item, written in the same transaction as the rejection. The
 * alternative (the replacement tube's `created_at`) is the same instant today and would drift the
 * day anybody re-labels a recollection without a new rejection.
 */
export async function sweepLabNonReturn(
  db: Db,
  now: Date,
  decls: readonly OrderKindDecl[],
  actor: Actor = LAB_NON_RETURN_ACTOR,
): Promise<NonReturnSweepReport> {
  const cutoff = new Date(now.getTime() - NON_RETURN_DAYS * DAY_MS);
  const report: NonReturnSweepReport = { cancelled: [], creditNotes: [] };

  /**
   * `lt`, not `lte`: an item that entered the state EXACTLY seven days ago has not yet been waiting
   * longer than seven days. A4's two fixtures sit at −7 d 1 h and −6 d 23 h precisely so that an
   * off-by-one on this comparator changes the answer.
   */
  const due = await db
    .select({
      orderItemId: labItems.orderItemId,
      instanceId: labItems.instanceId,
      invoiceId: labItems.invoiceId,
      invoiceLineId: labItems.invoiceLineId,
      status: orderItems.status,
    })
    .from(labItems)
    .innerJoin(workflowInstances, eq(workflowInstances.id, labItems.instanceId))
    .innerJoin(orderItems, eq(orderItems.id, labItems.orderItemId))
    .where(and(
      eq(workflowInstances.defKey, LAB_ITEM_DEF_KEY),
      eq(workflowInstances.currentState, "recollection_pending"),
      lt(workflowInstances.stateEnteredAt, cutoff),
      eq(orderItems.status, "placed"),
    ));
  if (due.length === 0) return report;

  const specimenNoByItem = new Map<string, string>();
  const links = await db
    .select({ orderItemId: labSpecimenItems.orderItemId, specimenNo: labSpecimens.specimenNo })
    .from(labSpecimenItems)
    .innerJoin(labSpecimens, eq(labSpecimens.id, labSpecimenItems.specimenId))
    .where(and(
      inArray(labSpecimenItems.orderItemId, due.map((d) => d.orderItemId)),
      eq(labSpecimenItems.active, true),
    ));
  for (const l of links) specimenNoByItem.set(l.orderItemId, l.specimenNo);

  for (const item of due) {
    /**
     * ONE TRANSACTION PER ITEM, not one for the batch. A credit note that fails on item nine must
     * not undo the eight cancellations before it — the sweep runs again tomorrow and a partially
     * applied batch is the correct intermediate state, whereas an all-or-nothing batch that always
     * fails on the same row never cancels anything at all.
     */
    await withTx(db, async (tx: Tx) => {
      await transition(tx, item.instanceId, "cancelled", actor);
      await advanceOrderItem(tx, actor, decls, item.orderItemId, "cancelled", {
        at: now,
        reason: "no_recollection",
        note: `no replacement specimen drawn within ${NON_RETURN_DAYS} days`,
      });
      /** The replacement tube is withdrawn with the item: nobody is going to draw it. */
      const tubes = await tx
        .select({ specimenId: labSpecimenItems.specimenId })
        .from(labSpecimenItems)
        .where(and(
          eq(labSpecimenItems.orderItemId, item.orderItemId),
          eq(labSpecimenItems.active, true),
        ));
      for (const t of tubes) {
        await tx.update(labSpecimenItems)
          .set({ active: false })
          .where(and(
            eq(labSpecimenItems.specimenId, t.specimenId),
            eq(labSpecimenItems.orderItemId, item.orderItemId),
          ));
      }
    });
    report.cancelled.push({
      orderItemId: item.orderItemId,
      specimenNo: specimenNoByItem.get(item.orderItemId) ?? "",
    });

    /**
     * DD7 — THE MONEY GOES BACK, and it is a SEPARATE transaction on purpose. `issueCreditNote` is
     * `Db`-first and opens its own; nesting it in the cancellation would make a billing refusal
     * (an entered-in-error invoice, a note already issued) roll back a cancellation that is
     * clinically correct and independently true. The cancellation is the fact; the credit note is
     * the consequence, and a consequence that fails is a worklist item, not a reason to un-cancel.
     */
    if (item.invoiceId && item.invoiceLineId) {
      const note = await issueCreditNote(db, actor, {
        kind: "refund",
        invoiceId: item.invoiceId,
        reason: `lab test cancelled: no recollection within ${NON_RETURN_DAYS} days`,
        lines: [{ invoiceLineId: item.invoiceLineId, qty: 1 }],
      });
      report.creditNotes.push({ orderItemId: item.orderItemId, creditNoteId: note.creditNoteId });
    }
  }

  return report;
}

export type SlaSweepReport = { breached: { orderItemId: string; stage: string; dueAt: Date }[] };

/**
 * THE SLA SWEEP (T5 A8).
 *
 * ═══ IT KEEPS NO STATE, AND `lab_sla_breaches_item_stage_ux` IS WHY ═══
 *
 * "Emit once" is the hard part of any breach sweep, and the tempting implementations all keep a
 * cursor or a `notified` flag the sweep itself maintains. T1 shipped a UNIQUE on
 * `(order_item_id, stage)` instead, so the SECOND sweep's insert simply conflicts and emits
 * nothing. The sweep is therefore stateless and safe to run on two worker processes at once, which
 * is the same argument `sweepBatchExpiry` makes with its threshold array.
 *
 * ═══ FINDING F18 — THE DEFINITION CANNOT EXPRESS A PER-PRIORITY SLA ═══
 *
 * §5 T5 says the breach is measured against *"the ACTIVE definition's SLA for its priority"*.
 * `defineWorkflow`'s schema carries ONE `sla` per state and no priority dimension, so that SLA does
 * not exist as written. What is implemented: the state's SLA is the base, and a STAT item is held
 * additionally to its orderable's own `tat_minutes_stat` — the tighter of the two. That keeps a
 * STAT troponin from sharing a routine LFT's four-hour analysis window, which is the clinical
 * content of the sentence, without inventing a schema the kernel does not have.
 */
export async function sweepLabSla(
  db: Db,
  now: Date,
  actor: Actor = LAB_SLA_ACTOR,
): Promise<SlaSweepReport> {
  const report: SlaSweepReport = { breached: [] };

  const active = await withTx(db, (tx: Tx) => getActiveDefinition(tx, LAB_ITEM_DEF_KEY));
  if (!active) return report;
  const slaByState = new Map(
    active.parsed.states.filter((s) => s.sla !== undefined).map((s) => [s.name, s.sla!.minutes]),
  );

  /**
   * NEVER A CANCELLED ITEM (A8). `order_items.status = 'pending' | 'in_progress'` is the live set;
   * a cancelled test that sat three days in `awaiting_collection` before somebody withdrew it is
   * not an SLA breach, it is a withdrawn order, and paging a pathologist about it is how an
   * alerting channel gets muted.
   */
  const live = await db
    .select({
      orderItemId: labItems.orderItemId,
      priority: labItems.priority,
      currentState: workflowInstances.currentState,
      stateEnteredAt: workflowInstances.stateEnteredAt,
      orderId: orderItems.orderId,
      tatMinutesStat: labOrderables.tatMinutesStat,
    })
    .from(labItems)
    .innerJoin(workflowInstances, eq(workflowInstances.id, labItems.instanceId))
    .innerJoin(orderItems, eq(orderItems.id, labItems.orderItemId))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, labItems.serviceId))
    .where(and(
      eq(workflowInstances.defKey, LAB_ITEM_DEF_KEY),
      inArray(orderItems.status, ["placed", "in_progress"]),
      isNotNull(workflowInstances.stateEnteredAt),
    ));

  for (const item of live) {
    const base = slaByState.get(item.currentState);
    if (base === undefined) continue; // a terminal state carries no SLA, by construction

    const minutes = item.priority === "stat" && item.tatMinutesStat !== null
      ? Math.min(base, item.tatMinutesStat)
      : base;
    const dueAt = new Date(item.stateEnteredAt!.getTime() + minutes * 60_000);
    if (dueAt.getTime() > now.getTime()) continue;

    const inserted = await db
      .insert(labSlaBreaches)
      .values({
        id: newId(), orderItemId: item.orderItemId, stage: item.currentState,
        dueAt, breachedAt: now, notified: false,
      })
      .onConflictDoNothing({ target: [labSlaBreaches.orderItemId, labSlaBreaches.stage] })
      .returning({ id: labSlaBreaches.id });
    /** Already recorded for this (item, stage) — the second sweep says nothing. */
    if (inserted.length === 0) continue;

    await withTx(db, (tx: Tx) => appendEvent(tx, labSlaBreached.make({
      actor,
      correlationId: item.orderId,
      payload: {
        orderItemId: item.orderItemId, orderId: item.orderId, stage: item.currentState,
        dueAt: dueAt.toISOString(), breachedAt: now.toISOString(), priority: item.priority,
      },
    })));
    report.breached.push({ orderItemId: item.orderItemId, stage: item.currentState, dueAt });
  }

  return report;
}
