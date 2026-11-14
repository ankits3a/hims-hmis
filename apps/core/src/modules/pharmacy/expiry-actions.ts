import { desc, eq, sql } from "drizzle-orm";
import { monthEndOf } from "@hmis/contracts";
import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { NEAR_EXPIRY_RETURN_DAYS, consumedQtyByItem, expiryCandidates, findStoreByCode, issueStock, topUpAgentReturns } from "../materials";
import {
  CONTROLLED_STORE_CODE, EXPIRY_ACTIONS_IST, EXPIRY_ACTIONS_WEEKDAY, EXPIRY_ACTION_HORIZON_DAYS, EXPIRY_SALES_WINDOW_DAYS,
  OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, istDateOf,
} from "./config";
import { PharmacyError } from "./errors";
import { expiryActionsRan } from "./events";
import { looseTraysOf } from "./loose-trays";
import { hospitalStateCode } from "./office";
import type { z } from "zod";
import type { Actor } from "@hmis/contracts";
import type { AgentReturnLine, AgentReturnsResult, ExpiryCandidate, ReturnLineReason, SupplierKind } from "../materials";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #1063 — THE WEEKLY EXPIRY ACTION LIST: RETURN, MOVE, AT RISK, WRITE OFF ═══
 *
 * Spec `docs/specs/1063-expiry-action-list.md` (owner APPROVED 2026-11-14 with its defaults). Every batch with stock
 * at the two counters — PHARM-OPD and PHARM-RETAIL, each with its loose and damage trays — that has expired or
 * expires within `EXPIRY_ACTION_HORIZON_DAYS` gets ONE action, the first that applies:
 *
 *   1. **Return** — a real supplier's own stock inside its window (`materials` `returnVerdict`: expired up to the
 *      vendor's days after expiry, near expiry within `NEAR_EXPIRY_RETURN_DAYS`, recalled). A damage tray never
 *      goes back (owner ruling 2026-10-03): it is written off whatever its date.
 *   2. **Move** — unexpired, on a counter's main shelf, the OTHER counter sold the item in the last
 *      `EXPIRY_SALES_WINDOW_DAYS` and this counter did not. The target is the other counter's main store.
 *   3. **At risk** — unexpired, more than `NEAR_EXPIRY_RETURN_DAYS` to go, and more stock than this counter's sales
 *      rate will clear before the END of the expiry month, the earlier-expiring batches of the item selling first
 *      (FEFO). The leftover is the action's quantity and value.
 *   4. **Write off** — expired past the window, or nobody to send it back to (opening/trial stock, donated) once it
 *      is expired, recalled, or within the near-expiry days with a leftover the sales will not clear.
 *
 * A batch none of these fits is not listed. A batch already held by a live return or write-off shows that document
 * instead of an action, in that document's group. NDPS stock — PHARM-NDPS, or an item of the narcotic class wherever
 * it sits — is listed APART and never drafted: its return and destruction follow the controlled register.
 *
 * The list is COMPUTED ON READ, never stored, so it is always today's. The RUN (Monday 07:00 IST from the scheduler,
 * or a person's Run now) writes only the Return group's drafts, through `materials` `topUpAgentReturns`: at most one
 * open agent draft per supplier, new batches added to it. It never approves, dispatches, moves or writes off. Its
 * log is the `expiry_actions.ran` event, which the page's "last run" reads. Move drafts a transfer only on a
 * person's tap (`moveExpiryBatch`), through the transfer writer `materials` `issueStock`.
 *
 * Value is the batch's cost per base unit (the GRN's `landed_cost_paise`); a batch whose opening rate was blank
 * carries an ESTIMATED cost (ruling 0093) and is marked so.
 */

export type ExpiryActionKind = "return" | "move" | "at_risk" | "write_off";
export const EXPIRY_ACTION_KINDS: readonly ExpiryActionKind[] = ["return", "move", "at_risk", "write_off"];

export type ExpiryActionWhy =
  | "inside_window" | "near_expiry" | "recalled"
  | "other_counter_sells"
  | "will_not_sell"
  | "past_window" | "no_supplier" | "damage_tray"
  | "on_document" | "controlled";

