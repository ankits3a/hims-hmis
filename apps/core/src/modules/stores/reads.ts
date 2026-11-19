import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { events, itemStockLevels, opdEncounters, orgDepartments, resources, stockBatches, stockLedger } from "../../kernel/db/schema";
import { balances, transferWorklist } from "../materials";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  STORES_MASTERS, STORES_SHELF_READ, STORES_SHELF_WORK, departmentOf, holds, requireMasters, requireShelf, requireShelfAct,
} from "./access";
import { STORES_ACT_EVENT } from "./events";
import { StoresError } from "./errors";
import { listStoresItems } from "./items";
import { listShelves } from "./shelves";
import { REVERSAL_REF } from "./use";
import type { OverBookCard, ShelfItemView, ShelfStatusWord, ShelfView } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S1 (#1111) — WHAT A SHELF READS (decisions 9, 13, 14).
 *
 * Use is NET: `consume` rows at the shelf less their reversals (`adjust`, `ref_type = 'reversal'`), so a
 * wrong "Used" undone in the sheet does not inflate the use rate. Days and months are the hospital's
 * (IST), read off `occurred_at`. No figure on the shelf view is money: department staff see quantities
 * and status words; the department's charge is a separate read for the materials head.
 */
const DAY_MS = 86_400_000;
const IST = "Asia/Kolkata";

const netUse = sql<string>`coalesce(sum(case when ${stockLedger.reason} = 'consume' or ${stockLedger.refType} = ${REVERSAL_REF} then -${stockLedger.qtyDelta} else 0 end), 0)`;

const istDay = istDayString;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function statusOf(onHand: number, par: { reorderBase: number } | null): ShelfStatusWord {
  if (onHand <= 0) return "out";
  if (par !== null && onHand <= par.reorderBase) return "low";
  return "ok";
}

/** item → the instant of the last check that counted it at this shelf. */
async function lastChecks(db: Db, shelfId: string): Promise<Map<string, string>> {
  const rows = await db.select({ at: events.occurredAt, payload: events.payload }).from(events)
    .where(and(eq(events.name, STORES_ACT_EVENT), sql`${events.payload}->>'act' = 'check'`, sql`${events.payload}->>'storeId' = ${shelfId}`))
    .orderBy(desc(events.seq)).limit(200);
  const out = new Map<string, string>();
  for (const r of rows) {
    for (const l of ((r.payload as { lines?: { itemId?: string }[] }).lines ?? [])) {
      if (typeof l.itemId === "string" && !out.has(l.itemId)) out.set(l.itemId, r.at.toISOString());
    }
  }
  return out;
}

export async function shelfView(db: Db, actor: Actor, shelfId: string, now: Date): Promise<ShelfView> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "read");
  const summary = (await listShelves(db, { departmentId: shelf.departmentId })).find((s) => s.id === shelf.id)!;
  const dept = await departmentOf(db, shelf.departmentId);

  const onHand = new Map<string, number>();
  for (const b of await balances(db, { resourceId: shelf.id })) onHand.set(b.itemId, (onHand.get(b.itemId) ?? 0) + b.qtyOnHand);
  const levels = new Map((await db.select().from(itemStockLevels).where(eq(itemStockLevels.storeResourceId, shelf.id)))
    .map((l) => [l.itemId, { minBase: l.minBase, reorderBase: l.reorderBase, maxBase: l.maxBase }]));
  const wanted = new Set([...onHand.keys(), ...levels.keys()]);
  const master = (await listStoresItems(db)).filter((i) => wanted.has(i.id));

  const since = new Date(now.getTime() - 30 * DAY_MS);
  const used = new Map((await db.select({ itemId: stockLedger.itemId, used: netUse }).from(stockLedger).where(and(
    eq(stockLedger.resourceId, shelf.id), gte(stockLedger.occurredAt, since), sql`${stockLedger.occurredAt} < ${now}`,
  )).groupBy(stockLedger.itemId)).map((r) => [r.itemId, Number(r.used)]));

  // Decision 13: per OPD visit for a department that runs a clinic (OPD is live).
  let visits: number | null = null;
  if (dept.opdDepartmentId !== null) {
    const [v] = await db.select({ n: sql<number>`count(*)::int` }).from(opdEncounters).where(and(
      eq(opdEncounters.departmentId, dept.opdDepartmentId), ne(opdEncounters.status, "abandoned"),
      gte(opdEncounters.serviceDate, istDay(since)), lte(opdEncounters.serviceDate, istDay(now)),
    ));
    visits = v?.n ?? 0;
  }
  const checks = await lastChecks(db, shelf.id);

  const rows: ShelfItemView[] = master.map((i) => {
    const have = onHand.get(i.id) ?? 0;
    const par = levels.get(i.id) ?? null;
    const u = used.get(i.id) ?? 0;
    return {
      itemId: i.id, code: i.code, name: i.name, baseUom: i.baseUom, trackMode: i.trackMode, onHand: have,
      status: statusOf(have, par), par, lastCheckAt: checks.get(i.id) ?? null,
      usePerDay30: round2(u / 30),
      usePerOpdVisit: visits === null || visits === 0 ? null : round2(u / visits),
      // Per occupied bed-day once IPD is live; IPD is off production (owner 2026-10-13), so it is null.
      usePerBedDay: null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const { awaiting } = await transferWorklist(db, { storeId: shelf.id });
  return {
    shelf: summary,
    items: rows,
    arriving: awaiting.filter((t) => t.to.id === shelf.id).map((t) => ({
      transferId: t.id, fromName: t.from.name, issuedAt: t.issuedAt,
      lines: t.lines.map((l) => ({ lineId: l.id, itemId: l.itemId, name: l.itemName, qty: l.qtyIssued })),
    })),
    may: { work: await holds(db, actor, STORES_SHELF_WORK, shelf.departmentId) },
  };
}

/** Decision 13 / HK-2: a floor shelf's use per item in one IST month (`YYYY-MM`), net of reversals. */
export async function floorShelfUseByMonth(db: Db, actor: Actor, shelfId: string, month: string): Promise<{ itemId: string; used: number }[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new StoresError("bad_quantity", "a month is YYYY-MM", { month });
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "read");
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(m + 1).padStart(2, "0")}`;
  const localAt = sql`(${stockLedger.occurredAt} at time zone ${IST})`;
  const rows = await db.select({ itemId: stockLedger.itemId, used: netUse }).from(stockLedger).where(and(
    eq(stockLedger.resourceId, shelf.id), sql`${localAt} >= ${`${month}-01`}::timestamp`, sql`${localAt} < ${`${next}-01`}::timestamp`,
  )).groupBy(stockLedger.itemId);
  return rows.map((r) => ({ itemId: r.itemId, used: Number(r.used) })).filter((r) => r.used !== 0);
}

/**
 * Decision 8: a department's charge on one IST day — Σ quantity × batch cost over the receipt rows INTO its
 * shelves that carry its cost centre. Money: the materials head's read, never a department screen's.
 */
export async function departmentChargeOn(db: Db, departmentCode: string, day: string): Promise<{ chargePaise: number; rows: number }> {
  // S2b (#1112, decision 10): a department's RETURN received by a store carries the department's cost centre on the
  // store's receipt leg, and credits it: the receipt into a shelf counts +, the receipt into any other store −,
  // both at the batch's cost. A pharmacy row carries no cost centre and is never read here.
  const [r] = await db.select({
    paise: sql<string>`coalesce(sum(case when ${resources.attributes}->>'kind' = 'shelf' then 1 else -1 end * ${stockLedger.qtyDelta}::bigint * ${stockBatches.landedCostPaise}), 0)`,
    n: sql<number>`count(*)::int`,
  }).from(stockLedger).innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId)).innerJoin(resources, eq(resources.id, stockLedger.resourceId))
    .where(and(
      eq(stockLedger.costCenter, departmentCode), eq(stockLedger.reason, "receive"), sql`${stockLedger.qtyDelta} > 0`,
      sql`(${stockLedger.occurredAt} at time zone ${IST})::date = ${day}::date`,
    ));
  return { chargePaise: Number(r?.paise ?? 0), rows: r?.n ?? 0 };
}

/** Decision 9: the "More than book" cards — every shelf check that counted an item above its book. */
export async function overBookCards(db: Db, actor: Actor, limit = 50): Promise<OverBookCard[]> {
  await requireMasters(db, actor);
  const rows = await db.select({ eventId: events.eventId, at: events.occurredAt, payload: events.payload }).from(events)
    .where(and(eq(events.name, STORES_ACT_EVENT), sql`${events.payload}->>'act' = 'check'`, sql`${events.payload}->>'reason' = 'more_than_book'`))
    .orderBy(desc(events.seq)).limit(limit);
  if (rows.length === 0) return [];
  type Line = { itemId: string; before: number; after: number; overBook?: boolean };
  const p = rows.map((r) => ({ ...r, payload: r.payload as { storeId: string; refId: string; lines: Line[] } }));
  const shelfIds = [...new Set(p.map((r) => r.payload.storeId))];
  const names = new Map((await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, shelfIds))).map((s) => [s.id, s.name]));
  const itemNames = new Map((await listStoresItems(db)).map((i) => [i.id, i.name]));
  return p.map((r) => ({
    cardId: r.eventId, shelfId: r.payload.storeId, shelfName: names.get(r.payload.storeId) ?? "", checkId: r.payload.refId, at: r.at.toISOString(),
    lines: r.payload.lines.filter((l) => l.overBook === true).map((l) => ({ itemId: l.itemId, name: itemNames.get(l.itemId) ?? "", book: l.before, counted: l.after })),
  }));
}

/** The shelves this person may open: every shelf whose department they read (all of them for the materials head). */
export async function myShelves(db: Db, actor: Actor): Promise<Awaited<ReturnType<typeof listShelves>>> {
  const all = await listShelves(db);
  if (await holds(db, actor, STORES_MASTERS)) return all;
  const out: typeof all = [];
  const seen = new Map<string, boolean>();
  for (const s of all) {
    if (s.departmentId === null) continue;
    if (!seen.has(s.departmentId)) seen.set(s.departmentId, await holds(db, actor, STORES_SHELF_READ, s.departmentId));
    if (seen.get(s.departmentId) === true) out.push(s);
  }
  return out;
}

/** What the "Add shelf" form picks from: the floors (registry `floor` resources) and the org departments. */
export async function storesPickers(db: Db): Promise<{ floors: { id: string; code: string; name: string }[]; departments: { id: string; code: string; name: string }[] }> {
  const floors = await db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(and(eq(resources.kind, "floor"), ne(resources.status, "retired"))).orderBy(resources.code);
  const departments = await db.select({ id: orgDepartments.id, code: orgDepartments.code, name: orgDepartments.name }).from(orgDepartments)
    .where(eq(orgDepartments.active, true)).orderBy(orgDepartments.name);
  return { floors, departments };
}
