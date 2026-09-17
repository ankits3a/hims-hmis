import { and, eq, inArray } from "drizzle-orm";
import { items, pharmacySaleItems } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { medicinesByIds, normalizeDrugName, saltsByIds } from "../formulary";
import { updateItem } from "../materials";
import { serviceCategoriesByIds, updateService } from "../tariff";
import { gstCategoryFor } from "./price";
import type { Actor } from "@hmis/contracts";
import type { MedicineWithSalts } from "../formulary";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P16 — EACH DRUG'S GST SLAB, FROM THE NOTIFICATION, AND THE BILL THAT FOLLOWS IT ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p16-gst-slabs.md`.
 *
 * **The rule (56th GST Council, effective 22 September 2025, Notification 9/2025-Central Tax
 * (Rate)).**
 *   - Medicaments under HSN 3003/3004 are 5%; the 12% slab for medicines is gone.
 *   - The drugs named in Lists 3 and 4 of that notification are nil: 33 moved from 12% and 3 from 5%.
 *   - A product is nil only when EVERY active ingredient is on the list. A combination with anything
 *     else is still 5%.
 *   - Supplements and wellness products (HSN 2106, 18%) are not medicaments. The rule never
 *     suggests 18%, because the HSN the item master records decides that, not the molecule.
 *   - The rate follows the molecule under the notification, not the brand, so a molecule rule is
 *     more reliable than reading e-commerce listings, which do not reliably state the rate.
 *
 * **Why the sale item's service moves with the slab.** `registerSaleItem` copies the slab into the
 * tariff service's GST category when the item is registered, and the bill taxes by that category.
 * A slab corrected afterwards used to leave the bill on the old rate. `setItemGstSlab` writes both,
 * in one transaction, and the census row `pharmacy_gst_slab_set` is red while any active sale item
 * has no slab or a category that no longer matches it.
 */
export const GST_NOTIFICATION = "Notification 9/2025-Central Tax (Rate), Lists 3 and 4, effective 22 September 2025";

/** The 36 nil-rated drugs, as the notification names them. */
export const NIL_RATED_DRUGS = [
  // List 3 — 33 drugs moved from 12% to nil.
  "Onasemnogene abeparvovec", "Asciminib", "Mepolizumab", "Pegylated liposomal irinotecan", "Daratumumab",
  "Daratumumab subcutaneous", "Teclistamab", "Amivantamab", "Alectinib", "Risdiplam", "Obinutuzumab",
  "Polatuzumab vedotin", "Entrectinib", "Atezolizumab", "Spesolimab", "Velaglucerase alfa", "Agalsidase alfa",
  "Rurioctocog alfa pegol", "Idursulphatase", "Alglucosidase alfa", "Laronidase", "Olipudase alfa", "Tepotinib",
  "Avelumab", "Emicizumab", "Belumosudil", "Miglustat", "Velmanase alfa", "Alirocumab", "Evolocumab",
  "Cysteamine bitartrate", "C1 esterase inhibitor", "Inclisiran",
  // List 4 — 3 drugs moved from 5% to nil.
  "Agalsidase beta", "Imiglucerase", "Eptacog alfa (activated recombinant coagulation factor VIIa)",
] as const;

/**
 * A name reduced to what the list is matched on: the formulary's normalisation, "alpha" spelt
 * "alfa", "sulphate" spelt "sulfate", and a parenthetical dropped.
 */
export function nilKey(name: string): string {
  return normalizeDrugName(name.replace(/\(.*?\)/g, " "))
    .replace(/\balpha\b/g, "alfa")
    .replace(/sulph/g, "sulf")
    .replace(/\bcystamine\b/g, "cysteamine")
    .replace(/\bci inhibitor\b/g, "c1 esterase inhibitor")
    .replace(/\bc1 inhibitor\b/g, "c1 esterase inhibitor")
    .trim();
}

const NIL_KEYS = new Set(NIL_RATED_DRUGS.map(nilKey));

export type GstSuggestion = { rateBps: 0 | 500; basis: string };

/**
 * The slab a medicine with these ingredients takes. `null` when there is nothing to judge (no
 * ingredient known): an item with no medicine behind it is left for a person.
 */
export function suggestGstSlab(ingredients: readonly { name: string; aliases?: readonly string[] }[]): GstSuggestion | null {
  if (ingredients.length === 0) return null;
  const nilNames = ingredients.map((i) => [i.name, ...(i.aliases ?? [])].find((n) => NIL_KEYS.has(nilKey(n))));
  if (nilNames.every((n) => n !== undefined)) {
    return { rateBps: 0, basis: `nil: ${nilNames.join(" + ")} (${GST_NOTIFICATION})` };
  }
  return { rateBps: 500, basis: "5%: medicaments, HSN 3003/3004 (GST Council, 22 September 2025)" };
}

/**
 * Sets a drug item's slab and, if it is registered for sale, its service's GST category in the
 * same transaction, so the bill follows the slab.
 */
export async function setItemGstSlab(tx: Tx, actor: Actor, itemId: string, rateBps: number): Promise<{ categoryChanged: boolean }> {
  gstCategoryFor(rateBps);
  await updateItem(tx, actor, itemId, { gstRateBps: rateBps });
  return syncSaleItemCategory(tx, actor, itemId, rateBps);
}

