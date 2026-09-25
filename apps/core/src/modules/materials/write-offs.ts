import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  approvals, items, resources, stockBalances, stockBatches, stockWriteOffLines, stockWriteOffs, users, vendors,
} from "../../kernel/db/schema";
import { STOCK_ADJUSTMENT_APPROVAL_TYPE } from "./approval-types";
import { TRANSIT_STORE_CODE } from "./config";
import { MaterialsError } from "./errors";
import { stockWriteOffPosted, stockWriteOffRefused, stockWriteOffRequested } from "./events";
import { istDay } from "./grn";
import { postMovements } from "./ledger";
import { committedByPair, exitAvailable } from "./supplier-returns";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P4 — DESTRUCTION: THE WRITE-OFF AND ITS BMW MANIFEST ═══
 *
 * Expired medicine that cannot go back to its supplier (past the return window, or the hospital's own
 * opening stock) is destroyed under the Bio-Medical Waste Management Rules 2016 — yellow category
 * (d), discarded medicines, handed to the common treatment facility against a manifest.
 *
 *   raise (`materials.writeoffs.manage`: the materials head, the pharmacist in charge)
 *     ─ approval `materials_stock_adjustment` (the medical superintendent — the SAME route a count's
 *       variance takes; DEFAULT, owner may change) ─granted→ post: one `adjust` row out per line,
 *       with the disposal agency, its manifest / challan number and the handover date
 *                                                   ─rejected→ refused, nothing moved
 *
 * - **What may be written off**: `expiry` — a batch past its printed expiry; `recall` — a recalled
 *   batch (through the ledger's `recallExit`, its only way out); `damage` — any batch a person says
 *   is damaged. Never more than the store holds less what is reserved, less frozen unless recalled,
 *   less what a live return or another write-off already holds.
 * - **Value** is the quantity at the batch's landed cost, for the approver and the accounts.
 * - **Nothing is destroyed before the approval is granted.** A rejected approval marks the
 *   write-off refused the next time anything reads or acts on it (`settleWriteOffs`).
 */

const WRITEOFFS_MANAGE = "materials.writeoffs.manage";
const WRITEOFF_READERS = [WRITEOFFS_MANAGE, "materials.stock.read", "approvals.requests.decide"];

export type WriteOffReason = "expiry" | "damage" | "recall";
export const WRITE_OFF_REASONS: readonly WriteOffReason[] = ["expiry", "damage", "recall"];
export type WriteOffStatus = "requested" | "posted" | "refused";
export type WriteOffLineInput = { batchId: string; qtyBase: number };
export type DisposalInput = { disposalAgency?: string | null; manifestNo?: string | null; disposalDate?: string | null };

const MAX_LINES = 300;
const MAX_TEXT = 200;

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${perm}`);
  }
}

async function requireReader(db: Db, actor: Actor): Promise<void> {
  if (actor.type === "user") {
    for (const p of WRITEOFF_READERS) if (await hasPermission(db, actor.id, p, "hospital")) return;
  }
  throw new MaterialsError("permission_denied", `reading write-offs needs one of ${WRITEOFF_READERS.join(", ")}`);
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  return t === "" ? null : t.slice(0, MAX_TEXT);
}

/** The disposal details, checked: text within bounds and a handover date on or before today. */
function disposalOf(input: DisposalInput | undefined, today: string): { disposalAgency: string | null; manifestNo: string | null; disposalDate: string | null } {
  const disposalDate = input?.disposalDate ?? null;
  if (disposalDate !== null && (!isIsoDate(disposalDate) || disposalDate > today)) {
    throw new MaterialsError("writeoff_invalid", `"${disposalDate}" is not a handover date on or before today`);
  }
  return { disposalAgency: clean(input?.disposalAgency), manifestNo: clean(input?.manifestNo), disposalDate };
}

// ═══════════════════════════════════ raise ═══════════════════════════════════

export async function raiseWriteOff(
  db: Db, actor: Actor,
  input: { storeResourceId: string; reason: WriteOffReason; lines: WriteOffLineInput[]; note?: string | null; disposal?: DisposalInput },
  now: Date = new Date(),
): Promise<WriteOffView> {
  await requirePerm(db, actor, WRITEOFFS_MANAGE, "raising a destruction write-off");
  const today = istDay(now);
  if (!WRITE_OFF_REASONS.includes(input.reason)) throw new MaterialsError("writeoff_invalid", `"${String(input.reason)}" is not a write-off reason`);
  if (input.lines.length === 0) throw new MaterialsError("writeoff_invalid", "a write-off carries at least one batch");
  if (input.lines.length > MAX_LINES) throw new MaterialsError("writeoff_invalid", `a write-off carries at most ${String(MAX_LINES)} batches`);
  const batchIds = input.lines.map((l) => l.batchId);
  if (new Set(batchIds).size !== batchIds.length) throw new MaterialsError("writeoff_invalid", "a batch appears twice on the write-off");
  const disposal = disposalOf(input.disposal, today);
  const [store] = await db.select().from(resources).where(eq(resources.id, input.storeResourceId));
  if (store === undefined || store.kind !== "store") throw new MaterialsError("unknown_store", `resource ${input.storeResourceId} is not a store`);
  if (store.code.toLowerCase() === TRANSIT_STORE_CODE.toLowerCase()) throw new MaterialsError("writeoff_invalid", "stock in transit is received first, then written off");
  const id = await withTx(db, async (tx) => {
    const batches = await tx.select().from(stockBatches).where(inArray(stockBatches.id, batchIds));
    const bals = await tx.select().from(stockBalances).where(and(eq(stockBalances.resourceId, store.id), inArray(stockBalances.batchId, batchIds)));
    const committed = await committedByPair(tx, batchIds);
    const lines = input.lines.map((l) => {
      const b = batches.find((x) => x.id === l.batchId);
      if (b === undefined) throw new MaterialsError("unknown_batch", `batch ${l.batchId} not found`);
      const recalled = b.recallStatus === "frozen";
      if (input.reason === "expiry" && (b.expiryDate === null || b.expiryDate >= today)) {
        throw new MaterialsError("writeoff_invalid", `batch ${b.batchNo} has not expired (expiry ${b.expiryDate ?? "none"}); an expiry write-off destroys expired stock only`, { batchNo: b.batchNo });
      }
      if (input.reason === "recall" && !recalled) throw new MaterialsError("writeoff_invalid", `batch ${b.batchNo} is not recalled`, { batchNo: b.batchNo });
      if (!Number.isSafeInteger(l.qtyBase) || l.qtyBase <= 0) throw new MaterialsError("writeoff_invalid", "a line writes off a whole number of base units, at least one");
      const bal = bals.find((x) => x.batchId === b.id);
      const held = committed.get(`${store.id}|${b.id}`) ?? 0;
      const can = (bal === undefined ? 0 : exitAvailable(bal, recalled)) - held;
      if (l.qtyBase > can) {
        throw new MaterialsError("insufficient_stock", `${store.name} can write off ${String(Math.max(0, can))} of batch ${b.batchNo}; the line asks ${String(l.qtyBase)}`, {
          batchNo: b.batchNo, onHand: bal?.qtyOnHand ?? 0, reserved: bal?.qtyReserved ?? 0, frozen: bal?.qtyFrozen ?? 0,
          onOtherDocuments: held, available: Math.max(0, can), required: l.qtyBase,
        });
      }
      return { id: newId(), itemId: b.itemId, batchId: b.id, qtyBase: l.qtyBase, valuePaise: l.qtyBase * b.landedCostPaise };
    });
    const writeOffId = newId();
    const writeOffNo = await nextEpisodeNo(tx, "stock_write_off", today);
    const total = lines.reduce((s, l) => s + l.valuePaise, 0);
    const note = clean(input.note);
    const { approvalId } = await requestApproval(tx, actor, {
      typeKey: STOCK_ADJUSTMENT_APPROVAL_TYPE,
      subject: { type: "stock_write_off", id: writeOffId },
      requestNote: `${writeOffNo} · destruction (${input.reason}, BMW yellow (d)) at ${store.name} · ${String(lines.length)} batch(es) · ₹${(total / 100).toFixed(2)}${note === null ? "" : ` — ${note}`}`,
    });
    await tx.insert(stockWriteOffs).values({
      id: writeOffId, writeOffNo, storeResourceId: store.id, reason: input.reason, status: "requested", totalValuePaise: total, approvalId,
      ...disposal, note, requestedBy: actor.id, requestedAt: now,
    });
    await tx.insert(stockWriteOffLines).values(lines.map((l) => ({ ...l, writeOffId })));
    await appendEvent(tx, stockWriteOffRequested.make({
      occurredAt: now, actor, correlationId: writeOffId,
      payload: { writeOffId, writeOffNo, storeResourceId: store.id, totalValuePaise: total, reason: input.reason, approvalId, lines: lines.length },
    }));
    return writeOffId;
  });
  return (await readWriteOff(db, id))!;
}

// ═══════════════════════════════════ settle, post ═══════════════════════════════════

/** Requested write-offs whose approval was REJECTED become refused (idempotent; conditional updates). */
export async function settleWriteOffs(db: Db, now: Date = new Date(), ids?: readonly string[]): Promise<number> {
  const rejected = await db.select({ w: stockWriteOffs, ap: approvals }).from(stockWriteOffs)
    .innerJoin(approvals, eq(approvals.id, stockWriteOffs.approvalId))
    .where(and(eq(stockWriteOffs.status, "requested"), eq(approvals.status, "rejected"), ...(ids === undefined ? [] : [inArray(stockWriteOffs.id, [...ids])])));
  let moved = 0;
  for (const { w, ap } of rejected) {
    await withTx(db, async (tx) => {
      const won = await tx.update(stockWriteOffs).set({ status: "refused", refusedAt: ap.decidedAt ?? now })
        .where(and(eq(stockWriteOffs.id, w.id), eq(stockWriteOffs.status, "requested"))).returning({ id: stockWriteOffs.id });
      if (won.length === 0) return;
      await appendEvent(tx, stockWriteOffRefused.make({
        occurredAt: now, actor: { type: "user", id: ap.decidedBy ?? "unknown" }, correlationId: w.id,
        payload: { writeOffId: w.id, writeOffNo: w.writeOffNo, storeResourceId: w.storeResourceId, totalValuePaise: w.totalValuePaise, approvalId: ap.id },
      }));
      moved += 1;
    });
  }
  return moved;
}

/**
 * The stock handed to the disposal agency: once the approval is GRANTED, and with the agency, its
 * manifest / challan number and the handover date (given now, or when raised). One `adjust` row out
 * per line. A rejected approval settles the write-off as refused instead; a pending one refuses.
 */
export async function postWriteOff(db: Db, actor: Actor, writeOffId: string, disposal: DisposalInput = {}, now: Date = new Date()): Promise<WriteOffView> {
  await requirePerm(db, actor, WRITEOFFS_MANAGE, "posting a destruction write-off");
  await settleWriteOffs(db, now, [writeOffId]);
  const [w] = await db.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, writeOffId));
  if (w === undefined) throw new MaterialsError("unknown_write_off", `write-off ${writeOffId} not found`);
  if (w.status !== "requested") throw new MaterialsError("writeoff_wrong_status", `write-off ${w.writeOffNo} is ${w.status}; only a requested one is posted`, { status: w.status });
  const approval = await getApproval(db, w.approvalId);
  if (approval?.status !== "granted") {
    throw new MaterialsError("writeoff_unapproved", `write-off ${w.writeOffNo}'s approval is ${approval?.status ?? "missing"}: nothing is destroyed before the medical superintendent grants it`, {
      approvalStatus: approval?.status ?? null,
    });
  }
  const today = istDay(now);
  const given = disposalOf(disposal, today);
  const agency = given.disposalAgency ?? w.disposalAgency;
  const manifestNo = given.manifestNo ?? w.manifestNo;
  const disposalDate = given.disposalDate ?? w.disposalDate;
  if (agency === null || manifestNo === null || disposalDate === null) {
    throw new MaterialsError("disposal_required", "posting a destruction needs the disposal agency, its manifest or challan number, and the handover date");
  }
  await withTx(db, async (tx) => {
    const [locked] = await tx.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, writeOffId)).for("update");
    if (locked?.status !== "requested") throw new MaterialsError("writeoff_wrong_status", `write-off ${w.writeOffNo} is ${locked?.status ?? "missing"}`, { status: locked?.status ?? null });
    const lines = await tx.select().from(stockWriteOffLines).where(eq(stockWriteOffLines.writeOffId, writeOffId)).orderBy(asc(stockWriteOffLines.id));
    const moved = await postMovements(tx, actor, lines.map((l) => ({
      resourceId: w.storeResourceId, batchId: l.batchId, qtyDelta: -l.qtyBase, reason: "adjust" as const,
      refType: "stock_write_off", refId: l.id, occurredAt: now, recallExit: true,
    })));
    for (const [i, l] of lines.entries()) {
      await tx.update(stockWriteOffLines).set({ ledgerEntryId: moved[i]!.ledgerEntryId }).where(eq(stockWriteOffLines.id, l.id));
    }
    await tx.update(stockWriteOffs).set({ status: "posted", postedBy: actor.id, postedAt: now, disposalAgency: agency, manifestNo, disposalDate })
      .where(eq(stockWriteOffs.id, writeOffId));
    await appendEvent(tx, stockWriteOffPosted.make({
      occurredAt: now, actor, correlationId: writeOffId,
      payload: {
        writeOffId, writeOffNo: w.writeOffNo, storeResourceId: w.storeResourceId, totalValuePaise: w.totalValuePaise, approvalId: w.approvalId,
        postedBy: actor.id, disposalAgency: agency, manifestNo, disposalDate,
        lines: lines.map((l, i) => ({ lineId: l.id, itemId: l.itemId, batchId: l.batchId, qtyBase: l.qtyBase, valuePaise: l.valuePaise, ledgerEntryId: moved[i]!.ledgerEntryId })),
      },
    }));
  });
  return (await readWriteOff(db, writeOffId))!;
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

