import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  items, orgDepartments, resources, roleAssignments, rolePermissions, storeIndentLines, storeIndents, storesPickingClaims, storesTicketDetails,
  transfers, users,
} from "../../kernel/db/schema";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import {
  addIndentLinesScoped, availableQtyByItem, issueIndent, issueIndentScoped, raiseIndentScoped, sellableBatchesByItem, stampIndentApproval, stampIndentReview,
} from "../materials";
import { taggedBatchIds } from "./asset-rules";
import { requireUnitsAt, unitsIntoTransit, unitsOnTransfers } from "./assets";
import { chainsOf, holderOf, lastCustodianOf, legsOf, returningUndelivered } from "./chain";
import {
  STORES_INDENTS_APPROVE, STORES_NIGHTSTORE_ISSUE, STORES_SHELF_WORK, departmentOf, holds, isStoresStore, recordAct, requireShelf, requireShelfAct,
  toStoresStore,
} from "./access";
import { StoresError } from "./errors";
import { requireStoresItem } from "./items";
import { TICKET_PRIORITIES } from "./types";
import type { IssueIndentInput } from "../materials";
import type { StoresStore } from "./access";
import type { ApproveTicketInput, RaiseTicketInput, TicketChannel, TicketPriority, TicketStage, TicketView } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S2a (#1112, decisions 1–6, 12) — THE REQUEST TICKET: raise, HOD approval and the medical
 * superintendent's stand-in, decline and re-raise, the emergency's after-the-fact review, the one picker's
 * claim, and the issue (the night store's included).
 *
 * The ticket IS the materials indent (decision 1): `raiseIndentScoped` writes it, `stores_ticket_details`
 * carries what Stores adds, and the approval is the indent's own write-once stamp (`stampIndentApproval`).
 * Every act appends one `stores.act_recorded` (refId = the indent) in its own transaction, and nothing about
 * a ticket's lane is stored: `stage` is derived from the rows every time it is read.
 */

/** Decision 6: a claim lapses after 30 idle minutes. */
export const CLAIM_IDLE_MS = 30 * 60_000;
/** Decision 4: an emergency issued first is reviewed within 24 h; after that it is overdue (S3's red card). */
export const EMERGENCY_REVIEW_MS = 24 * 60 * 60_000;
const LIST_LIMIT = 200;
const NOTICE_KIND = "stores.ticket";

const cleanText = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

// ═══════════════════════════════ notices (decision 12) ═══════════════════════════════

/** One line, a few words, English and Hindi. Never the decline's reason (decision 0069 precedent). */
export const WORDS = {
  toApprove: ["Indent to approve", "मंज़ूरी के लिए इंडेंट"],
  approved: ["Approved", "मंज़ूर"],
  declined: ["Not approved", "मंज़ूर नहीं"],
  onTheWay: ["On the way", "रास्ते में"],
  // S2b (#1112): the third notice of a delivered ticket, one of four, and the keeper's late-scan word.
  delivered: ["Delivered", "पहुँच गया"],
  returnedUndelivered: ["Returned undelivered", "बिना दिए वापस"],
  lateScan: ["Late scan to confirm", "देर वाला स्कैन जाँचें"],
} as const;

/** "Delivered, 3 short" / "Delivered, 2 sent back" — the number is the only thing that varies. */
export const deliveredShort = (n: number): readonly [string, string] => [`Delivered, ${String(n)} short`, `पहुँचा, ${String(n)} कम`];
export const deliveredSentBack = (n: number): readonly [string, string] => [`Delivered, ${String(n)} sent back`, `पहुँचा, ${String(n)} वापस`];

/** The issue voucher with the label QR (spec "To pick": Issue prints the voucher and label). Rendered by `voucher.ts`. */
export const ISSUE_VOUCHER_DOCUMENT = "stores_issue_voucher";

export async function notify(tx: Tx, userId: string, words: readonly [string, string], indent: { id: string; indentNo: string }, key: string, now: Date): Promise<void> {
  await raiseNotice(tx as unknown as Db, {
    userId, kind: NOTICE_KIND, title: words[0], body: `${words[1]} · ${indent.indentNo}`,
    refType: "store_indent", refId: indent.id, sourceKey: `stores-ticket:${indent.id}:${key}`, at: now,
  });
}

/** Holders of `permission` for a department: assigned AT it (`department`), or hospital-wide when `hospital`. */
export async function holdersOf(exec: Db | Tx, permission: string, scope: { departmentId: string } | "hospital"): Promise<string[]> {
  const rows = await (exec as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(
      eq(rolePermissions.permission, permission), eq(users.active, true),
      scope === "hospital"
        ? eq(roleAssignments.scopeType, "hospital")
        : and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, scope.departmentId)),
    ));
  return rows.map((r) => r.userId).sort();
}

/** Decision 3/12: the department's approvers, never the requester; when there is none, the stand-in (hospital scope). */
export async function approversToTell(exec: Db | Tx, departmentId: string, requesterId: string): Promise<string[]> {
  const own = (await holdersOf(exec, STORES_INDENTS_APPROVE, { departmentId })).filter((u) => u !== requesterId);
  if (own.length > 0) return own;
  return (await holdersOf(exec, STORES_INDENTS_APPROVE, "hospital")).filter((u) => u !== requesterId);
}

