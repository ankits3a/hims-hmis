import { listMedicines } from "../formulary";
import { fromBase, getBatch, itemUomRows, itemsByIds } from "../materials";
import { getPatientSummaries } from "../patients";
import { PharmacyError } from "./errors";
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
};

/** Everything the counter prints per pack — read after the pick, so a batch and its expiry exist. Alias-safe. */
export async function labelFor(db: Db, actor: Actor, dispenseId: string): Promise<LabelData> {
  const d = await getDispenseRow(db, dispenseId);
  const [summary] = await getPatientSummaries(db, actor, [d.patientId]);
  if (summary === undefined) throw new PharmacyError("unknown_dispense", `dispense ${dispenseId} not found`);
  const lines = (await linesOf(db, dispenseId)).filter((l) => l.status === "open");
  const medicines = new Map((await listMedicines(db)).map((m) => [m.id, m]));
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
      directions: [rx.dose, rx.frequency, rx.durationDays === null ? null : `${String(rx.durationDays)} days`, rx.instructions].filter((x): x is string => x !== null && x !== "").join(" · "),
      substitutedFor: l.substitutionType === "generic" && ordered !== undefined ? ordered.brandName : null,
    });
  }
  return {
    dispenseNo: d.dispenseNo, status: d.status,
    patient: { display: summary.alias ?? summary.name ?? summary.uhid, uhid: summary.uhid },
    handedOverAt: d.handedOverAt, lines: out,
  };
}
