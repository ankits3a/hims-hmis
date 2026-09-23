import { equivalentMedicines } from "../formulary";
import { availableQtyByItem, findStoreByCode } from "../materials";
import { OPD_PHARMACY_STORE_CODE, REFUSED_FLAGS } from "./config";
import { shelfByMedicine } from "./shelf";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ CONSULT V2 — WHAT THE PHARMACY CAN HAND OVER, SHOWN TO THE DOCTOR WHILE THEY PRESCRIBE ═══
 *
 * Owner, 2026-09-23: every medicine on the doctor's screen shows how many the pharmacy has; at zero the
 * screen offers an alternative, and the doctor may ignore it. This states, it changes nothing: no
 * reservation, no substitution, no gate on the prescription.
 *
 * "How many" is SELLABLE stock (D13): `availableQtyByItem`, the predicate the FEFO pick obeys — expired,
 * recalled, reserved and frozen quantities excluded — at the OPD pharmacy store. Never the raw on-hand.
 *
 * UNKNOWN IS NOT ZERO. When there is no OPD pharmacy store, or no medicine is on sale at all (a hospital
 * whose pharmacy is not open), every answer is `null` and the screen shows no tag. Telling a doctor
 * "0 in stock" about a pharmacy that does not exist would push them to switch a correct prescription.
 *
 * A medicine the shelf does not carry IS a real zero: this pharmacy cannot hand it over. Its
 * alternatives are what `alternativesFor` would offer at the counter — the same composition among what
 * the shelf carries, minus what this counter may not dispense — kept to those with stock, most first.
 */
export type DoctorStockAlternative = { medicineId: string; brandName: string; strengthLabel: string | null; available: number; unit: string };
export type DoctorStock = { medicineId: string; available: number | null; unit: string | null; alternatives: DoctorStockAlternative[] };

const MAX_ALTERNATIVES = 3;

export async function stockForDoctor(db: Db, medicineIds: readonly string[], now: Date = new Date()): Promise<DoctorStock[]> {
  const ids = [...new Set(medicineIds)].filter((id) => id !== "");
  if (ids.length === 0) return [];
  const unknown = (): DoctorStock[] => ids.map((medicineId) => ({ medicineId, available: null, unit: null, alternatives: [] }));

  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) return unknown();
  const shelf = await shelfByMedicine(db);
  if (shelf.size === 0) return unknown();

  const onShelf = ids.map((id) => shelf.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined);
  const available = await availableQtyByItem(db, store.id, onShelf.map((e) => e.item.id), now);

  const out: DoctorStock[] = [];
  for (const medicineId of ids) {
    const entry = shelf.get(medicineId);
    const qty = entry === undefined ? 0 : (available.get(entry.item.id) ?? 0);
    const row: DoctorStock = { medicineId, available: qty, unit: entry?.item.baseUom ?? null, alternatives: [] };
    if (qty === 0) {
      const candidates = (await equivalentMedicines(db, medicineId, { among: [...shelf.keys()] }))
        .filter((m) => m.scheduleFlag === null || !(REFUSED_FLAGS as readonly string[]).includes(m.scheduleFlag));
      const entries = candidates.map((m) => ({ m, e: shelf.get(m.id)! }));
      const qtys = await availableQtyByItem(db, store.id, entries.map((x) => x.e.item.id), now);
      row.alternatives = entries
        .map(({ m, e }) => ({ medicineId: m.id, brandName: m.brandName, strengthLabel: m.strengthLabel, available: qtys.get(e.item.id) ?? 0, unit: e.item.baseUom }))
        .filter((a) => a.available > 0)
        .sort((a, b) => b.available - a.available)
        .slice(0, MAX_ALTERNATIVES);
      if (row.unit === null) row.unit = row.alternatives[0]?.unit ?? null; // not carried here: the unit its alternatives count in
    }
    out.push(row);
  }
  return out;
}
