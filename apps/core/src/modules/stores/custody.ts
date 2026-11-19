import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import {
  items, resources, stockBatches, storeIndentLines, storeIndents, storesClientKeys, storesCustodyHandoffs, storesDeliveryLines, storesScanConfirmations,
  storesTicketDetails, storesTransitResolutions, transferLines, transfers, users,
} from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import {
  STOCK_ADJUSTMENT_APPROVAL_TYPE, ensureQuarantineStore, ensureTransitStore, getTransfer, issueStock, postMovements, receiveLate,
  receiveStock, returnInTransit,
} from "../materials";
import { STORES_MASTERS, holds, isStoresStore, recordAct, requireShelf, requireShelfAct, toStoresStore } from "./access";
import { carriersOf, chainOf, holderOf, lastCustodianOf, returningUndelivered } from "./chain";
import { StoresError } from "./errors";
import { requireStoresItem } from "./items";
import {
  WORDS, deliveredSentBack, deliveredShort, getTicket, keepsStore, notify, requireTicketRow, storesStoreRow, ticketViews,
} from "./tickets";
import { receiveAtShelf } from "./use";
import type { Chain } from "./chain";
import type { TicketRow } from "./tickets";
import type {
  CustodyLookup, CustodyResult, DeliverInput, LateScan, PorterCardRow, RaiseReturnInput, ReturnTicketView, ScanFlag, ScanInput, ShortResolution,
  TicketView,
} from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S2b (#1112, decisions 7–10, 14) — THE CUSTODY CHAIN AND WHAT HAPPENS AT THE OTHER END.
 *
 *   issue (S2a) ─→ take (porter's scan) ─→ hand_over (the incoming porter's scan) … ─→ deliver (the department)
 *                                     └─→ take_over (source keeper / materials head, with a reason)
 *                                     └─→ return_undelivered (the holder) ─→ accept_return (the source keeper)
 *
 * Hand-offs are rows in `stores_custody_handoffs` (append-only in the database) and NEVER touch the ledger: the
 * stock stays in IN-TRANSIT and the chain says whose hands it is in. The ledger moves only at the ends: the
 * department's receipt (`receiveAtShelf`, charged), a late receipt of a short ("found"), and a return to the
 * source or the quarantine store (materials `returnInTransit`). A short that is "lost" is an adjustment request
 * to the stock-adjustment approver and posts nothing until it is granted.
 *
 * Scans carry the phone's time and a client idempotency key (decision 14): a key seen before records nothing; a
 * scan more than 12 h old is accepted and flagged for the source keeper; one from the future is stored at the
 * server's time and flagged. Every act appends one `stores.act_recorded` in its own transaction.
 */

/** Decision 7 — the porter's grant. */
export const STORES_CARRY = "stores.carry";
/** Decision 14 — a scan older than this is accepted and flagged for the keeper's confirmation. */
export const LATE_SCAN_MS = 12 * 60 * 60_000;

const cleanText = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

// ═══════════════════════════════ the scan's clock and key ═══════════════════════════════

/** The scan time as stored: the phone's, unless it is in the future (then the server's). Both are kept. */
export function scanClock(scannedAt: string | Date | null | undefined, now: Date): { phoneAt: Date | null; occurredAt: Date; flag: ScanFlag | null } {
  if (scannedAt === null || scannedAt === undefined || scannedAt === "") return { phoneAt: null, occurredAt: now, flag: null };
  const phoneAt = scannedAt instanceof Date ? scannedAt : new Date(scannedAt);
  if (Number.isNaN(phoneAt.getTime())) throw new StoresError("bad_window", "the scan time is not a time");
  if (phoneAt.getTime() > now.getTime()) return { phoneAt, occurredAt: now, flag: "future" };
  return { phoneAt, occurredAt: phoneAt, flag: now.getTime() - phoneAt.getTime() > LATE_SCAN_MS ? "late" : null };
}

/** The ticket a key already recorded for this person, or null. */
async function seenKey(db: Db | Tx, actor: Actor, clientKey: string | null | undefined): Promise<string | null> {
  const key = cleanText(clientKey);
  if (key === null) return null;
  const [k] = await db.select({ indentId: storesClientKeys.indentId }).from(storesClientKeys)
    .where(and(eq(storesClientKeys.actorId, actor.id), eq(storesClientKeys.clientKey, key)));
  return k?.indentId ?? null;
}

/** Claims the key inside the act's transaction; false when a concurrent post of the same key got there first. */
async function claimKey(tx: Tx, actor: Actor, clientKey: string | null | undefined, act: string, indentId: string, now: Date): Promise<boolean> {
  const key = cleanText(clientKey);
  if (key === null) return true;
  const won = await tx.insert(storesClientKeys).values({ actorId: actor.id, clientKey: key, act, indentId, createdAt: now })
    .onConflictDoNothing().returning({ k: storesClientKeys.clientKey });
  return won.length > 0;
}

async function duplicateOf(db: Db, indentId: string, now: Date): Promise<CustodyResult> {
  return { ticket: (await getTicket(db, indentId, now))!, duplicate: true, flag: null };
}

// ═══════════════════════════════ finding the ticket a label names ═══════════════════════════════

type InTransit = TicketRow & { transfer: typeof transfers.$inferSelect; chain: Chain };

async function inTransitRow(db: Db | Tx, indentId: string, lock = false): Promise<InTransit> {
  const t = await requireTicketRow(db, indentId, lock);
  if (t.indent.status !== "issued" || t.indent.transferId === null) throw new StoresError("not_in_transit", `${t.indent.indentNo} is not on its way`);
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, t.indent.transferId));
  if (transfer === undefined) throw new StoresError("not_in_transit", `${t.indent.indentNo} has no transfer`);
  const chain = await chainOf(db, indentId);
  if (transfer.status !== "in_transit" || chain.delivery.length > 0) throw new StoresError("not_in_transit", `${t.indent.indentNo} is already ${transfer.status}`);
  return { ...t, transfer, chain };
}

