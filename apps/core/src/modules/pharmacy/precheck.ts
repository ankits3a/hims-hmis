import { inArray } from "drizzle-orm";
import { opdPrescriptions } from "../../kernel/db/schema";
import { medicinesByIds, resolveDrugTexts } from "../formulary";
import { availableQtyByItem, findStoreByCode } from "../materials";
import { OPD_PHARMACY_STORE_CODE, REFUSED_FLAGS } from "./config";
import { prefillQtyBase } from "./qty";
import { shelfByMedicine } from "./shelf";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "../opd";

/**
 * ═══ PHASE PD, PD-7 / C1 — THE LINE YOU HAVE NOT REACHED, ALREADY CHECKED AGAINST THE SHELF ═══
 *
 * The counter's copilot use case of highest value (phase doc §3): every WAITING ticket's lines read
 * against this shelf, so the row says "all on shelf" or "Azee 500 short" before anybody claims it.
 * It turns discovery-at-the-window into planning. Rung DID — it states, it changes nothing.
 *
 * A waiting ticket has no dispense lines yet (the claim lays them), so this resolves the
 * PRESCRIPTION the way `claimDispense` does — the medicine the doctor picked, else the typed text
 * through `resolveDrugTexts` — without writing anything. It asks only about the SHELF
 * (`shelfByMedicine`, the `alternativesFor` rule: what the counter can offer was never more than
 * what it stocks), and availability is `availableQtyByItem`, the predicate `fefoPick` obeys. It is
 * read on a POLLED list, so it is one query per concern for the whole page, never one per row.
 *
 * What it does not claim: the four clinical books are not run here — they run at the check, on the
 * medicine actually dispensed. This answers "can the shelf fill it", nothing else.
 */
export type ShelfCheck = {
  lines: number;
  /** Resolved, stocked here, and enough on the shelf for the quantity the sig works out to. */
  onShelf: number;
  /** Stocked here but short — named as the doctor wrote them. */
  short: string[];
  /** Resolved to a medicine this counter does not sell. */
  notStocked: string[];
  /** Text the catalogue cannot place (PD-D4's amber rows). */
  unplaceable: number;
  /** A Schedule X line: the claim itself will refuse this ticket (E17). */
  scheduleX: boolean;
};

export async function shelfChecks(
  db: Db, tickets: readonly { dispenseId: string; prescriptionId: string }[], now: Date,
): Promise<Map<string, ShelfCheck>> {
  const out = new Map<string, ShelfCheck>();
  if (tickets.length === 0) return out;
  const rx = await db.select({ id: opdPrescriptions.id, lines: opdPrescriptions.lines })
    .from(opdPrescriptions).where(inArray(opdPrescriptions.id, [...new Set(tickets.map((t) => t.prescriptionId))]));
  const linesByRx = new Map(rx.map((r) => [r.id, r.lines as RxLine[]]));

  const texts = [...new Set(rx.flatMap((r) => (r.lines as RxLine[]).filter((l) => !l.medicineId).map((l) => l.drug)))];
  const resolved = texts.length === 0 ? new Map<string, { medicineId: string | null } | null>() : await resolveDrugTexts(db, texts);
  const medicineOf = (l: RxLine): string | null => l.medicineId ?? resolved.get(l.drug)?.medicineId ?? null;
  const medicineIds = [...new Set(rx.flatMap((r) => (r.lines as RxLine[]).map(medicineOf)).filter((m): m is string => m !== null))];
  const medicines = await medicinesByIds(db, medicineIds);
  const shelf = await shelfByMedicine(db);
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  const itemIds = medicineIds.map((m) => shelf.get(m)?.item.id).filter((i): i is string => i !== undefined);
  const available = store === undefined || itemIds.length === 0 ? new Map<string, number>() : await availableQtyByItem(db, store.id, itemIds, now);

  for (const t of tickets) {
    const lines = linesByRx.get(t.prescriptionId) ?? [];
    const check: ShelfCheck = { lines: lines.length, onShelf: 0, short: [], notStocked: [], unplaceable: 0, scheduleX: false };
    for (const l of lines) {
      const medicineId = medicineOf(l);
      if (medicineId === null) { check.unplaceable += 1; continue; }
      const flag = medicines.get(medicineId)?.scheduleFlag ?? null;
      if (flag !== null && (REFUSED_FLAGS as readonly string[]).includes(flag)) { check.scheduleX = true; continue; }
      const entry = shelf.get(medicineId);
      if (entry === undefined) { check.notStocked.push(l.drug); continue; }
      const want = prefillQtyBase(l) ?? 1;
      if ((available.get(entry.item.id) ?? 0) < want) check.short.push(l.drug);
      else check.onShelf += 1;
    }
    out.set(t.dispenseId, check);
  }
  return out;
}
