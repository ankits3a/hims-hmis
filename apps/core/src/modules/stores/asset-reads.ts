import { eq, sql } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { grnLines, grns, storesAssetUnits, vendors } from "../../kernel/db/schema";
import { STORES_MASTERS, holds, recordAct } from "./access";
import { categoryRules, itemRules } from "./asset-rules";
import {
  ASSET_WORDS, STORES_ASSETS_EXPORT, STORES_ASSETS_MANAGE, STORES_ASSETS_READ, departmentNameOf, duesOf, itemName, lastTag, missingUnits, needsReplace,
  readsAll, unitStates,
} from "./assets";
import { csvCell } from "./audit-pack";
import { StoresError } from "./errors";
import { holdersOf } from "./tickets";
import type { UnitState } from "./assets";
import type { Actor, WireAssetAddition, WireAssetDueRow, WireEquipmentReceived, WireRedCard } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S4a (#1114, decisions 5, 7, 8, 15, 19) — what the asset register owes: the ledger check, due dates and their
 * reminders, the tower's asset red cards, the month's additions for Tally, equipment received apart from spend.
 * Everything here is a READ of derived state, except the reminders (notices, once each by source key) and the export's
 * one audit event.
 */

/* ═══════════════════════════════ decision 5: units ≠ ledger ═══════════════════════════════ */

export type LedgerDifference = { batchId: string; storeId: string; units: number; ledger: number };

/**
 * For every FULLY TAGGED batch (as many units as entered it by GRN or opening) and every store: the live units whose
 * derived place is that store against the batch's ledger balance there. Returns each pair that differs. It reads only:
 * a difference is a card for a person, never a correction of either side.
 */
export async function assetLedgerCheck(db: Db, now: Date = new Date()): Promise<{ at: string; differences: LedgerDifference[] }> {
  const rows = await db.execute(sql`
    with places as (
      select distinct on (e.unit_id) e.unit_id, e.store_id from stores_asset_unit_events e
       where e.store_id is not null and e.kind in ('tagged', 'placed', 'moved', 'out_on_pass', 'back', 'transferred', 'found')
       order by e.unit_id, e.seq desc
    ), ended as (
      select distinct on (e.unit_id) e.unit_id, e.kind from stores_asset_unit_events e
       where e.kind in ('disposed', 'written_off', 'found') order by e.unit_id, e.seq desc
    ), entered as (
      select l.batch_id, sum(l.qty_delta)::int as n from stock_ledger l
       where l.batch_id in (select batch_id from stores_asset_units) and (l.reason = 'grn' or l.ref_type = 'opening_balance')
         -- S4b (#1114): a written-off unit found again re-enters on an opening row naming its write-off; that is not a new unit.
         and not (l.ref_type = 'opening_balance' and l.ref_id in (select id from stock_write_offs))
       group by l.batch_id
    ), made as (
      select batch_id, count(*)::int as n from stores_asset_units group by batch_id
    ), full_batches as (
      select m.batch_id from made m join entered e on e.batch_id = m.batch_id where m.n >= e.n
    ), live as (
      select u.batch_id, p.store_id, count(*)::int as n from stores_asset_units u join places p on p.unit_id = u.id
       left join ended x on x.unit_id = u.id
       where u.batch_id in (select batch_id from full_batches) and (x.kind is null or x.kind = 'found')
         -- S4b (#1114): a sold unit is off the books from its write-off until the guard's exit scan writes "Disposed".
         and not exists (select 1 from stores_scrap_sales s where s.unit_id = u.id)
       group by u.batch_id, p.store_id
    ), led as (
      select b.batch_id, b.resource_id as store_id, b.qty_on_hand as n from stock_balances b
       where b.batch_id in (select batch_id from full_batches) and b.qty_on_hand <> 0
    )
    select coalesce(l.batch_id, g.batch_id) as batch_id, coalesce(l.store_id, g.store_id) as store_id,
           coalesce(l.n, 0) as units, coalesce(g.n, 0) as ledger
      from live l full join led g on g.batch_id = l.batch_id and g.store_id = l.store_id
     where coalesce(l.n, 0) <> coalesce(g.n, 0)
     order by 1, 2`);
  return {
    at: now.toISOString(),
    differences: (rows.rows as { batch_id: string; store_id: string; units: number; ledger: number }[])
      .map((r) => ({ batchId: r.batch_id, storeId: r.store_id, units: Number(r.units), ledger: Number(r.ledger) })),
  };
}

/* ═══════════════════════════════ decisions 7, 8: what is due ═══════════════════════════════ */

function dueRows(s: UnitState, name: string, now: Date): WireAssetDueRow[] {
  const d = duesOf(s, now);
  const base = { unitId: s.unit.id, tagNo: lastTag(s), name, place: s.place.name };
  const out: WireAssetDueRow[] = [];
  for (const what of ["warranty", "amc", "calibration"] as const) {
    const due = d[what];
    if (due !== null && due.word !== "ok") out.push({ ...base, what, word: due.word, date: due.date });
  }
  if (needsReplace(s, now)) out.push({ ...base, what: "replace", word: "due_soon", date: null });
  return out;
}

/** `/stores/assets` Due: every warranty, AMC and calibration due soon or overdue, and every "Replace?". Overdue first. */
export async function assetsDue(db: Db, actor: Actor, now: Date = new Date()): Promise<{ rows: WireAssetDueRow[] }> {
  if (!(await readsAll(db, actor))) throw new StoresError("not_permitted", "No permission", { permission: STORES_ASSETS_READ });
  const states = [...(await unitStates(db)).values()].filter((s) => s.ended === null);
  const names = new Map<string, string>();
  const rows: WireAssetDueRow[] = [];
  for (const s of states) {
    if (!names.has(s.unit.itemId)) names.set(s.unit.itemId, await itemName(db, s.unit.itemId));
    rows.push(...dueRows(s, names.get(s.unit.itemId)!, now));
  }
  const rank = { overdue: 0, due_soon: 1, ok: 2 } as const;
  return { rows: rows.sort((a, b) => rank[a.word] - rank[b.word] || (a.date ?? "").localeCompare(b.date ?? "") || a.tagNo.localeCompare(b.tagNo)) };
}

/**
 * Decision 7: the reminders, ridden by the chaser's minute sweep. AMC/CMC and warranty within 30 days of their end,
 * calibration within 15 days of due (and past it): one notice each to biomedical and the materials head, ONCE (the
 * source key names the unit, the kind and the date, so a new contract is reminded afresh).
 */
export async function runAssetReminders(db: Db, now: Date = new Date()): Promise<number> {
  const states = [...(await unitStates(db)).values()].filter((s) => s.ended === null);
  const due = states.flatMap((s) => {
    const d = duesOf(s, now);
    return ([["amc", d.amc], ["warranty", d.warranty], ["calibration", d.calibration]] as const)
      .filter(([, x]) => x !== null && x.word !== "ok").map(([what, x]) => ({ s, what, date: x!.date }));
  });
  if (due.length === 0) return 0;
  const to = [...new Set([...(await holdersOf(db, STORES_ASSETS_MANAGE, "hospital")), ...(await holdersOf(db, STORES_MASTERS, "hospital"))])];
  let sent = 0;
  for (const r of due) {
    const name = await itemName(db, r.s.unit.itemId);
    const words = ASSET_WORDS[r.what];
    for (const u of to) {
      const won = await raiseNotice(db, {
        userId: u, kind: "stores.asset", title: words[0], body: `${words[1]} · ${name} · ${lastTag(r.s).slice(-4)} · ${r.date}`,
        refType: "stores_asset", refId: r.s.unit.id, sourceKey: `stores-asset:${r.s.unit.id}:${r.what}:${r.date}`, at: now,
      });
      if (won) sent += 1;
    }
  }
  return sent;
}

/** The tower's asset red cards (decision 7, edge case 10, decision 5): calibration overdue, AMC lapsed, missing, units ≠ ledger. */
export async function assetRedCards(db: Db, now: Date): Promise<(WireRedCard & { at: number })[]> {
  const out: (WireRedCard & { at: number })[] = [];
  const today = istDayString(now);
  const MIN = 60_000;
  const card = (c: Omit<WireRedCard, "since" | "minutes" | "clock" | "indentId" | "shelfId" | "passId">, since: Date): WireRedCard & { at: number } => ({
    ...c, clock: null, indentId: null, shelfId: null, passId: null, since: since.toISOString(), minutes: Math.max(0, Math.round((now.getTime() - since.getTime()) / MIN)),
    at: since.getTime(),
  });
  const states = [...(await unitStates(db)).values()].filter((s) => s.ended === null);
  const missing = await missingUnits(db);
  for (const s of states) {
    const name = await itemName(db, s.unit.itemId);
    const what = `${name} · ${lastTag(s).slice(-4)}`;
    if (s.calibration !== null && s.calibration.dueOn < today) {
      out.push(card({ id: `calibration:${s.unit.id}`, kind: "calibration", what, where: s.place.name, unitId: s.unit.id }, new Date(`${s.calibration.dueOn}T00:00:00+05:30`)));
    }
    if (s.contract !== null && s.contract.end < today) {
      out.push(card({ id: `amc:${s.unit.id}`, kind: "amc", what, where: s.place.name, unitId: s.unit.id }, new Date(`${s.contract.end}T23:59:59+05:30`)));
    }
    if (missing.has(s.unit.id)) out.push(card({ id: `missing:${s.unit.id}`, kind: "missing", what, where: s.place.name, unitId: s.unit.id }, s.placeEvent.occurredAt));
  }
  const check = await assetLedgerCheck(db, now);
  if (check.differences.length > 0) {
    const ids = check.differences.map((d) => d.storeId);
    const names = new Map((await db.execute(sql`select id, name from resources where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).rows
      .map((r) => [(r as { id: string }).id, (r as { name: string }).name] as const));
    for (const d of check.differences) {
      out.push(card({ id: `units_ledger:${d.batchId}:${d.storeId}`, kind: "units_ledger", what: `${String(d.units)} ≠ ${String(d.ledger)}`, where: names.get(d.storeId) ?? "", unitId: null }, now));
    }
  }
  return out;
}

/* ═══════════════════════════════ decision 15: the month's additions for Tally ═══════════════════════════════ */

function monthOk(month: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new StoresError("bad_window", "a month is YYYY-MM");
}

async function requireExport(db: Db, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_ASSETS_EXPORT))) throw new StoresError("not_permitted", "No permission", { permission: STORES_ASSETS_EXPORT });
}

const ADDITION_HEAD = ["Tag", "Item", "Category", "Department", "Put to use", "Cost before GST (paise)", "GST (paise)", "Input credit", "GRN", "Bill", "Bill date", "Supplier"];

/**
 * Every unit bought through a GRN and put to use in the IST month (the installation date biomedical recorded, else the
 * day it first reached a department shelf): cost before GST, the GST on it, the input-credit mark (blank until S6),
 * put-to-use date, category, department, GRN, and the supplier's bill. HMIS computes no depreciation. One audit event
 * per export (`asset_export`).
 */
export async function assetAdditions(db: Db, actor: Actor, month: string, now: Date = new Date()): Promise<{ month: string; rows: WireAssetAddition[]; csv: string }> {
  await requireExport(db, actor);
  monthOk(month);
  const states = [...(await unitStates(db)).values()].filter((s) => s.unit.origin === "grn" && s.putToUse !== null && s.putToUse.startsWith(month));
  const rows: WireAssetAddition[] = [];
  for (const s of states) {
    const [g] = await db.select({ grnNo: grns.grnNo, invoiceNo: grns.invoiceNo, invoiceDate: grns.invoiceDate, vendor: vendors.legalName })
      .from(grnLines).innerJoin(grns, eq(grns.id, grnLines.grnId)).innerJoin(vendors, eq(vendors.id, grns.vendorId)).where(eq(grnLines.id, s.unit.grnLineId!));
    const rules = await itemRules(db, s.unit.itemId);
    const [ic] = (await db.execute(sql`select category_id from items where id = ${s.unit.itemId}`)).rows as { category_id: string | null }[];
    const cat = await categoryRules(db, ic?.category_id ?? null);
    const deptStore = s.firstShelfAt?.storeId ?? (s.place.kind === "shelf" ? s.place.id : null);
    const cost = (s.corrected.unitCostPaise as number | undefined) ?? s.unit.unitCostPaise;
    rows.push({
      unitId: s.unit.id, tagNo: lastTag(s), name: rules.name, category: cat.topName, department: deptStore === null ? "" : await departmentNameOf(db, deptStore),
      putToUse: s.putToUse!, costPaise: cost, gstPaise: cost === null || rules.gstRateBps === null ? null : Math.round((cost * rules.gstRateBps) / 10_000), inputCredit: null,
      grnNo: g?.grnNo ?? "", billNo: g?.invoiceNo ?? null, billDate: g?.invoiceDate ?? null, supplier: g?.vendor ?? null,
    });
  }
  rows.sort((a, b) => a.putToUse.localeCompare(b.putToUse) || a.tagNo.localeCompare(b.tagNo));
  const csv = [ADDITION_HEAD.join(","), ...rows.map((r) => [r.tagNo, r.name, r.category, r.department, r.putToUse, r.costPaise, r.gstPaise, "", r.grnNo, r.billNo, r.billDate, r.supplier].map(csvCell).join(","))].join("\n");
  await withTx(db, (tx) => recordAct(tx, actor, now, { act: "asset_export", after: { kind: "additions", month, rows: rows.length } }));
  return { month, rows, csv };
}

/** Decision 11: the opening units whose cost nobody knew, for accounts to fill once. */
export async function assetsCostUnknown(db: Db, actor: Actor): Promise<{ rows: { unitId: string; tagNo: string; name: string; place: string }[] }> {
  if (!(await readsAll(db, actor)) && !(await holds(db, actor, STORES_ASSETS_EXPORT))) throw new StoresError("not_permitted", "No permission", { permission: STORES_ASSETS_READ });
  const ids = (await db.select({ id: storesAssetUnits.id }).from(storesAssetUnits).where(sql`${storesAssetUnits.unitCostPaise} is null`)).map((r) => r.id);
  const states = [...(await unitStates(db, ids)).values()].filter((s) => s.corrected.unitCostPaise === undefined && s.ended === null);
  const rows = [];
  for (const s of states) rows.push({ unitId: s.unit.id, tagNo: lastTag(s), name: await itemName(db, s.unit.itemId), place: s.place.name });
  return { rows: rows.sort((a, b) => a.tagNo.localeCompare(b.tagNo)) };
}

/**
 * Decision 19: a tagged unit received by a department is "Equipment received", apart from the month's consumable spend
 * (`departmentSpendByMonth` leaves tagged batches out). The unit's first arrival at a department shelf in the IST month.
 */
export async function equipmentReceivedByMonth(db: Db, month: string): Promise<WireEquipmentReceived[]> {
  monthOk(month);
  const states = [...(await unitStates(db)).values()].filter((s) => s.firstShelfAt !== null && istDayString(s.firstShelfAt.at).startsWith(month));
  const out: WireEquipmentReceived[] = [];
  for (const s of states) {
    const shelf = s.firstShelfAt!;
    const [r] = (await db.execute(sql`select attributes->>'departmentId' as dept from resources where id = ${shelf.storeId}`)).rows as { dept: string | null }[];
    if (r?.dept == null) continue;
    out.push({ unitId: s.unit.id, tagNo: lastTag(s), name: await itemName(db, s.unit.itemId), departmentId: r.dept, departmentName: await departmentNameOf(db, shelf.storeId), at: shelf.at.toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