/**
 * The label's QR carries the ticket number; the typed fallback is its last four digits. Among the tickets on
 * their way that `fits` admits, exactly one must match: none is `unknown_ticket`, two are `ambiguous_code`.
 */
async function ticketByCode(db: Db | Tx, code: string, fits: (t: InTransit) => boolean): Promise<{ row: InTransit; method: "scan" | "typed" }> {
  const c = code.trim().toUpperCase();
  const typed = /^\d{4}$/.test(c);
  if (!typed && c.length < 5) throw new StoresError("unknown_ticket", "scan the label or type its last four digits");
  const rows = await db.select({ id: storeIndents.id, no: storeIndents.indentNo }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .innerJoin(transfers, eq(transfers.id, storeIndents.transferId))
    .where(and(eq(storeIndents.status, "issued"), eq(transfers.status, "in_transit")));
  const named = rows.filter((r) => (typed ? r.no.endsWith(c) : r.no.toUpperCase() === c));
  const fitting: InTransit[] = [];
  for (const r of named) {
    try {
      const row = await inTransitRow(db, r.id);
      if (!returningUndelivered(row.chain) && fits(row)) fitting.push(row);
    } catch (e) {
      if (!(e instanceof StoresError)) throw e;
    }
  }
  if (fitting.length === 0) {
    throw new StoresError(named.length === 0 ? "unknown_ticket" : "not_in_your_hands", named.length === 0 ? "no ticket on its way has that number" : "not in your hands");
  }
  if (fitting.length > 1) throw new StoresError("ambiguous_code", "two tickets end in those digits: scan the label", { count: fitting.length });
  return { row: fitting[0]!, method: typed ? "typed" : "scan" };
}

/** The source keepers who confirm a late or future-dated scan (the custodian roles of the supplying store). */
async function sourceKeepers(tx: Tx, storeId: string): Promise<string[]> {
  const store = await storesStoreRow(tx, storeId);
  const out = new Set<string>();
  for (const role of store.custodianRoles) for (const u of await usersHoldingRole(tx, role)) out.add(u);
  return [...out].sort();
}

type HandoffInput = {
  kind: "take" | "hand_over" | "take_over" | "return_accepted"; from: string; to: string; method: "scan" | "typed" | "forced" | "counter";
  reason?: string | null; clock: { phoneAt: Date | null; occurredAt: Date; flag: ScanFlag | null };
};

async function writeHandoff(tx: Tx, row: InTransit, h: HandoffInput, now: Date): Promise<string> {
  const id = newId();
  await tx.insert(storesCustodyHandoffs).values({
    id, indentId: row.indent.id, transferId: row.transfer.id, kind: h.kind, fromUserId: h.from, toUserId: h.to, method: h.method,
    reason: h.reason ?? null, phoneAt: h.clock.phoneAt, occurredAt: h.clock.occurredAt, recordedAt: now, flag: h.clock.flag,
  });
  if (h.clock.flag !== null) {
    for (const u of await sourceKeepers(tx, row.indent.toResourceId)) {
      await notify(tx, u, WORDS.lateScan, row.indent, `late-scan:${id}`, now);
    }
  }
  return id;
}

async function requireCarrier(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_CARRY))) throw new StoresError("not_permitted", "only a porter carries a ticket", { permission: STORES_CARRY });
}

// ═══════════════════════════════ take, hand on, take over ═══════════════════════════════

/** Decision 7: a porter takes custody from the store (the issuer, or whoever took it over) by scanning the label. */
export async function takeCustody(db: Db, actor: Actor, scan: ScanInput, now: Date = new Date()): Promise<CustodyResult> {
  const seen = await seenKey(db, actor, scan.clientKey);
  if (seen !== null) return duplicateOf(db, seen, now);
  await requireCarrier(db, actor);
  const clock = scanClock(scan.scannedAt, now);
  // At the store: nobody carried it yet, or the last hand was a take-over (back with the keeper or the head).
  const { row, method } = await ticketByCode(db, scan.code, (t) => t.chain.handoffs.length === 0 || t.chain.handoffs.at(-1)!.kind === "take_over");
  const from = holderOf(row.transfer.issuedBy, row.chain);
  if (from === actor.id) throw new StoresError("not_in_your_hands", "it is already in your hands");
  const dup = await withTx(db, async (tx) => {
    const locked = await inTransitRow(tx, row.indent.id, true);
    if (holderOf(locked.transfer.issuedBy, locked.chain) !== from) throw new StoresError("not_in_your_hands", "someone else took it first");
    if (!(await claimKey(tx, actor, scan.clientKey, "take_custody", row.indent.id, now))) return true;
    await writeHandoff(tx, locked, { kind: "take", from, to: actor.id, method, clock }, now);
    await recordAct(tx, actor, now, { act: "take_custody", storeId: row.indent.toResourceId, refId: row.indent.id, before: from, after: actor.id, reason: clock.flag });
    return false;
  });
  return { ticket: (await getTicket(db, row.indent.id, now))!, duplicate: dup, flag: dup ? null : clock.flag };
}

/**
 * Decision 7: porter to porter, recorded by the INCOMING porter's scan. Only the current holder hands on:
 * `fromUserId` must be whose hands it is in, else `not_in_your_hands` and nothing is written.
 */
