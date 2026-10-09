import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { labErrorText } from "../lib/lab-api";
import {
  draftSummary, previewFlag, quickCatalogue, quickRanges, quickReports, refText, saveQuickReport,
} from "../lib/lab-quick-api";
import { PatientPicker } from "../components/patient-picker";
import { Button } from "@/components/ui/button";
import { LabStation, sexAge } from "./lab-seat";
import type { PatientPickerHit } from "../components/patient-picker";
import type { QuickAnalyte, QuickFlag, QuickLine, QuickRange, QuickReport } from "../lib/lab-quick-api";

/**
 * QUICK ENTRY (owner 2026-10-09, decision 0061) — search the patient, add tests or single
 * parameters, type the values, and the screen colours each one against the patient's range and
 * drafts a short summary the technologist may edit. Save keeps it; Print hands it over.
 *
 * No order, no bill, no token, no pathologist signature: the owner runs those in other software
 * for now. The colours are a preview; the server resolves the range and flag again on save.
 */

type Row = { analyteId: string; value: string };

const FLAG_CLASS: Record<string, string> = {
  L: "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  H: "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  LL: "border-red-700 bg-red-200 font-bold text-red-950 dark:bg-red-900 dark:text-white",
  HH: "border-red-700 bg-red-200 font-bold text-red-950 dark:bg-red-900 dark:text-white",
};

