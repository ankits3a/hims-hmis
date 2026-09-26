import { inArray } from "drizzle-orm";
import { opdPrescriptions } from "../../kernel/db/schema";
import { medicinesByIds, ndpsClassByMedicine, resolveDrugTexts } from "../formulary";
import { availableQtyByItem, findStoreByCode } from "../materials";
import { OPD_PHARMACY_STORE_CODE } from "./config";
import { controlOf, controlledLicenceStates, controlledStore } from "./controlled";
import { prefillQtyBase } from "./qty";
import { shelfByMedicine } from "./shelf";
import { matchesFor, shelfIndex, targetOf } from "./auto-match";
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
  /*
    2026-09-23 — a line the doctor named no brand on is what the claim will fill with the stocked brand
    of its composition (`auto-match.ts`), so the waiting row counts it the same way: the shelf's
    matches for it, read once for the page and only when some waiting line needs them.
  */
  const allLines = rx.flatMap((r) => r.lines as RxLine[]);
  const needsMatch = (l: RxLine): boolean => {
    const id = medicineOf(l);
    return id === null || (medicines.get(id)?.code != null && !shelf.has(id));
  };
  const ix = allLines.some(needsMatch) ? await shelfIndex(db) : null;
  const matchesOf = new Map<RxLine, string[]>();
  if (ix !== null) {
    for (const l of allLines.filter(needsMatch)) {
      const target = targetOf(l, l.medicineId ? medicines.get(l.medicineId) : undefined, l.medicineId ? undefined : medicines.get(medicineOf(l) ?? ""));
      matchesOf.set(l, target === null ? [] : matchesFor(ix, target).map((c) => c.itemId));
    }
  }
  const itemIds = [
    ...medicineIds.map((m) => shelf.get(m)?.item.id).filter((i): i is string => i !== undefined),
    ...[...matchesOf.values()].flat(),
  ];
  const available = store === undefined || itemIds.length === 0 ? new Map<string, number>() : await availableQtyByItem(db, store.id, [...new Set(itemIds)], now);
  /*
    PHARMACY P6 — a controlled medicine (Schedule X, or an NDPS class) is judged as the claim will judge it:
    refused while the licence it needs is not current (the `scheduleX` mark, "not dispensed here"), and
    otherwise counted against the CABINET's stock, where it is kept and picked.
  */
  const ndps = await ndpsClassByMedicine(db, medicineIds);
  const controlledIds = medicineIds.filter((m) => controlOf(medicines.get(m)?.scheduleFlag, ndps.get(m)).controlled);
  const licences = controlledIds.length === 0 ? null : await controlledLicenceStates(db, now);
  const cabinet = controlledIds.length === 0 ? undefined : await controlledStore(db);
  const cabinetItems = controlledIds.map((m) => shelf.get(m)?.item.id).filter((i): i is string => i !== undefined);
  const inCabinet = cabinet === undefined || cabinetItems.length === 0 ? new Map<string, number>() : await availableQtyByItem(db, cabinet.id, cabinetItems, now);
  const refusedByLaw = (medicineId: string): boolean => {
    const c = controlOf(medicines.get(medicineId)?.scheduleFlag, ndps.get(medicineId));
    if (!c.controlled || licences === null) return false;
    return (c.scheduleX && licences.schedule_x.state !== "current") || (c.ndpsClass === "narcotic" && licences.ndps_rmi.state !== "current");
  };

  for (const t of tickets) {
    const lines = linesByRx.get(t.prescriptionId) ?? [];
    const check: ShelfCheck = { lines: lines.length, onShelf: 0, short: [], notStocked: [], unplaceable: 0, scheduleX: false };
    for (const l of lines) {
      const matched = matchesOf.get(l) ?? [];
      if (matched.length > 0) {
        const want = prefillQtyBase(l) ?? 1;
        if (matched.some((itemId) => (available.get(itemId) ?? 0) >= want)) check.onShelf += 1;
        else check.short.push(l.drug);
        continue;
      }
      const medicineId = medicineOf(l);
      if (medicineId === null) { check.unplaceable += 1; continue; }
      if (refusedByLaw(medicineId)) { check.scheduleX = true; continue; }
      const entry = shelf.get(medicineId);
      if (entry === undefined) { check.notStocked.push(l.drug); continue; }
      const want = prefillQtyBase(l) ?? 1;
      const onHand = controlledIds.includes(medicineId) ? inCabinet : available;
      if ((onHand.get(entry.item.id) ?? 0) < want) check.short.push(l.drug);
      else check.onShelf += 1;
    }
    out.set(t.dispenseId, check);
  }
  return out;
}
