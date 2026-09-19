import { CREST_PNG_DATA_URI } from "../../kernel/printing/crest";
import type {
  DayReportCounts, OpdDayReport, OpdDepartmentDayReport, PatientType, ReportHospital,
} from "./day-report";

/**
 * ═══ THE OPD DAY REPORT ON PAPER, AND AS A SPREADSHEET ═══
 *
 * The printable sheet is SELF-CONTAINED HTML in the shape `kernel/printing` already hands the
 * browser for Save-as-PDF (owner, 2026-09-06: *"browser based printing as a 'Save as pdf'"*): inline
 * CSS, the crest as a data URI, no font CDN. The production image has no browser to make a PDF with,
 * and the page the owner saves and the page a printer would draw are then one document.
 *
 * Both formats are built from the SAME loaded report the screen shows, so the three cannot disagree
 * about a number — the rule 07c's own export was built on.
 */

export type RenderedReport = { html: string; title: string; page: { widthMm: number; heightMm: number | null } };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const PATIENT_TYPE_LABEL: Record<PatientType, string> = { new: "New", revisit: "Revisit", renewal: "Renewal" };

/** The definitions printed under every table — a number without its definition gets argued about. */
export const DEFINITIONS: readonly string[] = [
  "New — first consultation at the hospital (no consultation on any earlier day, in any department).",
  "Revisit — a returning patient on the free follow-up of an earlier consultation in this department.",
  "Renewal — a returning patient paying a fresh consultation fee: the follow-up period is over, or it is their first visit to this department.",
  "Booked — appointments for this day that were not cancelled or moved. Consulted — consultations the doctor completed.",
];

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** `2026-09-19` → `19-Sep-2026`, the hospital's printed form. */
export function dayLabel(date: string): string {
  const m = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  return `${date.slice(8, 10)}-${m}-${date.slice(0, 4)}`;
}

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `19-Sep-2026 08:35 IST` — the instant the sheet was made, in the same form as its date. */
export function generatedLabel(iso: string): string {
  const at = new Date(iso);
  return `${dayLabel(IST_DAY.format(at))} ${IST_TIME.format(at)} IST`;
}

const CSS = `
  @page { size: A4 portrait; margin: 14mm 12mm 16mm;
    @bottom-left { content: "Computer-generated report"; font: 9px Arial, sans-serif; color: #777; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9px Arial, sans-serif; color: #777; } }
  * { box-sizing: border-box; }
  @media screen { body { max-width: 820px; margin: 28px auto; padding: 0 20px; } }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1c1c1c; font-size: 11.5px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .num { font-variant-numeric: tabular-nums; }
  .lh { display: flex; align-items: center; gap: 16px; padding-bottom: 10px; border-bottom: 2.5px solid #55064f; }
  .lh img { width: 64px; height: auto; display: block; }
  .lh .nm { font-size: 21px; font-weight: 800; color: #55064f; letter-spacing: .3px; line-height: 1.15; }
  .lh .ad { font-size: 11.5px; color: #333; margin-top: 3px; }
  .lh .sub { font-size: 10.5px; color: #666; margin-top: 2px; }
  .ttl { display: flex; justify-content: space-between; align-items: flex-end; margin: 14px 0 10px; gap: 12px; }
  .ttl h1 { margin: 0; font-size: 16px; letter-spacing: .6px; text-transform: uppercase; }
  .ttl .k { font-size: 11px; color: #555; margin-top: 3px; }
  .ttl .r { text-align: right; font-size: 11px; color: #444; }
  .ttl .r b { font-size: 13px; color: #1c1c1c; }
  .warn { border: 1px solid #d99a00; background: #fff6dd; color: #6b4a00; padding: 6px 10px; border-radius: 4px; margin-bottom: 10px; font-size: 11px; }
  .tiles { display: flex; gap: 8px; margin: 4px 0 12px; }
  .tile { flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 7px 10px; }
  .tile .v { font-size: 19px; font-weight: 800; }
  .tile .l { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: .4px; margin-top: 1px; }
  .tile.main { border-color: #55064f; background: #f8f1f7; }
  .tile.main .v { color: #55064f; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #55064f; color: #fff; font-size: 10.5px; font-weight: 700; text-align: left; padding: 6px 7px; }
  td { padding: 5px 7px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #faf8fa; }
  th.n, td.n { text-align: right; }
  td.dim { color: #999; }
  tfoot td { font-weight: 800; border-top: 2px solid #55064f; border-bottom: none; background: #f3eaf2; }
  .tag { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 10px; font-weight: 700; }
  .tag.new { background: #e3f4ea; color: #146c3a; }
  .tag.revisit { background: #e6eefb; color: #1d4f9c; }
  .tag.renewal { background: #f7ecdc; color: #8a5300; }
  .notes { margin-top: 14px; font-size: 9.8px; color: #555; line-height: 1.5; }
  .notes b { color: #333; }
  .empty { padding: 18px; text-align: center; color: #777; border: 1px dashed #ccc; border-radius: 6px; }
  .sign { display: flex; justify-content: flex-end; margin-top: 34px; }
  .sign div { width: 210px; border-top: 1px solid #555; text-align: center; font-size: 10px; color: #555; padding-top: 4px; }
`;

