import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  TRAY_CHECK_KINDS, items, patients, pharmacyTrayCheckLines, pharmacyTrayChecks, pharmacyTrayTemplates, resources, stockBalances,
  stockBatches, transfers, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import {
  createStore, findStoreByCode, getBatch, getTransfer, issueStock, listStores, postMovements, receiveStock, requireStore,
  setStoreCustodianRoles, storeCustodianRoles,
} from "../materials";
import { OPD_PHARMACY_STORE_CODE, isIsoDate, istDateOf, istInstantOf, istMonthStartUtc } from "./config";
import { PharmacyError } from "./errors";
import { trayChecked, trayRestocked, traySaved, trayTemplateSaved } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { TrayCheckKind, TrayCheckResult } from "../../kernel/db/schema";
import type { MovementInput, StoreRow } from "../materials";

/**
 * ═══ PHARMACY STAGE D4 — CRASH-CART AND EMERGENCY-TRAY CHECKS ═══
 *
 * Basis: NABH MOM — emergency medications are available, standardised, checked and replenished promptly after
 * use. Phase doc `docs/superpowers/plans/2026-09-28-pharmacy-safety-stage-d.md`, D4. Scope: the OPD, radiology,
 * OT and day-care trays; ER and ward carts come from their own brainstorms, on this model.
 *
 * - A TRAY IS A STORE: a materials `store` resource, a child of `PHARM-OPD`, `attributes.tray = true`, a location
 *   label and the roles that keep it (`custodianRoles`, which the transfer receipt already honours). Its stock is
 *   real stock: FEFO, expiry and the ledger work unchanged.
 * - THE TEMPLATE (`pharmacy_tray_templates`) is the fixed list — item and par per tray, an optional expiry margin.
 *   A master row under `pharmacy.trays.manage`, every save an audit event with the before and the after.
 * - THE CHECK (`pharmacy_tray_checks` + lines, append-only). DECIDED frequency: a DAILY SEAL check every IST day
 *   (due by 10:00), a MONTHLY FULL open check every IST calendar month (due by the 7th), and an AFTER-USE full check
 *   after every use. The SERVER decides the result: a line with less than par present, or with its earliest expiry
 *   inside the margin (30 days unless the template says otherwise), or a daily seal number that is not the one the
 *   tray was last sealed with, is DEFICIENT. A seal mismatch is answered by a full check, not a restock.
 * - USE. An after-use check posts what left the tray as `consume` on the ledger (ref `pharmacy_tray_check`, the
 *   patient when named): the tray's on-hand less what is present, earliest expiry first. Charging the patient is
 *   NOT here — it belongs to the ER and IPD brainstorms.
 * - RESTOCK. A deficient check offers one act: issue exactly the deficit (par less present, plus the units that
 *   expire inside the margin) from `PHARM-OPD` to the tray through `materials.issueStock`. The check records the
 *   transfer. The tray's keeper confirms receipt through `materials.receiveStock`, which refuses the issuer and
 *   anyone who does not keep the tray.
 */
export const TRAYS_CHECK_PERMISSION = "pharmacy.trays.check";
export const TRAYS_MANAGE_PERMISSION = "pharmacy.trays.manage";
/** DECIDED — a line whose earliest expiry is this close (days, IST) is deficient, unless its template says otherwise. */
export const TRAY_EXPIRY_MARGIN_DAYS = 30;
/** DECIDED — the daily seal check is due by this IST wall-clock time. */
export const TRAY_DAILY_DUE_IST = "10:00";
/** DECIDED — the monthly full check is due by the end of this IST day of the month. */
export const TRAY_MONTHLY_DUE_DAY = 7;
/** A check may be entered this long after it was made (the paper sheet during an outage); never from the future. */
export const TRAY_CHECK_BACKDATE_HOURS = 24;
/** The roles a tray may name as its keepers: the ones who check it. */
export const TRAY_KEEPER_ROLES = [
  "pharmacy", "pharmacy_assistant", "pharmacy_incharge", "ot_nurse", "recovery_nurse", "radiographer", "daycare_coordinator",
] as const;
/** The ledger's `ref_type` for what an after-use check consumed. */
export const TRAY_CHECK_REF_TYPE = "pharmacy_tray_check";

const LIST_LIMIT = 200;
const HISTORY_LIMIT = 50;
const MAX_TEXT = 1000;
const MAX_QTY = 100_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

export const trayCheckNumber = (seq: number): string => `TC-${String(seq).padStart(6, "0")}`;

export type TrayScheduleState = "done" | "due" | "missed" | "not_due";

export type TrayTemplateLineView = {
  id: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
  parQty: number; minExpiryDays: number | null; active: boolean;
};

export type TrayCheckSummary = {
  id: string; no: string; kind: TrayCheckKind; result: TrayCheckResult; findings: string[]; checkedAt: string;
  restock: { transferId: string; status: string; restockedAt: string } | null;
};