export type ExpiryActionRow = {
  /** `${storeResourceId}|${batchId}` — one row per store's batch. */
  key: string;
  storeResourceId: string; storeCode: string; storeName: string;
  counter: "opd" | "retail" | "ndps"; tray: "loose" | "damage" | null;
  itemId: string; itemCode: string; itemName: string; baseUom: string; pack: { uom: string; multiplier: number } | null;
  batchId: string; batchNo: string; expiryDate: string; daysToExpiry: number; expired: boolean;
  /** On hand at this store. */
  qtyBase: number;
  /** What the action is about: free stock to return, move or write off; the leftover at risk; what a document holds. */
  actionQtyBase: number;
  costPerBasePaise: number; valuePaise: number; estimated: boolean;
  vendorId: string | null; supplierName: string; supplierKind: SupplierKind;
  /** Null when a document already holds the batch, and for NDPS stock. */
  action: ExpiryActionKind | null;
  why: ExpiryActionWhy;
  /** The return reason the run drafts a Return row with. */
  returnReason: ReturnLineReason | null;
  returnableUntil: string | null;
  moveTo: { storeResourceId: string; storeCode: string; storeName: string } | null;
  document: { kind: "return" | "write_off"; id: string; no: string; status: string } | null;
  /** This counter's sales of the item per day over the window; null for NDPS. */
  salesPerDay: number | null;
};

export type ExpiryActionGroup = { count: number; valuePaise: number; estimated: boolean; rows: ExpiryActionRow[] };

export type ExpiryRunState = {
  lastRunAt: string | null; lastTrigger: "schedule" | "run_now" | null; batchesChecked: number | null;
  returnsCreated: number | null; returnsExtended: number | null; linesAdded: number | null;
  nextRunAt: string;
};

export type ExpiryActionList = {
  asOf: string; horizonDays: number; salesWindowDays: number;
  /** Store batches inside the horizon, NDPS included. */
  batchesChecked: number;
  groups: Record<ExpiryActionKind, ExpiryActionGroup>;
  ndps: ExpiryActionGroup;
  run: ExpiryRunState;
};

export type ExpiryRunResult = {
  ran: boolean; trigger: "schedule" | "run_now"; asOf: string; batchesChecked: number;
  returnsCreated: number; returnsExtended: number; linesAdded: number; returnIds: string[];
  skipped: { vendorId: string; code: string; message: string }[];
};

/** The Monday run's actor. Only the worker constructs it; the HTTP door refuses every non-user actor. */
export const EXPIRY_RUN_ACTOR: Actor = { type: "system", id: "pharmacy-expiry-run" };

/** The returns right drafts and reads (the office's returns page reads on it too); the transfer writer's own right moves. */
const RETURNS_RIGHT = "materials.returns.manage";
const MOVE_RIGHT = "materials.stock.issue";
const MOVE_REASON = "expiry action list (#1063): the other counter sells it";

const DAY_MS = 86_400_000;
const IST_MS = IST_UTC_OFFSET_MINUTES * 60_000;

// ═══════════════════════════════════ small pure pieces ═══════════════════════════════════

const dayNo = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const addDaysIso = (iso: string, n: number): string => new Date((dayNo(iso) + n) * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (from: string, to: string): number => Math.round(dayNo(to) - dayNo(from));

/** The next Monday 07:00 IST strictly after `now`. */
export function nextExpiryRunAt(now: Date): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const [h, m] = EXPIRY_ACTIONS_IST.split(":").map(Number) as [number, number];
  const todayAt = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_MS;
  let at = todayAt + ((EXPIRY_ACTIONS_WEEKDAY - ist.getUTCDay() + 7) % 7) * DAY_MS;
  if (at <= now.getTime()) at += 7 * DAY_MS;
  return new Date(at);
}

/** The latest Monday 07:00 IST at or before `now` — a run since then means this week's run is done. */
export function lastScheduledExpiryRunAt(now: Date): Date {
  return new Date(nextExpiryRunAt(now).getTime() - 7 * DAY_MS);
}

/**
 * What FEFO leaves on the shelf at each batch's expiry: walk the item's sellable batches at one counter in expiry
 * order with one clock of demand. A batch sells at `perDay` from where the batches ahead of it left the clock until
 * the end of its expiry month; what it cannot sell in that window is its leftover. Pure.
 */
