import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  episodeSeries, items, resources, roleAssignments, rolePermissions, storesAssetUnitEvents, storesAssetUnits, storesGatePasses, users, vendors,
} from "../../kernel/db/schema";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { OUT_ON_PASS_STORE_CODE, TRANSIT_STORE_CODE, ensureTransitStore, issueStock, postOpeningBalances } from "../materials";
import {
  STORES_MASTERS, STORES_SHELF_READ, STORES_SHELF_WORK, departmentOf, holds, isStoresStore, recordAct, requireShelf, requireShelfAct, requireStoresStore,
  toStoresStore,
} from "./access";
import { itemRules, tagDecisionFor, unitsOfLine } from "./asset-rules";
import { StoresError } from "./errors";
import { holdersOf, keepsStore } from "./tickets";
import { receiveAtShelf } from "./use";
import type {
  StoresAssetStatus, StoresDueWord, WireAssetDue, WireAssetEvent, WireAssetLookup, WireAssetNext, WireAssetPassportFull, WireAssetRegisterRow,
  WireTagLine,
} from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S4a (#1114, decisions 2–11, 17) — THE ASSET PASSPORT: one QR per physical unit, written once
 * (`stores_asset_units`), and every later fact a unit event (`stores_asset_unit_events`, append-only in the database).
 *
 * Place, holder, status and due dates are DERIVED from the events every time (programme I4): the latest event that
 * carries a `store_id` is where the unit is. A tagged unit is ONE base unit of its batch in `stock_ledger`, so every
 * act that moves a unit moves the ledger in the same transaction (an issue on a ticket, a receipt, a gate pass, a
 * transfer), and `assetLedgerCheck` proves the two never disagree; it never "fixes" either side.
 *
 * Who: `stores.assets.manage` (biomedical, the materials head) tags, records contracts, calibration and repairs, and
 * links a device; the receiving keeper also tags at the GRN. `stores.assets.read` reads every unit, cost included. A
 * department's shelf-grant holders read their own units (no cost); anyone else with a shelf grant who scans a unit sees
 * only its name, tag and "Belongs to …" with Found here.
 */
export const STORES_ASSETS_MANAGE = "stores.assets.manage";
export const STORES_ASSETS_READ = "stores.assets.read";
export const STORES_ASSETS_EXPORT = "stores.assets.export";
/** The label with the unit's QR (the tag number only). Rendered by `asset-label.ts`. */
export const ASSET_LABEL_DOCUMENT = "stores_asset_label";

const TAG_RE = /^AST\d{10}$/;
const LAST4_RE = /^\d{4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60_000;
/** Decision 7: warranty and AMC remind 30 days ahead, calibration 15. */
export const DUE_SOON_DAYS = { warranty: 30, amc: 30, calibration: 15 } as const;
/** Decision 8: the third fault inside 30 days puts "Replace?" on the passport. */
export const REPLACE_FAULTS = 3;
export const REPLACE_WINDOW_MS = 30 * DAY_MS;

/** Notices, verbatim (spec #1114 "Notices"): a few words, English and Hindi. */
export const ASSET_WORDS = {
  amc: ["AMC ends in 30 days", "AMC 30 दिन में खत्म"],
  warranty: ["Warranty ends in 30 days", "वारंटी 30 दिन में खत्म"],
  calibration: ["Calibration due", "कैलिब्रेशन बाकी"],
  replace: ["Replace?", "बदलें?"],
  notSeen: ["Asset not seen", "संपत्ति नहीं मिली"],
  elsewhere: ["Your unit is elsewhere", "आपकी यूनिट दूसरी जगह"],
  toAccept: ["Unit to accept", "यूनिट स्वीकारें"],
} as const;
const NOTICE_KIND = "stores.asset";

type UnitRow = typeof storesAssetUnits.$inferSelect;
type EventRow = typeof storesAssetUnitEvents.$inferSelect;
export type UnitEventKind = EventRow["kind"];

const clean = (s: string | null | undefined): string | null => (s == null || s.trim() === "" ? null : s.trim());

// ═══════════════════════════════ writing events ═══════════════════════════════

export type NewUnitEvent = {
  unitId: string; kind: string; storeId?: string | null; refType?: string | null; refId?: string | null; data?: Record<string, unknown>; occurredAt?: Date;
};

/** Appends unit events in the caller's transaction. `occurredAt` defaults to `now`. */
export async function appendUnitEvents(tx: Tx | Db, actor: Actor, now: Date, rows: readonly NewUnitEvent[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(() => newId());
  await (tx as Db).insert(storesAssetUnitEvents).values(rows.map((r, i) => ({
    id: ids[i]!, unitId: r.unitId, kind: r.kind, storeId: r.storeId ?? null, refType: r.refType ?? null, refId: r.refId ?? null,
    data: r.data ?? {}, actorId: actor.id, occurredAt: r.occurredAt ?? now, recordedAt: now,
  })));
  return ids;
}

/** `AST` + yymm + 6 digits, from the shared `episode_series` counter (key `asset_tag`, one row per IST month). */
async function nextTagNo(tx: Tx, now: Date): Promise<string> {
  const month = `${istDayString(now).slice(0, 7)}-01`;
  await (tx as Db).insert(episodeSeries).values({ seriesKey: "asset_tag", serviceDate: month, nextNo: 1 }).onConflictDoNothing();
  const rows = await (tx as Db).update(episodeSeries).set({ nextNo: sql`${episodeSeries.nextNo} + 1` })
    .where(and(eq(episodeSeries.seriesKey, "asset_tag"), eq(episodeSeries.serviceDate, month))).returning({ n: episodeSeries.nextNo });
  const n = rows[0]!.n - 1;
  if (n > 999_999) throw new StoresError("bad_quantity", "the month's tag series is full");
  return `AST${month.slice(2, 4)}${month.slice(5, 7)}${String(n).padStart(6, "0")}`;
}

/** Every tag number ever bound to a unit (live or voided): a tag is bound once in the whole house. */
async function tagIsBound(db: Db | Tx, tagNo: string): Promise<boolean> {
  const r = await (db as Db).select({ id: storesAssetUnitEvents.id }).from(storesAssetUnitEvents)
    .where(and(inArray(storesAssetUnitEvents.kind, ["tagged", "retagged"]), sql`${storesAssetUnitEvents.data}->>'tagNo' = ${tagNo}`)).limit(1);
  return r.length > 0;
}

async function bindTag(tx: Tx, given: string | undefined, now: Date): Promise<string> {
  if (given === undefined) return nextTagNo(tx, now);
  if (!TAG_RE.test(given)) throw new StoresError("unknown_tag", "a tag number is AST and ten digits");
  if (await tagIsBound(tx, given)) throw new StoresError("tag_bound", "Tag already used", { tagNo: given });
  return given;
}

// ═══════════════════════════════ deriving a unit's state ═══════════════════════════════

export type StoreInfo = { id: string; code: string; name: string; kind: string; departmentId: string | null };

export type UnitState = {
  unit: UnitRow;
  events: EventRow[];
  place: StoreInfo;
  placeEvent: EventRow;
  liveTags: string[];
  voidedTags: string[];
  openRepair: boolean;
  faults: Date[];
  warrantyEnd: string | null;
  contract: { kind: string; end: string; supplierName: string | null } | null;
  calibration: { doneOn: string; dueOn: string; agency: string } | null;
  installedOn: string | null;
  putToUse: string | null;
  firstShelfAt: { at: Date; storeId: string } | null;
  deviceId: string | null;
  pendingTransfer: { eventId: string; toShelfId: string; proposedBy: string } | null;
  corrected: Record<string, unknown>;
  ended: "disposed" | "written_off" | "condemned" | null;
};

const PLACE_KINDS = new Set(["tagged", "placed", "moved", "out_on_pass", "back", "transferred", "found"]);

async function storeInfos(db: Db | Tx, ids: readonly string[]): Promise<Map<string, StoreInfo>> {
  const want = [...new Set(ids)];
  if (want.length === 0) return new Map();
  const rows = await (db as Db).select().from(resources).where(inArray(resources.id, want));
  return new Map(rows.map((r) => {
    const s = isStoresStore(r) ? toStoresStore(r) : null;
    const kind = s?.kind ?? (r.code === TRANSIT_STORE_CODE ? "transit" : r.code === OUT_ON_PASS_STORE_CODE ? "out_on_pass" : "other");
    return [r.id, { id: r.id, code: r.code, name: r.name, kind, departmentId: s?.departmentId ?? null }] as const;
  }));
}

function derive(unit: UnitRow, events: EventRow[], stores: Map<string, StoreInfo>): UnitState {
  let placeEvent = events[0]!;
  const live: string[] = [];
  const voided: string[] = [];
  let openRepair = false;
  const faults: Date[] = [];
  let warrantyEnd: string | null = null;
  let contract: UnitState["contract"] = null;
  let calibration: UnitState["calibration"] = null;
  let installedOn: string | null = null;
  let openingPutToUse: string | null = null;
  let firstShelfAt: UnitState["firstShelfAt"] = null;
  let deviceId: string | null = null;
  let pending: UnitState["pendingTransfer"] = null;
  const corrected: Record<string, unknown> = {};
  let ended: UnitState["ended"] = null;
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    if (e.storeId !== null && PLACE_KINDS.has(e.kind)) {
      placeEvent = e;
      if (firstShelfAt === null && stores.get(e.storeId)?.kind === "shelf") firstShelfAt = { at: e.occurredAt, storeId: e.storeId };
    }
    switch (e.kind) {
      case "tagged":
        live.push(String(d.tagNo));
        if (typeof d.putToUse === "string") openingPutToUse = d.putToUse;
        break;
      case "retagged": live.push(String(d.tagNo)); break;
      case "tag_voided": {
        const i = live.indexOf(String(d.tagNo));
        if (i >= 0) live.splice(i, 1);
        voided.push(String(d.tagNo));
        break;
      }
      case "repair_opened": openRepair = true; break;
      case "repair_closed": openRepair = false; break;
      case "fault_reported": faults.push(e.occurredAt); break;
      case "warranty_set": warrantyEnd = typeof d.end === "string" ? d.end : null; break;
      case "contract_set": contract = { kind: String(d.kind), end: String(d.end), supplierName: typeof d.supplierName === "string" ? d.supplierName : null }; break;
      case "calibrated": calibration = { doneOn: String(d.doneOn), dueOn: String(d.dueOn), agency: String(d.agency) }; break;
      case "installed": installedOn = typeof d.on === "string" ? d.on : null; break;
      case "device_linked": deviceId = typeof d.deviceId === "string" ? d.deviceId : null; break;
      case "transfer_proposed": pending = { eventId: e.id, toShelfId: String(d.toShelfId), proposedBy: e.actorId }; break;
      case "transferred": pending = null; break;
      case "corrected": if (typeof d.field === "string") corrected[d.field] = d.after; break;
      case "condemned": ended = "condemned"; break;
      case "disposed": ended = "disposed"; break;
      case "written_off": ended = "written_off"; break;
      case "found": ended = null; break;
      default: break;
    }
  }
  const putToUse = installedOn ?? openingPutToUse ?? (firstShelfAt === null ? null : istDayString(firstShelfAt.at));
  return {
    unit, events, place: stores.get(placeEvent.storeId!) ?? { id: placeEvent.storeId!, code: "", name: "", kind: "other", departmentId: null },
    placeEvent, liveTags: live, voidedTags: voided, openRepair, faults, warrantyEnd, contract, calibration, installedOn, putToUse, firstShelfAt,
    deviceId, pendingTransfer: pending, corrected, ended,
  };
}

/** The derived state of each unit (all units when `unitIds` is omitted). */
export async function unitStates(db: Db | Tx, unitIds?: readonly string[]): Promise<Map<string, UnitState>> {
  if (unitIds !== undefined && unitIds.length === 0) return new Map();
  const units = unitIds === undefined
    ? await (db as Db).select().from(storesAssetUnits)
    : await (db as Db).select().from(storesAssetUnits).where(inArray(storesAssetUnits.id, [...new Set(unitIds)]));
  if (units.length === 0) return new Map();
  const evs = await (db as Db).select().from(storesAssetUnitEvents)
    .where(inArray(storesAssetUnitEvents.unitId, units.map((u) => u.id))).orderBy(asc(storesAssetUnitEvents.seq));
  const byUnit = new Map<string, EventRow[]>();
  for (const e of evs) byUnit.set(e.unitId, [...(byUnit.get(e.unitId) ?? []), e]);
  const stores = await storeInfos(db, [...evs.map((e) => e.storeId).filter((x): x is string => x !== null),
    ...evs.map((e) => (e.data as { toShelfId?: unknown; shelfId?: unknown })).flatMap((d) => [d.toShelfId, d.shelfId]).filter((x): x is string => typeof x === "string")]);
  const out = new Map<string, UnitState>();
  for (const u of units) {
    const list = byUnit.get(u.id);
    if (list !== undefined && list.length > 0) out.set(u.id, derive(u, list, stores));
  }
  return out;
}

export async function unitState(db: Db | Tx, unitId: string): Promise<UnitState> {
  const s = (await unitStates(db, [unitId])).get(unitId);
  if (s === undefined) throw new StoresError("unknown_unit", "no such unit", { unitId });
  return s;
}

function dueWord(date: string, today: string, soonDays: number): StoresDueWord {
  if (date < today) return "overdue";
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  return days <= soonDays ? "due_soon" : "ok";
}

export function duesOf(s: UnitState, now: Date): { warranty: WireAssetDue | null; amc: WireAssetDue | null; calibration: WireAssetDue | null; next: WireAssetNext | null } {
  const today = istDayString(now);
  const mk = (date: string | null, soon: number): WireAssetDue | null => (date === null ? null : { date, word: dueWord(date, today, soon) });
  const warranty = mk(s.warrantyEnd, DUE_SOON_DAYS.warranty);
  const amc = mk(s.contract?.end ?? null, DUE_SOON_DAYS.amc);
  const calibration = mk(s.calibration?.dueOn ?? null, DUE_SOON_DAYS.calibration);
  const all = ([["warranty", warranty], ["amc", amc], ["calibration", calibration]] as const)
    .filter((x): x is [typeof x[0], WireAssetDue] => x[1] !== null).sort((a, b) => a[1].date.localeCompare(b[1].date));
  const first = all[0];
  return { warranty, amc, calibration, next: first === undefined ? null : { what: first[0], date: first[1].date, word: first[1].word } };
}

/** Three faults inside 30 days, the newest of them no older than 30 days: "Replace?". */
export function needsReplace(s: UnitState, now: Date): boolean {
  const recent = s.faults.filter((f) => now.getTime() - f.getTime() <= REPLACE_WINDOW_MS);
  return recent.length >= REPLACE_FAULTS;
}

type PassInfo = { passId: string; passNo: string; purpose: string; dueBack: string };
async function passOf(db: Db | Tx, s: UnitState): Promise<PassInfo | null> {
  if (s.placeEvent.kind !== "out_on_pass" || s.placeEvent.refId === null) return null;
  const [p] = await (db as Db).select().from(storesGatePasses).where(eq(storesGatePasses.id, s.placeEvent.refId));
  return p === undefined ? null : { passId: p.id, passNo: p.passNo, purpose: p.purpose ?? "repair", dueBack: p.dueBack ?? "" };
}

/** The latest closed round of the unit's department did not see it, and nothing has placed or seen it since. */
async function missingUnits(db: Db | Tx): Promise<Set<string>> {
  const rows = await (db as Db).execute(sql`
    select distinct on (v.department_id) v.department_id, v.at, v.result from stores_asset_verifications v
     where v.kind = 'close' order by v.department_id, v.at desc`);
  const out = new Set<string>();
  for (const r of rows.rows as { at: Date | string; result: { notSeen?: { unitId: string }[] } | null }[]) {
    const ids = (r.result?.notSeen ?? []).map((n) => n.unitId);
    if (ids.length === 0) continue;
    const since = new Date(r.at);
    const later = await (db as Db).select({ unitId: storesAssetUnitEvents.unitId }).from(storesAssetUnitEvents)
      .where(and(inArray(storesAssetUnitEvents.unitId, ids), sql`${storesAssetUnitEvents.recordedAt} > ${since}`,
        sql`(${storesAssetUnitEvents.storeId} is not null or ${storesAssetUnitEvents.kind} in ('verified_seen', 'seen_elsewhere', 'found'))`));
    const seen = new Set(later.map((l) => l.unitId));
    for (const id of ids) if (!seen.has(id)) out.add(id);
  }
  return out;
}

export async function statusOf(db: Db | Tx, s: UnitState, now: Date, missing?: Set<string>): Promise<{ status: StoresAssetStatus; out: PassInfo | null }> {
  if (s.ended !== null) return { status: s.ended, out: null };
  const pass = await passOf(db, s);
  if (pass !== null) return { status: pass.dueBack !== "" && pass.dueBack < istDayString(now) ? "overdue" : "out_repair", out: pass };
  if (s.place.kind === "transit" || s.pendingTransfer !== null) return { status: "on_its_way", out: null };
  if (s.openRepair) return { status: "under_repair", out: null };
  if ((missing ?? (await missingUnits(db))).has(s.unit.id)) return { status: "missing", out: null };
  return { status: s.place.kind === "shelf" ? "in_use" : "in_store", out: null };
}

// ═══════════════════════════════ who may ═══════════════════════════════

/** True when the person holds a shelf grant at ANY department (the gate for a foreign scan). */
async function holdsShelfAnywhere(db: Db | Tx, actor: Actor): Promise<boolean> {
  if (actor.type !== "user") return false;
  const [row] = await (db as Db).select({ u: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .where(and(eq(roleAssignments.userId, actor.id), inArray(rolePermissions.permission, [STORES_SHELF_READ, STORES_SHELF_WORK]))).limit(1);
  return row !== undefined;
}

export async function requireAssetsManage(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await holds(db, actor, STORES_ASSETS_MANAGE))) {
    throw new StoresError("not_permitted", "biomedical or the materials head records this", { permission: STORES_ASSETS_MANAGE });
  }
}

async function readsAll(db: Db | Tx, actor: Actor): Promise<boolean> {
  return (await holds(db, actor, STORES_ASSETS_READ)) || (await holds(db, actor, STORES_ASSETS_MANAGE)) || (await holds(db, actor, STORES_MASTERS));
}

/** The department a unit belongs to: its place's, or (on a pass, in transit) the department of the last shelf it sat at. */
function homeDepartmentOf(s: UnitState, stores?: Map<string, StoreInfo>): string | null {
  if (s.place.departmentId !== null) return s.place.departmentId;
  for (let i = s.events.length - 1; i >= 0; i -= 1) {
    const e = s.events[i]!;
    if (e.storeId !== null && PLACE_KINDS.has(e.kind)) {
      const st = stores?.get(e.storeId);
      if (st?.departmentId != null) return st.departmentId;
    }
  }
  return null;
}

async function seesUnit(db: Db | Tx, actor: Actor, s: UnitState): Promise<boolean> {
  if (await readsAll(db, actor)) return true;
  const dept = homeDepartmentOf(s);
  if (dept !== null && (await holds(db, actor, STORES_SHELF_READ, dept))) return true;
  if (dept !== null && (await holds(db, actor, STORES_SHELF_WORK, dept))) return true;
  // The receiving department of an open transfer sees it to accept it.
  if (s.pendingTransfer !== null) {
    const to = await requireShelf(db, s.pendingTransfer.toShelfId).catch(() => null);
    if (to !== null && ((await holds(db, actor, STORES_SHELF_WORK, to.departmentId)) || (await holds(db, actor, STORES_SHELF_READ, to.departmentId)))) return true;
  }
  if (s.place.kind !== "shelf" && s.place.kind !== "other") {
    const store = await requireStoresStore(db, s.place.id).catch(() => null);
    if (store !== null && (await keepsStore(db, actor, store))) return true;
  }
  return false;
}

async function worksAt(db: Db | Tx, actor: Actor, departmentId: string | null): Promise<boolean> {
  return departmentId !== null && (await holds(db, actor, STORES_SHELF_WORK, departmentId));
}

// ═══════════════════════════════ the passport ═══════════════════════════════

async function names(db: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids)].filter((x) => x !== "");
  if (want.length === 0) return new Map();
  return new Map((await (db as Db).select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, want))).map((u) => [u.id, u.n] as const));
}

