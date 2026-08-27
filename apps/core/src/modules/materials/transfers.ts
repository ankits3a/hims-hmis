import { and, asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { transferLines, transfers } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { materialDiscrepancyFlagged, materialIssued, materialReceived } from "./events";
import { fefoPick, postMovements } from "./ledger";
import { ensureTransitStore, requireStore } from "./stores";
import type { MovementInput } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type TransferRow = typeof transfers.$inferSelect;
export type TransferLineRow = typeof transferLines.$inferSelect;
export type TransferWithLines = TransferRow & { lines: TransferLineRow[] };

/**
 * PLAN 14 T7 / DD9 — **TWO-SIDED ISSUE THROUGH A REAL `IN-TRANSIT` STORE.**
 *
 * ═══ WHY THE TRANSIT STORE IS A REAL PLACE ═══
 *
 * `issueStock` moves each batch quantity `from → IN-TRANSIT`; `receiveStock` moves
 * `IN-TRANSIT → to` for the quantities the receiver actually confirms. Between the two signatures
 * the stock is SOMEWHERE, and "nowhere" is the answer that loses a carton. The transit store is a
 * registry `store` resource with real balances, so "what is in transit right now" is a query
 * against the same table every other stock question is asked of.
 *
 * The alternative — decrementing the source at issue and incrementing the destination at receive —
 * makes the stock invisible in between and makes a shortfall unattributable: the quantity has
 * already left the source, so there is nothing to point at.
 *
 * ═══ A SHORTFALL IS A ROW, NOT AN ADJUSTMENT (A18) ═══
 *
 * Issue 10, receive 7: the destination gets 7, **THREE STAY IN `IN-TRANSIT`**, the header goes to
 * `discrepancy`, and `material.discrepancy_flagged` fires in the same transaction (§11.10:
 * *"discrepancies surface same-hour"*). Nothing writes the difference off, and nothing quietly
 * moves 10 because 10 were issued — **that is A18's mutant**, and its effect is a destination that
 * says it has stock it does not have.
 *
 * Resolution — return to source, or write off — is **14c's** variance machinery. In this phase a
 * discrepancy is VISIBLE and nothing hides it, which is the safe direction: an unresolved
 * discrepancy is an operational nuisance, and a hidden one is a stock figure nobody can trust.
 */

export type IssueLine = {
  itemId: string;
  qtyBase: number;
  /** Overrides FEFO. The pharmacy's substitution case — and it is EVENTED, never silent. */
  batchId?: string;
  overrideReason?: string;
};

/**
 * Moves stock from a store into `IN-TRANSIT` and opens a transfer.
 *
 * **FEFO by default** (`fefoPick`, DD9): the caller names an item and a quantity, and the earliest-
 * expiring available batches are picked in order. A caller may name a `batchId` instead — the
 * substitution case — but only WITH a reason, and the override travels in the event so that
 * "why was the March batch issued when February's was on the shelf" has an answer.
 */
export async function issueStock(
  tx: Tx,
  actor: Actor,
  input: {
    fromResourceId: string;
    toResourceId: string;
    lines: IssueLine[];
    note?: string | null;
    occurredAt: Date;
    siteId?: string;
  },
): Promise<{ transferId: string; lines: { transferLineId: string; batchId: string; qtyIssued: number }[] }> {
  if (input.lines.length === 0) {
    throw new MaterialsError("unknown_document", "a transfer must carry at least one line");
  }
  if (input.fromResourceId === input.toResourceId) {
    throw new MaterialsError(
      "unknown_store",
      "a transfer's source and destination are the same store — there is nothing to move",
    );
  }
  await requireStore(tx, input.fromResourceId);
  await requireStore(tx, input.toResourceId);
  const transitId = await ensureTransitStore(tx, input.siteId);

  const transferId = newId();
  await tx.insert(transfers).values({
    id: transferId,
    fromResourceId: input.fromResourceId, toResourceId: input.toResourceId,
    status: "in_transit", issuedBy: actor.id, issuedAt: input.occurredAt,
    note: input.note ?? null,
  });

  // Resolve every line to concrete batches FIRST, so the movement list is complete before the
  // ledger's single ordered lock is taken (A9's discipline, one caller up).
  const resolved: { itemId: string; batchId: string; qty: number; overrideReason: string | null }[] = [];
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.qtyBase) || line.qtyBase <= 0) {
      throw new MaterialsError("insufficient_stock", `a transfer line must be a positive integer`);
    }
    if (line.batchId !== undefined) {
      // THE OVERRIDE. A reason is mandatory: a silent override is indistinguishable from a FEFO
      // failure, and the two need very different follow-ups.
      if ((line.overrideReason ?? "").trim() === "") {
        throw new MaterialsError(
          "batch_mismatch",
          "naming a batch explicitly overrides FEFO and needs a reason (DD9)",
          { itemId: line.itemId, batchId: line.batchId },
        );
      }
      resolved.push({
        itemId: line.itemId, batchId: line.batchId, qty: line.qtyBase,
        overrideReason: line.overrideReason ?? null,
      });
      continue;
    }
    const picked = await fefoPick(tx, input.fromResourceId, line.itemId, line.qtyBase);
    const total = picked.reduce((a, p) => a + p.qty, 0);
    if (total < line.qtyBase) {
      // `fefoPick` returns what it CAN; deciding that a short pick is an error is the CALLER's,
      // and for an issue it is (DD9). A screen asking "what could we pick" gets the same list and
      // treats it as information.
      throw new MaterialsError(
        "insufficient_stock",
        `store holds ${String(total)} available of this item; the issue needs ${String(line.qtyBase)}`,
        { itemId: line.itemId, available: total, required: line.qtyBase },
      );
    }
    for (const p of picked) {
      resolved.push({ itemId: line.itemId, batchId: p.batchId, qty: p.qty, overrideReason: null });
    }
  }

  // OUT of the source, INTO transit — both halves in ONE `postMovements` call, so one ordered lock
  // covers every batch on both sides.
  const movements: MovementInput[] = [];
  for (const r of resolved) {
    movements.push({
      resourceId: input.fromResourceId, batchId: r.batchId, qtyDelta: -r.qty,
      reason: "issue", refType: "transfer", refId: transferId, occurredAt: input.occurredAt,
    });
    movements.push({
      resourceId: transitId, batchId: r.batchId, qtyDelta: r.qty,
      reason: "issue", refType: "transfer", refId: transferId, occurredAt: input.occurredAt,
    });
  }
  await postMovements(tx, actor, movements);

  const lines: { transferLineId: string; batchId: string; qtyIssued: number }[] = [];
  for (const r of resolved) {
    const transferLineId = newId();
    await tx.insert(transferLines).values({
      id: transferLineId, transferId, batchId: r.batchId, qtyIssued: r.qty,
      qtyReceived: null,
      discrepancyReason: r.overrideReason === null ? null : `fefo_override: ${r.overrideReason}`,
    });
    lines.push({ transferLineId, batchId: r.batchId, qtyIssued: r.qty });
  }

  await appendEvent(tx, materialIssued.make({
    payload: {
      transferId, fromResourceId: input.fromResourceId, toResourceId: input.toResourceId,
      lines: resolved.map((r) => ({ batchId: r.batchId, itemId: r.itemId, qtyBase: r.qty })),
    },
    actor, correlationId: transferId,
  }));
  return { transferId, lines };
}