export function fefoLeftovers(batches: readonly { key: string; free: number; daysLeft: number }[], perDay: number): Map<string, number> {
  const out = new Map<string, number>();
  let used = 0;
  for (const b of batches) {
    const window = Math.max(0, b.daysLeft - used);
    const canSell = perDay > 0 ? Math.floor(perDay * window + 1e-9) : 0;
    const sold = Math.min(b.free, canSell);
    out.set(b.key, b.free - sold);
    if (perDay > 0) used = sold === b.free ? used + b.free / perDay : Math.max(used, b.daysLeft);
  }
  return out;
}

// ═══════════════════════════════════ where the stock is ═══════════════════════════════════

type CounterKey = "opd" | "retail";
type Counter = { key: CounterKey; storeId: string; code: string; name: string; resourceIds: string[] };
type Place = { counter: Counter | null; tray: "loose" | "damage" | null; ndps: boolean };
type Scope = { counters: Counter[]; storeIds: string[]; placeOf: Map<string, Place> };

async function scopeOf(db: Db | Tx): Promise<Scope> {
  const counters: Counter[] = [];
  const placeOf = new Map<string, Place>();
  for (const [key, code] of [["opd", OPD_PHARMACY_STORE_CODE], ["retail", RETAIL_PHARMACY_STORE_CODE]] as const) {
    const store = await findStoreByCode(db, code);
    if (store === undefined) continue;
    const trays = await looseTraysOf(db, store.id);
    const counter: Counter = { key, storeId: store.id, code: store.code, name: store.name, resourceIds: [store.id] };
    placeOf.set(store.id, { counter, tray: null, ndps: false });
    for (const kind of ["loose", "damage"] as const) {
      const id = trays[kind];
      if (id === undefined) continue;
      counter.resourceIds.push(id);
      placeOf.set(id, { counter, tray: kind, ndps: false });
    }
    counters.push(counter);
  }
  const cabinet = await findStoreByCode(db, CONTROLLED_STORE_CODE);
  if (cabinet !== undefined) placeOf.set(cabinet.id, { counter: null, tray: null, ndps: true });
  return { counters, storeIds: [...placeOf.keys()], placeOf };
}

/** Each counter's `consume` rows per item over the window, its trays counted with it. */
async function salesOf(db: Db | Tx, scope: Scope, itemIds: readonly string[], now: Date): Promise<Map<CounterKey, Map<string, number>>> {
  const out = new Map<CounterKey, Map<string, number>>();
  const since = new Date(now.getTime() - EXPIRY_SALES_WINDOW_DAYS * DAY_MS);
  for (const c of scope.counters) {
    const sum = new Map<string, number>();
    if (itemIds.length > 0) {
      for (const id of c.resourceIds) {
        for (const [itemId, qty] of await consumedQtyByItem(db, id, itemIds, since, now)) sum.set(itemId, (sum.get(itemId) ?? 0) + qty);
      }
    }
    out.set(c.key, sum);
  }
  return out;
}

// ═══════════════════════════════════ the list ═══════════════════════════════════

const emptyGroup = (): ExpiryActionGroup => ({ count: 0, valuePaise: 0, estimated: false, rows: [] });
const keyOf = (c: Pick<ExpiryCandidate, "storeResourceId" | "batchId">): string => `${c.storeResourceId}|${c.batchId}`;