function noteOf(e: EventRow): string | null {
  const d = e.data as Record<string, unknown>;
  for (const k of ["text", "note", "outcome", "reason", "tagNo", "end", "dueOn", "on"]) if (typeof d[k] === "string" && d[k] !== "") return d[k];
  return null;
}

async function eventViews(db: Db | Tx, s: UnitState, limit = 5): Promise<WireAssetEvent[]> {
  const last = [...s.events].reverse().slice(0, limit);
  const who = await names(db, last.map((e) => e.actorId));
  const where = await storeInfos(db, last.flatMap((e) => [e.storeId, (e.data as { shelfId?: unknown }).shelfId]).filter((x): x is string => typeof x === "string"));
  return last.map((e) => {
    const sid = e.storeId ?? (typeof (e.data as { shelfId?: unknown }).shelfId === "string" ? String((e.data as { shelfId: string }).shelfId) : null);
    return { kind: e.kind, at: e.occurredAt.toISOString(), by: { id: e.actorId, name: who.get(e.actorId) ?? "" }, where: sid === null ? null : where.get(sid)?.name ?? null, note: noteOf(e) };
  });
}

async function itemName(db: Db | Tx, itemId: string): Promise<string> {
  return (await (db as Db).select({ n: items.name }).from(items).where(eq(items.id, itemId)))[0]?.n ?? "";
}