export type TrayView = {
  id: string; code: string; name: string; location: string; custodianRoles: string[];
  template: TrayTemplateLineView[];
  daily: TrayScheduleState;
  monthly: TrayScheduleState;
  lastCheck: TrayCheckSummary | null;
  /** The latest check is deficient and nothing has been issued for it yet. */
  needsRestock: boolean;
  /** The seal the next daily check expects to see; null when the tray was opened for a restock since. */
  expectedSeal: string | null;
  /** Tray stock (the ledger) expiring inside the margin, earliest first. */
  expiring: { itemId: string; itemName: string; batchNo: string; expiryDate: string; qty: number }[];
};

export type TrayCheckLineView = {
  itemId: string; itemName: string; parQty: number; qtyPresent: number; earliestExpiry: string | null; batchNo: string | null;
  qtyExpiring: number; qtyUsed: number; qtyRestock: number;
};

export type TrayCheckView = TrayCheckSummary & {
  trayId: string; sealSeen: string | null; sealNew: string | null; note: string | null; event: string | null; patientId: string | null;
  checkedByName: string | null; restockedByName: string | null;
  lines: TrayCheckLineView[];
};

function bad(message: string, detail?: Record<string, unknown>): never {
  throw new PharmacyError("invalid_tray", message, detail);
}

const clean = (v: string | null | undefined, max = MAX_TEXT): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t.slice(0, max);
};

async function hasAny(db: Db | Tx, actor: Actor, perms: readonly string[]): Promise<boolean> {
  if (actor.type !== "user") return false;
  for (const p of perms) if (await hasPermission(db as Db, actor.id, p, "hospital")) return true;
  return false;
}

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<string> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new PharmacyError("permission_denied", `${what} needs ${perm}`);
  }
  return actor.id;
}

/** The trays are read by whoever checks them or keeps their templates (the D1–D3 register shape). */
export async function assertTrayReader(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await hasAny(db, actor, [TRAYS_CHECK_PERMISSION, TRAYS_MANAGE_PERMISSION]))) {
    throw new PharmacyError("permission_denied", `the emergency trays are read with ${TRAYS_CHECK_PERMISSION} or ${TRAYS_MANAGE_PERMISSION}`);
  }
}

const attrs = (s: Pick<StoreRow, "attributes">): Record<string, unknown> => s.attributes as Record<string, unknown>;
const isTray = (s: Pick<StoreRow, "attributes">): boolean => attrs(s).tray === true;
const locationOf = (s: Pick<StoreRow, "attributes">): string => (typeof attrs(s).location === "string" ? attrs(s).location as string : "");
/** When the tray was set up (the service's clock, kept on the store); a check due before then was not missed. */
const setUpAtOf = (s: Pick<StoreRow, "attributes" | "createdAt">): Date => {
  const v = attrs(s).setUpAt;
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? s.createdAt : new Date(t);
};

async function pharmacyStore(db: Db | Tx): Promise<StoreRow> {
  const s = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (s === undefined) throw new PharmacyError("store_missing", `the ${OPD_PHARMACY_STORE_CODE} store is not set up — run seed:pharmacy`);
  return s;
}

/** A tray by id: a store, not retired, marked `tray`. */
async function requireTray(db: Db | Tx, trayId: string): Promise<StoreRow> {
  const [row] = await db.select().from(resources).where(eq(resources.id, trayId));
  if (row === undefined || row.kind !== "store" || !isTray(row) || row.status === "retired") {
    throw new PharmacyError("unknown_tray", `tray ${trayId} not found`);
  }
  return row;
}

/** Every live tray, by code. */
async function allTrays(db: Db | Tx): Promise<StoreRow[]> {
  return (await listStores(db)).filter(isTray).slice(0, LIST_LIMIT);
}

const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ═══════════════════════════════════ the trays and their templates ═══════════════════════════════════

export type SaveTrayInput = {
  /** Absent: a new tray. */
  id?: string;
  /** A new tray's name, as labelled. Ignored on an edit. */
  name?: string;
  /** Where it lives — "OPD procedure room", "CT room", "OT-1". Fixed once set up. */
  location?: string;
  custodianRoles: string[];
};

function keepers(roles: readonly string[]): string[] {
  const out = [...new Set(roles.map((r) => r.trim()).filter((r) => r !== ""))].sort();
  if (out.length === 0) bad("name who keeps the tray — they confirm what the pharmacy sends to it");
  const unknown = out.filter((r) => !(TRAY_KEEPER_ROLES as readonly string[]).includes(r));
  if (unknown.length > 0) bad(`a tray is kept by those who check it (${TRAY_KEEPER_ROLES.join(", ")}), not ${unknown.join(", ")}`, { unknown });
  return out;
}

/**
 * Set up a tray (a child store of PHARM-OPD) or change who keeps it. DECIDED: the store is created through the
 * materials module's `createStore` under `pharmacy.trays.manage`, not `materials.stores.manage` — the in-charge
 * does not hold the latter and this door makes only one shape of store (a tray under PHARM-OPD). A tray's name and
 * location are fixed once set up; a tray that moves is a new tray.
 */