function letterhead(h: ReportHospital): string {
  return `<div class="lh"><img src="${CREST_PNG_DATA_URI}" alt="">`
    + `<div><div class="nm">${esc(h.name)}</div>`
    + h.addressLines.map((l) => `<div class="ad">${esc(l)}</div>`).join("")
    + `</div></div>`;
}

function title(heading: string, sub: string, date: string, generatedAt: string): string {
  return `<div class="ttl"><div><h1>${esc(heading)}</h1><div class="k">${esc(sub)}</div></div>`
    + `<div class="r">Date: <b class="num">${esc(dayLabel(date))}</b>, ${esc(weekday(date))}`
    + `<div class="num">Generated ${esc(generatedLabel(generatedAt))}</div></div></div>`;
}

function provisionalNote(provisional: boolean, stillOpen: number): string {
  if (!provisional && stillOpen === 0) return "";
  const open = stillOpen === 0 ? "" : ` ${String(stillOpen)} patient${stillOpen === 1 ? " is" : "s are"} still being seen and ${stillOpen === 1 ? "is" : "are"} not counted as consulted yet.`;
  return `<div class="warn"><b>${provisional ? "The day is not over." : "Visits still open."}</b>${open} Figures may change.</div>`;
}

function tile(value: number, label: string, main = false): string {
  return `<div class="tile${main ? " main" : ""}"><div class="v num">${String(value)}</div><div class="l">${esc(label)}</div></div>`;
}

function notes(): string {
  return `<div class="notes">${DEFINITIONS.map((d) => {
    const [head, ...rest] = d.split(" — ");
    return `<div><b>${esc(head)}</b> — ${esc(rest.join(" — "))}</div>`;
  }).join("")}</div>`;
}