async function fullPassport(db: Db | Tx, actor: Actor, s: UnitState, now: Date, tagReplaced: boolean): Promise<WireAssetPassportFull> {
  const { status, out } = await statusOf(db, s, now);
  const dues = duesOf(s, now);
  const dept = s.place.departmentId === null ? null : await departmentOf(db, s.place.departmentId);
  let device: WireAssetPassportFull["device"] = null;
  if (s.deviceId !== null) {
    const [r] = await (db as Db).select().from(resources).where(eq(resources.id, s.deviceId));
    if (r !== undefined) device = { id: r.id, code: r.code, name: r.name, status: r.status };
  }
  let transfer: WireAssetPassportFull["transfer"] = null;
  if (s.pendingTransfer !== null) {
    const to = await requireShelf(db, s.pendingTransfer.toShelfId);
    const who = await names(db, [s.pendingTransfer.proposedBy]);
    transfer = { toShelfId: to.id, toDepartmentName: (await departmentOf(db, to.departmentId)).name, proposedBy: { id: s.pendingTransfer.proposedBy, name: who.get(s.pendingTransfer.proposedBy) ?? "" } };
  }
  const manage = await holds(db, actor, STORES_ASSETS_MANAGE);
  const works = (await worksAt(db, actor, s.place.departmentId)) || manage;
  let acceptTransfer = false;
  if (s.pendingTransfer !== null && s.pendingTransfer.proposedBy !== actor.id) {
    const to = await requireShelf(db, s.pendingTransfer.toShelfId);
    acceptTransfer = await worksAt(db, actor, to.departmentId);
  }
  const tagNo = s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo;
  const view: WireAssetPassportFull = {
    access: "full", tagReplaced,
    unit: {
      id: s.unit.id, tagNo, last4: tagNo.slice(-4), name: await itemName(db, s.unit.itemId), itemId: s.unit.itemId,
      serial: (s.corrected.serial as string | undefined) ?? s.unit.serial, make: (s.corrected.make as string | undefined) ?? s.unit.make,
      model: (s.corrected.model as string | undefined) ?? s.unit.model, liveTags: s.liveTags, origin: s.unit.origin as "grn" | "opening",
    },
    status, out, transfer,
    place: { id: s.place.id, code: s.place.code, name: s.place.name, kind: s.place.kind },
    department: dept === null ? null : { id: dept.id, name: dept.name },
    putToUse: s.putToUse,
    dues: { warranty: dues.warranty, amc: dues.amc, calibration: dues.calibration }, next: dues.next,
    events: await eventViews(db, s),
    device, replace: needsReplace(s, now),
    can: {
      reportFault: s.ended === null && (works || (await worksAt(db, actor, homeDepartmentOf(s)))),
      addDetails: manage && s.ended === null,
      transfer: s.ended === null && s.place.kind === "shelf" && s.pendingTransfer === null && (await worksAt(db, actor, s.place.departmentId)),
      foundHere: false, acceptTransfer,
    },
  };
  if (await holds(db, actor, STORES_ASSETS_READ)) view.costPaise = (s.corrected.unitCostPaise as number | undefined) ?? s.unit.unitCostPaise;
  return view;
}

