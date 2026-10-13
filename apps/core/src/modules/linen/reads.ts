import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { LINEN_STANDARD_ITEMS, linenSetsPerBed } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import {
  linenCondemnRequests, linenItems, linenLaundryBatches, linenMovements, linenParLevels, linenVariances, resources, users,
} from "../../kernel/db/schema";
import { MAX_RESOURCE_DEPTH } from "../../kernel/resources";
import type {
  LinenBatchCard, LinenBoardView, LinenCondemnCard, LinenHandlerView, LinenItem, LinenShortRecord, LinenVarianceRow,
  LinenWardState,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE READS ═══ — nothing here is stored; everything is computed from the records on read.
 *
 *   · Beds per ward: every non-retired `bed` resource anywhere under a `ward` resource (ward → bed, or ward → room →
 *     bed), walked in memory with the registry's depth cap and a visited set (the `resourceTree` guards).
 *   · Computed par per item = Σ over the ward's beds of sets-per-bed(bed class) × the item's units per set. The bed's
 *     class is `attributes.class` on the bed, else on the ward, else general. A par in `linen_par_levels` overrides.
 *   · On hand (book balance) = the last ward count at or before `now` + what moved since: issued and borrowed in, less
 *     soiled, infected, borrowed out and condemned.
 *   · Weekly loss variance — see `weeklyVariance`.
 */
type Exec = Db | Tx;

/** Seed the standard catalogue (the migration does the same for a live database; tests truncate it). Idempotent. */
export async function seedLinenItems(exec: Exec): Promise<void> {
  await exec.insert(linenItems).values(LINEN_STANDARD_ITEMS.map((i) => ({ code: i.code, name: i.name, unitsPerSet: i.unitsPerSet, sort: i.sort })))
    .onConflictDoNothing();
}

export async function linenItemList(exec: Exec): Promise<LinenItem[]> {
  return exec.select({ code: linenItems.code, name: linenItems.name, unitsPerSet: linenItems.unitsPerSet }).from(linenItems)
    .where(eq(linenItems.active, true)).orderBy(asc(linenItems.sort), asc(linenItems.code));
}

export type WardShape = { wardId: string; wardName: string; floorName: string | null; beds: number; bedsByClass: Record<string, number>; setsTotal: number };

/** Every ward with its beds by class. One query over the structural kinds; the walk is in memory. */
export async function wardShapes(exec: Exec, wardId?: string): Promise<WardShape[]> {
  const rows = await exec.select({
    id: resources.id, parentId: resources.parentId, kind: resources.kind, name: resources.name, code: resources.code,
    attributes: resources.attributes,
  }).from(resources).where(and(inArray(resources.kind, ["floor", "ward", "hall", "room", "bed"]), ne(resources.status, "retired")));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }
  const wards = rows.filter((r) => r.kind === "ward" && (wardId === undefined || r.id === wardId))
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  return wards.map((w) => {
    const wardClass = typeof w.attributes.class === "string" ? w.attributes.class : undefined;
    const bedsByClass: Record<string, number> = {};
    let setsTotal = 0;
    const visited = new Set([w.id]);
    let frontier = [w];
    for (let level = 1; level < MAX_RESOURCE_DEPTH && frontier.length > 0; level += 1) {
      const next: typeof rows = [];
      for (const node of frontier) {
        for (const c of children.get(node.id) ?? []) {
          // A ward inside a ward is its own ward: its beds are counted there, not here.
          if (visited.has(c.id) || c.kind === "ward") continue;
          visited.add(c.id);
          if (c.kind === "bed") {
            const cls = typeof c.attributes.class === "string" ? c.attributes.class : wardClass ?? "general";
            bedsByClass[cls] = (bedsByClass[cls] ?? 0) + 1;
            setsTotal += linenSetsPerBed(cls);
          } else next.push(c);
        }
      }
      frontier = next;
    }
    const parent = w.parentId === null ? undefined : byId.get(w.parentId);
    return {
      wardId: w.id, wardName: w.name, floorName: parent?.kind === "floor" ? parent.name : null,
      beds: Object.values(bedsByClass).reduce((n, x) => n + x, 0), bedsByClass, setsTotal,
    };
  });
}

