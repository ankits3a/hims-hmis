import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { labErrorText } from "../lib/lab-api";
import { quickReportsForPatient, refText } from "../lib/lab-quick-api";
import { useAuth } from "../lib/auth";
import { AstPreview } from "./lab-ast";
import { istStamp, quickReportHtml, withAutoPrint } from "../../../../packages/contracts/src/lab-report-html";
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

const abnormal = (l: QuickLine): boolean => l.flag !== null && l.flag !== "N";

/** `09-Oct-2026 11:52` in IST — the way an Indian lab report writes a time (the shared report template's). */
export { istStamp };

/**
 * THE PRINTED QUICK REPORT — the template is `packages/contracts/src/lab-report-html.ts`, shared with
 * the phone's Share PDF (owner 2026-10-12) so the desk's page and the phone's PDF cannot drift. It is
 * a document of its own (a new window), so a quick report prints from any screen that shows it; the
 * desk adds only the line that opens the print dialog once the page has loaded.
 */
export function printQuickReport(report: QuickReport, printedBy: string | null): void {
  const html = withAutoPrint(quickReportHtml(report, {
    printedBy, logoUrl: `${window.location.origin}/print/hospital-logo.png`, now: new Date(),
  }));
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
      {open && (report.ast ?? []).map((b) => (
        <div key={b.serviceId} className="mt-2"><AstPreview block={b} title={report.tests.find((x) => x.serviceId === b.serviceId)?.nameEn ?? ""} /></div>
      ))}
      {open && compact && report.summary.trim() !== "" && <p className="mt-1 whitespace-pre-wrap text-sm">{report.summary}</p>}
    </li>
  );
}

/**
 * The block. `compact` (the doctor's brief) shows the out-of-range values and hides the summary
 * until opened; `onOpen` (the lab) adds "Open to edit". Renders nothing at all when the reader may
 * not ask (`enabled` false) and, in compact or `hideEmpty` mode, when there is nothing to show.
 */
export function QuickLabReports({ patientId, enabled = true, compact = false, hideEmpty = false, onOpen, via = "results", exclude }: {
  patientId: string; enabled?: boolean; compact?: boolean; hideEmpty?: boolean; onOpen?: (id: string) => void;
  /** Owner 2026-10-11 — visit numbers whose reports open from the visit row instead (the profile's lab visits). */
  exclude?: ReadonlySet<string>;
  /** Owner 2026-10-11 — `print`: the lab counter's grant reads them for the profile (`/printable`). */
  via?: "results" | "print";
}): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["lab-quick", "patient", patientId, via],
    queryFn: () => quickReportsForPatient(patientId, via),
    enabled: enabled && patientId !== "",
    retry: false,
  });
  if (!enabled) return null;
  const items = (q.data?.items ?? []).filter((r) => exclude === undefined || r.encounterNo === null || !exclude.has(r.encounterNo));
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