/** Resolve a scanned or typed code: a full tag (live or voided) or the last four, the reader's departments first. */
async function unitsByCode(db: Db | Tx, actor: Actor, code: string): Promise<{ unitIds: string[]; voided: boolean }> {
  const c = code.trim().toUpperCase();
  if (TAG_RE.test(c)) {
    const rows = await (db as Db).select({ unitId: storesAssetUnitEvents.unitId }).from(storesAssetUnitEvents)
      .where(and(inArray(storesAssetUnitEvents.kind, ["tagged", "retagged"]), sql`${storesAssetUnitEvents.data}->>'tagNo' = ${c}`)).limit(1);
    if (rows.length === 0) return { unitIds: [], voided: false };
    const s = await unitState(db, rows[0]!.unitId);
    return { unitIds: [rows[0]!.unitId], voided: !s.liveTags.includes(c) };
  }
  if (!LAST4_RE.test(c)) return { unitIds: [], voided: false };
  const rows = await (db as Db).select({ unitId: storesAssetUnitEvents.unitId, tagNo: sql<string>`${storesAssetUnitEvents.data}->>'tagNo'` }).from(storesAssetUnitEvents)
    .where(and(inArray(storesAssetUnitEvents.kind, ["tagged", "retagged"]), sql`${storesAssetUnitEvents.data}->>'tagNo' like ${`%${c}`}`)).limit(50);
  const states = await unitStates(db, rows.map((r) => r.unitId));
  const live = [...states.values()].filter((s) => s.liveTags.some((t) => t.endsWith(c)) && s.ended === null);
  const mine: string[] = [];
  for (const s of live) {
    const dept = homeDepartmentOf(s);
    if (dept !== null && ((await holds(db, actor, STORES_SHELF_READ, dept)) || (await holds(db, actor, STORES_SHELF_WORK, dept)))) mine.push(s.unit.id);
  }
  return { unitIds: mine.length > 0 ? mine : live.map((s) => s.unit.id), voided: false };
}

/**
 * Decision 3 and the flow's step 4: the passport of one unit, by id or by a scanned / typed code. The reader's
 * department sees the whole passport (no cost); `stores.assets.read` sees the cost too; anyone else with a shelf grant
 * sees "Belongs to …" and Found here, nothing more; nobody else.
 */
export async function assetPassport(db: Db | Tx, actor: Actor, by: { unitId?: string; code?: string }, now: Date = new Date()): Promise<WireAssetLookup> {
  let unitId = by.unitId;
  let voided = false;
  if (unitId === undefined) {
    const found = await unitsByCode(db, actor, by.code ?? "");
    if (found.unitIds.length === 0) throw new StoresError("unknown_unit", "no unit has that tag", { code: by.code });
    if (found.unitIds.length > 1) {
      const states = await unitStates(db, found.unitIds);
      const out = [];
      for (const s of states.values()) {
        const tag = s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo;
        out.push({ unitId: s.unit.id, tagNo: tag, name: await itemName(db, s.unit.itemId), place: s.place.name });
      }
      return { access: "choose", matches: out.sort((a, b) => a.tagNo.localeCompare(b.tagNo)) };
    }
    unitId = found.unitIds[0]!;
    voided = found.voided;
  }
  const s = await unitState(db, unitId);
  if (await seesUnit(db, actor, s)) return fullPassport(db, actor, s, now, voided);
  if (await holdsShelfAnywhere(db, actor)) {
    const deptId = homeDepartmentOf(s);
    const dept = deptId === null ? null : await departmentOf(db, deptId);
    const tagNo = s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo;
    return {
      access: "foreign", tagReplaced: voided,
      unit: { id: s.unit.id, tagNo, name: await itemName(db, s.unit.itemId) },
      belongsTo: { departmentId: dept?.id ?? null, departmentName: dept?.name ?? s.place.name },
    };
  }
  throw new StoresError("not_permitted", "not your department", { unitId });
}

// ═══════════════════════════════ tagging at the GRN (decision 1, flow step 1) ═══════════════════════════════

async function mayTagAt(db: Db | Tx, actor: Actor, storeId: string): Promise<boolean> {
  if (await holds(db, actor, STORES_ASSETS_MANAGE)) return true;
  const store = await requireStoresStore(db, storeId).catch(() => null);
  return store !== null && (await keepsStore(db, actor, store));
}

/** One posted GRN line's tagging: the decision, how many units it has and owes. */
export async function grnLineTagging(db: Db | Tx, grnLineId: string, now: Date): Promise<WireTagLine | null> {
  const d = await tagDecisionFor(db, grnLineId, now);
  if (d === null) return null;
  const units = await unitsOfLine(db, grnLineId);
  return {
    grnLineId, grnNo: d.grnNo, itemId: d.itemId, itemName: await itemName(db, d.itemId), qty: d.qty, tagged: units.length, decision: d.result,
    units: units.map((u) => ({ id: u.id, tagNo: u.tagNo, serial: u.serial })),
  };
}

/**
 * Tag the units of a posted GRN line: one unit row, one `tagged` event at the GRN's store, one label print job each.
 * Make from the item master, cost (before GST) and supplier from the GRN line. The serial is scanned or typed (optional
 * for furniture); a pre-printed tag number may be given and is refused when already bound (`tag_bound`).
 */
