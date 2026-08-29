import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { downloadReportCsv, fetchReport, todayIst } from "../lib/desk-api";
import type { WireReportSection } from "../lib/desk-api";
import { useAuth } from "../lib/auth";
import { Button } from "@/components/ui/button";

/**
 * PLAN 07c T2/T3/T5 — MY DAY: ONE MODEL, RENDERED THREE WAYS.
 *
 * The screen below, the `.print-doc` it prints, and the CSV the button downloads are the SAME
 * server-computed `DailyReport` (DD5). That is the whole reason the model is a list of sections of
 * string rows rather than three shaped payloads: screen, paper and spreadsheet cannot disagree
 * about a number, because there is one number. A second query for the file — the obvious, faster
 * thing to write — would let the paper in the ward file and the CSV in the accountant's inbox drift
 * apart while both looked authoritative.
 *
 * ═══ THERE IS NO `userId` ON THIS SCREEN, AND THERE IS NONE ON THE ROUTE (DD4) ═══
 *
 * `GET /me/report` takes a date and nothing else. Self-scoping is structural rather than a check
 * somebody can forget: there is no parameter to tamper with, so there is no version of this screen
 * that reads a colleague's day. A supervisor's view of a named staff member is a different route
 * behind a different permission (T9), not an argument added here.
 *
 * ═══ PRINT IS NOT THE AFTERTHOUGHT ═══
 *
 * A shift report is printed, signed and filed — that is what "close" means at an Indian hospital
 * counter, and the signature line is part of the document rather than a nicety. `.print-doc` is
 * `position: fixed` at the origin, so exactly ONE printable node may exist on a screen at a time
 * (07a/07b finding: two of them OVERPRINT rather than making two pages). This screen therefore has
 * one printable node containing every section, never one per section.
 */
function SectionTable({ section }: { section: WireReportSection }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold">{t(section.titleKey)}</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            {section.columnKeys.map((c) => (
              <th key={c} className="py-1 pr-3 font-medium text-muted-foreground">{t(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.length === 0 ? (
            /* E-4 — a day before this person existed, or a day they did nothing, is ZEROES. */
            <tr>
              <td className="py-2 text-muted-foreground" colSpan={section.columnKeys.length}>
                {t("myDay.noRows")}
              </td>
            </tr>
          ) : (
            section.rows.map((row, i) => (
              <tr key={`${section.key}-${String(i)}`} className="border-b last:border-b-0">
                {row.map((cell, j) => (
                  <td key={`${section.key}-${String(i)}-${String(j)}`} className="py-1 pr-3 tabular-nums">{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {section.totals === undefined ? null : (
          <tfoot>
            <tr className="border-t font-semibold">
              {section.totals.map((cell, j) => (
                <td key={`${section.key}-total-${String(j)}`} className="py-1 pr-3 tabular-nums">{cell}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function MyDay(): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const [date, setDate] = useState(todayIst());
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const report = useQuery({ queryKey: ["me", "report", date], queryFn: () => fetchReport(date) });

  const sections = report.data?.sections ?? [];
  const provisional = report.data?.provisional ?? false;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <div className="no-print flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">{t("myDay.title")}</h1>
        <label className="text-sm">
          <span className="sr-only">{t("myDay.date")}</span>
          <input
            type="date"
            className="rounded border px-2 py-1"
            value={date}
            aria-label={t("myDay.date")}
            onChange={(e) => { setDate(e.target.value); }}
          />
        </label>
        {/*
          E-5 / T2 A4 — the day is not closed, and the document says so on the screen AND on the
          paper. The flag comes from the server so that the file, the print and this line cannot
          disagree about whether what is being filed is the close.
        */}
        {provisional ? (
          <span className="rounded border border-state-waiting px-2 py-0.5 text-xs text-state-waiting">
            {t("myDay.provisional")}
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => { window.print(); }}>{t("myDay.print")}</Button>
          <Button
            disabled={downloading}
            onClick={() => {
              setError(null);
              setDownloading(true);
              downloadReportCsv(date)
                .catch(() => { setError(t("myDay.exportFailed")); })
                .finally(() => { setDownloading(false); });
            }}
          >
            {t("myDay.export")}
          </Button>
        </div>
      </div>
      {error === null ? null : <p className="no-print text-sm text-destructive">{error}</p>}

      {report.isPending ? <p className="text-sm text-muted-foreground">{t("app.loading")}</p> : null}

      {/*
        ONE printable node holding every section — see the header. It is also the SCREEN rendering:
        a second copy for the screen would be the two-source failure this whole model exists to
        prevent, one level down.
      */}
      <div className="print-doc flex flex-col gap-4">
        <div className="flex flex-col gap-0.5 border-b pb-2">
          <span className="text-base font-semibold">{t("myDay.docTitle")}</span>
          <span className="text-sm">{t("myDay.docFor", { date })}</span>
          <span className="text-sm">{actor === null ? "" : actor.id}</span>
          {provisional ? <span className="text-sm">{t("myDay.provisionalNote")}</span> : null}
        </div>

        {!report.isPending && sections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("myDay.empty")}</p>
        ) : null}

        {sections.map((s) => (
          <SectionTable key={s.key} section={s} />
        ))}

        {/*
          THE SIGNATURE LINE IS PART OF THE DOCUMENT. A shift report that is printed and filed is
          signed by the person whose day it is and countersigned by whoever received the handover;
          a printout with nowhere to sign gets a line drawn on it in biro, which is the same
          document with worse provenance.
        */}
        <div className="mt-8 flex gap-12 text-sm">
          <div className="flex-1 border-t pt-1">{t("myDay.signedBy")}</div>
          <div className="flex-1 border-t pt-1">{t("myDay.receivedBy")}</div>
        </div>
      </div>
    </div>
  );
}