async function computeList(db: Db | Tx, now: Date): Promise<Omit<ExpiryActionList, "run">> {
  const today = istDateOf(now);
  const scope = await scopeOf(db);
  const cands = scope.storeIds.length === 0 ? []
    : await expiryCandidates(db, now, { storeResourceIds: scope.storeIds, expiryTo: addDaysIso(today, EXPIRY_ACTION_HORIZON_DAYS) });
  const sales = await salesOf(db, scope, [...new Set(cands.map((c) => c.itemId))], now);
  const perDay = (counter: CounterKey, itemId: string): number => (sales.get(counter)?.get(itemId) ?? 0) / EXPIRY_SALES_WINDOW_DAYS;
  const placeOf = (c: ExpiryCandidate): Place => scope.placeOf.get(c.storeResourceId) ?? { counter: null, tray: null, ndps: true };
  const isNdps = (c: ExpiryCandidate): boolean => placeOf(c).ndps || c.storageClass === "narcotic";
  const expired = (c: ExpiryCandidate): boolean => c.expiryDate < today;
  const daysLeft = (c: ExpiryCandidate): number => daysFrom(today, monthEndOf(c.expiryDate) ?? c.expiryDate);

  // FEFO, per counter and item, over what can still be sold: unexpired, free, not NDPS, not the damage tray.
  const leftover = new Map<string, number>();
  const queues = new Map<string, { counter: CounterKey; itemId: string; rows: ExpiryCandidate[] }>();
  for (const c of cands) {
    const p = placeOf(c);
    if (p.counter === null || p.tray === "damage" || isNdps(c) || expired(c) || c.free <= 0) continue;
    const k = `${p.counter.key}|${c.itemId}`;
    const q = queues.get(k) ?? { counter: p.counter.key, itemId: c.itemId, rows: [] };
    q.rows.push(c);
    queues.set(k, q);
  }
  for (const q of queues.values()) {
    const ordered = [...q.rows].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)
      || Number(placeOf(b).tray === "loose") - Number(placeOf(a).tray === "loose") || a.batchNo.localeCompare(b.batchNo));
    for (const [k, v] of fefoLeftovers(ordered.map((c) => ({ key: keyOf(c), free: c.free, daysLeft: daysLeft(c) })), perDay(q.counter, q.itemId))) leftover.set(k, v);
  }

  const groups: Record<ExpiryActionKind, ExpiryActionGroup> = { return: emptyGroup(), move: emptyGroup(), at_risk: emptyGroup(), write_off: emptyGroup() };
  const ndps = emptyGroup();
  const put = (g: ExpiryActionGroup, r: ExpiryActionRow): void => {
    g.rows.push(r);
    g.count += 1;
    g.valuePaise += r.valuePaise;
    if (r.estimated) g.estimated = true;
  };

  for (const c of cands) {
    const p = placeOf(c);
    const realSupplier = c.supplierKind === "supplier" && c.ownership === "owned" && c.vendorId !== null;
    const base = {
      key: keyOf(c), storeResourceId: c.storeResourceId, storeCode: c.storeCode, storeName: c.storeName,
      counter: p.counter?.key ?? ("ndps" as const), tray: p.tray,
      itemId: c.itemId, itemCode: c.itemCode, itemName: c.itemName, baseUom: c.baseUom, pack: c.pack,
      batchId: c.batchId, batchNo: c.batchNo, expiryDate: c.expiryDate, daysToExpiry: daysFrom(today, c.expiryDate), expired: expired(c),
      qtyBase: c.onHand, costPerBasePaise: c.landedCostPaise, estimated: c.estimatedCost,
      vendorId: c.vendorId, supplierName: c.vendorName, supplierKind: c.supplierKind,
      returnableUntil: realSupplier && !c.recalled ? c.verdict.until : null,
      document: c.document, moveTo: null, returnReason: null,
      salesPerDay: p.counter === null || isNdps(c) ? null : Math.round(perDay(p.counter.key, c.itemId) * 100) / 100,
    };
    const row = (action: ExpiryActionKind | null, why: ExpiryActionWhy, qty: number, extra: Partial<ExpiryActionRow> = {}): ExpiryActionRow =>
      ({ ...base, action, why, actionQtyBase: qty, valuePaise: qty * c.landedCostPaise, ...extra });

    if (isNdps(c)) { put(ndps, row(null, "controlled", c.onHand)); continue; }
    if (c.document !== null) { put(groups[c.document.kind === "return" ? "return" : "write_off"], row(null, "on_document", c.held)); continue; }
    if (c.free <= 0 || p.counter === null) continue;
    if (p.tray === "damage") { put(groups.write_off, row("write_off", "damage_tray", c.free)); continue; }

    // 1. Return — a real supplier's own stock inside its window.
    if (realSupplier && c.verdict.returnable && c.verdict.reason !== null) {
      const why: ExpiryActionWhy = c.verdict.reason === "expired" ? "inside_window" : c.verdict.reason;
      put(groups.return, row("return", why, c.free, { returnReason: c.verdict.reason }));
      continue;
    }
    // Expired (or recalled with nobody to send it to) and not returnable: nothing sells it.
    if (expired(c) || c.recalled) { put(groups.write_off, row("write_off", realSupplier ? "past_window" : "no_supplier", c.free)); continue; }

    // 2. Move — the other counter sells the item and this one does not.
    const other = scope.counters.find((x) => x.key !== p.counter!.key);
    if (p.tray === null && other !== undefined && perDay(other.key, c.itemId) > 0 && perDay(p.counter.key, c.itemId) === 0) {
      put(groups.move, row("move", "other_counter_sells", c.free, { moveTo: { storeResourceId: other.storeId, storeCode: other.code, storeName: other.name } }));
      continue;
    }

    // 3 and 4 — what this counter's sales will not clear before the expiry month ends.
    const left = leftover.get(keyOf(c)) ?? c.free;
    if (left <= 0) continue;
    if (daysFrom(today, c.expiryDate) <= NEAR_EXPIRY_RETURN_DAYS) put(groups.write_off, row("write_off", "no_supplier", left));
    else put(groups.at_risk, row("at_risk", "will_not_sell", left));
  }

  const order = (a: ExpiryActionRow, b: ExpiryActionRow): number =>
    a.expiryDate.localeCompare(b.expiryDate) || a.itemName.localeCompare(b.itemName) || a.storeCode.localeCompare(b.storeCode) || a.batchNo.localeCompare(b.batchNo);
  for (const g of [...Object.values(groups), ndps]) g.rows.sort(order);
  return {
    asOf: today, horizonDays: EXPIRY_ACTION_HORIZON_DAYS, salesWindowDays: EXPIRY_SALES_WINDOW_DAYS, batchesChecked: cands.length, groups, ndps,
  };
}

