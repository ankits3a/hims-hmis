import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { items, resources, stockBatches, transferLines, transfers, users } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { MaterialsError } from "./errors";
import { materialDiscrepancyFlagged, materialIssued, materialReceived } from "./events";
import { fefoPick, getBatch, postMovements } from "./ledger";
import { ensureTransitStore, requireStore, storeCustodianRoles } from "./stores";
import type { MovementInput } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Custody } from "./controlled";
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
    /** PHARMACY P6 — out of the controlled cabinet only under two keys (the register names the store it went to). */
    custody?: Custody;
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
      /**
       * ═══ CLOSE REVIEW m3 — THE NAMED BATCH MUST BE A BATCH OF THE NAMED ITEM ═══
       *
       * The override took `itemId` and `batchId` from the caller and checked NEITHER against the
       * other. `postMovements` reads the batch's OWN `item_id` for the ledger row, so the ledger
       * and the balances were always right — which is why this is a MINOR and not a MAJOR. But the
       * transfer LINE and the `material.issued` EVENT both carry the caller's `itemId`, so a
       * transposed pair produced a permanent, plausible, wrong record: "300 of paracetamol" against
       * a batch of insulin, in the append-only event stream, where nothing downstream can tell.
       *
       * `batch_mismatch` is the right code and already means exactly this — `grn.ts` and
       * `consumption.ts` both raise it when a batch does not agree with what its caller believes.
       */
      const named = await getBatch(tx, line.batchId);
      if (named === undefined) {
        throw new MaterialsError("unknown_batch", `batch ${line.batchId} not found`, {
          itemId: line.itemId, batchId: line.batchId,
        });
      }
      if (named.itemId !== line.itemId) {
        throw new MaterialsError(
          "batch_mismatch",
          `batch ${named.batchNo} belongs to a different item — a FEFO override names a batch OF the item it overrides`,
          { itemId: line.itemId, batchId: line.batchId, batchItemId: named.itemId },
        );
      }
      resolved.push({
        itemId: line.itemId, batchId: line.batchId, qty: line.qtyBase,
        overrideReason: line.overrideReason ?? null,
      });
      continue;
    }
    /**
     * `occurredAt`, not the wall clock (16c close review, pass 2). `fefoPick` gained an `asOf` in
     * the close review that stopped it offering EXPIRED stock, with the rule "the caller resolves
     * the clock" — and this caller, the only other one in the tree, went on taking the default
     * `new Date()`. It has a clock: an issue carries the moment it happened, and a transfer
     * recorded after the fact must pick the batches that were in date THEN, not the ones in date
     * when somebody got round to typing it in.
     */
    const picked = await fefoPick(tx, input.fromResourceId, line.itemId, line.qtyBase, input.occurredAt);
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
      ...(input.custody === undefined ? {} : {
        custody: { ...input.custody, counterparty: input.custody.counterparty ?? (await requireStore(tx, input.toResourceId)).name, documentRef: `transfer ${transferId}` },
      }),
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
  /** PHARMACY P6 — into the controlled cabinet only under two keys (the register names the store it came from). */
  opts: { custody?: Custody } = {},
): Promise<{ status: string; shortfalls: { transferLineId: string; qtyShort: number }[] }> {
  const rows = await tx.select().from(transfers).where(eq(transfers.id, transferId));
  const transfer = rows[0];
  if (transfer === undefined) {
    throw new MaterialsError("unknown_document", `transfer ${transferId} not found`);
  }
  if (transfer.status !== "in_transit") {
    /**
     * ═══ CLOSE REVIEW M8 — THE TERNARY WAS UNREACHABLE IN ONE DIRECTION BY CONSTRUCTION ═══
     *
     * This read `transfer.status === "in_transit" ? "not_in_transit" : "already_received"` INSIDE
     * `if (transfer.status !== "in_transit")`. The true branch could never be taken, so
     * `not_in_transit` — a code `errors.ts` declares and describes as belonging to exactly this
     * call — had NO reachable thrower anywhere in the module, while `grn.ts` had BORROWED it to
     * mean something else entirely ("gate QC has not run"). The union drifted in both directions
     * at once and `errors.test.ts`, promised in `errors.ts` to assert exactly that, was never
     * written.
     *
     * `transfers_status_ck` admits three values and the guard above excludes one, so the two that
     * remain — `received` and `discrepancy` — both mean the other side has already signed. That is
     * `already_received` unconditionally, and it is now written unconditionally. `not_in_transit`
     * is REMOVED from the union rather than kept as a code nothing can produce.
     *
     * (`received` and `discrepancy` are both terminal in this phase; resolution is 14c's.)
     */
    throw new MaterialsError(
      "already_received",
      `transfer ${transferId} is "${transfer.status}" and cannot be received again`,
      { status: transfer.status },
    );
  }

  /*
    TWO SIGNATURES, AND THE RIGHT SECOND ONE (the transfer screen, 2026-09-17). The stores issue and
    the receiving department acknowledges: the Indian hospital indent voucher has both signatures,
    and one person signing both is a transfer nobody checked. A store that names its keepers
    (`attributes.custodianRoles`, which `seed:pharmacy` sets on both pharmacy counters) is received
    into only by one of them, so the pharmacy, not the storekeeper, confirms what reached its shelf.
  */
  if (actor.id === transfer.issuedBy) {
    throw new MaterialsError("transfer_self_receipt", `you issued transfer ${transferId}; the receiving store confirms it`);
  }
  const keepers = storeCustodianRoles(await requireStore(tx, transfer.toResourceId));
  if (keepers.length > 0) {
    let keeps = false;
    for (const roleKey of keepers) {
      if ((await usersHoldingRole(tx, roleKey)).includes(actor.id)) { keeps = true; break; }
    }
    if (!keeps) {
      throw new MaterialsError("not_store_keeper", `only the receiving store's own staff (${keepers.join(", ")}) confirm what reached it`, { keepers });
    }
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
        ...(opts.custody === undefined ? {} : {
          custody: { ...opts.custody, counterparty: opts.custody.counterparty ?? (await requireStore(tx, transfer.fromResourceId)).name, documentRef: `transfer ${transferId}` },
        }),
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

// ═══════════════════════ THE TRANSFER SCREEN'S READ (2026-09-17) ═══════════════════════

export type TransferView = {
  id: string;
  /** What staff say aloud: `TR-` and the id's last six characters. */
  ref: string;
  status: string;
  note: string | null;
  from: { id: string; code: string; name: string };
  to: { id: string; code: string; name: string };
  issuedBy: { id: string; name: string };
  issuedAt: string;
  receivedBy: { id: string; name: string } | null;
  receivedAt: string | null;
  lines: {
    id: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
    batchId: string; batchNo: string; expiryDate: string | null;
    qtyIssued: number; qtyReceived: number | null; discrepancyReason: string | null;
  }[];
};

const RECENT_TRANSFERS = 50;

/**
 * What the transfer screen shows, with names instead of ids: every transfer still in transit (to
 * `storeId` when given), oldest first, and the latest moves (from or to `storeId`), newest first.
 */
export async function transferWorklist(
  db: Db | Tx, filter: { storeId?: string },
): Promise<{ awaiting: TransferView[]; recent: TransferView[] }> {
  const store = filter.storeId;
  const awaitingRows = await db.select().from(transfers)
    .where(and(eq(transfers.status, "in_transit"), store === undefined ? undefined : eq(transfers.toResourceId, store)))
    .orderBy(asc(transfers.issuedAt), asc(transfers.id)).limit(200);
  const recentRows = await db.select().from(transfers)
    .where(store === undefined ? undefined : or(eq(transfers.fromResourceId, store), eq(transfers.toResourceId, store)))
    .orderBy(desc(transfers.issuedAt), desc(transfers.id)).limit(RECENT_TRANSFERS);
  const views = await transferViews(db, [...awaitingRows, ...recentRows]);
  return {
    awaiting: awaitingRows.map((r) => views.get(r.id)!),
    recent: recentRows.map((r) => views.get(r.id)!),
  };
}

async function transferViews(db: Db | Tx, rows: TransferRow[]): Promise<Map<string, TransferView>> {
  const out = new Map<string, TransferView>();
  const ids = [...new Set(rows.map((r) => r.id))];
  if (ids.length === 0) return out;
  const lines = await db.select({
    line: transferLines, itemId: stockBatches.itemId, itemCode: items.code, itemName: items.name, baseUom: items.baseUom,
    batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
  })
    .from(transferLines)
    .innerJoin(stockBatches, eq(stockBatches.id, transferLines.batchId))
    .innerJoin(items, eq(items.id, stockBatches.itemId))
    .where(inArray(transferLines.transferId, ids))
    .orderBy(asc(transferLines.id));
  const storeIds = [...new Set(rows.flatMap((r) => [r.fromResourceId, r.toResourceId]))];
  const stores = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources).where(inArray(resources.id, storeIds))).map((s) => [s.id, s] as const));
  const people = [...new Set(rows.flatMap((r) => [r.issuedBy, r.receivedBy]).filter((x): x is string => x !== null))];
  const nameOf = new Map((people.length === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName })
    .from(users).where(inArray(users.id, people))).map((u) => [u.id, u.fullName] as const));
  const storeOf = (id: string): TransferView["from"] => {
    const s = stores.get(id);
    return { id, code: s?.code ?? "", name: s?.name ?? id };
  };
  for (const r of rows) {
    if (out.has(r.id)) continue;
    out.set(r.id, {
      id: r.id, ref: `TR-${r.id.slice(-6)}`, status: r.status, note: r.note,
      from: storeOf(r.fromResourceId), to: storeOf(r.toResourceId),
      issuedBy: { id: r.issuedBy, name: nameOf.get(r.issuedBy) ?? r.issuedBy },
      issuedAt: r.issuedAt.toISOString(),
      receivedBy: r.receivedBy === null ? null : { id: r.receivedBy, name: nameOf.get(r.receivedBy) ?? r.receivedBy },
      receivedAt: r.receivedAt === null ? null : r.receivedAt.toISOString(),
      lines: lines.filter((l) => l.line.transferId === r.id).map((l) => ({
        id: l.line.id, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, baseUom: l.baseUom,
        batchId: l.line.batchId, batchNo: l.batchNo, expiryDate: l.expiryDate,
        qtyIssued: l.line.qtyIssued, qtyReceived: l.line.qtyReceived, discrepancyReason: l.line.discrepancyReason,
      })),
    });
  }
  return out;
}
