import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { labErrorText } from "../lib/lab-api";
import { quickReportsForPatient, refText } from "../lib/lab-quick-api";
import { sexAge } from "./lab-seat";
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

/** A plain A4 page in a new window, grouped under each test. Labels are English: the hospital's document. */
export function printQuickReport(report: QuickReport): void {
  const p = report.patient;
  const byId = new Map(report.lines.map((l) => [l.analyteId, l]));
  const line = (l: QuickLine): string => `<tr${abnormal(l) ? ' class="ab"' : ""}><td>${escapeHtml(l.nameEn)}</td>`
    + `<td><b>${escapeHtml(l.value)}</b> ${abnormal(l) ? escapeHtml(l.flag!) : ""}</td><td>${escapeHtml(l.unit ?? "")}</td>`
    + `<td>${escapeHtml(refText({ low: l.low, high: l.high, text: l.refText }))}</td></tr>`;
  const rows = report.groups.map((g) => {
    const filled = g.analyteIds.map((id) => byId.get(id)).filter((l): l is QuickLine => l !== undefined);
    if (filled.length === 0) return "";
    return `<tr class="grp"><td colspan="4">${escapeHtml(g.title ?? "Other")}</td></tr>${filled.map(line).join("")}`;
  }).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lab report ${escapeHtml(p.uhid)}</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#000}h1{font-size:18px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}
tr.ab td{font-weight:600}tr.grp td{font-weight:700;padding-top:14px;border-bottom:2px solid #000}
.sum{white-space:pre-wrap;border:1px solid #999;padding:8px}.meta{color:#333;line-height:1.5}</style></head><body>
<h1>Laboratory report</h1>
<div class="meta">${escapeHtml(p.display)} · ${escapeHtml(p.uhid)} · ${escapeHtml(sexAge(p.administrativeGender, p.dob))}${report.encounterNo ? ` · Visit ${escapeHtml(report.encounterNo)}` : ""}<br>
Tests: ${escapeHtml(report.tests.map((x) => x.nameEn).join(", "))}<br>
Sample collected: ${escapeHtml(fmtIst(report.collectedAt))} · Reported: ${escapeHtml(fmtIst(report.reportedAt ?? new Date().toISOString()))}</div>
<table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference range</th></tr></thead><tbody>${rows}</tbody></table>
${report.summary.trim() !== "" ? `<h3>Remarks</h3><div class="sum">${escapeHtml(report.summary)}</div>` : ""}
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open("", "_blank");
  if (w === null) return;
  w.document.write(html);
  w.document.close();
}

function ReportCard({ report, compact, onOpen }: { report: QuickReport; compact: boolean; onOpen?: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
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
        <button type="button" className="underline" onClick={() => printQuickReport(report)}>{t("lab.quick.print")}</button>
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
