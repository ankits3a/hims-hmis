import { balances, batchesByNo, itemsByIds, resolveBarcode } from "../materials";
import { PharmacyError } from "./errors";
import { parseGs1 } from "./gs1";
import { getDispenseRow, linesOf } from "./queue";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P13 — WHAT A PACK SCAN SAYS ABOUT A LINE ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p13-scan-to-pick.md`. The item
 * master's barcodes (`item_barcodes`, registered at `/materials/items`) say which item a code is on.
 * The scan is checked in this order, and each refusal says what to do:
 *   - an unregistered code → `scan_unknown` (register the pack's barcode, or pick without scanning);
 *   - another item's pack → `scan_wrong_item` (the wrong drug in the hand);
 *   - a GS1 batch this counter does not hold → `scan_batch_unknown`;
 *   - a GS1 expiry that disagrees with the batch on the books → `scan_batch_mismatch` (a mis-keyed
 *     GRN, or a different pack with the same number; the books must be checked before it goes out).
 * A GS1 GTIN is looked up as printed and as the EAN-13 inside it. The pick uses the same resolution,
 * so a check at scan time and the pick can never disagree.
 */
export type ScanMatch = { itemCode: string; batchNo: string | null; expiryDate: string | null; batchId: string | null };

export async function resolveScan(db: Db, storeResourceId: string, lineIdx: number, itemId: string, raw: string): Promise<ScanMatch> {
  const code = raw.trim();
  const gs1 = parseGs1(code);
  const candidates = gs1 === null ? [code] : [gs1.gtin, gs1.gtin.replace(/^0/, ""), code];
  let found: { itemId: string } | undefined;
  for (const c of candidates) {
    found = await resolveBarcode(db, c);
    if (found !== undefined) break;
  }
  const n = String(lineIdx + 1);
  if (found === undefined) {
    throw new PharmacyError("scan_unknown", `line ${n}: no item carries the code ${code} — register the pack's barcode on the item, or pick without scanning`, { lineIdx });
  }
  if (found.itemId !== itemId) {
    const other = (await itemsByIds(db, [found.itemId])).get(found.itemId);
    throw new PharmacyError("scan_wrong_item", `line ${n}: this pack is ${other?.name ?? found.itemId}, not the line's medicine — put it back`, { lineIdx, scannedItemId: found.itemId });
  }
  const item = (await itemsByIds(db, [itemId])).get(itemId);
  if (gs1 === null || gs1.batch === null) return { itemCode: item?.code ?? "", batchNo: null, expiryDate: null, batchId: null };

  const held = new Set((await balances(db, { resourceId: storeResourceId })).filter((b) => b.qtyOnHand > 0).map((b) => b.batchId));
  const batch = (await batchesByNo(db, itemId, gs1.batch)).find((b) => held.has(b.id));
  if (batch === undefined) {
    throw new PharmacyError("scan_batch_unknown", `line ${n}: the counter holds no batch ${gs1.batch} of this medicine — check the GRN`, { lineIdx, batchNo: gs1.batch });
  }
  if (gs1.expiry !== null && batch.expiryDate !== gs1.expiry) {
    throw new PharmacyError("scan_batch_mismatch", `line ${n}: the pack says batch ${batch.batchNo} expires ${gs1.expiry}, the books say ${batch.expiryDate ?? "no expiry"} — check the GRN before this goes out`, { lineIdx, printed: gs1.expiry, booked: batch.expiryDate });
  }
  return { itemCode: item?.code ?? "", batchNo: batch.batchNo, expiryDate: batch.expiryDate, batchId: batch.id };
}

/** The counter's check as the pack is scanned: nothing is reserved. */
export async function checkPickScan(
  db: Db, dispenseId: string, lineIdx: number, code: string,
): Promise<{ itemCode: string; batchNo: string | null; expiryDate: string | null }> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "verified") throw new PharmacyError("dispense_not_in_state", `dispense ${d.id} is ${d.status}, not verified`, { status: d.status });
  const line = (await linesOf(db, dispenseId)).find((l) => l.lineIdx === lineIdx);
  if (line === undefined || line.status !== "open" || line.itemId === null || d.storeResourceId === null) {
    throw new PharmacyError("unknown_line", `line ${String(lineIdx + 1)} is not open for picking`, { lineIdx });
  }
  const m = await resolveScan(db, d.storeResourceId, lineIdx, line.itemId, code);
  return { itemCode: m.itemCode, batchNo: m.batchNo, expiryDate: m.expiryDate };
}
