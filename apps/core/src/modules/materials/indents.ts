import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import { items, resources, storeIndentLines, storeIndents, transfers, users } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { MaterialsError } from "./errors";
import { materialIndentCancelled, materialIndentIssued, materialIndentRaised, materialIndentRejected } from "./events";
import { istDay } from "./grn";
import { assertNotMerged } from "./items";
import { availableQtyByItem } from "./ledger";
import { requireStore, storeCustodianRoles } from "./stores";
import { issueStock } from "./transfers";
import type { Actor } from "@hmis/contracts";
import type { StoreRow } from "./stores";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PHARMACY GAP A6b — INDENTS: a sub-store asks, the supplying store answers with a transfer.
 *
 * The standard Indian-corporate-hospital indent (DECIDED, plan doc §A6b): a ward, the OT or a pharmacy
 * counter raises an indent on the central store for items and quantities in base units. An indent MOVES
 * NOTHING. The supplying store's keeper either
 *   - **issues** it: one ordinary transfer (`issueStock`, FEFO, into `IN-TRANSIT`) whose id the indent
 *     records, with the quantity actually sent per line — the asked quantity by default, capped at what
 *     the shelf has, and a line may go short or at 0 — or
 *   - **rejects** it, with a reason.
 * The requester may **cancel** it while it is still asked. The receipt is the transfer's own
 * (`receiveStock`, unchanged): the indent is the paper that asked, the transfer the paper that moved.
 *
 * Who may: raising and cancelling are the requesting side's (`materials.stock.receive`), issuing and
 * rejecting the supplying side's (`materials.stock.issue`). A store that names its keepers
 * (`attributes.custodianRoles`) is spoken for only by them — the rule `receiveStock` and the tray
 * restock already apply. No new permission.
 */

const STOCK_ISSUE = "materials.stock.issue";
const STOCK_RECEIVE = "materials.stock.receive";
const RECENT_INDENTS = 100;

export type IndentStatus = "requested" | "issued" | "rejected" | "cancelled";
export type IndentLineInput = { itemId: string; qtyBase: number };
export type RaiseIndentInput = { fromResourceId: string; toResourceId: string; lines: IndentLineInput[]; note?: string | null };
export type IssueIndentInput = { lines?: { lineIdx: number; qtyBase: number }[] };

export type IndentView = {
  id: string;
  indentNo: string;
  status: IndentStatus;
  note: string | null;
  /** The requesting store. */
  from: { id: string; code: string; name: string };
  /** The supplying store. */
  to: { id: string; code: string; name: string };
  requestedBy: { id: string; name: string };
  requestedAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  transfer: { id: string; ref: string; status: string } | null;
  lines: {
    lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string;
    qtyBase: number; qtyIssued: number | null;
    /** What the supplying store could send now — only while the indent is requested. */
    available: number | null;
  }[];
};

// ═══════════════════════════════════ who may ═══════════════════════════════════

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<string> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
  return actor.id;
}

/** A store that names its keepers is spoken for only by one of them; a store that names none, by anyone permitted. */
async function requireKeeper(tx: Tx, userId: string, store: StoreRow, side: string): Promise<void> {
  const keepers = storeCustodianRoles(store);
  if (keepers.length === 0) return;
  for (const role of keepers) {
    if ((await usersHoldingRole(tx, role)).includes(userId)) return;
  }
  throw new MaterialsError("not_store_keeper", `only ${store.name}'s own staff (${keepers.join(", ")}) ${side}`, { keepers });
}

function bad(message: string, detail?: unknown): never {
  throw new MaterialsError("invalid_indent", message, detail);
}
const cleanText = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

async function lockRequested(tx: Tx, indentId: string): Promise<typeof storeIndents.$inferSelect> {
  const [row] = await tx.select().from(storeIndents).where(eq(storeIndents.id, indentId)).for("update");
  if (row === undefined) throw new MaterialsError("unknown_indent", `indent ${indentId} not found`);
  if (row.status !== "requested") {
    throw new MaterialsError("indent_closed", `indent ${row.indentNo} is ${row.status} — only a requested indent is acted on`, { status: row.status });
  }
  return row;
}

const headerOf = (r: typeof storeIndents.$inferSelect): { indentId: string; indentNo: string; fromResourceId: string; toResourceId: string } =>
  ({ indentId: r.id, indentNo: r.indentNo, fromResourceId: r.fromResourceId, toResourceId: r.toResourceId });