/** True when the user holds `permission` through any assignment at all — the cheap gate before a per-row check. */
async function holdsAnywhere(db: Db | Tx, userId: string, permission: string): Promise<boolean> {
  const [row] = await (db as Db).select({ u: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .where(and(eq(roleAssignments.userId, userId), eq(rolePermissions.permission, permission))).limit(1);
  return row !== undefined || (await holds(db, { type: "user", id: userId }, permission));
}

// ═══════════════════════════════ places and hours ═══════════════════════════════

type SourceStore = StoresStore & { serviceHours: string | null };

export async function storesStoreRow(db: Db | Tx, storeId: string): Promise<SourceStore> {
  const [row] = await db.select().from(resources).where(eq(resources.id, storeId));
  if (row === undefined || !isStoresStore(row)) throw new StoresError("unknown_store", `store ${storeId} is not a Stores store`, { storeId });
  const hours = (row.attributes as Record<string, unknown> | null)?.serviceHours;
  return { ...toStoresStore(row), serviceHours: typeof hours === "string" ? hours : null };
}

/** `"09:00-17:00"` in IST. A store that states no hours is always open. An overnight span (`22:00-06:00`) wraps. */
export function withinServiceHours(hours: string | null, now: Date): boolean {
  if (hours === null) return true;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours.trim());
  if (m === null) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const at = Math.floor((now.getTime() - istDayWindow(now).start.getTime()) / 60_000);
  return start <= end ? at >= start && at < end : at >= start || at < end;
}

/** Decision 5: an emergency raised outside the central store's hours goes to the night store it supplies. */
async function sourceFor(db: Db | Tx, supplierId: string, priority: TicketPriority, now: Date): Promise<{ source: SourceStore; night: boolean }> {
  const supplier = await storesStoreRow(db, supplierId);
  if (priority !== "emergency" || supplier.kind !== "central" || withinServiceHours(supplier.serviceHours, now)) return { source: supplier, night: false };
  const rows = await db.select().from(resources).where(eq(resources.kind, "store"));
  const night = rows.filter((r) => isStoresStore(r) && r.status !== "retired").map(toStoresStore)
    .find((s) => s.kind === "night" && s.suppliedBy === supplier.id);
  if (night === undefined) return { source: supplier, night: false };
  return { source: await storesStoreRow(db, night.id), night: true };
}

// ═══════════════════════════════ raise ═══════════════════════════════

type Origin = { indentId: string; kind: "re_raise" | "re_ask"; clockFrom: Date };

/** Decision 1: a shelf-grant holder (no `materials.*` grant) asks the shelf's supplier. The HOD answers it. */
export async function raiseTicket(db: Db, actor: Actor, input: RaiseTicketInput, now: Date = new Date()): Promise<TicketView> {
  const id = await raise(db, actor, input, now, null);
  return (await getTicket(db, id, now))!;
}

/**
 * `approval: false` only for a re-ask (S2b, decision 6): the short part of a ticket the HOD already approved
 * rides on that approval, so it is raised with no stamp to wait for and no approver is told.
 */
async function raise(db: Db, actor: Actor, input: RaiseTicketInput, now: Date, origin: Origin | null, approval = true): Promise<string> {
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  if (!TICKET_PRIORITIES.includes(input.priority)) throw new StoresError("bad_quantity", "priority is routine, urgent or emergency");
  if (input.lines.length === 0) throw new StoresError("bad_quantity", "a ticket asks for at least one item");
  const lines: { itemId: string; qtyBase: number }[] = [];
  for (const l of input.lines) {
    if (typeof l.itemId !== "string" || l.itemId.trim() === "") throw new StoresError("item_id_required", "choose each item from the list");
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new StoresError("bad_quantity", "each quantity is a whole number above zero", { itemId: l.itemId });
    lines.push({ itemId: l.itemId, qtyBase: l.qtyBase });
  }
  const reason = cleanText(input.emergencyReason);
  if (input.priority === "emergency" && reason === null) throw new StoresError("reason_required", "an emergency ticket says why");
  for (const l of lines) await requireStoresItem(db, l.itemId);
  if (shelf.suppliedBy === null) throw new StoresError("unknown_store", `${shelf.code} names no supplying store`, { storeId: shelf.id });
  const { source, night } = await sourceFor(db, shelf.suppliedBy, input.priority, now);

  const indent = await withTx(db, async (tx) => {
    const made = await raiseIndentScoped(tx, actor, { fromResourceId: shelf.id, toResourceId: source.id, lines, note: input.note ?? null }, now,
      approval ? { issueBeforeApproval: input.priority === "emergency" } : null);
    await tx.insert(storesTicketDetails).values({
      indentId: made.indentId, departmentId: shelf.departmentId, shelfId: shelf.id, priority: input.priority,
      channel: input.channel ?? "web", neededBy: input.neededBy == null ? null : new Date(input.neededBy),
      deliverTo: cleanText(input.deliverTo), emergencyReason: input.priority === "emergency" ? reason : null, night,
      originIndentId: origin?.indentId ?? null, originKind: origin?.kind ?? null, clockFrom: origin?.clockFrom ?? now,
    });
    await recordAct(tx, actor, now, {
      act: origin?.kind === "re_raise" ? "reraise_ticket" : origin?.kind === "re_ask" ? "reask_ticket" : "raise_ticket", storeId: shelf.id, refId: made.indentId,
      after: { indentNo: made.indentNo, priority: input.priority, sourceId: source.id, night, origin: origin?.indentId ?? null },
      reason: input.priority === "emergency" ? reason : null, lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })),
    });
    const ref = { id: made.indentId, indentNo: made.indentNo };
    if (approval) for (const u of await approversToTell(tx, shelf.departmentId, actor.id)) await notify(tx, u, WORDS.toApprove, ref, "to-approve", now);
    return ref;
  });
  return indent.id;
}

/** Decision 3: a declined ticket re-raises in one call with its lines, linked to the first and on the first's clock. */
export async function reRaiseTicket(db: Db, actor: Actor, indentId: string, now: Date = new Date()): Promise<TicketView> {
  const first = await requireTicketRow(db, indentId);
  if (first.indent.approvalDecision !== "declined") throw new StoresError("not_declined", `${first.indent.indentNo} was not declined`);
  const [child] = await db.select({ id: storesTicketDetails.indentId }).from(storesTicketDetails)
    .where(and(eq(storesTicketDetails.originIndentId, indentId), eq(storesTicketDetails.originKind, "re_raise")));
  if (child !== undefined) throw new StoresError("already_reraised", `${first.indent.indentNo} was already raised again`, { indentId: child.id });
  const lines = await db.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx));
  const d = first.details;
  const id = await raise(db, actor, {
    shelfId: d.shelfId, lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })), priority: d.priority as TicketPriority,
    channel: d.channel as TicketChannel, neededBy: d.neededBy?.toISOString() ?? null, deliverTo: d.deliverTo, emergencyReason: d.emergencyReason,
    note: first.indent.note,
  }, now, { indentId, kind: "re_raise", clockFrom: d.clockFrom });
  return (await getTicket(db, id, now))!;
}