/** The book balance per (ward, item) at `at`: the last count at or before it plus every ward movement since. */
export async function bookBalances(exec: Exec, at: Date, wardId?: string): Promise<Map<string, Map<string, { onHand: number; countedAt: Date | null }>>> {
  const atIso = at.toISOString();
  const ward = wardId ?? null;
  const r = await exec.execute<{ w: string; i: string; on_hand: string; counted_at: Date | string | null }>(sql`
    with last as (
      select distinct on (ward_resource_id, item_code) ward_resource_id as w, item_code as i, on_hand, counted_at
        from linen_ward_counts
       where counted_at <= ${atIso}::timestamptz and (${ward}::text is null or ward_resource_id = ${ward}::text)
       order by ward_resource_id, item_code, counted_at desc, id desc
    ), mv as (
      select ward_resource_id as w, item_code as i, at, case when kind = 'issue_to_ward' then qty else -qty end as d
        from linen_movements
       where ward_resource_id is not null and at <= ${atIso}::timestamptz
         and kind in ('issue_to_ward', 'return_soiled', 'return_infected', 'condemn', 'transfer_between_wards')
         and (${ward}::text is null or ward_resource_id = ${ward}::text)
      union all
      select to_ward_resource_id, item_code, at, qty
        from linen_movements
       where kind = 'transfer_between_wards' and at <= ${atIso}::timestamptz
         and (${ward}::text is null or to_ward_resource_id = ${ward}::text)
    ), pairs as (select w, i from last union select w, i from mv)
    select p.w, p.i, l.counted_at,
           coalesce(l.on_hand, 0) + coalesce((select sum(m.d) from mv m where m.w = p.w and m.i = p.i
                                                and (l.counted_at is null or m.at >= l.counted_at)), 0) as on_hand
      from pairs p left join last l on l.w = p.w and l.i = p.i`);
  const out = new Map<string, Map<string, { onHand: number; countedAt: Date | null }>>();
  for (const row of r.rows) {
    const m = out.get(row.w) ?? new Map<string, { onHand: number; countedAt: Date | null }>();
    m.set(row.i, { onHand: Number(row.on_hand), countedAt: row.counted_at === null ? null : new Date(row.counted_at) });
    out.set(row.w, m);
  }
  return out;
}

/** Every ward (or one): beds, par per item (computed or set), on hand, short. Below par first, then by name. */
export async function wardStates(exec: Exec, now: Date, wardId?: string): Promise<LinenWardState[]> {
  // Sequential, not Promise.all: an intent calls this inside its transaction, and one client runs one query at a time.
  const shapes = await wardShapes(exec, wardId);
  const items = await linenItemList(exec);
  const overrides = await exec.select().from(linenParLevels).where(wardId === undefined ? undefined : eq(linenParLevels.wardResourceId, wardId));
  const balances = await bookBalances(exec, now, wardId);
  const set = new Map(overrides.map((o) => [`${o.wardResourceId}|${o.itemCode}`, o.par]));
  const states = shapes.map((s): LinenWardState => {
    const book = balances.get(s.wardId);
    let lastCount: Date | null = null;
    const rows = items.map((it) => {
      const own = set.get(`${s.wardId}|${it.code}`);
      const par = own ?? s.setsTotal * it.unitsPerSet;
      const b = book?.get(it.code);
      if (b?.countedAt != null && (lastCount === null || b.countedAt > lastCount)) lastCount = b.countedAt;
      const onHand = b?.onHand ?? 0;
      return { itemCode: it.code, par, parSource: own === undefined ? "computed" as const : "set" as const, onHand, short: Math.max(0, par - onHand) };
    });
    const shortPieces = rows.reduce((n, x) => n + x.short, 0);
    return {
      wardId: s.wardId, wardName: s.wardName, floorName: s.floorName, beds: s.beds, bedsByClass: s.bedsByClass, items: rows,
      belowPar: shortPieces > 0, shortPieces, lastCountAt: (lastCount as Date | null)?.toISOString() ?? null,
    };
  });
  return states.sort((a, b) => Number(b.belowPar) - Number(a.belowPar) || b.shortPieces - a.shortPieces || a.wardName.localeCompare(b.wardName));
}

