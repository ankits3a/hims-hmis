import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiDownload } from "../lib/api";
import type { CopilotDayReport } from "../lib/copilot-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DAY REPORT, HANDED OVER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17: *"If the user ask to generate the day report, it should do it and give it to
 * the user."* The word that does the work is GIVE. The server composes the report and the copilot
 * announces it; this is the part where the clerk actually receives it.
 *
 * ═══ EVERY CELL IS ALREADY A STRING, AND THAT IS NOT LAZINESS ═══
 *
 * `ReportSection` carries `rows: string[][]` because, in `kernel/desk/types.ts`'s own words, *"the
 * CSV is strings, the printed slip is strings, and the screen renders strings"* — formatting money
 * or a duration in three places is three places to round it differently. So this component does no
 * arithmetic and no formatting whatever. It is a renderer, and if a number looks wrong here it is
 * wrong in the CSV and on the printed slip too, which is the property that was wanted.
 *
 * ═══ THE DOWNLOAD IS THE SAME ROUTE `/my-day` ALREADY USES ═══
 *
 * `GET /me/report.csv` appends its own `report.exported` event BEFORE returning bytes, so a file
 * leaving the building stays an act with a name and a time on it whether a clerk pressed the button
 * on `/my-day` or asked the copilot for it here. Reusing the route rather than serialising these
 * rows in the browser is what keeps that true.
 */
export function CopilotReport(
  { report, onDismiss }: { report: CopilotDayReport; onDismiss: () => void },
): React.ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div data-testid="copilot-report" style={{ borderTop: "1px solid #24413631", paddingTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <span className="tag" style={{ color: "var(--mint)" }}>
          {t("copilot.report.title", { date: report.date })}
        </span>
        {report.provisional ? (
          /*
            PROVISIONAL IS THE SERVER'S FLAG, carried through rather than re-derived — the screen,
            the print and the CSV are three renderings of one model and a flag computed in each is
            three chances for them to disagree. A clerk who files a provisional report as final has
            been misled by the screen, not by the data.
          */
          <span className="stamp un" data-testid="copilot-report-provisional">
            {t("copilot.report.provisional")}
          </span>
        ) : null}
        <span style={{ flexGrow: 1 }} />
        <button
          type="button"
          className="sec"
          data-testid="copilot-report-csv"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailed(false);
            apiDownload(`/me/report.csv?date=${report.date}`, `my-day-${report.date}.csv`)
              .catch(() => { setFailed(true); })
              .finally(() => { setBusy(false); });
          }}
        >
          {t("copilot.report.download")}
        </button>
        <button type="button" className="sec" data-testid="copilot-report-dismiss" onClick={onDismiss}>
          {t("copilot.report.dismiss")}
        </button>
      </div>

      {failed ? (
        <div style={{ fontSize: 11.5, color: "#ff9d94", marginBottom: 8 }}>{t("copilot.report.downloadFailed")}</div>
      ) : null}

      {report.sections.map((section) => (
        <div key={section.key} style={{ marginBottom: 14 }}>
          <div className="tag" style={{ color: "var(--agent-dim)", marginBottom: 6 }}>{t(section.titleKey)}</div>
          {/*
            A TABLE IN ITS OWN SCROLLER. A report section is as wide as its widest column and this
            bar is as wide as the screen; without this the dock pushes the whole page sideways.
          */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>
              <thead>
                <tr>
                  {section.columnKeys.map((col) => (
                    <th key={col} style={{ textAlign: "left", padding: "3px 10px 3px 0", color: "var(--agent-dim)", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {t(col)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(section.columnKeys.length, 1)} style={{ padding: "3px 0", color: "var(--agent-dim)" }}>
                      {t("copilot.report.emptySection")}
                    </td>
                  </tr>
                ) : section.rows.map((row, i) => (
                  <tr key={`${section.key}-${String(i)}`}>
                    {row.map((cell, j) => (
                      <td key={`${section.key}-${String(i)}-${String(j)}`} style={{ padding: "3px 10px 3px 0", whiteSpace: "nowrap" }}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {section.totals === undefined ? null : (
                <tfoot>
                  <tr>
                    {section.totals.map((cell, j) => (
                      <td key={`${section.key}-total-${String(j)}`} style={{ padding: "5px 10px 3px 0", fontWeight: 700, borderTop: "1px solid #24413631", whiteSpace: "nowrap" }}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