// ═══════════════════════════════════ the acts ═══════════════════════════════════

/** The requesting store asks the supplying one. `from` asks, `to` supplies. */
export async function raiseIndent(db: Db, actor: Actor, input: RaiseIndentInput, now: Date = new Date()): Promise<IndentView> {
  const userId = await requirePerm(db, actor, STOCK_RECEIVE, "raising an indent");
  const { indentId } = await withTx(db, (tx) => insertIndent(tx, actor, userId, input, now, null));
  return (await getIndent(db, indentId))!;
}

/**
 * STORES S2a (#1112, decision 1) — what a Stores ticket fixes at raise: the HOD answers it, and an
 * emergency may be issued before the answer (`issueBeforeApproval`).
 */
export type IndentApprovalInput = { issueBeforeApproval: boolean };

/**
 * STORES S2a (#1112) — THE CALLER-AUTHORISED TWIN OF `raiseIndent`: no `requirePerm`, because the Stores
 * intent (`stores/tickets.ts` `raiseTicket`) has already asked the department-scoped shelf grant, and
 * department roles hold no `materials.*` string. Everything else is `raiseIndent`'s (the requesting store's
 * keepers, the items, the number, the event), run in the CALLER's transaction so the ticket's own row lands
 * with it. `raiseIndent` itself is unchanged.
 */
export async function raiseIndentScoped(
  tx: Tx, actor: Actor, input: RaiseIndentInput, now: Date, approval: IndentApprovalInput | null = null,
): Promise<{ indentId: string; indentNo: string }> {
  if (actor.type !== "user") throw new MaterialsError("permission_denied", "raising an indent needs a person");
  return insertIndent(tx, actor, actor.id, input, now, approval);
}

async function insertIndent(
  tx: Tx, actor: Actor, userId: string, input: RaiseIndentInput, now: Date, approval: IndentApprovalInput | null,
): Promise<{ indentId: string; indentNo: string }> {
  if (input.lines.length === 0) bad("an indent asks for at least one item");
  if (input.fromResourceId === input.toResourceId) bad("a store cannot indent on itself");
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) bad("each quantity is a whole number above zero, in base units", { itemId: l.itemId });
    if (seen.has(l.itemId)) bad("an item appears once on an indent — add the quantities together", { itemId: l.itemId });
    seen.add(l.itemId);
  }
  const from = await requireStore(tx, input.fromResourceId);
  await requireStore(tx, input.toResourceId);
  await requireKeeper(tx, userId, from, "raise its indents");
  const known = await tx.select({ id: items.id }).from(items).where(inArray(items.id, [...seen]));
  const missing = [...seen].filter((i) => !known.some((k) => k.id === i));
  if (missing.length > 0) throw new MaterialsError("unknown_item", `no such item: ${missing.join(", ")}`, { itemIds: missing });
  await assertNotMerged(tx, [...seen], "indenting");

  const indentId = newId();
  const indentNo = await nextEpisodeNo(tx, "store_indent", istDay(now));
  await tx.insert(storeIndents).values({
    id: indentId, indentNo, fromResourceId: input.fromResourceId, toResourceId: input.toResourceId, status: "requested",
    note: cleanText(input.note), requestedBy: userId, requestedAt: now,
    ...(approval === null ? {} : { approvalRequired: true, issueBeforeApproval: approval.issueBeforeApproval }),
  });
  await tx.insert(storeIndentLines).values(input.lines.map((l, lineIdx) => ({
    id: newId(), indentId, lineIdx, itemId: l.itemId, qtyBase: l.qtyBase, qtyIssued: null,
  })));
  await appendEvent(tx, materialIndentRaised.make({
    actor, occurredAt: now, correlationId: indentId,
    payload: { indentId, indentNo, fromResourceId: input.fromResourceId, toResourceId: input.toResourceId, lines: input.lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })) },
  }));
  return { indentId, indentNo };
}

/**
 * The supplying store issues the indent as ONE transfer to the requesting store. Each line goes at the
 * quantity given, or by default at the asked quantity capped at what the shelf has now; a line may go
 * short or at 0, the indent as a whole carries at least one unit. More than the shelf has is the
 * transfer's own refusal (`insufficient_stock`), more than was asked is this one's.
 */
