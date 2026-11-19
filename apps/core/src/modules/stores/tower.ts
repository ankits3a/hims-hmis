import { and, asc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import {
  events, itemStockLevels, items, opdEncounters, orgDepartments, resources, stockBalances, stockLedger, storeIndents, storesDeliveryLines,
  storesTicketDetails, transfers,
} from "../../kernel/db/schema";
import { STORES_ACT_EVENT } from "./events";
import { StoresError } from "./errors";
import { holds } from "./access";
import { assetRedCards, equipmentReceivedByMonth } from "./asset-reads";
import { CARRIER_KINDS, chainsOf } from "./chain";
import { overdueGatePasses } from "./gate-pass";
import { NO_WARNING_WINDOW_MS, stockOutsWithoutWarning } from "./planner-score";
import { listShelves } from "./shelves";
import { departmentSpendByMonth, monthLastDay, nextMonthStart } from "./spend";
import { gstNotCreditedBetween } from "./tax-on-bill";
import { EMERGENCY_REVIEW_MS, ticketViews } from "./tickets";
import type { Chain } from "./chain";
import type { TicketRow } from "./tickets";
import type { ShelfStatusWord, TicketPriority, TicketView } from "./types";
import type {
  Actor, StoresTowerClock, StoresTowerLane, WireRedCard, WireTowerCard, WireTowerFloor, WireTowerNumbers, WireTowerSpend, WireTowerSummary, WireTowerView,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * STORES S3 (#1113, decisions 1–7, 15, 16) — THE CONTROL TOWER: ONE READ, DERIVED FROM ROWS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `towerView(db, actor, now)` is the board: six lanes, the red-card strip, the floor map in words, the numbers
 * strip and (for `stores.spend.read` only) the month's spend per department. NOTHING about a lane is stored
 * (programme invariant I4): every card is derived, each time it is read, from the S1/S2 rows — the indent and its
 * write-once approval stamp, the picking claims, the transfer, the append-only hand-off log, the delivery lines
 * and the resolutions. So the board can never disagree with the ledger or the timeline.
 *
 * ═══ A CARD SITS IN EXACTLY ONE LANE, AND STUCK WINS ═══
 *
 *   requested   raised, the HOD has not answered (an emergency issued-first is NOT here: it waits to be picked)
 *   approved    approved (or an emergency, or a re-ask riding on its first ticket's approval), nobody picking
 *   picking     a keeper's claim is live (30 idle minutes, `CLAIM_IDLE_MS`)
 *   in_transit  issued, on its way (or coming back undelivered): the holder and the minutes since the last hand-off
 *   delivered   received TODAY (IST)
 *   stuck       past any clock (`CLOCKS`) — and the card says which clock broke
 *
 * A delivered ticket older than today is on the board only while a clock still runs on it (an open short past
 * 24 h, an emergency review past 24 h). Declined, rejected, cancelled and returned tickets are closed.
 *
 * ═══ NON-DRUG ONLY, NO PATIENT ═══
 *
 * Every ticket is read through `stores_ticket_details` (inner join): a pharmacy indent has no row there and cannot
 * reach the board. A card's key set is closed (`WireTowerCard`, spec #1113 D6): no patient field exists in Stores.
 */
export const STORES_TOWER_READ = "stores.tower.read";
/** Decision 5: the spend tile, for the owner, the materials head and the medical superintendent. Never a doctor (decision 0058). */
export const STORES_SPEND_READ = "stores.spend.read";

const MIN = 60_000;
/** Decision 2, in minutes. Picking runs from approval, an emergency's from its raise. */
export const CLOCKS = {
  approval: 60,
  pick: { routine: 240, urgent: 30, emergency: 10 } satisfies Record<TicketPriority, number>,
  leg: 30,
  /** A porter holding custody (the same leg, past 2 h). */
  custody: 120,
  short: 24 * 60,
  review: EMERGENCY_REVIEW_MS / MIN,
} as const;
/** Decision 4: the strip's length. */
export const RED_CARD_LIMIT = 8;
/** "More than book" checks stay on the strip for a day; the shelf check that follows answers them. */
const OVER_BOOK_WINDOW_MS = 24 * 60 * MIN;
/** The board reads at most this many tickets: a hospital's open tickets fit many times over. */
const BOARD_LIMIT = 1000;

const minutesBetween = (from: Date, to: Date): number => Math.max(0, Math.round((to.getTime() - from.getTime()) / MIN));

/** The derived facts behind one card: the card itself, when its clock started, and the stage underneath a Stuck card. */
export type BoardCard = { card: WireTowerCard; since: Date; under: Exclude<StoresTowerLane, "stuck">; ticket: TicketView; shelfFloorId: string | null };

type Extra = { issuedAt: Date | null; decidedAt: Date | null; chain: Chain };

/**
 * The tickets the board can show: every one still `requested`, every issued one on its way, delivered today, with a
 * short, or an emergency still waiting for its review. Ordered by the clock, oldest first.
 */
async function boardRows(db: Db | Tx, now: Date, indentIds?: readonly string[]): Promise<TicketRow[]> {
  const day = istDayWindow(now);
  const open = or(
    eq(storeIndents.status, "requested"),
    and(eq(storeIndents.status, "issued"), or(
      eq(transfers.status, "in_transit"),
      gte(transfers.receivedAt, day.start),
      sql`exists (select 1 from ${storesDeliveryLines} d where d.indent_id = ${storeIndents.id} and (d.received_at >= ${day.start.toISOString()} or d.short > 0))`,
      and(eq(storeIndents.issueBeforeApproval, true), sql`${storeIndents.approvalDecision} is null`, sql`${storeIndents.reviewDecision} is null`),
    )),
  );
  const rows = await (db as Db).select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .leftJoin(transfers, eq(transfers.id, storeIndents.transferId))
    .where(indentIds === undefined ? open : and(open, inArray(storeIndents.id, indentIds.length === 0 ? [""] : [...indentIds])))
    .orderBy(asc(storesTicketDetails.clockFrom), asc(storeIndents.requestedAt)).limit(BOARD_LIMIT);
  return rows;
}

/** The pick clock's start: approval, an emergency's raise, a re-ask's own raise (it rides on the first approval). */
function pickFrom(t: TicketView): Date {
  if (t.priority === "emergency") return new Date(t.clockFrom);
  if (t.approval.state === "approved" && t.approval.at !== null) return new Date(t.approval.at);
  return new Date(t.requestedAt);
}

/** Place one ticket: its lane, its minutes, and the clock that broke (if one did). Null when it is closed for the board. */
function place(t: TicketView, x: Extra, now: Date, todayStart: Date): { lane: StoresTowerLane; under: Exclude<StoresTowerLane, "stuck">; minutes: number; since: Date; clock: { kind: StoresTowerClock; minutes: number } | null; holder: { id: string; name: string } | null } | null {
  const stuck = (kind: StoresTowerClock, from: Date) => ({ kind, minutes: minutesBetween(from, now), from });
  const broken: { kind: StoresTowerClock; minutes: number; from: Date }[] = [];
  // An emergency issued before approval, with no answer and no review 24 h after its issue (decision 4, S2a).
  const reviewOpen = t.status === "issued" && t.approval.state === "pending" && t.review === null && x.decidedAt !== null;
  if (reviewOpen && now.getTime() - x.decidedAt!.getTime() >= EMERGENCY_REVIEW_MS) broken.push(stuck("review", x.decidedAt!));

  let under: Exclude<StoresTowerLane, "stuck">;
  let since: Date;
  let holder: { id: string; name: string } | null = null;

  if (t.status === "requested") {
    const waitsForHod = t.approval.state === "pending" && t.priority !== "emergency";
    if (waitsForHod) {
      under = "requested";
      since = new Date(t.clockFrom);
      if (now.getTime() - since.getTime() >= CLOCKS.approval * MIN) broken.push(stuck("approval", since));
    } else {
      under = t.claim === null ? "approved" : "picking";
      holder = t.claim?.by ?? null;
      since = pickFrom(t);
      if (now.getTime() - since.getTime() >= CLOCKS.pick[t.priority] * MIN) broken.push(stuck("pick", since));
    }
  } else if (t.status === "issued" && t.delivery === null && (t.transfer?.status === "in_transit")) {
    under = "in_transit";
    const last = x.chain.handoffs.at(-1);
    since = last?.occurredAt ?? x.issuedAt ?? new Date(t.requestedAt);
    holder = t.custody?.holder ?? null;
    // A carrier (a porter, or whoever took it over) holds it: the 2 h custody clock runs beside the 30 min leg.
    const porterHolds = last !== undefined && CARRIER_KINDS.includes(last.kind);
    if (porterHolds && now.getTime() - since.getTime() >= CLOCKS.custody * MIN) broken.push(stuck("custody", since));
    else if (now.getTime() - since.getTime() >= CLOCKS.leg * MIN) broken.push(stuck("leg", since));
  } else if (t.status === "issued") {
    if (t.transfer?.status === "returned") return null;
    const deliveredAt = t.delivery === null ? null : new Date(t.delivery.at);
    under = "delivered";
    since = new Date(t.clockFrom);
    const openShort = t.shorts.some((s) => s.resolution === null);
    if (openShort && deliveredAt !== null && now.getTime() - deliveredAt.getTime() >= CLOCKS.short * MIN) broken.push(stuck("short", deliveredAt));
    const at = deliveredAt;
    if (broken.length === 0 && (at === null || at.getTime() < todayStart.getTime())) return null;
    if (broken.length === 0) {
      return { lane: "delivered", under, minutes: minutesBetween(new Date(t.requestedAt), at ?? now), since: at ?? now, clock: null, holder: null };
    }
  } else {
    return null;
  }

  const worst = broken[0];
  if (worst !== undefined) {
    return { lane: "stuck", under, minutes: worst.minutes, since: worst.from, clock: { kind: worst.kind, minutes: worst.minutes }, holder };
  }
  return { lane: under, under, minutes: minutesBetween(since, now), since, clock: null, holder };
}

/** Every open ticket's card, oldest clock first. Shared by the board, the owner's line, the desk card, the chaser and the concierge. */
export async function boardCards(db: Db | Tx, now: Date, indentIds?: readonly string[]): Promise<BoardCard[]> {
  const rows = await boardRows(db, now, indentIds);
  if (rows.length === 0) return [];
  const views = await ticketViews(db, rows, now);
  const chains = await chainsOf(db, rows.map((r) => r.indent.id));
  const transferIds = rows.map((r) => r.indent.transferId).filter((x): x is string => x !== null);
  const issued = new Map(transferIds.length === 0 ? [] : (await (db as Db).select({ id: transfers.id, at: transfers.issuedAt }).from(transfers)
    .where(inArray(transfers.id, transferIds))).map((t) => [t.id, t.at] as const));
  const shelfIds = [...new Set(views.map((v) => v.shelf.id))];
  const shelves = new Map((await (db as Db).select({ id: resources.id, parentId: resources.parentId }).from(resources)
    .where(inArray(resources.id, shelfIds))).map((s) => [s.id, s.parentId] as const));
  const floorIds = [...new Set([...shelves.values()].filter((x): x is string => x !== null))];
  const floors = new Map(floorIds.length === 0 ? [] : (await (db as Db).select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(inArray(resources.id, floorIds))).map((f) => [f.id, f] as const));
  const todayStart = istDayWindow(now).start;

  const out: BoardCard[] = [];
  views.forEach((t, i) => {
    const r = rows[i]!;
    const x: Extra = {
      issuedAt: r.indent.transferId === null ? null : (issued.get(r.indent.transferId) ?? null),
      decidedAt: r.indent.decidedAt, chain: chains.get(r.indent.id)!,
    };
    const p = place(t, x, now, todayStart);
    if (p === null) return;
    const floorId = shelves.get(t.shelf.id) ?? null;
    const floor = floorId === null ? null : (floors.get(floorId) ?? null);
    out.push({
      card: {
        id: t.id, indentNo: t.indentNo, lane: p.lane, priority: t.priority, department: t.department,
        floor: floor === null ? null : { id: floor.id, code: floor.code, name: floor.name },
        holder: p.holder, minutes: p.minutes, clock: p.clock,
      },
      since: p.since, under: p.under, ticket: t, shelfFloorId: floorId,
    });
  });
  return out;
}

function lanesOf(cards: readonly BoardCard[]): Record<StoresTowerLane, WireTowerCard[]> {
  const lanes: Record<StoresTowerLane, WireTowerCard[]> = { requested: [], approved: [], picking: [], in_transit: [], delivered: [], stuck: [] };
  for (const c of cards) lanes[c.card.lane].push(c.card);
  // Stuck: the longest-broken first. The others keep the clock order they were read in.
  lanes.stuck.sort((a, b) => (b.clock?.minutes ?? 0) - (a.clock?.minutes ?? 0));
  return lanes;
}

/* ═══════════════════════════════ the floor map (decision 3) ═══════════════════════════════ */

/** item at a shelf → on hand, from the balances materials keeps (every row a ledger sum). */
async function shelfStock(db: Db | Tx, shelfIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (shelfIds.length === 0) return out;
  const rows = await (db as Db).select({ resourceId: stockBalances.resourceId, itemId: stockBalances.itemId, qty: sql<string>`sum(${stockBalances.qtyOnHand})` })
    .from(stockBalances).where(inArray(stockBalances.resourceId, [...shelfIds])).groupBy(stockBalances.resourceId, stockBalances.itemId);
  for (const r of rows) out.set(`${r.resourceId}:${r.itemId}`, Number(r.qty));
  return out;
}

type ShelfState = { shelfId: string; shelfName: string; departmentId: string; floorId: string | null; status: ShelfStatusWord; low: number; out: number; outItems: string[] };

/**
 * Each shelf's word: Out if any item it keeps (an item with a par at the shelf) is at 0, Low if any is at or under its
 * reorder level (the shelf screen's own rule, `reads.ts` `statusOf`), else OK. An item with no par is not kept there
 * (an expensed item is consumed on receipt and always reads 0), so it says nothing about the shelf.
 */
export async function shelfStates(db: Db | Tx, shelfIds?: readonly string[]): Promise<ShelfState[]> {
  const shelves = (await listShelves(db)).filter((s) => s.departmentId !== null && (shelfIds === undefined || shelfIds.includes(s.id)));
  if (shelves.length === 0) return [];
  const levels = await (db as Db).select().from(itemStockLevels).where(inArray(itemStockLevels.storeResourceId, shelves.map((s) => s.id)));
  const stock = await shelfStock(db, shelves.map((s) => s.id));
  return shelves.map((s) => {
    let low = 0;
    let out = 0;
    const outItems: string[] = [];
    for (const l of levels.filter((x) => x.storeResourceId === s.id)) {
      const have = stock.get(`${s.id}:${l.itemId}`) ?? 0;
      if (have <= 0) { out += 1; outItems.push(l.itemId); } else if (have <= l.reorderBase) low += 1;
    }
    return {
      shelfId: s.id, shelfName: s.name, departmentId: s.departmentId!, floorId: s.parentId,
      status: out > 0 ? "out" : low > 0 ? "low" : "ok", low, out, outItems,
    };
  });
}

const WORSE: Record<ShelfStatusWord, number> = { ok: 0, low: 1, out: 2 };

async function floorMap(db: Db | Tx, states: readonly ShelfState[]): Promise<WireTowerFloor[]> {
  if (states.length === 0) return [];
  const floorIds = [...new Set(states.map((s) => s.floorId).filter((x): x is string => x !== null))];
  const floors = floorIds.length === 0 ? [] : await (db as Db).select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(inArray(resources.id, floorIds));
  const depts = new Map((await (db as Db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, [...new Set(states.map((s) => s.departmentId))]))).map((d) => [d.id, d] as const));
  const byFloor = new Map<string, Map<string, ShelfStatusWord>>();
  for (const s of states) {
    const key = s.floorId ?? "";
    const m = byFloor.get(key) ?? new Map<string, ShelfStatusWord>();
    const was = m.get(s.departmentId);
    if (was === undefined || WORSE[s.status] > WORSE[was]) m.set(s.departmentId, s.status);
    byFloor.set(key, m);
  }
  const out: WireTowerFloor[] = [];
  for (const [key, m] of byFloor) {
    const f = floors.find((x) => x.id === key);
    out.push({
      id: f?.id ?? null, code: f?.code ?? "—", name: f?.name ?? "",
      departments: [...m].map(([id, status]) => ({ id, code: depts.get(id)?.code ?? "", name: depts.get(id)?.name ?? id, status }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/* ═══════════════════════════════ the red cards (decision 4) ═══════════════════════════════ */

/** Every red card, oldest first and uncapped (the strip takes the first eight; the concierge counts them all). */
export async function redCards(db: Db | Tx, now: Date, cards: readonly BoardCard[], states: readonly ShelfState[]): Promise<WireRedCard[]> {
  const out: (WireRedCard & { at: number })[] = [];
  const push = (c: Omit<WireRedCard, "since" | "minutes">, since: Date): void => {
    out.push({ ...c, since: since.toISOString(), minutes: minutesBetween(since, now), at: since.getTime() });
  };
  for (const c of cards) {
    if (c.card.lane === "stuck") {
      push({ id: `stuck:${c.card.id}`, kind: "stuck", what: c.card.indentNo, where: c.card.department.name, clock: c.card.clock!.kind, indentId: c.card.id, shelfId: null, passId: null }, c.since);
    } else if (c.ticket.shorts.some((s) => s.resolution === null) && c.ticket.delivery !== null) {
      push({ id: `short:${c.card.id}`, kind: "short", what: c.card.indentNo, where: c.card.department.name, clock: null, indentId: c.card.id, shelfId: null, passId: null }, new Date(c.ticket.delivery.at));
    }
  }
  // Shelves that are out: since the last movement of an out item there (when it reached 0).
  const outShelves = states.filter((s) => s.out > 0);
  if (outShelves.length > 0) {
    const last = await (db as Db).select({ resourceId: stockLedger.resourceId, at: sql<Date>`max(${stockLedger.occurredAt})` }).from(stockLedger)
      .where(inArray(stockLedger.resourceId, outShelves.map((s) => s.shelfId))).groupBy(stockLedger.resourceId);
    const depts = new Map((await (db as Db).select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments)
      .where(inArray(orgDepartments.id, outShelves.map((s) => s.departmentId)))).map((d) => [d.id, d.name] as const));
    for (const s of outShelves) {
      const at = last.find((l) => l.resourceId === s.shelfId)?.at;
      push({ id: `out:${s.shelfId}`, kind: "out", what: s.shelfName, where: depts.get(s.departmentId) ?? "", clock: null, indentId: null, shelfId: s.shelfId, passId: null },
        at === undefined || at === null ? now : new Date(at));
    }
  }
  for (const p of await overdueGatePasses(db, now)) {
    // A pass is overdue from the end of its due-back day (IST).
    const dueEnd = istDayWindow(new Date(`${p.dueBack!}T12:00:00+05:30`)).end;
    push({ id: `pass:${p.id}`, kind: "pass", what: p.passNo, where: p.party, clock: null, indentId: null, shelfId: null, passId: p.id }, dueEnd);
  }
  const overBook = await (db as Db).select({ eventId: events.eventId, at: events.occurredAt, payload: events.payload }).from(events)
    .where(and(eq(events.name, STORES_ACT_EVENT), sql`${events.payload}->>'act' = 'check'`, sql`${events.payload}->>'reason' = 'more_than_book'`,
      gte(events.occurredAt, new Date(now.getTime() - OVER_BOOK_WINDOW_MS)), lt(events.occurredAt, new Date(now.getTime() + MIN))));
  if (overBook.length > 0) {
    const ids = [...new Set(overBook.map((e) => (e.payload as { storeId: string }).storeId))];
    const names = new Map((await (db as Db).select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, ids))).map((r) => [r.id, r.name] as const));
    for (const e of overBook) {
      const shelfId = (e.payload as { storeId: string }).storeId;
      push({ id: `over_book:${e.eventId}`, kind: "over_book", what: names.get(shelfId) ?? "", where: "", clock: null, indentId: null, shelfId, passId: null }, e.at);
    }
  }
  // S7 (#1117, decision 13): a shelf item that ran out with no planner warning 24 h before, over the last 7 days.
  const outs = (await stockOutsWithoutWarning(db, new Date(now.getTime() - NO_WARNING_WINDOW_MS), now)).events;
  if (outs.length > 0) {
    const shelfNames = new Map((await (db as Db).select({ id: resources.id, name: resources.name }).from(resources)
      .where(inArray(resources.id, [...new Set(outs.map((o) => o.storeId))]))).map((r) => [r.id, r.name] as const));
    const itemNames = new Map((await (db as Db).select({ id: items.id, name: items.name }).from(items)
      .where(inArray(items.id, [...new Set(outs.map((o) => o.itemId))]))).map((r) => [r.id, r.name] as const));
    for (const o of outs) {
      push({
        id: `no_warning:${o.storeId}:${o.itemId}:${o.at}`, kind: "no_warning", what: itemNames.get(o.itemId) ?? "", where: shelfNames.get(o.storeId) ?? "",
        clock: null, indentId: null, shelfId: o.storeId, passId: null,
      }, new Date(o.at));
    }
  }
  // S4 (#1114): calibration overdue, AMC lapsed, a missing asset, units ≠ ledger.
  out.push(...(await assetRedCards(db as Db, now)));
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((c) => {
    const { at, ...card } = c;
    void at;
    return card;
  });
}

/* ═══════════════════════════════ the numbers strip (decision 5) ═══════════════════════════════ */

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

async function numbersOf(db: Db | Tx, now: Date, cards: readonly BoardCard[]): Promise<WireTowerNumbers> {
  const day = istDayWindow(now);
  const today = and(gte(storeIndents.requestedAt, day.start), lt(storeIndents.requestedAt, day.end));
  const [raised] = await (db as Db).select({ n: sql<number>`count(*)::int` }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id)).where(today);
  const approvals = await (db as Db).select({ raised: storeIndents.requestedAt, at: storeIndents.approvalAt }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .where(and(eq(storeIndents.approvalDecision, "approved"), gte(storeIndents.approvalAt, day.start), lt(storeIndents.approvalAt, day.end)));
  const deliveries = await (db as Db).selectDistinct({ indentId: storesDeliveryLines.indentId, at: storesDeliveryLines.receivedAt, by: storesDeliveryLines.receivedBy,
    raised: storeIndents.requestedAt, issuedBy: transfers.issuedBy })
    .from(storesDeliveryLines).innerJoin(storeIndents, eq(storeIndents.id, storesDeliveryLines.indentId))
    .innerJoin(transfers, eq(transfers.id, storesDeliveryLines.transferId))
    .where(and(gte(storesDeliveryLines.receivedAt, day.start), lt(storesDeliveryLines.receivedAt, day.end)));
  const signed = deliveries.filter((d) => d.by !== d.issuedBy).length;
  return {
    ticketsToday: raised?.n ?? 0,
    medianApprovalMin: median(approvals.filter((a) => a.at !== null).map((a) => minutesBetween(a.raised, a.at!))),
    medianDeliverMin: median(deliveries.map((d) => minutesBetween(d.raised, d.at))),
    doubleSignedPct: deliveries.length === 0 ? null : Math.round((100 * signed) / deliveries.length),
    openShorts: cards.reduce((n, c) => n + c.ticket.shorts.filter((s) => s.resolution === null).length, 0),
  };
}

/* ═══════════════════════════════ spend (decision 5) ═══════════════════════════════ */

// The month's spend rule lives in `spend.ts` (S5a: budgets read it too, and `tickets.ts` cannot import this file).
async function spendOf(db: Db | Tx, now: Date): Promise<WireTowerSpend> {
  const month = istDayString(now).slice(0, 7);
  const byCode = await departmentSpendByMonth(db, month);
  const shelfDepts = [...new Set((await listShelves(db)).map((s) => s.departmentId).filter((x): x is string => x !== null))];
  if (shelfDepts.length === 0) return { month, departments: [] };
  const depts = await (db as Db).select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name, opd: orgDepartments.opdDepartmentId })
    .from(orgDepartments).where(inArray(orgDepartments.id, shelfDepts));
  const opdIds = depts.map((d) => d.opd).filter((x): x is string => x !== null);
  const visits = new Map(opdIds.length === 0 ? [] : (await (db as Db).select({ dept: opdEncounters.departmentId, n: sql<number>`count(*)::int` }).from(opdEncounters)
    .where(and(inArray(opdEncounters.departmentId, opdIds), ne(opdEncounters.status, "abandoned"),
      gte(opdEncounters.serviceDate, `${month}-01`), lt(opdEncounters.serviceDate, nextMonthStart(month)))).groupBy(opdEncounters.departmentId))
    .map((v) => [v.dept, v.n] as const));
  // S6c (#1116, decision 4): each department's derived "GST not credited" this month, beside (never inside) the charge.
  const gst = new Map<string, number>();
  for (const d of depts) gst.set(d.code, (await gstNotCreditedBetween(db, d.code, `${month}-01`, monthLastDay(month))).paise);
  return {
    month,
    departments: depts.map((d) => {
      const charge = byCode.get(d.code) ?? 0;
      const n = d.opd === null ? 0 : (visits.get(d.opd) ?? 0);
      // Per occupied bed-day once IPD is on production (owner 2026-10-13); null until then.
      return {
        id: d.id, code: d.code, name: d.name, chargePaise: charge, perOpdVisitPaise: n === 0 ? null : Math.round(charge / n), perBedDayPaise: null,
        gstNotCreditedPaise: gst.get(d.code) ?? 0,
      };
    }).sort((a, b) => b.chargePaise - a.chargePaise || a.code.localeCompare(b.code)),
  };
}

/* ═══════════════════════════════ the reads ═══════════════════════════════ */

export { departmentSpendByMonth };

export async function requireTowerReader(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_TOWER_READ))) {
    throw new StoresError("not_permitted", "the control tower is the materials head's, the store's and the duty manager's", { permission: STORES_TOWER_READ });
  }
}

/** Decision 1: the board. The `spend` key exists only for a holder of `stores.spend.read` (decision 5, spec D5). */
export async function towerView(db: Db, actor: Actor, now: Date = new Date()): Promise<WireTowerView> {
  await requireTowerReader(db, actor);
  const cards = await boardCards(db, now);
  const states = await shelfStates(db);
  const view: WireTowerView = {
    at: now.toISOString(),
    lanes: lanesOf(cards),
    redCards: (await redCards(db, now, cards, states)).slice(0, RED_CARD_LIMIT),
    floors: await floorMap(db, states),
    numbers: await numbersOf(db, now, cards),
  };
  if (await holds(db, actor, STORES_SPEND_READ)) {
    view.spend = { ...(await spendOf(db, now)), equipment: await equipmentReceivedByMonth(db, istDayString(now).slice(0, 7)) };
  }
  return view;
}

/**
 * Decision 16: the owner's one line — how many are stuck, and where. `places` are the floor codes of the stuck
 * tickets' shelves, the floor with most first (ties: the longest stuck first).
 */
export async function towerSummary(db: Db, actor: Actor, now: Date = new Date()): Promise<WireTowerSummary> {
  await requireTowerReader(db, actor);
  const stuck = (await boardCards(db, now)).filter((c) => c.card.lane === "stuck")
    .sort((a, b) => (b.card.clock?.minutes ?? 0) - (a.card.clock?.minutes ?? 0));
  const count = new Map<string, number>();
  for (const c of stuck) {
    const code = c.card.floor?.code ?? c.card.department.code;
    count.set(code, (count.get(code) ?? 0) + 1);
  }
  const first = [...count.keys()];
  return { stuck: stuck.length, places: [...first].sort((a, b) => (count.get(b)! - count.get(a)!) || first.indexOf(a) - first.indexOf(b)) };
}
