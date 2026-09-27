import { and, asc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { withTx } from "../../kernel/db/client";
import { items, stockAdjustments, stockBatches, stockCountLines, stockCounts } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { STOCK_ADJUSTMENT_APPROVAL_TYPE } from "./approval-types";
import { MaterialsError } from "./errors";
import { stockAdjusted } from "./events";
import { postMovements } from "./ledger";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { Custody } from "./controlled";

/**
 * ═══ PLAN 14c, SECOND SLICE — A COUNT'S VARIANCE, BOOKED WITH A SECOND KEY ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-adjustments.md`; doc 09 §3.9's
 * `variance_review → approved(adjusted)`.
 *
 *   requestCountAdjustment (materials head) ─→ approval (medical superintendent) ─→ postAdjustments
 *
 * - **Which lines.** A `variance` line of a submitted or closed count. A `match` has nothing to book.
 *   A `recount` line is booked from its recount, whose own lines carry the settled figure.
 * - **The quantity booked is the variance** (counted − expected at the sheet's time), applied to
 *   the books when posted. Stock that moved since is the ledger's own. A write-off the shelf can no
 *   longer cover is refused whole (`insufficient_stock`), because the ledger never goes negative.
 * - **The reason fits the direction.** `found` books stock ON; `shrinkage`, `damage` and `expiry`
 *   write it OFF; `entry_error` either way. The table's CHECK says the same.
 * - **Two people.** The materials head asks, the medical superintendent decides in the approvals
 *   inbox, and the kernel refuses a requester deciding their own request. Nothing posts before
 *   GRANTED; a REJECTED request marks its lines refused, which frees them to be asked again.
 * - **Posting is idempotent.** Only `requested` rows are posted, once each, in one transaction with
 *   one `stock.adjusted` event.
 */
const COUNTS_MANAGE = "materials.counts.manage";
export const ADJUSTMENT_REASONS = ["shrinkage", "damage", "expiry", "entry_error", "found"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export type AdjustmentView = {
  id: string;
  countId: string;
  countLineId: string;
  batchId: string;
  batchNo: string;
  itemId: string;
  itemCode: string;
  qtyDelta: number;
  valuePaise: number;
  reasonCode: AdjustmentReason;
  note: string | null;
  approvalId: string;
  approvalStatus: string;
  status: "requested" | "posted" | "refused";
  requestedBy: string;
  requestedAt: string;
  postedAt: string | null;
  ledgerEntryId: string | null;
};

async function requireManage(db: Db, actor: Actor, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, COUNTS_MANAGE, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${COUNTS_MANAGE}`);
  }
}

function fitsDirection(reason: AdjustmentReason, qtyDelta: number): boolean {
  if (reason === "entry_error") return true;
  return reason === "found" ? qtyDelta > 0 : qtyDelta < 0;
}

export async function requestCountAdjustment(
  db: Db, actor: Actor, countId: string,
  input: { lines: { lineId: string; reasonCode: AdjustmentReason }[]; note?: string },
  now: Date,
): Promise<{ approvalId: string; adjustments: AdjustmentView[] }> {
  await requireManage(db, actor, "asking to book a count's variance");
  const [count] = await db.select().from(stockCounts).where(eq(stockCounts.id, countId));
  if (count === undefined) throw new MaterialsError("unknown_count", `count ${countId} not found`);
  if (count.status !== "submitted" && count.status !== "closed") {
    throw new MaterialsError("count_not_submitted", `count ${countId} is ${count.status}: only a counted sheet's variance is booked`);
  }
  if (input.lines.length === 0) throw new MaterialsError("nothing_to_adjust", "name at least one variance line");
  const lineIds = input.lines.map((l) => l.lineId);
  const lines = await db.select({ line: stockCountLines, landed: stockBatches.landedCostPaise })
    .from(stockCountLines)
    .innerJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
    .where(and(eq(stockCountLines.countId, countId), inArray(stockCountLines.id, lineIds)));
  const byId = new Map(lines.map((l) => [l.line.id, l] as const));
  const live = await db.select({ lineId: stockAdjustments.countLineId }).from(stockAdjustments)
    .where(and(inArray(stockAdjustments.countLineId, lineIds), inArray(stockAdjustments.status, ["requested", "posted"])));
  const taken = new Set(live.map((l) => l.lineId));

  const planned = input.lines.map((want) => {
    const found = byId.get(want.lineId);
    if (found === undefined || found.line.flag === null || found.line.flag === "match" || found.line.varianceQty === null || found.line.varianceQty === 0) {
      throw new MaterialsError("nothing_to_adjust", `line ${want.lineId} has no variance to book`, { lineId: want.lineId });
    }
    if (found.line.flag === "recount") {
      throw new MaterialsError("recount_pending", "this line was sent for a blind recount — book the recount's line instead", { lineId: want.lineId, recountId: count.recountId });
    }
    if (taken.has(want.lineId)) throw new MaterialsError("already_requested", "this line's variance is already asked for or booked", { lineId: want.lineId });
    if (!(ADJUSTMENT_REASONS as readonly string[]).includes(want.reasonCode) || !fitsDirection(want.reasonCode, found.line.varianceQty)) {
      throw new MaterialsError("invalid_adjustment_reason", `"${want.reasonCode}" does not fit a variance of ${String(found.line.varianceQty)}`, { lineId: want.lineId });
    }
    return {
      id: newId(), line: found.line, qtyDelta: found.line.varianceQty, valuePaise: found.line.varianceQty * found.landed, reasonCode: want.reasonCode,
    };
  });
  if (new Set(lineIds).size !== lineIds.length) throw new MaterialsError("already_requested", "a line is named twice");

  const approvalId = await withTx(db, (tx) => fileCountAdjustment(tx, actor, {
    countId, resourceId: count.resourceId,
    planned: planned.map((p) => ({ lineId: p.line.id, batchId: p.line.batchId, itemId: p.line.itemId, qtyDelta: p.qtyDelta, valuePaise: p.valuePaise, reasonCode: p.reasonCode })),
    note: input.note,
  }, now));
  return { approvalId, adjustments: await listAdjustments(db, actor, { approvalId }) };
}

/**
 * The request itself, inside the caller's transaction: ONE `materials_stock_adjustment` approval (the
 * medical superintendent) for the lines, and a `requested` adjustment per line. `requestCountAdjustment`
 * files it after its grant and variance checks; PHARMACY P6's daily balance check of the controlled
 * cabinet files it the moment a batch does not balance (`controlled-check.ts`) — the same path, so a
 * narcotic that is short reaches the same person a cycle count's shortage does.
 */
export async function fileCountAdjustment(
  tx: Tx, actor: Actor,
  input: {
    countId: string; resourceId: string; note?: string | null;
    planned: { lineId: string; batchId: string; itemId: string; qtyDelta: number; valuePaise: number; reasonCode: AdjustmentReason }[];
  },
  now: Date,
): Promise<string> {
  const net = input.planned.reduce((s, p) => s + p.valuePaise, 0);
  const note = input.note?.trim() ?? "";
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: STOCK_ADJUSTMENT_APPROVAL_TYPE,
    subject: { type: "stock_count", id: input.countId },
    requestNote: `${String(input.planned.length)} line(s), net ₹${(net / 100).toFixed(2)}${note === "" ? "" : ` — ${note}`}`,
  });
  await tx.insert(stockAdjustments).values(input.planned.map((p) => ({
    id: newId(), resourceId: input.resourceId, countId: input.countId, countLineId: p.lineId, batchId: p.batchId, itemId: p.itemId,
    qtyDelta: p.qtyDelta, valuePaise: p.valuePaise, reasonCode: p.reasonCode, note: note === "" ? null : note,
    approvalId, status: "requested", requestedBy: actor.id, requestedAt: now,
  })));
  return approvalId;
}