export async function tagUnits(
  db: Db, actor: Actor, input: { grnLineId: string; units: readonly { serial?: string | null; tagNo?: string }[] }, now: Date = new Date(),
): Promise<{ units: { id: string; tagNo: string }[]; line: WireTagLine }> {
  if (input.units.length === 0) throw new StoresError("bad_quantity", "tag at least one unit");
  // The line's decision is recorded first, on its own: a refusal below still leaves "counted" or "tagged" on file.
  await tagDecisionFor(db, input.grnLineId, now);
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-tag:${input.grnLineId}`}))`);
    const d = await tagDecisionFor(tx, input.grnLineId, now);
    if (d === null || d.result !== "tagged") throw new StoresError("not_tagged_batch", "this line is counted, not tagged", { grnLineId: input.grnLineId, decision: d?.result ?? null });
    const [grn] = (await tx.execute(sql`select store_resource_id from grns where id = ${d.grnId}`)).rows as { store_resource_id: string }[];
    const storeId = grn!.store_resource_id;
    if (!(await mayTagAt(tx, actor, storeId))) throw new StoresError("not_permitted", "the receiving keeper or biomedical tags units", { permission: STORES_ASSETS_MANAGE });
    const have = (await unitsOfLine(tx, input.grnLineId)).length;
    if (have + input.units.length > d.qty) throw new StoresError("bad_quantity", `this line has ${String(d.qty)} units; ${String(have)} are tagged`, { qty: d.qty, tagged: have });
    const rules = await itemRules(tx, d.itemId);
    const seenSerials = new Set<string>();
    const out: { id: string; tagNo: string }[] = [];
    for (const u of input.units) {
      const serial = clean(u.serial);
      if (serial !== null) {
        const k = serial.toLowerCase();
        const dup = seenSerials.has(k) || (await tx.select({ id: storesAssetUnits.id }).from(storesAssetUnits)
          .where(and(eq(storesAssetUnits.itemId, d.itemId), sql`lower(${storesAssetUnits.serial}) = ${k}`)).limit(1)).length > 0;
        if (dup) throw new StoresError("serial_exists", "Serial already exists", { serial });
        seenSerials.add(k);
      }
      const tagNo = await bindTag(tx, u.tagNo, now);
      const id = newId();
      await tx.insert(storesAssetUnits).values({
        id, itemId: d.itemId, tagNo, serial, make: rules.manufacturer, model: rules.name, origin: "grn", grnLineId: d.grnLineId, batchId: d.batchId,
        unitCostPaise: d.unitCostPaise, supplierId: d.supplierId, createdBy: actor.id, createdAt: now,
      });
      await appendUnitEvents(tx, actor, now, [{ unitId: id, kind: "tagged", storeId, refType: "grn_line", refId: d.grnLineId, data: { tagNo } }]);
      await enqueuePrintJob(tx, { document: ASSET_LABEL_DOCUMENT, params: { unitId: id }, dedupeKey: `stores-asset-label:${id}:${tagNo}`, requestedBy: actor.id });
      out.push({ id, tagNo });
    }
    await recordAct(tx, actor, now, {
      act: "tag_units", storeId, itemId: d.itemId, refId: d.grnLineId, before: have, after: have + out.length,
      lines: out.map((u) => ({ unitId: u.id, tagNo: u.tagNo })),
    });
    return { units: out, line: (await grnLineTagging(tx, input.grnLineId, now))! };
  });
}

/** Decision 10: void one tag of a unit (with the reason). The unit stays; scanning the old tag answers "Tag replaced". */
export async function voidTag(db: Db, actor: Actor, unitId: string, input: { tagNo: string; reason: string }, now: Date = new Date()): Promise<WireAssetLookup> {
  await requireAssetsManage(db, actor);
  const reason = clean(input.reason);
  if (reason === null) throw new StoresError("reason_required", "say why the tag is voided");
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (!s.liveTags.includes(input.tagNo)) throw new StoresError("unknown_tag", "that tag is not live on this unit", { tagNo: input.tagNo });
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "tag_voided", data: { tagNo: input.tagNo, reason } }]);
    await recordAct(tx, actor, now, { act: "void_tag", itemId: s.unit.itemId, refId: unitId, before: input.tagNo, after: null, reason });
  });
  return assetPassport(db, actor, { unitId }, now);
}

/** Decision 10: a lost or torn tag is reprinted with a NEW number; every live tag of the unit is voided first. */
export async function retag(db: Db, actor: Actor, unitId: string, input: { reason: string; tagNo?: string }, now: Date = new Date()): Promise<{ tagNo: string }> {
  await requireAssetsManage(db, actor);
  const reason = clean(input.reason);
  if (reason === null) throw new StoresError("reason_required", "say why the unit is re-tagged");
  return withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
    const tagNo = await bindTag(tx, input.tagNo, now);
    await appendUnitEvents(tx, actor, now, [
      ...s.liveTags.map((t) => ({ unitId, kind: "tag_voided", data: { tagNo: t, reason } })),
      { unitId, kind: "retagged", data: { tagNo, reason } },
    ]);
    await enqueuePrintJob(tx, { document: ASSET_LABEL_DOCUMENT, params: { unitId }, dedupeKey: `stores-asset-label:${unitId}:${tagNo}`, requestedBy: actor.id });
    await recordAct(tx, actor, now, { act: "retag", itemId: s.unit.itemId, refId: unitId, before: s.liveTags, after: tagNo, reason });
    return { tagNo };
  });
}

// ═══════════════════════════════ the opening sweep (decision 11) ═══════════════════════════════

/**
 * Existing equipment, tagged once at go-live, department by department: the item from the master (never free text),
 * serial, make, model, cost if known (else "Cost unknown"), put-to-use date if known. One opening ledger row at its
 * place with no cost centre (materials `postOpeningBalances`, one batch per unit). The same item and serial twice is
 * refused (`already_opened`).
 */
export async function openUnit(
  db: Db, actor: Actor,
  input: { storeId: string; itemId: string; serial?: string | null; make?: string | null; model?: string | null; unitCostPaise: number | null; putToUse?: string | null; tagNo?: string },
  now: Date = new Date(),
): Promise<{ unitId: string; tagNo: string }> {
  await requireAssetsManage(db, actor);
  const store = await requireStoresStore(db, input.storeId);
  const rules = await itemRules(db, input.itemId);
  if (rules.trackMode !== "tagged" && !(rules.trackMode === "durable" && rules.tagRule !== "never")) {
    throw new StoresError("not_tagged_batch", "this item is not tagged", { itemId: input.itemId });
  }
  if (input.unitCostPaise !== null && (!Number.isSafeInteger(input.unitCostPaise) || input.unitCostPaise < 0)) throw new StoresError("bad_quantity", "a cost is paise, zero or more");
  const putToUse = clean(input.putToUse);
  if (putToUse !== null && (!DAY_RE.test(putToUse) || putToUse > istDayString(now))) throw new StoresError("bad_window", "a put-to-use date is a day, not in the future");
  const serial = clean(input.serial);
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-open-unit:${input.itemId}`}))`);
    if (serial !== null) {
      const dup = await tx.select({ id: storesAssetUnits.id }).from(storesAssetUnits)
        .where(and(eq(storesAssetUnits.itemId, input.itemId), sql`lower(${storesAssetUnits.serial}) = ${serial.toLowerCase()}`)).limit(1);
      if (dup.length > 0) throw new StoresError("already_opened", "this unit is already on the register", { unitId: dup[0]!.id });
    }
    const tagNo = await bindTag(tx, input.tagNo, now);
    const id = newId();
    const { batchIds } = await postOpeningBalances(tx, actor, {
      resourceId: store.id, refId: id, occurredAt: now,
      lines: [{ itemId: input.itemId, qtyBase: 1, unitCostPaise: input.unitCostPaise, batchNo: `OPEN-${store.code}-${tagNo}` }],
    });
    await tx.insert(storesAssetUnits).values({
      id, itemId: input.itemId, tagNo, serial, make: clean(input.make) ?? rules.manufacturer, model: clean(input.model) ?? rules.name, origin: "opening",
      grnLineId: null, batchId: batchIds[0]!, unitCostPaise: input.unitCostPaise, supplierId: null, createdBy: actor.id, createdAt: now,
    });
    await appendUnitEvents(tx, actor, now, [{ unitId: id, kind: "tagged", storeId: store.id, refType: "opening", refId: id, data: { tagNo, opening: true, putToUse } }]);
    await enqueuePrintJob(tx, { document: ASSET_LABEL_DOCUMENT, params: { unitId: id }, dedupeKey: `stores-asset-label:${id}:${tagNo}`, requestedBy: actor.id });
    await recordAct(tx, actor, now, { act: "open_unit", storeId: store.id, itemId: input.itemId, refId: id, after: { tagNo, costKnown: input.unitCostPaise !== null } });
    return { unitId: id, tagNo };
  });
}

