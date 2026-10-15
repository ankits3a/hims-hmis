import { and, asc, eq, inArray, isNull, lte, or, gte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { items, vendorItemRates, vendors } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import { vendorUpdated } from "./events";
import { assertNotMerged, itemsByIds, uomsByItems } from "./items";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ A VENDOR'S RATE CONTRACT (owner 2026-10-04, step 2 of buying from Aptus Drugs) ═══
 *
 * The vendor quotes a rate per item; the hospital accepts it; from then on that rate is what an order to that
 * vendor is priced at, and a line priced above it says so. Three acts and two reads:
 *
 *   - `setVendorRates` — record quoted rates (a whole price list at once). A rate that differs from the open one
 *     ends it and opens a new one; the same rate again is left alone. `materials.vendors.manage`: the person
 *     who keeps the vendor's paperwork keeps its prices. One `vendor.updated { changed: ["rates"] }` per act.
 *   - `endVendorRate` — the vendor withdrew the item, or the hospital stopped accepting the rate.
 *   - `vendorRates` — a vendor's open rates, as the office reads them.
 *   - `contractRatesFor` — for items, every rate in force today from an ACTIVE vendor, cheapest per base unit
 *     first. The purchase drafts and the order sheet read this.
 *
 * Every rate is EX-GST per pack, like a purchase-order line's `rate_paise`: what it prefills is what it is.
 */

const VENDORS_MANAGE = "materials.vendors.manage";
const VENDORS_READ = "materials.vendors.read";
const PO_RAISE = "materials.po.raise";
const MAX_ROWS = 1000;

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

export type VendorRateInput = {
  itemId: string;
  /** The pack the rate is for: its unit name, or how many base units it holds. Neither = the item's largest pack. */
  uom?: string;
  packSize?: number;
  ratePaise: number;
  gstRateBps?: number;
  mrpPaise?: number | null;
  validTo?: string | null;
};
export type VendorRateResult =
  | { itemId: string; ok: true; rateId: string; changed: boolean }
  | { itemId: string; ok: false; code: string; message: string };

export type VendorRateView = {
  id: string; vendorId: string; itemId: string; itemCode: string; itemName: string; baseUom: string;
  uom: string; multiplier: number; ratePaise: number; gstRateBps: number; mrpPaise: number | null;
  validFrom: string; validTo: string | null; source: string | null; createdAt: string;
};

export type ContractRate = {
  rateId: string; vendorId: string; vendorName: string; uom: string; multiplier: number;
  ratePaise: number; gstRateBps: number; mrpPaise: number | null; validTo: string | null;
};

const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

async function requirePermission(db: Db | Tx, actor: Actor, permissions: string[], what: string): Promise<void> {
  if (actor.type === "user") for (const p of permissions) if (await hasPermission(db as Db, actor.id, p, "hospital")) return;
  throw new MaterialsError("permission_denied", `${what} needs ${permissions.join(" or ")}`);
}

/** Record a vendor's quoted rates. Each row stands alone: a bad row is reported, the others are kept. */
export async function setVendorRates(
  db: Db, actor: Actor, vendorId: string, rows: readonly VendorRateInput[],
  opts: { source?: string | null; validFrom?: string; now?: Date } = {},
): Promise<VendorRateResult[]> {
  await requirePermission(db, actor, [VENDORS_MANAGE], "recording a vendor's rates");
  if (rows.length === 0 || rows.length > MAX_ROWS) throw new MaterialsError("po_invalid", `between 1 and ${String(MAX_ROWS)} rates at a time`);
  const now = opts.now ?? new Date();
  const today = IST_DAY.format(now);
  const validFrom = opts.validFrom ?? today;
  if (!isIsoDate(validFrom)) throw new MaterialsError("po_invalid", `valid from "${validFrom}" is not a date`);
  const source = opts.source?.trim().slice(0, 200) || null;

  const [vendor] = await db.select({ id: vendors.id, status: vendors.status }).from(vendors).where(eq(vendors.id, vendorId));
  if (vendor === undefined) throw new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`, { vendorId });
  if (vendor.status === "blacklisted") throw new MaterialsError("vendor_blacklisted", "a blacklisted vendor's rates are not recorded", { vendorId });

  const ids = [...new Set(rows.map((r) => r.itemId))];
  const [found, packs] = await Promise.all([itemsByIds(db, ids), uomsByItems(db, ids)]);
  const out: VendorRateResult[] = [];
  let changedAny = false;
  for (const r of rows) {
    const fail = (code: string, message: string): void => { out.push({ itemId: r.itemId, ok: false, code, message }); };
    const item = found.get(r.itemId);
    if (item === undefined) { fail("unknown_item", `item ${r.itemId} not found`); continue; }
    if (item.mergedIntoItemId !== null) { fail("item_merged", `${item.name} was merged into another item — record the rate on that one`); continue; }
    if (!Number.isSafeInteger(r.ratePaise) || r.ratePaise < 0) { fail("po_invalid", `the rate for ${item.name} is not a sum of money`); continue; }
    if (r.mrpPaise !== undefined && r.mrpPaise !== null && (!Number.isSafeInteger(r.mrpPaise) || r.mrpPaise <= 0)) { fail("po_invalid", `the MRP for ${item.name} is not a sum of money`); continue; }
    if (r.validTo !== undefined && r.validTo !== null && (!isIsoDate(r.validTo) || r.validTo < validFrom)) { fail("po_invalid", `valid to for ${item.name} is before valid from`); continue; }
    const mine = [...(packs.get(r.itemId) ?? [])].sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier);
    const pack = r.uom !== undefined ? mine.find((p) => p.uom.toLowerCase() === r.uom!.toLowerCase())
      : r.packSize !== undefined ? mine.find((p) => p.toBaseMultiplier === r.packSize)
        : mine[0];
    if (pack === undefined) {
      const has = mine.map((p) => `${p.uom} of ${String(p.toBaseMultiplier)}`).join(", ") || "no packs";
      fail("unknown_uom", `${item.name} has no ${r.uom ?? (r.packSize === undefined ? "pack" : `pack of ${String(r.packSize)}`)} (it has ${has})`);
      continue;
    }
    const gstRateBps = r.gstRateBps ?? item.gstRateBps ?? 0;
    const mrpPaise = r.mrpPaise ?? null;
    const validTo = r.validTo ?? null;
    const result = await withTx(db, async (tx) => {
      await assertNotMerged(tx, [r.itemId], "recording a rate");
      const open = (await tx.select().from(vendorItemRates)
        .where(and(eq(vendorItemRates.vendorId, vendorId), eq(vendorItemRates.itemId, r.itemId), isNull(vendorItemRates.endedAt)))
        .for("update"))[0];
      if (open !== undefined && open.uom === pack.uom && open.ratePaise === r.ratePaise && open.gstRateBps === gstRateBps
        && open.mrpPaise === mrpPaise && open.validTo === validTo) {
        return { rateId: open.id, changed: false };
      }
      if (open !== undefined) {
        await tx.update(vendorItemRates).set({ endedAt: now, endedBy: actor.id }).where(eq(vendorItemRates.id, open.id));
      }
      const id = newId();
      await tx.insert(vendorItemRates).values({
        id, vendorId, itemId: r.itemId, uom: pack.uom, multiplier: pack.toBaseMultiplier, ratePaise: r.ratePaise,
        gstRateBps, mrpPaise, validFrom, validTo, source, createdBy: actor.id, createdAt: now,
      });
      return { rateId: id, changed: true };
    });
    changedAny ||= result.changed;
    out.push({ itemId: r.itemId, ok: true, ...result });
  }
  if (changedAny) {
    await withTx(db, (tx) => appendEvent(tx, vendorUpdated.make({ occurredAt: now, actor, correlationId: vendorId, payload: { vendorId, changed: ["rates"] } })));
  }
  return out;
}

/** End one open rate: the vendor withdrew the item, or the hospital no longer accepts it. */
export async function endVendorRate(db: Db, actor: Actor, rateId: string, now: Date = new Date()): Promise<void> {
  await requirePermission(db, actor, [VENDORS_MANAGE], "ending a vendor's rate");
  await withTx(db, async (tx) => {
    const [row] = await tx.select().from(vendorItemRates).where(eq(vendorItemRates.id, rateId)).for("update");
    if (row === undefined) throw new MaterialsError("unknown_item", `rate ${rateId} not found`, { rateId });
    if (row.endedAt !== null) return;
    await tx.update(vendorItemRates).set({ endedAt: now, endedBy: actor.id }).where(eq(vendorItemRates.id, rateId));
    await appendEvent(tx, vendorUpdated.make({ occurredAt: now, actor, correlationId: row.vendorId, payload: { vendorId: row.vendorId, changed: ["rates"] } }));
  });
}

/** A vendor's open rates, by item name. Whoever reads vendors, or raises orders, reads them. */
export async function vendorRates(db: Db, actor: Actor, vendorId: string): Promise<VendorRateView[]> {
  await requirePermission(db, actor, [VENDORS_READ, PO_RAISE], "reading a vendor's rates");
  const rows = await db.select({
    r: vendorItemRates, code: items.code, name: items.name, baseUom: items.baseUom,
  }).from(vendorItemRates).innerJoin(items, eq(items.id, vendorItemRates.itemId))
    .where(and(eq(vendorItemRates.vendorId, vendorId), isNull(vendorItemRates.endedAt)))
    .orderBy(asc(items.name)).limit(MAX_ROWS * 2);
  return rows.map(({ r, code, name, baseUom }) => ({
    id: r.id, vendorId: r.vendorId, itemId: r.itemId, itemCode: code, itemName: name, baseUom,
    uom: r.uom, multiplier: r.multiplier, ratePaise: r.ratePaise, gstRateBps: r.gstRateBps, mrpPaise: r.mrpPaise,
    validFrom: r.validFrom, validTo: r.validTo, source: r.source, createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * For each item, the rates in force on `now`'s IST day from vendors that are ACTIVE, cheapest per base unit
 * first (a strip of 10 at ₹20 beats a box of 100 at ₹210). No permission: a read the order paths make for
 * the person who already passed theirs.
 */
export async function contractRatesFor(db: Db | Tx, itemIds: readonly string[], now: Date = new Date()): Promise<Map<string, ContractRate[]>> {
  const out = new Map<string, ContractRate[]>();
  const wanted = [...new Set(itemIds)];
  if (wanted.length === 0) return out;
  const today = IST_DAY.format(now);
  const rows = await db.select({ r: vendorItemRates, legal: vendors.legalName, trade: vendors.tradeName })
    .from(vendorItemRates).innerJoin(vendors, eq(vendors.id, vendorItemRates.vendorId))
    .where(and(
      inArray(vendorItemRates.itemId, wanted), isNull(vendorItemRates.endedAt), eq(vendors.status, "active"),
      lte(vendorItemRates.validFrom, today), or(isNull(vendorItemRates.validTo), gte(vendorItemRates.validTo, today)),
    ))
    .orderBy(sql`${vendorItemRates.ratePaise}::numeric / ${vendorItemRates.multiplier}`, asc(vendorItemRates.createdAt));
  for (const { r, legal, trade } of rows) {
    out.set(r.itemId, [...(out.get(r.itemId) ?? []), {
      rateId: r.id, vendorId: r.vendorId, vendorName: trade ?? legal, uom: r.uom, multiplier: r.multiplier,
      ratePaise: r.ratePaise, gstRateBps: r.gstRateBps, mrpPaise: r.mrpPaise, validTo: r.validTo,
    }]);
  }
  return out;
}
