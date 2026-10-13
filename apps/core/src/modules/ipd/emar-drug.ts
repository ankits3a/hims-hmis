import { ndpsClassByMedicine, resolveMedicines } from "../formulary";
import { shelfByMedicine } from "../pharmacy";
import { isHighAlert, isTimeCritical } from "./emar-rules";
import type { Db, Tx } from "../../kernel/db/client";
import type { ShelfEntry } from "../pharmacy";
import type { IpdOrderRow } from "./orders";

/**
 * E4.3 (#735) — what the eMAR knows about an order's DRUG, from the catalogues it does not own: the pharmacy's stocked item
 * (its NABH `high_alert` / `lasa` flags and the tall-man `lasa_note`), the formulary's composition (moieties, classes —
 * for the time-critical and high-alert words, the duplicate and interaction checks) and the NDPS class (a narcotic goes on
 * the ward register and is high-alert). Read through each module's `index.ts`; nothing here queries their tables.
 */
export type EmarDrug = {
  medicineId: string;
  name: string;
  shelf: ShelfEntry | null;
  saltIds: string[];
  moieties: string[];
  classes: (string | null)[];
  narcotic: boolean;
  highAlert: boolean;
  timeCritical: boolean;
  lasa: boolean;
  /** The tall-man sentence the item master carries ("hydrOXYzine vs hydrALAZINE"), or null. */
  tallMan: string | null;
};

export async function emarDrugsOf(db: Db | Tx, orders: readonly IpdOrderRow[]): Promise<Map<string, EmarDrug>> {
  const out = new Map<string, EmarDrug>();
  const drugs = orders.filter((o) => o.kind === "drug" && o.medicineId !== null);
  if (drugs.length === 0) return out;
  const ids = [...new Set(drugs.map((o) => o.medicineId!))];
  const [shelf, resolved, ndps] = await Promise.all([
    shelfByMedicine(db), resolveMedicines(db as Db, ids), ndpsClassByMedicine(db, ids),
  ]);
  for (const o of drugs) {
    const s = shelf.get(o.medicineId!) ?? null;
    const r = resolved.get(o.medicineId!);
    const words = { name: o.medicineName ?? "", moieties: (r?.salts ?? []).map((x) => x.moiety), classes: (r?.salts ?? []).map((x) => x.drugClass) };
    const narcotic = ndps.get(o.medicineId!) === "narcotic";
    out.set(o.id, {
      medicineId: o.medicineId!, name: o.medicineName ?? "", shelf: s,
      saltIds: (r?.salts ?? []).map((x) => x.saltId), moieties: words.moieties, classes: words.classes,
      narcotic, highAlert: isHighAlert(s?.item.highAlert === true, narcotic, words), timeCritical: isTimeCritical(o.antibiotic, words),
      lasa: s?.item.lasa === true, tallMan: s?.item.lasa === true ? (s.item.lasaNote ?? null) : null,
    });
  }
  return out;
}