export async function listAdjustments(
  db: Db, actor: Actor, filter: { countId?: string; approvalId?: string },
): Promise<AdjustmentView[]> {
  await requireManage(db, actor, "reading adjustments");
  const where = [
    ...(filter.countId === undefined ? [] : [eq(stockAdjustments.countId, filter.countId)]),
    ...(filter.approvalId === undefined ? [] : [eq(stockAdjustments.approvalId, filter.approvalId)]),
  ];
  const rows = await db.select({ a: stockAdjustments, batchNo: stockBatches.batchNo, itemCode: items.code })
    .from(stockAdjustments)
    .innerJoin(stockBatches, eq(stockBatches.id, stockAdjustments.batchId))
    .innerJoin(items, eq(items.id, stockAdjustments.itemId))
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(asc(stockAdjustments.requestedAt), asc(items.code), asc(stockBatches.batchNo))
    .limit(500);
  const approvalStatus = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.a.approvalId))) approvalStatus.set(id, (await getApproval(db, id))?.status ?? "unknown");
  return rows.map(({ a, batchNo, itemCode }) => ({
    id: a.id, countId: a.countId, countLineId: a.countLineId, batchId: a.batchId, batchNo, itemId: a.itemId, itemCode,
    qtyDelta: a.qtyDelta, valuePaise: a.valuePaise, reasonCode: a.reasonCode as AdjustmentReason, note: a.note,
    approvalId: a.approvalId, approvalStatus: approvalStatus.get(a.approvalId) ?? "unknown",
    status: a.status as AdjustmentView["status"], requestedBy: a.requestedBy, requestedAt: a.requestedAt.toISOString(),
    postedAt: a.postedAt === null ? null : a.postedAt.toISOString(), ledgerEntryId: a.ledgerEntryId,
  }));
}