export async function saveTray(db: Db, actor: Actor, input: SaveTrayInput, now: Date = new Date()): Promise<{ trayId: string; code: string }> {
  await requirePerm(db, actor, TRAYS_MANAGE_PERMISSION, "setting up an emergency tray");
  const roles = keepers(input.custodianRoles);
  return withTx(db, async (tx) => {
    if (input.id !== undefined) {
      const tray = await requireTray(tx, input.id);
      const before = { name: tray.name, location: locationOf(tray), custodianRoles: storeCustodianRoles(tray) };
      await setStoreCustodianRoles(tx, actor, tray.id, roles);
      await appendEvent(tx, traySaved.make({
        actor, occurredAt: now, payload: { trayId: tray.id, code: tray.code, before, after: { ...before, custodianRoles: roles } },
      }));
      return { trayId: tray.id, code: tray.code };
    }
    const name = clean(input.name, 80);
    const location = clean(input.location, 80);
    if (name === null) bad("name the tray as it is labelled");
    if (location === null) bad("say where the tray lives — the room it is kept in");
    const parent = await pharmacyStore(tx);
    const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    const code = `TRAY-${slug === "" ? "X" : slug}`;
    if ((await findStoreByCode(tx, code)) !== undefined) bad(`a store called ${code} already exists — name this tray differently`);
    const { resourceId } = await createStore(tx, actor, {
      code, name, parentId: parent.id, attributes: { tray: true, location, custodianRoles: roles, setUpAt: now.toISOString() },
    });
    await appendEvent(tx, traySaved.make({
      actor, occurredAt: now, payload: { trayId: resourceId, code, before: null, after: { name, location, custodianRoles: roles } },
    }));
    return { trayId: resourceId, code };
  });
}

export type SaveTemplateLineInput = { trayId: string; itemId: string; parQty: number; minExpiryDays?: number | null; active?: boolean };

/** Add or edit one item on a tray's list. A mutable master row, an audit event per save (D3's fridge shape). */
export async function saveTrayTemplateLine(db: Db, actor: Actor, input: SaveTemplateLineInput, now: Date = new Date()): Promise<{ templateId: string }> {
  const userId = await requirePerm(db, actor, TRAYS_MANAGE_PERMISSION, "editing a tray's list");
  if (!Number.isSafeInteger(input.parQty) || input.parQty <= 0 || input.parQty > 10_000) bad("the par quantity is a whole number of base units, at least one");
  const margin = input.minExpiryDays ?? null;
  if (margin !== null && (!Number.isSafeInteger(margin) || margin < 0 || margin > 365)) bad("the expiry margin is 0 to 365 days");
  return withTx(db, async (tx) => {
    await requireTray(tx, input.trayId);
    const [item] = await tx.select({ id: items.id }).from(items).where(eq(items.id, input.itemId));
    if (item === undefined) bad(`item ${input.itemId} not found`);
    const [row] = await tx.select().from(pharmacyTrayTemplates)
      .where(and(eq(pharmacyTrayTemplates.trayResourceId, input.trayId), eq(pharmacyTrayTemplates.itemId, input.itemId))).for("update");
    const after = { parQty: input.parQty, minExpiryDays: margin, active: input.active ?? true };
    let templateId: string;
    let before: typeof after | null = null;
    if (row === undefined) {
      templateId = newId();
      await tx.insert(pharmacyTrayTemplates).values({ id: templateId, trayResourceId: input.trayId, itemId: input.itemId, ...after, createdBy: userId, createdAt: now });
    } else {
      templateId = row.id;
      before = { parQty: row.parQty, minExpiryDays: row.minExpiryDays, active: row.active };
      await tx.update(pharmacyTrayTemplates).set({ ...after, updatedBy: userId, updatedAt: now }).where(eq(pharmacyTrayTemplates.id, row.id));
    }
    await appendEvent(tx, trayTemplateSaved.make({ actor, occurredAt: now, payload: { templateId, trayId: input.trayId, itemId: input.itemId, before, after } }));
    return { templateId };
  });
}

async function templateOf(db: Db | Tx, trayIds: readonly string[]): Promise<(TrayTemplateLineView & { trayId: string })[]> {
  if (trayIds.length === 0) return [];
  const rows = await db.select({ t: pharmacyTrayTemplates, code: items.code, name: items.name, baseUom: items.baseUom })
    .from(pharmacyTrayTemplates).innerJoin(items, eq(items.id, pharmacyTrayTemplates.itemId))
    .where(inArray(pharmacyTrayTemplates.trayResourceId, [...trayIds])).orderBy(asc(items.name)).limit(LIST_LIMIT * 20);
  return rows.map(({ t, code, name, baseUom }) => ({
    id: t.id, trayId: t.trayResourceId, itemId: t.itemId, itemCode: code, itemName: name, baseUom,
    parQty: t.parQty, minExpiryDays: t.minExpiryDays, active: t.active,
  }));
}