export async function issueIndent(
  db: Db, actor: Actor, indentId: string, input: IssueIndentInput = {}, now: Date = new Date(),
): Promise<IndentView> {
  const userId = await requirePerm(db, actor, STOCK_ISSUE, "issuing an indent");
  await withTx(db, (tx) => issueIndentIn(tx, actor, userId, indentId, input, now));
  return (await getIndent(db, indentId))!;
}

/**
 * STORES S2a (#1112, decision 5) — THE CALLER-AUTHORISED TWIN OF `issueIndent`: no `requirePerm`, because the
 * night store's keepers (the duty nursing supervisor, the duty manager) hold `stores.nightstore.issue`, which
 * the Stores intent has already asked, and not `materials.stock.issue`. The supplying store's keeper check, the
 * approval check, FEFO and the transfer are `issueIndent`'s own. `issueIndent` itself is unchanged.
 */
export async function issueIndentScoped(
  db: Db, actor: Actor, indentId: string, input: IssueIndentInput = {}, now: Date = new Date(),
): Promise<IndentView> {
  if (actor.type !== "user") throw new MaterialsError("permission_denied", "issuing an indent needs a person");
  await withTx(db, (tx) => issueIndentIn(tx, actor, actor.id, indentId, input, now));
  return (await getIndent(db, indentId))!;
}

/**
 * STORES S2a (#1112) — an indent that waits for its approval is not issued. Only a Stores ticket carries
 * `approval_required`; an emergency (`issue_before_approval`) may go first and is reviewed afterwards. A
 * pharmacy indent has neither, so this never refuses one.
 */
function assertApproved(indent: typeof storeIndents.$inferSelect): void {
  if (indent.approvalRequired && indent.approvalDecision === null && !indent.issueBeforeApproval) {
    throw new MaterialsError("indent_not_approved", `indent ${indent.indentNo} waits for its approval`, { indentNo: indent.indentNo });
  }
}

async function issueIndentIn(tx: Tx, actor: Actor, userId: string, indentId: string, input: IssueIndentInput, now: Date): Promise<void> {
  const indent = await lockRequested(tx, indentId);
  await requireKeeper(tx, userId, await requireStore(tx, indent.toResourceId), "issue from it");
  assertApproved(indent);
  const lines = await tx.select().from(storeIndentLines).where(eq(storeIndentLines.indentId, indent.id)).orderBy(asc(storeIndentLines.lineIdx));

  const given = new Map<number, number>();
  for (const g of input.lines ?? []) {
    const line = lines.find((l) => l.lineIdx === g.lineIdx);
    if (line === undefined) bad(`indent ${indent.indentNo} has no line ${String(g.lineIdx)}`, { lineIdx: g.lineIdx });
    if (given.has(g.lineIdx)) bad(`line ${String(g.lineIdx)} is given twice`, { lineIdx: g.lineIdx });
    if (!Number.isSafeInteger(g.qtyBase) || g.qtyBase < 0) bad("a quantity issued is a whole number, zero or more", { lineIdx: g.lineIdx });
    // STORES S2a — up to what was approved, when the HOD approved less (null: what was asked).
    if (g.qtyBase > (line.qtyApproved ?? line.qtyBase)) {
      bad(`line ${String(g.lineIdx)} asked for ${String(line.qtyApproved ?? line.qtyBase)} — an indent is issued up to what it asked`, { lineIdx: g.lineIdx, asked: line.qtyApproved ?? line.qtyBase, qtyIssued: g.qtyBase });
    }
    given.set(g.lineIdx, g.qtyBase);
  }
  const available = await availableQtyByItem(tx, indent.toResourceId, lines.map((l) => l.itemId), now);
  const plan = lines.map((l) => ({ line: l, qty: given.get(l.lineIdx) ?? Math.min(l.qtyApproved ?? l.qtyBase, available.get(l.itemId) ?? 0) }));
  if (plan.every((p) => p.qty === 0)) {
    bad(`nothing to issue on ${indent.indentNo} — the supplying store has none of it available; reject it with the reason instead`);
  }

  const { transferId } = await issueStock(tx, actor, {
    fromResourceId: indent.toResourceId, toResourceId: indent.fromResourceId,
    lines: plan.filter((p) => p.qty > 0).map((p) => ({ itemId: p.line.itemId, qtyBase: p.qty })),
    note: `indent ${indent.indentNo}`, occurredAt: now,
  });
  for (const p of plan) {
    await tx.update(storeIndentLines).set({ qtyIssued: p.qty }).where(eq(storeIndentLines.id, p.line.id));
  }
  await tx.update(storeIndents).set({ status: "issued", decidedBy: userId, decidedAt: now, transferId }).where(eq(storeIndents.id, indent.id));
  await appendEvent(tx, materialIndentIssued.make({
    actor, occurredAt: now, correlationId: indent.id,
    payload: { ...headerOf(indent), transferId, lines: plan.map((p) => ({ itemId: p.line.itemId, qtyBase: p.line.qtyBase, qtyIssued: p.qty })) },
  }));
}