/** Decision 11: accounts fill a "Cost unknown" unit's cost once, from their fixed-asset register. The fill is an event. */
export async function fillUnitCost(db: Db, actor: Actor, unitId: string, unitCostPaise: number, now: Date = new Date()): Promise<void> {
  if (!(await holds(db, actor, STORES_ASSETS_EXPORT)) && !(await holds(db, actor, STORES_ASSETS_MANAGE))) {
    throw new StoresError("not_permitted", "accounts fill the cost", { permission: STORES_ASSETS_EXPORT });
  }
  if (!Number.isSafeInteger(unitCostPaise) || unitCostPaise < 0) throw new StoresError("bad_quantity", "a cost is paise, zero or more");
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.unit.unitCostPaise !== null || s.corrected.unitCostPaise !== undefined) throw new StoresError("already_decided", "this unit's cost is known");
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "corrected", data: { field: "unitCostPaise", before: null, after: unitCostPaise } }]);
    await recordAct(tx, actor, now, { act: "fill_cost", itemId: s.unit.itemId, refId: unitId, before: null, after: unitCostPaise });
  });
}

// ═══════════════════════════════ details: warranty, AMC/CMC, calibration, installation (decisions 6, 7) ═══════════════════════════════

export type AssetDetailsInput = {
  warrantyEnd?: string | null;
  contract?: { kind: "amc" | "cmc"; supplierId?: string | null; start: string; end: string; poRef?: string | null } | null;
  calibration?: { doneOn: string; dueOn: string; agency: string; documentId?: string | null } | null;
  installedOn?: string | null;
};

/** "Add details": biomedical fills only what the system cannot know. One event per fact, in one transaction. */
export async function addAssetDetails(db: Db, actor: Actor, unitId: string, input: AssetDetailsInput, now: Date = new Date()): Promise<WireAssetLookup> {
  await requireAssetsManage(db, actor);
  const day = (v: string, what: string): string => {
    if (!DAY_RE.test(v) || Number.isNaN(Date.parse(v))) throw new StoresError("bad_window", `${what} is a day (YYYY-MM-DD)`);
    return v;
  };
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
    const rows: NewUnitEvent[] = [];
    if (input.warrantyEnd != null) rows.push({ unitId, kind: "warranty_set", data: { end: day(input.warrantyEnd, "a warranty end") } });
    if (input.contract != null) {
      const c = input.contract;
      if (day(c.end, "a contract end") < day(c.start, "a contract start")) throw new StoresError("bad_window", "a contract ends after it starts");
      let supplierName: string | null = null;
      if (c.supplierId != null) {
        const [v] = await tx.select({ n: vendors.legalName }).from(vendors).where(eq(vendors.id, c.supplierId));
        if (v === undefined) throw new StoresError("unknown_supplier", "choose the supplier from the list");
        supplierName = v.n;
      }
      rows.push({ unitId, kind: "contract_set", refType: c.poRef == null ? null : "po", refId: clean(c.poRef), data: { kind: c.kind, supplierId: c.supplierId ?? null, supplierName, start: c.start, end: c.end } });
    }
    if (input.calibration != null) {
      const c = input.calibration;
      if (day(c.dueOn, "a calibration due date") < day(c.doneOn, "a calibration date")) throw new StoresError("bad_window", "calibration falls due after it was done");
      const agency = clean(c.agency);
      if (agency === null) throw new StoresError("reason_required", "name the calibration agency");
      rows.push({ unitId, kind: "calibrated", data: { doneOn: c.doneOn, dueOn: c.dueOn, agency, documentId: c.documentId ?? null } });
    }
    if (input.installedOn != null) {
      const on = day(input.installedOn, "an installation date");
      const grnDay = istDayString(s.unit.createdAt);
      if (on > istDayString(now) || (s.unit.origin === "grn" && on < grnDay)) throw new StoresError("bad_window", "installed on or after the GRN, and not in the future");
      rows.push({ unitId, kind: "installed", data: { on } });
    }
    if (rows.length === 0) throw new StoresError("bad_quantity", "nothing to record");
    await appendUnitEvents(tx, actor, now, rows);
    await recordAct(tx, actor, now, { act: "asset_details", itemId: s.unit.itemId, refId: unitId, after: rows.map((r) => r.kind) });
  });
  return assetPassport(db, actor, { unitId }, now);
}

/** Decision 9: link the unit to a radiology or lab `device` resource. Read-only: Stores never writes a device status. */
export async function linkDevice(db: Db, actor: Actor, unitId: string, deviceResourceId: string, now: Date = new Date()): Promise<WireAssetLookup> {
  await requireAssetsManage(db, actor);
  const [r] = await db.select().from(resources).where(eq(resources.id, deviceResourceId));
  if (r === undefined || r.kind !== "device") throw new StoresError("unknown_device", "choose a device from the list", { deviceResourceId });
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "device_linked", refType: "resource", refId: r.id, data: { deviceId: r.id } }]);
    await recordAct(tx, actor, now, { act: "link_device", itemId: s.unit.itemId, refId: unitId, before: s.deviceId, after: r.id });
  });
  return assetPassport(db, actor, { unitId }, now);
}

// ═══════════════════════════════ faults and repairs (decision 8, flow step 5) ═══════════════════════════════

async function materialsHeads(db: Db | Tx): Promise<string[]> {
  return holdersOf(db, STORES_MASTERS, "hospital");
}

async function tell(tx: Tx, users_: readonly string[], words: readonly [string, string], unit: { id: string; tag: string; name: string }, key: string, now: Date, extra = ""): Promise<void> {
  for (const u of [...new Set(users_)]) {
    await raiseNotice(tx as unknown as Db, {
      userId: u, kind: NOTICE_KIND, title: words[0], body: `${words[1]} · ${unit.name} · ${unit.tag.slice(-4)}${extra === "" ? "" : ` · ${extra}`}`,
      refType: "stores_asset", refId: unit.id, sourceKey: `stores-asset:${unit.id}:${key}`, at: now,
    });
  }
}

/** The department in-charge (or biomedical) reports a fault: one line. The third in 30 days tells the materials head "Replace?". */
export async function reportFault(db: Db, actor: Actor, unitId: string, input: { text: string }, now: Date = new Date()): Promise<WireAssetLookup> {
  const text = clean(input.text);
  if (text === null) throw new StoresError("reason_required", "say what is wrong, in one line");
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
    if (!(await worksAt(tx, actor, homeDepartmentOf(s))) && !(await holds(tx, actor, STORES_ASSETS_MANAGE))) {
      throw new StoresError("not_permitted", "not your department", { permission: STORES_SHELF_WORK });
    }
    const [eventId] = await appendUnitEvents(tx, actor, now, [{ unitId, kind: "fault_reported", data: { text: text.slice(0, 200) } }]);
    await recordAct(tx, actor, now, { act: "report_fault", storeId: s.place.id, itemId: s.unit.itemId, refId: unitId, reason: text.slice(0, 200) });
    const after = { ...s, faults: [...s.faults, now] };
    const unit = { id: unitId, tag: s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo, name: await itemName(tx, s.unit.itemId) };
    if (needsReplace(after, now)) {
      // One card per unit per window: keyed on the oldest fault inside the window.
      const first = after.faults.filter((f) => now.getTime() - f.getTime() <= REPLACE_WINDOW_MS)[0]!;
      await tell(tx, await materialsHeads(tx), ASSET_WORDS.replace, unit, `replace:${first.toISOString()}`, now);
    }
    void eventId;
  });
  return assetPassport(db, actor, { unitId }, now);
}

