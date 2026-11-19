import { HOSPITAL, esc } from "../../kernel/printing/document-kit";
import { qrSvg } from "../../kernel/printing/qr";
import { getGatePass } from "./gate-pass";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2c (#1119, decision 6) — THE GATE PASS, A4, both kinds. What leaves, for whom and why, who raised it, the
 * due-back day of a returnable pass, the record a non-returnable pass stands on, and the boxes the gate signs (out,
 * and in for a returnable pass). The QR carries the pass number only (decision 4); its last four digits are printed
 * large beside it for the guard's typed fallback. Labels are English and Hindi: the guard reads either.
 *
 * Queued by `raiseGatePass` in the raise's transaction (the relay prints it) and served to the store's own browser
 * by `GET /stores/gate-passes/:passId/print`. The renderer reads the rows at print time; params are the pass id.
 */
const CSS = `
  @page { size: A4; margin: 12mm; }
  body { font-family: "Noto Sans", "Noto Sans Devanagari", Arial, sans-serif; font-size: 13px; color: #111; margin: 0; }
  .hd { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #111; padding-bottom: 4px; }
  .nm { font-weight: 700; font-size: 15px; }
  h1 { font-size: 18px; margin: 10px 0 2px; }
  .kind { display: inline-block; border: 2px solid #111; padding: 2px 8px; font-weight: 700; margin: 4px 0 8px; }
  .kv td { padding: 2px 8px 2px 0; vertical-align: top; }
  .kv .k { color: #444; white-space: nowrap; }
  table.ln { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.ln th, table.ln td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  table.ln td.n, table.ln th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .sig { display: flex; gap: 24px; margin-top: 36px; }
  .sig .b { flex: 1; } .sig .line { border-bottom: 1px solid #111; height: 32px; } .sig .c { font-size: 11px; color: #333; }
  .qr { margin-top: 28px; display: flex; gap: 6mm; align-items: center; }
  .qr .no { font-size: 13px; font-weight: 700; } .qr .last4 { font-size: 34px; font-weight: 800; letter-spacing: 3px; }
`;

const PURPOSE: Record<string, string> = { repair: "Repair / मरम्मत", calibration: "Calibration / कैलिब्रेशन", refill: "Refill / रीफ़िल", loan: "Loan / उधार" };
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (d: string): string => new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

export async function renderGatePass(db: Db, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  const passId = typeof params.passId === "string" ? params.passId : null;
  if (passId === null) return null;
  const p = await getGatePass(db, passId);
  if (p === null) return null;
  const returnable = p.kind === "returnable";
  const kv = (k: string, v: string): string => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const body = `
    <div class="hd"><div class="nm">${HOSPITAL.nameTitleCase}</div><div>Stores · स्टोर</div></div>
    <h1>Gate pass · गेट पास · ${esc(p.passNo)}</h1>
    <div class="kind">${returnable ? "Returnable / वापसी वाला" : "Non-returnable / बिना वापसी"}</div>
    <table class="kv">
      ${kv("From / कहाँ से", p.store.name)}
      ${kv("To / किसको", p.party)}
      ${returnable ? kv("Purpose / काम", PURPOSE[p.purpose ?? ""] ?? "") : ""}
      ${returnable && p.dueBack !== null ? kv("Due back / वापसी की तारीख़", day(p.dueBack)) : ""}
      ${p.ref === null ? "" : kv(p.ref.type === "supplier_return" ? "Supplier return / सप्लायर वापसी" : "Write-off / राइट-ऑफ़", p.ref.no)}
      ${kv("Raised by / बनाया", `${p.raisedBy.name} · ${when(p.raisedAt)}`)}
      ${p.note === null ? "" : kv("Note / टिप्पणी", p.note)}
    </table>
    <table class="ln">
      <tr><th>Item / सामान</th><th>Code</th><th class="n">Qty / मात्रा</th><th>Unit</th></tr>
      ${p.lines.map((l) => `<tr><td>${esc(l.itemName)}</td><td>${esc(l.itemCode)}</td><td class="n">${String(l.qty)}</td><td>${esc(l.baseUom)}</td></tr>`).join("")}
    </table>
    <div class="sig">
      <div class="b"><div class="line"></div><div class="c">Store / स्टोर</div></div>
      <div class="b"><div class="line"></div><div class="c">Carried by / ले जाने वाला</div></div>
      <div class="b"><div class="line"></div><div class="c">Guard, out / गार्ड, बाहर</div></div>
      ${returnable ? `<div class="b"><div class="line"></div><div class="c">Guard, in / गार्ड, अंदर</div></div>` : ""}
    </div>
    <div class="qr">
      ${qrSvg(p.passNo, 130)}
      <div><div class="no">${esc(p.passNo)}</div><div class="last4">${esc(p.passNo.slice(-4))}</div><div>Scan at the gate / गेट पर स्कैन करें</div></div>
    </div>`;
  return {
    title: `Gate pass ${p.passNo}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gate pass</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}