export async function handOver(db: Db, actor: Actor, scan: ScanInput & { fromUserId: string }, now: Date = new Date()): Promise<CustodyResult> {
  const seen = await seenKey(db, actor, scan.clientKey);
  if (seen !== null) return duplicateOf(db, seen, now);
  await requireCarrier(db, actor);
  if (scan.fromUserId === actor.id) throw new StoresError("not_in_your_hands", "it is already in your hands");
  const clock = scanClock(scan.scannedAt, now);
  const { row, method } = await ticketByCode(db, scan.code, (t) => holderOf(t.transfer.issuedBy, t.chain) === scan.fromUserId);
  const dup = await withTx(db, async (tx) => {
    const locked = await inTransitRow(tx, row.indent.id, true);
    if (holderOf(locked.transfer.issuedBy, locked.chain) !== scan.fromUserId) throw new StoresError("not_in_your_hands", "not in their hands");
    if (!(await claimKey(tx, actor, scan.clientKey, "hand_over", row.indent.id, now))) return true;
    await writeHandoff(tx, locked, { kind: "hand_over", from: scan.fromUserId, to: actor.id, method, clock }, now);
    await recordAct(tx, actor, now, { act: "hand_over", storeId: row.indent.toResourceId, refId: row.indent.id, before: scan.fromUserId, after: actor.id, reason: clock.flag });
    return false;
  });
  return { ticket: (await getTicket(db, row.indent.id, now))!, duplicate: dup, flag: dup ? null : clock.flag };
}

/**
 * UX pass (#1112, spec "Porter card"): the porter scans the label (or types its last four) and the system names
 * whose hands the goods are in, so nobody types a person. `act` says which intent the one confirm tap posts:
 * "take" (still at the store, the keeper's hands) or "hand_over" (another porter's). Read-only; the intent
 * that follows checks the holder again inside its own transaction.
 */
export async function custodyLookup(db: Db, actor: Actor, code: string, now: Date = new Date()): Promise<CustodyLookup> {
  await requireCarrier(db, actor);
  const notMine = (t: InTransit): boolean => holderOf(t.transfer.issuedBy, t.chain) !== actor.id;
  let found: { row: InTransit };
  try {
    found = await ticketByCode(db, code, notMine);
  } catch (e) {
    if (!(e instanceof StoresError) || e.code !== "not_in_your_hands") throw e;
    const mine = await ticketByCode(db, code, (t) => !notMine(t)).then(() => true, () => false);
    if (mine) throw new StoresError("already_yours", "it is already in your hands");
    throw e;
  }
  const { row } = found;
  const holder = holderOf(row.transfer.issuedBy, row.chain);
  const last = row.chain.handoffs.at(-1);
  const [u] = await db.select({ n: users.fullName }).from(users).where(eq(users.id, holder));
  return {
    ticket: (await getTicket(db, row.indent.id, now))!,
    act: last === undefined || last.kind === "take_over" ? "take" : "hand_over",
    holder: { id: holder, name: u?.n ?? holder },
  };
}

/** May this person take the goods over (decision 7, "porter gone")? The source store's keepers and the materials head. */
async function mayTakeOver(db: Db | Tx, actor: Actor, sourceId: string): Promise<boolean> {
  return (await holds(db, actor, STORES_MASTERS)) || (await keepsStore(db, actor, await storesStoreRow(db, sourceId)));
}

/** Decision 7: the source keeper or the materials head takes the goods from whoever holds them, with a reason. */
export async function takeOverCustody(db: Db, actor: Actor, indentId: string, reason: string, now: Date = new Date()): Promise<CustodyResult> {
  const row = await inTransitRow(db, indentId);
  if (!(await mayTakeOver(db, actor, row.indent.toResourceId))) {
    throw new StoresError("not_permitted", "only the source store's keeper or the materials head takes it over", { storeId: row.indent.toResourceId });
  }
  const why = cleanText(reason);
  if (why === null) throw new StoresError("reason_required", "a take-over says why");
  await withTx(db, async (tx) => {
    const locked = await inTransitRow(tx, indentId, true);
    if (returningUndelivered(locked.chain)) throw new StoresError("not_in_transit", "it is on its way back");
    const from = holderOf(locked.transfer.issuedBy, locked.chain);
    if (from === actor.id) throw new StoresError("not_in_your_hands", "it is already in your hands");
    await writeHandoff(tx, locked, { kind: "take_over", from, to: actor.id, method: "forced", reason: why, clock: scanClock(null, now) }, now);
    await recordAct(tx, actor, now, { act: "take_over", storeId: locked.indent.toResourceId, refId: indentId, before: from, after: actor.id, reason: why });
  });
  return { ticket: (await getTicket(db, indentId, now))!, duplicate: false, flag: null };
}

// ═══════════════════════════════ the receipt ═══════════════════════════════

type LinePlan = {
  transferLineId: string; batchId: string; lineIdx: number; itemId: string;
  accepted: number; short: number; wrong: number; damaged: number;
};

/**
 * Splits each ticket line's answer (accepted / short / wrong / damaged, adding up to what was issued) over the
 * batches it went in (the transfer lines, FEFO order): accepted first, then short, wrong, damaged.
 */
