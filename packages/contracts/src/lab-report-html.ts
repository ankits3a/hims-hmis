import { AST_RESULT_WORD, astName } from "./lab-ast";
import type { AstBlock } from "./lab-ast";

/**
 * OWNER 2026-10-12 — THE PRINTED QUICK LAB REPORT, ONE TEMPLATE FOR THE DESK AND THE PHONE
 * (spec `SPEC-phone-report-pdf-share-2026-10-12.md`). The desk prints this document from a new
 * window (`apps/web/src/screens/lab-quick-reports.tsx`); the phone hands the same document to
 * expo-print and shares the PDF (`apps/mobile/src/lab/report-pdf.ts`). Moved here so the two cannot
 * drift: a test proves the desk's page and the phone's are byte for byte the same.
 *
 * **IMPORTS NOTHING BUT `lab-ast.ts`.** The web and the phone app import this file by relative path,
 * and the phone's CI installs only its own packages: no zod, no DOM, no React, no i18n library. The
 * report prints in English on both (the desk never translated it).
 *
 * **Dates are written by arithmetic, not by `Intl`.** India keeps no daylight saving, so IST is UTC
 * + 5:30 always; the month words are the desk browser's en-GB ones ("Sept" included). A phone's own
 * ICU may spell a month differently, and then the PDF would not be the desk's page.
 */

