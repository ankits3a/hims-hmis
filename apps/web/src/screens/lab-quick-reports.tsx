import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { labErrorText } from "../lib/lab-api";
import { quickReportsForPatient, refText } from "../lib/lab-quick-api";
import { ageYearsFrom } from "./lab-seat";
import { useAuth } from "../lib/auth";
import type { QuickLine, QuickReport } from "../lib/lab-quick-api";

/**
 * QUICK MODE (decision 0061) — a patient's saved quick reports, wherever someone needs them: the
 * lab's own "Saved reports", the patient profile, and the doctor's consult brief. One block, so the
 * three never disagree about what a quick report says.
 *
 * **Every row says "not signed".** A quick report has no pathologist signature (the owner signs in
 * other software for now), and the signed-results readers deliberately hold unsigned numbers back.
 * These are shown beside them, never mixed into them.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const abnormal = (l: QuickLine): boolean => l.flag !== null && l.flag !== "N";

const IST_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

/** `09-Oct-2026 11:52` in IST — the way an Indian lab report writes a time. */
export function istStamp(iso: string): string {
  const d = new Date(iso);
  return `${IST_DATE.format(d).replace(/ /g, "-")} ${IST_TIME.format(d)}`;
}

function istDateOnly(iso: string): string {
  return IST_DATE.format(new Date(iso)).replace(/ /g, "-");
}

/** The flag WORD a clinician reads — never a bare letter (`lab-report-print.tsx`'s rule). */
const FLAG_WORD: Record<string, string> = { L: "Low", H: "High", LL: "Critically low", HH: "Critically high", N: "Normal" };
const FLAG_CLASS: Record<string, string> = { L: "ab", H: "ab", LL: "cr", HH: "cr", N: "ok" };

/**
 * THE PRINTED QUICK REPORT — laid out from the approved A4 board
 * (`docs/design/2026-08-29-opd-counter-flow/ReportA4.dc.html`), the same board the signed report
 * follows: the hospital's logo and "Laboratory Medicine" beside the identity block, the times on the
 * right, the department rule, one titled table per test with a coloured result cell and a flag WORD,
 * the remarks box, the standing notes, the two signatory lines, and the hospital's address at the foot.
 *
 * It is a document of its own (a new window), so a quick report prints from any screen that shows it.
 * The header and the address repeat on every page (`thead`/`tfoot`), and the page number comes from
 * the browser's `@page` margin box.
 *
 * **Unsigned, and the paper says so by leaving the line to sign.** HMIS holds no pathologist
 * signature for a quick report (decision 0061), so "Authorised by" is a line for a pen, not a name.
 * The result colours are also printed as words, because a photocopy loses colour.
 */
export function printQuickReport(report: QuickReport, printedBy: string | null): void {
  const p = report.patient;
  const h = report.hospital;
  const byId = new Map(report.lines.map((l) => [l.analyteId, l]));
  const age = ageYearsFrom(p.dob);
  const gender = p.administrativeGender === "female" ? "Female" : p.administrativeGender === "male" ? "Male" : "Other";
  const reportedIso = report.reportedAt ?? new Date().toISOString();
  const logo = `${window.location.origin}/print/hospital-logo.png`;
  const e = escapeHtml;

  const tables = report.groups.map((g, i) => {
    const filled = g.analyteIds.map((id) => byId.get(id)).filter((l): l is QuickLine => l !== undefined);
    if (filled.length === 0) return "";
    const rows = filled.map((l) => {
      const cls = l.flag === null ? "" : FLAG_CLASS[l.flag] ?? "";
      const word = l.flag === null ? "—" : FLAG_WORD[l.flag] ?? "—";
      return `<tr><td class="name">${e(l.nameEn)}</td><td class="val ${cls}">${e(l.value)}</td><td class="c">${e(l.unit ?? "—")}</td>`
        + `<td class="c flag ${cls}">${e(word)}</td><td class="c">${e(refText({ low: l.low, high: l.high, text: l.refText }) || "—")}</td></tr>`;
    }).join("");
    return `<section class="test">
      <div class="testhead"><h2>${e(g.title ?? "Other parameters")}</h2>${i === 0 ? `<div class="legend">Colours indicate: <span class="lg ab">Abnormal</span><span class="lg cr">Critical</span><span class="lg ok">Normal</span></div>` : ""}</div>
      <table class="res"><thead><tr><th class="name">Test name</th><th>${e(istDateOnly(reportedIso))}</th><th>Unit</th><th>Flag</th><th>Biological ref. interval</th></tr></thead>
      <tbody>${rows}</tbody></table></section>`;
  }).join("");

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
  const now = new Date().toISOString();
  const footer = `<div class="ft">
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
    <div class="by"><span class="num">Printed${printedBy ? ` by <strong>${e(printedBy)}</strong>` : ""} on ${e(istDateOnly(now))} at ${e(IST_TIME.format(new Date(now)))}</span></div>
  </div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lab report ${e(p.uhid)} ${e(istDateOnly(reportedIso))}</title>
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
@media screen { body { background: #e9e9e9; } .sheet { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 12mm; box-shadow: 0 1px 6px rgba(0,0,0,.2); } }
</style></head><body><div class="sheet">
<table class="page">
<thead><tr><td>${header}</td></tr></thead>
<tfoot><tr><td>${footer}</td></tr></tfoot>
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
</table></div>
<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>`;
  const w = window.open("", "_blank");
  if (w === null) return;
  w.document.write(html);
  w.document.close();
}

