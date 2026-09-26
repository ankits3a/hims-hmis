import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { assertNotSodPair } from "../../kernel/auth/sod";
import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { getApproval, listApprovals } from "../../kernel/approvals/worklist";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  approvals, grnLines, grns, itemStockLevels, itemUoms, items, purchaseOrderLines, purchaseOrders, resources, users, vendors,
} from "../../kernel/db/schema";
import { PO_APPROVAL_TYPE, PO_OWNER_APPROVAL_TYPE } from "./approval-types";
import { PO_HEAD_APPROVAL_LIMIT_PAISE, PO_RECEIPT_TOLERANCE_BPS } from "./config";
import { MaterialsError } from "./errors";
import {
  purchaseOrderApproved, purchaseOrderCancelled, purchaseOrderDrafted, purchaseOrderReceived, purchaseOrderRejected,
  purchaseOrderSent, purchaseOrderSubmitted, purchaseOrderUpdated, stockLevelSet,
} from "./events";
import { assertNotMerged, withMergedAliases } from "./items";
import { assertVendorPurchasable } from "./vendors";
import { requireStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P2 — BUYING: LEVELS, THE PURCHASE ORDER, AND THE RECEIPT AGAINST IT ═══
 *
 * Plan `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md`, P2. Materials OWNS the
 * order (stock lives here); the pharmacy's back office only federates it (`pharmacy/office.ts`).
 *
 *   draft ─submit→ pending_approval ─approve→ approved ─send→ sent ─GRN→ part_received ─GRN→ received
 *                        └─reject→ draft (with the reason)      open states ─cancel→ cancelled
 *
 * - **Who.** `materials.po.raise` drafts, edits, submits, sends and cancels (materials_head, the
 *   pharmacist). The DECISION is the approvals engine's: up to `PO_HEAD_APPROVAL_LIMIT_PAISE` the
 *   `materials_po_approval` type (materials_head), above it `materials_po_approval_owner` (owner).
 *   The kernel refuses the submitter deciding their own request; this file also refuses whoever
 *   DRAFTED it (`requester_approver`, checked here because the drafter and the submitter may differ).
 * - **Decided in the inbox or on the sheet — the same thing.** `decidePurchaseOrder` calls the
 *   kernel's decision and then settles the order; a decision taken in `/approvals` instead is
 *   settled by `settlePurchaseOrders` the next time anything reads or acts on an order.
 * - **Received against.** A GRN may name the order (`grns.purchase_order_id`). Capture refuses the
 *   order's approver (`po_approver_grn_receiver`), another vendor or store, an item it does not
 *   carry, and a paid quantity beyond ordered + `PO_RECEIPT_TOLERANCE_BPS` counting every GRN
 *   already captured against it. Posting re-asks all of that under the order's row lock, books the
 *   ACCEPTED quantity onto the lines, and moves the order to `part_received` or `received`. Less than
 *   ordered leaves the line open — short supplied — until a later GRN or a cancel.
 * - **Money.** Paise everywhere. A line is `qty_packs × rate_paise`, its GST is that times the rate
 *   in basis points, rounded half up per line; the header keeps the sums.
 */

const PO_RAISE = "materials.po.raise";
const APPROVALS_DECIDE = "approvals.requests.decide";
const STOCK_READ = "materials.stock.read";

export type PoStatus = "draft" | "pending_approval" | "approved" | "sent" | "part_received" | "received" | "cancelled";
export const OPEN_PO_STATUSES: readonly PoStatus[] = ["draft", "pending_approval", "approved", "sent", "part_received"];
/** The statuses a GRN may be captured against. An approved order phoned through is an order. */
const RECEIVABLE: readonly PoStatus[] = ["approved", "sent", "part_received"];

export type PoLineInput = {
  itemId: string;
  /** The pack ordered in. Defaults to the item's purchase unit, else its largest pack. */
  uom?: string | null;
  qtyPacks: number;
  freePacks?: number;
  /** PTR per pack, before GST. */
  ratePaise: number;
  /** Defaults to the item's own GST rate. */
  gstRateBps?: number | null;
  mrpPaise?: number | null;
};

export type PoInput = {
  vendorId: string;
  storeResourceId: string;
  expectedDate?: string | null;
  terms?: string | null;
  note?: string | null;
  lines: PoLineInput[];
};

export type PoLineView = {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUom: string;
  uom: string;
  multiplier: number;
  qtyPacks: number;
  freePacks: number;
  ratePaise: number;
  gstRateBps: number;
  gstPaise: number;
  mrpPaise: number | null;
  lineTotalPaise: number;
  orderedBase: number;
  receivedBase: number;
  freeReceivedBase: number;
  /** What is still to come, in base units (never negative). */
  remainingBase: number;
};

export type PoSummary = {
  id: string;
  poNo: string;
  status: PoStatus;
  source: "manual" | "agent";
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  storeResourceId: string;
  storeCode: string;
  expectedDate: string | null;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  lineCount: number;
  approvalId: string | null;
  approvalTier: "head" | "owner" | null;
  rejectionNote: string | null;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
};

export type PoView = PoSummary & {
  terms: string | null;
  note: string | null;
  storeName: string;
  vendorGstin: string | null;
  cancelReason: string | null;
  names: Record<string, string>;
  approval: { status: string; approverRole: string; requesterId: string; decidedBy: string | null; decisionNote: string | null } | null;
  lines: PoLineView[];
};

// ═══════════════════════════════════ small pure pieces ═══════════════════════════════════

/** A line's GST in paise: half up, per line — the way a supplier's bill computes it. */
export function lineGstPaise(lineTotalPaise: number, gstRateBps: number): number {
  return Math.floor((lineTotalPaise * gstRateBps + 5_000) / 10_000);
}

/** Which approval a total goes to. At the limit is still the head's. */
export function approvalTierFor(totalPaise: number): "head" | "owner" {
  return totalPaise <= PO_HEAD_APPROVAL_LIMIT_PAISE ? "head" : "owner";
}

/** The most a line may receive, paid quantity, in base units: ordered plus the tolerance, rounded down. */
export function allowedReceiptBase(orderedBase: number): number {
  return Math.floor((orderedBase * (10_000 + PO_RECEIPT_TOLERANCE_BPS)) / 10_000);
}

/**
 * The IST calendar date of an instant. By the zone's name rather than a fifteenth hand-rolled copy
 * of the offset (`ist-clock-parity.test.ts` pins the copies); `grn.ts`'s `istDay` would do, but it
 * imports this file.
 */
const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
function istDayOf(at: Date): string {
  return IST_DAY.format(at);
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// ═══════════════════════════════════ who may ═══════════════════════════════════

async function requireRaiser(db: Db | Tx, actor: Actor, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, PO_RAISE, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${PO_RAISE}`);
  }
}

/**
 * Reading an order: whoever reads stock (the stores and the pharmacy — a storekeeper must see what
 * is coming), and whoever may decide one (an approver opening what they approve).
 */
async function requireReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user" && (await hasPermission(db, actor.id, STOCK_READ, "hospital")
    || await hasPermission(db, actor.id, APPROVALS_DECIDE, "hospital"))) return;
  throw new MaterialsError("permission_denied", `reading purchase orders needs ${STOCK_READ} or ${APPROVALS_DECIDE}`);
}

// ═══════════════════════════════════ lines ═══════════════════════════════════

type ResolvedLine = {
  itemId: string; uom: string; multiplier: number; qtyPacks: number; freePacks: number;
  ratePaise: number; gstRateBps: number; mrpPaise: number | null; lineTotalPaise: number; gstPaise: number;
};

const MAX_LINES = 200;
const MAX_PACKS = 1_000_000;
const MAX_RATE_PAISE = 1_000_000_000; // ₹1 crore a pack is a typo, not a price
const MAX_TEXT = 500;

async function resolveLines(tx: Tx, lines: readonly PoLineInput[]): Promise<ResolvedLine[]> {
  if (lines.length === 0) throw new MaterialsError("po_invalid", "an order carries at least one line");
  if (lines.length > MAX_LINES) throw new MaterialsError("po_invalid", `an order carries at most ${String(MAX_LINES)} lines`);
  const ids = [...new Set(lines.map((l) => l.itemId))];
  if (ids.length !== lines.length) throw new MaterialsError("po_invalid", "an item appears twice — put it on one line");
  const found = await tx.select().from(items).where(inArray(items.id, ids));
  const byId = new Map(found.map((i) => [i.id, i]));
  const packs = await tx.select().from(itemUoms).where(inArray(itemUoms.itemId, ids));
  // PHARMACY P6 — an item merged into another is never ordered: the refusal names the survivor.
  await assertNotMerged(tx, found.filter((i) => i.mergedIntoItemId !== null).map((i) => i.id), "ordering it");
  return lines.map((l) => {
    const item = byId.get(l.itemId);
    if (item === undefined) throw new MaterialsError("unknown_item", `item ${l.itemId} not found`, { itemId: l.itemId });
    if (!item.active) throw new MaterialsError("po_invalid", `item ${item.code} is inactive and cannot be ordered`, { itemId: l.itemId });
    const mine = packs.filter((p) => p.itemId === l.itemId);
    const wanted = l.uom?.trim().toLowerCase();
    const pack = wanted !== undefined && wanted !== ""
      ? mine.find((p) => p.uom.toLowerCase() === wanted)
      : mine.find((p) => p.isPurchaseUom) ?? [...mine].sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier)[0];
    if (pack === undefined) {
      throw new MaterialsError("po_invalid", `item ${item.code} has no pack "${l.uom ?? ""}"`, { itemId: l.itemId, uom: l.uom ?? null });
    }
    const free = l.freePacks ?? 0;
    const gst = l.gstRateBps ?? item.gstRateBps ?? 0;
    const mrp = l.mrpPaise ?? null;
    const okInt = (n: number, lo: number, hi: number): boolean => Number.isSafeInteger(n) && n >= lo && n <= hi;
    if (!okInt(l.qtyPacks, 1, MAX_PACKS) || !okInt(free, 0, MAX_PACKS) || !okInt(l.ratePaise, 0, MAX_RATE_PAISE)
      || !okInt(gst, 0, 2_800) || (mrp !== null && !okInt(mrp, 1, MAX_RATE_PAISE))) {
      throw new MaterialsError("po_invalid", `line for ${item.code}: quantity, free quantity, rate, GST or MRP is out of range`, { itemId: l.itemId });
    }
    const lineTotalPaise = l.qtyPacks * l.ratePaise;
    return {
      itemId: l.itemId, uom: pack.uom, multiplier: pack.toBaseMultiplier, qtyPacks: l.qtyPacks, freePacks: free,
      ratePaise: l.ratePaise, gstRateBps: gst, mrpPaise: mrp, lineTotalPaise, gstPaise: lineGstPaise(lineTotalPaise, gst),
    };
  });
}

function totalsOf(lines: readonly ResolvedLine[]): { subtotalPaise: number; gstPaise: number; totalPaise: number } {
  const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const gstPaise = lines.reduce((s, l) => s + l.gstPaise, 0);
  return { subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise };
}

function cleanText(v: string | null | undefined, what: string): string | null {
  const t = v?.trim() ?? "";
  if (t.length > MAX_TEXT) throw new MaterialsError("po_invalid", `${what} is longer than ${String(MAX_TEXT)} characters`);
  return t === "" ? null : t;
}

function cleanDate(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (!isIsoDate(v)) throw new MaterialsError("po_invalid", `expected date "${v}" is not a calendar date`);
  return v;
}

async function insertLines(tx: Tx, poId: string, lines: readonly ResolvedLine[]): Promise<void> {
  await tx.insert(purchaseOrderLines).values(lines.map((l) => ({
    id: newId(), purchaseOrderId: poId, itemId: l.itemId, uom: l.uom, multiplier: l.multiplier,
    qtyPacks: l.qtyPacks, freePacks: l.freePacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps,
    mrpPaise: l.mrpPaise, lineTotalPaise: l.lineTotalPaise,
  })));
}

type PoRow = typeof purchaseOrders.$inferSelect;

async function lockPo(tx: Tx, poId: string): Promise<PoRow> {
  const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for("update");
  const row = rows[0];
  if (row === undefined) throw new MaterialsError("unknown_purchase_order", `purchase order ${poId} not found`);
  return row;
}

function wrongStatus(po: PoRow, act: string, need: readonly string[]): MaterialsError {
  return new MaterialsError(
    "po_wrong_status",
    `purchase order ${po.poNo} is ${po.status}; ${act} needs it ${need.join(" or ")}`,
    { status: po.status, poNo: po.poNo },
  );
}

const header = (po: PoRow): { purchaseOrderId: string; poNo: string; vendorId: string; totalPaise: number } =>
  ({ purchaseOrderId: po.id, poNo: po.poNo, vendorId: po.vendorId, totalPaise: po.totalPaise });

// ═══════════════════════════════════ draft, edit ═══════════════════════════════════

export async function createPurchaseOrder(
  db: Db, actor: Actor, input: PoInput, opts: { source?: "manual" | "agent"; now?: Date } = {},
): Promise<PoView> {
  await requireRaiser(db, actor, "drafting a purchase order");
  const now = opts.now ?? new Date();
  const poId = await withTx(db, async (tx) => {
    await assertVendorPurchasable(tx, input.vendorId);
    await requireStore(tx, input.storeResourceId);
    const lines = await resolveLines(tx, input.lines);
    const totals = totalsOf(lines);
    const id = newId();
    const poNo = await nextEpisodeNo(tx, "purchase_order", istDayOf(now));
    await tx.insert(purchaseOrders).values({
      id, poNo, vendorId: input.vendorId, storeResourceId: input.storeResourceId, status: "draft",
      source: opts.source ?? "manual", expectedDate: cleanDate(input.expectedDate),
      terms: cleanText(input.terms, "terms"), note: cleanText(input.note, "the note"),
      ...totals, createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    });
    await insertLines(tx, id, lines);
    await appendEvent(tx, purchaseOrderDrafted.make({
      occurredAt: now, actor, correlationId: id,
      payload: {
        purchaseOrderId: id, poNo, vendorId: input.vendorId, totalPaise: totals.totalPaise,
        storeResourceId: input.storeResourceId, source: opts.source ?? "manual", lines: lines.length,
      },
    }));
    return id;
  });
  return (await readPurchaseOrder(db, poId))!;
}

/** A draft's header and, when given, its whole set of lines. Only a draft is edited. */
export async function updatePurchaseOrder(
  db: Db, actor: Actor, poId: string, patch: Partial<PoInput>, now: Date = new Date(),
): Promise<PoView> {
  await requireRaiser(db, actor, "editing a purchase order");
  await withTx(db, async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== "draft") throw wrongStatus(po, "editing", ["draft"]);
    const set: Partial<typeof purchaseOrders.$inferInsert> = { updatedBy: actor.id, updatedAt: now };
    if (patch.vendorId !== undefined && patch.vendorId !== po.vendorId) {
      await assertVendorPurchasable(tx, patch.vendorId);
      set.vendorId = patch.vendorId;
    }
    if (patch.storeResourceId !== undefined) {
      await requireStore(tx, patch.storeResourceId);
      set.storeResourceId = patch.storeResourceId;
    }
    if (patch.expectedDate !== undefined) set.expectedDate = cleanDate(patch.expectedDate);
    if (patch.terms !== undefined) set.terms = cleanText(patch.terms, "terms");
    if (patch.note !== undefined) set.note = cleanText(patch.note, "the note");
    let lineCount = (await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId))).length;
    if (patch.lines !== undefined) {
      const lines = await resolveLines(tx, patch.lines);
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
      await insertLines(tx, poId, lines);
      Object.assign(set, totalsOf(lines));
      lineCount = lines.length;
    }
    const [after] = await tx.update(purchaseOrders).set(set).where(eq(purchaseOrders.id, poId)).returning();
    await appendEvent(tx, purchaseOrderUpdated.make({
      occurredAt: now, actor, correlationId: poId, payload: { ...header(after!), lines: lineCount },
    }));
  });
  return (await readPurchaseOrder(db, poId))!;
}

// ═══════════════════════════════════ approval ═══════════════════════════════════

/**
 * Draft → pending_approval: files the approval of the tier the TOTAL falls in. The vendor must still
 * be active: an order to a vendor suspended since it was drafted is refused here, not at the gate.
 */
export async function submitPurchaseOrder(db: Db, actor: Actor, poId: string, now: Date = new Date()): Promise<PoView> {
  await requireRaiser(db, actor, "submitting a purchase order");
  await withTx(db, async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== "draft") throw wrongStatus(po, "submitting", ["draft"]);
    const lines = await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
    if (lines.length === 0) throw new MaterialsError("po_invalid", "an order carries at least one line");
    const vendor = await assertVendorPurchasable(tx, po.vendorId);
    const tier = approvalTierFor(po.totalPaise);
    const { approvalId } = await requestApproval(tx, actor, {
      typeKey: tier === "head" ? PO_APPROVAL_TYPE : PO_OWNER_APPROVAL_TYPE,
      subject: { type: "purchase_order", id: poId },
      payeeId: po.vendorId,
      ...(po.totalPaise > 0 ? { amountPaise: po.totalPaise } : {}),
      requestNote: `${po.poNo} · ${vendor.legalName} · ${String(lines.length)} line(s) · ₹${(po.totalPaise / 100).toFixed(2)}`,
    });
    await tx.update(purchaseOrders).set({
      status: "pending_approval", approvalId, approvalTier: tier, submittedBy: actor.id, submittedAt: now,
      rejectionNote: null, updatedBy: actor.id, updatedAt: now,
    }).where(eq(purchaseOrders.id, poId));
    await appendEvent(tx, purchaseOrderSubmitted.make({
      occurredAt: now, actor, correlationId: poId, payload: { ...header(po), approvalId, tier },
    }));
  });
  return (await readPurchaseOrder(db, poId))!;
}

/**
 * Approve or reject from the order's own sheet. The kernel decides (approver role, requester ≠
 * approver, note mandatory); this adds that whoever DRAFTED the order may not decide it either, and
 * then settles the order in the kernel's wake.
 */
export async function decidePurchaseOrder(
  db: Db, actor: Actor, poId: string, verdict: "approve" | "reject", note: string, now: Date = new Date(),
): Promise<PoView> {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (po === undefined) throw new MaterialsError("unknown_purchase_order", `purchase order ${poId} not found`);
  if (po.status !== "pending_approval" || po.approvalId === null) throw wrongStatus(po, "a decision", ["pending_approval"]);
  // The raiser can never approve their own order — even when a colleague pressed Submit.
  await assertNotSodPair(db, "requester_approver", { type: "user", id: po.createdBy }, actor);
  if (verdict === "approve") await approveRequest(db, actor, { approvalId: po.approvalId, note });
  else await rejectRequest(db, actor, { approvalId: po.approvalId, note });
  await settlePurchaseOrders(db, now, [poId]);
  return (await readPurchaseOrder(db, poId))!;
}

/**
 * Brings pending orders level with their approvals: granted → approved (the approval's decider is
 * the order's approver), rejected → back to draft with the decision note. Idempotent; each move is a
 * conditional update on `status = 'pending_approval' and approval_id = <that approval>`.
 */
export async function settlePurchaseOrders(db: Db, now: Date = new Date(), poIds?: readonly string[]): Promise<number> {
  const decided = await db.select({ po: purchaseOrders, ap: approvals }).from(purchaseOrders)
    .innerJoin(approvals, eq(approvals.id, purchaseOrders.approvalId))
    .where(and(
      eq(purchaseOrders.status, "pending_approval"), ne(approvals.status, "pending"),
      ...(poIds === undefined ? [] : [inArray(purchaseOrders.id, [...poIds])]),
    ));
  let moved = 0;
  for (const { po, ap } of decided) {
    const decider: Actor = { type: "user", id: ap.decidedBy ?? "unknown" };
    await withTx(db, async (tx) => {
      const guard = and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, "pending_approval"), eq(purchaseOrders.approvalId, ap.id));
      if (ap.status === "granted") {
        const won = await tx.update(purchaseOrders).set({
          status: "approved", approvedBy: ap.decidedBy, approvedAt: ap.decidedAt ?? now, updatedBy: ap.decidedBy ?? po.updatedBy, updatedAt: now,
        }).where(guard).returning({ id: purchaseOrders.id });
        if (won.length === 0) return;
        await appendEvent(tx, purchaseOrderApproved.make({
          occurredAt: now, actor: decider, correlationId: po.id,
          payload: { ...header(po), approvalId: ap.id, approvedBy: ap.decidedBy ?? "unknown" },
        }));
      } else {
        const won = await tx.update(purchaseOrders).set({
          status: "draft", approvalId: null, approvalTier: null, rejectionNote: ap.decisionNote ?? "rejected",
          updatedBy: ap.decidedBy ?? po.updatedBy, updatedAt: now,
        }).where(guard).returning({ id: purchaseOrders.id });
        if (won.length === 0) return;
        await appendEvent(tx, purchaseOrderRejected.make({
          occurredAt: now, actor: decider, correlationId: po.id,
          payload: { ...header(po), approvalId: ap.id, rejectedBy: ap.decidedBy ?? "unknown", note: ap.decisionNote ?? "" },
        }));
      }
      moved += 1;
    });
  }
  return moved;
}

// ═══════════════════════════════════ send, cancel ═══════════════════════════════════

/** Approved → sent: the order has gone to the vendor (its PDF is `pharmacy/po-document.ts`). */
export async function sendPurchaseOrder(db: Db, actor: Actor, poId: string, now: Date = new Date()): Promise<PoView> {
  await requireRaiser(db, actor, "sending a purchase order");
  await settlePurchaseOrders(db, now, [poId]);
  await withTx(db, async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== "approved") throw wrongStatus(po, "sending", ["approved"]);
    await assertVendorPurchasable(tx, po.vendorId);
    await tx.update(purchaseOrders).set({ status: "sent", sentBy: actor.id, sentAt: now, updatedBy: actor.id, updatedAt: now })
      .where(eq(purchaseOrders.id, poId));
    await appendEvent(tx, purchaseOrderSent.make({ occurredAt: now, actor, correlationId: poId, payload: { ...header(po), sentBy: actor.id } }));
  });
  return (await readPurchaseOrder(db, poId))!;
}

/**
 * Any open order that has received nothing may be cancelled, with a reason. One that has received
 * something is not cancelled — its GRNs are facts; short-closing the rest is P3's.
 */
export async function cancelPurchaseOrder(db: Db, actor: Actor, poId: string, reason: string, now: Date = new Date()): Promise<PoView> {
  await requireRaiser(db, actor, "cancelling a purchase order");
  const why = reason.trim();
  if (why === "") throw new MaterialsError("reason_required", "say why the order is cancelled");
  await withTx(db, async (tx) => {
    const po = await lockPo(tx, poId);
    const cancellable = ["draft", "pending_approval", "approved", "sent"];
    if (!cancellable.includes(po.status)) throw wrongStatus(po, "cancelling", cancellable);
    const against = await tx.select({ id: grns.id }).from(grns).where(eq(grns.purchaseOrderId, poId)).limit(1);
    if (against.length > 0) {
      throw new MaterialsError("po_wrong_status", `purchase order ${po.poNo} already has a GRN against it and cannot be cancelled`, { status: po.status });
    }
    await tx.update(purchaseOrders).set({
      status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: why.slice(0, MAX_TEXT), updatedBy: actor.id, updatedAt: now,
    }).where(eq(purchaseOrders.id, poId));
    await appendEvent(tx, purchaseOrderCancelled.make({
      occurredAt: now, actor, correlationId: poId, payload: { ...header(po), reason: why.slice(0, MAX_TEXT), fromStatus: po.status },
    }));
  });
  return (await readPurchaseOrder(db, poId))!;
}

// ═══════════════════════════════════ the receipt ═══════════════════════════════════

/**
 * The SoD engine's half of `po_approver_grn_receiver`: run on `db` BEFORE the GRN's transaction, so
 * the `sod.violation_blocked` event survives the refusal (kernel/auth/sod.ts). The in-transaction
 * half, `assertReceivableAgainstPo`, refuses the same person whatever the caller did.
 */
export async function assertNotPoApprover(db: Db, actor: Actor, poId: string): Promise<void> {
  const [po] = await db.select({ approvedBy: purchaseOrders.approvedBy }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (po?.approvedBy === null || po?.approvedBy === undefined) return;
  await assertNotSodPair(db, "po_approver_grn_receiver", { type: "user", id: po.approvedBy }, actor);
}

/** The PO a GRN names, for `assertNotPoApprover` at post. */
export async function purchaseOrderOfGrn(db: Db, grnId: string): Promise<string | null> {
  const [row] = await db.select({ poId: grns.purchaseOrderId }).from(grns).where(eq(grns.id, grnId));
  return row?.poId ?? null;
}

type ReceiptLine = { itemId: string; qtyBase: number; freeGoods: boolean };

/**
 * Every GRN against the order that has been captured and not posted, by item, paid quantity only —
 * a second lorry captured before the first is posted must not be allowed the same headroom twice.
 */
async function unpostedPaidBase(tx: Tx, poId: string, exceptGrnId?: string): Promise<Map<string, number>> {
  const rows = await tx.select({ itemId: grnLines.itemId, qty: sql<string>`sum(${grnLines.qtyBase})` })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId))
    .where(and(
      eq(grns.purchaseOrderId, poId), ne(grns.status, "posted"), eq(grnLines.freeGoods, false),
      ...(exceptGrnId === undefined ? [] : [ne(grns.id, exceptGrnId)]),
    ))
    .groupBy(grnLines.itemId);
  return new Map(rows.map((r) => [r.itemId, Number(r.qty)]));
}

/**
 * Capture-time: may this delivery be received against this order? Locks the order row so two
 * captures against one order take turns. Refuses, in this order: an order that is not receivable,
 * another vendor or store, the order's approver as receiver, an item the order does not carry, and
 * a paid quantity past ordered + tolerance counting what is posted AND what is captured.
 */
export async function assertReceivableAgainstPo(
  tx: Tx, actor: Actor, poId: string, grn: { vendorId: string; storeResourceId: string }, lines: readonly ReceiptLine[],
): Promise<void> {
  const po = await lockPo(tx, poId);
  if (!RECEIVABLE.includes(po.status as PoStatus)) throw wrongStatus(po, "receiving against it", RECEIVABLE);
  if (po.vendorId !== grn.vendorId || po.storeResourceId !== grn.storeResourceId) {
    throw new MaterialsError("po_mismatch", `purchase order ${po.poNo} is for another vendor or store`, {
      poNo: po.poNo, vendorId: po.vendorId, storeResourceId: po.storeResourceId,
    });
  }
  if (actor.id === po.approvedBy) {
    throw new MaterialsError("po_approver_receiving", `you approved purchase order ${po.poNo}; somebody else receives it`, { poNo: po.poNo });
  }
  const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
  const byItem = new Map(poLines.map((l) => [l.itemId, l]));
  const pending = await unpostedPaidBase(tx, poId);
  const thisGrn = new Map<string, number>();
  for (const l of lines) {
    const pl = byItem.get(l.itemId);
    if (pl === undefined) throw new MaterialsError("po_mismatch", `purchase order ${po.poNo} does not carry this item`, { itemId: l.itemId, poNo: po.poNo });
    if (!l.freeGoods) thisGrn.set(l.itemId, (thisGrn.get(l.itemId) ?? 0) + l.qtyBase);
  }
  for (const [itemId, qty] of thisGrn) {
    const pl = byItem.get(itemId)!;
    overReceipt(po.poNo, pl, pl.receivedBase + (pending.get(itemId) ?? 0), qty);
  }
}

function overReceipt(poNo: string, pl: typeof purchaseOrderLines.$inferSelect, alreadyBase: number, thisBase: number): void {
  const orderedBase = pl.qtyPacks * pl.multiplier;
  const allowedBase = allowedReceiptBase(orderedBase);
  if (alreadyBase + thisBase > allowedBase) {
    throw new MaterialsError(
      "po_over_receipt",
      `purchase order ${poNo}: ${String(alreadyBase + thisBase)} would be received against ${String(orderedBase)} ordered; `
        + `at most ${String(allowedBase)} (ordered + ${String(PO_RECEIPT_TOLERANCE_BPS / 100)}%) — free goods go on their own line`,
      { itemId: pl.itemId, orderedBase, alreadyBase, thisBase, allowedBase },
    );
  }
}

/**
 * Post-time: books a posted GRN's ACCEPTED quantities onto the order, under its row lock, re-asking
 * the approver and the tolerance (the capture's answer has an age). Returns the order's new status.
 */
export async function applyReceiptToPo(
  tx: Tx, actor: Actor, poId: string, grnId: string, accepted: readonly ReceiptLine[], now: Date,
): Promise<PoStatus> {
  const po = await lockPo(tx, poId);
  if (!RECEIVABLE.includes(po.status as PoStatus)) throw wrongStatus(po, "receiving against it", RECEIVABLE);
  if (actor.id === po.approvedBy) {
    throw new MaterialsError("po_approver_receiving", `you approved purchase order ${po.poNo}; somebody else receives it`, { poNo: po.poNo });
  }
  const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
  const byItem = new Map(poLines.map((l) => [l.itemId, l]));
  const add = new Map<string, { paid: number; free: number }>();
  for (const l of accepted) {
    if (!byItem.has(l.itemId)) throw new MaterialsError("po_mismatch", `purchase order ${po.poNo} does not carry this item`, { itemId: l.itemId });
    const a = add.get(l.itemId) ?? { paid: 0, free: 0 };
    if (l.freeGoods) a.free += l.qtyBase; else a.paid += l.qtyBase;
    add.set(l.itemId, a);
  }
  const changed: { itemId: string; receivedBase: number; freeReceivedBase: number }[] = [];
  for (const [itemId, a] of add) {
    const pl = byItem.get(itemId)!;
    overReceipt(po.poNo, pl, pl.receivedBase, a.paid);
    pl.receivedBase += a.paid;
    pl.freeReceivedBase += a.free;
    await tx.update(purchaseOrderLines).set({ receivedBase: pl.receivedBase, freeReceivedBase: pl.freeReceivedBase })
      .where(eq(purchaseOrderLines.id, pl.id));
    changed.push({ itemId, receivedBase: pl.receivedBase, freeReceivedBase: pl.freeReceivedBase });
  }
  const complete = poLines.every((l) => l.receivedBase >= l.qtyPacks * l.multiplier);
  const status: PoStatus = complete ? "received" : "part_received";
  await tx.update(purchaseOrders).set({ status, updatedBy: actor.id, updatedAt: now }).where(eq(purchaseOrders.id, poId));
  if (changed.length > 0) {
    await appendEvent(tx, purchaseOrderReceived.make({
      occurredAt: now, actor, correlationId: poId, payload: { ...header(po), grnId, status, lines: changed },
    }));
  }
  return status;
}

/**
 * What a GRN against this order would prefill: each line's remaining paid quantity in its pack,
 * the rate per BASE unit the GRN records (rounded to the paise), and the expected MRP per pack.
 */
export async function receivableLines(db: Db, actor: Actor, poId: string): Promise<{
  purchaseOrder: PoSummary;
  lines: { itemId: string; itemCode: string; itemName: string; uom: string; multiplier: number; remainingPacks: number; remainingBase: number; unitCostPaise: number; mrpPaise: number | null; freePacksRemaining: number }[];
}> {
  const po = await getPurchaseOrder(db, actor, poId);
  if (!RECEIVABLE.includes(po.status)) {
    throw new MaterialsError("po_wrong_status", `purchase order ${po.poNo} is ${po.status}; only an approved or sent order is received against`, { status: po.status });
  }
  return {
    purchaseOrder: po,
    lines: po.lines.filter((l) => l.remainingBase > 0 || l.freePacks * l.multiplier > l.freeReceivedBase).map((l) => ({
      itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, uom: l.uom, multiplier: l.multiplier,
      remainingPacks: Math.ceil(l.remainingBase / l.multiplier), remainingBase: l.remainingBase,
      unitCostPaise: Math.round(l.ratePaise / l.multiplier), mrpPaise: l.mrpPaise,
      freePacksRemaining: Math.max(0, Math.floor((l.freePacks * l.multiplier - l.freeReceivedBase) / l.multiplier)),
    })),
  };
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

function summaryOf(
  po: PoRow, vendor: { code: string; legalName: string; tradeName: string | null }, storeCode: string, lineCount: number,
): PoSummary {
  return {
    id: po.id, poNo: po.poNo, status: po.status as PoStatus, source: po.source as "manual" | "agent",
    vendorId: po.vendorId, vendorCode: vendor.code, vendorName: vendor.tradeName ?? vendor.legalName,
    storeResourceId: po.storeResourceId, storeCode, expectedDate: po.expectedDate,
    subtotalPaise: po.subtotalPaise, gstPaise: po.gstPaise, totalPaise: po.totalPaise, lineCount,
    approvalId: po.approvalId, approvalTier: po.approvalTier as "head" | "owner" | null, rejectionNote: po.rejectionNote,
    createdBy: po.createdBy, createdAt: po.createdAt.toISOString(),
    submittedAt: po.submittedAt?.toISOString() ?? null, approvedBy: po.approvedBy, approvedAt: po.approvedAt?.toISOString() ?? null,
    sentAt: po.sentAt?.toISOString() ?? null,
  };
}

async function readPurchaseOrder(db: Db, poId: string): Promise<PoView | undefined> {
  const [row] = await db.select({ po: purchaseOrders, vendor: vendors, storeCode: resources.code, storeName: resources.name })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .innerJoin(resources, eq(resources.id, purchaseOrders.storeResourceId))
    .where(eq(purchaseOrders.id, poId));
  if (row === undefined) return undefined;
  const lines = await db.select({ l: purchaseOrderLines, code: items.code, name: items.name, baseUom: items.baseUom })
    .from(purchaseOrderLines).innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
    .where(eq(purchaseOrderLines.purchaseOrderId, poId)).orderBy(asc(items.name), asc(purchaseOrderLines.id));
  const ap = row.po.approvalId === null ? null : await getApproval(db, row.po.approvalId);
  const names = await namesOf(db, [row.po.createdBy, row.po.submittedBy, row.po.approvedBy, row.po.sentBy, row.po.cancelledBy, ap?.decidedBy ?? null]);
  return {
    ...summaryOf(row.po, row.vendor, row.storeCode, lines.length),
    terms: row.po.terms, note: row.po.note, storeName: row.storeName, vendorGstin: row.vendor.gstin,
    cancelReason: row.po.cancelReason, names,
    approval: ap === null ? null : {
      status: ap.status, approverRole: ap.approverRole, requesterId: ap.requesterId, decidedBy: ap.decidedBy, decisionNote: ap.decisionNote,
    },
    lines: lines.map(({ l, code, name, baseUom }) => {
      const orderedBase = l.qtyPacks * l.multiplier;
      return {
        id: l.id, itemId: l.itemId, itemCode: code, itemName: name, baseUom, uom: l.uom, multiplier: l.multiplier,
        qtyPacks: l.qtyPacks, freePacks: l.freePacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps,
        gstPaise: lineGstPaise(l.lineTotalPaise, l.gstRateBps), mrpPaise: l.mrpPaise, lineTotalPaise: l.lineTotalPaise,
        orderedBase, receivedBase: l.receivedBase, freeReceivedBase: l.freeReceivedBase,
        remainingBase: Math.max(0, orderedBase - l.receivedBase),
      };
    }),
  };
}

export async function getPurchaseOrder(db: Db, actor: Actor, poId: string): Promise<PoView> {
  await requireReader(db, actor);
  await settlePurchaseOrders(db, new Date(), [poId]);
  const po = await readPurchaseOrder(db, poId);
  if (po === undefined) throw new MaterialsError("unknown_purchase_order", `purchase order ${poId} not found`);
  return po;
}

export type PoFilter = { statuses?: readonly PoStatus[]; vendorId?: string; storeResourceId?: string; limit?: number };

export async function listPurchaseOrders(db: Db, actor: Actor, filter: PoFilter = {}): Promise<PoSummary[]> {
  await requireReader(db, actor);
  await settlePurchaseOrders(db);
  const where = [
    ...(filter.statuses === undefined || filter.statuses.length === 0 ? [] : [inArray(purchaseOrders.status, [...filter.statuses])]),
    ...(filter.vendorId === undefined ? [] : [eq(purchaseOrders.vendorId, filter.vendorId)]),
    ...(filter.storeResourceId === undefined ? [] : [eq(purchaseOrders.storeResourceId, filter.storeResourceId)]),
  ];
  const rows = await db.select({
    po: purchaseOrders, vendor: vendors, storeCode: resources.code,
    lineCount: sql<string>`(select count(*) from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
  })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .innerJoin(resources, eq(resources.id, purchaseOrders.storeResourceId))
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
    .limit(Math.min(filter.limit ?? 200, 500));
  return rows.map((r) => summaryOf(r.po, r.vendor, r.storeCode, Number(r.lineCount)));
}

/** Pending orders this person may decide: the approvals engine's own worklist, narrowed to the two PO types. */
export async function purchaseOrdersAwaiting(db: Db, actor: Actor): Promise<PoSummary[]> {
  if (actor.type !== "user") return [];
  const mine = [
    ...(await listApprovals(db, actor, { typeKey: PO_APPROVAL_TYPE, limit: 200 })).items,
    ...(await listApprovals(db, actor, { typeKey: PO_OWNER_APPROVAL_TYPE, limit: 200 })).items,
  ].filter((a) => a.requesterId !== actor.id);
  if (mine.length === 0) return [];
  const ids = new Set(mine.map((a) => a.subjectId));
  const pending = await listPurchaseOrders(db, actor, { statuses: ["pending_approval"] });
  return pending.filter((p) => ids.has(p.id) && p.createdBy !== actor.id);
}

/** Open orders past their expected date (IST), soonest-late first. */
export async function overduePurchaseOrders(db: Db, actor: Actor, now: Date = new Date()): Promise<PoSummary[]> {
  await requireReader(db, actor);
  const today = istDayOf(now);
  const late = await db.select({ id: purchaseOrders.id }).from(purchaseOrders)
    .where(and(inArray(purchaseOrders.status, ["approved", "sent", "part_received"]), lt(purchaseOrders.expectedDate, today)));
  if (late.length === 0) return [];
  const ids = new Set(late.map((r) => r.id));
  return (await listPurchaseOrders(db, actor, { statuses: ["approved", "sent", "part_received"] }))
    .filter((p) => ids.has(p.id))
    .sort((a, b) => (a.expectedDate ?? "").localeCompare(b.expectedDate ?? ""));
}

// ═══════════════════════════════════ levels, on order, last purchase ═══════════════════════════════════

export type StockLevel = { minBase: number; reorderBase: number; maxBase: number };

export async function setStockLevel(
  db: Db, actor: Actor, input: { itemId: string; storeResourceId: string } & StockLevel, now: Date = new Date(),
): Promise<StockLevel> {
  await requireRaiser(db, actor, "setting stock levels");
  const { minBase, reorderBase, maxBase } = input;
  const ok = [minBase, reorderBase, maxBase].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000);
  if (!ok || minBase > reorderBase || reorderBase >= maxBase) {
    throw new MaterialsError("invalid_stock_level", "levels must be whole numbers with 0 ≤ min ≤ reorder < max", { minBase, reorderBase, maxBase });
  }
  await withTx(db, async (tx) => {
    const [item] = await tx.select({ id: items.id }).from(items).where(eq(items.id, input.itemId));
    if (item === undefined) throw new MaterialsError("unknown_item", `item ${input.itemId} not found`, { itemId: input.itemId });
    await assertNotMerged(tx, [input.itemId], "setting its levels");
    await requireStore(tx, input.storeResourceId);
    const [prev] = await tx.select().from(itemStockLevels)
      .where(and(eq(itemStockLevels.itemId, input.itemId), eq(itemStockLevels.storeResourceId, input.storeResourceId))).for("update");
    await tx.insert(itemStockLevels).values({
      id: newId(), itemId: input.itemId, storeResourceId: input.storeResourceId, minBase, reorderBase, maxBase, updatedBy: actor.id, updatedAt: now,
    }).onConflictDoUpdate({
      target: [itemStockLevels.itemId, itemStockLevels.storeResourceId],
      set: { minBase, reorderBase, maxBase, updatedBy: actor.id, updatedAt: now },
    });
    await appendEvent(tx, stockLevelSet.make({
      occurredAt: now, actor, correlationId: input.itemId,
      payload: {
        itemId: input.itemId, storeResourceId: input.storeResourceId, minBase, reorderBase, maxBase,
        previous: prev === undefined ? null : { minBase: prev.minBase, reorderBase: prev.reorderBase, maxBase: prev.maxBase },
      },
    }));
  });
  return { minBase, reorderBase, maxBase };
}