export type ReportHtmlLine = {
  analyteId: string; nameEn: string; unit: string | null;
  value: string; low: string | null; high: string | null; refText: string | null; flag: string | null;
};
/** What the template reads of a quick report — the server's `GET /lab/quick/ready/:id`, on both clients. */
export type ReportHtmlInput = {
  patient: { uhid: string; display: string; administrativeGender: string; dob: string | null };
  encounterNo: string | null;
  tests: { serviceId: string; code: string; nameEn: string }[];
  collectedAt: string; reportedAt: string | null;
  groups: { title: string | null; analyteIds: string[] }[];
  lines: ReportHtmlLine[];
  summary: string;
  reportedByName: string | null;
  hospital: { name: string; address: string; hotline: string; emergency: string; email: string; website: string };
  visitQrSvg: string | null;
  ast?: AstBlock[];
};
export type ReportHtmlOptions = {
  /** The username in "Printed by …", or null. */
  printedBy: string | null;
  /** Absolute URL of the hospital's logo (`<origin>/print/hospital-logo.png`). */
  logoUrl: string;
  /** The moment of printing: "Printed … on … at …", the age, and "Reported" when the report has no time. */
  now: Date;
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"] as const;
const IST_MS = 330 * 60_000;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const ist = (d: Date): Date => new Date(d.getTime() + IST_MS);

/** `09-Oct-2026` in IST. */
export function istDateOnly(iso: string): string {
  const d = ist(new Date(iso));
  return `${pad2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]!}-${String(d.getUTCFullYear())}`;
}
/** `11:52` in IST, 24-hour. */
export function istHourMinute(d: Date): string {
  const x = ist(d);
  return `${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}`;
}
/** `09-Oct-2026 11:52` in IST — the way an Indian lab report writes a time. */
export function istStamp(iso: string): string {
  return `${istDateOnly(iso)} ${istHourMinute(new Date(iso))}`;
}

/** Whole years from a `YYYY-MM-DD` birth date (the web's `ageYearsFrom`, line for line). */
function ageYears(dob: string | null, now: Date): number | null {
  if (dob === null) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
  return years;
}

function trimNum(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
/** "12 – 15", "≥ 40", "≤ 200", or the range's text (the web's and the phone's `refText`). */
function refRange(low: string | null, high: string | null, text: string | null): string {
  if (low !== null && high !== null) return `${trimNum(low)} – ${trimNum(high)}`;
  if (low !== null) return `≥ ${trimNum(low)}`;
  if (high !== null) return `≤ ${trimNum(high)}`;
  return text ?? "";
}

/** The flag WORD a clinician reads — never a bare letter (`lab-report-print.tsx`'s rule). */
const FLAG_WORD: Record<string, string> = { L: "Low", H: "High", LL: "Critically low", HH: "Critically high", N: "Normal" };
const FLAG_CLASS: Record<string, string> = { L: "ab", H: "ab", LL: "cr", HH: "cr", N: "ok" };

/**
 * The PRINTED antibiotic table: Antibiotic | Result | MIC (µg/mL), the result as a word with its
 * letter, a Resistant row in bold (a photocopy keeps bold, not colour), the MIC column only when a
 * row has one.
 */
export function astPrintHtml(block: AstBlock, title: string): string {
  if (block.rows.length === 0) return "";
  const e = escapeHtml;
  const withMic = block.rows.some((r) => r.mic !== null);
  const rows = block.rows.map((r) => {
    const cell = (s: string): string => (r.result === "R" ? `<b>${s}</b>` : s);
    return `<tr class="ast-${r.result}"><td class="name">${cell(e(astName(r.antibiotic)))}</td><td class="c">${cell(`${e(AST_RESULT_WORD[r.result])} (${r.result})`)}</td>`
      + `${withMic ? `<td class="c">${cell(e(r.mic ?? "—"))}</td>` : ""}</tr>`;
  }).join("");
  return `<section class="test ast">
      <div class="testhead"><h2>Antibiotic sensitivity — ${e(title)}</h2></div>
      <table class="res"><thead><tr><th class="name">Antibiotic</th><th>Result</th>${withMic ? "<th>MIC (µg/mL)</th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table></section>`;
}

/**
 * THE PRINTED QUICK REPORT — laid out from the approved A4 board
 * (`docs/design/2026-08-29-opd-counter-flow/ReportA4.dc.html`), the same board the signed report
 * follows: the hospital's logo and "Laboratory Medicine" beside the identity block, the times on the
 * right, the department rule, one titled table per test with a coloured result cell and a flag WORD,
 * the remarks box, the standing notes, the two signatory lines, and the hospital's address at the foot.
 *
 * The header repeats on every page (`thead`), the page number comes from the `@page` margin box.
 *
 * **Unsigned, and the paper says so by leaving the line to sign.** HMIS holds no pathologist
 * signature for a quick report (decision 0061), so "Authorised by" is a line for a pen, not a name.
 * The result colours are also printed as words, because a photocopy loses colour.
 *
 * A whole document and NO script: the desk adds its own "print on load" line (`withAutoPrint`); the
 * phone's PDF renderer gets the document as it is.
 */
export function quickReportHtml(report: ReportHtmlInput, o: ReportHtmlOptions): string {
  const p = report.patient;
  const h = report.hospital;
  const byId = new Map(report.lines.map((l) => [l.analyteId, l]));
  const age = ageYears(p.dob, o.now);
  const gender = p.administrativeGender === "female" ? "Female" : p.administrativeGender === "male" ? "Male" : "Other";
  const reportedIso = report.reportedAt ?? o.now.toISOString();
  const logo = o.logoUrl;
  const e = escapeHtml;

  /**
   * Owner 2026-10-12 — a culture's antibiotic table prints right after that test's own table; one
   * whose test drew no table of its own (a parameter shared with an earlier test) prints after all.
   */
  const testName = (serviceId: string): string => report.tests.find((x) => x.serviceId === serviceId)?.nameEn ?? "";
  const astPrinted = new Set<string>();
  const astOf = (title: string | null): string => (report.ast ?? []).filter((b) => testName(b.serviceId) === title)
    .map((b) => { astPrinted.add(b.serviceId); return astPrintHtml(b, testName(b.serviceId)); }).join("");
  const tables = report.groups.map((g, i) => {
    const filled = g.analyteIds.map((id) => byId.get(id)).filter((l): l is ReportHtmlLine => l !== undefined);
    if (filled.length === 0) return "";
    const rows = filled.map((l) => {
      const cls = l.flag === null ? "" : FLAG_CLASS[l.flag] ?? "";
      const word = l.flag === null ? "—" : FLAG_WORD[l.flag] ?? "—";
      return `<tr><td class="name">${e(l.nameEn)}</td><td class="val ${cls}">${e(l.value)}</td><td class="c">${e(l.unit ?? "—")}</td>`
        + `<td class="c flag ${cls}">${e(word)}</td><td class="c">${e(refRange(l.low, l.high, l.refText) || "—")}</td></tr>`;
    }).join("");
    return `<section class="test">
      <div class="testhead"><h2>${e(g.title ?? "Other parameters")}</h2>${i === 0 ? `<div class="legend">Colours indicate: <span class="lg ab">Abnormal</span><span class="lg cr">Critical</span><span class="lg ok">Normal</span></div>` : ""}</div>
      <table class="res"><thead><tr><th class="name">Test name</th><th>${e(istDateOnly(reportedIso))}</th><th>Unit</th><th>Flag</th><th>Biological ref. interval</th></tr></thead>
      <tbody>${rows}</tbody></table></section>${astOf(g.title)}`;
  }).join("") + (report.ast ?? []).filter((b) => !astPrinted.has(b.serviceId))
    .map((b) => astPrintHtml(b, testName(b.serviceId))).join("");

  const header = `<div class="hd">
    <div class="brand"><img src="${e(logo)}" alt="" onerror="this.style.display='none'"><div class="dept">Laboratory Medicine</div></div>
    <div class="who">
      <div><span>Name:</span> <b>${e(p.display)}</b></div>
      <div><span>UHID:</span> <b>${e(p.uhid)}</b></div>
      <div><span>Gender:</span> <b>${e(gender)}</b></div>
      <div><span>DOB:</span> <b>${p.dob ? `${e(istDateOnly(`${p.dob}T00:00:00+05:30`))}${age === null ? "" : ` (${String(age)} years)`}` : "—"}</b></div>
      ${report.encounterNo ? `<div><span>Visit No:</span> <b>${e(report.encounterNo)}</b></div>` : ""}
    </div>
    <div class="when">
      <div><span>Collected:</span> <b>${e(istStamp(report.collectedAt))}</b></div>
      <div><span>Reported:</span> <b>${e(istStamp(reportedIso))}</b></div>
      <div><span>Tests:</span> <b>${e(report.tests.map((x) => x.code).join(", "))}</b></div>
    </div>
  </div>
  <div class="rule">Department of Laboratory Medicine</div>`;

  /**
   * THE FOOTER IS THE OPD PRESCRIPTION'S (owner 2026-10-09) — `kernel/printing/render.ts`'s A4 `.ft`:
   * a black rule, one disclaimer line, a grey rule, the address / hotline / emergency / email / red
   * website on the left and the visit number's QR on the right, a grey rule, then "Printed by … on
   * … at …". "Page X of Y" stands at the same baseline from the page's margin box (`@page`), because
   * a page counter cannot be read inside the body.
   */
  const now = o.now.toISOString();
  const footer = `<div class="ft ftfix">
    <div class="frule"></div>
    <div class="dis">This report is computer generated. Values are entered by the laboratory; the pathologist signs above.</div>
    <div class="thin"></div>
    <div class="grid">
      <div class="cols">
        <div class="addr"><span class="lb">Address:</span> <span class="vl">${e(h.name)},</span> ${e(h.address)}</div>
        <div class="line">
          <div><span class="lb">24×7 Hotline:</span> <span class="vl num">${e(h.hotline)}</span></div>
          <div><span class="lb">Emergency:</span> <span class="vl num">${e(h.emergency)}</span></div>
          <div class="sp"></div>
          ${report.visitQrSvg !== null ? `<div><span class="lb">Scan to enter the visit number</span></div>` : ""}
        </div>
        <div class="line">
          <div><span class="lb">Email:</span> <span class="vl">${e(h.email)}</span></div>
          <div><span class="site">${e(h.website)}</span></div>
          <div class="sp"></div>
          ${report.encounterNo !== null ? `<div><span class="lb num">${e(report.encounterNo)}</span></div>` : ""}
        </div>
      </div>
      ${report.visitQrSvg !== null ? `<div class="qr">${report.visitQrSvg}</div>` : ""}
    </div>
    <div class="thin" style="margin-top:6px"></div>
    <div class="by"><span class="num">Printed${o.printedBy ? ` by <strong>${e(o.printedBy)}</strong>` : ""} on ${e(istDateOnly(now))} at ${e(istHourMinute(new Date(now)))}</span></div>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>Lab report ${e(p.uhid)} ${e(istDateOnly(reportedIso))}</title>
<style>
@page { size: A4 portrait; margin: 12mm 12mm 12mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 10.5px Arial, sans-serif; color: #333; vertical-align: top; padding-top: 1mm; } }
* { box-sizing: border-box; }
body { margin: 0; font: 12px/1.45 Arial, Helvetica, sans-serif; color: #111; }
.page { width: 100%; border-collapse: collapse; }
.page > thead > tr > td, .page > tfoot > tr > td, .page > tbody > tr > td { padding: 0 2px 0 0; }
.hd { display: grid; grid-template-columns: 130px 1fr auto; gap: 16px; align-items: start; padding-bottom: 8px; }
.brand img { width: 84px; height: auto; display: block; }
.brand .dept { color: #4a1a7a; font-weight: 700; font-size: 12px; margin-top: 4px; }
.who div, .when div { margin: 1px 0; }
.who span, .when span, .ft span { color: #333; }
.when { text-align: right; }
.rule { border-top: 1px solid #000; border-bottom: 1px solid #000; text-align: center; font-weight: 700; font-size: 13px; padding: 5px 0; margin-bottom: 10px; }
.test { margin: 14px 0 6px; break-inside: avoid-page; }
.testhead { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1px solid #e0a0a0; padding-bottom: 3px; margin-bottom: 8px; }
.testhead h2 { margin: 0; color: #c8102e; font-size: 17px; }
.legend { font-size: 10.5px; color: #333; }
.lg { margin-left: 10px; padding-bottom: 1px; border-bottom: 2px solid; }
.lg.ab { color: #c8102e; } .lg.cr { color: #7a0016; font-weight: 700; } .lg.ok { color: #1a7f4b; }
table.res { width: 100%; border-collapse: collapse; }
table.res th { background: #f0f0f0; font-size: 11px; padding: 7px 8px; border: 1px solid #bbb; }
table.res th.name { text-align: left; }
table.res td { border: 1px solid #bbb; padding: 6px 8px; }
table.res td.c { text-align: center; }
table.res td.val { text-align: center; font-weight: 700; width: 16%; }
td.val.ok { background: #e3f4ea; } td.val.ab { background: #fbe1e4; } td.val.cr { background: #f3b6be; }
td.flag.ok { color: #1a7f4b; font-weight: 700; } td.flag.ab { color: #c8102e; font-weight: 700; } td.flag.cr { color: #7a0016; font-weight: 800; text-transform: uppercase; font-size: 11px; }
.remarks { border: 1px solid #bbb; padding: 8px 10px; margin: 14px 0; white-space: pre-wrap; break-inside: avoid; }
.remarks b { display: block; margin-bottom: 2px; }
.notes { margin: 12px 0 0; break-inside: avoid; } .notes b { font-size: 12.5px; } .notes ol { margin: 4px 0 0; padding-left: 20px; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 60px; margin: 46px 40px 10px; text-align: center; break-inside: avoid; }
.sign .ln { border-top: 1px solid #777; padding-top: 4px; color: #333; }
.sign .nm { font-weight: 700; font-size: 13px; min-height: 18px; }
.sign .rl { color: #555; font-size: 10.5px; }
.cg { border-top: 1px solid #000; margin-top: 6px; padding-top: 4px; font-size: 10.5px; }
.ft { padding-top: 12px; }
.ft .frule { height: 1px; background: #000; } .ft .thin { height: 1px; background: #9a9a9a; }
.ft .dis { font-size: 10.5px; padding: 4px 0 5px; }
.ft .grid { display: flex; gap: 14px; padding-top: 6px; }
.ft .cols { flex-grow: 1; display: flex; flex-direction: column; gap: 3px; }
.ft .line { display: flex; gap: 22px; }
.ft .line > div, .ft .addr { font-size: 11.5px; white-space: nowrap; }
.ft .sp { flex-grow: 1; }
.ft .lb { color: #333; font-weight: 400; } .ft .vl { color: #000; font-weight: 700; }
.ft .num { font-variant-numeric: tabular-nums; }
.ft .site { font-weight: 700; color: #d92230; }
.ft .qr { width: 62px; height: 62px; flex-shrink: 0; } .ft .qr svg { display: block; }
.ft .by { display: flex; align-items: baseline; padding-top: 4px; font-size: 10.5px; color: #333; }
/* Owner 2026-10-11 — the footer stands at the FOOT of every page, not after the last line of results.
   Printed, a fixed box repeats at the bottom of each page's area; the empty tfoot row (as tall as the
   footer) repeats too, so results never run under it. On screen the sheet holds it at its own foot. */
.ftsp { height: 38mm; }
.ftfix { background: #fff; }
@media print { .ftfix { position: fixed; left: 0; right: 0; bottom: 0; } }
@media screen { body { background: #e9e9e9; } .sheet { position: relative; background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 12mm; box-shadow: 0 1px 6px rgba(0,0,0,.2); }
  .ftfix { position: absolute; left: 12mm; right: 12mm; bottom: 12mm; } }
</style></head><body><div class="sheet">
<table class="page">
<thead><tr><td>${header}</td></tr></thead>
<tfoot><tr><td><div class="ftsp"></div></td></tr></tfoot>
<tbody><tr><td>
${tables}
${report.summary.trim() !== "" ? `<div class="remarks"><b>Remarks</b>${e(report.summary)}</div>` : ""}
<div class="notes"><b>Please note</b><ol>
<li>Test results are to be clinically correlated.</li>
<li>An abnormal value should be confirmed before any change of treatment.</li>
<li>Results relate only to the sample tested.</li>
<li>Results are not valid for medico-legal purposes.</li>
</ol></div>
<div class="sign">
  <div><div class="nm">${e(report.reportedByName ?? "")}</div><div class="ln">Performed by</div><div class="rl">Laboratory Technologist</div></div>
  <div><div class="nm"></div><div class="ln">Authorised by</div><div class="rl">Pathologist — signature and seal</div></div>
</div>
</td></tr></tbody>
</table>
${footer}</div>
</body></html>`;
}

/** The desk's one addition: print as soon as the window has loaded. Never in the phone's PDF. */
export const AUTO_PRINT_SCRIPT = "<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>";

export function withAutoPrint(html: string): string {
  return html.replace(/<\/body><\/html>$/, `${AUTO_PRINT_SCRIPT}</body></html>`);
}