/** The sale item's service category, brought to the slab. A no-op when it already matches. */
export async function syncSaleItemCategory(tx: Tx, actor: Actor, itemId: string, rateBps: number): Promise<{ categoryChanged: boolean }> {
  const category = gstCategoryFor(rateBps);
  const [sale] = await tx.select({ serviceId: pharmacySaleItems.serviceId }).from(pharmacySaleItems).where(eq(pharmacySaleItems.itemId, itemId));
  if (sale === undefined) return { categoryChanged: false };
  const current = (await serviceCategoriesByIds(tx, [sale.serviceId])).get(sale.serviceId);
  if (current === category) return { categoryChanged: false };
  await updateService(tx, actor, sale.serviceId, { category });
  return { categoryChanged: true };
}

export type GstSlabPlanRow = {
  itemId: string;
  code: string;
  name: string;
  current: number | null;
  suggested: number | null;
  basis: string | null;
  /** `set`: a blank slab gets the suggestion; `differs`: a slab disagrees with it; `ok`; `unknown`: nothing to judge. */
  verdict: "set" | "differs" | "ok" | "unknown";
  /** The sale item's service category does not match the item's slab, whatever the verdict. */
  categoryStale: boolean;
};

/** Every active drug item, judged. Read-only. */
export async function gstSlabPlan(db: Db): Promise<GstSlabPlanRow[]> {
  const drugs = await db.select({
    id: items.id, code: items.code, name: items.name, gstRateBps: items.gstRateBps, medicineId: items.formularyMedicineId,
  }).from(items).where(and(eq(items.class, "drug"), eq(items.active, true))).orderBy(items.code);
  if (drugs.length === 0) return [];
  const medicineIds = [...new Set(drugs.map((d) => d.medicineId).filter((m): m is string => m !== null))];
  const plan: GstSlabPlanRow[] = [];
  const sales = await db.select().from(pharmacySaleItems).where(inArray(pharmacySaleItems.itemId, drugs.map((d) => d.id)));
  const serviceOf = new Map(sales.map((s) => [s.itemId, s.serviceId] as const));
  const categories = await serviceCategoriesByIds(db, sales.map((s) => s.serviceId));
  // Bounded reads, a page at a time (the formulary refuses unbounded questions).
  const medicines = new Map<string, MedicineWithSalts>();
  for (let i = 0; i < medicineIds.length; i += 500) {
    for (const [k, v] of await medicinesByIds(db, medicineIds.slice(i, i + 500))) medicines.set(k, v);
  }
  const saltIds = [...new Set([...medicines.values()].flatMap((m) => m.salts.map((s) => s.saltId)))];
  const salts = new Map<string, { name: string; aliases: string[] }>();
  for (let i = 0; i < saltIds.length; i += 500) {
    for (const [k, v] of await saltsByIds(db, saltIds.slice(i, i + 500))) salts.set(k, { name: v.name, aliases: v.aliases ?? [] });
  }
  for (const d of drugs) {
    const med = d.medicineId === null ? undefined : medicines.get(d.medicineId);
    const ingredients = (med?.salts ?? []).map((s) => salts.get(s.saltId)).filter((s): s is { name: string; aliases: string[] } => s !== undefined);
    const suggestion = suggestGstSlab(ingredients);
    const verdict: GstSlabPlanRow["verdict"] = suggestion === null ? "unknown"
      : d.gstRateBps === null ? "set"
        : d.gstRateBps === suggestion.rateBps ? "ok" : "differs";
    const serviceId = serviceOf.get(d.id);
    let categoryStale = false;
    if (serviceId !== undefined && d.gstRateBps !== null) {
      try {
        categoryStale = categories.get(serviceId) !== gstCategoryFor(d.gstRateBps);
      } catch {
        categoryStale = true;
      }
    }
    plan.push({
      itemId: d.id, code: d.code, name: d.name, current: d.gstRateBps,
      suggested: suggestion?.rateBps ?? null, basis: suggestion?.basis ?? null, verdict, categoryStale,
    });
  }
  return plan;
}

/**
 * Applies a plan: every `set` row, every `differs` row when `overwrite`, and every stale category.
 * One transaction for the whole plan, so a failure leaves nothing half-applied.
 */
export async function applyGstSlabPlan(
  db: Db, actor: Actor, plan: readonly GstSlabPlanRow[], opts: { overwrite?: boolean } = {},
): Promise<{ slabsSet: number; categoriesSynced: number }> {
  return withTx(db, async (tx) => {
    let slabsSet = 0;
    let categoriesSynced = 0;
    for (const row of plan) {
      const target = row.verdict === "set" || (row.verdict === "differs" && opts.overwrite === true) ? row.suggested : row.current;
      if (target === null) continue;
      if (target !== row.current) {
        const r = await setItemGstSlab(tx, actor, row.itemId, target);
        slabsSet += 1;
        if (r.categoryChanged) categoriesSynced += 1;
      } else if (row.categoryStale) {
        const r = await syncSaleItemCategory(tx, actor, row.itemId, target);
        if (r.categoryChanged) categoriesSynced += 1;
      }
    }
    return { slabsSet, categoriesSynced };
  });
}