/**
 * S2b (#1112, decision 6) — THE BACK-ORDER: the short part of an issued ticket (asked or approved, less issued),
 * re-asked in one call as a linked ticket on the first one's clock. It rides on the first ticket's approval, so
 * it waits only for stock: it is on "To pick" once the store holds enough of every line (`ticketsToPick`).
 */
export async function reAskShort(db: Db, actor: Actor, indentId: string, now: Date = new Date()): Promise<TicketView> {
  const first = await requireTicketRow(db, indentId);
  if (first.indent.status !== "issued") throw new StoresError("nothing_to_reask", `${first.indent.indentNo} is not issued`);
  const [child] = await db.select({ id: storesTicketDetails.indentId }).from(storesTicketDetails)
    .where(and(eq(storesTicketDetails.originIndentId, indentId), eq(storesTicketDetails.originKind, "re_ask")));
  if (child !== undefined) throw new StoresError("already_reasked", `${first.indent.indentNo}'s short part was already asked again`, { indentId: child.id });
  const lines = (await db.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx)))
    .map((l) => ({ itemId: l.itemId, qtyBase: (l.qtyApproved ?? l.qtyBase) - (l.qtyIssued ?? 0) })).filter((l) => l.qtyBase > 0);
  if (lines.length === 0) throw new StoresError("nothing_to_reask", `${first.indent.indentNo} went in full`);
  const d = first.details;
  const id = await raise(db, actor, {
    shelfId: d.shelfId, lines, priority: d.priority as TicketPriority, channel: d.channel as TicketChannel,
    neededBy: d.neededBy?.toISOString() ?? null, deliverTo: d.deliverTo, emergencyReason: d.emergencyReason, note: first.indent.note,
  }, now, { indentId, kind: "re_ask", clockFrom: d.clockFrom }, false);
  return (await getTicket(db, id, now))!;
}

/**
 * The raise sheet's "Add to open ticket?" (spec "Raise"): the shelf's newest ticket still waiting for its HOD, when
 * one exists. An item already on it is left off (an item is asked once per ticket); the rest join it as new lines.
 */
export async function openTicketFor(db: Db, actor: Actor, shelfId: string, now: Date = new Date()): Promise<TicketView | null> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const rows = (await ticketRows(db, and(eq(storesTicketDetails.shelfId, shelfId), eq(storeIndents.status, "requested"),
    eq(storeIndents.approvalRequired, true), isNull(storeIndents.approvalDecision))));
  const newest = rows.at(-1);
  return newest === undefined ? null : ((await ticketViews(db, [newest], now))[0] ?? null);
}

/**
 * UX pass (walk finding 5) — "My tickets" on the shelf: the shelf's newest tickets, any stage, newest first, read
 * with the shelf's own grant. The requester follows a ticket after "Sent" from here.
 */
export async function shelfTickets(db: Db | Tx, actor: Actor, shelfId: string, now: Date = new Date()): Promise<TicketView[]> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "read");
  const rows = await db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .where(eq(storesTicketDetails.shelfId, shelfId))
    .orderBy(desc(storeIndents.requestedAt), desc(storeIndents.indentNo)).limit(SHELF_TICKETS_LIMIT);
  return ticketViews(db, rows, now);
}
const SHELF_TICKETS_LIMIT = 20;

/**
 * UX pass (walk finding 14, programme §5.5 "Not your department: ask the HOD of X") — who a refused reader asks:
 * the department's approvers (assigned AT it), else its shelf in-charges, else the hospital-scope stand-ins. Names
 * only; any signed-in user may read it, because the refusal is what sends them here.
 */
export async function whoToAsk(
  db: Db | Tx, actor: Actor, at: { shelfId: string } | { indentId: string },
): Promise<{ department: { id: string; name: string }; ask: { id: string; name: string }[] }> {
  if (actor.type !== "user") throw new StoresError("not_permitted", "a person asks", {});
  const departmentId = "shelfId" in at ? (await requireShelf(db, at.shelfId)).departmentId : (await requireTicketRow(db, at.indentId)).details.departmentId;
  const dept = await departmentOf(db, departmentId);
  let ids = await holdersOf(db, STORES_INDENTS_APPROVE, { departmentId });
  if (ids.length === 0) ids = await holdersOf(db, STORES_SHELF_WORK, { departmentId });
  if (ids.length === 0) ids = await holdersOf(db, STORES_INDENTS_APPROVE, "hospital");
  ids = ids.slice(0, WHO_TO_ASK_LIMIT);
  const names = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids));
  return { department: { id: dept.id, name: dept.name }, ask: ids.map((id) => ({ id, name: names.find((n) => n.id === id)?.name ?? id })) };
}
const WHO_TO_ASK_LIMIT = 2;