// ═══════════════════════════════════ the check ═══════════════════════════════════

export type TrayCheckLineInput = {
  itemId: string; qtyPresent: number; earliestExpiry?: string | null; batchId?: string | null;
  /** Of what is present, how many expire inside the margin. Defaults to all present when the earliest does. */
  qtyExpiring?: number | null;
};

export type RecordTrayCheckInput = {
  trayId: string;
  kind: TrayCheckKind;
  sealSeen?: string | null;
  sealNew?: string | null;
  lines?: TrayCheckLineInput[];
  /** `after_use` only. */
  patientId?: string | null;
  event?: string | null;
  note?: string | null;
  checkedAt?: Date | null;
};

export type RecordedTrayCheck = {
  checkId: string; no: string; result: TrayCheckResult; findings: string[];
  /** Units an after-use check took off the tray's ledger as consumption. */
  consumed: number;
  /** Units the restock would issue (par less present, plus the expiring). */
  deficit: number;
};

type LatestCheck = { sealSeen: string | null; sealNew: string | null; restockTransferId: string | null };

/** The seal the next daily check should see: the last one recorded, unless the tray was opened to restock since. */
function expectedSealOf(latest: LatestCheck | undefined): string | null {
  if (latest === undefined || latest.restockTransferId !== null) return null;
  return latest.sealNew ?? latest.sealSeen;
}

async function latestCheckOf(db: Db | Tx, trayId: string): Promise<(typeof pharmacyTrayChecks.$inferSelect) | undefined> {
  const [row] = await db.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.trayResourceId, trayId))
    .orderBy(desc(pharmacyTrayChecks.checkedAt), desc(pharmacyTrayChecks.seq)).limit(1);
  return row;
}

/** The tray's stock of one item, batch by batch, earliest expiry first (the order a use takes it in). */
async function trayStockOf(tx: Tx, trayId: string, itemId: string): Promise<{ batchId: string; onHand: number; free: number }[]> {
  const rows = await tx.select({ batchId: stockBalances.batchId, onHand: stockBalances.qtyOnHand, reserved: stockBalances.qtyReserved, frozen: stockBalances.qtyFrozen })
    .from(stockBalances).innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .where(and(eq(stockBalances.resourceId, trayId), eq(stockBalances.itemId, itemId), gt(stockBalances.qtyOnHand, 0)))
    .orderBy(sql`${stockBatches.expiryDate} asc nulls last`, asc(stockBalances.batchId));
  return rows.map((r) => ({ batchId: r.batchId, onHand: r.onHand, free: r.onHand - r.reserved - r.frozen }));
}

/**
 * Record a check. The result is decided HERE, from the seal and the lines — the client's view of it is never read.
 * The tray's row is locked first, so two checks at one tray are serialised (the seal chain and the use both read
 * the latest state).
 */