async function planDelivery(tx: Tx, row: InTransit, input: DeliverInput): Promise<LinePlan[]> {
  const lines = await tx.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, row.indent.id)).orderBy(asc(storeIndentLines.lineIdx));
  const tls = await tx.select({ tl: transferLines, itemId: stockBatches.itemId }).from(transferLines)
    .innerJoin(stockBatches, eq(stockBatches.id, transferLines.batchId))
    .where(eq(transferLines.transferId, row.transfer.id)).orderBy(asc(transferLines.id));
  const given = new Map<number, { accepted?: number; short?: number; wrong?: number; damaged?: number }>();
  for (const g of input.lines ?? []) {
    if (!lines.some((l) => l.lineIdx === g.lineIdx) || given.has(g.lineIdx)) throw new StoresError("bad_quantity", `no line ${String(g.lineIdx)}, or given twice`, { lineIdx: g.lineIdx });
    given.set(g.lineIdx, g);
  }
  const out: LinePlan[] = [];
  for (const l of lines) {
    const mine = tls.filter((t) => t.itemId === l.itemId);
    const issued = mine.reduce((a, t) => a + t.tl.qtyIssued, 0);
    if (issued === 0) continue;
    const g = given.get(l.lineIdx);
    const parts = { short: g?.short ?? 0, wrong: g?.wrong ?? 0, damaged: g?.damaged ?? 0 };
    for (const v of Object.values(parts)) if (!Number.isSafeInteger(v) || v < 0) throw new StoresError("bad_quantity", "each quantity is a whole number, zero or more");
    const accepted = g?.accepted ?? issued - parts.short - parts.wrong - parts.damaged;
    if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted + parts.short + parts.wrong + parts.damaged !== issued) {
      throw new StoresError("bad_quantity", `line ${String(l.lineIdx)} went ${String(issued)}: accepted, short, wrong and damaged add up to it`, { lineIdx: l.lineIdx, issued });
    }
    const left = { accepted, ...parts };
    for (const t of mine) {
      let room = t.tl.qtyIssued;
      const take = (k: keyof typeof left): number => { const n = Math.min(room, left[k]); left[k] -= n; room -= n; return n; };
      out.push({ transferLineId: t.tl.id, batchId: t.tl.batchId, lineIdx: l.lineIdx, itemId: l.itemId, accepted: take("accepted"), short: take("short"), wrong: take("wrong"), damaged: take("damaged") });
    }
  }
  return out;
}

/**
 * Decision 8: the department receives, per line accepted / short / wrong / damaged. Only the accepted quantity
 * is received (`receiveAtShelf`: the shelf grant at the department, the cost centre, an expensed item used on
 * receipt). Wrong and damaged quantities are never charged: they stay in IN-TRANSIT, going back on the same chain
 * (`sent_back`, accepted by the source keeper: wrong → source, damaged → quarantine). A short stays in IN-TRANSIT
 * against the last custodian until the materials head resolves it. Never the issuer, never anyone who carried it.
 * No carrier leg = collected at the store counter.
 */