export async function stockLevelsAt(db: Db | Tx, storeResourceId: string, itemIds: readonly string[]): Promise<Map<string, StockLevel>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.select().from(itemStockLevels)
    .where(and(eq(itemStockLevels.storeResourceId, storeResourceId), inArray(itemStockLevels.itemId, [...itemIds])));
  return new Map(rows.map((r) => [r.itemId, { minBase: r.minBase, reorderBase: r.reorderBase, maxBase: r.maxBase }]));
}

/**
 * What is coming to a store, per item, in base units: `onOrderBase` still owed on approved, sent and
 * part-received orders; `inDraftBase` on drafts and orders awaiting approval. The reorder list
 * subtracts both, so an order already drafted is not suggested twice.
 */
export async function onOrderAt(
  db: Db | Tx, storeResourceId: string, itemIds: readonly string[],
): Promise<Map<string, { onOrderBase: number; inDraftBase: number }>> {
  const out = new Map<string, { onOrderBase: number; inDraftBase: number }>();
  if (itemIds.length === 0) return out;
  const rows = await db.select({ l: purchaseOrderLines, status: purchaseOrders.status }).from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(and(
      eq(purchaseOrders.storeResourceId, storeResourceId), inArray(purchaseOrders.status, [...OPEN_PO_STATUSES]),
      inArray(purchaseOrderLines.itemId, [...itemIds]),
    ));
  for (const { l, status } of rows) {
    const cur = out.get(l.itemId) ?? { onOrderBase: 0, inDraftBase: 0 };
    const ordered = l.qtyPacks * l.multiplier;
    if (status === "draft" || status === "pending_approval") cur.inDraftBase += ordered;
    else cur.onOrderBase += Math.max(0, ordered - l.receivedBase);
    out.set(l.itemId, cur);
  }
  return out;
}

