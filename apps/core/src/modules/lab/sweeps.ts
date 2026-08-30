import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  labItems, labOrderables, labSlaBreaches, labSpecimenItems, labSpecimens, orderItems,
  workflowInstances,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { LIVE_ITEM_STATUSES } from "../../kernel/orders/transitions";
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
  /** Items whose cancellation ROLLED BACK. They stay `recollection_pending` for the next run. */
  failed: { orderItemId: string; reason: string }[];
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
  const report: NonReturnSweepReport = { cancelled: [], creditNotes: [], failed: [] };

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
      /** LIVE work — a recollection opened after accession is `in_progress` (pass 1 CRITICAL 1). */
      inArray(orderItems.status, [...LIVE_ITEM_STATUSES]),
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
     * ═══ ONE TRANSACTION PER ITEM, AND THE CREDIT NOTE IS **INSIDE** IT ═══
     *
     * **Close review pass 1, CRITICAL 2.** This loop used to commit the cancellation and then issue
     * the credit note on a SEPARATE transaction, defending the split with "a consequence that fails
     * is a worklist item, not a reason to un-cancel". **There is no worklist.** `report` is an
     * in-memory value the scheduler discards, and the sweep's own re-drive query cannot recover the
     * item: `due` requires `recollection_pending` AND a live item, and the committed cancellation
     * has just set both to `cancelled`. So any throw between the two — a dropped connection, a
     * SIGTERM mid-deploy, a missing credit-note series for the financial year, a deadlock, a
     * counter's `correction` note already over that line — left the item **cancelled, unrefunded,
     * and invisible to every subsequent run**. The credit-note-series case is deterministic: it
     * would have stranded one patient's money per day, for ever, with a throwing job as the only
     * symptom.
     *
     * Atomic is the honest shape here precisely BECAUSE there is nowhere to write an obligation:
     * a billing refusal now rolls the cancellation back, the item stays `recollection_pending`, and
     * tomorrow's run retries it. A permanently-failing note means the item is never cancelled —
     * loudly, and still visible — which is the failure a hospital can act on.
     *
     * `issueCreditNote` is `Db`-first and opens its own `withTx`, so it nests as a SAVEPOINT on this
     * transaction exactly as `issueInvoice` does at the desk (F7, probed against Postgres).
     *
     * The per-item try/catch is the other half: one item's billing refusal must not abort the batch
     * behind it, which was the second way this loop lost work.
     */
    let creditNoteId: string | null = null;
    try {
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

      /**
       * DD7 — THE MONEY GOES BACK, in the SAME atom as the cancellation. The hospital charged for
       * this test at the desk (DD6) and has just decided it will never do it.
       */
      if (item.invoiceId && item.invoiceLineId) {
        const note = await issueCreditNote(tx as unknown as Db, actor, {
          kind: "refund",
          invoiceId: item.invoiceId,
          reason: `lab test cancelled: no recollection within ${NON_RETURN_DAYS} days`,
          lines: [{ invoiceLineId: item.invoiceLineId, qty: 1 }],
        });
        creditNoteId = note.creditNoteId;
      }
      });
      /** Pushed AFTER the commit — a COMMIT failure must not report a note that rolled back. */
      if (creditNoteId !== null) {
        report.creditNotes.push({ orderItemId: item.orderItemId, creditNoteId });
      }
      report.cancelled.push({
        orderItemId: item.orderItemId,
        specimenNo: specimenNoByItem.get(item.orderItemId) ?? "",
      });
    } catch (e) {
      /**
       * ONE ITEM'S REFUSAL IS NOT THE BATCH'S. Recorded and carried, so the remaining items are
       * still swept and tomorrow's run retries this one from a state it can still see.
       */
      report.failed.push({
        orderItemId: item.orderItemId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }

  }

  /**
   * ═══ AND THE BATCH ESCALATES — close review pass 2, finding 2 ═══
   *
   * The per-item catch is right: one billing refusal must not abort the items behind it. But
   * swallowing it moved the failure from the channel that is MONITORED to the one that is
   * discarded. `scheduler.ts` catches a throwing run, writes an ERROR heartbeat and appends
   * `sweep.failed`, and `alerts.yml` carries both lab jobs in the staleness and `absent()` chains
   * (F19) — while `jobs.ts` drops this function's return value on the floor. So a deterministic
   * failure (no `credit_note` series for the new financial year, say) would have refunded nobody,
   * for ever, with a green heartbeat and no page. The first remediation's header claimed the
   * failure would be "loud, and still visible"; it was neither.
   *
   * Throwing AFTER the loop keeps both properties: every item is still attempted, and the
   * scheduler's existing alerting does the escalating.
   */
  if (report.failed.length > 0) {
    throw new Error(
      `sweepLabNonReturn: ${report.failed.length} of ${due.length} items could not be cancelled ` +
        `and refunded — ${report.failed.map((f) => `${f.orderItemId}: ${f.reason}`).join("; ")}`,
    );
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
      inArray(orderItems.status, [...LIVE_ITEM_STATUSES]),
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
      /**
       * ═══ ONCE PER *ENTRY*, NOT ONCE PER STAGE EVER — close review pass 2, finding 3 ═══
       *
       * `lab_sla_breaches_item_stage_ux` is `(item, stage)`, and the first pass reported this as
       * needing a migration. It does not: the row already carries `due_at`, and a RE-ENTERED stage
       * has a strictly later one, so an upsert guarded on `due_at` distinguishes "already told you
       * about this breach" from "this stage was entered again and breached again".
       *
       * It matters now in a way it did not before, and CRITICAL 1's fix is why: reject → redraw →
       * reject again is the ordinary difficult-draw case, and `recollection_pending` carries a
       * 24-hour ACTIVE escalation to `lab_reception`. Without this, the patient who was stuck twice
       * is exactly the one nobody is paged about.
       */
      .onConflictDoUpdate({
        target: [labSlaBreaches.orderItemId, labSlaBreaches.stage],
        set: { dueAt, breachedAt: now, notified: false },
        setWhere: lt(labSlaBreaches.dueAt, dueAt),
      })
      .returning({ id: labSlaBreaches.id });
    /** No row back ⇒ this exact breach was already announced. The second sweep says nothing. */
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