export async function openRepair(db: Db, actor: Actor, unitId: string, input: { note?: string | null } = {}, now: Date = new Date()): Promise<WireAssetLookup> {
  await requireAssetsManage(db, actor);
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
    if (s.openRepair) throw new StoresError("already_decided", "a repair is already open");
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "repair_opened", data: { note: clean(input.note) } }]);
    await recordAct(tx, actor, now, { act: "open_repair", storeId: s.place.id, itemId: s.unit.itemId, refId: unitId, reason: clean(input.note) });
  });
  return assetPassport(db, actor, { unitId }, now);
}

/** Outcome repaired / not repairable / preventive (an AMC visit, decision 7). Preventive needs no open repair. */
export async function closeRepair(
  db: Db, actor: Actor, unitId: string, input: { outcome: "repaired" | "not_repairable" | "preventive"; note?: string | null }, now: Date = new Date(),
): Promise<WireAssetLookup> {
  await requireAssetsManage(db, actor);
  if (!["repaired", "not_repairable", "preventive"].includes(input.outcome)) throw new StoresError("bad_quantity", "repaired, not repairable or preventive");
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (!s.openRepair && input.outcome !== "preventive") throw new StoresError("no_open_repair", "no repair is open");
    await appendUnitEvents(tx, actor, now, [{ unitId, kind: "repair_closed", data: { outcome: input.outcome, note: clean(input.note) } }]);
    await recordAct(tx, actor, now, { act: "close_repair", storeId: s.place.id, itemId: s.unit.itemId, refId: unitId, after: input.outcome, reason: clean(input.note) });
  });
  return assetPassport(db, actor, { unitId }, now);
}

// ═══════════════════════════════ found here (flow step 4) ═══════════════════════════════

/**
 * Another department finds the unit: one `seen_elsewhere` event naming the shelf where it was found, and one notice to
 * the owning department's in-charges. The books do not move: the owner collects it.
 */
export async function reportFoundHere(db: Db, actor: Actor, unitId: string, input: { shelfId: string }, now: Date = new Date()): Promise<{ told: number }> {
  const shelf = await requireShelf(db, input.shelfId);
  await requireShelfAct(db, actor, shelf, "read");
  return withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    const home = homeDepartmentOf(s);
    if (home === shelf.departmentId) throw new StoresError("not_elsewhere", "this unit belongs here");
    const [eventId] = await appendUnitEvents(tx, actor, now, [{ unitId, kind: "seen_elsewhere", data: { shelfId: shelf.id } }]);
    await recordAct(tx, actor, now, { act: "found_here", storeId: shelf.id, itemId: s.unit.itemId, refId: unitId });
    const owners = home === null ? await materialsHeads(tx) : await holdersOf(tx, STORES_SHELF_WORK, { departmentId: home });
    const unit = { id: unitId, tag: s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo, name: await itemName(tx, s.unit.itemId) };
    await tell(tx, owners, ASSET_WORDS.elsewhere, unit, `elsewhere:${eventId!}`, now, shelf.name);
    return { told: owners.length };
  });
}

// ═══════════════════════════════ transfer to another department (decision 17) ═══════════════════════════════

export async function proposeUnitTransfer(db: Db, actor: Actor, unitId: string, input: { toShelfId: string }, now: Date = new Date()): Promise<WireAssetLookup> {
  const to = await requireShelf(db, input.toShelfId);
  await withTx(db, async (tx) => {
    const s = await unitState(tx, unitId);
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service");
    if (s.place.kind !== "shelf") throw new StoresError("not_on_shelf", "only a unit in a department is transferred");
    if (!(await worksAt(tx, actor, s.place.departmentId))) throw new StoresError("not_permitted", "the holding department transfers it", { permission: STORES_SHELF_WORK });
    if (s.pendingTransfer !== null) throw new StoresError("already_decided", "a transfer is already open");
    if (to.id === s.place.id) throw new StoresError("not_this_shelf", "it is already there");
    const [eventId] = await appendUnitEvents(tx, actor, now, [{ unitId, kind: "transfer_proposed", data: { toShelfId: to.id, fromShelfId: s.place.id } }]);
    await recordAct(tx, actor, now, { act: "propose_unit_transfer", storeId: s.place.id, itemId: s.unit.itemId, refId: unitId, after: { toShelfId: to.id } });
    const unit = { id: unitId, tag: s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo, name: await itemName(tx, s.unit.itemId) };
    await tell(tx, (await holdersOf(tx, STORES_SHELF_WORK, { departmentId: to.departmentId })).filter((u) => u !== actor.id), ASSET_WORDS.toAccept, unit, `transfer:${eventId!}`, now);
  });
  return assetPassport(db, actor, { unitId }, now);
}

/**
 * The receiving department scans the unit to accept: a materials transfer shelf to shelf inside this act (issue and
 * receipt, so the ledger and the cost centre move together) and one `transferred` event. Never the proposer.
 */
export async function acceptUnitTransfer(db: Db, actor: Actor, input: { code?: string; unitId?: string }, now: Date = new Date()): Promise<WireAssetLookup> {
  let unitId = input.unitId;
  if (unitId === undefined) {
    const found = await unitsByCode(db, actor, input.code ?? "");
    const states = await unitStates(db, found.unitIds);
    const open = [...states.values()].filter((s) => s.pendingTransfer !== null);
    if (open.length === 0) throw new StoresError("unknown_unit", "no unit with that tag is on its way to you");
    if (open.length > 1) throw new StoresError("ambiguous_code", "two units match: scan the label");
    unitId = open[0]!.unit.id;
  }
  const s0 = await unitState(db, unitId);
  if (s0.pendingTransfer === null) throw new StoresError("no_open_transfer", "nothing to accept");
  if (s0.pendingTransfer.proposedBy === actor.id) throw new StoresError("own_transfer", "Your own transfer");
  const to = await requireShelf(db, s0.pendingTransfer.toShelfId);
  await requireShelfAct(db, actor, to, "work");
  await withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stores-unit:${unitId!}`}))`);
    const s = await unitState(tx, unitId!);
    if (s.pendingTransfer === null || s.pendingTransfer.eventId !== s0.pendingTransfer!.eventId) throw new StoresError("no_open_transfer", "nothing to accept");
    const from = s.place;
    // Two people, as for any movement: the proposer gave it (the issue legs are theirs), the acceptor receives it.
    const giver: Actor = { type: "user", id: s.pendingTransfer.proposedBy };
    const { transferId, lines } = await issueStock(tx, giver, {
      fromResourceId: from.id, toResourceId: to.id, lines: [{ itemId: s.unit.itemId, qtyBase: 1, batchId: s.unit.batchId, overrideReason: "stores: tagged unit transfer" }],
      note: `unit transfer ${s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo}`, occurredAt: now,
    });
    await receiveAtShelf(tx as unknown as Db, actor, transferId, now, lines.map((l) => ({ lineId: l.transferLineId, qtyReceived: l.qtyIssued })), to.id);
    await appendUnitEvents(tx, actor, now, [{ unitId: unitId!, kind: "transferred", storeId: to.id, refType: "transfer", refId: transferId, data: { proposalId: s.pendingTransfer.eventId, fromShelfId: from.id } }]);
    await recordAct(tx, actor, now, { act: "accept_unit_transfer", storeId: to.id, itemId: s.unit.itemId, refId: unitId!, before: from.id, after: to.id });
  });
  return assetPassport(db, actor, { unitId }, now);
}

// ═══════════════════════════════ units riding the ledger (decision 5) ═══════════════════════════════

/** Units on these batches whose derived place is `storeId` (live only), oldest tag first. */
export async function unitsAt(db: Db | Tx, storeId: string, batchIds?: readonly string[]): Promise<UnitState[]> {
  const ids = (await (db as Db).execute(sql`
    select p.unit_id from (select distinct on (e.unit_id) e.unit_id, e.store_id from stores_asset_unit_events e
      where e.store_id is not null and e.kind in ('tagged', 'placed', 'moved', 'out_on_pass', 'back', 'transferred', 'found')
      order by e.unit_id, e.seq desc) p join stores_asset_units u on u.id = p.unit_id
     where p.store_id = ${storeId} ${batchIds === undefined ? sql`` : batchIds.length === 0 ? sql`and false` : sql`and u.batch_id in (${sql.join(batchIds.map((b) => sql`${b}`), sql`, `)})`}`)).rows as { unit_id: string }[];
  const states = await unitStates(db, ids.map((r) => r.unit_id));
  return [...states.values()].filter((s) => s.ended === null).sort((a, b) => a.unit.tagNo.localeCompare(b.unit.tagNo));
}

