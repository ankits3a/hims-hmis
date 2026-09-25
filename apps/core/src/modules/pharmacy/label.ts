import { medicinesByIds } from "../formulary";
import { fromBase, getBatch, itemUomRows, itemsByIds } from "../materials";
import { EYE_TEXT } from "../opd";
import { getPatientSummaries } from "../patients";
import { billRowsForInvoice } from "./bill-rows";
import { PharmacyError } from "./errors";
import type { BillRow } from "./bill-rows";
import { personName, registrationAt } from "./pharmacists";
import { getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "../opd";

export type LabelLine = {
  lineIdx: number;
  drug: string;
  strength: string | null;
  form: string | null;
  qtyBase: number;
  unit: string;
  /** "2 strip" when the item has a pack unit the quantity divides into; otherwise null. */
  packs: string | null;
  batchNo: string;
  expiryDate: string | null;
  directions: string;
  /** D6 — printed on the label: the brand the doctor wrote, when a generic was substituted. */
  substitutedFor: string | null;
};

export type LabelData = {
  dispenseNo: string | null;
  status: string;
  patient: { display: string; uhid: string };
  handedOverAt: Date | null;
  lines: LabelLine[];
  /**
   * P2 — "Dispensed by": the pharmacist who verified the dispense, and the council registration that
   * was current when they did. Null before the verify.
   */
  pharmacist: { name: string; council: string | null; registrationNo: string | null } | null;
  /**
   * The bill as a person reads it once issued — one row per drug, a pack residue folded into its
   * drug (loose-MRP ruling, `bill-rows.ts`). Null before the bill.
   */
  billRows: BillRow[] | null;
};

/**
 * The directions line the patient reads at home: dose · eye · frequency · days · instructions,
 * only the parts present. The eye rides right after the dose ("1 drop · RIGHT EYE · …") because
 * WHICH eye is the part of an eye line that must never be missed.
 */
export function labelDirections(rx: RxLine): string {
  const eye = rx.eye === undefined || rx.eye === null ? null : EYE_TEXT[rx.eye];
  return [rx.dose, eye, rx.frequency, rx.durationDays === null ? null : `${String(rx.durationDays)} days`, rx.instructions]
    .filter((x): x is string => x !== null && x !== "").join(" · ");
}

/** Everything the counter prints per pack — read after the pick, so a batch and its expiry exist. Alias-safe. */
export async function labelFor(db: Db, actor: Actor, dispenseId: string): Promise<LabelData> {
  const d = await getDispenseRow(db, dispenseId);
  const [summary] = await getPatientSummaries(db, actor, [d.patientId]);
  if (summary === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const lines = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  const medicines = await medicinesByIds(db, lines.flatMap((l) => [l.dispensedMedicineId, l.orderedMedicineId]).filter((x): x is string => x !== null));
  const items = await itemsByIds(db, lines.map((l) => l.itemId).filter((x): x is string => x !== null));
  const out: LabelLine[] = [];
  for (const l of lines) {
    const rx = l.rxLine as RxLine;
    const med = l.dispensedMedicineId === null ? undefined : medicines.get(l.dispensedMedicineId);
    const ordered = l.orderedMedicineId === null ? undefined : medicines.get(l.orderedMedicineId);
    const item = l.itemId === null ? undefined : items.get(l.itemId);
    const batch = l.batchId === null ? undefined : await getBatch(db, l.batchId);
    let packs: string | null = null;
    if (item !== undefined && l.qtyBase !== null) {
      const uoms = await itemUomRows(db, item.id);
      const pack = uoms.filter((u) => u.toBaseMultiplier > 1).sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier)[0];
      if (pack !== undefined && l.qtyBase % pack.toBaseMultiplier === 0) packs = `${String(fromBase(uoms, pack.uom, l.qtyBase).whole)} ${pack.uom}`;
    }
    out.push({
      lineIdx: l.lineIdx,
      drug: med?.brandName ?? rx.drug, strength: med?.strengthLabel ?? null, form: med?.form ?? null,
      qtyBase: l.qtyBase ?? 0, unit: item?.baseUom ?? "unit", packs,
      batchNo: batch?.batchNo ?? "", expiryDate: batch?.expiryDate ?? null,
      directions: labelDirections(rx),
      substitutedFor: l.substitutionType === "generic" && ordered !== undefined ? ordered.brandName : null,
    });
  }
  let pharmacist: LabelData["pharmacist"] = null;
  if (d.verifiedBy !== null && d.verifiedAt !== null) {
    const reg = await registrationAt(db, d.verifiedBy, d.verifiedAt);
    pharmacist = {
      name: (await personName(db, d.verifiedBy)) ?? d.verifiedBy,
      council: reg?.council ?? null, registrationNo: reg?.registrationNo ?? null,
    };
  }
  return {
    dispenseNo: d.dispenseNo, status: d.status,
    patient: { display: summary.alias ?? summary.name ?? summary.uhid, uhid: summary.uhid },
    handedOverAt: d.handedOverAt, lines: out, pharmacist,
    billRows: d.invoiceId === null ? null : await billRowsForInvoice(db, d.invoiceId, lines),
  };
}