function ReportCard({ report, compact, onOpen }: { report: QuickReport; compact: boolean; onOpen?: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const [open, setOpen] = useState(false);
  const flagged = report.lines.filter(abnormal);
  const byId = new Map(report.lines.map((l) => [l.analyteId, l]));
  return (
    <li className="rounded border p-2" data-testid={`quick-report-${report.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold">{report.tests.map((x) => x.nameEn).join(", ")}</span>
        <span className="text-xs text-muted-foreground">{fmtIst(report.reportedAt ?? report.collectedAt)}</span>
        <span className="rounded border px-1 text-xs text-muted-foreground">{t("lab.quick.notSigned")}</span>
      </div>
      {flagged.length > 0 ? (
        <ul className="mt-1 text-sm">
          {flagged.map((l) => (
            <li key={l.analyteId} className="font-semibold text-red-800 dark:text-red-300">
              {l.nameEn}: {l.value}{l.unit ? ` ${l.unit}` : ""} {l.flag}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{t("lab.quick.allNormal")}</p>
      )}
      {!compact && report.summary.trim() !== "" && <p className="mt-1 whitespace-pre-wrap text-sm">{report.summary}</p>}
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        <button type="button" className="underline" onClick={() => setOpen((x) => !x)}>
          {open ? t("lab.quick.hideValues") : t("lab.quick.showValues")}
        </button>
        <button type="button" className="underline" onClick={() => printQuickReport(report, username)}>{t("lab.quick.print")}</button>
        {onOpen && <button type="button" className="underline" onClick={() => onOpen(report.id)}>{t("lab.quick.openToEdit")}</button>}
      </div>
      {open && (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {report.groups.map((g) => {
              const filled = g.analyteIds.map((id) => byId.get(id)).filter((l): l is QuickLine => l !== undefined);
              if (filled.length === 0) return null;
              return [
                <tr key={`g-${g.title ?? "other"}`}><th colSpan={3} className="pt-2 text-left">{g.title ?? t("lab.quick.otherParams")}</th></tr>,
                ...filled.map((l) => (
                  <tr key={l.analyteId} className="border-b">
                    <td className="py-0.5 pr-2">{l.nameEn}</td>
                    <td className={`py-0.5 pr-2 ${abnormal(l) ? "font-bold text-red-800 dark:text-red-300" : ""}`}>
                      {l.value}{l.unit ? ` ${l.unit}` : ""} {abnormal(l) ? l.flag : ""}
                    </td>
                    <td className="py-0.5 text-muted-foreground">{refText({ low: l.low, high: l.high, text: l.refText })}</td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      )}
      {open && compact && report.summary.trim() !== "" && <p className="mt-1 whitespace-pre-wrap text-sm">{report.summary}</p>}
    </li>
  );
}

/**
 * The block. `compact` (the doctor's brief) shows the out-of-range values and hides the summary
 * until opened; `onOpen` (the lab) adds "Open to edit". Renders nothing at all when the reader may
 * not ask (`enabled` false) and, in compact or `hideEmpty` mode, when there is nothing to show.
 */
export function QuickLabReports({ patientId, enabled = true, compact = false, hideEmpty = false, onOpen }: {
  patientId: string; enabled?: boolean; compact?: boolean; hideEmpty?: boolean; onOpen?: (id: string) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["lab-quick", "patient", patientId],
    queryFn: () => quickReportsForPatient(patientId),
    enabled: enabled && patientId !== "",
    retry: false,
  });
  if (!enabled) return null;
  const items = q.data?.items ?? [];
  if ((compact || hideEmpty) && items.length === 0) return null;
  return (
    <section data-testid="quick-lab-reports" aria-label={t("lab.quick.savedTitle")}>
      <h3 className="mb-1 text-sm font-semibold">{t("lab.quick.savedTitle")}</h3>
      {q.isError && <p role="alert" className="text-sm">{labErrorText(q.error)}</p>}
      {q.isSuccess && items.length === 0 && <p className="text-sm text-muted-foreground">{t("lab.quick.noSaved")}</p>}
      <ul className="space-y-2">
        {(compact ? items.slice(0, 3) : items).map((r) => <ReportCard key={r.id} report={r} compact={compact} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}
