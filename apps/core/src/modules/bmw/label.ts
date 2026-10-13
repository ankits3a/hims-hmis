import { eq } from "drizzle-orm";
import { bmwBags, resources } from "../../kernel/db/schema";
import { HOSPITAL, esc } from "../../kernel/printing/document-kit";
import { qrSvg } from "../../kernel/printing/qr";
import type { BmwCategory } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/document-kit";

/**
 * ═══ THE BAG LABEL — 75 × 50 mm, ONE PER BAG ═══
 *
 * BMW Rules 2016 Schedule IV and the 2018 amendment's bar-code requirement: the biohazard (or sharps)
 * mark, the colour category, the occupier, the place and the date and time of generation, the weight,
 * and the bag's bar code. The code is printed twice — as a QR any phone or handheld reads, and as text
 * under it for a hand-typed fallback. DECIDED: QR rather than a 1-D Code 128, because the kernel draws QR
 * already (`kernel/printing/qr.ts`) and CPCB's bar-code guidance accepts either.
 *
 * The weight line is drawn from the bag row at print time: a label printed before weighing shows a blank
 * line the handler writes on; a reprint after weighing shows the weight.
 */
export const BAG_LABEL_DOCUMENT = "bmw_bag_label" as const;

const CATEGORY_WORDS: Record<BmwCategory, { en: string; hi: string; mark: string }> = {
  yellow: { en: "YELLOW", hi: "पीला", mark: "BIOHAZARD" },
  red: { en: "RED", hi: "लाल", mark: "BIOHAZARD" },
  white_translucent: { en: "WHITE · SHARPS", hi: "सफ़ेद · नुकीला", mark: "SHARPS" },
  blue: { en: "BLUE · GLASS", hi: "नीला · कांच", mark: "GLASSWARE" },
};

const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

const LABEL_CSS = `
  @page { size: 75mm 50mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "DejaVu Sans", "Noto Sans Devanagari", Arial, sans-serif; color: #000; }
  .lab { width: 75mm; height: 50mm; padding: 2mm; display: grid; grid-template-columns: 26mm 1fr; gap: 2mm; overflow: hidden; }
  .qr { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6mm; }
  .qr svg { width: 25mm; height: 25mm; display: block; }
  .code { font-family: "DejaVu Sans Mono", monospace; font-size: 6.5pt; font-weight: 700; word-break: break-all; text-align: center; }
  .t { display: flex; flex-direction: column; gap: .8mm; min-width: 0; }
  .mark { font-size: 8pt; font-weight: 700; letter-spacing: .04em; border: .4mm solid #000; padding: .4mm 1mm; align-self: flex-start; }
  .cat { font-size: 13pt; font-weight: 700; line-height: 1.05; }
  .cyto { font-size: 8pt; font-weight: 700; border: .4mm solid #000; padding: .3mm 1mm; align-self: flex-start; }
  .row { font-size: 7.5pt; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row b { font-weight: 700; }
  .wt { font-size: 9pt; font-weight: 700; }
  .occ { font-size: 6pt; line-height: 1.15; margin-top: auto; }
`;

export type LabelBag = {
  barcode: string; category: BmwCategory; cytotoxic: boolean; placeName: string; generatedAt: Date; deptWeightGrams: number | null;
};

export function drawBagLabel(b: LabelBag): RenderedDocument {
  const words = CATEGORY_WORDS[b.category];
  const weight = b.deptWeightGrams === null ? "______ g" : `${(b.deptWeightGrams / 1000).toFixed(2)} kg`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(b.barcode)}</title><style>${LABEL_CSS}</style></head><body>`
    + `<div class="lab" data-barcode="${esc(b.barcode)}">`
    + `<div class="qr">${qrSvg(b.barcode, 96)}<div class="code">${esc(b.barcode)}</div></div>`
    + `<div class="t"><span class="mark">&#9763; ${words.mark}</span>`
    + `<div class="cat">${esc(words.en)} <span style="font-weight:400">${esc(words.hi)}</span></div>`
    + (b.cytotoxic ? `<span class="cyto">CYTOTOXIC · साइटोटॉक्सिक</span>` : "")
    + `<div class="row"><b>${esc(b.placeName)}</b></div>`
    + `<div class="row">${esc(IST.format(b.generatedAt))}</div>`
    + `<div class="row wt">Wt ${esc(weight)}</div>`
    + `<div class="occ">${HOSPITAL.name}</div></div></div></body></html>`;
  return { html, title: `BMW label ${b.barcode}`, page: { widthMm: 75, heightMm: 50 } };
}

/** The renderer the bmw module registers: params `{ bagId }`. Null for a bag that does not exist. */
export async function renderBagLabelJob(db: Db, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  if (typeof params.bagId !== "string") return null;
  const row = (await db.select({
    barcode: bmwBags.barcode, category: bmwBags.category, cytotoxic: bmwBags.cytotoxic, generatedAt: bmwBags.generatedAt,
    deptWeightGrams: bmwBags.deptWeightGrams, placeName: resources.name,
  }).from(bmwBags).innerJoin(resources, eq(resources.id, bmwBags.placeResourceId)).where(eq(bmwBags.id, params.bagId)))[0];
  if (row === undefined) return null;
  return drawBagLabel({ ...row, category: row.category as BmwCategory });
}
