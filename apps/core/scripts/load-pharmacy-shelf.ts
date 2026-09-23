import { readFileSync } from "node:fs";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { medicineIdsByBrandNames } from "../src/modules/formulary";
import { findStoreByCode, listItems, registerItem } from "../src/modules/materials";
import { OPD_PHARMACY_STORE_CODE, gstCategoryFor, listSaleItems, registerSaleItem, setShelfLocation, shelfLocationsFor } from "../src/modules/pharmacy";
import { argValue, hasFlag, parseCsv, resolvePerson } from "./pharmacy-shelf-common";
import type { CsvFile } from "./pharmacy-shelf-common";
import type { Person } from "./pharmacy-shelf-common";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/load-pharmacy-shelf.ts --list scripts/data/pharmacy-starter-list.csv --as <materials_head> --pharmacist <pharmacist> [--apply]`
 *
 * ═══ THE STARTER LIST, MADE REAL — THROUGH THE SCREENS' OWN WRITERS ═══
 *
 * For every row of the list `build-pharmacy-starter-list.ts` wrote (and a person read):
 *
 *   1. the drug ITEM — `registerItem`, as `--as` (materials_head, `materials.items.manage`, the
 *      /materials/items screen's permission): linked to its formulary medicine (DD3), base unit + pack
 *      unit, HSN, and the GST slab from the list;
 *   2. its SALE registration — `registerSaleItem`, as `--pharmacist` (`pharmacy.sale_items.manage`,
 *      /pharmacy/items): mints the `RX-<code>` tariff service at the slab's category, so the bill taxes
 *      at the slab from the first line (`pharmacy_gst_slab_set`);
 *   3. its RACK at the OPD counter — `setShelfLocation`, as `--pharmacist`.
 *
 * Two named people, because §2 of the go-live runbook is two people; neither is minted — both are
 * looked up and must hold the permission their screen is gated on.
 *
 * ═══ IDEMPOTENT, AND IT NEVER OVERWRITES A PERSON ═══
 *
 * An item already there (by code, or already stocking that medicine under another code) is ADOPTED:
 * its sale registration and rack are added if missing, and nothing about it is changed. A slab or rack
 * that differs from the list is REPORTED, not corrected — somebody may have set it at the desk, and
 * that decision outranks a generated list. A rerun on a loaded shelf writes nothing.
 *
 * ═══ ALL OR NOTHING ═══
 *
 * The whole list is judged before anything is written (every brand must resolve to an active formulary
 * medicine; a code taken by a different medicine refuses), then written in ONE transaction.
 */

const REQUIRED = ["code", "brand_name", "base_uom", "gst_rate_bps", "hsn_code"] as const;

export type ShelfPlanRow = {
  line: number; code: string; brandName: string; medicineId?: string; itemId?: string;
  verdict: "create" | "adopt" | "refuse";
  needsSaleItem: boolean; needsRack: boolean; rack: string; reasons: string[]; notes: string[];
  gstRateBps: number | null; baseUom: string; packUom: string; packMultiplier: number | null; hsnCode: string;
};

export type ShelfPlan = {
  rows: ShelfPlanRow[]; creates: number; adopts: number; refusals: number;
  saleItemsToRegister: number; racksToSet: number; storeId: string | null;
};

export async function planShelf(db: Db, file: CsvFile): Promise<ShelfPlan> {
  const missing = REQUIRED.filter((c) => !file.header.includes(c));
  if (missing.length > 0) throw new Error(`the list is missing column(s): ${missing.join(", ")}`);
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  const medicines = await medicineIdsByBrandNames(db, file.rows.map((r) => r.cells.brand_name ?? "").filter((b) => b !== ""));
  const drugItems = await listItems(db, { class: "drug" });
  const byCode = new Map(drugItems.map((i) => [i.code.toLowerCase(), i]));
  const byMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId!, i]));
  const sale = new Set((await listSaleItems(db)).map((s) => s.itemId));
  const racks = store === undefined ? new Map<string, string>() : await shelfLocationsFor(db, store.id, drugItems.map((i) => i.id));
  const seenCodes = new Map<string, number>();
  const seenMeds = new Map<string, number>();

  const rows: ShelfPlanRow[] = file.rows.map((r) => {
    const c = r.cells;
    const slab = (c.gst_rate_bps ?? "") === "" ? null : Number(c.gst_rate_bps);
    const mult = (c.pack_multiplier ?? "") === "" ? null : Number(c.pack_multiplier);
    const row: ShelfPlanRow = {
      line: r.line, code: c.code ?? "", brandName: c.brand_name ?? "", verdict: "refuse", needsSaleItem: false, needsRack: false,
      rack: c.rack ?? "", reasons: [], notes: [], gstRateBps: slab, baseUom: c.base_uom ?? "", packUom: c.pack_uom ?? "",
      packMultiplier: mult, hsnCode: c.hsn_code ?? "",
    };
    if (row.code === "") row.reasons.push("code_required");
    if (row.baseUom === "") row.reasons.push("base_uom_required");
    if (slab !== null) { try { gstCategoryFor(slab); } catch { row.reasons.push(`gst_rate_bps_not_a_slab:${String(slab)}`); } }
    if (row.packUom !== "" && (mult === null || !Number.isInteger(mult) || mult < 2)) row.reasons.push("pack_multiplier_must_be_an_integer_above_1");
    const prevCode = seenCodes.get(row.code.toLowerCase());
    if (prevCode !== undefined) row.reasons.push(`duplicate_code_also_on_line:${String(prevCode)}`);
    seenCodes.set(row.code.toLowerCase(), r.line);

    row.medicineId = medicines.get(row.brandName.toLowerCase());
    if (row.medicineId === undefined) { row.reasons.push(`unknown_medicine_brand:${row.brandName}`); return row; }
    const prevMed = seenMeds.get(row.medicineId);
    if (prevMed !== undefined) row.reasons.push(`medicine_also_on_line:${String(prevMed)}`);
    seenMeds.set(row.medicineId, r.line);

    const existing = byCode.get(row.code.toLowerCase()) ?? byMedicine.get(row.medicineId);
    if (existing !== undefined) {
      if (existing.formularyMedicineId !== row.medicineId) {
        row.reasons.push(`code_taken_by_another_medicine:${existing.code}`);
      } else {
        row.itemId = existing.id;
        if (existing.code.toLowerCase() !== row.code.toLowerCase()) row.notes.push(`already stocked as ${existing.code}`);
        if (existing.gstRateBps !== slab) row.notes.push(`slab on file ${String(existing.gstRateBps)} ≠ list ${String(slab)} — left alone`);
        if (!existing.active) row.reasons.push("item_inactive — reactivate it at /materials/items first");
      }
    }
    row.needsSaleItem = row.itemId === undefined || !sale.has(row.itemId);
    const onFile = row.itemId === undefined ? undefined : racks.get(row.itemId);
    row.needsRack = row.rack !== "" && onFile === undefined;
    if (onFile !== undefined && row.rack !== "" && onFile !== row.rack) row.notes.push(`rack on file "${onFile}" ≠ list "${row.rack}" — left alone`);
    if (row.reasons.length === 0) row.verdict = row.itemId === undefined ? "create" : "adopt";
    return row;
  });
  if (store === undefined) {
    for (const r of rows) {
      if (!r.needsRack) continue;
      r.reasons.push("store_missing: run seed:pharmacy first");
      r.verdict = "refuse";
    }
  }
  return {
    rows, storeId: store?.id ?? null,
    creates: rows.filter((r) => r.verdict === "create").length,
    adopts: rows.filter((r) => r.verdict === "adopt").length,
    refusals: rows.filter((r) => r.verdict === "refuse").length,
    saleItemsToRegister: rows.filter((r) => r.verdict !== "refuse" && r.needsSaleItem).length,
    racksToSet: rows.filter((r) => r.verdict !== "refuse" && r.needsRack).length,
  };
}

export async function applyShelf(
  db: Db, head: Person, pharmacist: Person, plan: ShelfPlan, now: Date = new Date(),
): Promise<{ itemsCreated: number; saleItemsRegistered: number; racksSet: number }> {
  if (plan.refusals > 0) throw new Error(`refusing to apply: ${String(plan.refusals)} row(s) were refused`);
  return withTx(db, async (tx) => {
    let itemsCreated = 0; let saleItemsRegistered = 0; let racksSet = 0;
    for (const r of plan.rows) {
      let itemId = r.itemId;
      if (itemId === undefined) {
        ({ itemId } = await registerItem(tx, head, {
          code: r.code, name: r.brandName, class: "drug", baseUom: r.baseUom, batchTracked: true,
          formularyMedicineId: r.medicineId ?? null, hsnCode: r.hsnCode === "" ? null : r.hsnCode, gstRateBps: r.gstRateBps,
          uoms: r.packUom === "" || r.packMultiplier === null ? [] : [{ uom: r.packUom, toBaseMultiplier: r.packMultiplier, isPurchaseUom: true, isIssueUom: true }],
        }));
        itemsCreated += 1;
      }
      if (r.needsSaleItem) { await registerSaleItem(tx, pharmacist, itemId); saleItemsRegistered += 1; }
      if (r.needsRack && plan.storeId !== null) {
        /* `setShelfLocation` opens its own transaction on what it is handed; handed THIS transaction it
           nests as a savepoint, so the rack commits with the item or not at all — and its "is this a
           sale item?" read sees the registration made two lines up, which the pool would not. */
        await setShelfLocation(tx as unknown as Db, pharmacist, { storeResourceId: plan.storeId, itemId, location: r.rack }, now);
        racksSet += 1;
      }
    }
    return { itemsCreated, saleItemsRegistered, racksSet };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const listPath = argValue(argv, "--list");
  if (listPath === undefined) throw new Error("usage: --list <starter-list.csv> --as <materials_head> --pharmacist <pharmacist> [--apply]");
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const head = await resolvePerson(db, argValue(argv, "--as"), "materials.items.manage", "--as");
    const pharmacist = await resolvePerson(db, argValue(argv, "--pharmacist"), "pharmacy.sale_items.manage", "--pharmacist");
    const plan = await planShelf(db, parseCsv(readFileSync(listPath, "utf8")));
    for (const r of plan.rows) {
      if (r.verdict === "refuse" || r.notes.length > 0) {
        process.stdout.write(`  line ${String(r.line).padStart(4)}  ${r.verdict.padEnd(7)} ${r.code.padEnd(16)} ${[...r.reasons, ...r.notes].join("; ")}\n`);
      }
    }
    process.stdout.write(
      `\nshelf · ${String(plan.rows.length)} rows · create ${String(plan.creates)} · adopt ${String(plan.adopts)} · REFUSE ${String(plan.refusals)}\n` +
      `  sale registrations to add ${String(plan.saleItemsToRegister)} · racks to set ${String(plan.racksToSet)}\n` +
      `  items by ${head.username} (${head.fullName}); sale items and racks by ${pharmacist.username} (${pharmacist.fullName})\n`,
    );
    if (plan.refusals > 0) { process.stdout.write("\nNOTHING WAS WRITTEN — fix the refused rows; the list is applied whole or not at all.\n"); process.exitCode = 1; return; }
    if (!hasFlag(argv, "--apply")) { process.stdout.write("\nDRY RUN — nothing written. Re-run with --apply.\n"); return; }
    const done = await applyShelf(db, head, pharmacist, plan);
    process.stdout.write(`\nAPPLIED in one transaction: ${String(done.itemsCreated)} items, ${String(done.saleItemsRegistered)} sale registrations, ${String(done.racksSet)} racks.\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
