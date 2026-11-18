import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { itemStockLevels, stockLedger } from "../../kernel/db/schema";
import { balances, fefoPick, getBatch, getTransfer, postMovements, receiveStock } from "../materials";
import { recordAct, requireShelf, requireShelfAct } from "./access";
import { StoresError } from "./errors";
import { listStoresItems, requireStoresItem } from "./items";
import type { MovementInput } from "../materials";
import type { CheckResult, ReorderDraftLine, TrackMode } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — WHAT HAPPENS AT A DEPARTMENT SHELF (decisions 7, 8, 9, 12, 16).
 *
 * Every act here is asked at the shelf's department first (`requireShelfAct`), then posts through the one
 * materials ledger. The department is CHARGED AT RECEIPT: the receipt rows carry its org code as
 * `cost_center` at the batch's received cost. A "Used" and a check difference are `consume` rows with the
 * same cost centre (the department's use, for the use rates and the monthly floor report); they move no
 * money a second time. A wrong "Used" is corrected by ONE opposite row naming it, never by an edit: the
 * database refuses UPDATE and DELETE on `stock_ledger` (migration 0237).
 */

export const SHELF_USE_REF = "shelf_use";
export const SHELF_CHECK_REF = "shelf_check";
export const EXPENSED_REF = "expensed_on_receipt";
export const REVERSAL_REF = "reversal";

async function onHand(db: Db | Tx, storeId: string, itemId: string): Promise<number> {
  return (await balances(db, { resourceId: storeId, itemId })).reduce((s, b) => s + b.qtyOnHand, 0);
}

function positive(qty: number, what: string): void {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new StoresError("bad_quantity", `${what} must be a positive whole number`, { qty });
}

/**
 * Decision 7/8: the department's in-charge receives a transfer from its supplying store. The receipt rows
 * carry the department's code as cost centre; an `expensed` item is consumed in the same transaction,
 * against the same cost centre, so its shelf balance stays 0.
 */
export async function receiveAtShelf(
  db: Db, actor: Actor, transferId: string, now: Date, lines?: readonly { lineId: string; qtyReceived: number }[],
  /** The shelf the caller believes it is receiving at (the route's `:shelfId`); refused when it is another. */
  expectShelfId?: string,
): Promise<{ status: string; shortfalls: { transferLineId: string; qtyShort: number }[] }> {
  const transfer = await getTransfer(db, transferId);
  if (transfer === undefined) throw new StoresError("unknown_store", `transfer ${transferId} not found`);
  if (expectShelfId !== undefined && expectShelfId !== transfer.toResourceId) throw new StoresError("not_this_shelf", "this transfer is for another shelf");
  const shelf = await requireShelf(db, transfer.toResourceId);
  await requireShelfAct(db, actor, shelf, "work");
  const confirm = lines ?? transfer.lines.filter((l) => l.qtyReceived === null).map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued }));
  return withTx(db, async (tx) => {
    const byLine = new Map(transfer.lines.map((l) => [l.id, l]));
    const batchItem = new Map<string, string>();
    for (const l of transfer.lines) {
      const b = await getBatch(tx, l.batchId);
      if (b !== undefined) batchItem.set(l.batchId, b.itemId);
    }
    const itemIds = [...new Set([...batchItem.values()])];
    const modes = new Map<string, TrackMode>();
    for (const id of itemIds) modes.set(id, (await requireStoresItem(tx, id)).trackMode);
    const before = new Map<string, number>();
    for (const id of itemIds) before.set(id, await onHand(tx, shelf.id, id));

    const result = await receiveStock(tx, actor, transferId, [...confirm], now, undefined, { costCenter: shelf.departmentCode, throughStores: true });

    // Decision 8: an expensed item is used on receipt, against the same cost centre.
    const used: MovementInput[] = [];
    for (const c of confirm) {
      const line = byLine.get(c.lineId);
      if (line === undefined || c.qtyReceived <= 0) continue;
      const itemId = batchItem.get(line.batchId);
      if (itemId !== undefined && modes.get(itemId) === "expensed") {
        used.push({
          resourceId: shelf.id, batchId: line.batchId, qtyDelta: -c.qtyReceived, reason: "consume",
          refType: EXPENSED_REF, refId: transferId, costCenter: shelf.departmentCode, occurredAt: now,
        });
      }
    }
    if (used.length > 0) await postMovements(tx, actor, used);

    const after = new Map<string, number>();
    for (const id of itemIds) after.set(id, await onHand(tx, shelf.id, id));
    const single = itemIds.length === 1 ? itemIds[0]! : null;
    await recordAct(tx, actor, now, {
      act: "receive", storeId: shelf.id, itemId: single, refId: transferId, reason: result.shortfalls.length > 0 ? "short" : null,
      before: single === null ? null : before.get(single) ?? 0, after: single === null ? null : after.get(single) ?? 0,
      lines: itemIds.map((id) => ({ itemId: id, before: before.get(id) ?? 0, after: after.get(id) ?? 0 })),
    });
    return result;
  });
}