function flagLabel(t: (k: string) => string, f: QuickFlag): string {
  if (f === null) return "";
  return t(`lab.quick.flag_${f}`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A plain A4 page in a new window. Labels are English: the report is the hospital's document. */
function printReport(patient: PatientPickerHit, report: QuickReport): void {
  const rows = report.lines.map((l) => `<tr${l.flag && l.flag !== "N" ? ' class="ab"' : ""}><td>${escapeHtml(l.nameEn)}</td>`
    + `<td><b>${escapeHtml(l.value)}</b> ${l.flag && l.flag !== "N" ? escapeHtml(l.flag) : ""}</td><td>${escapeHtml(l.unit ?? "")}</td>`
    + `<td>${escapeHtml(refText({ low: l.low, high: l.high, text: l.refText }))}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lab report ${escapeHtml(patient.uhid)}</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#000}h1{font-size:18px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}
tr.ab td{font-weight:600}.sum{white-space:pre-wrap;border:1px solid #999;padding:8px}.meta{color:#333}</style></head><body>
<h1>Laboratory report</h1>
<div class="meta">${escapeHtml(patient.name ?? "")} · ${escapeHtml(patient.uhid)} · ${escapeHtml(sexAge(patient.administrativeGender, patient.dob))}<br>
Date: ${escapeHtml(fmtIst(report.updatedAt))}</div>
<table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Reference range</th></tr></thead><tbody>${rows}</tbody></table>
${report.summary.trim() !== "" ? `<h3>Remarks</h3><div class="sum">${escapeHtml(report.summary)}</div>` : ""}
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open("", "_blank");
  if (w === null) return;
  w.document.write(html);
  w.document.close();
}

export function LabQuick(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [patient, setPatient] = useState<PatientPickerHit | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState("");
  const [summaryEdited, setSummaryEdited] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [saved, setSaved] = useState<QuickReport | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const catalogue = useQuery({ queryKey: ["lab-quick", "catalogue"], queryFn: quickCatalogue, staleTime: 10 * 60_000 });
  const analyteById = useMemo(
    () => new Map((catalogue.data?.analytes ?? []).map((a) => [a.analyteId, a])),
    [catalogue.data],
  );

  const ids = rows.map((r) => r.analyteId);
  const sortedIds = [...ids].sort().join(",");
  const ranges = useQuery({
    queryKey: ["lab-quick", "ranges", patient?.id, sortedIds],
    queryFn: () => quickRanges(patient!.id, ids),
    enabled: patient !== null && ids.length > 0,
  });
  const rangeById = useMemo(
    () => new Map<string, QuickRange>((ranges.data?.items ?? []).map((r) => [r.analyteId, r])),
    [ranges.data],
  );

  const history = useQuery({
    queryKey: ["lab-quick", "reports", patient?.id],
    queryFn: () => quickReports(patient!.id),
    enabled: patient !== null,
  });

  const previewLines: QuickLine[] = rows.flatMap((r) => {
    const a = analyteById.get(r.analyteId);
    if (!a) return [];
    const range = rangeById.get(r.analyteId);
    return [{
      analyteId: a.analyteId, code: a.code, nameEn: a.nameEn, unit: a.unit, value: r.value,
      low: range?.low ?? null, high: range?.high ?? null, refText: range?.text ?? null,
      flag: a.resultType === "numeric" || a.resultType === "formula" ? previewFlag(r.value, range) : null,
    }];
  });
  const draft = draftSummary(previewLines);
  const shownSummary = summaryEdited ? summary : draft;

  const save = useMutation({
    mutationFn: () => saveQuickReport({
      patientId: patient!.id,
      lines: rows.filter((r) => r.value.trim() !== ""),
      summary: shownSummary,
    }, reportId),
    onSuccess: (r) => {
      setReportId(r.id);
      setSaved(r);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["lab-quick", "reports", r.patientId] });
    },
    onError: (e) => setError(labErrorText(e)),
  });

  function reset(): void {
    setRows([]); setSummary(""); setSummaryEdited(false); setReportId(null); setSaved(null); setError(null); setSearch("");
  }

  function pickPatient(hit: PatientPickerHit): void {
    reset();
    setPatient(hit);
  }

  function addAnalytes(analyteIds: readonly string[]): void {
    setRows((prev) => {
      const have = new Set(prev.map((r) => r.analyteId));
      const added = analyteIds.filter((id) => !have.has(id)).map((analyteId) => ({ analyteId, value: "" }));
      if (added.length > 0) {
        setTimeout(() => inputs.current.get(added[0]!.analyteId)?.focus(), 0);
      }
      return [...prev, ...added];
    });
    setSaved(null);
    setSearch("");
  }

  function openReport(r: QuickReport): void {
    setRows(r.lines.map((l) => ({ analyteId: l.analyteId, value: l.value })));
    setSummary(r.summary);
    setSummaryEdited(true);
    setReportId(r.id);
    setSaved(r);
    setError(null);
  }

  const q = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (q === "" || !catalogue.data) return { tests: [], analytes: [] as QuickAnalyte[] };
    const hit = (code: string, name: string): boolean => code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    return {
      tests: catalogue.data.tests.filter((x) => x.analyteIds.length > 0 && hit(x.code, x.nameEn)).slice(0, 8),
      analytes: catalogue.data.analytes.filter((x) => hit(x.code, x.nameEn)).slice(0, 8),
    };
  }, [q, catalogue.data]);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const test = matches.tests[0];
    if (test) addAnalytes(test.analyteIds);
    else if (matches.analytes[0]) addAnalytes([matches.analytes[0].analyteId]);
  }

  function onValueKey(e: React.KeyboardEvent<HTMLInputElement>, index: number): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const next = rows[index + 1];
    if (next) inputs.current.get(next.analyteId)?.focus();
    else document.getElementById("lab-quick-summary")?.focus();
  }

  const filledCount = rows.filter((r) => r.value.trim() !== "").length;
  const abnormalCount = previewLines.filter((l) => l.flag !== null && l.flag !== "N").length;

  const listPane = (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">{t("lab.quick.history")}</h2>
      {patient === null && <p className="text-sm text-muted-foreground">{t("lab.quick.pickFirst")}</p>}
      {patient !== null && (history.data?.items ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">{t("lab.quick.noHistory")}</p>
      )}
      <ul className="space-y-1">
        {(history.data?.items ?? []).map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => openReport(r)}
              className={`w-full rounded border px-2 py-1 text-left text-sm hover:bg-muted ${r.id === reportId ? "border-primary" : ""}`}
            >
              <span className="font-medium">{fmtIst(r.updatedAt)}</span>
              <span className="block truncate text-xs text-muted-foreground">{r.lines.map((l) => l.code).join(", ")}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <LabStation
      station="quick"
      title={t("lab.quick.title")}
      place={t("lab.quick.place")}
      stats={[
        { label: t("lab.quick.paramsStat"), value: rows.length },
        { label: t("lab.quick.filledStat"), value: filledCount, tone: "live" },
        { label: t("lab.quick.abnormalStat"), value: abnormalCount, tone: abnormalCount > 0 ? "danger" : "plain" },
      ]}
      list={listPane}
    >
      <div className="space-y-4">
        {patient === null ? (
          <section aria-label={t("lab.quick.findPatient")}>
            <h2 className="mb-2 text-base font-semibold">{t("lab.quick.findPatient")}</h2>
            <PatientPicker onPick={pickPatient} autoFocus />
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-center gap-3 rounded border p-3" aria-label={t("lab.quick.patient")}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold">{patient.name}</div>
                <div className="text-sm text-muted-foreground">
                  {patient.uhid} · {sexAge(patient.administrativeGender, patient.dob)}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={reset}>{t("lab.quick.newReport")}</Button>
              <Button variant="outline" size="sm" onClick={() => { reset(); setPatient(null); }}>
                {t("lab.quick.changePatient")}
              </Button>
            </section>

            <section className="relative">
              <label htmlFor="lab-quick-search" className="mb-1 block text-sm font-medium">{t("lab.quick.addTest")}</label>
              <input
                id="lab-quick-search"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={t("lab.quick.addTestHint")}
                autoComplete="off"
                className="w-full rounded border bg-background px-3 py-2 text-base"
              />
              {q !== "" && (
                <div className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded border bg-background shadow">
                  {matches.tests.map((x) => (
                    <button key={x.serviceId} type="button" onClick={() => addAnalytes(x.analyteIds)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">
                      <span className="font-medium">{x.nameEn}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{x.code} · {t("lab.quick.paramCount", { count: x.analyteIds.length })}</span>
                    </button>
                  ))}
                  {matches.analytes.map((x) => (
                    <button key={x.analyteId} type="button" onClick={() => addAnalytes([x.analyteId])}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">
                      {x.nameEn}<span className="ml-2 text-xs text-muted-foreground">{x.code}{x.unit ? ` · ${x.unit}` : ""}</span>
                    </button>
                  ))}
                  {matches.tests.length === 0 && matches.analytes.length === 0 && (
                    <p className="px-3 py-2 text-sm text-muted-foreground">{t("lab.quick.noMatch")}</p>
                  )}
                </div>
              )}
            </section>

            {rows.length > 0 && (
              <section className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-2">{t("lab.quick.colParameter")}</th>
                      <th className="py-1 pr-2">{t("lab.quick.colResult")}</th>
                      <th className="hidden py-1 pr-2 sm:table-cell">{t("lab.quick.colUnit")}</th>
                      <th className="py-1 pr-2">{t("lab.quick.colRange")}</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const a = analyteById.get(r.analyteId);
                      const line = previewLines.find((l) => l.analyteId === r.analyteId);
                      const flag = line?.flag ?? null;
                      const range = rangeById.get(r.analyteId);
                      return (
                        <tr key={r.analyteId} className="border-b">
                          <td className="py-1 pr-2">
                            <div className="font-medium">{a?.nameEn ?? r.analyteId}</div>
                            {range?.note && <div className="text-xs text-muted-foreground">{range.note}</div>}
                          </td>
                          <td className="py-1 pr-2">
                            <div className="flex items-center gap-1">
                              <input
                                ref={(el) => { if (el) inputs.current.set(r.analyteId, el); else inputs.current.delete(r.analyteId); }}
                                aria-label={a?.nameEn ?? r.analyteId}
                                data-flag={flag ?? ""}
                                inputMode={a?.resultType === "numeric" ? "decimal" : "text"}
                                value={r.value}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setRows((prev) => prev.map((x) => (x.analyteId === r.analyteId ? { ...x, value: v } : x)));
                                  setSaved(null);
                                }}
                                onKeyDown={(e) => onValueKey(e, i)}
                                className={`w-24 rounded border px-2 py-1 text-base ${flag ? FLAG_CLASS[flag] ?? "" : ""}`}
                              />
                              {flag !== null && flag !== "N" && (
                                <span className="text-xs font-bold" aria-label={flagLabel(t, flag)}>{flag}</span>
                              )}
                            </div>
                          </td>
                          <td className="hidden py-1 pr-2 text-muted-foreground sm:table-cell">{a?.unit ?? ""}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{refText(range)}</td>
                          <td className="py-1 text-right">
                            <button type="button" aria-label={t("lab.quick.remove")}
                              onClick={() => setRows((prev) => prev.filter((x) => x.analyteId !== r.analyteId))}
                              className="px-2 text-muted-foreground hover:text-foreground">×</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {rows.length > 0 && (
              <section>
                <div className="mb-1 flex items-center justify-between">
                  <label htmlFor="lab-quick-summary" className="text-sm font-medium">{t("lab.quick.summary")}</label>
                  {summaryEdited && (
                    <button type="button" className="text-xs underline" onClick={() => { setSummaryEdited(false); setSummary(""); }}>
                      {t("lab.quick.regenerate")}
                    </button>
                  )}
                </div>
                <textarea
                  id="lab-quick-summary"
                  rows={4}
                  value={shownSummary}
                  onChange={(e) => { setSummary(e.target.value); setSummaryEdited(true); setSaved(null); }}
                  className="w-full rounded border bg-background px-3 py-2 text-sm"
                />
              </section>
            )}

            {error !== null && <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}

            {rows.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => save.mutate()} disabled={filledCount === 0 || save.isPending}>
                  {reportId === null ? t("lab.quick.save") : t("lab.quick.saveChanges")}
                </Button>
                {saved !== null && (
                  <>
                    <Button variant="outline" onClick={() => printReport(patient, saved)}>{t("lab.quick.print")}</Button>
                    <span role="status" className="text-sm text-green-700 dark:text-green-300">{t("lab.quick.saved")}</span>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </LabStation>
  );
}