export async function deliverTicket(db: Db, actor: Actor, indentId: string, input: DeliverInput = {}, now: Date = new Date()): Promise<CustodyResult> {
  const seen = await seenKey(db, actor, input.clientKey);
  if (seen !== null) return duplicateOf(db, seen, now);
  const row = await inTransitRow(db, indentId);
  if (returningUndelivered(row.chain)) throw new StoresError("not_in_transit", `${row.indent.indentNo} is on its way back`);
  if (actor.id === row.transfer.issuedBy) throw new StoresError("you_issued_it", "you issued it: the department receives it");
  if (carriersOf(row.chain).has(actor.id)) throw new StoresError("you_carried_it", "you carried it: someone in the department receives it");
  const shelf = await requireShelf(db, row.details.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const { occurredAt } = scanClock(input.scannedAt, now);
  const atCounter = row.chain.handoffs.length === 0;
  const dup = await withTx(db, async (tx) => {
    const locked = await inTransitRow(tx, indentId, true);
    if (!(await claimKey(tx, actor, input.clientKey, "deliver_ticket", indentId, now))) return true;
    const plan = await planDelivery(tx, locked, input);
    const quarantine = plan.some((p) => p.damaged > 0) ? await ensureQuarantineStore(tx) : null;
    await receiveAtShelf(tx as unknown as Db, actor, locked.transfer.id, occurredAt, plan.map((p) => ({ lineId: p.transferLineId, qtyReceived: p.accepted })), shelf.id);
    await tx.insert(storesDeliveryLines).values(plan.map((p) => ({
      transferLineId: p.transferLineId, transferId: locked.transfer.id, indentId, lineIdx: p.lineIdx, itemId: p.itemId,
      accepted: p.accepted, short: p.short, wrong: p.wrong, damaged: p.damaged, receivedBy: actor.id, receivedAt: occurredAt, atCounter,
    })));
    const back = plan.flatMap((p) => [
      ...(p.wrong > 0 ? [{ p, qty: p.wrong, to: locked.indent.toResourceId }] : []),
      ...(p.damaged > 0 ? [{ p, qty: p.damaged, to: quarantine! }] : []),
    ]);
    if (back.length > 0) {
      await tx.insert(storesTransitResolutions).values(back.map((b) => ({
        id: newId(), indentId, transferId: locked.transfer.id, transferLineId: b.p.transferLineId, kind: "sent_back", qty: b.qty,
        toResourceId: b.to, approvalId: null, status: "pending", note: b.to === quarantine ? "damaged" : "wrong", requestedBy: actor.id, requestedAt: occurredAt,
        postedBy: null, postedAt: null,
      })));
    }
    const short = plan.reduce((a, p) => a + p.short, 0);
    const sentBack = back.reduce((a, b) => a + b.qty, 0);
    await recordAct(tx, actor, now, {
      act: "deliver_ticket", storeId: shelf.id, refId: indentId, after: { atCounter, short, sentBack, lastCustodian: lastCustodianOf(locked.transfer.issuedBy, locked.chain) },
      lines: plan.map((p) => ({ itemId: p.itemId, batchId: p.batchId, accepted: p.accepted, short: p.short, wrong: p.wrong, damaged: p.damaged })),
    });
    const words = sentBack > 0 ? deliveredSentBack(sentBack) : short > 0 ? deliveredShort(short) : WORDS.delivered;
    await notify(tx, locked.indent.requestedBy, words, locked.indent, "delivered", now);
    return false;
  });
  return { ticket: (await getTicket(db, indentId, now))!, duplicate: dup, flag: null };
}

// ═══════════════════════════════ undelivered, and taking goods back ═══════════════════════════════

/** Decision 8: nobody signed — the holder brings the whole transfer back; the source keeper accepts it (`acceptReturn`). */
export async function returnUndelivered(
  db: Db, actor: Actor, indentId: string, input: { clientKey?: string | null; scannedAt?: string | null } = {}, now: Date = new Date(),
): Promise<CustodyResult> {
  const seen = await seenKey(db, actor, input.clientKey);
  if (seen !== null) return duplicateOf(db, seen, now);
  const { occurredAt } = scanClock(input.scannedAt, now);
  const dup = await withTx(db, async (tx) => {
    const row = await inTransitRow(tx, indentId, true);
    if (returningUndelivered(row.chain)) throw new StoresError("not_in_transit", "it is already on its way back");
    if (holderOf(row.transfer.issuedBy, row.chain) !== actor.id || row.chain.handoffs.length === 0) throw new StoresError("not_in_your_hands", "not in your hands");
    if (!(await claimKey(tx, actor, input.clientKey, "return_undelivered", indentId, now))) return true;
    const tls = await tx.select().from(transferLines).where(eq(transferLines.transferId, row.transfer.id)).orderBy(asc(transferLines.id));
    await tx.insert(storesTransitResolutions).values(tls.map((tl) => ({
      id: newId(), indentId, transferId: row.transfer.id, transferLineId: tl.id, kind: "undelivered", qty: tl.qtyIssued,
      toResourceId: row.indent.toResourceId, approvalId: null, status: "pending", note: null, requestedBy: actor.id, requestedAt: occurredAt,
      postedBy: null, postedAt: null,
    })));
    await recordAct(tx, actor, now, { act: "return_undelivered", storeId: row.indent.toResourceId, refId: indentId, before: actor.id });
    return false;
  });
  return { ticket: (await getTicket(db, indentId, now))!, duplicate: dup, flag: null };
}

/**
 * The source keeper takes back what is coming back: a whole undelivered transfer (→ the source; the ticket reads
 * "Returned undelivered") or the wrong and damaged lines a receiver sent back (wrong → source, damaged →
 * quarantine). IN-TRANSIT → there, through materials `returnInTransit`, and the chain's last hand is to the keeper.
 */
export async function acceptReturn(db: Db, actor: Actor, indentId: string, now: Date = new Date()): Promise<TicketView> {
  const t = await requireTicketRow(db, indentId);
  if (!(await keepsStore(db, actor, await storesStoreRow(db, t.indent.toResourceId)))) {
    throw new StoresError("not_permitted", "only the source store's keeper takes goods back", { storeId: t.indent.toResourceId });
  }
  await withTx(db, async (tx) => {
    const locked = await requireTicketRow(tx, indentId, true);
    if (locked.indent.transferId === null) throw new StoresError("nothing_to_return", `${locked.indent.indentNo} was never issued`);
    const pending = await tx.select().from(storesTransitResolutions).where(and(
      eq(storesTransitResolutions.indentId, indentId), inArray(storesTransitResolutions.kind, ["sent_back", "undelivered"]), eq(storesTransitResolutions.status, "pending"),
    ));
    if (pending.length === 0) throw new StoresError("nothing_to_return", `nothing on ${locked.indent.indentNo} is coming back`);
    const [transfer] = await tx.select().from(transfers).where(eq(transfers.id, locked.indent.transferId));
    await returnInTransit(tx, actor, locked.indent.transferId, pending.map((p) => ({ lineId: p.transferLineId, qty: p.qty, toResourceId: p.toResourceId ?? locked.indent.toResourceId })), now);
    for (const p of pending) {
      await tx.update(storesTransitResolutions).set({ status: "posted", postedBy: actor.id, postedAt: now }).where(eq(storesTransitResolutions.id, p.id));
    }
    const chain = await chainOf(tx, indentId);
    const from = lastCustodianOf(transfer!.issuedBy, chain);
    if (from !== actor.id) {
      const row = { ...locked, transfer: transfer!, chain };
      await writeHandoff(tx, row, { kind: "return_accepted", from, to: actor.id, method: "counter", clock: scanClock(null, now) }, now);
    }
    const undelivered = pending.some((p) => p.kind === "undelivered");
    await recordAct(tx, actor, now, {
      act: "accept_return", storeId: locked.indent.toResourceId, refId: indentId, reason: undelivered ? "undelivered" : "sent_back",
      lines: pending.map((p) => ({ transferLineId: p.transferLineId, qty: p.qty, to: p.toResourceId })),
    });
    if (undelivered) await notify(tx, locked.indent.requestedBy, WORDS.returnedUndelivered, locked.indent, "returned-undelivered", now);
  });
  return (await getTicket(db, indentId, now))!;
}

// ═══════════════════════════════ shorts (decision 9) ═══════════════════════════════

/**
 * The materials head resolves a short line: "found" (a late receipt into the shelf, charged then), "returned"
 * (back to the source) or "lost" (an adjustment request to the stock-adjustment approver — the medical
 * superintendent — and NOTHING is posted until it is granted; `postTransitLoss`). Nothing writes off by itself.
 */
export async function resolveShort(
  db: Db, actor: Actor, indentId: string, input: { lineIdx: number; resolution: ShortResolution; note?: string | null }, now: Date = new Date(),
): Promise<{ ticket: TicketView; approvalId: string | null }> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "the materials head resolves a short", { permission: STORES_MASTERS });
  if (!["found", "returned", "lost"].includes(input.resolution)) throw new StoresError("bad_quantity", "found, returned or lost");
  const approvalId = await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const shorts = (await tx.select().from(storesDeliveryLines).where(and(eq(storesDeliveryLines.indentId, indentId), eq(storesDeliveryLines.lineIdx, input.lineIdx))))
      .filter((d) => d.short > 0);
    if (shorts.length === 0 || t.indent.transferId === null) throw new StoresError("nothing_short", `line ${String(input.lineIdx)} came in full`);
    const live = await tx.select({ id: storesTransitResolutions.id }).from(storesTransitResolutions).where(and(
      inArray(storesTransitResolutions.transferLineId, shorts.map((s) => s.transferLineId)), inArray(storesTransitResolutions.kind, ["found", "returned", "lost"]),
    ));
    const refused = live.length === 0 ? [] : await tx.select({ id: storesTransitResolutions.id }).from(storesTransitResolutions)
      .where(and(inArray(storesTransitResolutions.id, live.map((l) => l.id)), eq(storesTransitResolutions.status, "refused")));
    if (live.length > refused.length) throw new StoresError("already_resolved", `line ${String(input.lineIdx)}'s short is already resolved`);
    const transferId = t.indent.transferId;
    const note = cleanText(input.note);
    let approval: string | null = null;
    if (input.resolution === "found") {
      const shelf = await requireShelf(tx, t.details.shelfId);
      await receiveLate(tx, actor, transferId, shorts.map((s) => ({ lineId: s.transferLineId, qty: s.short })), now, undefined, { costCenter: shelf.departmentCode, throughStores: true });
    } else if (input.resolution === "returned") {
      await returnInTransit(tx, actor, transferId, shorts.map((s) => ({ lineId: s.transferLineId, qty: s.short, toResourceId: t.indent.toResourceId })), now, undefined,
        { authorisedBy: "stores" });
    } else {
      const qty = shorts.reduce((a, s) => a + s.short, 0);
      ({ approvalId: approval } = await requestApproval(tx, actor, {
        typeKey: STOCK_ADJUSTMENT_APPROVAL_TYPE, subject: { type: "stores_transit_loss", id: `${indentId}:${String(input.lineIdx)}` },
        requestNote: `${t.indent.indentNo} line ${String(input.lineIdx + 1)}: ${String(qty)} lost in transit${note === null ? "" : ` — ${note}`}`,
      }));
    }
    const posted = input.resolution !== "lost";
    await tx.insert(storesTransitResolutions).values(shorts.map((s) => ({
      id: newId(), indentId, transferId, transferLineId: s.transferLineId, kind: input.resolution, qty: s.short,
      toResourceId: input.resolution === "returned" ? t.indent.toResourceId : input.resolution === "found" ? t.details.shelfId : null,
      approvalId: approval, status: posted ? "posted" : "pending", note, requestedBy: actor.id, requestedAt: now,
      postedBy: posted ? actor.id : null, postedAt: posted ? now : null,
    })));
    await recordAct(tx, actor, now, {
      act: "resolve_short", storeId: t.indent.toResourceId, refId: indentId, after: input.resolution, reason: note,
      lines: shorts.map((s) => ({ itemId: s.itemId, transferLineId: s.transferLineId, qty: s.short, approvalId: approval })),
    });
    return approval;
  });
  return { ticket: (await getTicket(db, indentId, now))!, approvalId };
}