/** The supplying store refuses the indent, with the reason. Nothing moves. */
export async function rejectIndent(db: Db, actor: Actor, indentId: string, reason: string, now: Date = new Date()): Promise<IndentView> {
  const userId = await requirePerm(db, actor, STOCK_ISSUE, "rejecting an indent");
  const why = cleanText(reason);
  if (why === null) throw new MaterialsError("reason_required", "a rejection says why");
  await withTx(db, async (tx) => {
    const indent = await lockRequested(tx, indentId);
    await requireKeeper(tx, userId, await requireStore(tx, indent.toResourceId), "answer its indents");
    await tx.update(storeIndents).set({ status: "rejected", decidedBy: userId, decidedAt: now, rejectReason: why }).where(eq(storeIndents.id, indent.id));
    await appendEvent(tx, materialIndentRejected.make({ actor, occurredAt: now, correlationId: indent.id, payload: { ...headerOf(indent), reason: why } }));
  });
  return (await getIndent(db, indentId))!;
}

/** The requesting store withdraws the indent before it is answered. */
export async function cancelIndent(db: Db, actor: Actor, indentId: string, reason: string, now: Date = new Date()): Promise<IndentView> {
  const userId = await requirePerm(db, actor, STOCK_RECEIVE, "cancelling an indent");
  const why = cleanText(reason);
  if (why === null) throw new MaterialsError("reason_required", "a cancellation says why");
  await withTx(db, async (tx) => {
    const indent = await lockRequested(tx, indentId);
    await requireKeeper(tx, userId, await requireStore(tx, indent.fromResourceId), "cancel its indents");
    await tx.update(storeIndents).set({ status: "cancelled", decidedBy: userId, decidedAt: now, cancelReason: why }).where(eq(storeIndents.id, indent.id));
    await appendEvent(tx, materialIndentCancelled.make({ actor, occurredAt: now, correlationId: indent.id, payload: { ...headerOf(indent), reason: why } }));
  });
  return (await getIndent(db, indentId))!;
}

// ═══════════════════════════ STORES S2a (#1112) — the write-once stamps ═══════════════════════════

/**
 * The HOD's answer, stamped on the indent: `approved` (with any line approved at less than asked) or
 * `declined` (with its reason; the indent closes as `rejected` by the approver in the same update).
 * CALLER-AUTHORISED and caller-checked: the Stores intent holds the row lock, has asked
 * `stores.indents.approve` at the department and refused the requester and a second answer. The
 * migration's trigger refuses changing or clearing a stamp, whoever calls.
 */
export async function stampIndentApproval(
  tx: Tx, indentId: string,
  stamp: { decision: "approved" | "declined"; by: string; at: Date; reason: string | null; forHod: boolean; lines?: { lineIdx: number; qtyApproved: number }[] },
): Promise<void> {
  const decision = { approvalDecision: stamp.decision, approvalBy: stamp.by, approvalAt: stamp.at, approvalReason: stamp.reason, approvalForHod: stamp.forHod };
  await tx.update(storeIndents).set(stamp.decision === "approved" ? decision : {
    ...decision, status: "rejected", decidedBy: stamp.by, decidedAt: stamp.at, rejectReason: stamp.reason,
  }).where(eq(storeIndents.id, indentId));
  for (const l of stamp.lines ?? []) {
    await tx.update(storeIndentLines).set({ qtyApproved: l.qtyApproved })
      .where(and(eq(storeIndentLines.indentId, indentId), eq(storeIndentLines.lineIdx, l.lineIdx)));
  }
}