export async function recordTrayCheck(db: Db, actor: Actor, input: RecordTrayCheckInput, now: Date = new Date()): Promise<RecordedTrayCheck> {
  const userId = await requirePerm(db, actor, TRAYS_CHECK_PERMISSION, "checking an emergency tray");
  if (!(TRAY_CHECK_KINDS as readonly string[]).includes(input.kind)) bad(`"${String(input.kind)}" is not a daily seal, monthly full or after-use check`);
  const checkedAt = input.checkedAt ?? now;
  if (Number.isNaN(checkedAt.getTime()) || checkedAt.getTime() > now.getTime() + MINUTE) bad("the check's time is in the future");
  if (now.getTime() - checkedAt.getTime() > TRAY_CHECK_BACKDATE_HOURS * 60 * MINUTE) {
    bad(`a check is entered within ${String(TRAY_CHECK_BACKDATE_HOURS)} hours of making it — check the tray again`);
  }
  const sealSeen = clean(input.sealSeen, 40);
  const sealNew = clean(input.sealNew, 40);
  const note = clean(input.note);
  const event = input.kind === "after_use" ? clean(input.event, 200) : null;
  const patientId = input.kind === "after_use" ? (input.patientId ?? null) : null;
  if (input.kind !== "after_use" && (input.patientId != null || clean(input.event) !== null)) bad("only an after-use check names a patient or an event");
  const lines = input.lines ?? [];
  const full = input.kind !== "daily_seal";
  if (!full) {
    if (sealSeen === null) bad("a daily check reads the seal number on the tray");
    if (lines.length > 0) bad("a daily check reads the seal and does not open the tray — record a full check to count it");
  }

  return withTx(db, async (tx) => {
    await tx.select({ id: resources.id }).from(resources).where(eq(resources.id, input.trayId)).for("update");
    const tray = await requireTray(tx, input.trayId);
    if (patientId !== null) {
      const [p] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId));
      if (p === undefined) bad(`patient ${patientId} not found`);
    }
    const latest = await latestCheckOf(tx, tray.id);
    const findings = new Set<string>();

    // ── the seal: a daily check that does not see the seal the tray was last closed with ──
    const expected = expectedSealOf(latest);
    if (!full && expected !== null && sealSeen !== expected) findings.add("seal_mismatch");

    // ── the lines: every active template item, exactly once ──
    const tpl = (await templateOf(tx, [tray.id])).filter((l) => l.active);
    if (full && tpl.length === 0) bad("this tray has no list yet — the pharmacist in charge sets its items and par first");
    const byItem = new Map(tpl.map((l) => [l.itemId, l]));
    const seen = new Set<string>();
    for (const l of lines) {
      if (!byItem.has(l.itemId)) bad(`item ${l.itemId} is not on this tray's list`, { itemId: l.itemId });
      if (seen.has(l.itemId)) bad("an item is counted once", { itemId: l.itemId });
      seen.add(l.itemId);
    }
    const missing = tpl.filter((l) => !seen.has(l.itemId)).map((l) => l.itemName);
    if (full && missing.length > 0) bad(`count every item on the list — ${String(missing.length)} not counted: ${missing.join(", ")}`, { missing });

    const today = istDateOf(checkedAt);
    const rows: (typeof pharmacyTrayCheckLines.$inferInsert)[] = [];
    const checkId = newId();
    for (const l of lines) {
      const t = byItem.get(l.itemId)!;
      if (!Number.isSafeInteger(l.qtyPresent) || l.qtyPresent < 0 || l.qtyPresent > MAX_QTY) bad(`${t.itemName}: the quantity present is a whole number`, { itemId: l.itemId });
      const expiry = l.earliestExpiry ?? null;
      if (expiry !== null && !isIsoDate(expiry)) bad(`${t.itemName}: the earliest expiry is a date (YYYY-MM-DD)`, { itemId: l.itemId });
      if (l.batchId != null) {
        const b = await getBatch(tx, l.batchId);
        if (b === undefined || b.itemId !== l.itemId) bad(`${t.itemName}: the scanned batch is not a batch of this item`, { itemId: l.itemId });
      }
      const cutoff = plusDays(today, t.minExpiryDays ?? TRAY_EXPIRY_MARGIN_DAYS);
      const expiring = l.qtyPresent > 0 && expiry !== null && expiry <= cutoff;
      let qtyExpiring = 0;
      if (expiring) {
        qtyExpiring = l.qtyExpiring ?? l.qtyPresent;
        if (!Number.isSafeInteger(qtyExpiring) || qtyExpiring < 1 || qtyExpiring > l.qtyPresent) {
          bad(`${t.itemName}: the earliest expiry is inside ${String(t.minExpiryDays ?? TRAY_EXPIRY_MARGIN_DAYS)} days, so 1 to ${String(l.qtyPresent)} expire`, { itemId: l.itemId });
        }
        findings.add("expiring");
      } else if ((l.qtyExpiring ?? 0) !== 0) {
        bad(`${t.itemName}: nothing present expires inside the margin by the earliest expiry given`, { itemId: l.itemId });
      }
      if (l.qtyPresent < t.parQty) findings.add("short");
      rows.push({
        checkId, itemId: l.itemId, parQty: t.parQty, qtyPresent: l.qtyPresent, earliestExpiry: expiry, batchId: l.batchId ?? null,
        qtyExpiring, qtyUsed: 0, qtyRestock: Math.max(t.parQty - l.qtyPresent, 0) + qtyExpiring,
      });
    }

    // ── the use: what the tray's ledger holds beyond what is present left it as consumption ──
    const movements: MovementInput[] = [];
    if (input.kind === "after_use") {
      for (const r of rows) {
        const stock = await trayStockOf(tx, tray.id, r.itemId);
        let remaining = Math.max(stock.reduce((a, s) => a + s.onHand, 0) - r.qtyPresent, 0);
        let used = 0;
        for (const s of stock) {
          if (remaining <= 0) break;
          const take = Math.min(s.free, remaining);
          if (take <= 0) continue;
          movements.push({
            resourceId: tray.id, batchId: s.batchId, qtyDelta: -take, reason: "consume", refType: TRAY_CHECK_REF_TYPE, refId: checkId,
            patientId, occurredAt: checkedAt,
          });
          used += take;
          remaining -= take;
        }
        r.qtyUsed = used;
      }
    }

    const order = ["seal_mismatch", "short", "expiring"];
    const found = order.filter((f) => findings.has(f));
    const result: TrayCheckResult = found.length > 0 ? "deficient" : "ok";
    const [ins] = await tx.insert(pharmacyTrayChecks).values({
      id: checkId, trayResourceId: tray.id, kind: input.kind, sealSeen, sealNew, result, findings: found,
      patientId, event, note, checkedBy: userId, checkedAt, recordedAt: now,
    }).returning({ seq: pharmacyTrayChecks.seq });
    if (rows.length > 0) await tx.insert(pharmacyTrayCheckLines).values(rows);
    if (movements.length > 0) await postMovements(tx, actor, movements);
    const consumed = rows.reduce((a, r) => a + (r.qtyUsed ?? 0), 0);
    await appendEvent(tx, trayChecked.make({
      actor, occurredAt: now, correlationId: checkId,
      payload: { checkId, trayId: tray.id, kind: input.kind, result, findings: found, consumed, patientId },
    }));
    return { checkId, no: trayCheckNumber(ins!.seq), result, findings: found, consumed, deficit: rows.reduce((a, r) => a + (r.qtyRestock ?? 0), 0) };
  });
}

