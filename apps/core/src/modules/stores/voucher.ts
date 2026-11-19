import { asc, eq } from "drizzle-orm";
import { items, orgDepartments, resources, storeIndentLines, storeIndents, storesTicketDetails, users } from "../../kernel/db/schema";
import { HOSPITAL, esc, registerDocumentRenderer } from "../../kernel/printing/document-kit";
import { qrSvg } from "../../kernel/printing/qr";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import type { Db } from "../../kernel/db/client";

/**
 * STORES S2b (#1112, spec "To pick": Issue prints the voucher and label) — THE ISSUE VOUCHER, A4: the ticket's
 * lines as issued, who asked, who approved and who issued, the two signature boxes the Indian indent voucher
 * carries (issued by / received by), and a LABEL with the QR the porter scans. The QR carries the ticket number
 * only (decision 7); its last four digits are printed large under it, for the typed fallback.
 *
 * Queued by `issueTicket` in the issue's own transaction; the renderer reads the rows at print time (a job's
 * params are the indent id only). An indent that is not issued renders nothing.
 */
const CSS = `
  @page { size: A4; margin: 12mm; }
  body { font-family: "Noto Sans", Arial, sans-serif; font-size: 13px; color: #111; margin: 0; }
  .hd { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #111; padding-bottom: 4px; }
  .nm { font-weight: 700; font-size: 15px; }
  h1 { font-size: 18px; margin: 10px 0 2px; }
  .kv td { padding: 2px 8px 2px 0; vertical-align: top; }
  .kv .k { color: #444; white-space: nowrap; }
  table.ln { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.ln th, table.ln td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  table.ln td.n, table.ln th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .sig { display: flex; gap: 24px; margin-top: 36px; }
  .sig .b { flex: 1; } .sig .line { border-bottom: 1px solid #111; height: 32px; } .sig .c { font-size: 11px; color: #333; }
  .label { margin-top: 28px; border: 2px dashed #111; width: 72mm; padding: 4mm; display: flex; gap: 4mm; align-items: center; }
  .label .no { font-size: 13px; font-weight: 700; } .label .last4 { font-size: 30px; font-weight: 800; letter-spacing: 2px; }
`;

const when = (d: Date): string => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export async function renderIssueVoucher(db: Db, params: Record<string, unknown>): Promise<RenderedDocument | null> {
  const indentId = typeof params.indentId === "string" ? params.indentId : null;
  if (indentId === null) return null;
  const [row] = await db.select({ indent: storeIndents, details: storesTicketDetails }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id)).where(eq(storeIndents.id, indentId));
  if (row === undefined || row.indent.status !== "issued" || row.indent.decidedAt === null) return null;
  const { indent: i, details: d } = row;
  const issuedAt = row.indent.decidedAt;
  const lines = await db.select({ line: storeIndentLines, code: items.code, name: items.name, uom: items.baseUom }).from(storeIndentLines)
    .innerJoin(items, eq(items.id, storeIndentLines.itemId)).where(eq(storeIndentLines.indentId, indentId)).orderBy(asc(storeIndentLines.lineIdx));
  const place = async (id: string): Promise<string> => (await db.select({ name: resources.name }).from(resources).where(eq(resources.id, id)))[0]?.name ?? "—";
  const person = async (id: string | null): Promise<string> =>
    id === null ? "—" : (await db.select({ n: users.fullName }).from(users).where(eq(users.id, id)))[0]?.n ?? "—";
  const [dept] = await db.select({ name: orgDepartments.name }).from(orgDepartments).where(eq(orgDepartments.id, d.departmentId));
  const kv = (k: string, v: string): string => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const body = `
    <div class="hd"><div class="nm">${HOSPITAL.nameTitleCase}</div><div>Stores</div></div>
    <h1>Issue voucher · ${esc(i.indentNo)}</h1>
    <table class="kv">
      ${kv("From", await place(i.toResourceId))}
      ${kv("To", `${await place(i.fromResourceId)} · ${dept?.name ?? ""}${d.deliverTo === null ? "" : ` · ${d.deliverTo}`}`)}
      ${kv("Priority", d.priority)}
      ${kv("Asked by", `${await person(i.requestedBy)} · ${when(i.requestedAt)}`)}
      ${kv("Approved by", i.approvalBy === null ? "—" : `${await person(i.approvalBy)}${i.approvalForHod === true ? " (for HOD)" : ""}`)}
      ${kv("Issued by", `${await person(i.decidedBy)} · ${when(issuedAt)}`)}
    </table>
    <table class="ln">
      <tr><th>Item</th><th>Code</th><th class="n">Asked</th><th class="n">Approved</th><th class="n">Issued</th><th>Unit</th></tr>
      ${lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.code)}</td><td class="n">${String(l.line.qtyBase)}</td><td class="n">${String(l.line.qtyApproved ?? l.line.qtyBase)}</td><td class="n">${String(l.line.qtyIssued ?? 0)}</td><td>${esc(l.uom)}</td></tr>`).join("")}
    </table>
    <div class="sig">
      <div class="b"><div class="line"></div><div class="c">Issued by (store)</div></div>
      <div class="b"><div class="line"></div><div class="c">Received by (department)</div></div>
    </div>
    <div class="label">
      ${qrSvg(i.indentNo, 120)}
      <div><div class="no">${esc(i.indentNo)}</div><div class="last4">${esc(i.indentNo.slice(-4))}</div><div>${esc(dept?.name ?? "")}</div></div>
    </div>`;
  return {
    title: `Issue voucher ${i.indentNo}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Issue voucher</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

/** Registered by `StoresModule.onModuleInit`; exported so a suite can register it without Nest. Returns the unregister. */
export function registerStoresPrinting(): () => void {
  return registerDocumentRenderer("stores_issue_voucher", (db, params) => renderIssueVoucher(db, params));
}
