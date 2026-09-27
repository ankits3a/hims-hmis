import { withTx } from "../../kernel/db/client";
import { classifyNdpsSalts, medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { balances, isControlledStore, listItems, listStores, updateItem } from "../materials";
import { controlOf, LICENCES_PERMISSION } from "./controlled";
import { PharmacyError } from "./errors";
import { hasPermission } from "../../kernel/auth/permissions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { NdpsClassificationReport } from "../formulary";

/**
 * ═══ PHARMACY P6 — CLASSIFY, THEN KEEP IN THE CABINET (`classify-ndps`, a dry run first) ═══
 *
 *   1. The cited NDPS list onto the catalogue's moieties (`formulary/ndps.ts`), and the moieties that LOOK
 *      controlled but are not on it, for a pharmacist to rule on — never guessed.
 *   2. Every stock item of a controlled medicine (Schedule X, or an NDPS class) is stored as `narcotic`, so
 *      the ledger keeps it in the cabinet (`materials/controlled.ts` rule 2) and the counter picks it there.
 *   3. What controlled stock sits OUTSIDE the cabinet today, per store and batch: it has to be moved in
 *      under two keys (a transfer, received at the office's Controlled side). Nothing here moves stock.
 */
export type ControlledClassification = {
  salts: NdpsClassificationReport;
  items: { itemId: string; code: string; name: string; was: string; scheduleX: boolean; ndpsClass: string | null }[];
  outsideCabinet: { storeCode: string; itemCode: string; itemName: string; batchId: string; qtyOnHand: number }[];
  applied: boolean;
};

export async function classifyControlledDrugs(db: Db, actor: Actor, opts: { apply: boolean }): Promise<ControlledClassification> {
  if (actor.type !== "user" || !(await hasPermission(db, actor.id, LICENCES_PERMISSION, "hospital"))) {
    throw new PharmacyError("permission_denied", `classifying the controlled drugs needs ${LICENCES_PERMISSION}`);
  }
  // Written only on --apply; a dry run reads and reports.
  const salts = await withTx(db, async (tx) => classifyNdpsSalts(tx, actor, { apply: opts.apply }));
  const drugs = (await listItems(db, { class: "drug", active: true })).filter((i) => i.formularyMedicineId !== null);
  const items: ControlledClassification["items"] = [];
  const controlledItemIds = new Set<string>();
  for (let i = 0; i < drugs.length; i += 400) {
    const chunk = drugs.slice(i, i + 400);
    const ids = chunk.map((d) => d.formularyMedicineId as string);
    const [meds, ndps] = await Promise.all([medicinesByIds(db, ids), ndpsClassByMedicine(db, ids)]);
    for (const d of chunk) {
      const id = d.formularyMedicineId as string;
      // On a dry run the salts are not yet written, so the class the list WOULD give is read off the report.
      const listed = salts.classified.find((c) => (meds.get(id)?.salts ?? []).some((s) => s.saltId === c.saltId))?.ndpsClass ?? null;
      const c = controlOf(meds.get(id)?.scheduleFlag ?? null, ndps.get(id) ?? listed);
      if (!c.controlled) continue;
      controlledItemIds.add(d.id);
      if (d.storageClass !== "narcotic") items.push({ itemId: d.id, code: d.code, name: d.name, was: d.storageClass, scheduleX: c.scheduleX, ndpsClass: c.ndpsClass });
    }
  }
  if (opts.apply) {
    await withTx(db, async (tx) => {
      for (const it of items) await updateItem(tx, actor, it.itemId, { storageClass: "narcotic" });
    });
  }
  const stores = await listStores(db);
  const outsideCabinet: ControlledClassification["outsideCabinet"] = [];
  const itemById = new Map(drugs.map((d) => [d.id, d]));
  for (const store of stores.filter((s) => !isControlledStore(s))) {
    for (const b of await balances(db, { resourceId: store.id })) {
      if (b.qtyOnHand <= 0 || !controlledItemIds.has(b.itemId)) continue;
      const it = itemById.get(b.itemId)!;
      outsideCabinet.push({ storeCode: store.code, itemCode: it.code, itemName: it.name, batchId: b.batchId, qtyOnHand: b.qtyOnHand });
    }
  }
  return { salts, items, outsideCabinet, applied: opts.apply };
}