// ═══════════════════════════════════ the run's log ═══════════════════════════════════

type RunPayload = z.infer<typeof expiryActionsRan.payloadSchema>;

async function lastRun(db: Db | Tx): Promise<{ at: Date; payload: RunPayload } | null> {
  const [row] = await db.select({ at: events.occurredAt, payload: events.payload }).from(events)
    .where(eq(events.name, expiryActionsRan.name)).orderBy(desc(events.occurredAt), desc(events.seq)).limit(1);
  return row === undefined ? null : { at: row.at, payload: row.payload as RunPayload };
}

async function runState(db: Db | Tx, now: Date): Promise<ExpiryRunState> {
  const last = await lastRun(db);
  return {
    lastRunAt: last?.at.toISOString() ?? null, lastTrigger: last?.payload.trigger ?? null, batchesChecked: last?.payload.batchesChecked ?? null,
    returnsCreated: last?.payload.returnsCreated ?? null, returnsExtended: last?.payload.returnsExtended ?? null, linesAdded: last?.payload.linesAdded ?? null,
    nextRunAt: nextExpiryRunAt(now).toISOString(),
  };
}

async function requireGrant(db: Db, actor: Actor, perm: string, what: string): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, perm, "hospital"))) {
    throw new PharmacyError("permission_denied", `${what} needs ${perm}`);
  }
}

// ═══════════════════════════════════ the doors ═══════════════════════════════════

/** The page's read: the four groups, NDPS apart, and the run's last, next and batches checked. */
export async function expiryActionList(db: Db, actor: Actor, now: Date): Promise<ExpiryActionList> {
  await requireGrant(db, actor, RETURNS_RIGHT, "reading the expiry action list");
  return { ...(await computeList(db, now)), run: await runState(db, now) };
}

/**
 * THE RUN, one transaction under one advisory lock (a Run now and the Monday tick never draft side by side): read the
 * list, draft the Return group through `topUpAgentReturns`, log `expiry_actions.ran`. `dueSince` (the scheduler's)
 * makes it a no-op when a run already happened since that instant.
 */