export type WriteOffSummary = {
  id: string; writeOffNo: string; status: WriteOffStatus; reason: WriteOffReason; storeResourceId: string; storeCode: string; storeName: string;
  totalValuePaise: number; lineCount: number; approvalId: string; approvalStatus: string;
  disposalAgency: string | null; manifestNo: string | null; disposalDate: string | null;
  requestedBy: string; requestedAt: string; postedBy: string | null; postedAt: string | null;
};

export type WriteOffLineView = {
  id: string; itemId: string; itemCode: string; itemName: string; hsnCode: string | null; baseUom: string; batchId: string; batchNo: string;
  expiryDate: string | null; supplierName: string | null; qtyBase: number; valuePaise: number; ledgerEntryId: string | null;
};

export type WriteOffView = WriteOffSummary & {
  note: string | null; names: Record<string, string>; lines: WriteOffLineView[];
  approval: { status: string; approverRole: string; decidedBy: string | null; decisionNote: string | null } | null;
};

async function namesOf(db: Db, ids: readonly (string | null)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return Object.fromEntries(rows.map((r) => [r.id, r.fullName]));
}

type WriteOffRow = typeof stockWriteOffs.$inferSelect;

function summaryOf(w: WriteOffRow, store: { code: string; name: string }, lineCount: number, approvalStatus: string): WriteOffSummary {
  return {
    id: w.id, writeOffNo: w.writeOffNo, status: w.status as WriteOffStatus, reason: w.reason as WriteOffReason, storeResourceId: w.storeResourceId,
    storeCode: store.code, storeName: store.name, totalValuePaise: w.totalValuePaise, lineCount, approvalId: w.approvalId, approvalStatus,
    disposalAgency: w.disposalAgency, manifestNo: w.manifestNo, disposalDate: w.disposalDate,
    requestedBy: w.requestedBy, requestedAt: w.requestedAt.toISOString(), postedBy: w.postedBy, postedAt: w.postedAt?.toISOString() ?? null,
  };
}