/**
 * **THE RECEIVING SIGNATURE (A18).** Moves `IN-TRANSIT → destination` for the quantities the
 * receiver CONFIRMS — never for the quantities that were issued.
 *
 * A line receiving less than it was issued leaves the difference in `IN-TRANSIT`, records the gap
 * on the line, and puts the header into `discrepancy`. **A18's mutant moves `qty_issued`
 * regardless**, which empties transit, fills the destination with stock nobody counted, and leaves
 * the two stores agreeing on a number that is wrong at both ends.
 *
 * Receiving MORE than was issued is refused outright: there is no honest source for the excess, and
 * "the receiver counted more than the sender sent" is a counting problem, not a stock movement.
 */
export async function receiveStock(
  tx: Tx,
  actor: Actor,
  transferId: string,
  lines: { lineId: string; qtyReceived: number }[],
  occurredAt: Date,
  siteId?: string,
): Promise<{ status: string; shortfalls: { transferLineId: string; qtyShort: number }[] }> {
  const rows = await tx.select().from(transfers).where(eq(transfers.id, transferId));
  const transfer = rows[0];
  if (transfer === undefined) {
    throw new MaterialsError("unknown_document", `transfer ${transferId} not found`);
  }
  if (transfer.status !== "in_transit") {
    // `received` and `discrepancy` are both terminal in this phase; resolution is 14c's.
    throw new MaterialsError(
      transfer.status === "in_transit" ? "not_in_transit" : "already_received",
      `transfer ${transferId} is "${transfer.status}" and cannot be received again`,
      { status: transfer.status },
    );
  }

  const existing = await tx.select().from(transferLines)
    .where(eq(transferLines.transferId, transferId)).orderBy(asc(transferLines.id));
  const byId = new Map(existing.map((l) => [l.id, l]));
  const transitId = await ensureTransitStore(tx, siteId);

  const movements: MovementInput[] = [];
  const confirmed: { transferLineId: string; batchId: string; qtyReceived: number }[] = [];
  const shortfalls: { transferLineId: string; batchId: string; qtyIssued: number; qtyReceived: number; qtyShort: number }[] = [];

  for (const l of lines) {
    const line = byId.get(l.lineId);
    if (line === undefined) {
      throw new MaterialsError("unknown_document", `transfer line ${l.lineId} is not on transfer ${transferId}`);
    }
    if (line.qtyReceived !== null) {
      throw new MaterialsError("already_received", `transfer line ${l.lineId} is already received`);
    }
    if (!Number.isSafeInteger(l.qtyReceived) || l.qtyReceived < 0) {
      throw new MaterialsError("insufficient_stock", `a received quantity must be a non-negative integer`);
    }
    if (l.qtyReceived > line.qtyIssued) {
      throw new MaterialsError(
        "insufficient_stock",
        `line ${l.lineId} was issued ${String(line.qtyIssued)} and the receiver confirms ` +
          `${String(l.qtyReceived)} — more than was sent has no source`,
        { qtyIssued: line.qtyIssued, qtyReceived: l.qtyReceived },
      );
    }

    // **ONLY THE CONFIRMED QUANTITY MOVES.** This is the whole of A18.
    if (l.qtyReceived > 0) {
      movements.push({
        resourceId: transitId, batchId: line.batchId, qtyDelta: -l.qtyReceived,
        reason: "receive", refType: "transfer", refId: transferId, occurredAt,
      });
      movements.push({
        resourceId: transfer.toResourceId, batchId: line.batchId, qtyDelta: l.qtyReceived,
        reason: "receive", refType: "transfer", refId: transferId, occurredAt,
      });
    }
    confirmed.push({ transferLineId: line.id, batchId: line.batchId, qtyReceived: l.qtyReceived });
    const short = line.qtyIssued - l.qtyReceived;
    if (short > 0) {
      shortfalls.push({
        transferLineId: line.id, batchId: line.batchId,
        qtyIssued: line.qtyIssued, qtyReceived: l.qtyReceived, qtyShort: short,
      });
    }
  }

  if (movements.length > 0) await postMovements(tx, actor, movements);

  for (const c of confirmed) {
    const short = shortfalls.find((s) => s.transferLineId === c.transferLineId);
    await tx.update(transferLines).set({
      qtyReceived: c.qtyReceived,
      ...(short === undefined ? {} : { discrepancyReason: `short_${String(short.qtyShort)}` }),
    }).where(eq(transferLines.id, c.transferLineId));
  }

  // A line nobody confirmed leaves the transfer open in spirit; in this phase the header closes on
  // what was reported, and any unreported line is itself a shortfall the next reader can see.
  const unreported = existing.filter((l) => !lines.some((x) => x.lineId === l.id) && l.qtyReceived === null);
  const status = shortfalls.length > 0 || unreported.length > 0 ? "discrepancy" : "received";

  await tx.update(transfers).set({
    status, receivedBy: actor.id, receivedAt: occurredAt,
  }).where(eq(transfers.id, transferId));

  await appendEvent(tx, materialReceived.make({
    payload: {
      transferId, fromResourceId: transfer.fromResourceId, toResourceId: transfer.toResourceId,
      lines: confirmed,
    },
    actor, correlationId: transferId,
  }));

  if (shortfalls.length > 0) {
    // SAME TRANSACTION as the receive (§11.10). A discrepancy discovered an hour later is a
    // discrepancy nobody can reconstruct.
    await appendEvent(tx, materialDiscrepancyFlagged.make({
      payload: {
        transferId, fromResourceId: transfer.fromResourceId, toResourceId: transfer.toResourceId,
        gaps: shortfalls.map((s) => ({
          transferLineId: s.transferLineId, batchId: s.batchId,
          qtyIssued: s.qtyIssued, qtyReceived: s.qtyReceived, qtyShort: s.qtyShort,
        })),
      },
      actor, correlationId: transferId,
    }));
  }

  return { status, shortfalls: shortfalls.map((s) => ({ transferLineId: s.transferLineId, qtyShort: s.qtyShort })) };
}