async function runExpiryActions(db: Db, actor: Actor, now: Date, trigger: "schedule" | "run_now", dueSince: Date | null): Promise<ExpiryRunResult> {
  const asOf = istDateOf(now);
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pharmacy.expiry_actions'))`);
    if (dueSince !== null) {
      const last = await lastRun(tx);
      if (last !== null && last.at.getTime() >= dueSince.getTime()) {
        return { ran: false, trigger, asOf, batchesChecked: 0, returnsCreated: 0, returnsExtended: 0, linesAdded: 0, returnIds: [], skipped: [] };
      }
    }
    const exec = tx as unknown as Db;
    const listed = await computeList(tx, now);
    const lines: AgentReturnLine[] = listed.groups.return.rows
      .filter((r) => r.action === "return" && r.vendorId !== null && r.returnReason !== null)
      .map((r) => ({ vendorId: r.vendorId!, batchId: r.batchId, storeResourceId: r.storeResourceId, qtyBase: r.actionQtyBase, reason: r.returnReason! }));
    const drafted: AgentReturnsResult = lines.length === 0 ? { created: [], extended: [], linesAdded: 0, skipped: [] }
      : await topUpAgentReturns(exec, actor, now, { lines, hospitalStateCode: await hospitalStateCode(exec) });
    const result: ExpiryRunResult = {
      ran: true, trigger, asOf, batchesChecked: listed.batchesChecked,
      returnsCreated: drafted.created.length, returnsExtended: drafted.extended.length, linesAdded: drafted.linesAdded,
      returnIds: [...drafted.created, ...drafted.extended].map((r) => r.id), skipped: drafted.skipped,
    };
    await appendEvent(tx, expiryActionsRan.make({
      occurredAt: now, actor,
      payload: {
        trigger, asOf, batchesChecked: result.batchesChecked,
        groups: {
          return: listed.groups.return.count, move: listed.groups.move.count, at_risk: listed.groups.at_risk.count,
          write_off: listed.groups.write_off.count, ndps: listed.ndps.count,
        },
        returnsCreated: result.returnsCreated, returnsExtended: result.returnsExtended, linesAdded: result.linesAdded,
        returnIds: result.returnIds, skipped: result.skipped.map((s) => ({ vendorId: s.vendorId, code: s.code })),
      },
    }));
    return result;
  });
}

/** Run now: a person holding the returns right runs it at once; the page gets the list as it now stands. */
export async function runExpiryActionsNow(db: Db, actor: Actor, now: Date): Promise<{ run: ExpiryRunResult; list: ExpiryActionList }> {
  await requireGrant(db, actor, RETURNS_RIGHT, "running the expiry action list");
  const run = await runExpiryActions(db, actor, now, "run_now", null);
  return { run, list: await expiryActionList(db, actor, now) };
}

/**
 * The scheduler's job (`kernel/worker/jobs.ts` `runExpiryActions`, daily at 07:00 IST): it runs when no run has
 * happened since the latest Monday 07:00 IST — on the Monday, or on the first tick after a missed one.
 */
export async function runWeeklyExpiryActions(db: Db, now: Date): Promise<ExpiryRunResult> {
  return runExpiryActions(db, EXPIRY_RUN_ACTOR, now, "schedule", lastScheduledExpiryRunAt(now));
}

/**
 * A person's tap on Move: the batch's free stock at this counter goes to the other counter through the transfer
 * writer (into IN-TRANSIT; the other counter signs for it). Only a batch the list shows under Move, read again in
 * the same transaction; the transfer writer's own right (`materials.stock.issue`).
 */
export async function moveExpiryBatch(
  db: Db, actor: Actor, input: { storeResourceId: string; batchId: string }, now: Date,
): Promise<{ transferId: string; qtyBase: number; toStoreResourceId: string }> {
  await requireGrant(db, actor, MOVE_RIGHT, "moving a batch to the other counter");
  return withTx(db, async (tx) => {
    const listed = await computeList(tx, now);
    const row = listed.groups.move.rows.find((r) => r.storeResourceId === input.storeResourceId && r.batchId === input.batchId);
    if (row?.action !== "move" || row.moveTo === null) {
      throw new PharmacyError("not_found", "this batch is not on the expiry list's Move group", { why: "not_on_move_list", ...input });
    }
    const issued = await issueStock(tx, actor, {
      fromResourceId: row.storeResourceId, toResourceId: row.moveTo.storeResourceId,
      lines: [{ itemId: row.itemId, qtyBase: row.actionQtyBase, batchId: row.batchId, overrideReason: MOVE_REASON }],
      note: `Expiry list: ${row.itemName} ${row.batchNo} to ${row.moveTo.storeName}`.slice(0, 500), occurredAt: now,
    });
    return { transferId: issued.transferId, qtyBase: row.actionQtyBase, toStoreResourceId: row.moveTo.storeResourceId };
  });
}