/** Decision 4: the HOD's look at an emergency issued first ("agree" | "query"). Caller-authorised, write-once. */
export async function stampIndentReview(
  tx: Tx, indentId: string, stamp: { decision: "agree" | "query"; by: string; at: Date; note: string | null },
): Promise<void> {
  await tx.update(storeIndents).set({ reviewDecision: stamp.decision, reviewedBy: stamp.by, reviewedAt: stamp.at, reviewNote: stamp.note })
    .where(eq(storeIndents.id, indentId));
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

export async function getIndent(db: Db | Tx, indentId: string, now: Date = new Date()): Promise<IndentView | undefined> {
  const rows = await db.select().from(storeIndents).where(eq(storeIndents.id, indentId));
  return (await indentViews(db, rows, now))[0];
}

/** Indents asked by or of `storeId` (either side), newest first; `status` narrows them. */
export async function listIndents(
  db: Db | Tx, filter: { storeId?: string; status?: IndentStatus } = {}, now: Date = new Date(),
): Promise<IndentView[]> {
  const rows = await db.select().from(storeIndents)
    .where(and(
      filter.storeId === undefined ? undefined : or(eq(storeIndents.fromResourceId, filter.storeId), eq(storeIndents.toResourceId, filter.storeId)),
      filter.status === undefined ? undefined : eq(storeIndents.status, filter.status),
    ))
    .orderBy(desc(storeIndents.requestedAt), desc(storeIndents.id)).limit(RECENT_INDENTS);
  return indentViews(db, rows, now);
}

async function indentViews(db: Db | Tx, rows: (typeof storeIndents.$inferSelect)[], now: Date): Promise<IndentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await db.select({ line: storeIndentLines, itemCode: items.code, itemName: items.name, baseUom: items.baseUom })
    .from(storeIndentLines).innerJoin(items, eq(items.id, storeIndentLines.itemId))
    .where(inArray(storeIndentLines.indentId, ids)).orderBy(asc(storeIndentLines.lineIdx));
  const storeIds = [...new Set(rows.flatMap((r) => [r.fromResourceId, r.toResourceId]))];
  const stores = new Map((await db.select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources).where(inArray(resources.id, storeIds))).map((s) => [s.id, s] as const));
  const people = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => x !== null))];
  const nameOf = new Map((await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, people)))
    .map((u) => [u.id, u.fullName] as const));
  const transferIds = rows.map((r) => r.transferId).filter((x): x is string => x !== null);
  const transferStatus = new Map(transferIds.length === 0 ? [] : (await db.select({ id: transfers.id, status: transfers.status })
    .from(transfers).where(inArray(transfers.id, transferIds))).map((t) => [t.id, t.status] as const));

  // What each supplying store could send now, for the indents still asked of it.
  const availableAt = new Map<string, Map<string, number>>();
  for (const r of rows.filter((x) => x.status === "requested")) {
    const itemIds = lines.filter((l) => l.line.indentId === r.id).map((l) => l.line.itemId);
    const got = availableAt.get(r.toResourceId) ?? new Map<string, number>();
    const wanted = itemIds.filter((i) => !got.has(i));
    for (const [k, v] of await availableQtyByItem(db, r.toResourceId, wanted, now)) got.set(k, v);
    for (const i of wanted) if (!got.has(i)) got.set(i, 0);
    availableAt.set(r.toResourceId, got);
  }

  const storeOf = (id: string): IndentView["from"] => {
    const s = stores.get(id);
    return { id, code: s?.code ?? "", name: s?.name ?? id };
  };
  const person = (id: string): { id: string; name: string } => ({ id, name: nameOf.get(id) ?? id });
  return rows.map((r) => ({
    id: r.id, indentNo: r.indentNo, status: r.status as IndentStatus, note: r.note,
    from: storeOf(r.fromResourceId), to: storeOf(r.toResourceId),
    requestedBy: person(r.requestedBy), requestedAt: r.requestedAt.toISOString(),
    decidedBy: r.decidedBy === null ? null : person(r.decidedBy),
    decidedAt: r.decidedAt === null ? null : r.decidedAt.toISOString(),
    rejectReason: r.rejectReason, cancelReason: r.cancelReason,
    transfer: r.transferId === null ? null : { id: r.transferId, ref: `TR-${r.transferId.slice(-6)}`, status: transferStatus.get(r.transferId) ?? "" },
    lines: lines.filter((l) => l.line.indentId === r.id).map((l) => ({
      lineIdx: l.line.lineIdx, itemId: l.line.itemId, itemCode: l.itemCode, itemName: l.itemName, baseUom: l.baseUom,
      qtyBase: l.line.qtyBase, qtyIssued: l.line.qtyIssued,
      available: r.status === "requested" ? (availableAt.get(r.toResourceId)?.get(l.line.itemId) ?? 0) : null,
    })),
  }));
}