/** Decision 9: "Used" — one tap and a quantity posts a `consume` at the shelf. A durable item is never used. */
export async function recordShelfUse(
  db: Db, actor: Actor, input: { shelfId: string; itemId: string; qty: number }, now: Date,
): Promise<{ ledgerEntryIds: string[] }> {
  positive(input.qty, "the quantity used");
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const item = await requireStoresItem(db, input.itemId);
  if (item.trackMode === "durable") throw new StoresError("durable_not_used", "not used up: return it", { itemId: item.id });
  return withTx(db, async (tx) => {
    const before = await onHand(tx, shelf.id, item.id);
    const picked = await fefoPick(tx, shelf.id, item.id, input.qty, now);
    const available = picked.reduce((s, p) => s + p.qty, 0);
    if (available < input.qty) throw new StoresError("more_than_on_hand", "more than on hand", { onHand: before, qty: input.qty });
    const useId = newId();
    const posted = await postMovements(tx, actor, picked.map((p) => ({
      resourceId: shelf.id, batchId: p.batchId, qtyDelta: -p.qty, reason: "consume" as const,
      refType: SHELF_USE_REF, refId: useId, costCenter: shelf.departmentCode, occurredAt: now,
    })));
    await recordAct(tx, actor, now, { act: "use", storeId: shelf.id, itemId: item.id, refId: useId, before, after: before - input.qty });
    return { ledgerEntryIds: posted.map((p) => p.ledgerEntryId) };
  });
}

/**
 * Decision 16: a wrong "Used" is corrected by ONE opposite row (`adjust`, `ref_type = 'reversal'`,
 * `ref_id` = the original row), at the same shelf, batch and cost centre. A row is reversed at most once:
 * the row's own advisory lock serialises two reversals, and the second finds the first's row.
 */
export async function reverseShelfUse(
  db: Db, actor: Actor, rowId: string, reason: string, now: Date, expectShelfId?: string,
): Promise<{ ledgerEntryId: string }> {
  if (reason.trim() === "") throw new StoresError("not_reversible", "say why the use is undone");
  const [row] = await db.select().from(stockLedger).where(eq(stockLedger.id, rowId));
  if (row === undefined || row.reason !== "consume" || row.refType !== SHELF_USE_REF) {
    throw new StoresError("not_reversible", "only a shelf's own \"Used\" is undone this way", { rowId });
  }
  if (expectShelfId !== undefined && expectShelfId !== row.resourceId) throw new StoresError("not_this_shelf", "this use was at another shelf");
  const shelf = await requireShelf(db, row.resourceId);
  await requireShelfAct(db, actor, shelf, "work");
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-reversal:${rowId}`}))`);
    const [done] = await tx.select({ id: stockLedger.id }).from(stockLedger)
      .where(and(eq(stockLedger.refType, REVERSAL_REF), eq(stockLedger.refId, rowId))).limit(1);
    if (done !== undefined) throw new StoresError("already_reversed", "this use was already undone", { rowId });
    const before = await onHand(tx, shelf.id, row.itemId);
    const [posted] = await postMovements(tx, actor, [{
      resourceId: row.resourceId, batchId: row.batchId, qtyDelta: -row.qtyDelta, reason: "adjust",
      refType: REVERSAL_REF, refId: rowId, costCenter: row.costCenter, occurredAt: now,
    }]);
    await recordAct(tx, actor, now, {
      act: "reverse", storeId: shelf.id, itemId: row.itemId, refId: rowId, reason: reason.trim(), before, after: before - row.qtyDelta,
    });
    return { ledgerEntryId: posted!.ledgerEntryId };
  });
}

/**
 * Decision 9: the shelf check. The counted number replaces the book: a shortfall posts as use
 * (`ref_type = 'shelf_check'`); a count ABOVE book posts nothing and is a "More than book" card for the
 * materials head (the check's own event carries it, `overBookCards` reads it). A `durable` item counted
 * short is not "used" (it leaves only by return or condemnation, S4): it is reported, not posted.
 */
