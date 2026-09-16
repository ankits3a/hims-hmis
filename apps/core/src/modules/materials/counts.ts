import { randomInt } from "node:crypto";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  items, rolePermissions, stockBalances, stockBatches, stockCountLines, stockCounts, stockLedger, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import {
  COUNT_CUSTODY_DAYS, COUNT_EMPTY_LOOKBACK_DAYS, COUNT_RECOUNT_FRACTION_BPS, COUNT_RECOUNT_PAISE, TRANSIT_STORE_CODE,
} from "./config";
import { MaterialsError } from "./errors";
import { stockCountCancelled, stockCountClosed, stockCountScheduled, stockCounted, stockVarianceFlagged } from "./events";
import { requireStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PLAN 14c, FIRST SLICE — BLIND STOCK COUNTS AND THE VARIANCE REGISTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-materials-counts.md`; doc 09 §3.9.
 *
 *   scheduleCount ─(system picks a counter)→ counting ─submitCount→ submitted ─closeCount→ closed
 *                                               └─cancelCount→ cancelled
 *
 * ═══ WHO COUNTS ═══
 *
 * The system chooses, at random, among active holders of `materials.counts.perform` at hospital
 * scope, leaving out:
 *   - the person scheduling the count (the table's CHECK says so too);
 *   - the store's custodians. There is no custody master, so custody is read off the ledger:
 *     whoever posted a movement at the store in the last COUNT_CUSTODY_DAYS keeps it (S10).
 * A recount prefers someone other than the first counter, and falls back to them.
 *
 * ═══ WHAT IS COMPARED WITH WHAT ═══
 *
 * Scheduling freezes each batch's `qty_on_hand`. That is the PHYSICAL figure: reserved strips are
 * still on the shelf. The counter never sees it. At submission:
 *   expected = frozen + the ledger's net movement at that store and batch in [frozenAt, countedAt)
 *   variance = counted − expected, and variance_paise = variance × landed cost per base unit.
 * So a sale during the count is the ledger's, not the counter's. A line more than 10% or ₹2,000 out
 * is counted again blind by the automatic recount, and stock found where the books have none weighs
 * the same as stock missing.
 *
 * ═══ WHAT IS NOT HERE ═══
 *
 * No adjustment. The ledger is never written from a count. Writing a variance off (or on) needs a
 * second key, and runbook O1 is open. The variance is visible and nothing hides it, as with Plan 14's
 * transfer discrepancies.
 */
const COUNTS_MANAGE = "materials.counts.manage";
const COUNTS_PERFORM = "materials.counts.perform";
const DAY_MS = 24 * 60 * 60 * 1000;

export type CountStatus = "counting" | "submitted" | "closed" | "cancelled";
export type CountFlag = "match" | "variance" | "recount";

export type CountHeader = {
  id: string;
  storeResourceId: string;
  storeCode: string;
  storeName: string;
  status: CountStatus;
  scheduledBy: string;
  counterUserId: string;
  counterName: string;
  recountOf: string | null;
  recountId: string | null;
  frozenAt: string;
  countedAt: string | null;
  submittedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeNote: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
};

export type CountReviewLine = {
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUom: string;
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  systemQty: number;
  countedQty: number | null;
  movedQty: number | null;
  varianceQty: number | null;
  variancePaise: number | null;
  flag: CountFlag | null;
};

export type CountReview = CountHeader & {
  lines: CountReviewLine[];
  totals: { lines: number; matched: number; variances: number; recounts: number; netVariancePaise: number };
};

/** What the counter reads: the shelf, never the books. */
export type CountSheetLine = { lineId: string; itemCode: string; itemName: string; baseUom: string; batchNo: string; expiryDate: string | null };
export type CountSheet = { id: string; storeCode: string; storeName: string; frozenAt: string; lines: CountSheetLine[] };

export type SubmitCountInput = { countedAt: string; lines: { lineId: string; countedQty: number }[] };

async function requireGrant(db: Db | Tx, actor: Actor, permission: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, permission, "hospital"))) {
    throw new MaterialsError("permission_denied", `${what} needs ${permission}`);
  }
}

type CountRow = typeof stockCounts.$inferSelect;

async function requireCount(db: Db | Tx, countId: string): Promise<CountRow> {
  const [row] = await db.select().from(stockCounts).where(eq(stockCounts.id, countId));
  if (row === undefined) throw new MaterialsError("unknown_count", `count ${countId} not found`);
  return row;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

async function headerOf(db: Db | Tx, row: CountRow): Promise<CountHeader> {
  const store = await requireStore(db, row.resourceId);
  const [counter] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, row.counterUserId));
  return {
    id: row.id, storeResourceId: row.resourceId, storeCode: store.code, storeName: store.name,
    status: row.status as CountStatus, scheduledBy: row.scheduledBy, counterUserId: row.counterUserId,
    counterName: counter?.fullName ?? row.counterUserId, recountOf: row.recountOf, recountId: row.recountId,
    frozenAt: row.frozenAt.toISOString(), countedAt: iso(row.countedAt), submittedAt: iso(row.submittedAt),
    closedBy: row.closedBy, closedAt: iso(row.closedAt), closeNote: row.closeNote,
    cancelledBy: row.cancelledBy, cancelledAt: iso(row.cancelledAt), cancelReason: row.cancelReason,
  };
}

async function linesOf(db: Db | Tx, countId: string) {
  return db.select({
    line: stockCountLines,
    itemCode: items.code, itemName: items.name, baseUom: items.baseUom,
    batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, landedCostPaise: stockBatches.landedCostPaise,
  })
    .from(stockCountLines)
    .innerJoin(items, eq(items.id, stockCountLines.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
    .where(eq(stockCountLines.countId, countId))
    .orderBy(asc(items.name), sql`${stockBatches.expiryDate} asc nulls last`, asc(stockBatches.batchNo));
}

/** Active hospital-scope holders of the perform grant, less `exclude` and the store's custodians. */
async function eligibleCounters(db: Db | Tx, resourceId: string, exclude: ReadonlySet<string>, now: Date): Promise<string[]> {
  const roles = await db.select({ roleKey: rolePermissions.roleKey }).from(rolePermissions)
    .where(eq(rolePermissions.permission, COUNTS_PERFORM));
  const holders = new Set<string>();
  for (const r of roles) {
    for (const userId of await usersHoldingRoleAtScope(db as Tx, r.roleKey, "hospital")) holders.add(userId);
  }
  if (holders.size === 0) return [];
  const since = new Date(now.getTime() - COUNT_CUSTODY_DAYS * DAY_MS);
  const keepers = await db.selectDistinct({ actorId: stockLedger.actorId }).from(stockLedger).where(and(
    eq(stockLedger.resourceId, resourceId),
    sql`greatest(${stockLedger.occurredAt}, ${stockLedger.recordedAt}) >= ${since}`,
  ));
  const custodians = new Set(keepers.map((k) => k.actorId));
  const active = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.id, [...holders]), eq(users.active, true)));
  return active.map((u) => u.id).filter((id) => !exclude.has(id) && !custodians.has(id)).sort();
}

/**
 * Opens a count in `tx`: freezes the store's batches (or only `batchIds`, for a recount) and
 * assigns a counter. `avoid` is preferred against, never required.
 */
async function openCount(
  tx: Tx, actor: Actor, input: { resourceId: string; scheduledBy: string; recountOf: string | null; batchIds?: readonly string[]; avoid?: string },
  now: Date,
): Promise<CountRow> {
  const eligible = await eligibleCounters(tx, input.resourceId, new Set([input.scheduledBy]), now);
  const preferred = eligible.filter((id) => id !== input.avoid);
  const pool = preferred.length > 0 ? preferred : eligible;
  if (pool.length === 0) {
    throw new MaterialsError("no_eligible_counter", "nobody holding materials.counts.perform is free of this store's stock and of scheduling the count");
  }
  const counterUserId = pool[randomInt(pool.length)]!;

  const lookback = new Date(now.getTime() - COUNT_EMPTY_LOOKBACK_DAYS * DAY_MS);
  const frozen = await tx.select({ batchId: stockBalances.batchId, itemId: stockBalances.itemId, onHand: stockBalances.qtyOnHand })
    .from(stockBalances)
    .where(and(
      eq(stockBalances.resourceId, input.resourceId),
      ...(input.batchIds === undefined ? [] : [inArray(stockBalances.batchId, [...input.batchIds])]),
      sql`(${stockBalances.qtyOnHand} > 0 or exists (
        select 1 from ${stockLedger}
        where ${stockLedger.resourceId} = ${stockBalances.resourceId} and ${stockLedger.batchId} = ${stockBalances.batchId}
          and greatest(${stockLedger.occurredAt}, ${stockLedger.recordedAt}) >= ${lookback}))`,
    ));

  const id = newId();
  try {
    await tx.insert(stockCounts).values({
      id, resourceId: input.resourceId, status: "counting", scheduledBy: input.scheduledBy, counterUserId,
      recountOf: input.recountOf, frozenAt: now,
    });
  } catch (e) {
    const pg = e as { code?: string; cause?: { code?: string } };
    if (pg.code === "23505" || pg.cause?.code === "23505") {
      throw new MaterialsError("count_already_open", "this store is already being counted");
    }
    throw e;
  }
  if (frozen.length > 0) {
    await tx.insert(stockCountLines).values(frozen.map((f) => ({
      id: newId(), countId: id, batchId: f.batchId, itemId: f.itemId, systemQty: f.onHand,
    })));
  }
  await appendEvent(tx, stockCountScheduled.make({
    occurredAt: now, actor,
    payload: {
      countId: id, storeResourceId: input.resourceId, scheduledBy: input.scheduledBy, counterUserId,
      lines: frozen.length, frozenAt: now.toISOString(), recountOf: input.recountOf,
    },
  }));
  return requireCount(tx, id);
}

export async function scheduleCount(db: Db, actor: Actor, input: { storeResourceId: string }, now: Date): Promise<CountHeader> {
  await requireGrant(db, actor, COUNTS_MANAGE, "scheduling a count");
  const store = await requireStore(db, input.storeResourceId);
  if (store.code.toLowerCase() === TRANSIT_STORE_CODE.toLowerCase() || store.status === "retired") {
    throw new MaterialsError("not_countable", `${store.code} is not a shelf anyone can count`);
  }
  const open = await db.select({ id: stockCounts.id }).from(stockCounts)
    .where(and(eq(stockCounts.resourceId, store.id), eq(stockCounts.status, "counting")));
  if (open.length > 0) throw new MaterialsError("count_already_open", `${store.code} is already being counted`, { countId: open[0]!.id });
  const row = await withTx(db, (tx) => openCount(tx, actor, { resourceId: store.id, scheduledBy: actor.id, recountOf: null }, now));
  return headerOf(db, row);
}

export async function countSheet(db: Db, actor: Actor, countId: string): Promise<CountSheet> {
  const row = await requireCount(db, countId);
  if (row.status !== "counting") throw new MaterialsError("count_not_open", `count ${countId} is ${row.status}`);
  if (actor.id !== row.counterUserId) throw new MaterialsError("count_not_assigned", "this sheet belongs to the counter the system assigned");
  const header = await headerOf(db, row);
  const lines = await linesOf(db, countId);
  return {
    id: row.id, storeCode: header.storeCode, storeName: header.storeName, frozenAt: header.frozenAt,
    lines: lines.map((l) => ({
      lineId: l.line.id, itemCode: l.itemCode, itemName: l.itemName, baseUom: l.baseUom, batchNo: l.batchNo, expiryDate: l.expiryDate,
    })),
  };
}

function flagFor(varianceQty: number, expected: number, variancePaise: number): CountFlag {
  if (varianceQty === 0) return "match";
  const overFraction = Math.abs(varianceQty) * 10_000 > COUNT_RECOUNT_FRACTION_BPS * Math.max(expected, 1);
  return overFraction || Math.abs(variancePaise) > COUNT_RECOUNT_PAISE ? "recount" : "variance";
}

export async function submitCount(db: Db, actor: Actor, countId: string, input: SubmitCountInput, now: Date): Promise<CountHeader> {
  const row = await requireCount(db, countId);
  if (row.status !== "counting") throw new MaterialsError("count_not_open", `count ${countId} is ${row.status}`);
  if (actor.id !== row.counterUserId) throw new MaterialsError("count_not_assigned", "this sheet belongs to the counter the system assigned");
  const countedAt = new Date(input.countedAt);
  if (Number.isNaN(countedAt.getTime()) || countedAt < row.frozenAt || countedAt > now) {
    throw new MaterialsError("invalid_count_time", "the sheet's time must fall between the freeze and now", { frozenAt: row.frozenAt });
  }
  const lines = await linesOf(db, countId);
  const given = new Map<string, number>();
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.countedQty) || l.countedQty < 0) {
      throw new MaterialsError("invalid_count_qty", "a count is a whole number, zero or more", { lineId: l.lineId });
    }
    given.set(l.lineId, l.countedQty);
  }
  const known = new Set(lines.map((l) => l.line.id));
  if (given.size !== input.lines.length || given.size !== known.size || [...given.keys()].some((k) => !known.has(k))) {
    throw new MaterialsError("count_incomplete", "every line on the sheet needs its count, once", { expected: known.size, given: input.lines.length });
  }

  const batchIds = lines.map((l) => l.line.batchId);
  const moves = batchIds.length === 0 ? [] : await db.select({
    batchId: stockLedger.batchId, moved: sql<string>`coalesce(sum(${stockLedger.qtyDelta}), 0)`,
  }).from(stockLedger).where(and(
    eq(stockLedger.resourceId, row.resourceId),
    inArray(stockLedger.batchId, batchIds),
    gte(stockLedger.occurredAt, row.frozenAt),
    lt(stockLedger.occurredAt, countedAt),
  )).groupBy(stockLedger.batchId);
  const movedBy = new Map(moves.map((m) => [m.batchId, Number(m.moved)] as const));

  const settled = lines.map((l) => {
    const countedQty = given.get(l.line.id)!;
    const movedQty = movedBy.get(l.line.batchId) ?? 0;
    const expected = l.line.systemQty + movedQty;
    const varianceQty = countedQty - expected;
    const variancePaise = varianceQty * l.landedCostPaise;
    return { l, countedQty, movedQty, varianceQty, variancePaise, flag: flagFor(varianceQty, expected, variancePaise) };
  });

  const result = await withTx(db, async (tx) => {
    const won = await tx.update(stockCounts)
      .set({ status: "submitted", countedAt, submittedAt: now })
      .where(and(eq(stockCounts.id, countId), eq(stockCounts.status, "counting")))
      .returning({ id: stockCounts.id });
    if (won.length === 0) throw new MaterialsError("count_not_open", `count ${countId} moved while it was being submitted`);
    for (const s of settled) {
      await tx.update(stockCountLines).set({
        countedQty: s.countedQty, movedQty: s.movedQty, varianceQty: s.varianceQty, variancePaise: s.variancePaise, flag: s.flag,
      }).where(eq(stockCountLines.id, s.l.line.id));
    }
    const recountBatches = settled.filter((s) => s.flag === "recount").map((s) => s.l.line.batchId);
    let recountId: string | null = null;
    if (recountBatches.length > 0) {
      const recount = await openCount(tx, actor, {
        resourceId: row.resourceId, scheduledBy: row.scheduledBy, recountOf: row.id, batchIds: recountBatches, avoid: row.counterUserId,
      }, now);
      recountId = recount.id;
      await tx.update(stockCounts).set({ recountId }).where(eq(stockCounts.id, countId));
    }
    for (const s of settled) {
      if (s.varianceQty === 0) continue;
      await appendEvent(tx, stockVarianceFlagged.make({
        occurredAt: now, actor,
        payload: {
          countId, storeResourceId: row.resourceId, batchId: s.l.line.batchId, itemId: s.l.line.itemId,
          systemQty: s.l.line.systemQty, movedQty: s.movedQty, countedQty: s.countedQty,
          varianceQty: s.varianceQty, variancePaise: s.variancePaise, recount: s.flag === "recount",
        },
      }));
    }
    await appendEvent(tx, stockCounted.make({
      occurredAt: now, actor,
      payload: {
        countId, storeResourceId: row.resourceId, countedBy: actor.id, countedAt: countedAt.toISOString(),
        lines: settled.length,
        matched: settled.filter((s) => s.flag === "match").length,
        variances: settled.filter((s) => s.flag !== "match").length,
        recounts: recountBatches.length,
        netVariancePaise: settled.reduce((sum, s) => sum + s.variancePaise, 0),
        recountId,
      },
    }));
    return requireCount(tx, countId);
  });
  return headerOf(db, result);
}

export async function getCount(db: Db, actor: Actor, countId: string): Promise<CountReview> {
  await requireGrant(db, actor, COUNTS_MANAGE, "reviewing a count");
  const row = await requireCount(db, countId);
  const header = await headerOf(db, row);
  const lines: CountReviewLine[] = (await linesOf(db, countId)).map((l) => ({
    lineId: l.line.id, itemId: l.line.itemId, itemCode: l.itemCode, itemName: l.itemName, baseUom: l.baseUom,
    batchId: l.line.batchId, batchNo: l.batchNo, expiryDate: l.expiryDate,
    systemQty: l.line.systemQty, countedQty: l.line.countedQty, movedQty: l.line.movedQty,
    varianceQty: l.line.varianceQty, variancePaise: l.line.variancePaise, flag: l.line.flag as CountFlag | null,
  }));
  return {
    ...header,
    lines,
    totals: {
      lines: lines.length,
      matched: lines.filter((l) => l.flag === "match").length,
      variances: lines.filter((l) => l.flag === "variance" || l.flag === "recount").length,
      recounts: lines.filter((l) => l.flag === "recount").length,
      netVariancePaise: lines.reduce((sum, l) => sum + (l.variancePaise ?? 0), 0),
    },
  };
}

/**
 * PHARMACY P12 — the leakage triangle's COUNTED leg: every non-zero variance line of the counts at
 * one store whose sheet time falls in `[start, end)`, submitted or closed. A reader for a report,
 * gated by the report's own route; it carries no system figures beyond the variance.
 */
export async function countVariancesBetween(
  db: Db | Tx, resourceId: string, start: Date, end: Date,
): Promise<{ counts: number; lines: { countId: string; itemCode: string; batchNo: string; varianceQty: number; variancePaise: number }[] }> {
  const counts = await db.select({ id: stockCounts.id }).from(stockCounts).where(and(
    eq(stockCounts.resourceId, resourceId),
    inArray(stockCounts.status, ["submitted", "closed"]),
    gte(stockCounts.countedAt, start), lt(stockCounts.countedAt, end),
  ));
  if (counts.length === 0) return { counts: 0, lines: [] };
  const rows = await db.select({
    countId: stockCountLines.countId, itemCode: items.code, batchNo: stockBatches.batchNo,
    varianceQty: stockCountLines.varianceQty, variancePaise: stockCountLines.variancePaise,
  })
    .from(stockCountLines)
    .innerJoin(items, eq(items.id, stockCountLines.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
    .where(and(inArray(stockCountLines.countId, counts.map((c) => c.id)), sql`${stockCountLines.varianceQty} <> 0`))
    .orderBy(asc(items.code), asc(stockBatches.batchNo));
  return {
    counts: counts.length,
    lines: rows.map((r) => ({ countId: r.countId, itemCode: r.itemCode, batchNo: r.batchNo, varianceQty: r.varianceQty ?? 0, variancePaise: r.variancePaise ?? 0 })),
  };
}

/** The manager's list: newest first, optionally one status. */
export async function listCounts(db: Db, actor: Actor, opts: { status?: CountStatus } = {}): Promise<CountHeader[]> {
  await requireGrant(db, actor, COUNTS_MANAGE, "listing counts");
  const rows = await db.select().from(stockCounts)
    .where(opts.status === undefined ? sql`true` : eq(stockCounts.status, opts.status))
    .orderBy(sql`${stockCounts.frozenAt} desc`).limit(200);
  return Promise.all(rows.map((r) => headerOf(db, r)));
}

/** The counter's list: the sheets assigned to them that are still being counted. */
export async function myCounts(db: Db, actor: Actor): Promise<CountHeader[]> {
  const rows = await db.select().from(stockCounts)
    .where(and(eq(stockCounts.counterUserId, actor.id), eq(stockCounts.status, "counting")))
    .orderBy(asc(stockCounts.frozenAt));
  return Promise.all(rows.map((r) => headerOf(db, r)));
}

export async function closeCount(db: Db, actor: Actor, countId: string, input: { note: string }, now: Date): Promise<CountHeader> {
  await requireGrant(db, actor, COUNTS_MANAGE, "closing a count");
  const row = await requireCount(db, countId);
  if (row.status !== "submitted") throw new MaterialsError("count_not_submitted", `count ${countId} is ${row.status}: only a submitted count is closed`);
  const note = input.note.trim();
  if (note.length === 0) throw new MaterialsError("reason_required", "a closed count records what the review found");
  const result = await withTx(db, async (tx) => {
    const won = await tx.update(stockCounts)
      .set({ status: "closed", closedBy: actor.id, closedAt: now, closeNote: note })
      .where(and(eq(stockCounts.id, countId), eq(stockCounts.status, "submitted")))
      .returning({ id: stockCounts.id });
    if (won.length === 0) throw new MaterialsError("count_not_submitted", `count ${countId} moved while it was being closed`);
    await appendEvent(tx, stockCountClosed.make({
      occurredAt: now, actor, payload: { countId, storeResourceId: row.resourceId, closedBy: actor.id, note },
    }));
    return requireCount(tx, countId);
  });
  return headerOf(db, result);
}

export async function cancelCount(db: Db, actor: Actor, countId: string, input: { reason: string }, now: Date): Promise<CountHeader> {
  await requireGrant(db, actor, COUNTS_MANAGE, "cancelling a count");
  const row = await requireCount(db, countId);
  if (row.status !== "counting") throw new MaterialsError("count_not_open", `count ${countId} is ${row.status}: only a count still being counted is cancelled`);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new MaterialsError("reason_required", "a cancelled count records why");
  const result = await withTx(db, async (tx) => {
    const won = await tx.update(stockCounts)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now, cancelReason: reason })
      .where(and(eq(stockCounts.id, countId), eq(stockCounts.status, "counting")))
      .returning({ id: stockCounts.id });
    if (won.length === 0) throw new MaterialsError("count_not_open", `count ${countId} moved while it was being cancelled`);
    await appendEvent(tx, stockCountCancelled.make({
      occurredAt: now, actor, payload: { countId, storeResourceId: row.resourceId, cancelledBy: actor.id, reason },
    }));
    return requireCount(tx, countId);
  });
  return headerOf(db, result);
}