/**
 * Books a request's lines once its approval is granted. A rejected request marks its lines refused.
 * A pending one is refused (`adjustment_unapproved`).
 */
export async function postAdjustments(
  db: Db, actor: Actor, approvalId: string, now: Date,
  /**
   * PHARMACY P6 — the controlled cabinet's daily balance check books its own variance, once the medical
   * superintendent has granted it, by its custodian with a witness (`custody`, the ledger's second key).
   * That path is open ONLY for a `controlled_check` count — the custodian's grant and the witness's PIN
   * are asked by the pharmacy's act before it gets here; every other count still needs
   * `materials.counts.manage`, unchanged.
   */
  opts: { custody?: Custody } = {},
): Promise<{ posted: number; refused: number }> {
  const rows = await db.select().from(stockAdjustments).where(eq(stockAdjustments.approvalId, approvalId));
  if (rows.length === 0) {
    await requireManage(db, actor, "booking an adjustment");
    throw new MaterialsError("unknown_adjustment", `no adjustment was asked under approval ${approvalId}`);
  }
  const [count] = await db.select({ kind: stockCounts.kind }).from(stockCounts).where(eq(stockCounts.id, rows[0]!.countId));
  if (opts.custody === undefined || count?.kind !== "controlled_check") await requireManage(db, actor, "booking an adjustment");
  const approval = await getApproval(db, approvalId);
  const open = rows.filter((r) => r.status === "requested");
  if (approval?.status === "rejected") {
    if (open.length > 0) {
      await db.update(stockAdjustments).set({ status: "refused" })
        .where(and(eq(stockAdjustments.approvalId, approvalId), eq(stockAdjustments.status, "requested")));
    }
    return { posted: 0, refused: open.length };
  }
  if (approval?.status !== "granted") {
    throw new MaterialsError("adjustment_unapproved", `approval ${approvalId} is ${approval?.status ?? "missing"}: nothing is booked before it is granted`, { approvalStatus: approval?.status ?? null });
  }
  if (open.length === 0) return { posted: 0, refused: 0 };
  return withTx(db, async (tx) => {
    const moved = await postMovements(tx, actor, open.map((r) => ({
      resourceId: r.resourceId, batchId: r.batchId, qtyDelta: r.qtyDelta, reason: "adjust" as const,
      refType: "stock_adjustment", refId: r.id, occurredAt: now,
      ...(opts.custody === undefined ? {} : { custody: { ...opts.custody, documentRef: opts.custody.documentRef ?? `approval ${approvalId}` } }),
    })));
    const lines = [];
    for (const [i, r] of open.entries()) {
      const ledgerEntryId = moved[i]!.ledgerEntryId;
      const won = await tx.update(stockAdjustments)
        .set({ status: "posted", postedBy: actor.id, postedAt: now, ledgerEntryId })
        .where(and(eq(stockAdjustments.id, r.id), eq(stockAdjustments.status, "requested")))
        .returning({ id: stockAdjustments.id });
      if (won.length === 0) throw new MaterialsError("already_requested", `adjustment ${r.id} was booked concurrently`);
      lines.push({ adjustmentId: r.id, batchId: r.batchId, itemId: r.itemId, qtyDelta: r.qtyDelta, valuePaise: r.valuePaise, reasonCode: r.reasonCode, ledgerEntryId });
    }
    await appendEvent(tx, stockAdjusted.make({
      occurredAt: now, actor,
      payload: {
        approvalId, countId: open[0]!.countId, storeResourceId: open[0]!.resourceId, postedBy: actor.id, lines,
        netValuePaise: lines.reduce((s, l) => s + l.valuePaise, 0),
      },
    }));
    return { posted: open.length, refused: 0 };
  });
}
