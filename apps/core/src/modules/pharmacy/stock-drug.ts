import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { anyOfText } from "../../kernel/db/any-of";
import { pharmacySaleItems } from "../../kernel/db/schema";
import { medicinesByIds, updateMedicine } from "../formulary";
import {
  MaterialsError, effectiveRegulation, findStoreByCode, listItems, listVendors, registerItem, setPriceRegulation, uomsByItems,
} from "../materials";
import { OPD_PHARMACY_STORE_CODE } from "./config";
import { PharmacyError } from "./errors";
import { PACK_UOM_PREFIX, norm } from "./opening-stock";
import { gstCategoryFor } from "./price";
import { registerSaleItem } from "./sale-items";
import { shelfLocationsFor } from "./shelf-locations";
import type { PackType } from "./opening-stock";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ STOCK ENTRY ON SCREEN (2026-09-29) — WHAT THE GRID LOOKS UP, AND THE NEW-DRUG DOOR ═══
 *
 * The owner enters the real shelf in the office's Stock → Opening stock sheet, one row per batch
 * (`opening-stock.ts` judges the rows). Two things the grid needs are here:
 *
 *   · `stockEntryItems` — the brand search: the item master's drugs, each with its strength and form (from its
 *     formulary medicine), its packs, GST, rack, last MRP, and whether the counter sells it yet.
 *   · `createStockDrug` — a brand the hospital has never stocked, in ONE transaction: the item and its pack
 *     unit (`registerItem`), its MRP (`setPriceRegulation`), its sale registration (`registerSaleItem`), and
 *     its schedule on the formulary medicine when the person changed it (`updateMedicine`). The existing acts,
 *     each with the permission its own screen asks for — nothing new is granted by this door.
 *
 * ═══ THE ITEM NAMES ITS FORMULARY MEDICINE ═══
 *
 * A drug item must (DD3, `assertDrugMedicinePairing`): OPD, emergency and IPD prescribe from the formulary,
 * and the counter matches a prescription line to a stocked brand through that link. The sheet searches the
 * 103k-row catalogue for it; a drug with no formulary row is added in the formulary first.
 */

/** The unit a new drug's ledger counts in, by pack type: a strip counts tablets, a bottle counts bottles. */
export const BASE_UOM_OF: Record<PackType, string> = {
  tablet_strip: "tablet", capsule_strip: "capsule", bottle: "bottle", vial: "vial", ampoule: "ampoule", tube: "tube",
  pouch: "pouch", sachet: "sachet", box: "unit", other: "unit",
};

/** A pack of more than one base unit: its unit's name — a strip is `strip`, five vials come in a `box`. */
export function packUomFor(packType: PackType): string {
  const prefix = PACK_UOM_PREFIX[packType];
  return prefix === BASE_UOM_OF[packType] ? "box" : prefix;
}

export type StockEntryItem = {
  itemId: string; code: string; name: string; baseUom: string;
  packs: { uom: string; multiplier: number }[];
  gstRateBps: number | null; hsnCode: string | null;
  /** Sold at the counter (an ACTIVE sale item). Stock is only received for what the counter sells. */
  onSale: boolean; active: boolean;
  strength: string | null; form: string | null; schedule: string | null;
  rack: string | null;
  /** The MRP on file (the price regulation in force), with its pack — to prefill a row. */
  mrpPaise: number | null; mrpUom: string | null;
};

const SEARCH_LIMIT = 15;