/** What waits in the soiled room per item, ordinary and infected apart: returned to it, less sent to the laundry. */
export async function soiledPool(exec: Exec): Promise<{ general: Record<string, number>; infected: Record<string, number> }> {
  const r = await exec.execute<{ pool: "general" | "infected"; i: string; n: string }>(sql`
    select pool, i, sum(d) as n from (
      select case when kind = 'return_infected' then 'infected' else 'general' end as pool, item_code as i, qty as d
        from linen_movements where kind in ('return_soiled', 'return_infected')
      union all
      select case when b.infected then 'infected' else 'general' end, m.item_code, -m.qty
        from linen_movements m join linen_laundry_batches b on b.id = m.batch_id where m.kind = 'laundry_out'
    ) x group by pool, i`);
  const out = { general: {} as Record<string, number>, infected: {} as Record<string, number> };
  for (const row of r.rows) {
    const n = Number(row.n);
    if (n !== 0) out[row.pool][row.i] = n;
  }
  return out;
}

async function batchCards(exec: Exec, batches: (typeof linenLaundryBatches.$inferSelect)[]): Promise<LinenBatchCard[]> {
  if (batches.length === 0) return [];
  const mv = await exec.select({ batchId: linenMovements.batchId, kind: linenMovements.kind, itemCode: linenMovements.itemCode, qty: linenMovements.qty })
    .from(linenMovements).where(inArray(linenMovements.batchId, batches.map((b) => b.id)));
  return batches.map((b) => {
    const lines = new Map<string, { itemCode: string; sent: number; received: number | null }>();
    for (const m of mv.filter((x) => x.batchId === b.id)) {
      const l = lines.get(m.itemCode) ?? { itemCode: m.itemCode, sent: 0, received: b.state === "sent" ? null : 0 };
      if (m.kind === "laundry_out") l.sent += m.qty;
      else l.received = (l.received ?? 0) + m.qty;
      lines.set(m.itemCode, l);
    }
    return {
      id: b.id, batchNo: b.batchNo, infected: b.infected, state: b.state as LinenBatchCard["state"], vendorName: b.vendorName,
      sentAt: b.sentAt.toISOString(), receivedAt: b.receivedAt?.toISOString() ?? null, piecesSent: b.piecesSent,
      piecesReceived: b.piecesReceived, lines: [...lines.values()],
    };
  });
}

/** Batches at the laundry (sent, not yet received), oldest first. Infected batches carry `infected: true`. */
export async function inTransit(exec: Exec, limit = 30): Promise<LinenBatchCard[]> {
  const rows = await exec.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.state, "sent"))
    .orderBy(asc(linenLaundryBatches.sentAt)).limit(limit);
  return batchCards(exec, rows);
}

/**
 * WEEKLY LOSS VARIANCE per ward per item, for the window [from, to) the caller passes:
 *
 *   missing = opening + issued − returned − counted
 *
 * where `counted` is the ward's LAST count inside the window, `opening` is its last count BEFORE the window (0 when it
 * was never counted before), `issued` = issued from the store + borrowed in, and `returned` = soiled + infected
 * returns + borrowed out + condemned — all between the opening count and the closing count. With no earlier count this
 * is exactly the spec's "issued − (returned soiled + infected + on hand by last count)". A ward-item with no count in
 * the window has no variance (it is listed by the board as "not counted", not guessed). Positive = pieces lost.
 *
 * ONE BOUNDARY RULE, shared with `bookBalances`: a movement at exactly a count's instant happened AFTER the count.
 */