// ═══════════════════════════════════ the restock, and its receipt ═══════════════════════════════════

/**
 * "Restock from pharmacy": issue EXACTLY the check's deficit from PHARM-OPD to the tray, one transfer, FEFO at the
 * pharmacy's shelf. Only the pharmacy's own keepers issue from its shelf (PHARM-OPD's `custodianRoles`), and only
 * the tray's latest check is restocked — a later check supersedes an earlier one's count.
 */
export async function restockTrayCheck(db: Db, actor: Actor, checkId: string, now: Date = new Date()): Promise<{ transferId: string; units: number }> {
  const userId = await requirePerm(db, actor, TRAYS_CHECK_PERMISSION, "restocking an emergency tray");
  return withTx(db, async (tx) => {
    const [check] = await tx.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.id, checkId)).for("update");
    if (check === undefined) throw new PharmacyError("unknown_tray_check", `tray check ${checkId} not found`);
    const no = trayCheckNumber(check.seq);
    if (check.restockTransferId !== null) throw new PharmacyError("tray_already_restocked", `${no} was restocked already — the tray's keeper receives that transfer`);
    if (check.result !== "deficient") bad(`${no} found the tray complete — there is nothing to restock`);
    const latest = await latestCheckOf(tx, check.trayResourceId);
    if (latest !== undefined && latest.id !== check.id) bad(`a later check (${trayCheckNumber(latest.seq)}) supersedes ${no} — restock from that one`);
    const lines = (await tx.select().from(pharmacyTrayCheckLines).where(eq(pharmacyTrayCheckLines.checkId, check.id))).filter((l) => l.qtyRestock > 0);
    if (lines.length === 0) bad(`${no} is deficient on its seal alone — open the tray and record a full check; its count says what to restock`);

    const shelf = await pharmacyStore(tx);
    const shelfKeepers = storeCustodianRoles(shelf);
    let keeps = false;
    for (const role of shelfKeepers) {
      if ((await usersHoldingRole(tx, role)).includes(userId)) { keeps = true; break; }
    }
    if (!keeps) {
      throw new PharmacyError("permission_denied", `only the pharmacy's own staff (${shelfKeepers.join(", ") || "none named on " + OPD_PHARMACY_STORE_CODE}) issue from ${OPD_PHARMACY_STORE_CODE} to a tray`);
    }
    const tray = await requireStore(tx, check.trayResourceId);
    const units = lines.reduce((a, l) => a + l.qtyRestock, 0);
    const { transferId } = await issueStock(tx, actor, {
      fromResourceId: shelf.id, toResourceId: tray.id,
      lines: lines.map((l) => ({ itemId: l.itemId, qtyBase: l.qtyRestock })),
      note: `restock of tray ${tray.code} after check ${no}`, occurredAt: now,
    });
    await tx.update(pharmacyTrayChecks).set({ restockTransferId: transferId, restockedBy: userId, restockedAt: now }).where(eq(pharmacyTrayChecks.id, check.id));
    await appendEvent(tx, trayRestocked.make({ actor, occurredAt: now, correlationId: check.id, payload: { checkId: check.id, trayId: tray.id, transferId, units } }));
    return { transferId, units };
  });
}

/**
 * The tray's keeper confirms the restock reached the tray — in full, or line by line when short. This is the
 * materials receipt itself (`receiveStock`): it refuses the issuer, anyone who does not keep the tray, and more than
 * was sent; a shortfall stays in transit as a discrepancy.
 */
export async function receiveTrayRestock(
  db: Db, actor: Actor, checkId: string, input: { lines?: { lineId: string; qtyReceived: number }[] } = {}, now: Date = new Date(),
): Promise<{ status: string }> {
  await requirePerm(db, actor, TRAYS_CHECK_PERMISSION, "receiving a tray's restock");
  return withTx(db, async (tx) => {
    const [check] = await tx.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.id, checkId));
    if (check === undefined) throw new PharmacyError("unknown_tray_check", `tray check ${checkId} not found`);
    if (check.restockTransferId === null) bad(`${trayCheckNumber(check.seq)} has not been restocked yet`);
    const transfer = await getTransfer(tx, check.restockTransferId);
    if (transfer === undefined) throw new PharmacyError("unknown_tray_check", `the restock of ${trayCheckNumber(check.seq)} is not on file`);
    const lines = input.lines ?? transfer.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued }));
    const out = await receiveStock(tx, actor, transfer.id, lines, now);
    return { status: out.status };
  });
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