export async function addToOpenTicket(
  db: Db, actor: Actor, indentId: string, input: { lines: { itemId?: string | null; qtyBase: number }[] }, now: Date = new Date(),
): Promise<{ ticket: TicketView; added: string[]; alreadyOn: string[] }> {
  const t = await requireTicketRow(db, indentId);
  const shelf = await requireShelf(db, t.details.shelfId);
  await requireShelfAct(db, actor, shelf, "work");
  const result = await withTx(db, async (tx) => {
    const locked = await requireTicketRow(tx, indentId, true);
    if (locked.indent.status !== "requested" || locked.indent.approvalDecision !== null || !locked.indent.approvalRequired) {
      throw new StoresError("already_decided", `${locked.indent.indentNo} is no longer waiting for its HOD`);
    }
    const on = new Set((await tx.select({ itemId: storeIndentLines.itemId }).from(storeIndentLines).where(eq(storeIndentLines.indentId, indentId))).map((l) => l.itemId));
    const add: { itemId: string; qtyBase: number }[] = [];
    const alreadyOn: string[] = [];
    for (const l of input.lines) {
      if (typeof l.itemId !== "string" || l.itemId.trim() === "") throw new StoresError("item_id_required", "choose each item from the list");
      if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new StoresError("bad_quantity", "each quantity is a whole number above zero", { itemId: l.itemId });
      await requireStoresItem(tx, l.itemId);
      if (on.has(l.itemId) || add.some((a) => a.itemId === l.itemId)) alreadyOn.push(l.itemId);
      else add.push({ itemId: l.itemId, qtyBase: l.qtyBase });
    }
    if (add.length === 0) throw new StoresError("already_on_ticket", `everything asked is already on ${locked.indent.indentNo}`, { itemIds: alreadyOn });
    await addIndentLinesScoped(tx, locked.indent.id, add);
    await recordAct(tx, actor, now, { act: "add_to_ticket", storeId: shelf.id, refId: indentId, lines: add.map((a) => ({ itemId: a.itemId, qtyBase: a.qtyBase })) });
    return { added: add.map((a) => a.itemId), alreadyOn };
  });
  return { ticket: (await getTicket(db, indentId, now))!, ...result };
}

// ═══════════════════════════════ approve, decline, review ═══════════════════════════════

export type TicketRow = { indent: typeof storeIndents.$inferSelect; details: typeof storesTicketDetails.$inferSelect };

export async function requireTicketRow(db: Db | Tx, indentId: string, lock = false): Promise<TicketRow> {
  const q = db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id)).where(eq(storeIndents.id, indentId));
  const [row] = lock ? await q.for("update", { of: storeIndents }) : await q;
  if (row === undefined) throw new StoresError("unknown_ticket", `ticket ${indentId} not found`, { indentId });
  return row;
}

/**
 * The approver's authority (decision 3): `stores.indents.approve` AT the requesting department (a
 * hospital-scoped holding — the medical superintendent's — satisfies any department, and is the stand-in:
 * `forHod`). Never the requester.
 */
async function requireApprover(tx: Tx, actor: Actor, t: TicketRow): Promise<{ forHod: boolean }> {
  if (!(await holds(tx, actor, STORES_INDENTS_APPROVE, t.details.departmentId))) {
    throw new StoresError("not_permitted", "not your department", { permission: STORES_INDENTS_APPROVE, departmentId: t.details.departmentId });
  }
  if (t.indent.requestedBy === actor.id) throw new StoresError("own_ticket", "your own ticket goes to another approver");
  const deptOwn = (await holdersOf(tx, STORES_INDENTS_APPROVE, { departmentId: t.details.departmentId })).includes(actor.id);
  return { forHod: !deptOwn };
}

function requireOpen(t: TicketRow): void {
  if (t.indent.approvalDecision !== null || t.indent.status !== "requested") {
    throw new StoresError("already_decided", `${t.indent.indentNo} is already ${t.indent.approvalDecision ?? t.indent.status}`);
  }
}

/** Decision 3: approve, optionally at less than asked on a line (never more). The requester is told "Approved". */
export async function approveTicket(db: Db, actor: Actor, indentId: string, input: ApproveTicketInput = {}, now: Date = new Date()): Promise<TicketView> {
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const { forHod } = await requireApprover(tx, actor, t);
    requireOpen(t);
    const lines = await tx.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx));
    const given = new Map<number, number>();
    for (const g of input.lines ?? []) {
      const line = lines.find((l) => l.lineIdx === g.lineIdx);
      if (line === undefined || given.has(g.lineIdx)) throw new StoresError("bad_quantity", `no line ${String(g.lineIdx)}, or given twice`, { lineIdx: g.lineIdx });
      if (!Number.isSafeInteger(g.qtyBase) || g.qtyBase < 0) throw new StoresError("bad_quantity", "an approved quantity is a whole number, zero or more");
      if (g.qtyBase > line.qtyBase) throw new StoresError("more_than_asked", `line ${String(g.lineIdx)} asked for ${String(line.qtyBase)}`, { asked: line.qtyBase, approved: g.qtyBase });
      given.set(g.lineIdx, g.qtyBase);
    }
    const approved = lines.map((l) => ({ line: l, qty: given.get(l.lineIdx) ?? l.qtyBase }));
    if (approved.every((a) => a.qty === 0)) throw new StoresError("bad_quantity", "nothing approved — decline it with the reason instead");
    await stampIndentApproval(tx, indentId, {
      decision: "approved", by: actor.id, at: now, reason: null, forHod, lines: approved.map((a) => ({ lineIdx: a.line.lineIdx, qtyApproved: a.qty })),
    });
    await recordAct(tx, actor, now, {
      act: "approve_ticket", storeId: t.details.shelfId, refId: indentId, after: { forHod },
      lines: approved.map((a) => ({ itemId: a.line.itemId, asked: a.line.qtyBase, approved: a.qty })),
    });
    await notify(tx, t.indent.requestedBy, WORDS.approved, t.indent, "approved", now);
  });
  return (await getTicket(db, indentId, now))!;
}

/** Decision 3: decline, with the reason (on the ticket, never in the notice, which says only "Not approved"). */
export async function declineTicket(db: Db, actor: Actor, indentId: string, reason: string, now: Date = new Date()): Promise<TicketView> {
  const why = cleanText(reason);
  if (why === null) throw new StoresError("reason_required", "a decline says why");
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const { forHod } = await requireApprover(tx, actor, t);
    requireOpen(t);
    await stampIndentApproval(tx, indentId, { decision: "declined", by: actor.id, at: now, reason: why, forHod });
    await recordAct(tx, actor, now, { act: "decline_ticket", storeId: t.details.shelfId, refId: indentId, after: { forHod }, reason: why });
    await notify(tx, t.indent.requestedBy, WORDS.declined, t.indent, "declined", now);
  });
  return (await getTicket(db, indentId, now))!;
}