// ═══════════════════════════════════════ READS ═══════════════════════════════════════

export async function getTransfer(db: Db | Tx, transferId: string): Promise<TransferWithLines | undefined> {
  const rows = await db.select().from(transfers).where(eq(transfers.id, transferId));
  const row = rows[0];
  if (row === undefined) return undefined;
  const lines = await db.select().from(transferLines)
    .where(eq(transferLines.transferId, transferId)).orderBy(asc(transferLines.id));
  return { ...row, lines };
}

export async function listTransfers(
  db: Db | Tx,
  filter: { status?: string; fromResourceId?: string; toResourceId?: string } = {},
): Promise<TransferRow[]> {
  const clauses = [];
  if (filter.status !== undefined) clauses.push(eq(transfers.status, filter.status));
  if (filter.fromResourceId !== undefined) clauses.push(eq(transfers.fromResourceId, filter.fromResourceId));
  if (filter.toResourceId !== undefined) clauses.push(eq(transfers.toResourceId, filter.toResourceId));
  const q = db.select().from(transfers).orderBy(asc(transfers.issuedAt));
  return clauses.length === 0 ? q : q.where(and(...clauses));
}

/** The DD16 worklist: every transfer whose count did not agree. The GRN screen's second tab. */
export async function listDiscrepancies(db: Db | Tx): Promise<TransferWithLines[]> {
  const headers = await listTransfers(db, { status: "discrepancy" });
  const out: TransferWithLines[] = [];
  for (const h of headers) {
    const lines = await db.select().from(transferLines)
      .where(eq(transferLines.transferId, h.id)).orderBy(asc(transferLines.id));
    out.push({ ...h, lines });
  }
  return out;
}