async function namesOf(db: Db | Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const u = [...new Set(ids.filter((x): x is string => x !== null))];
  if (u.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, u));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function transferStatuses(db: Db | Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const u = [...new Set(ids.filter((x): x is string => x !== null))];
  if (u.length === 0) return new Map();
  const rows = await db.select({ id: transfers.id, status: transfers.status }).from(transfers).where(inArray(transfers.id, u));
  return new Map(rows.map((r) => [r.id, r.status]));
}

function summaryOf(c: typeof pharmacyTrayChecks.$inferSelect, statuses: Map<string, string>): TrayCheckSummary {
  return {
    id: c.id, no: trayCheckNumber(c.seq), kind: c.kind as TrayCheckKind, result: c.result as TrayCheckResult, findings: c.findings,
    checkedAt: c.checkedAt.toISOString(),
    restock: c.restockTransferId === null ? null : {
      transferId: c.restockTransferId, status: statuses.get(c.restockTransferId) ?? "in_transit", restockedAt: c.restockedAt!.toISOString(),
    },
  };
}

/** Tray stock expiring on or before `cutoff` (an IST date), earliest first. */
async function expiringTrayStock(db: Db | Tx, trayIds: readonly string[], cutoff: string) {
  if (trayIds.length === 0) return [];
  return db.select({
    trayId: stockBalances.resourceId, itemId: stockBalances.itemId, itemName: items.name, batchNo: stockBatches.batchNo,
    expiryDate: stockBatches.expiryDate, qty: stockBalances.qtyOnHand,
  }).from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .where(and(inArray(stockBalances.resourceId, [...trayIds]), gt(stockBalances.qtyOnHand, 0), isNotNull(stockBatches.expiryDate), lte(stockBatches.expiryDate, cutoff)))
    .orderBy(asc(stockBatches.expiryDate), asc(items.name)).limit(LIST_LIMIT);
}

/** Every tray, with its list, today's and this month's check state, its last check and its expiring stock. */
export async function listTrays(db: Db, actor: Actor, now: Date = new Date()): Promise<TrayView[]> {
  await assertTrayReader(db, actor);
  const trays = await allTrays(db);
  if (trays.length === 0) return [];
  const ids = trays.map((t) => t.id);
  const today = istDateOf(now);
  const dayStart = istInstantOf(today, "00:00");
  const dailyDue = istInstantOf(today, TRAY_DAILY_DUE_IST);
  const monthStart = istMonthStartUtc(now, 0);
  const monthlyDue = new Date(monthStart.getTime() + TRAY_MONTHLY_DUE_DAY * DAY);
  const [tpl, month, last, expiring] = await Promise.all([
    templateOf(db, ids),
    db.select({ trayId: pharmacyTrayChecks.trayResourceId, kind: pharmacyTrayChecks.kind, checkedAt: pharmacyTrayChecks.checkedAt }).from(pharmacyTrayChecks)
      .where(and(inArray(pharmacyTrayChecks.trayResourceId, ids), gte(pharmacyTrayChecks.checkedAt, monthStart))).limit(LIST_LIMIT * 40),
    db.selectDistinctOn([pharmacyTrayChecks.trayResourceId]).from(pharmacyTrayChecks)
      .where(inArray(pharmacyTrayChecks.trayResourceId, ids))
      .orderBy(pharmacyTrayChecks.trayResourceId, desc(pharmacyTrayChecks.checkedAt), desc(pharmacyTrayChecks.seq)),
    expiringTrayStock(db, ids, plusDays(today, TRAY_EXPIRY_MARGIN_DAYS)),
  ]);
  const statuses = await transferStatuses(db, last.map((c) => c.restockTransferId));
  const state = (done: boolean, due: Date, createdAt: Date): TrayScheduleState =>
    done ? "done" : now.getTime() <= due.getTime() ? "due" : createdAt.getTime() > due.getTime() ? "not_due" : "missed";
  return trays.map((t): TrayView => {
    const mine = month.filter((c) => c.trayId === t.id);
    const l = last.find((c) => c.trayResourceId === t.id);
    return {
      id: t.id, code: t.code, name: t.name, location: locationOf(t), custodianRoles: storeCustodianRoles(t),
      template: tpl.filter((x) => x.trayId === t.id).map((x) => ({ id: x.id, itemId: x.itemId, itemCode: x.itemCode, itemName: x.itemName, baseUom: x.baseUom, parQty: x.parQty, minExpiryDays: x.minExpiryDays, active: x.active })),
      daily: state(mine.some((c) => c.checkedAt.getTime() >= dayStart.getTime()), dailyDue, setUpAtOf(t)),
      monthly: state(mine.some((c) => c.kind !== "daily_seal"), monthlyDue, setUpAtOf(t)),
      lastCheck: l === undefined ? null : summaryOf(l, statuses),
      needsRestock: l !== undefined && l.result === "deficient" && l.restockTransferId === null,
      expectedSeal: expectedSealOf(l),
      expiring: expiring.filter((e) => e.trayId === t.id).map((e) => ({ itemId: e.itemId, itemName: e.itemName, batchNo: e.batchNo, expiryDate: e.expiryDate!, qty: e.qty })),
    };
  });
}

