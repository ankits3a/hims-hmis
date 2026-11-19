import { asc, eq } from "drizzle-orm";
import { items, resources, storesRfqLines, storesRfqs } from "../../kernel/db/schema";
import { HOSPITAL, esc } from "../../kernel/printing/document-kit";
import { rfqClock, vendorNames } from "./buying-common";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S5b (#1115, flow 12) — THE RFQ A SUPPLIER RECEIVES, A4: RFQ number, the items and quantities, the delivery place
 * and date, the reply-by date, and the words "Quote before GST, GST apart, freight apart". No price, no other supplier's
 * name, no patient. Queued once per invitee by `sendRfq`; the buyer's browser prints the same render from
 * `GET /stores/rfqs/:id/print?vendorId=`. An RFQ never sent to that supplier renders nothing.
 */
const CSS = `
  @page { size: A4; margin: 14mm; }
  body { font-family: "Noto Sans", Arial, sans-serif; font-size: 13px; color: #111; margin: 0; }
  .hd { display: flex; justify-content: space-between; border-bottom: 1px solid #111; padding-bottom: 4px; }
  .nm { font-weight: 700; font-size: 15px; } h1 { font-size: 18px; margin: 10px 0 4px; }
  .kv td { padding: 2px 10px 2px 0; } .kv .k { color: #444; }
  table.ln { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.ln th, table.ln td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  table.ln td.n, table.ln th.n { text-align: right; } .terms { margin-top: 14px; font-weight: 700; }
`;
const day = (d: Date): string => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export async function renderRfq(db: Db, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  const rfqId = typeof params.rfqId === "string" ? params.rfqId : null;
  const vendorId = typeof params.vendorId === "string" ? params.vendorId : null;
  if (rfqId === null || vendorId === null) return null;
  const [r] = await db.select().from(storesRfqs).where(eq(storesRfqs.id, rfqId));
  if (r === undefined) return null;
  const clock = await rfqClock(db, r);
  if (!clock.sentTo.has(vendorId)) return null;
  const lines = await db.select({ l: storesRfqLines, code: items.code, name: items.name, uom: items.baseUom }).from(storesRfqLines)
    .innerJoin(items, eq(items.id, storesRfqLines.itemId)).where(eq(storesRfqLines.rfqId, rfqId)).orderBy(asc(storesRfqLines.lineIdx));
  const [place] = await db.select({ name: resources.name }).from(resources).where(eq(resources.id, r.deliveryStoreId));
  const to = (await vendorNames(db, [vendorId])).get(vendorId)?.name ?? "";
  const kv = (k: string, v: string): string => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const body = `
    <div class="hd"><div class="nm">${HOSPITAL.nameTitleCase}</div><div>Purchase</div></div>
    <h1>Request for quotation · ${esc(r.rfqNo)}</h1>
    <table class="kv">
      ${kv("To", to)}
      ${kv("Deliver to", `${place?.name ?? "Central store"}${r.deliveryDate === null ? "" : ` by ${r.deliveryDate}`}`)}
      ${kv("Reply by", day(clock.replyBy))}
    </table>
    <table class="ln"><thead><tr><th>#</th><th>Item</th><th class="n">Quantity</th><th>Unit</th></tr></thead><tbody>
      ${lines.map((l, i) => `<tr><td>${String(i + 1)}</td><td>${esc(l.name)} (${esc(l.code)})</td><td class="n">${String(l.l.qtyBase)}</td><td>${esc(l.uom)}</td></tr>`).join("")}
    </tbody></table>
    <p class="terms">Quote before GST, GST apart, freight apart. Payment after goods are received (GRN).</p>
    <p>Quote the RFQ number on your reply.</p>`;
  return {
    title: `RFQ ${r.rfqNo}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RFQ</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}