/**
 * A "lost" short once its approval is decided: granted posts one `adjust` row per line OUT of IN-TRANSIT
 * (`ref_type = 'transit_loss'`); rejected marks the request refused, which frees the line to be resolved again.
 */
export async function postTransitLoss(db: Db, actor: Actor, approvalId: string, now: Date = new Date()): Promise<{ posted: number; refused: number }> {
  if (!(await holds(db, actor, STORES_MASTERS))) throw new StoresError("not_permitted", "the materials head books a loss", { permission: STORES_MASTERS });
  const approval = await getApproval(db, approvalId);
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(storesTransitResolutions).where(and(eq(storesTransitResolutions.approvalId, approvalId), eq(storesTransitResolutions.status, "pending")));
    if (rows.length === 0) return { posted: 0, refused: 0 };
    if (approval?.status === "rejected") {
      for (const r of rows) await tx.update(storesTransitResolutions).set({ status: "refused" }).where(eq(storesTransitResolutions.id, r.id));
      return { posted: 0, refused: rows.length };
    }
    if (approval?.status !== "granted") throw new StoresError("not_approved", `approval ${approvalId} is ${approval?.status ?? "missing"}`);
    const transitId = await ensureTransitStore(tx);
    const lines = await tx.select().from(transferLines).where(inArray(transferLines.id, rows.map((r) => r.transferLineId)));
    await postMovements(tx, actor, rows.map((r) => ({
      resourceId: transitId, batchId: lines.find((l) => l.id === r.transferLineId)!.batchId, qtyDelta: -r.qty, reason: "adjust" as const,
      refType: "transit_loss", refId: r.id, occurredAt: now,
    })));
    for (const r of rows) await tx.update(storesTransitResolutions).set({ status: "posted", postedBy: actor.id, postedAt: now }).where(eq(storesTransitResolutions.id, r.id));
    await recordAct(tx, actor, now, { act: "resolve_short", refId: rows[0]!.indentId, after: "lost_posted", lines: rows.map((r) => ({ transferLineId: r.transferLineId, qty: r.qty, approvalId })) });
    return { posted: rows.length, refused: 0 };
  });
}

// ═══════════════════════════════ returns from a department (decision 10) ═══════════════════════════════

const RETURN_NOTE = "stores return";

/**
 * Unused, wrong or defective items go back from a shelf on a return ticket: a transfer shelf → its supplying
 * store (defective → the quarantine store, for a supplier return). The shelf's stock leaves at issue; the
 * department is CREDITED when the store receives it (`receiveReturn`), at the batch's cost.
 */
