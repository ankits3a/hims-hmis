import { eq } from "drizzle-orm";
import { items, storesAssetUnits } from "../../kernel/db/schema";
import { HOSPITAL, esc } from "../../kernel/printing/document-kit";
import { qrSvg } from "../../kernel/printing/qr";
import { lastTag, unitState } from "./assets";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S4a (#1114, decision 3) — THE UNIT LABEL: the QR carries the tag number and nothing else; the last four digits
 * are printed large for the typed fallback; the item's name and the hospital's. One label per unit (queued by
 * `tagUnits`, `retag`, `openUnit`), 50 × 25 mm, on the store's printer.
 */
const CSS = `
  @page { size: 50mm 25mm; margin: 1.5mm; }
  body { font-family: "Noto Sans", Arial, sans-serif; margin: 0; color: #111; }
  .l { display: flex; gap: 2mm; align-items: center; height: 22mm; }
  .no { font-size: 8px; font-weight: 700; } .last4 { font-size: 22px; font-weight: 800; letter-spacing: 1px; line-height: 1; }
  .nm { font-size: 8px; max-width: 28mm; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; } .h { font-size: 7px; color: #333; }
`;

export async function renderAssetLabel(db: Db, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  const unitId = typeof params.unitId === "string" ? params.unitId : null;
  if (unitId === null) return null;
  const [u] = await db.select({ itemId: storesAssetUnits.itemId }).from(storesAssetUnits).where(eq(storesAssetUnits.id, unitId));
  if (u === undefined) return null;
  const s = await unitState(db, unitId);
  const tag = lastTag(s);
  const [item] = await db.select({ name: items.name }).from(items).where(eq(items.id, u.itemId));
  const body = `<div class="l">${qrSvg(tag, 76)}<div><div class="last4">${esc(tag.slice(-4))}</div><div class="no">${esc(tag)}</div>`
    + `<div class="nm">${esc(item?.name ?? "")}</div><div class="h">${HOSPITAL.nameTitleCase}</div></div></div>`;
  return {
    title: `Asset label ${tag}`,
    page: { widthMm: 50, heightMm: 25 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Asset label</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}