export async function weeklyVariance(exec: Exec, from: Date, to: Date): Promise<LinenVarianceRow[]> {
  const f = from.toISOString();
  const t = to.toISOString();
  const r = await exec.execute<{
    w: string; ward_name: string; i: string; opening: string; counted: string; counted_at: Date | string; issued: string; returned: string;
  }>(sql`
    with closing as (
      select distinct on (ward_resource_id, item_code) ward_resource_id as w, item_code as i, on_hand, counted_at
        from linen_ward_counts where counted_at >= ${f}::timestamptz and counted_at < ${t}::timestamptz
       order by ward_resource_id, item_code, counted_at desc, id desc
    ), opening as (
      select distinct on (ward_resource_id, item_code) ward_resource_id as w, item_code as i, on_hand, counted_at
        from linen_ward_counts where counted_at < ${f}::timestamptz
       order by ward_resource_id, item_code, counted_at desc, id desc
    ), mv as (
      select ward_resource_id as w, item_code as i, at,
             case when kind = 'issue_to_ward' then qty else 0 end as issued,
             case when kind = 'issue_to_ward' then 0 else qty end as returned
        from linen_movements
       where ward_resource_id is not null
         and kind in ('issue_to_ward', 'return_soiled', 'return_infected', 'condemn', 'transfer_between_wards')
      union all
      select to_ward_resource_id, item_code, at, qty, 0 from linen_movements where kind = 'transfer_between_wards'
    )
    select c.w, r.name as ward_name, c.i, coalesce(o.on_hand, 0) as opening, c.on_hand as counted, c.counted_at,
           coalesce(sum(m.issued), 0) as issued, coalesce(sum(m.returned), 0) as returned
      from closing c
      join resources r on r.id = c.w
      left join opening o on o.w = c.w and o.i = c.i
      left join mv m on m.w = c.w and m.i = c.i and m.at < c.counted_at and (o.counted_at is null or m.at >= o.counted_at)
     group by c.w, r.name, c.i, o.on_hand, c.on_hand, c.counted_at`);
  return r.rows.map((row) => {
    const opening = Number(row.opening);
    const issued = Number(row.issued);
    const returned = Number(row.returned);
    const counted = Number(row.counted);
    return {
      wardId: row.w, wardName: row.ward_name, itemCode: row.i, opening, issued, returned, counted,
      countedAt: new Date(row.counted_at).toISOString(), missing: opening + issued - returned - counted,
    };
  }).sort((a, b) => b.missing - a.missing || a.wardName.localeCompare(b.wardName) || a.itemCode.localeCompare(b.itemCode));
}

/** The last seven IST days ending with today (DECIDED: the board's "week" is rolling). */
export function rollingWeek(now: Date): { from: Date; to: Date } {
  const { end } = istDayWindow(now);
  return { from: new Date(end.getTime() - 7 * 86_400_000), to: end };
}

async function laundryToday(exec: Exec, now: Date): Promise<LinenBoardView["laundryToday"]> {
  const { start, end } = istDayWindow(now);
  const r = await exec.execute<{ out_n: string; in_n: string; inf_n: string }>(sql`
    select coalesce(sum(m.qty) filter (where m.kind = 'laundry_out'), 0) as out_n,
           coalesce(sum(m.qty) filter (where m.kind = 'laundry_in'), 0) as in_n,
           coalesce(sum(m.qty) filter (where m.kind = 'laundry_out' and b.infected), 0) as inf_n
      from linen_movements m join linen_laundry_batches b on b.id = m.batch_id
     where m.at >= ${start.toISOString()}::timestamptz and m.at < ${end.toISOString()}::timestamptz`);
  const shortN = await exec.select({ n: sql<string>`coalesce(sum(${linenVariances.short}), 0)` }).from(linenVariances)
    .where(and(gte(linenVariances.recordedAt, start), lt(linenVariances.recordedAt, end)));
  const row = r.rows[0]!;
  return { outPieces: Number(row.out_n), inPieces: Number(row.in_n), infectedOutPieces: Number(row.inf_n), shortPieces: Number(shortN[0]?.n ?? 0) };
}