function page(docTitle: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(docTitle)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

const cell = (n: number, dim = true): string => `<td class="n num${dim && n === 0 ? " dim" : ""}">${String(n)}</td>`;

function countCells(c: DayReportCounts, showOpen: boolean): string {
  return cell(c.booked) + cell(c.consulted) + cell(c.new) + cell(c.revisit) + cell(c.renewal) + (showOpen ? cell(c.stillOpen) : "");
}

export function fileStem(date: string, department?: { code: string }): string {
  return department === undefined ? `OPD-Day-Report-${date}` : `OPD-Day-Report-${department.code}-${date}`;
}

/** The hospital's day, department by department, on the letterhead. */
export function renderDayReport(r: OpdDayReport): RenderedReport {
  const showOpen = r.totals.stillOpen > 0;
  const rows = r.departments.map((d, i) =>
    `<tr><td class="num">${String(i + 1)}</td><td><b>${esc(d.name)}</b></td>${countCells(d, showOpen)}</tr>`).join("");
  const body = letterhead(r.hospital)
    + title("OPD Day Report", "Department-wise appointments and consultations", r.date, r.generatedAt)
    + provisionalNote(r.provisional, r.totals.stillOpen)
    + `<div class="tiles">${tile(r.totals.consulted, "Consulted", true)}${tile(r.totals.new, "New")}`
    + `${tile(r.totals.revisit, "Revisit")}${tile(r.totals.renewal, "Renewal")}${tile(r.totals.booked, "Appointments booked")}</div>`
    + (r.departments.length === 0
      ? `<div class="empty">No OPD department is set up.</div>`
      : `<table><thead><tr><th style="width:28px">#</th><th>Department</th><th class="n">Booked</th><th class="n">Consulted</th>`
        + `<th class="n">New</th><th class="n">Revisit</th><th class="n">Renewal</th>${showOpen ? `<th class="n">Still open</th>` : ""}</tr></thead>`
        + `<tbody>${rows}</tbody>`
        + `<tfoot><tr><td></td><td>Total</td>${countCells(r.totals, showOpen).replace(/ dim/g, "")}</tr></tfoot></table>`)
    + `<div class="notes"><div><b>${String(r.patientsConsulted)}</b> different patient${r.patientsConsulted === 1 ? " was" : "s were"} consulted; `
    + `<b>${String(r.newPatients)}</b> of them came to the hospital for the first time. A patient seen in two departments is counted in each department's row.</div></div>`
    + notes()
    + `<div class="sign"><div>Checked by (name &amp; signature)</div></div>`;
  const docTitle = fileStem(r.date);
  return { title: docTitle, page: { widthMm: 210, heightMm: 297 }, html: page(docTitle, body) };
}

/** One department's day: the brief, then every patient seen. */
export function renderDepartmentDayReport(r: OpdDepartmentDayReport): RenderedReport {
  const d = r.department;
  const rows = r.rows.map((p, i) => `<tr><td class="num">${String(i + 1)}</td><td class="num">${esc(p.time)}</td>`
    + `<td><b>${esc(p.name)}</b></td><td class="num">${esc(p.uhid)}</td><td class="num">${esc(p.age)}</td><td>${esc(p.gender)}</td>`
    + `<td>${esc(p.shortAddress)}</td><td><span class="tag ${p.patientType}">${PATIENT_TYPE_LABEL[p.patientType]}</span></td>`
    + `<td>${esc(p.doctor)}</td></tr>`).join("");
  const body = letterhead(r.hospital)
    + title(`OPD Day Report — ${d.name}`, "Department brief and patients consulted", r.date, r.generatedAt)
    + provisionalNote(r.provisional, d.stillOpen)
    + `<div class="tiles">${tile(d.consulted, "Consulted", true)}${tile(d.new, "New")}${tile(d.revisit, "Revisit")}`
    + `${tile(d.renewal, "Renewal")}${tile(d.booked, "Booked")}</div>`
    + (r.rows.length === 0
      ? `<div class="empty">No consultation was completed in ${esc(d.name)} on ${esc(dayLabel(r.date))}.</div>`
      : `<table><thead><tr><th style="width:26px">#</th><th>Time</th><th>Patient name</th><th>UHID</th><th>Age</th><th>Sex</th>`
        + `<th>Address</th><th>Type</th><th>Doctor</th></tr></thead><tbody>${rows}</tbody></table>`)
    + notes()
    + `<div class="sign"><div>Checked by (name &amp; signature)</div></div>`;
  const docTitle = fileStem(r.date, d);
  return { title: docTitle, page: { widthMm: 210, heightMm: 297 }, html: page(docTitle, body) };
}

/**
 * A typed name or address that begins with `=`, `+`, `-` or `@` is a FORMULA to Excel. The desk types
 * these fields, so a cell of free text is written with a leading apostrophe when it would otherwise be
 * evaluated — the spreadsheet shows the text and never runs it.
 */
export function sheetText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const countHeader = ["Booked", "Consulted", "New", "Revisit", "Renewal", "Still open"];
const countRow = (c: DayReportCounts): string[] =>
  [c.booked, c.consulted, c.new, c.revisit, c.renewal, c.stillOpen].map(String);

function csvHead(hospital: ReportHospital, heading: string, date: string, provisional: boolean, generatedAt: string): string[][] {
  return [
    [sheetText(hospital.name)],
    ...hospital.addressLines.map((l) => [sheetText(l)]),
    [heading, dayLabel(date)],
    ["Status", provisional ? "Provisional — the day is not over" : "Final"],
    ["Generated", generatedLabel(generatedAt)],
    [],
  ];
}

/** Rows for `toCsv`: the letterhead as a few lines, then one clean table a spreadsheet can sort. */
export function dayReportCsvRows(r: OpdDayReport): string[][] {
  return [
    ...csvHead(r.hospital, "OPD Day Report", r.date, r.provisional, r.generatedAt),
    ["Department", ...countHeader],
    ...r.departments.map((d) => [sheetText(d.name), ...countRow(d)]),
    ["Total", ...countRow(r.totals)],
    [],
    ["Different patients consulted", String(r.patientsConsulted)],
    ["New patients (first time at the hospital)", String(r.newPatients)],
    [],
    ...DEFINITIONS.map((d) => [d]),
  ];
}

export function departmentDayReportCsvRows(r: OpdDepartmentDayReport): string[][] {
  const d = r.department;
  return [
    ...csvHead(r.hospital, sheetText(`OPD Day Report — ${d.name}`), r.date, r.provisional, r.generatedAt),
    countHeader,
    countRow(d),
    [],
    ["#", "Time", "Visit no", "Patient name", "UHID", "Age", "Sex", "Address", "Patient type", "Doctor"],
    ...r.rows.map((p, i) => [
      String(i + 1), p.time, p.visitNo, sheetText(p.name), p.uhid, p.age, p.gender, sheetText(p.shortAddress),
      PATIENT_TYPE_LABEL[p.patientType], sheetText(p.doctor),
    ]),
    [],
    ...DEFINITIONS.map((line) => [line]),
  ];
}
