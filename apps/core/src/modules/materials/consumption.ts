import { and, asc, eq, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import {
  consignmentLots, eventIdempotency, stockBatches, stockLedger,
} from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { consignmentDeployed, materialConsumed } from "./events";
import { effectiveRegulation } from "./items";
import { postMovement } from "./ledger";
import { mrpPerBaseUnit } from "./uom";
import { itemUomRows } from "./items";
import type { Handler, DispatchedEvent } from "../../kernel/events/subscriptions";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/** The consumer key the manifest subscribes with. One string, two places, and this is the source. */
export const MATERIALS_CONSUMPTION_CONSUMER = "materials.consumption";

/**
 * PLAN 14 T7 / DD13 — **THE CONSIGNMENT CONSUMER: the interface Plan 15 is written against.**
 *
 * ═══ WHAT IT DOES, IN ONE TRANSACTION ═══
 *
 *   1. claims the event id in `event_idempotency` — a duplicate delivery stops here (A19);
 *   2. resolves the lot and REFUSES `lot_exhausted` when
 *      `received − deployed − returned` cannot cover the deployment (A20);
 *   3. appends a `consume` ledger row through `postMovement`, so the balance moves under the same
 *      ordered lock every other movement takes;
 *   4. increments `consignment_lots.qty_deployed`;
 *   5. emits `material.consumed` carrying **the price facts effective at `occurredAt`** (A21).
 *
 * ═══ IT POSTS NO CHARGE, AND THE REASON IS MEASURED RATHER THAN ASSUMED ═══
 *
 * Billing has no event-driven charge path: invoices are issued from a counter draft
 * (`invoices.ts:638`) and the daily close's `orphanScan` is the §11.11 orphan REPORT, not a poster.
 * Spike Q5 measured production at **six services, none of them a `device` or `pharmacy` category,
 * `regulated = false` on all six, and zero `regulated_prices` rows** — so there is nothing an
 * implant could be billed against even if a poster existed. Inventing one here would put a money
 * writer in the stores module.
 *
 * What this does instead is carry **every fact a charge will need**, so the day billing grows a
 * chargeables spine (§ 4A item 3) `material.consumed` is already the event it consumes. Plan 15
 * composes the day-care bill at discharge from `consumptionsFor(encounterId)`.
 *
 * ═══ THE ORDER OF THE CHECKS IS A DECISION (A20) ═══
 *
 * **The LOT check runs BEFORE the movement.** A20's mutant posts the movement first — and the plan
 * names why that is hard to catch: the movement may itself refuse `insufficient_stock` when the
 * balance is also exhausted, so the two implementations agree on the obvious fixture. The
 * discriminating fixture keeps the BALANCE ≥ 1 with a second, OWNED batch of the same item in the
 * same store, so only the LOT check can refuse — and a mutant that checked the lot afterwards would
 * have already written a ledger row for stock the vendor never sent.
 */

/** The claim key. Namespaced so it cannot collide with `appendEvent`'s own idempotency keys. */
function claimKey(eventId: string): string {
  return `${MATERIALS_CONSUMPTION_CONSUMER}:${eventId}`;
}

/**
 * Claims the event for this consumer. `true` when THIS call won the claim; `false` when the event
 * has already been handled.
 *
 * `ON CONFLICT DO NOTHING` on the primary key is the whole mechanism — the same claim-first shape
 * `appendEvent` uses, and the reason A19's duplicate leaves exactly one ledger row rather than two.
 */
async function claim(tx: Tx, eventId: string): Promise<boolean> {
  const claimed = await tx.insert(eventIdempotency)
    .values({ idempotencyKey: claimKey(eventId), eventId })
    .onConflictDoNothing({ target: eventIdempotency.idempotencyKey })
    .returning({ eventId: eventIdempotency.eventId });
  return claimed.length > 0;
}

/**
 * Handles ONE `consignment.deployed`. Exported separately from the `Handler` wrapper so a test — and
 * Plan 15 — can drive it on a caller's transaction rather than through the bus.
 */
export async function handleConsignmentDeployed(
  tx: Tx,
  actor: Actor,
  eventId: string,
  payload: unknown,
): Promise<{ handled: boolean; ledgerEntryId?: string }> {
  // The payload is PARSED, not trusted. Plan 15 imports the same object to build it, so a shape
  // mismatch is a contract break and should read as one rather than as a null dereference.
  const parsed = consignmentDeployed.payloadSchema.parse(payload) as {
    lotId: string; batchId: string; itemId: string; storeResourceId: string; qtyBase: number;
    patientId: string; encounterId: string; caseRef: { type: string; id: string };
    stickerRef?: string; occurredAt: string;
  };

  // ── 1. IDEMPOTENCY, FIRST (A19) ──
  if (!(await claim(tx, eventId))) return { handled: false };

  const occurredAt = new Date(parsed.occurredAt);

  // ── 2. THE LOT, BEFORE ANY MOVEMENT (A20) ──
  // Locked, because two scans against one lot compete for the same remaining quantity exactly as
  // two pickers compete for the last strip.
  await tx.execute(sql`select id from consignment_lots where id = ${parsed.lotId} for update`);
  const lotRows = await tx.select().from(consignmentLots).where(eq(consignmentLots.id, parsed.lotId));
  const lot = lotRows[0];
  if (lot === undefined) {
    throw new MaterialsError("unknown_document", `consignment lot ${parsed.lotId} not found`, {
      lotId: parsed.lotId,
    });
  }
  if (lot.batchId !== parsed.batchId) {
    // The pair travels in the payload so a mismatch can be REFUSED rather than trusted — one batch
    // can back several lots, and deploying against the wrong one credits the wrong vendor.
    throw new MaterialsError(
      "batch_mismatch",
      `lot ${parsed.lotId} is against batch ${lot.batchId}, not ${parsed.batchId}`,
      { lotBatchId: lot.batchId, eventBatchId: parsed.batchId },
    );
  }
  const remaining = lot.qtyReceived - lot.qtyDeployed - lot.qtyReturned;
  if (remaining < parsed.qtyBase) {
    throw new MaterialsError(
      "lot_exhausted",
      `consignment lot ${lot.challanNo} has ${String(remaining)} remaining and the deployment ` +
        `needs ${String(parsed.qtyBase)} — doc 09 §6.3's Friday evening, caught at the scan`,
      {
        lotId: lot.id, challanNo: lot.challanNo, remaining, required: parsed.qtyBase,
        qtyReceived: lot.qtyReceived, qtyDeployed: lot.qtyDeployed, qtyReturned: lot.qtyReturned,
      },
    );
  }

  // ── 3. THE MOVEMENT ──
  const { ledgerEntryId } = await postMovement(tx, actor, {
    resourceId: parsed.storeResourceId, batchId: parsed.batchId,
    qtyDelta: -parsed.qtyBase, reason: "consume",
    refType: parsed.caseRef.type, refId: parsed.caseRef.id,
    eventId,
    patientId: parsed.patientId, encounterId: parsed.encounterId,
    occurredAt,
  });

  // ── 4. THE LOT COUNTER ──
  await tx.update(consignmentLots)
    .set({ qtyDeployed: sql`${consignmentLots.qtyDeployed} + ${parsed.qtyBase}` })
    .where(eq(consignmentLots.id, parsed.lotId));

  // ── 5. THE PRICE FACTS, AT `occurredAt` (A21) ──
  const batchRows = await tx.select().from(stockBatches).where(eq(stockBatches.id, parsed.batchId));
  const batch = batchRows[0];
  if (batch === undefined) throw new MaterialsError("unknown_batch", `batch ${parsed.batchId} not found`);

  /**
   * **`effectiveRegulation(itemId, occurredAt)` — NOT `now()` (A21).**
   *
   * A21's mutant asks at processing time, and the discriminating fixture is two regulation rows:
   * one effective BEFORE `occurredAt` with ceiling C1, one effective AFTER `occurredAt` but before
   * now with C2. The shipped code carries C1 — the ceiling that was in force when the implant went
   * into the patient — and the mutant carries C2. **One regulation row does not discriminate.**
   *
   * It matters because the event is what a bill will be composed from: a deployment reprocessed
   * after a dead-letter replay, or a worker catching up after an outage, must price the same way it
   * would have priced at the time.
   */
  const uoms = await itemUomRows(tx, parsed.itemId);
  const reg = await effectiveRegulation(tx, parsed.itemId, occurredAt);
  let ceilingPaise: number | null = null;
  if (reg?.ceilingPaise !== null && reg?.ceilingPaise !== undefined) {
    try {
      ceilingPaise = mrpPerBaseUnit(
        uoms, reg.ceilingPaise,
        reg.mrpUom ?? uoms.find((u) => u.toBaseMultiplier === 1)?.uom ?? null,
      );
    } catch {
      // An unconvertible ceiling is carried as null rather than aborting a clinical event: the
      // implant is already in the patient, and refusing to record that would be the worse error.
      ceilingPaise = null;
    }
  }

  await appendEvent(tx, materialConsumed.make({
    payload: {
      ledgerEntryId,
      itemId: parsed.itemId,
      batchId: parsed.batchId,
      ownership: batch.ownership as "owned" | "consignment" | "loaner" | "donated",
      vendorId: batch.vendorId,
      qtyBase: parsed.qtyBase,
      patientId: parsed.patientId,
      encounterId: parsed.encounterId,
      caseRef: parsed.caseRef,
      // The batch's OWN printed price — what is on the box in this patient's theatre, not a
      // default from the master (DD7's pair rule: paise and unit travel together).
      mrpPaise: batch.mrpPaise,
      mrpUom: batch.mrpUom,
      ceilingPaise,
      occurredAt: parsed.occurredAt,
    },
    actor, correlationId: parsed.encounterId,
  }));

  return { handled: true, ledgerEntryId };
}

/**
 * The `Handler` `workerConsumers` registers. Its own transaction, because a bus handler has no
 * caller transaction to join — the `accrualConsumer` shape.
 */
export function consumptionConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== consignmentDeployed.name) return;
    await withTx(db, (tx) => handleConsignmentDeployed(
      tx,
      // The consumer acts as the system: the human actor is on the ORIGINATING event, and the
      // ledger row's `ref` carries the case that caused it.
      { type: "system", id: MATERIALS_CONSUMPTION_CONSUMER },
      e.eventId,
      e.payload,
    ));
  };
}