async function readWriteOff(db: Db, writeOffId: string): Promise<WriteOffView | undefined> {
  const [row] = await db.select({ w: stockWriteOffs, code: resources.code, name: resources.name }).from(stockWriteOffs)
    .innerJoin(resources, eq(resources.id, stockWriteOffs.storeResourceId)).where(eq(stockWriteOffs.id, writeOffId));
  if (row === undefined) return undefined;
  const lines = await db.select({
    l: stockWriteOffLines, code: items.code, name: items.name, hsn: items.hsnCode, baseUom: items.baseUom, batchNo: stockBatches.batchNo,
    expiry: stockBatches.expiryDate, vendorName: vendors.tradeName, vendorLegal: vendors.legalName,
  }).from(stockWriteOffLines)
    .innerJoin(items, eq(items.id, stockWriteOffLines.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockWriteOffLines.batchId))
    .leftJoin(vendors, eq(vendors.id, stockBatches.vendorId))
    .where(eq(stockWriteOffLines.writeOffId, writeOffId)).orderBy(asc(items.name), asc(stockBatches.batchNo));
  const ap = await getApproval(db, row.w.approvalId);
  const names = await namesOf(db, [row.w.requestedBy, row.w.postedBy, ap?.decidedBy ?? null]);
  return {
    ...summaryOf(row.w, row, lines.length, ap?.status ?? "missing"), note: row.w.note, names,
    lines: lines.map((x) => ({
      id: x.l.id, itemId: x.l.itemId, itemCode: x.code, itemName: x.name, hsnCode: x.hsn, baseUom: x.baseUom, batchId: x.l.batchId, batchNo: x.batchNo,
      expiryDate: x.expiry, supplierName: x.vendorName ?? x.vendorLegal, qtyBase: x.l.qtyBase, valuePaise: x.l.valuePaise, ledgerEntryId: x.l.ledgerEntryId,
    })),
    approval: ap === null ? null : { status: ap.status, approverRole: ap.approverRole, decidedBy: ap.decidedBy, decisionNote: ap.decisionNote },
  };
}

