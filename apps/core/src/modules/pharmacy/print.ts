import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { printJobs } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { esc, thermalPage } from "../../kernel/printing/render";
import { relayServes } from "../../kernel/printing/served";
import { getInvoice } from "../billing";
import { loadOpdConfig } from "../opd";
import { closingFor } from "./closing";
import { PharmacyError } from "./errors";
import { labelFor } from "./label";
import { getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { BillRow } from "./bill-rows";
import type { LabelData } from "./label";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHARMACY P1 — THE DESK PRINTS (parity plan 2026-09-24)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until now `/pharmacy/desk` printed nothing: the label was printed only from the old counter, by
 * `window.print()`, and the invoice only from the walk-in screen. The owner ruled printing
 * SERVER-SIDE (2026-09-04): the server renders, a relay inside the hospital claims the job and hands
 * it to CUPS. So after a hand-over the desk asks for its paper here and this file:
 *
 *   1. asks whether a relay is serving the pharmacy's roll at all (`relayServes`) — queuing paper
 *      for a site with no relay only prints it, stale, the day one is installed;
 *   2. if so, queues the BILL and the LABELS as two jobs to `pharmacy_thermal` (dedupe key per
 *      dispense; a Reprint mints a fresh key, so both attempts stay on the record — the kernel's
 *      reprint rule, `printing.controller.ts`);
 *   3. if not, says `browser`, and the desk prints the SAME documents from
 *      `GET /pharmacy/dispenses/:id/paper` — this file's renderers, the ones the relay would get.
 *
 * R7 holds: printing is ADVISORY. Nothing here is on the money or the stock path; a refusal here
 * leaves the hand-over exactly as it was.
 *
 * ═══ THE BILL IS THE COUNTER'S BILL ═══
 *
 * One row per drug (the loose-MRP ruling's merged rows, `bill-rows.ts`), the invoice's OWN totals,
 * and the GST summary folded from the STORED line heads — never re-priced, so the paper reconciles
 * to the ledger to the paisa. The title follows CGST Rules r.46/r.49/r.46A exactly as the web
 * invoice does (`documentTitleKey`): all taxable is a tax invoice.
 */
export type PharmacyPaper = "pharmacy_bill" | "pharmacy_labels";

const PHARMACY_PAPER: readonly PharmacyPaper[] = ["pharmacy_bill", "pharmacy_labels"];

/** The roll's extra rules: a table of rows, the summary, and a cut line between labels. */
const PHARMACY_CSS = `
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  th { text-align: left; font-weight: 700; border-bottom: 1px solid #000; padding: .5mm 0; font-size: 7.5pt; }
  td { vertical-align: top; padding: .6mm 0; }
  .r { text-align: right; white-space: nowrap; }
  .sub { font-size: 7pt; }
  .ttl { text-align: center; font-weight: 700; letter-spacing: .12em; font-size: 9pt; margin: 2mm 0 1mm; }
  .net { font-size: 12pt; font-weight: 700; }
  .lab { border: 1px solid #000; padding: 2mm; margin-top: 2mm; }
  .lab .drug { font-size: 11pt; font-weight: 700; line-height: 1.2; }
  .lab .how { font-size: 10.5pt; font-weight: 700; margin: 1.2mm 0; }
  .cut { border-top: 1px dashed #000; margin: 3mm 0 0; }
`;

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const IST_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `P2609190004` → `P-4`, the desk's own display form (PD-D8); anything else as it is. */
function ticketLabel(dispenseNo: string | null): string {
  if (dispenseNo === null) return "—";
  const m = /^([A-Za-z]+)\d{6}(\d+)$/.exec(dispenseNo);
  return m === null ? dispenseNo : `${m[1]!}-${String(Number(m[2]!))}`;
}

function qtyText(row: BillRow): string {
  const p = row.pack;
  if (p === null || p.packs === 0) return `× ${String(row.qty)}`;
  return p.loose === 0 ? `${String(p.packs)} ${p.uom}` : `${String(p.packs)} ${p.uom} + ${String(p.loose)} ${p.baseUom}`;
}

/** CGST Rules r.46 / r.49 / r.46A — the same rule as the web invoice's `documentTitleKey`. */
export function documentTitle(lines: readonly { exempt: boolean }[]): string {
  const exempt = lines.filter((l) => l.exempt).length;
  if (exempt === 0) return "TAX INVOICE";
  return exempt === lines.length ? "BILL OF SUPPLY" : "INVOICE-CUM-BILL OF SUPPLY";
}

/**
 * The GST summary: stored line heads summed by (rate, exempt). A fold of the ledger's own figures —
 * the invoice's CGST and SGST are sums of these same heads, so the rows add up to the totals.
 */
export function gstSummary(lines: readonly { rateBps: number; exempt: boolean; taxableBasePaise: number; cgstPaise: number; sgstPaise: number }[]): {
  rateBps: number; exempt: boolean; taxableBasePaise: number; cgstPaise: number; sgstPaise: number;
}[] {
  const out = new Map<string, { rateBps: number; exempt: boolean; taxableBasePaise: number; cgstPaise: number; sgstPaise: number }>();
  for (const l of lines) {
    const k = `${String(l.rateBps)}|${String(l.exempt)}`;
    const row = out.get(k) ?? { rateBps: l.rateBps, exempt: l.exempt, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    row.taxableBasePaise += l.taxableBasePaise; row.cgstPaise += l.cgstPaise; row.sgstPaise += l.sgstPaise;
    out.set(k, row);
  }
  return [...out.values()];
}

type Part = { title: string; body: string };

/** The paper names the patient as the label read does — alias-safe (`labelFor`). No requester reads as nobody. */
function readerOf(requester: Actor | null): Actor {
  return requester ?? { type: "system", id: "pharmacy-print" };
}

async function billPart(db: Db, requester: Actor | null, dispenseId: string, label: LabelData): Promise<Part | null> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.invoiceId === null || label.billRows === null) return null;
  const found = await getInvoice(db, d.invoiceId);
  if (found === null) return null;
  const { invoice, lines } = found;
  const closing = await closingFor(db, readerOf(requester), dispenseId);
  const letterhead = (await loadOpdConfig(db)).letterhead;
  const summary = gstSummary(lines);

  const rows = label.billRows.map((r) => `
      <tr><td>${esc(r.serviceName)}<div class="sub">HSN ${esc(r.sacCode ?? "")}${r.exempt === true ? " · exempt" : r.rateBps === null ? "" : ` · GST ${String(r.rateBps / 100)}%`}${r.pack !== null && r.pack.packs > 0 && r.pack.packPaise !== null ? ` · ${esc(rupees(r.pack.packPaise))}/${esc(r.pack.uom)}` : ""}</div></td>
      <td class="r">${esc(qtyText(r))}</td><td class="r">${esc(rupees(r.netPaise))}</td></tr>`).join("");
  const gst = summary.map((g) => `
      <tr><td>${g.exempt ? "Exempt" : `${String(g.rateBps / 100)}%`}</td><td class="r">${esc(rupees(g.taxableBasePaise))}</td><td class="r">${esc(rupees(g.cgstPaise))}</td><td class="r">${esc(rupees(g.sgstPaise))}</td></tr>`).join("");
  const money = closing.money;
  const tenders = money === null ? "" : money.tenders.map((t) => `${t.mode.toUpperCase()} ${rupees(t.amountPaise)}`).join(" + ");
  const pharmacist = label.pharmacist;

  const body = `
    <div class="hd">
      <div class="nm">${esc(letterhead.name)}</div>
      <div class="ad">${letterhead.legalName === undefined ? "" : `A unit of ${esc(letterhead.legalName)}<br>`}${letterhead.addressLines.map(esc).join("<br>")}${letterhead.gstin === undefined ? "" : `<br>GSTIN ${esc(letterhead.gstin)}`}</div>
    </div>
    <div class="ttl">${documentTitle(lines)}</div>
    <div class="row"><span class="k">Invoice</span><span class="v mo">${esc(invoice.invoiceNo)}</span></div>
    <div class="row"><span class="k">Date</span><span class="v">${esc(invoice.serviceDay)}${d.handedOverAt === null ? "" : ` ${esc(IST_TIME.format(d.handedOverAt))}`}</span></div>
    <div class="row"><span class="k">Patient</span><span class="v">${esc(label.patient.display)}</span></div>
    <div class="row"><span class="k">UHID</span><span class="v mo">${esc(label.patient.uhid)}</span></div>
    <div class="row"><span class="k">Ticket</span><span class="v mo">${esc(ticketLabel(label.dispenseNo))}</span></div>
    <div class="sec"><table>
      <thead><tr><th>Medicine</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="sec">
      <div class="row"><span class="k">Gross</span><span class="v">${esc(rupees(invoice.grossPaise))}</span></div>
      ${invoice.discountPaise === 0 ? "" : `<div class="row"><span class="k">Discount</span><span class="v">${esc(rupees(invoice.discountPaise))}</span></div>`}
      <div class="row"><span class="k">Taxable value</span><span class="v">${esc(rupees(invoice.taxableBasePaise))}</span></div>
      <div class="row"><span class="k">CGST</span><span class="v">${esc(rupees(invoice.cgstPaise))}</span></div>
      <div class="row"><span class="k">SGST</span><span class="v">${esc(rupees(invoice.sgstPaise))}</span></div>
      ${invoice.roundingPaise === 0 ? "" : `<div class="row"><span class="k">Rounding</span><span class="v">${esc(rupees(invoice.roundingPaise))}</span></div>`}
      <div class="row net"><span class="k">Net payable</span><span class="v">${esc(rupees(invoice.netPayablePaise))}</span></div>
    </div>
    <div class="sec"><table>
      <thead><tr><th>GST</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th></tr></thead>
      <tbody>${gst}</tbody>
    </table></div>
    ${money === null ? "" : `<div class="sec">
      <div class="row"><span class="k">Paid</span><span class="v">${esc(tenders)}</span></div>
      ${money.receiptNo === null ? "" : `<div class="row"><span class="k">Receipt</span><span class="v mo">${esc(money.receiptNo)}</span></div>`}
      ${money.changeGivenPaise === 0 ? "" : `<div class="row"><span class="k">Change</span><span class="v">${esc(rupees(money.changeGivenPaise))}</span></div>`}
    </div>`}
    <div class="ft">
      Prices include GST and are never above the printed MRP.<br>
      ${pharmacist === null ? "" : `Dispensed by ${esc(pharmacist.name)}${pharmacist.registrationNo === null ? "" : ` · Reg. ${esc(pharmacist.registrationNo)}`}<br>`}
      Authorised signatory · ${esc(letterhead.legalName ?? letterhead.name)}
    </div>
  `;
  return { title: `Pharmacy bill ${invoice.invoiceNo} — ${label.patient.display}`, body };
}

function labelsPart(label: LabelData, now: Date): Part | null {
  const lines = label.lines.filter((l) => l.batchNo !== "");
  if (lines.length === 0) return null;
  const day = IST_DAY.format(label.handedOverAt ?? now);
  const who = label.pharmacist;
  const body = lines.map((l, i) => `
    ${i === 0 ? "" : '<div class="cut"></div>'}
    <div class="lab">
      <div class="row"><span class="k">${esc(label.patient.display)}</span><span class="v mo">${esc(label.patient.uhid)}</span></div>
      <div class="drug">${esc(l.drug)}${l.strength === null ? "" : ` ${esc(l.strength)}`}</div>
      <div class="sub">${esc(l.packs ?? `${String(l.qtyBase)} ${l.unit}`)}${l.form === null ? "" : ` · ${esc(l.form)}`}${l.substitutedFor === null ? "" : ` · for ${esc(l.substitutedFor)}`}</div>
      <div class="how">${esc(l.directions === "" ? "As directed by the doctor" : l.directions)}</div>
      <div class="row"><span class="k">Batch <span class="mo">${esc(l.batchNo)}</span></span><span class="v">Exp ${esc(l.expiryDate ?? "—")}</span></div>
      <div class="row"><span class="k">${esc(ticketLabel(label.dispenseNo))} · ${esc(day)}</span><span class="v">${who === null ? "" : esc(who.name)}</span></div>
    </div>`).join("");
  return { title: `Labels ${ticketLabel(label.dispenseNo)} — ${label.patient.display}`, body };
}

/** One document of the pair, or null when it does not exist yet (the relay reports that failed; R7). */
export async function renderPharmacyPaper(
  db: Db, document: PharmacyPaper, params: Record<string, unknown>, now: Date, requester: Actor | null,
): Promise<RenderedDocument | null> {
  const dispenseId = typeof params.dispenseId === "string" ? params.dispenseId : null;
  if (dispenseId === null) return null;
  const label = await labelFor(db, readerOf(requester), dispenseId);
  const part = document === "pharmacy_bill" ? await billPart(db, requester, dispenseId, label) : labelsPart(label, now);
  return part === null ? null : thermalPage(part.title, part.body, PHARMACY_CSS);
}

/**
 * The browser's copy: the bill and the labels as ONE roll, so the fallback is one print dialog, not
 * two. Both parts are the relay's own renderings, joined at a cut line.
 */
export async function dispensePaper(db: Db, actor: Actor, dispenseId: string, now: Date): Promise<RenderedDocument> {
  const label = await labelFor(db, actor, dispenseId);
  const parts = [await billPart(db, actor, dispenseId, label), labelsPart(label, now)].filter((p): p is Part => p !== null);
  if (parts.length === 0) throw new PharmacyError("nothing_to_print", "no bill and no picked medicine on this ticket yet");
  return thermalPage(parts.map((p) => p.title).join(" · "), parts.map((p) => p.body).join('<div class="cut"></div>'), PHARMACY_CSS);
}

export type PrintJobView = { id: string; document: string; status: string; lastError: string | null; printedAt: Date | null; createdAt: Date };
export type SendPaperResult =
  | { via: "relay"; jobs: PrintJobView[] }
  /** No relay is serving the pharmacy's roll: the desk prints `GET …/paper` itself, and says so once. */
  | { via: "browser"; documents: PharmacyPaper[] };

/** What this dispense has to print now: the bill once there is an invoice, labels once something was picked. */
async function paperFor(db: Db, dispenseId: string): Promise<{ d: Awaited<ReturnType<typeof getDispenseRow>>; documents: PharmacyPaper[] }> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "billed" && d.status !== "handed_over") {
    throw new PharmacyError("nothing_to_print", `dispense ${d.id} is ${d.status}; the bill and labels print once it is billed`, { status: d.status });
  }
  const picked = (await linesOf(db, dispenseId)).some((l) => l.status === "open" && l.batchId !== null);
  const documents = PHARMACY_PAPER.filter((p) => (p === "pharmacy_bill" ? d.invoiceId !== null : picked));
  if (documents.length === 0) throw new PharmacyError("nothing_to_print", "no bill and no picked medicine on this ticket");
  return { d, documents };
}

