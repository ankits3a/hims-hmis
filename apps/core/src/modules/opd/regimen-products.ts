import { eq } from "drizzle-orm";
import { pharmacySaleItems } from "../../kernel/db/schema";
import { productSpecFor } from "../cds";
import { matchProducts } from "../formulary";
import { listItems } from "../materials";
import type { BuiltLine } from "../cds";
import type { ProductMatch } from "../formulary";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE MEDICINES THE COUNTER CAN SELL — READ HERE, NOT ASKED OF `pharmacy` ═══
 *
 * "Stocked" is the pharmacy's own definition (`pharmacy/shelf.ts`): an active drug item, bridged
 * to its formulary medicine, registered as an active sale item. The items half is asked of
 * `materials` through its index. The sale-items half is one column of one table read directly,
 * because `pharmacy` already imports `opd` (it re-runs `runRxChecks` at the counter) and importing
 * it back would make the two modules a cycle. It is a READ of which ids are sellable, nothing more:
 * no price, no stock level, no write.
 */
export async function stockedMedicineIds(db: Db): Promise<string[]> {
  const drugItems = await listItems(db, { class: "drug", active: true });
  if (drugItems.length === 0) return [];
  const sale = await db.select({ itemId: pharmacySaleItems.itemId })
    .from(pharmacySaleItems).where(eq(pharmacySaleItems.active, true));
  const saleable = new Set(sale.map((s) => s.itemId));
  return [...new Set(drugItems
    .filter((i) => i.formularyMedicineId !== null && saleable.has(i.id))
    .map((i) => i.formularyMedicineId as string))];
}

/**
 * One product per regimen line, or null. A line that is advice (a cold compress, fluids) is not a
 * drug and is never matched. A BLOCKED line is matched like any other: if a doctor issues it
 * anyway, the id is what makes the issue-time allergy check see the moiety it is blocked for.
 */
export async function productsForRegimen(db: Db, lines: readonly BuiltLine[]): Promise<(ProductMatch | null)[]> {
  const specs = lines.map((l) => (l.dose.state === "advice_only" ? null : productSpecFor(l.drugLabel)));
  if (specs.every((s) => s === null)) return lines.map(() => null);
  return matchProducts(db, specs, await stockedMedicineIds(db));
}
