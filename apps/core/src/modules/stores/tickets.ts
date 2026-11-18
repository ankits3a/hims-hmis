import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  items, orgDepartments, resources, roleAssignments, rolePermissions, storeIndentLines, storeIndents, storesPickingClaims, storesTicketDetails,
  transfers, users,
} from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { issueIndent, issueIndentScoped, raiseIndentScoped, stampIndentApproval, stampIndentReview } from "../materials";
import {
  STORES_INDENTS_APPROVE, STORES_NIGHTSTORE_ISSUE, STORES_SHELF_WORK, holds, isStoresStore, recordAct, requireShelf, requireShelfAct,
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
const WORDS = {
  toApprove: ["Indent to approve", "मंज़ूरी के लिए इंडेंट"],
  approved: ["Approved", "मंज़ूर"],
  declined: ["Not approved", "मंज़ूर नहीं"],
  onTheWay: ["On the way", "रास्ते में"],
} as const;

async function notify(tx: Tx, userId: string, words: readonly [string, string], indent: { id: string; indentNo: string }, key: string, now: Date): Promise<void> {
  await raiseNotice(tx as unknown as Db, {
    userId, kind: NOTICE_KIND, title: words[0], body: `${words[1]} · ${indent.indentNo}`,
    refType: "store_indent", refId: indent.id, sourceKey: `stores-ticket:${indent.id}:${key}`, at: now,
  });
}

/** Holders of `permission` for a department: assigned AT it (`department`), or hospital-wide when `hospital`. */
async function holdersOf(exec: Db | Tx, permission: string, scope: { departmentId: string } | "hospital"): Promise<string[]> {
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
async function approversToTell(exec: Db | Tx, departmentId: string, requesterId: string): Promise<string[]> {
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

async function storesStoreRow(db: Db | Tx, storeId: string): Promise<SourceStore> {
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

async function raise(db: Db, actor: Actor, input: RaiseTicketInput, now: Date, origin: Origin | null): Promise<string> {
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
    const made = await raiseIndentScoped(tx, actor, { fromResourceId: shelf.id, toResourceId: source.id, lines, note: input.note ?? null }, now, {
      issueBeforeApproval: input.priority === "emergency",
    });
    await tx.insert(storesTicketDetails).values({
      indentId: made.indentId, departmentId: shelf.departmentId, shelfId: shelf.id, priority: input.priority,
      channel: input.channel ?? "web", neededBy: input.neededBy == null ? null : new Date(input.neededBy),
      deliverTo: cleanText(input.deliverTo), emergencyReason: input.priority === "emergency" ? reason : null, night,
      originIndentId: origin?.indentId ?? null, originKind: origin?.kind ?? null, clockFrom: origin?.clockFrom ?? now,
    });
    await recordAct(tx, actor, now, {
      act: origin?.kind === "re_raise" ? "reraise_ticket" : "raise_ticket", storeId: shelf.id, refId: made.indentId,
      after: { indentNo: made.indentNo, priority: input.priority, sourceId: source.id, night, origin: origin?.indentId ?? null },
      reason: input.priority === "emergency" ? reason : null, lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })),
    });
    const ref = { id: made.indentId, indentNo: made.indentNo };
    for (const u of await approversToTell(tx, shelf.departmentId, actor.id)) await notify(tx, u, WORDS.toApprove, ref, "to-approve", now);
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

// ═══════════════════════════════ approve, decline, review ═══════════════════════════════

type TicketRow = { indent: typeof storeIndents.$inferSelect; details: typeof storesTicketDetails.$inferSelect };

async function requireTicketRow(db: Db | Tx, indentId: string, lock = false): Promise<TicketRow> {
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
async function keepsStore(db: Db | Tx, actor: Actor, store: StoresStore): Promise<boolean> {
  if (actor.type !== "user") return false;
  const perm = store.kind === "night" ? STORES_NIGHTSTORE_ISSUE : "materials.stock.issue";
  if (!(await holds(db, actor, perm))) return false;
  if (store.custodianRoles.length === 0) return true;
  for (const role of store.custodianRoles) if ((await usersHoldingRole(db as Tx, role)).includes(actor.id)) return true;
  return false;
}

function pickable(i: typeof storeIndents.$inferSelect): boolean {
  return i.status === "requested" && (i.approvalDecision === "approved" || (i.issueBeforeApproval && i.approvalDecision === null));
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
export async function issueTicket(db: Db, actor: Actor, indentId: string, input: IssueIndentInput = {}, now: Date = new Date()): Promise<TicketView> {
  await withTx(db, async (tx) => {
    const t = await requireTicketRow(tx, indentId, true);
    const claim = await liveClaim(tx, indentId, now);
    if (claim !== null && claim.claimedBy !== actor.id) throw new StoresError("claimed_by_another", "taken by another keeper", { claimedBy: claim.claimedBy });
    const source = await storesStoreRow(tx, t.indent.toResourceId);
    const night = source.kind === "night" && (await holds(tx, actor, STORES_NIGHTSTORE_ISSUE));
    const view = night
      ? await issueIndentScoped(tx as unknown as Db, actor, indentId, input, now)
      : await issueIndent(tx as unknown as Db, actor, indentId, input, now);
    await recordAct(tx, actor, now, {
      act: "issue_ticket", storeId: source.id, refId: indentId, after: { transferId: view.transfer?.id ?? null, night },
      lines: view.lines.map((l) => ({ itemId: l.itemId, asked: l.qtyBase, issued: l.qtyIssued })),
    });
    await notify(tx, t.indent.requestedBy, WORDS.onTheWay, t.indent, "issued", now);
  });
  return (await getTicket(db, indentId, now))!;
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
  const views = await ticketViews(db, out, now);
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
  return ticketViews(db, await filterByDepartment(db, actor, rows, STORES_SHELF_WORK), now);
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

function stageOf(i: typeof storeIndents.$inferSelect, transferStatus: string | null): TicketStage {
  if (i.status === "cancelled") return "cancelled";
  if (i.status === "rejected") return i.approvalDecision === "declined" ? "declined" : "rejected";
  if (i.status === "issued") return transferStatus === "in_transit" ? "to_receive" : "delivered";
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
  const people = [...new Set(rows.flatMap((r) => [r.indent.requestedBy, r.indent.approvalBy, r.indent.reviewedBy]).concat(claims.map((c) => c.claimedBy))
    .filter((x): x is string => x !== null))];
  const nameOf = new Map((await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, people)))
    .map((u) => [u.id, u.fullName] as const));
  const transferIds = rows.map((r) => r.indent.transferId).filter((x): x is string => x !== null);
  const transferStatus = new Map(transferIds.length === 0 ? [] : (await db.select({ id: transfers.id, status: transfers.status })
    .from(transfers).where(inArray(transfers.id, transferIds))).map((t) => [t.id, t.status] as const));
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
    return {
      id: i.id, indentNo: i.indentNo, status: i.status, stage: stageOf(i, tStatus),
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
      })),
      custody: null, delivery: null, shorts: [],
    };
  });
}