/**
 * Validate the units a picker named for one item at one store: each a live unit of that item, there, not on an open
 * transfer, and named once. Returns them with their batches.
 */
export async function requireUnitsAt(db: Db | Tx, unitIds: readonly string[], itemId: string, storeId: string): Promise<UnitState[]> {
  if (new Set(unitIds).size !== unitIds.length) throw new StoresError("bad_quantity", "a unit is named twice");
  const states = await unitStates(db, unitIds);
  const out: UnitState[] = [];
  for (const id of unitIds) {
    const s = states.get(id);
    if (s === undefined || s.unit.itemId !== itemId) throw new StoresError("unknown_unit", "that unit is not this item", { unitId: id });
    if (s.ended !== null) throw new StoresError("unit_ended", "this unit is no longer in service", { unitId: id });
    if (s.place.id !== storeId || s.pendingTransfer !== null) throw new StoresError("unit_not_here", "that unit is not in this store", { unitId: id });
    out.push(s);
  }
  return out;
}

/** After an issue: the named units are in IN-TRANSIT on that transfer. */
export async function unitsIntoTransit(tx: Tx, actor: Actor, unitIds: readonly string[], transferId: string, now: Date): Promise<void> {
  if (unitIds.length === 0) return;
  const transit = await ensureTransitStore(tx);
  await appendUnitEvents(tx, actor, now, unitIds.map((unitId) => ({ unitId, kind: "moved", storeId: transit, refType: "transfer", refId: transferId })));
}

/** The units still in IN-TRANSIT on this transfer (their last place-bearing event put them there for it). */
export async function unitsInTransitOn(db: Db | Tx, transferId: string): Promise<UnitState[]> {
  const transit = await ensureTransitStore(db as Tx);
  return (await unitsAt(db, transit)).filter((s) => s.placeEvent.refType === "transfer" && s.placeEvent.refId === transferId);
}

/**
 * Units follow quantities moved OUT of IN-TRANSIT for this transfer (a receipt, a send-back taken back, a short
 * resolved): `qty` units of each batch go to `toStoreId`. `chosen` names the exact units (a receiver's scans).
 */
export async function followTransit(
  tx: Tx, actor: Actor, transferId: string, moves: readonly { batchId: string; qty: number; toStoreId: string }[], kind: "placed" | "moved", at: Date, now: Date,
  chosen?: readonly string[],
): Promise<string[]> {
  const inTransit = await unitsInTransitOn(tx, transferId);
  const taken = new Set<string>();
  const rows: NewUnitEvent[] = [];
  for (const m of moves) {
    if (m.qty <= 0) continue;
    const pool = inTransit.filter((s) => s.unit.batchId === m.batchId && !taken.has(s.unit.id));
    if (pool.length === 0) continue;
    const preferred = chosen === undefined ? pool : [...pool.filter((s) => chosen.includes(s.unit.id)), ...pool.filter((s) => !chosen.includes(s.unit.id))];
    for (const s of preferred.slice(0, m.qty)) {
      taken.add(s.unit.id);
      rows.push({ unitId: s.unit.id, kind, storeId: m.toStoreId, refType: "transfer", refId: transferId, occurredAt: at });
    }
  }
  await appendUnitEvents(tx, actor, now, rows);
  return [...taken];
}

// ═══════════════════════════════ lists ═══════════════════════════════

async function registerRows(db: Db | Tx, states: UnitState[], now: Date): Promise<WireAssetRegisterRow[]> {
  const missing = await missingUnits(db);
  const itemIds = [...new Set(states.map((s) => s.unit.itemId))];
  const its = itemIds.length === 0 ? { rows: [] } : await (db as Db).execute(sql`
    select i.id, i.name, coalesce(p.name, c.name, '') as category from items i left join item_categories c on c.id = i.category_id
      left join item_categories p on p.id = c.parent_id where i.id in (${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)})`);
  const byItem = new Map((its.rows as { id: string; name: string; category: string }[]).map((r) => [r.id, r] as const));
  const deptIds = [...new Set(states.map((s) => s.place.departmentId).filter((x): x is string => x !== null))];
  const depts = new Map<string, string>();
  for (const d of deptIds) depts.set(d, (await departmentOf(db, d)).name);
  const out: WireAssetRegisterRow[] = [];
  for (const s of states) {
    const tagNo = s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo;
    out.push({
      unitId: s.unit.id, tagNo, last4: tagNo.slice(-4), name: byItem.get(s.unit.itemId)?.name ?? "", category: byItem.get(s.unit.itemId)?.category ?? "",
      status: (await statusOf(db, s, now, missing)).status, place: s.place.name, department: s.place.departmentId === null ? null : depts.get(s.place.departmentId) ?? null,
      next: duesOf(s, now).next,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.tagNo.localeCompare(b.tagNo));
}

/** `/stores/assets` Register: every unit (stores.assets.read or manage). */
export async function assetRegister(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<{ rows: WireAssetRegisterRow[] }> {
  if (!(await readsAll(db, actor))) throw new StoresError("not_permitted", "No permission", { permission: STORES_ASSETS_READ });
  return { rows: await registerRows(db, [...(await unitStates(db)).values()], now) };
}

/** Department assets (phone): the units at the shelves of the departments this person works or reads at. */
export async function myAssets(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<{ rows: WireAssetRegisterRow[] }> {
  const all = [...(await unitStates(db)).values()].filter((s) => s.ended === null);
  const mine: UnitState[] = [];
  const cache = new Map<string, boolean>();
  for (const s of all) {
    const d = homeDepartmentOf(s);
    if (d === null) continue;
    if (!cache.has(d)) cache.set(d, (await holds(db, actor, STORES_SHELF_READ, d)) || (await holds(db, actor, STORES_SHELF_WORK, d)));
    if (cache.get(d) === true) mine.push(s);
  }
  return { rows: await registerRows(db, mine, now) };
}

/** Units arriving for this person to accept (an open transfer to a department they work at). */
export async function unitsToAccept(db: Db | Tx, actor: Actor, now: Date = new Date()): Promise<{ rows: WireAssetRegisterRow[] }> {
  const open = [...(await unitStates(db)).values()].filter((s) => s.pendingTransfer !== null && s.pendingTransfer.proposedBy !== actor.id);
  const mine: UnitState[] = [];
  for (const s of open) {
    const to = await requireShelf(db, s.pendingTransfer!.toShelfId).catch(() => null);
    if (to !== null && (await worksAt(db, actor, to.departmentId))) mine.push(s);
  }
  return { rows: await registerRows(db, mine, now) };
}

/** The shelves a person may name as "here": every shelf of a department they read or work at. */
export async function requireReadableShelf(db: Db | Tx, actor: Actor, shelfId: string): Promise<void> {
  const shelf = await requireShelf(db, shelfId);
  await requireShelfAct(db, actor, shelf, "read");
}

export function lastTag(s: UnitState): string { return s.liveTags[s.liveTags.length - 1] ?? s.unit.tagNo; }

/** The name of the department a shelf belongs to ("" for a store that is not a shelf). */
export async function departmentNameOf(db: Db | Tx, storeId: string): Promise<string> {
  const info = (await storeInfos(db, [storeId])).get(storeId);
  return info?.departmentId == null ? "" : (await departmentOf(db, info.departmentId)).name;
}
export { homeDepartmentOf, missingUnits, readsAll, storeInfos, itemName };
