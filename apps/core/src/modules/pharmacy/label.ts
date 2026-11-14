import { packWordOf, strengthShown } from "@hmis/contracts";
import { medicinesByIds } from "../formulary";
import { fromBase, getBatch, itemUomRows, itemsByIds } from "../materials";
import { EYE_TEXT } from "../opd";
import { getPatientSummaries } from "../patients";
import { billRowsForInvoice } from "./bill-rows";
import { PharmacyError } from "./errors";
import type { BillRow } from "./bill-rows";
import { personName, registrationAt } from "./pharmacists";
import { addedMarkOf, balanceOnPaper, getDispenseRow, linesOf, userNames } from "./queue";
import { licenceOnBill } from "./retail";
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
  /** Spec #1046 D5 — the maker on the pack (`items.manufacturer`), printed per line on the bill; null when none. */
  manufacturer: string | null;
  /** The invoice line this dispense line was billed as (null before the bill): how the bill finds its batch. */
  invoiceLineId: string | null;
  /** Spec #1055 — a medicine added at the counter by hand: the bill says "added at the counter by <name>" and why. */
  added: { reason: "not_prescribed" | "paper"; byName: string } | null;
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
  /** Spec #1046 D5 — the drug licence numbers the bill's header prints (the register's current Form 20/21), null when none. */
  licence: { form20No: string; form21No: string } | null;
  /**
   * Spec #1046 D6, walk 2026-11-13 — what this ticket still owes and until when (`queue.ts` `balanceOnPaper`): the bill
   * and the short line's label say it. Null when nothing is owed.
   */
  balance: { lines: { lineIdx: number; drug: string; qtyBase: number; unit: string }[]; until: Date } | null;
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
export async function labelFor(db: Db, actor: Actor, dispenseId: string, now: Date = new Date()): Promise<LabelData> {
  const d = await getDispenseRow(db, dispenseId);
  const [summary] = await getPatientSummaries(db, actor, [d.patientId]);
  if (summary === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const all = await linesOf(db, dispenseId);
  const lines = all.filter((l) => l.status === "open");
  const medicines = await medicinesByIds(db, lines.flatMap((l) => [l.dispensedMedicineId, l.orderedMedicineId]).filter((x): x is string => x !== null));
  const items = await itemsByIds(db, lines.map((l) => l.itemId).filter((x): x is string => x !== null));
  const adders = await userNames(db, lines.map((l) => l.addedBy));
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
      if (pack !== undefined && l.qtyBase % pack.toBaseMultiplier === 0) packs = `${String(fromBase(uoms, pack.uom, l.qtyBase).whole)} ${packWordOf(pack.uom)}`;
    }
    out.push({
      lineIdx: l.lineIdx,
      drug: med?.brandName ?? rx.drug, strength: strengthShown(med?.strengthLabel), form: med?.form ?? null,
      qtyBase: l.qtyBase ?? 0, unit: item?.baseUom ?? "unit", packs,
      batchNo: batch?.batchNo ?? "", expiryDate: batch?.expiryDate ?? null,
      directions: labelDirections(rx),
      substitutedFor: l.substitutionType === "generic" && ordered !== undefined ? ordered.brandName : null,
      manufacturer: item?.manufacturer ?? null, invoiceLineId: l.invoiceLineId,
      added: addedOnPaper(addedMarkOf(l, adders)),
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
  const owed = await balanceOnPaper(db, d, all, now);
  return {
    dispenseNo: d.dispenseNo, status: d.status,
    patient: { display: summary.alias ?? summary.name ?? summary.uhid, uhid: summary.uhid },
    handedOverAt: d.handedOverAt, lines: out, pharmacist,
    billRows: d.invoiceId === null ? null : await billRowsForInvoice(db, d.invoiceId, lines),
    licence: await licenceOnBill(db, d.billedAt ?? new Date()),
    balance: owed === null ? null : {
      until: owed.until,
      lines: owed.lines.map((l) => {
        const med = l.dispensedMedicineId === null ? undefined : medicines.get(l.dispensedMedicineId);
        return { lineIdx: l.lineIdx, drug: med?.brandName ?? (l.rxLine as RxLine).drug, qtyBase: l.owedQtyBase ?? 0, unit: (l.itemId === null ? undefined : items.get(l.itemId))?.baseUom ?? "unit" };
      }),
    },
  };
}

function addedOnPaper(mark: ReturnType<typeof addedMarkOf>): LabelLine["added"] {
  return mark === null ? null : { reason: mark.reason, byName: mark.byName ?? mark.by };
}

/** Spec #1055 — the words a bill prints beside a medicine the counter added by hand. One sentence for the server's paper. */
export function addedText(added: NonNullable<LabelLine["added"]>): string {
  return `added at the counter by ${added.byName} · ${added.reason === "paper" ? "the doctor wrote it on paper" : "not prescribed"}`;
}