export async function getWriteOff(db: Db, actor: Actor, writeOffId: string, now: Date = new Date()): Promise<WriteOffView> {
  await requireReader(db, actor);
  await settleWriteOffs(db, now, [writeOffId]);
  const w = await readWriteOff(db, writeOffId);
  if (w === undefined) throw new MaterialsError("unknown_write_off", `write-off ${writeOffId} not found`);
  return w;
}

export async function listWriteOffs(db: Db, actor: Actor, filter: { statuses?: readonly WriteOffStatus[]; limit?: number } = {}): Promise<WriteOffSummary[]> {
  await requireReader(db, actor);
  await settleWriteOffs(db);
  const rows = await db.select({ w: stockWriteOffs, code: resources.code, name: resources.name, apStatus: approvals.status }).from(stockWriteOffs)
    .innerJoin(resources, eq(resources.id, stockWriteOffs.storeResourceId))
    .leftJoin(approvals, eq(approvals.id, stockWriteOffs.approvalId))
    .where(filter.statuses === undefined || filter.statuses.length === 0 ? undefined : inArray(stockWriteOffs.status, [...filter.statuses]))
    .orderBy(desc(stockWriteOffs.requestedAt), desc(stockWriteOffs.id)).limit(Math.min(filter.limit ?? 200, 1000));
  const counts = rows.length === 0 ? [] : await db.select({ id: stockWriteOffLines.writeOffId }).from(stockWriteOffLines)
    .where(inArray(stockWriteOffLines.writeOffId, rows.map((r) => r.w.id)));
  return rows.map((r) => summaryOf(r.w, r, counts.filter((c) => c.id === r.w.id).length, r.apStatus ?? "missing"));
}

/** Write-offs whose approval is still pending (the office's "awaiting the superintendent" card). */
export async function writeOffsAwaitingApproval(db: Db, actor: Actor): Promise<WriteOffSummary[]> {
  return (await listWriteOffs(db, actor, { statuses: ["requested"] })).filter((w) => w.approvalStatus === "pending");
}

/** Requested write-offs whose approval is granted: ready to hand over and post. */
export async function writeOffsReadyToPost(db: Db, actor: Actor): Promise<WriteOffSummary[]> {
  return (await listWriteOffs(db, actor, { statuses: ["requested"] })).filter((w) => w.approvalStatus === "granted");
}