export type LastPurchase = {
  vendorId: string;
  vendorActive: boolean;
  grnNo: string;
  postedAt: string;
  /** The pack it came in and what one pack cost (the GRN's per-base cost × the pack). */
  uom: string;
  multiplier: number;
  ratePaise: number;
  mrpPaise: number | null;
};

/**
 * Each item's most recent PAID receipt (posted GRN, accepted, not free goods): who supplied it, in
 * what pack, at what rate. The agent's drafts are priced from it and addressed to that vendor.
 */
export async function lastPurchaseByItem(db: Db | Tx, itemIds: readonly string[]): Promise<Map<string, LastPurchase>> {
  const out = new Map<string, LastPurchase>();
  if (itemIds.length === 0) return out;
  // PHARMACY P6 — an item's last purchase may have been booked under a duplicate since merged into it; the
  // pack is read off the receipt's own item (the merge gave the survivor the same packs).
  const { ids: readIds, standsFor } = await withMergedAliases(db, itemIds);
  const rows = await db.select({
    itemId: grnLines.itemId, uom: grnLines.uom, unitCost: grnLines.unitCostPaise, mrp: grnLines.mrpPaise, mrpUom: grnLines.mrpUom,
    vendorId: grns.vendorId, vendorStatus: vendors.status, grnNo: grns.grnNo, postedAt: grns.postedAt,
  })
    .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(vendors, eq(vendors.id, grns.vendorId))
    .where(and(
      inArray(grnLines.itemId, readIds), eq(grns.status, "posted"), eq(grnLines.freeGoods, false), sql`${grnLines.qtyAcceptedBase} > 0`,
    ))
    .orderBy(desc(grns.postedAt), desc(grns.grnNo));
  const packs = await db.select().from(itemUoms).where(inArray(itemUoms.itemId, readIds));
  for (const r of rows) {
    const key = standsFor.get(r.itemId) ?? r.itemId;
    if (out.has(key)) continue;
    const mine = packs.filter((p) => p.itemId === r.itemId);
    const pack = mine.find((p) => p.uom.toLowerCase() === r.uom.toLowerCase()) ?? mine.find((p) => p.toBaseMultiplier === 1);
    const multiplier = pack?.toBaseMultiplier ?? 1;
    let mrpPaise: number | null = null;
    if (r.mrp !== null && r.mrpUom !== null) {
      const mrpPack = mine.find((p) => p.uom.toLowerCase() === r.mrpUom!.toLowerCase());
      if (mrpPack !== undefined && (r.mrp * multiplier) % mrpPack.toBaseMultiplier === 0) mrpPaise = (r.mrp * multiplier) / mrpPack.toBaseMultiplier;
    }
    out.set(key, {
      vendorId: r.vendorId, vendorActive: r.vendorStatus === "active", grnNo: r.grnNo, postedAt: r.postedAt?.toISOString() ?? "",
      uom: pack?.uom ?? r.uom, multiplier, ratePaise: r.unitCost * multiplier, mrpPaise,
    });
  }
  return out;
}

/** Active vendors as a picker needs them — for assigning an item with no history. Never the bank. */
export async function purchasableVendors(db: Db, actor: Actor): Promise<{ id: string; code: string; name: string }[]> {
  await requireRaiser(db, actor, "choosing a vendor");
  const rows = await db.select({ id: vendors.id, code: vendors.code, legal: vendors.legalName, trade: vendors.tradeName })
    .from(vendors).where(eq(vendors.status, "active")).orderBy(asc(vendors.legalName)).limit(500);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.trade ?? r.legal }));
}