export async function raiseReturn(db: Db, actor: Actor, input: RaiseReturnInput, now: Date = new Date()): Promise<ReturnTicketView[]> {
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  if (input.lines.length === 0) throw new StoresError("bad_quantity", "a return names at least one item");
  if (shelf.suppliedBy === null) throw new StoresError("unknown_store", `${shelf.code} names no supplying store`, { storeId: shelf.id });
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new StoresError("bad_quantity", "each quantity is a whole number above zero");
    if (!["unused", "wrong", "defective"].includes(l.reason)) throw new StoresError("bad_quantity", "unused, wrong or defective");
    await requireStoresItem(db, l.itemId);
  }
  const ids = await withTx(db, async (tx) => {
    const groups: { to: string; quarantine: boolean; lines: typeof input.lines }[] = [];
    const toStore = input.lines.filter((l) => l.reason !== "defective");
    const defective = input.lines.filter((l) => l.reason === "defective");
    if (toStore.length > 0) groups.push({ to: shelf.suppliedBy!, quarantine: false, lines: toStore });
    if (defective.length > 0) groups.push({ to: await ensureQuarantineStore(tx), quarantine: true, lines: defective });
    const made: string[] = [];
    for (const g of groups) {
      const merged = new Map<string, number>();
      for (const l of g.lines) merged.set(l.itemId, (merged.get(l.itemId) ?? 0) + l.qtyBase);
      let transferId: string;
      try {
        ({ transferId } = await issueStock(tx, actor, {
          fromResourceId: shelf.id, toResourceId: g.to, lines: [...merged].map(([itemId, qtyBase]) => ({ itemId, qtyBase })),
          note: `${RETURN_NOTE} ${shelf.code}${cleanText(input.note) === null ? "" : ` — ${cleanText(input.note)!}`}`, occurredAt: now,
        }));
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code: string }).code === "insufficient_stock") throw new StoresError("more_than_on_hand", "more than on hand");
        throw e;
      }
      await recordAct(tx, actor, now, {
        act: "raise_return", storeId: shelf.id, refId: transferId, after: { to: g.to, quarantine: g.quarantine },
        lines: g.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase, reason: l.reason })),
      });
      made.push(transferId);
    }
    return made;
  });
  const out: ReturnTicketView[] = [];
  for (const id of ids) out.push(await returnView(db, id));
  return out;
}

/** Is this transfer a department's return: out of a Stores shelf? Returns the shelf. */
async function requireReturn(db: Db | Tx, transferId: string): Promise<{ transfer: typeof transfers.$inferSelect; shelf: Awaited<ReturnType<typeof requireShelf>> }> {
  const [transfer] = await db.select().from(transfers).where(eq(transfers.id, transferId));
  if (transfer === undefined) throw new StoresError("not_a_return", `transfer ${transferId} not found`);
  const [from] = await db.select().from(resources).where(eq(resources.id, transfer.fromResourceId));
  if (from === undefined || !isStoresStore(from) || toStoresStore(from).kind !== "shelf") throw new StoresError("not_a_return", "not a return from a department shelf");
  return { transfer, shelf: await requireShelf(db, from.id) };
}

/** The supplying store's keeper receives a return; both legs carry the department's cost centre, which credits it. */
export async function receiveReturn(db: Db, actor: Actor, transferId: string, now: Date = new Date()): Promise<ReturnTicketView> {
  const { transfer, shelf } = await requireReturn(db, transferId);
  if (shelf.suppliedBy === null || !(await keepsStore(db, actor, await storesStoreRow(db, shelf.suppliedBy)))) {
    throw new StoresError("not_permitted", "only the supplying store's keeper receives a return", { storeId: shelf.suppliedBy });
  }
  if (transfer.status !== "in_transit") throw new StoresError("not_in_transit", "this return is already received");
  await withTx(db, async (tx) => {
    const t = await getTransfer(tx, transferId);
    await receiveStock(tx, actor, transferId, t!.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })), now, undefined, { costCenter: shelf.departmentCode });
    await recordAct(tx, actor, now, { act: "receive_return", storeId: transfer.toResourceId, refId: transferId, after: { costCenter: shelf.departmentCode } });
  });
  return returnView(db, transferId);
}

/** Returns on their way to the stores the reader keeps. */
export async function returnsToReceive(db: Db, actor: Actor): Promise<ReturnTicketView[]> {
  if (actor.type !== "user") return [];
  const rows = await db.select().from(transfers).where(eq(transfers.status, "in_transit")).orderBy(asc(transfers.issuedAt)).limit(200);
  const out: ReturnTicketView[] = [];
  for (const r of rows) {
    if (!(r.note ?? "").startsWith(RETURN_NOTE)) continue;
    try {
      const { shelf } = await requireReturn(db, r.id);
      if (shelf.suppliedBy !== null && (await keepsStore(db, actor, await storesStoreRow(db, shelf.suppliedBy)))) out.push(await returnView(db, r.id));
    } catch (e) {
      if (!(e instanceof StoresError)) throw e;
    }
  }
  return out;
}

async function returnView(db: Db | Tx, transferId: string): Promise<ReturnTicketView> {
  const t = (await getTransfer(db, transferId))!;
  const places = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name, attributes: resources.attributes }).from(resources)
    .where(inArray(resources.id, [t.fromResourceId, t.toResourceId]))).map((p) => [p.id, p] as const));
  const [who] = await db.select({ n: users.fullName }).from(users).where(eq(users.id, t.issuedBy));
  const batchItems = t.lines.length === 0 ? [] : await db.select({ batchId: stockBatches.id, itemId: stockBatches.itemId, name: items.name }).from(stockBatches)
    .innerJoin(items, eq(items.id, stockBatches.itemId)).where(inArray(stockBatches.id, t.lines.map((l) => l.batchId)));
  const byItem = new Map<string, { itemId: string; itemName: string; qtyBase: number }>();
  for (const l of t.lines) {
    const b = batchItems.find((x) => x.batchId === l.batchId);
    if (b === undefined) continue;
    const cur = byItem.get(b.itemId) ?? { itemId: b.itemId, itemName: b.name, qtyBase: 0 };
    cur.qtyBase += l.qtyIssued;
    byItem.set(b.itemId, cur);
  }
  const place = (id: string): { id: string; code: string; name: string } => ({ id, code: places.get(id)?.code ?? "", name: places.get(id)?.name ?? id });
  return {
    transferId, status: t.status, shelf: place(t.fromResourceId), to: place(t.toResourceId),
    quarantine: (places.get(t.toResourceId)?.attributes as Record<string, unknown> | null)?.domain !== "stores",
    raisedBy: { id: t.issuedBy, name: who?.n ?? t.issuedBy }, raisedAt: t.issuedAt.toISOString(), lines: [...byItem.values()],
  };
}

