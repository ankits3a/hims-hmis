import { getInvoice } from "../billing";
import { itemUomRows, itemsByIds } from "../materials";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ONE ROW PER DRUG, WHEREVER A PERSON READS THE BILL (loose-MRP ruling, 2026-09-22) ═══
 *
 * A quantity whose full pack does not divide is STORED as two invoice lines — the main line (every
 * unit at the loose rate) and its pack residue right after it (`bill.ts` `invoiceInputsOf`) —
 * because the tariff engine prices `unit × qty`. Shown as stored, 20 tablets of ₹35.50/15 read as
 * "Dolo 650 × 20 ₹47.20" and "Dolo 650 × 1 ₹0.10": twenty-one tablets to anyone at the counter.
 *
 * So every human-facing rendering is given the MERGED view from here: one row per drug, the stored
 * money summed (never re-priced), the quantity as packs + loose units where the item has a pack.
 * The stored lines — and every GST figure summed from them — are untouched, so the invoice's
 * taxable value and heads still reconcile to the lines exactly.
 */

/** "1 strip + 5 tablets": the smallest pack above one unit, and the price one full pack was charged. */
export type BillRowPack = {
  uom: string; multiplier: number; packs: number; loose: number; baseUom: string;
  /** What each full pack cost on this row (the printed MRP, or the ceiling's), or null when it is not a whole number of paise. */
  packPaise: number | null;
};

export type BillRow = {
  /** The stored invoice lines (or draft lines) this row stands for: the main line, then its residue if any. */
  lineIds: string[];
  serviceName: string;
  qty: number;
  pack: BillRowPack | null;
  /** The loose-unit rate (the main line's). */
  unitPaise: number;
  grossPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  sacCode: string | null; rateBps: number | null; exempt: boolean | null;
};

export type RowLine = {
  id: string; serviceName: string; qty: number; unitPaise: number;
  grossPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  sacCode?: string | null; rateBps?: number | null; exempt?: boolean | null;
};

/** A drug's main line, its residue (if any), and the pack the quantity is read in. */
export type RowGroup = { mainId: string; residueId: string | null; pack: { uom: string; multiplier: number; baseUom: string } | null };

/**
 * PURE. The rows in line order; a residue line never appears as its own row. A line no group names
 * stands alone (a pharmacy invoice has none, but a bill must never lose a line).
 */
export function mergeBillRows(lines: readonly RowLine[], groups: readonly RowGroup[]): BillRow[] {
  const byMain = new Map(groups.map((g) => [g.mainId, g]));
  const residues = new Set(groups.map((g) => g.residueId).filter((x): x is string => x !== null));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const rows: BillRow[] = [];
  for (const l of lines) {
    if (residues.has(l.id)) continue;
    const g = byMain.get(l.id);
    const r = g?.residueId == null ? undefined : byId.get(g.residueId);
    const parts = r === undefined ? [l] : [l, r];
    const sum = (f: (x: RowLine) => number): number => parts.reduce((n, x) => n + f(x), 0);
    const grossPaise = sum((x) => x.grossPaise);
    let pack: BillRowPack | null = null;
    if (g?.pack != null && g.pack.multiplier > 1) {
      const packs = Math.floor(l.qty / g.pack.multiplier);
      const loose = l.qty - packs * g.pack.multiplier;
      const perPack = packs === 0 ? null : (grossPaise - loose * l.unitPaise) / packs;
      pack = {
        uom: g.pack.uom, multiplier: g.pack.multiplier, packs, loose, baseUom: g.pack.baseUom,
        packPaise: perPack !== null && Number.isSafeInteger(perPack) ? perPack : null,
      };
    }
    rows.push({
      lineIds: parts.map((x) => x.id), serviceName: l.serviceName, qty: l.qty, pack, unitPaise: l.unitPaise,
      grossPaise, discountPaise: sum((x) => x.discountPaise), cgstPaise: sum((x) => x.cgstPaise),
      sgstPaise: sum((x) => x.sgstPaise), netPaise: sum((x) => x.netPaise),
      sacCode: l.sacCode ?? null, rateBps: l.rateBps ?? null, exempt: l.exempt ?? null,
    });
  }
  return rows;
}

/**
 * The residue line of each owned main line on a STORED invoice: the line immediately after it that
 * no sale line owns and that bills the same service (`invoiceInputsOf` put it there; the invoice
 * is immutable). Keyed by the main line's id.
 */
export function residueLinesOf<L extends { id: string; serviceId: string; lineNo: number }>(
  lines: readonly L[], owned: ReadonlySet<string>,
): Map<string, L> {
  const byNo = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  const out = new Map<string, L>();
  for (const [i, row] of byNo.entries()) {
    const next = byNo[i + 1];
    if (owned.has(row.id) && next !== undefined && !owned.has(next.id) && next.serviceId === row.serviceId) out.set(row.id, next);
  }
  return out;
}

/** The smallest pack above one unit per item — the pack that crosses the counter (quote, returns). */
export async function counterPacks(db: Db, itemIds: readonly string[]): Promise<Map<string, RowGroup["pack"]>> {
  const unique = [...new Set(itemIds)];
  const items = await itemsByIds(db, unique);
  const out = new Map<string, RowGroup["pack"]>();
  for (const id of unique) {
    const pack = (await itemUomRows(db, id)).filter((u) => u.toBaseMultiplier > 1).sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier)[0];
    out.set(id, pack === undefined ? null : { uom: pack.uom, multiplier: pack.toBaseMultiplier, baseUom: items.get(id)?.baseUom ?? "unit" });
  }
  return out;
}

/** The merged rows of an ISSUED pharmacy invoice, from the sale lines that own its main lines. */
export async function billRowsForInvoice(
  db: Db, invoiceId: string, saleLines: readonly { invoiceLineId: string | null; itemId: string | null }[],
): Promise<BillRow[] | null> {
  const invoice = await getInvoice(db, invoiceId);
  if (invoice === null) return null;
  const owned = saleLines.filter((l): l is { invoiceLineId: string; itemId: string | null } => l.invoiceLineId !== null);
  const residue = residueLinesOf(invoice.lines, new Set(owned.map((l) => l.invoiceLineId)));
  const packs = await counterPacks(db, owned.map((l) => l.itemId).filter((x): x is string => x !== null));
  const groups: RowGroup[] = owned.map((l) => ({
    mainId: l.invoiceLineId, residueId: residue.get(l.invoiceLineId)?.id ?? null,
    pack: l.itemId === null ? null : packs.get(l.itemId) ?? null,
  }));
  const lines = [...invoice.lines].sort((a, b) => a.lineNo - b.lineNo);
  return mergeBillRows(lines.map((l) => ({
    id: l.id, serviceName: l.serviceName, qty: l.qty, unitPaise: l.unitPaise, grossPaise: l.grossPaise,
    discountPaise: l.discountPaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, netPaise: l.netPaise,
    sacCode: l.sacCode, rateBps: l.rateBps, exempt: l.exempt,
  })), groups);
}