/** Decision 4: the HOD's look at an emergency the store issued before any approval: "agree" or "query". */
export async function reviewEmergency(
  db: Db, actor: Actor, indentId: string, input: { decision: "agree" | "query"; note?: string | null }, now: Date = new Date(),
): Promise<TicketView> {
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    await requireApprover(tx, actor, t);
    if (!t.indent.issueBeforeApproval || t.indent.status !== "issued") throw new StoresError("not_emergency", `${t.indent.indentNo} is not an emergency issued before approval`);
    if (t.indent.approvalDecision !== null || t.indent.reviewDecision !== null) throw new StoresError("already_reviewed", `${t.indent.indentNo} is already answered`);
    const note = cleanText(input.note);
    await stampIndentReview(tx, indentId, { decision: input.decision, by: actor.id, at: now, note });
    await recordAct(tx, actor, now, { act: "review_emergency", storeId: t.details.shelfId, refId: indentId, after: input.decision, reason: note });
  });
  return (await getTicket(db, indentId, now))!;
}

// ═══════════════════════════════ pick and issue ═══════════════════════════════

/** May this person keep (pick and issue from) the supplying store? Its keepers; the night store's hold `stores.nightstore.issue`. */
export async function keepsStore(db: Db | Tx, actor: Actor, store: StoresStore): Promise<boolean> {
  if (actor.type !== "user") return false;
  const perm = store.kind === "night" ? STORES_NIGHTSTORE_ISSUE : "materials.stock.issue";
  if (!(await holds(db, actor, perm))) return false;
  if (store.custodianRoles.length === 0) return true;
  for (const role of store.custodianRoles) if ((await usersHoldingRole(db as Tx, role)).includes(actor.id)) return true;
  return false;
}

/** Approved, an emergency issued first, or (S2b) a re-ask riding on its first ticket's approval (`approval_required = false`). */
function pickable(i: typeof storeIndents.$inferSelect): boolean {
  return i.status === "requested" && (i.approvalDecision === "approved" || (i.issueBeforeApproval && i.approvalDecision === null) || !i.approvalRequired);
}

async function liveClaim(db: Db | Tx, indentId: string, now: Date): Promise<typeof storesPickingClaims.$inferSelect | null> {
  const [c] = await db.select().from(storesPickingClaims).where(eq(storesPickingClaims.indentId, indentId))
    .orderBy(desc(storesPickingClaims.claimedAt), desc(storesPickingClaims.id)).limit(1);
  return c !== undefined && now.getTime() - c.claimedAt.getTime() < CLAIM_IDLE_MS ? c : null;
}

/** Decision 6: one picker. A second keeper is refused while the first's claim is live (30 idle minutes). */
export async function claimPicking(db: Db, actor: Actor, indentId: string, now: Date = new Date()): Promise<TicketView> {
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const source = await storesStoreRow(tx, t.indent.toResourceId);
    if (!(await keepsStore(tx, actor, source))) throw new StoresError("not_permitted", `only ${source.name}'s keepers pick its tickets`, { storeId: source.id });
    if (!pickable(t.indent)) {
      if (t.indent.status !== "requested") throw new StoresError("already_decided", `${t.indent.indentNo} is ${t.indent.status}`);
      throw new StoresError("not_approved", `${t.indent.indentNo} is not approved yet`);
    }
    const claim = await liveClaim(tx, indentId, now);
    if (claim !== null && claim.claimedBy !== actor.id) throw new StoresError("claimed_by_another", "taken by another keeper", { claimedBy: claim.claimedBy });
    await tx.insert(storesPickingClaims).values({ id: newId(), indentId, claimedBy: actor.id, claimedAt: now });
    await recordAct(tx, actor, now, { act: "claim_picking", storeId: source.id, refId: indentId });
  });
  return (await getTicket(db, indentId, now))!;
}

/**
 * Decision 6: the issue is materials' own `issueIndent` (FEFO into IN-TRANSIT; a line may go short or to 0),
 * refused while it waits for approval (`indent_not_approved`) and while another keeper's claim is live. The
 * night store's keepers issue through `issueIndentScoped` (decision 5). The requester is told "On the way".
 */
export async function issueTicket(
  db: Db, actor: Actor, indentId: string, input: { lines?: { lineIdx: number; qtyBase: number; unitIds?: string[] }[] } = {}, now: Date = new Date(),
): Promise<TicketView> {
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const claim = await liveClaim(tx, indentId, now);
    if (claim !== null && claim.claimedBy !== actor.id) throw new StoresError("claimed_by_another", "taken by another keeper", { claimedBy: claim.claimedBy });
    const source = await storesStoreRow(tx, t.indent.toResourceId);
    const night = source.kind === "night" && (await holds(tx, actor, STORES_NIGHTSTORE_ISSUE));
    // S4 (#1114, decision 5): a tagged line is picked by its units' scans (they choose the batches); a counted line of an
    // item that also has tagged batches is kept off them. Everything else goes to materials as before.
    const plan = await planUnitIssue(tx, t.indent.toResourceId, indentId, input, now);
    const view = night
      ? await issueIndentScoped(tx as unknown as Db, actor, indentId, plan.input, now)
      : await issueIndent(tx as unknown as Db, actor, indentId, plan.input, now);
    if (view.transfer !== null) await unitsIntoTransit(tx, actor, plan.unitIds, view.transfer.id, now);
    await recordAct(tx, actor, now, {
      act: "issue_ticket", storeId: source.id, refId: indentId, after: { transferId: view.transfer?.id ?? null, night },
      lines: view.lines.map((l) => ({ itemId: l.itemId, asked: l.qtyBase, issued: l.qtyIssued })),
    });
    await notify(tx, t.indent.requestedBy, WORDS.onTheWay, t.indent, "issued", now);
    // The issue voucher with the label QR: the porter scans the label (decision 7). Queued in the issue's own
    // transaction; the relay or the counter's browser prints it (decision 0045). Params are the indent id only.
    await enqueuePrintJob(tx, { document: ISSUE_VOUCHER_DOCUMENT, params: { indentId }, dedupeKey: `stores-voucher:${indentId}`, requestedBy: actor.id });
  });
  return (await getTicket(db, indentId, now))!;
}