/**
 * UX pass (#1112): tickets coming back to the stores the reader keeps — a whole transfer returning undelivered, or
 * the wrong and damaged lines a receiver sent back — waiting for the keeper's one-tap `acceptReturn`.
 */
export async function ticketsComingBack(db: Db, actor: Actor, now: Date = new Date()): Promise<TicketView[]> {
  if (actor.type !== "user") return [];
  const pending = await db.selectDistinct({ indentId: storesTransitResolutions.indentId }).from(storesTransitResolutions)
    .where(and(inArray(storesTransitResolutions.kind, ["sent_back", "undelivered"]), eq(storesTransitResolutions.status, "pending")));
  const kept = new Map<string, boolean>();
  const rows: TicketRow[] = [];
  for (const { indentId } of pending) {
    const r = await requireTicketRow(db, indentId);
    const source = r.indent.toResourceId;
    if (!kept.has(source)) kept.set(source, await keepsStore(db, actor, await storesStoreRow(db, source)));
    if (kept.get(source) === true) rows.push(r);
  }
  return (await ticketViews(db, rows, now)).sort((a, b) => a.clockFrom.localeCompare(b.clockFrom));
}

// ═══════════════════════════════ the porter's card and the keeper's late scans ═══════════════════════════════

/** "Tickets in my hands": every ticket on its way whose newest hand is the reader's. */
export async function myCustody(db: Db, actor: Actor, now: Date = new Date()): Promise<PorterCardRow[]> {
  if (actor.type !== "user") return [];
  const mine = await db.selectDistinct({ indentId: storesCustodyHandoffs.indentId }).from(storesCustodyHandoffs).where(eq(storesCustodyHandoffs.toUserId, actor.id));
  const out: PorterCardRow[] = [];
  for (const { indentId } of mine) {
    let row: InTransit;
    try { row = await inTransitRow(db, indentId); } catch (e) { if (e instanceof StoresError) continue; throw e; }
    if (holderOf(row.transfer.issuedBy, row.chain) !== actor.id) continue;
    const since = row.chain.handoffs.at(-1)!.occurredAt;
    const [view] = await ticketViews(db, [row], now);
    out.push({ ticket: view!, from: view!.source, to: view!.shelf, minutes: Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000)) });
  }
  return out.sort((a, b) => b.minutes - a.minutes);
}

/** Decision 14: the late or future-dated scans of the stores the reader keeps, not yet confirmed. */
export async function lateScansToConfirm(db: Db, actor: Actor): Promise<LateScan[]> {
  if (actor.type !== "user") return [];
  const rows = await db.select({ h: storesCustodyHandoffs, no: storeIndents.indentNo, source: storeIndents.toResourceId, n: users.fullName })
    .from(storesCustodyHandoffs)
    .innerJoin(storeIndents, eq(storeIndents.id, storesCustodyHandoffs.indentId))
    .leftJoin(users, eq(users.id, storesCustodyHandoffs.toUserId))
    .leftJoin(storesScanConfirmations, eq(storesScanConfirmations.handoffId, storesCustodyHandoffs.id))
    .where(isNull(storesScanConfirmations.handoffId))
    .orderBy(asc(storesCustodyHandoffs.recordedAt));
  const kept = new Map<string, boolean>();
  const out: LateScan[] = [];
  for (const r of rows) {
    if (r.h.flag === null || r.h.phoneAt === null) continue;
    if (!kept.has(r.source)) kept.set(r.source, await keepsStore(db, actor, await storesStoreRow(db, r.source)));
    if (kept.get(r.source) !== true) continue;
    out.push({
      handoffId: r.h.id, indentId: r.h.indentId, indentNo: r.no, kind: r.h.kind, by: { id: r.h.toUserId, name: r.n ?? r.h.toUserId },
      phoneAt: r.h.phoneAt.toISOString(), recordedAt: r.h.recordedAt.toISOString(), flag: r.h.flag as ScanFlag,
    });
  }
  return out;
}

export async function confirmLateScan(db: Db, actor: Actor, handoffId: string, now: Date = new Date()): Promise<{ ok: true }> {
  const [h] = await db.select({ h: storesCustodyHandoffs, source: storeIndents.toResourceId }).from(storesCustodyHandoffs)
    .innerJoin(storeIndents, eq(storeIndents.id, storesCustodyHandoffs.indentId)).where(eq(storesCustodyHandoffs.id, handoffId));
  if (h === undefined || h.h.flag === null) throw new StoresError("unknown_scan", "no late scan with that id");
  if (!(await keepsStore(db, actor, await storesStoreRow(db, h.source)))) throw new StoresError("not_permitted", "the source store's keeper confirms a late scan");
  await withTx(db, async (tx) => {
    const won = await tx.insert(storesScanConfirmations).values({ handoffId, confirmedBy: actor.id, confirmedAt: now }).onConflictDoNothing().returning({ id: storesScanConfirmations.handoffId });
    if (won.length === 0) throw new StoresError("already_confirmed", "this scan is already confirmed");
    await recordAct(tx, actor, now, { act: "confirm_late_scan", storeId: h.source, refId: h.h.indentId, after: handoffId, reason: h.h.flag });
  });
  return { ok: true };
}