/** The brand search. Every word must match (name or code); the longest word narrows the read. */
export async function stockEntryItems(db: Db, search: string, now: Date = new Date()): Promise<StockEntryItem[]> {
  const words = norm(search).split(" ").filter((w) => w !== "");
  if (words.length === 0 || words.join("").length < 2) return [];
  const anchor = words.reduce((a, b) => (b.length > a.length ? b : a));
  const found = (await listItems(db, { class: "drug", search: anchor }))
    .filter((i) => i.mergedIntoItemId === null)
    .filter((i) => { const hay = norm(`${i.name} ${i.code}`); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => Number(!norm(a.name).startsWith(words[0]!)) - Number(!norm(b.name).startsWith(words[0]!)) || a.name.localeCompare(b.name))
    .slice(0, SEARCH_LIMIT);
  if (found.length === 0) return [];
  const ids = found.map((i) => i.id);
  const sale = await db.select({ itemId: pharmacySaleItems.itemId, active: pharmacySaleItems.active }).from(pharmacySaleItems)
    .where(anyOfText(pharmacySaleItems.itemId, ids));
  const onSale = new Set(sale.filter((s) => s.active).map((s) => s.itemId));
  const uoms = await uomsByItems(db, ids);
  const meds = await medicinesByIds(db, found.map((i) => i.formularyMedicineId).filter((m): m is string => m !== null));
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  const racks = store === undefined ? new Map<string, string>() : await shelfLocationsFor(db, store.id, ids);
  const out: StockEntryItem[] = [];
  for (const i of found) {
    const med = i.formularyMedicineId === null ? undefined : meds.get(i.formularyMedicineId);
    const reg = await effectiveRegulation(db, i.id, now);
    out.push({
      itemId: i.id, code: i.code, name: i.name, baseUom: i.baseUom,
      packs: (uoms.get(i.id) ?? []).map((u) => ({ uom: u.uom, multiplier: u.toBaseMultiplier })).sort((a, b) => a.multiplier - b.multiplier),
      gstRateBps: i.gstRateBps, hsnCode: i.hsnCode, onSale: onSale.has(i.id), active: i.active,
      strength: med?.strengthLabel ?? null, form: med?.form ?? null, schedule: med?.scheduleFlag ?? null,
      rack: racks.get(i.id) ?? null, mrpPaise: reg?.mrpDefaultPaise ?? null, mrpUom: reg?.mrpUom ?? null,
    });
  }
  return out;
}

/** The active suppliers a row may name (blank is OPENING STOCK). */
export async function stockEntrySuppliers(db: Db): Promise<{ id: string; code: string; name: string }[]> {
  return (await listVendors(db, { status: "active" })).map((v) => ({ id: v.id, code: v.code, name: v.tradeName ?? v.legalName }));
}

/** A formulary medicine as the new-drug sheet shows it once picked: its form, strength and schedule. */
export async function stockEntryMedicine(db: Db, medicineId: string): Promise<{ id: string; name: string; form: string; strength: string | null; schedule: string | null }> {
  const med = (await medicinesByIds(db, [medicineId])).get(medicineId);
  if (med === undefined) throw new MaterialsError("unknown_item", `formulary medicine ${medicineId} not found`, { medicineId });
  return { id: med.id, name: med.brandName, form: med.form, strength: med.strengthLabel, schedule: med.scheduleFlag };
}

export type NewStockDrug = {
  brandName: string; strength: string; medicineId: string; form: string;
  packType: PackType; packSize: number;
  hsnCode: string; gstRateBps: number;
  /** The law's class. Written onto the formulary medicine only when it differs from what is there (`formulary.manage`). */
  schedule: "H" | "H1" | "X" | "OTC" | null;
  mrpPerPackPaise: number;
  storage: "ambient" | "cold_2_8";
};

/** "DOLO650" from "Dolo 650" — letters and digits, upper case, at most 24. */
function codeStem(name: string): string {
  return norm(name).replace(/ /g, "").toUpperCase().slice(0, 24) || "DRUG";
}

/**
 * A NEW DRUG, ready to receive stock: item + pack unit + MRP + sale registration (+ schedule), all or nothing.
 *
 * The route is gated on `materials.items.manage` (creating an item is the item master's act). Registering it
 * for sale is `pharmacy.sale_items.manage` and changing the medicine's schedule is `formulary.manage`; both are
 * asked here, before anything is written, and a person without one is told which — never lent it.
 */
export async function createStockDrug(
  db: Db, actor: Actor, input: NewStockDrug, now: Date = new Date(),
): Promise<{ itemId: string; code: string; name: string; uom: string; packSize: number; gstRateBps: number }> {
  const lacking: string[] = [];
  if (!(await hasPermission(db, actor.id, "pharmacy.sale_items.manage", "hospital"))) lacking.push("pharmacy.sale_items.manage");
  const med = (await medicinesByIds(db, [input.medicineId])).get(input.medicineId);
  if (med === undefined) throw new MaterialsError("unknown_item", `formulary medicine ${input.medicineId} not found — pick it from the formulary search`, { medicineId: input.medicineId });
  const scheduleChanges = input.schedule !== null && input.schedule !== med.scheduleFlag;
  if (scheduleChanges && !(await hasPermission(db, actor.id, "formulary.manage", "hospital"))) lacking.push("formulary.manage");
  if (lacking.length > 0) {
    throw new PharmacyError("permission_denied", `a new drug also needs ${lacking.join(" and ")} — ask the pharmacist in charge`, { lacking });
  }
  gstCategoryFor(input.gstRateBps); // a slab the bill cannot tax is refused before the item exists

  const brand = input.brandName.trim().replace(/\s+/g, " ");
  const strength = input.strength.trim();
  const strengthDigits = /[\d.]+/.exec(strength)?.[0];
  const withStrength = strength === "" || (strengthDigits !== undefined && norm(brand).split(" ").includes(norm(strengthDigits))) ? brand : `${brand} ${strength}`;
  const form = input.form.trim();
  const name = form === "" || norm(withStrength).endsWith(norm(form)) ? withStrength : `${withStrength} ${form}`;

  // The same name twice is two piles of one drug. Refused, with the one that exists named.
  const same = (await listItems(db, { class: "drug", search: brand })).find((i) => norm(i.name) === norm(name));
  if (same !== undefined) {
    throw new MaterialsError("duplicate_code", `"${same.name}" is already in the item master (${same.code}) — pick it from the search`, { itemId: same.id, code: same.code });
  }
  const stem = codeStem(withStrength);
  const taken = new Set((await listItems(db, { search: stem })).map((i) => i.code.toUpperCase()));
  let code = stem;
  for (let n = 2; taken.has(code); n += 1) code = `${stem}-${String(n)}`;

  const baseUom = BASE_UOM_OF[input.packType];
  const packUom = input.packSize > 1 ? packUomFor(input.packType) : baseUom;
  return withTx(db, async (tx) => {
    const { itemId } = await registerItem(tx, actor, {
      code, name, class: "drug", baseUom, batchTracked: true, formularyMedicineId: med.id,
      hsnCode: input.hsnCode, gstRateBps: input.gstRateBps, storageClass: input.storage,
      uoms: input.packSize > 1 ? [{ uom: packUom, toBaseMultiplier: input.packSize, isPurchaseUom: true, isIssueUom: true }] : [],
    });
    await setPriceRegulation(tx, actor, itemId, { mrpDefaultPaise: input.mrpPerPackPaise, mrpUom: packUom, effectiveFrom: now });
    await registerSaleItem(tx, actor, itemId);
    if (scheduleChanges) await updateMedicine(tx, actor, med.id, { scheduleFlag: input.schedule });
    return { itemId, code, name, uom: packUom, packSize: input.packSize, gstRateBps: input.gstRateBps };
  });
}