/**
 * Send the bill and labels to the counter's printer. `reprint` mints fresh dedupe keys — a second
 * copy on purpose, recorded against the person who asked for it; without it a repeat is one row.
 */
export async function sendDispensePaper(
  db: Db, actor: Actor, dispenseId: string, input: { reprint?: boolean }, now: Date,
): Promise<SendPaperResult> {
  const { d, documents } = await paperFor(db, dispenseId);
  if (!(await relayServes(db, "pharmacy_thermal", now))) return { via: "browser", documents };
  const ids = await withTx(db, async (tx) => {
    const out: string[] = [];
    for (const document of documents) {
      const dedupeKey = `${document}:${d.id}${input.reprint === true ? `:reprint:${newId()}` : ""}`;
      const id = await enqueuePrintJob(tx, {
        document, params: { dispenseId: d.id }, dedupeKey,
        patientId: d.patientId, encounterId: d.encounterId, requestedBy: actor.type === "user" ? actor.id : null,
      });
      if (id !== null) out.push(id);
      else {
        /* Already queued under this key: the paper is coming (enqueue's own contract). Report that row. */
        const [existing] = await tx.select({ id: printJobs.id }).from(printJobs).where(eq(printJobs.dedupeKey, dedupeKey));
        if (existing !== undefined) out.push(existing.id);
      }
    }
    return out;
  });
  const jobs = await db.select().from(printJobs).where(inArray(printJobs.id, ids));
  return { via: "relay", jobs: jobs.map(viewOf) };
}

function viewOf(r: typeof printJobs.$inferSelect): PrintJobView {
  return { id: r.id, document: r.document, status: r.status, lastError: r.lastError, printedAt: r.printedAt, createdAt: r.createdAt };
}

/** The dispense's paper, newest first — what the done screen polls to say "printed" or "not taken". */
export async function dispensePrintJobs(db: Db, dispenseId: string): Promise<PrintJobView[]> {
  const rows = await db.select().from(printJobs)
    .where(and(inArray(printJobs.document, [...PHARMACY_PAPER]), sql`${printJobs.params}->>'dispenseId' = ${dispenseId}`))
    .orderBy(desc(printJobs.createdAt));
  return rows.map(viewOf);
}