export async function recordShelfCheck(
  db: Db, actor: Actor, input: { shelfId: string; lines: readonly { itemId: string; counted: number }[] }, now: Date,
): Promise<CheckResult> {
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  if (input.lines.length === 0) throw new StoresError("bad_quantity", "count at least one item");
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.counted) || l.counted < 0) throw new StoresError("bad_quantity", "a count is a whole number, 0 or more", { itemId: l.itemId });
  }
  return withTx(db, async (tx) => {
    await tx.execute(sql`select id from resources where id = ${shelf.id} for update`);
    const checkId = newId();
    const result: CheckResult = { checkId, used: [], overBook: [], shortDurable: [] };
    const movements: MovementInput[] = [];
    const lines: Record<string, unknown>[] = [];
    for (const l of input.lines) {
      const item = await requireStoresItem(tx, l.itemId);
      const book = await onHand(tx, shelf.id, item.id);
      lines.push({ itemId: item.id, before: book, after: l.counted });
      if (l.counted > book) { result.overBook.push({ itemId: item.id, book, counted: l.counted }); continue; }
      if (l.counted === book) continue;
      if (item.trackMode === "durable") { result.shortDurable.push({ itemId: item.id, book, counted: l.counted }); continue; }
      const gap = book - l.counted;
      const picked = await fefoPick(tx, shelf.id, item.id, gap, now);
      for (const p of picked) {
        movements.push({
          resourceId: shelf.id, batchId: p.batchId, qtyDelta: -p.qty, reason: "consume",
          refType: SHELF_CHECK_REF, refId: checkId, costCenter: shelf.departmentCode, occurredAt: now,
        });
      }
      result.used.push({ itemId: item.id, qty: picked.reduce((s, p) => s + p.qty, 0) });
    }
    if (movements.length > 0) await postMovements(tx, actor, movements);
    await recordAct(tx, actor, now, {
      act: "check", storeId: shelf.id, refId: checkId, reason: result.overBook.length > 0 ? "more_than_book" : null,
      itemId: input.lines.length === 1 ? input.lines[0]!.itemId : null,
      before: input.lines.length === 1 ? lines[0]!.before : null, after: input.lines.length === 1 ? lines[0]!.after : null,
      lines: lines.map((x) => ({
        ...x,
        overBook: result.overBook.some((o) => o.itemId === x.itemId),
        shortDurable: result.shortDurable.some((o) => o.itemId === x.itemId),
      })),
    });
    return result;
  });
}

/**
 * Decision 12: one tap proposes every `shelf` item at or under its reorder level, for max − on hand,
 * rounded UP to the issue pack. Expensed and durable items are never proposed. Sending it is S2's ticket.
 */
export async function shelfReorderDraft(db: Db, actor: Actor, shelfId: string): Promise<{ lines: ReorderDraftLine[] }> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const levels = await db.select().from(itemStockLevels).where(eq(itemStockLevels.storeResourceId, shelf.id));
  if (levels.length === 0) return { lines: [] };
  const master = new Map((await listStoresItems(db)).map((i) => [i.id, i]));
  const lines: ReorderDraftLine[] = [];
  for (const lv of levels) {
    const item = master.get(lv.itemId);
    if (item === undefined || item.trackMode !== "shelf") continue;
    const have = await onHand(db, shelf.id, item.id);
    if (have > lv.reorderBase) continue;
    const want = lv.maxBase - have;
    if (want <= 0) continue;
    const pack = Math.max(1, item.issuePack.multiplier);
    lines.push({
      itemId: item.id, code: item.code, name: item.name, onHand: have, proposed: Math.ceil(want / pack) * pack,
      packUom: item.issuePack.uom, packSize: pack,
    });
  }
  return { lines: lines.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** S1's "Save draft": the lines as the in-charge left them. Every line names a master item (no free text). */
export async function saveReorderDraft(
  db: Db, actor: Actor, shelfId: string, lines: readonly { itemId?: string | null; qty: number }[], now: Date,
): Promise<{ draftId: string }> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  if (lines.length === 0) throw new StoresError("bad_quantity", "nothing to reorder");
  for (const l of lines) {
    if (l.itemId === undefined || l.itemId === null || l.itemId === "") {
      throw new StoresError("item_id_required", "every line names an item from the list; use \"Not in the list\" for a new one");
    }
    positive(l.qty, "a reorder quantity");
  }
  const ids = [...new Set(lines.map((l) => l.itemId!))];
  const known = new Set((await listStoresItems(db)).filter((i) => ids.includes(i.id)).map((i) => i.id));
  for (const id of ids) if (!known.has(id)) throw new StoresError("not_stores_item", "a reorder line names a Stores item", { itemId: id });
  return withTx(db, async (tx) => {
    const draftId = newId();
    await recordAct(tx, actor, now, { act: "reorder_draft", storeId: shelf.id, refId: draftId, lines: lines.map((l) => ({ itemId: l.itemId!, qty: l.qty })) });
    return { draftId };
  });
}

/** Re-exported for the reads: the ref types a shelf's use is written under. */
export const SHELF_USE_REFS = [SHELF_USE_REF, SHELF_CHECK_REF, EXPENSED_REF] as const;