/**
 * **THE READ INTERFACE PLAN 15 COMPOSES A BILL FROM (DD13).**
 *
 * Every `consume` ledger row for an encounter, in `seq` order, with the price facts the
 * `material.consumed` event carried. Ordered by `seq` and never by `id` or `occurred_at`, for
 * `movementsFor`'s reason: `id` is a ULID and `occurred_at` may run backwards.
 *
 * It returns the payload SHAPE rather than the events themselves, so a caller does not have to know
 * that the facts live in the event stream — which is what lets a later phase materialise them into
 * a table without changing this signature.
 */
export type ConsumptionRow = {
  ledgerEntryId: string;
  seq: number;
  itemId: string;
  batchId: string;
  ownership: string;
  vendorId: string | null;
  qtyBase: number;
  patientId: string | null;
  encounterId: string | null;
  mrpPaise: number | null;
  mrpUom: string | null;
  occurredAt: Date;
};

export async function consumptionsFor(db: Db | Tx, encounterId: string): Promise<ConsumptionRow[]> {
  const rows = await db.select({
    ledgerEntryId: stockLedger.id,
    seq: stockLedger.seq,
    itemId: stockLedger.itemId,
    batchId: stockLedger.batchId,
    ownership: stockBatches.ownership,
    vendorId: stockBatches.vendorId,
    qtyDelta: stockLedger.qtyDelta,
    patientId: stockLedger.patientId,
    encounterId: stockLedger.encounterId,
    mrpPaise: stockBatches.mrpPaise,
    mrpUom: stockBatches.mrpUom,
    occurredAt: stockLedger.occurredAt,
  })
    .from(stockLedger)
    .innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId))
    .where(and(eq(stockLedger.encounterId, encounterId), eq(stockLedger.reason, "consume")))
    .orderBy(asc(stockLedger.seq));

  return rows.map((r) => ({
    ledgerEntryId: r.ledgerEntryId,
    seq: r.seq,
    itemId: r.itemId,
    batchId: r.batchId,
    ownership: r.ownership,
    vendorId: r.vendorId,
    // The ledger stores the movement SIGNED; a consumption's quantity is its magnitude, and a
    // caller composing a bill should not have to remember the sign convention.
    qtyBase: Math.abs(r.qtyDelta),
    patientId: r.patientId,
    encounterId: r.encounterId,
    mrpPaise: r.mrpPaise,
    mrpUom: r.mrpUom,
    occurredAt: r.occurredAt,
  }));
}
