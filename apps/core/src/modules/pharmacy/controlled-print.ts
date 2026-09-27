import { esc } from "../../kernel/printing/render";
import { survivorsOf } from "../materials";
import { loadOpdConfig } from "../opd";
import { readControlledBalance, readControlledRegister } from "./controlled-office";
import { istDateOf } from "./config";
import { PharmacyError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { ControlledRegisterView } from "./controlled-office";

/**
 * ═══ PHARMACY P6 — THE REGISTERS ON PAPER, IN THE FORMS' OWN LAYOUT (A4, printed from the office) ═══
 *
 *   - `form3h` — NDPS Rules r.52R(1)(c), Form 3H: for each essential narcotic drug, a page; for each day,
 *     opening stock, quantity received (from whom, against which consignment note / bill / invoice),
 *     quantity dispensed with the Form 3E registration number of each patient (the UHID) and the quantity
 *     each received, closing stock; signed by the overall in charge.
 *   - `schedule_x` — D&C Rules r.65(21): for each Schedule X drug, a page; per transaction the date, the
 *     quantity received with the supplier's name, address and licence number, the quantity supplied, the
 *     batch, the patient's name and address, the prescription reference, the bill number and date, and
 *     the supervising pharmacist. The manufacturer is not in this catalogue: its column is left for the pen.
 *   - `form3e` — Form 3E: one patient's record of what they were given, with the column they sign in.
 *
 * Every page carries the serial numbers of its register rows (the "serially numbered pages" of Form 3H's
 * notes: the register's own `seq`, which an append-only table never re-uses).
 */
export type ControlledPrintKind = "form3h" | "schedule_x" | "form3e";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const dayLabel = (d: string): string => `${d.slice(8, 10)}-${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""}-${d.slice(0, 4)}`;
const istDay = (iso: string): string => istDateOf(new Date(iso));

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

const CSS = `@page{size:210mm 297mm;margin:12mm}body{font-family:"Segoe UI",Arial,"Nirmala UI",sans-serif;font-size:10px;color:#111;margin:0}
header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
.nm{font-size:14px;font-weight:700}.ad{font-size:9px}.t{text-align:right}.t h1{margin:0;font-size:14px}.t div{font-size:9px}
h2{font-size:12px;margin:10px 0 4px}table{width:100%;border-collapse:collapse;margin-bottom:6px}
th,td{border:1px solid #999;padding:3px;text-align:left;vertical-align:top}th{background:#f2f2f2}.n{text-align:right}
.page{page-break-after:always}.page:last-child{page-break-after:auto}.small{font-size:8px;color:#444}
footer{display:flex;justify-content:space-between;margin-top:24px;font-size:10px}`;

async function frame(db: Db, title: string, form: string, period: string, pages: string): Promise<RenderedDocument> {
  const lh = (await loadOpdConfig(db)).letterhead;
  const head = `<header><div><div class="nm">${esc(lh.name)}</div><div class="ad">${lh.legalName === undefined ? "" : `A unit of ${esc(lh.legalName)}<br>`}${lh.addressLines.map(esc).join("<br>")}</div></div>
    <div class="t"><h1>${esc(title)}</h1><div>${esc(form)}</div><div>${esc(period)}</div></div></header>`;
  const body = pages.trim() === "" ? `${head}<p>No entries in this period.</p>` : pages.replaceAll("<!--HEAD-->", head);
  return {
    title: `${title} — ${period}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

type Row = ControlledRegisterView["rows"][number];

/**
 * The register's pages, one per drug. PHARMACY P6 — a drug is its item AFTER merges: the rows of a
 * duplicate since merged into another stay as written (the register is append-only) and print on the
 * survivor's page, so the page's running balance is the whole drug's (`through`, from `survivorsOf`).
 */
function byDrug(rows: readonly Row[], through: ReadonlyMap<string, string>): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const key = through.get(r.itemId) ?? r.itemId;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

const signature = `<footer><div>Full name / designation: ____________________</div><div>Signature of the overall in charge: ____________________</div></footer>`;

async function form3h(db: Db, actor: Actor, from: string, to: string): Promise<RenderedDocument> {
  const reg = await readControlledRegister(db, actor, { register: "ndps", from, to });
  const balance = await readControlledBalance(db, actor, { from, to });
  const through = await survivorsOf(db, [...balance.rows.map((b) => b.itemId), ...reg.rows.map((r) => r.itemId)]);
  const k = (itemId: string): string => through.get(itemId) ?? itemId;
  const openingOf = (key: string): number => balance.rows.filter((b) => k(b.itemId) === key).reduce((s, b) => s + b.opening, 0);
  const drugs = new Map<string, { name: string; unit: string }>();
  // A page is named as the survivor names the drug; a merged duplicate's name only when the survivor has no row.
  const name = (itemId: string, drug: { name: string; unit: string }): void => {
    if (!drugs.has(k(itemId)) || itemId === k(itemId)) drugs.set(k(itemId), drug);
  };
  for (const b of balance.rows) if (b.ndpsClass !== null) name(b.itemId, { name: b.drugName, unit: b.unit });
  for (const r of reg.rows) name(r.itemId, { name: r.drugName, unit: r.unit });
  const rowsBy = byDrug(reg.rows, through);
  const pages = [...drugs.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([itemId, drug]) => {
    let running = openingOf(itemId);
    const rows = rowsBy.get(itemId) ?? [];
    const body = days(from, to).map((day) => {
      const today = rows.filter((r) => istDay(r.occurredAt) === day);
      const opening = running;
      const received = today.filter((r) => r.direction === "in");
      const dispensed = today.filter((r) => r.direction === "out" && r.movement === "consume");
      const otherOut = today.filter((r) => r.direction === "out" && r.movement !== "consume");
      const net = today.reduce((s, r) => s + (r.direction === "in" ? r.qtyBase : -r.qtyBase), 0);
      running = opening + net;
      const recQty = received.reduce((s, r) => s + r.qtyBase, 0);
      const disQty = dispensed.reduce((s, r) => s + r.qtyBase, 0);
      return `<tr><td>${dayLabel(day)}</td><td class="n">${String(opening)}</td>
        <td class="n">${recQty === 0 ? "—" : String(recQty)}</td>
        <td>${received.map((r) => `${esc(r.counterparty ?? r.movement)}${r.counterpartyLicence === null ? "" : ` (DL ${esc(r.counterpartyLicence)})`}`).join("; ")}</td>
        <td>${received.map((r) => esc(r.documentRef ?? "")).join("; ")}</td>
        <td class="n">${disQty === 0 ? "—" : String(disQty)}</td>
        <td>${dispensed.map((r) => `${esc(r.uhid ?? "—")} × ${String(r.qtyBase)}`).join("; ")}${otherOut.map((r) => `<div class="small">${esc(r.movement === "adjust" ? "destroyed / adjusted" : r.movement)} ${String(r.qtyBase)} — ${esc(r.documentRef ?? "")}</div>`).join("")}</td>
        <td class="n">${String(running)}</td>
        <td class="small">${today.map((r) => `#${String(r.seq)} ${esc(r.holderName)} / ${esc(r.witnessName)}`).join("<br>")}</td></tr>`;
    }).join("");
    return `<div class="page"><!--HEAD--><h2>Name of the essential narcotic drug: ${esc(drug.name)} (${esc(drug.unit)})</h2>
      <table><thead><tr><th>Date</th><th>1. Opening stock</th><th>2. Quantity received</th><th>2(i) Received from</th><th>2(ii) Consignment note / bill / invoice no.</th>
      <th>3. Quantity dispensed</th><th>4. Registration no. (Form 3E) × quantity</th><th>5. Closing stock</th><th>Entry no. · holder / witness</th></tr></thead>
      <tbody>${body}</tbody></table>${signature}</div>`;
  }).join("");
  return frame(db, "Record of essential narcotic drugs", "Form 3H — NDPS Rules 1985, r.52R(1)(c)", `${dayLabel(from)} to ${dayLabel(to)}`, pages);
}

async function scheduleX(db: Db, actor: Actor, from: string, to: string): Promise<RenderedDocument> {
  const reg = await readControlledRegister(db, actor, { register: "x", from, to });
  const pages = [...byDrug(reg.rows, await survivorsOf(db, reg.rows.map((r) => r.itemId))).values()].sort((a, b) => a[0]!.drugName.localeCompare(b[0]!.drugName)).map((rows) => {
    const body = rows.map((r) => {
      const supplied = r.direction === "out";
      return `<tr><td>#${String(r.seq)}</td><td>${dayLabel(istDay(r.occurredAt))}</td>
        <td class="n">${supplied ? "—" : String(r.qtyBase)}</td>
        <td>${supplied ? "" : `${esc(r.counterparty ?? "")}${r.counterpartyAddress === null ? "" : `, ${esc(r.counterpartyAddress)}`}${r.counterpartyLicence === null ? "" : `<br>DL ${esc(r.counterpartyLicence)}`}`}</td>
        <td class="n">${supplied ? String(r.qtyBase) : "—"}</td><td></td><td>${esc(r.batchNo)}</td>
        <td>${supplied && r.movement === "consume" ? `${esc(r.counterparty ?? "")}${r.counterpartyAddress === null ? "" : `, ${esc(r.counterpartyAddress)}`}` : supplied ? esc(`${r.movement}: ${r.counterparty ?? ""}`) : ""}</td>
        <td>${esc(r.rxRef ?? "")}</td><td>${esc(r.documentRef ?? "")}${r.documentDate === null ? "" : `<br>${dayLabel(r.documentDate)}`}</td>
        <td>${esc(r.holderName)}${r.holderRegNo === null ? "" : `<br>Reg. ${esc(r.holderRegNo)}`}<div class="small">witness ${esc(r.witnessName)}</div></td>
        <td class="n">${String(r.balanceAfter)}</td></tr>`;
    }).join("");
    return `<div class="page"><!--HEAD--><h2>${esc(rows[0]!.drugName)} (${esc(rows[0]!.unit)})</h2>
      <table><thead><tr><th>Entry</th><th>Date</th><th>Qty received</th><th>Supplier: name, address, licence no.</th><th>Qty supplied</th><th>Manufacturer</th><th>Batch</th>
      <th>Patient: name and address</th><th>Prescription ref.</th><th>Bill no. and date</th><th>Pharmacist</th><th>Balance (batch)</th></tr></thead><tbody>${body}</tbody></table>
      <footer><div>Signature of the pharmacist: ____________________</div><div></div></footer></div>`;
  }).join("");
  return frame(db, "Schedule X register", "D&C Rules 1945, r.65(21)", `${dayLabel(from)} to ${dayLabel(to)}`, pages);
}

async function form3e(db: Db, actor: Actor, from: string, to: string, patientId: string | undefined): Promise<RenderedDocument> {
  if (patientId === undefined) throw new PharmacyError("invalid_range", "Form 3E is one patient's record — name the patient");
  const reg = await readControlledRegister(db, actor, { register: "ndps", from, to, patientId });
  const rows = reg.rows.filter((r) => r.movement === "consume");
  const first = rows[0];
  const head = first === undefined ? "" : `<table><tbody>
    <tr><th>Registration number</th><td>${esc(first.uhid ?? "")}</td><th>Date</th><td>${dayLabel(istDay(first.occurredAt))}</td></tr>
    <tr><th>1. Name</th><td colspan="3">${esc(first.counterparty ?? "")}</td></tr>
    <tr><th>2. Complete postal address</th><td colspan="3">${esc(first.counterpartyAddress ?? "")}</td></tr>
    <tr><th>3. Brief description of the illness</th><td colspan="3"></td></tr>
    <tr><th>4. Registered with any other RMP / RMI</th><td colspan="3"></td></tr></tbody></table>`;
  const body = rows.map((r) => `<tr><td>${dayLabel(istDay(r.occurredAt))}</td><td>${esc(r.drugName)}</td><td class="n">${String(r.qtyBase)} ${esc(r.unit)}</td><td style="height:22px"></td>
    <td class="small">#${String(r.seq)} · Dr ${esc(r.prescriberName ?? "")} (${esc(r.prescriberRegNo ?? "")}) · to ${esc(r.collectedBy ?? "")}</td></tr>`).join("");
  const page = `<div class="page"><!--HEAD-->${head}<h2>5. Details of the essential narcotic drugs dispensed</h2>
    <table><thead><tr><th>Date</th><th>Name of the essential narcotic drug</th><th>Quantity</th><th>Signature / thumb impression of the patient</th><th>Remarks</th></tr></thead>
    <tbody>${body}</tbody></table>${signature}</div>`;
  return frame(db, "Patient record — essential narcotic drugs", "Form 3E — NDPS Rules 1985, r.52H(3), r.52R(1)(b)", `${dayLabel(from)} to ${dayLabel(to)}`, rows.length === 0 ? "" : page);
}

export async function controlledRegisterDocument(
  db: Db, actor: Actor, input: { kind: ControlledPrintKind; from: string; to: string; patientId?: string },
): Promise<RenderedDocument> {
  if (input.kind === "form3h") return form3h(db, actor, input.from, input.to);
  if (input.kind === "schedule_x") return scheduleX(db, actor, input.from, input.to);
  return form3e(db, actor, input.from, input.to, input.patientId);
}