/** One tray's checks, newest first, with their lines. */
export async function listTrayChecks(db: Db, actor: Actor, trayId: string): Promise<TrayCheckView[]> {
  await assertTrayReader(db, actor);
  await requireTray(db, trayId);
  const rows = await db.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.trayResourceId, trayId))
    .orderBy(desc(pharmacyTrayChecks.checkedAt), desc(pharmacyTrayChecks.seq)).limit(HISTORY_LIMIT);
  if (rows.length === 0) return [];
  const lines = await db.select({ l: pharmacyTrayCheckLines, itemName: items.name, batchNo: stockBatches.batchNo })
    .from(pharmacyTrayCheckLines).innerJoin(items, eq(items.id, pharmacyTrayCheckLines.itemId))
    .leftJoin(stockBatches, eq(stockBatches.id, pharmacyTrayCheckLines.batchId))
    .where(inArray(pharmacyTrayCheckLines.checkId, rows.map((r) => r.id))).orderBy(asc(items.name));
  const [names, statuses] = await Promise.all([
    namesOf(db, rows.flatMap((r) => [r.checkedBy, r.restockedBy])),
    transferStatuses(db, rows.map((r) => r.restockTransferId)),
  ]);
  return rows.map((c): TrayCheckView => ({
    ...summaryOf(c, statuses),
    trayId: c.trayResourceId, sealSeen: c.sealSeen, sealNew: c.sealNew, note: c.note, event: c.event, patientId: c.patientId,
    checkedByName: names.get(c.checkedBy) ?? null, restockedByName: c.restockedBy === null ? null : names.get(c.restockedBy) ?? null,
    lines: lines.filter((x) => x.l.checkId === c.id).map(({ l, itemName, batchNo }) => ({
      itemId: l.itemId, itemName, parQty: l.parQty, qtyPresent: l.qtyPresent, earliestExpiry: l.earliestExpiry, batchNo,
      qtyExpiring: l.qtyExpiring, qtyUsed: l.qtyUsed, qtyRestock: l.qtyRestock,
    })),
  }));
}

/** The office's STOCK side for the trays. Codes and names only. */
export type TraysToday = {
  dailyMissed: { trayId: string; code: string; name: string; location: string }[];
  monthlyMissed: { trayId: string; code: string; name: string; location: string; month: string }[];
  deficient: { trayId: string; code: string; name: string; location: string; checkId: string; no: string; checkedAt: string; findings: string[] }[];
  expiring: { trayId: string; code: string; name: string; itemName: string; batchNo: string; expiryDate: string; qty: number }[];
};

export async function traysToday(db: Db, actor: Actor, now: Date = new Date()): Promise<TraysToday> {
  const trays = await listTrays(db, actor, now);
  const base = (t: TrayView) => ({ trayId: t.id, code: t.code, name: t.name, location: t.location });
  return {
    dailyMissed: trays.filter((t) => t.daily === "missed").map(base),
    monthlyMissed: trays.filter((t) => t.monthly === "missed").map((t) => ({ ...base(t), month: istDateOf(now).slice(0, 7) })),
    deficient: trays.filter((t) => t.needsRestock && t.lastCheck !== null).map((t) => ({
      ...base(t), checkId: t.lastCheck!.id, no: t.lastCheck!.no, checkedAt: t.lastCheck!.checkedAt, findings: t.lastCheck!.findings,
    })),
    expiring: trays.flatMap((t) => t.expiring.map((e) => ({ trayId: t.id, code: t.code, name: t.name, itemName: e.itemName, batchNo: e.batchNo, expiryDate: e.expiryDate, qty: e.qty }))),
  };
}

/** The items a tray's list may name (the manage sheet's picker): the pharmacy's items, by name. */
export async function trayItemChoices(db: Db, actor: Actor, q: string): Promise<{ id: string; code: string; name: string; baseUom: string }[]> {
  await requirePerm(db, actor, TRAYS_MANAGE_PERMISSION, "choosing a tray's items");
  const term = q.trim();
  if (term.length < 2) return [];
  return db.select({ id: items.id, code: items.code, name: items.name, baseUom: items.baseUom }).from(items)
    .where(sql`(${items.name} ilike ${`%${term}%`} or ${items.code} ilike ${`%${term}%`})`).orderBy(asc(items.name)).limit(20);
}
