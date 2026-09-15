import { eq } from "drizzle-orm";
import { anyOfText } from "../../kernel/db/any-of";
import { formularyMedicineSalts, formularyMedicines, formularySalts } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { MedicineWithSalts, SaltRow } from "./masters";

/**
 * ═══ THE ID-KEYED READS: ASK FOR WHAT YOU NEED, NOT FOR THE CATALOGUE ═══
 *
 * Every caller in this repo that reached for `listMedicines` wanted a HANDFUL of medicines — the
 * ones on a dispense, on a label, on a claim — and got the whole national catalogue because that
 * was the only question the module knew how to answer. `queue.ts` did it most plainly: it loaded
 * every row and then wrote `.filter((m) => medicineIds.includes(m.id))`, an O(catalogue × lines)
 * scan to keep two of them.
 *
 * At 103,383 rows that read does not merely waste a heap — it THROWS, because drizzle's `inArray`
 * emits one bind parameter per id and the wire protocol counts them in an Int16. See
 * `kernel/db/any-of.ts` for the measured reproduction; `catalogue-scale.test.ts` is the pin.
 *
 * ═══ THESE READERS REFUSE RATHER THAN TRUNCATE ═══
 *
 * Past `MAX_IDS` they throw. They never return a short map. A cap that silently drops a dispense
 * line's medicine turns `substitution_not_allowed` into `unresolved_medicine` and blanks a brand on
 * a printed label — a wrong answer delivered quietly, which is strictly worse than a refusal a
 * caller can see. A list longer than `MAX_IDS` arriving here is a BUG in the caller, and a bug
 * should arrive as a refusal.
 *
 * The asymmetry is deliberate and it is about blame: readers serving REQUEST handlers refuse,
 * because the oversized list is a defect; a reader serving an IMPORTER would chunk internally,
 * because refusing on row 501 of a legitimate item master is hostile to an operator who did
 * nothing wrong.
 */
export const MAX_IDS = 500;

function requireBounded(ids: readonly string[], what: string): string[] {
  const wanted = [...new Set(ids)].filter((id) => id !== "");
  if (wanted.length > MAX_IDS) {
    throw new FormularyError(
      "too_many_ids",
      `${what}: asked for ${String(wanted.length)} ids at once, and ${String(MAX_IDS)} is the limit`,
      { asked: wanted.length, limit: MAX_IDS },
    );
  }
  return wanted;
}

/**
 * The named medicines, each with its composition, keyed by id. An unknown id is simply absent.
 *
 * ═══ IT DOES NOT FILTER `active`, AND THE ABSENCE IS THE DECISION ═══
 *
 * All five pharmacy callers this replaces called `listMedicines(db)` with no `activeOnly`, and they
 * were right to. A medicine DEACTIVATED after the prescription was written must still be nameable:
 * on the label the patient carries away, and inside the refusal that explains why it cannot be
 * substituted. Filtering here would blank that brand and change a precise refusal into a vague one.
 *
 * Where "active" is the actual question — may this be OFFERED, may this be SUBSTITUTED — it is
 * asked in SQL at the place that decides, which is `equivalence.ts`.
 */
export async function medicinesByIds(db: Db | Tx, ids: readonly string[]): Promise<Map<string, MedicineWithSalts>> {
  const wanted = requireBounded(ids, "medicinesByIds");
  const out = new Map<string, MedicineWithSalts>();
  if (wanted.length === 0) return out;

  const medicines = await db.select().from(formularyMedicines)
    .where(anyOfText(formularyMedicines.id, wanted));
  if (medicines.length === 0) return out;

  const composition = await db.select().from(formularyMedicineSalts)
    .where(anyOfText(formularyMedicineSalts.medicineId, medicines.map((m) => m.id)));

  const byMedicine = new Map<string, { saltId: string; strength: string | null }[]>();
  for (const row of composition) {
    const list = byMedicine.get(row.medicineId) ?? [];
    list.push({ saltId: row.saltId, strength: row.strength });
    byMedicine.set(row.medicineId, list);
  }
  for (const m of medicines) out.set(m.id, { ...m, salts: byMedicine.get(m.id) ?? [] });
  return out;
}

/** The named moieties, keyed by id. Same bound, same refusal, same reason. */
export async function saltsByIds(db: Db | Tx, ids: readonly string[]): Promise<Map<string, SaltRow>> {
  const wanted = requireBounded(ids, "saltsByIds");
  const out = new Map<string, SaltRow>();
  if (wanted.length === 0) return out;
  const rows = await db.select().from(formularySalts).where(anyOfText(formularySalts.id, wanted));
  for (const row of rows) out.set(row.id, row);
  return out;
}

/**
 * Does this medicine id name a row? One indexed probe, no row crossing the wire.
 *
 * It exists so `modules/materials` can validate `items.formulary_medicine_id` without importing
 * `kernel/db/schema/formulary` — the module boundary the formulary's own `index.ts` states, and
 * which a direct table read goes round.
 */
export async function medicineExists(db: Db | Tx, id: string): Promise<boolean> {
  if (id === "") return false;
  const rows = await db.select({ id: formularyMedicines.id }).from(formularyMedicines)
    .where(eq(formularyMedicines.id, id)).limit(1);
  return rows.length > 0;
}