/**
 * S4 (#1114, decision 5) — the issue of a ticket's tagged lines. For each line whose item is `tagged`, or has tagged
 * batches at the source, or names units: the units must be live units of the item at the source (`requireUnitsAt`),
 * their batches are the line's batches, and any counted remainder is taken FEFO from the item's untagged batches only.
 * A tagged item issued without its units, or a counted remainder that only tagged stock could cover, is refused
 * `units_required` before anything moves. Other lines pass through untouched (pharmacy never comes here).
 */
async function planUnitIssue(
  tx: Tx, sourceId: string, indentId: string, input: { lines?: { lineIdx: number; qtyBase: number; unitIds?: string[] }[] }, now: Date,
): Promise<{ input: IssueIndentInput; unitIds: string[] }> {
  const lines = await tx.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx));
  const tagged = await taggedBatchIds(tx, lines.map((l) => l.itemId));
  const given = new Map((input.lines ?? []).map((g) => [g.lineIdx, g]));
  const out: NonNullable<IssueIndentInput["lines"]> = [];
  const unitIds: string[] = [];
  for (const l of lines) {
    const g = given.get(l.lineIdx);
    const item = await requireStoresItem(tx, l.itemId);
    const sellable = (await sellableBatchesByItem(tx, sourceId, [l.itemId], now)).get(l.itemId) ?? [];
    const named = g?.unitIds ?? [];
    const unitLine = item.trackMode === "tagged" || named.length > 0 || sellable.some((b) => tagged.has(b.batchId));
    if (!unitLine) {
      if (g !== undefined) out.push({ lineIdx: g.lineIdx, qtyBase: g.qtyBase });
      continue;
    }
    const units = await requireUnitsAt(tx, named, l.itemId, sourceId);
    const counted = sellable.filter((b) => !tagged.has(b.batchId));
    const countedAvail = counted.reduce((a, b) => a + b.available, 0);
    const cap = l.qtyApproved ?? l.qtyBase;
    // A tagged item asked for with nothing scanned: the picker scans its units (the screen switches the line to scanning).
    if (item.trackMode === "tagged" && units.length === 0 && (g?.qtyBase ?? cap) > 0 && sellable.length > 0) {
      throw new StoresError("units_required", "scan each tagged unit you issue", { lineIdx: l.lineIdx, itemId: l.itemId, scanned: 0, issuing: g?.qtyBase ?? cap });
    }
    const want = g?.qtyBase ?? (item.trackMode === "tagged" ? units.length : Math.min(cap, units.length + countedAvail));
    if (units.length > want) throw new StoresError("bad_quantity", "more units scanned than the line issues", { lineIdx: l.lineIdx });
    let rest = want - units.length;
    if (rest > 0 && (item.trackMode === "tagged" || rest > countedAvail)) {
      throw new StoresError("units_required", "scan each tagged unit you issue", { lineIdx: l.lineIdx, itemId: l.itemId, scanned: units.length, issuing: want });
    }
    const batches = new Map<string, number>();
    for (const u of units) batches.set(u.unit.batchId, (batches.get(u.unit.batchId) ?? 0) + 1);
    for (const b of counted) {
      if (rest <= 0) break;
      const take = Math.min(rest, b.available);
      batches.set(b.batchId, (batches.get(b.batchId) ?? 0) + take);
      rest -= take;
    }
    out.push(want === 0 ? { lineIdx: l.lineIdx, qtyBase: 0 } : { lineIdx: l.lineIdx, qtyBase: want, batches: [...batches].map(([batchId, qty]) => ({ batchId, qty })) });
    unitIds.push(...units.map((u) => u.unit.id));
  }
  return { input: { lines: out.length === 0 && input.lines === undefined ? undefined : out }, unitIds };
}

// ═══════════════════════════════ reads ═══════════════════════════════

export async function getTicket(db: Db | Tx, indentId: string, now: Date = new Date()): Promise<TicketView | undefined> {
  const rows = await ticketRows(db, eq(storeIndents.id, indentId));
  return (await ticketViews(db, rows, now))[0];
}

async function ticketRows(db: Db | Tx, where: ReturnType<typeof and>): Promise<TicketRow[]> {
  return db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .where(where).orderBy(asc(storesTicketDetails.clockFrom), asc(storeIndents.requestedAt)).limit(LIST_LIMIT);
}

/** "Indents to approve": pending tickets of the departments the reader approves for; never their own. */
export async function ticketsToApprove(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<TicketView[]> {
  if (actor.type !== "user" || !(await holdsAnywhere(db, actor.id, STORES_INDENTS_APPROVE))) return [];
  const rows = (await ticketRows(db, and(eq(storeIndents.status, "requested"), eq(storeIndents.approvalRequired, true), isNull(storeIndents.approvalDecision))))
    .filter((r) => r.indent.requestedBy !== actor.id);
  return ticketViews(db, await filterByDepartment(db, actor, rows, STORES_INDENTS_APPROVE), now);
}

/** "To pick": approved (or emergency) tickets of the stores the reader keeps, sorted by floor, then clock. */
export async function ticketsToPick(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<TicketView[]> {
  if (actor.type !== "user") return [];
  const rows = (await ticketRows(db, eq(storeIndents.status, "requested"))).filter((r) => pickable(r.indent));
  const kept = new Map<string, boolean>();
  const out: TicketRow[] = [];
  for (const r of rows) {
    if (!kept.has(r.indent.toResourceId)) kept.set(r.indent.toResourceId, await keepsStore(db, actor, await storesStoreRow(db, r.indent.toResourceId)));
    if (kept.get(r.indent.toResourceId) === true) out.push(r);
  }
  // S2b (decision 6): a back-order (a re-ask) is on "To pick" once the store holds enough of every line.
  const ready: TicketRow[] = [];
  for (const r of out) {
    if (r.details.originKind !== "re_ask") { ready.push(r); continue; }
    const lines = await db.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, r.indent.id));
    const available = await availableQtyByItem(db as Tx, r.indent.toResourceId, lines.map((l) => l.itemId), now);
    if (lines.every((l) => (available.get(l.itemId) ?? 0) >= l.qtyBase)) ready.push(r);
  }
  const views = await ticketViews(db, ready, now);
  const floorOf = new Map((await db.select({ id: resources.id, parentId: resources.parentId }).from(resources)
    .where(inArray(resources.id, views.length === 0 ? [""] : views.map((v) => v.shelf.id)))).map((s) => [s.id, s.parentId ?? ""] as const));
  return views.sort((a, b) => (floorOf.get(a.shelf.id) ?? "").localeCompare(floorOf.get(b.shelf.id) ?? "") || a.clockFrom.localeCompare(b.clockFrom));
}