async function recentShorts(exec: Exec, limit = 6): Promise<LinenShortRecord[]> {
  const rows = await exec.select({
    id: linenVariances.id, batchNo: linenLaundryBatches.batchNo, itemCode: linenVariances.itemCode, sent: linenVariances.sent,
    received: linenVariances.received, short: linenVariances.short, recordedAt: linenVariances.recordedAt,
  }).from(linenVariances).innerJoin(linenLaundryBatches, eq(linenLaundryBatches.id, linenVariances.batchId))
    .orderBy(desc(linenVariances.recordedAt)).limit(limit);
  return rows.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() }));
}

export async function condemnPending(exec: Exec, limit = 20): Promise<LinenCondemnCard[]> {
  const rows = await exec.select({
    id: linenCondemnRequests.id, wardId: linenCondemnRequests.wardResourceId, wardName: resources.name, itemCode: linenCondemnRequests.itemCode,
    qty: linenCondemnRequests.qty, reason: linenCondemnRequests.reason, state: linenCondemnRequests.state,
    requestedBy: linenCondemnRequests.requestedBy, requestedByName: users.fullName, requestedAt: linenCondemnRequests.requestedAt,
  }).from(linenCondemnRequests)
    .leftJoin(resources, eq(resources.id, linenCondemnRequests.wardResourceId))
    .leftJoin(users, eq(users.id, linenCondemnRequests.requestedBy))
    .where(eq(linenCondemnRequests.state, "requested")).orderBy(asc(linenCondemnRequests.requestedAt)).limit(limit);
  return rows.map((r) => ({
    ...r, wardName: r.wardName ?? null, state: r.state as LinenCondemnCard["state"], requestedByName: r.requestedByName ?? r.requestedBy,
    requestedAt: r.requestedAt.toISOString(),
  }));
}

/** The supervisor's board (16:9). `week` defaults to the rolling seven IST days ending today. */
export async function linenBoard(exec: Exec, now: Date, week: { from: Date; to: Date } = rollingWeek(now)): Promise<LinenBoardView> {
  const wards = await wardStates(exec, now);
  const today = await laundryToday(exec, now);
  const transit = await inTransit(exec);
  const shorts = await recentShorts(exec);
  const variance = await weeklyVariance(exec, week.from, week.to);
  const pending = await condemnPending(exec);
  const items = await linenItemList(exec);
  return {
    serverNow: now.toISOString(),
    counts: { wards: wards.length, belowPar: wards.filter((w) => w.belowPar).length, shortPieces: wards.reduce((n, w) => n + w.shortPieces, 0) },
    wards, laundryToday: today, inTransit: transit, shorts,
    variance: { from: week.from.toISOString(), to: week.to.toISOString(), top: variance.filter((v) => v.missing > 0).slice(0, 5) },
    condemnPending: pending, items,
  };
}

/** The handler's phone: every ward with its par and on hand, the catalogue, the soiled room, batches at the laundry. */
export async function linenHandlerView(exec: Exec, now: Date): Promise<LinenHandlerView> {
  const wards = await wardStates(exec, now);
  const items = await linenItemList(exec);
  const soiled = await soiledPool(exec);
  const transit = await inTransit(exec);
  return { serverNow: now.toISOString(), wards: [...wards].sort((a, b) => a.wardName.localeCompare(b.wardName)), items, soiled, inTransit: transit };
}