/** "To receive": issued tickets still in transit to a shelf of the reader's department (the shelf-work grant). */
export async function ticketsToReceive(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<TicketView[]> {
  if (actor.type !== "user" || !(await holdsAnywhere(db, actor.id, STORES_SHELF_WORK))) return [];
  const rows = await db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .innerJoin(transfers, eq(transfers.id, storeIndents.transferId))
    .where(and(eq(storeIndents.status, "issued"), eq(transfers.status, "in_transit")))
    .orderBy(asc(storesTicketDetails.clockFrom)).limit(LIST_LIMIT);
  const chains = await chainsOf(db, rows.map((r) => r.indent.id));
  const waiting = rows.filter((r) => {
    const c = chains.get(r.indent.id)!;
    return c.delivery.length === 0 && !returningUndelivered(c);
  });
  return ticketViews(db, await filterByDepartment(db, actor, waiting, STORES_SHELF_WORK), now);
}

/** Decision 4: emergencies issued before approval with no answer from the HOD 24 h after the issue. */
export async function overdueEmergencyReviews(db: Db | Tx, now: Date = new Date()): Promise<TicketView[]> {
  const rows = await ticketRows(db, and(
    eq(storeIndents.status, "issued"), eq(storeIndents.issueBeforeApproval, true), isNull(storeIndents.approvalDecision),
    isNull(storeIndents.reviewDecision), lt(storeIndents.decidedAt, new Date(now.getTime() - EMERGENCY_REVIEW_MS)),
  ));
  return ticketViews(db, rows, now);
}

async function filterByDepartment(db: Db | Tx, actor: Actor, rows: TicketRow[], permission: string): Promise<TicketRow[]> {
  const may = new Map<string, boolean>();
  const out: TicketRow[] = [];
  for (const r of rows) {
    const d = r.details.departmentId;
    if (!may.has(d)) may.set(d, await holds(db, actor, permission, d));
    if (may.get(d) === true) out.push(r);
  }
  return out;
}

function stageOf(i: typeof storeIndents.$inferSelect, transferStatus: string | null, returning = false): TicketStage {
  if (i.status === "cancelled") return "cancelled";
  if (i.status === "rejected") return i.approvalDecision === "declined" ? "declined" : "rejected";
  if (i.status === "issued") {
    if (transferStatus === "returned") return "returned";
    if (returning) return "returning";
    return transferStatus === "in_transit" ? "to_receive" : "delivered";
  }
  return pickable(i) && i.approvalDecision === "approved" ? "to_pick" : "to_approve";
}

export async function ticketViews(db: Db | Tx, rows: TicketRow[], now: Date): Promise<TicketView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.indent.id);
  const lines = await db.select({ line: storeIndentLines, itemCode: items.code, itemName: items.name, baseUom: items.baseUom })
    .from(storeIndentLines).innerJoin(items, eq(items.id, storeIndentLines.itemId))
    .where(inArray(storeIndentLines.indentId, ids)).orderBy(asc(storeIndentLines.lineIdx));
  const storeIds = [...new Set(rows.flatMap((r) => [r.indent.fromResourceId, r.indent.toResourceId]))];
  const stores = new Map((await db.select().from(resources).where(inArray(resources.id, storeIds))).map((s) => [s.id, s] as const));
  const depts = new Map((await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, [...new Set(rows.map((r) => r.details.departmentId))]))).map((d) => [d.id, d] as const));
  const claims = await db.select().from(storesPickingClaims).where(inArray(storesPickingClaims.indentId, ids))
    .orderBy(desc(storesPickingClaims.claimedAt), desc(storesPickingClaims.id));
  const transferIds = rows.map((r) => r.indent.transferId).filter((x): x is string => x !== null);
  const transferRows = new Map(transferIds.length === 0 ? [] : (await db.select({ id: transfers.id, status: transfers.status, issuedBy: transfers.issuedBy })
    .from(transfers).where(inArray(transfers.id, transferIds))).map((t) => [t.id, t] as const));
  // S4b (#1114, edge case 1): the tagged units still on their way on each open transfer, so the receiver scans what arrived.
  const onWay = await unitsOnTransfers(db, [...transferRows.values()].filter((t) => t.status === "in_transit").map((t) => t.id));
  const chains = await chainsOf(db, ids);
  const chainPeople = [...chains.values()].flatMap((c) => [...c.handoffs.flatMap((h) => [h.fromUserId, h.toUserId]), ...c.delivery.map((d) => d.receivedBy),
    ...c.resolutions.flatMap((r) => [r.requestedBy, r.postedBy])]);
  const people = [...new Set(rows.flatMap((r) => [r.indent.requestedBy, r.indent.approvalBy, r.indent.reviewedBy]).concat(claims.map((c) => c.claimedBy))
    .concat([...transferRows.values()].map((t) => t.issuedBy)).concat(chainPeople)
    .filter((x): x is string => x !== null))];
  const nameOf = new Map((await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, people)))
    .map((u) => [u.id, u.fullName] as const));
  const transferStatus = new Map([...transferRows.values()].map((t) => [t.id, t.status] as const));
  const originIds = rows.map((r) => r.details.originIndentId).filter((x): x is string => x !== null);
  const originNo = new Map(originIds.length === 0 ? [] : (await db.select({ id: storeIndents.id, no: storeIndents.indentNo })
    .from(storeIndents).where(inArray(storeIndents.id, originIds))).map((o) => [o.id, o.no] as const));

  const person = (id: string) => ({ id, name: nameOf.get(id) ?? id });
  const place = (id: string) => {
    const s = stores.get(id);
    return { id, code: s?.code ?? "", name: s?.name ?? id, kind: (s === undefined ? "sub" : toStoresStore(s).kind) };
  };
  return rows.map(({ indent: i, details: d }) => {
    const claim = claims.find((c) => c.indentId === i.id);
    const live = claim !== undefined && i.status === "requested" && now.getTime() - claim.claimedAt.getTime() < CLAIM_IDLE_MS ? claim : null;
    const dept = depts.get(d.departmentId);
    const tStatus = i.transferId === null ? null : (transferStatus.get(i.transferId) ?? "");
    const shelf = place(d.shelfId);
    const chain = chains.get(i.id)!;
    const issuedBy = i.transferId === null ? null : (transferRows.get(i.transferId)?.issuedBy ?? null);
    const closed = chain.delivery.length > 0 || tStatus === "returned";
    const lastCustodian = issuedBy === null ? null : person(lastCustodianOf(issuedBy, chain));
    const delivered = chain.delivery[0];
    const sentBackRows = chain.resolutions.filter((r) => r.kind === "sent_back");
    const shortLines = [...new Set(chain.delivery.filter((x) => x.short > 0).map((x) => x.lineIdx))];
    return {
      id: i.id, indentNo: i.indentNo, status: i.status, stage: stageOf(i, tStatus, returningUndelivered(chain)),
      priority: d.priority as TicketPriority, channel: d.channel as TicketChannel,
      neededBy: d.neededBy?.toISOString() ?? null, deliverTo: d.deliverTo, emergencyReason: d.emergencyReason, night: d.night,
      department: { id: d.departmentId, code: dept?.code ?? "", name: dept?.name ?? d.departmentId },
      shelf: { id: shelf.id, code: shelf.code, name: shelf.name },
      source: place(i.toResourceId),
      requestedBy: person(i.requestedBy), requestedAt: i.requestedAt.toISOString(), clockFrom: d.clockFrom.toISOString(),
      origin: d.originIndentId === null ? null : { indentId: d.originIndentId, indentNo: originNo.get(d.originIndentId) ?? "", kind: d.originKind as "re_raise" | "re_ask" },
      approval: {
        state: !i.approvalRequired ? "not_needed" : i.approvalDecision === null ? "pending" : (i.approvalDecision as "approved" | "declined"),
        by: i.approvalBy === null ? null : person(i.approvalBy), at: i.approvalAt?.toISOString() ?? null,
        forHod: i.approvalForHod === true, reason: i.approvalReason,
      },
      review: i.reviewDecision === null || i.reviewedBy === null || i.reviewedAt === null ? null
        : { decision: i.reviewDecision as "agree" | "query", by: person(i.reviewedBy), at: i.reviewedAt.toISOString(), note: i.reviewNote },
      claim: live === null ? null : { by: person(live.claimedBy), at: live.claimedAt.toISOString(), lapsesAt: new Date(live.claimedAt.getTime() + CLAIM_IDLE_MS).toISOString() },
      transfer: i.transferId === null ? null : { id: i.transferId, status: tStatus ?? "" },
      lines: lines.filter((l) => l.line.indentId === i.id).map((l) => ({
        lineIdx: l.line.lineIdx, itemId: l.line.itemId, itemCode: l.itemCode, itemName: l.itemName, baseUom: l.baseUom,
        qtyBase: l.line.qtyBase, qtyApproved: l.line.qtyApproved, qtyIssued: l.line.qtyIssued,
        ...(() => {
          const u = i.transferId === null ? [] : (onWay.get(i.transferId) ?? []).filter((x) => x.itemId === l.line.itemId);
          return u.length === 0 ? {} : { units: u.map((x) => ({ id: x.id, tagNo: x.tagNo })) };
        })(),
      })),
      custody: issuedBy === null || lastCustodian === null ? null : {
        holder: closed ? null : person(holderOf(issuedBy, chain)), legs: legsOf(chain), lastCustodian,
      },
      delivery: delivered === undefined ? null : {
        by: person(delivered.receivedBy), at: delivered.receivedAt.toISOString(), atCounter: delivered.atCounter,
        lines: [...new Set(chain.delivery.map((x) => x.lineIdx))].map((lineIdx) => {
          const of = chain.delivery.filter((x) => x.lineIdx === lineIdx);
          return {
            lineIdx, itemId: of[0]!.itemId, accepted: of.reduce((a, x) => a + x.accepted, 0), short: of.reduce((a, x) => a + x.short, 0),
            wrong: of.reduce((a, x) => a + x.wrong, 0), damaged: of.reduce((a, x) => a + x.damaged, 0),
          };
        }),
        sentBack: chain.delivery.reduce((a, x) => a + x.wrong + x.damaged, 0),
        sentBackAccepted: sentBackRows.length > 0 && sentBackRows.every((r) => r.status === "posted"),
      },
      shorts: lastCustodian === null ? [] : shortLines.map((lineIdx) => {
        const of = chain.delivery.filter((x) => x.lineIdx === lineIdx && x.short > 0);
        const tl = new Set(of.map((x) => x.transferLineId));
        const res = chain.resolutions.find((r) => tl.has(r.transferLineId) && (r.kind === "found" || r.kind === "returned" || r.kind === "lost") && r.status !== "refused");
        return {
          lineIdx, itemId: of[0]!.itemId, qty: of.reduce((a, x) => a + x.short, 0), with: lastCustodian,
          resolution: res === undefined ? null : {
            kind: res.kind as "found" | "returned" | "lost", by: person(res.postedBy ?? res.requestedBy), at: (res.postedAt ?? res.requestedAt).toISOString(),
            approvalId: res.approvalId, posted: res.status === "posted",
          },
        };
      }),
    };
  });
}
