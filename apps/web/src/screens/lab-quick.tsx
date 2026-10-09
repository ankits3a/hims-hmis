import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { deskFind, istToday, labErrorText } from "../lib/lab-api";
import {
  draftSummary, previewFlag, quickCatalogue, quickQueue, quickRanges, quickReport, refText, saveQuickResults,
  startQuick, verifyCardQr,
} from "../lib/lab-quick-api";
import { Button } from "@/components/ui/button";
import { LabStation, sexAge } from "./lab-seat";
import type { WireDeskFindHit } from "../lib/lab-api";
import type {
  QuickAnalyte, QuickCatalogue, QuickChosenTest, QuickFlag, QuickLine, QuickRange, QuickReport, QuickRow,
} from "../lib/lab-quick-api";

/**
 * QUICK MODE (owner 2026-10-09, decision 0061) — the lab without bills, tokens or signatures.
 *
 *   START (counter, `lab.desk.operate`): type the visit no. from the slip, the token, the UHID, a
 *   mobile or a name — or scan the card's QR — and pick the patient. The doctor's advised tests come
 *   ticked; add or remove tests; tick "Blood collected"; Start puts the patient in the queue and the
 *   patient is told when to come back.
 *
 *   RESULTS (bench, `lab.results.enter`): pick the patient from the queue on the right. The form
 *   holds every parameter of the chosen tests; each value is coloured against the patient's range
 *   as it is typed, a summary drafts itself and stays editable; Save, then Print.
 *
 * The colours are a preview; the server resolves the range and flag again on save.
 */

type Mode = { kind: "start" } | { kind: "results"; id: string };

const FLAG_CLASS: Record<string, string> = {
  L: "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  H: "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  LL: "border-red-700 bg-red-200 font-bold text-red-950 dark:bg-red-900 dark:text-white",
  HH: "border-red-700 bg-red-200 font-bold text-red-950 dark:bg-red-900 dark:text-white",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A plain A4 page in a new window. Labels are English: the report is the hospital's document. */
function printReport(report: QuickReport): void {
  const p = report.patient;
  const rows = report.lines.map((l) => `<tr${l.flag && l.flag !== "N" ? ' class="ab"' : ""}><td>${escapeHtml(l.nameEn)}</td>`
    + `<td><b>${escapeHtml(l.value)}</b> ${l.flag && l.flag !== "N" ? escapeHtml(l.flag) : ""}</td><td>${escapeHtml(l.unit ?? "")}</td>`
    + `<td>${escapeHtml(refText({ low: l.low, high: l.high, text: l.refText }))}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lab report ${escapeHtml(p.uhid)}</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#000}h1{font-size:18px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}
tr.ab td{font-weight:600}.sum{white-space:pre-wrap;border:1px solid #999;padding:8px}.meta{color:#333;line-height:1.5}</style></head><body>
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

/* ═══════════════════════════════ START ═══════════════════════════════ */

function StartPanel({ catalogue, onStarted }: { catalogue: QuickCatalogue | undefined; onStarted: (r: QuickRow) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WireDeskFindHit[] | null>(null);
  const [hit, setHit] = useState<WireDeskFindHit | null>(null);
  const [tests, setTests] = useState<QuickChosenTest[]>([]);
  const [testSearch, setTestSearch] = useState("");
  const [collected, setCollected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const find = useMutation({
    mutationFn: async (query: string): Promise<WireDeskFindHit[]> => {
      const today = istToday();
      const r = await deskFind(query, today);
      if (r.hits.length > 0 || query.length < 30) return r.hits;
      /** Nothing by visit, token, UHID, mobile or name, and long: a scanned card QR. */
      const qr = await verifyCardQr(query);
      if (!qr.ok) return [];
      return (await deskFind(qr.patient.uhid, today)).hits;
    },
    onSuccess: (h) => {
      setError(null);
      if (h.length === 1) choose(h[0]!);
      else setHits(h);
    },
    onError: (e) => setError(labErrorText(e)),
  });

  function choose(h: WireDeskFindHit): void {
    setHit(h);
    setHits(null);
    setDone(null);
    setCollected(false);
    const advised = (h.visit?.advised ?? []).filter((a) => a.orderable !== null);
    setTests(advised.map((a) => ({ serviceId: a.serviceId, code: a.code, nameEn: a.name })));
  }

  function clear(): void {
    setHit(null); setHits(null); setTests([]); setCollected(false); setQ(""); setTestSearch(""); setError(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  const start = useMutation({
    mutationFn: () => startQuick({
      patientId: hit!.patient.id, encounterNo: hit!.visit?.encounterNo ?? null,
      serviceIds: tests.map((x) => x.serviceId), bloodCollected: collected,
    }),
    onSuccess: (row) => {
      setDone(t("lab.quick.started", { name: row.patient.display }));
      onStarted(row);
      clear();
    },
    onError: (e) => setError(labErrorText(e)),
  });

  const tq = testSearch.trim().toLowerCase();
  const testMatches = useMemo(() => {
    if (tq === "" || !catalogue) return [];
    const chosen = new Set(tests.map((x) => x.serviceId));
    return catalogue.tests
      .filter((x) => !chosen.has(x.serviceId) && (x.code.toLowerCase().includes(tq) || x.nameEn.toLowerCase().includes(tq)))
      .slice(0, 8);
  }, [tq, catalogue, tests]);

  function addTest(x: { serviceId: string; code: string; nameEn: string }): void {
    setTests((prev) => (prev.some((p) => p.serviceId === x.serviceId) ? prev : [...prev, x]));
    setTestSearch("");
  }

  return (
    <div className="space-y-4">
      {done !== null && <p role="status" className="rounded border border-green-600 p-2 text-sm text-green-800 dark:text-green-200">{done}</p>}
      {hit === null ? (
        <section>
          <label htmlFor="lab-quick-find" className="mb-1 block text-base font-semibold">{t("lab.quick.findPatient")}</label>
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") find.mutate(q.trim()); }} className="flex gap-2">
            <input
              id="lab-quick-find"
              ref={searchRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("lab.quick.findHint")}
              autoComplete="off"
              className="min-w-0 flex-1 rounded border bg-background px-3 py-2 text-base"
            />
            <Button type="submit" disabled={find.isPending}>{t("lab.quick.find")}</Button>
          </form>
          {hits !== null && hits.length === 0 && <p className="mt-2 text-sm">{t("lab.quick.notFound")}</p>}
          {hits !== null && hits.length > 0 && (
            <ul className="mt-2 divide-y rounded border">
              {hits.map((h) => (
                <li key={`${h.patient.id}-${h.visit?.encounterNo ?? ""}`}>
                  <button type="button" onClick={() => choose(h)} className="w-full px-3 py-2 text-left hover:bg-muted">
                    <span className="font-medium">{h.patient.display}</span>
                    <span className="block text-xs text-muted-foreground">
                      {h.patient.uhid} · {sexAge(h.patient.administrativeGender, h.patient.dob)}
                      {h.visit ? ` · ${h.visit.encounterNo}${h.visit.doctorName ? ` · ${h.visit.doctorName}` : ""}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-3 rounded border p-3" aria-label={t("lab.quick.patient")}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold">{hit.patient.display}</div>
              <div className="text-sm text-muted-foreground">
                {hit.patient.uhid} · {sexAge(hit.patient.administrativeGender, hit.patient.dob)}
                {hit.visit ? ` · ${hit.visit.encounterNo}${hit.visit.doctorName ? ` · ${hit.visit.doctorName}` : ""}` : ""}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={clear}>{t("lab.quick.changePatient")}</Button>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">{t("lab.quick.tests")}</h2>
            {tests.length === 0 && <p className="mb-2 text-sm text-muted-foreground">{t("lab.quick.noAdvised")}</p>}
            <ul className="mb-2 flex flex-wrap gap-2">
              {tests.map((x) => (
                <li key={x.serviceId} className="flex items-center gap-1 rounded-full border px-3 py-1 text-sm">
                  <span>{x.nameEn}</span>
                  <button type="button" aria-label={t("lab.quick.removeTest", { name: x.nameEn })}
                    onClick={() => setTests((prev) => prev.filter((p) => p.serviceId !== x.serviceId))}
                    className="px-1 text-muted-foreground hover:text-foreground">×</button>
                </li>
              ))}
            </ul>
            <div className="relative">
              <input
                aria-label={t("lab.quick.addTest")}
                value={testSearch}
                onChange={(e) => setTestSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (testMatches[0]) addTest(testMatches[0]); } }}
                placeholder={t("lab.quick.addTestHint")}
                autoComplete="off"
                className="w-full rounded border bg-background px-3 py-2 text-base"
              />
              {tq !== "" && (
                <div className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border bg-background shadow">
                  {testMatches.map((x) => (
                    <button key={x.serviceId} type="button" onClick={() => addTest(x)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">
                      {x.nameEn}<span className="ml-2 text-xs text-muted-foreground">{x.code}</span>
                    </button>
                  ))}
                  {testMatches.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{t("lab.quick.noMatch")}</p>}
                </div>
              )}
            </div>
          </section>

          <label className="flex items-center gap-3 rounded border p-3 text-base font-medium">
            <input type="checkbox" className="h-5 w-5" checked={collected} onChange={(e) => setCollected(e.target.checked)} />
            {t("lab.quick.bloodCollected")}
          </label>

          {error !== null && <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}

          <Button size="lg" onClick={() => start.mutate()} disabled={!collected || tests.length === 0 || start.isPending}>
            {t("lab.quick.start")}
          </Button>
        </>
      )}
      {hit === null && error !== null && <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

/* ═══════════════════════════════ RESULTS ═══════════════════════════════ */

type Row = { analyteId: string; value: string };

function ResultsPanel({ id, catalogue, onBack }: { id: string; catalogue: QuickCatalogue | undefined; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ["lab-quick", "report", id], queryFn: () => quickReport(id) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState("");
  const [summaryEdited, setSummaryEdited] = useState(false);
  const [saved, setSaved] = useState<QuickReport | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    const r = report.data;
    if (r === undefined || rows !== null) return;
    const typed = new Map(r.lines.map((l) => [l.analyteId, l.value]));
    setRows(r.analyteIds.map((analyteId) => ({ analyteId, value: typed.get(analyteId) ?? "" })));
    if (r.status === "reported") { setSummary(r.summary); setSummaryEdited(true); setSaved(r); }
    setTimeout(() => { const first = r.analyteIds[0]; if (first) inputs.current.get(first)?.focus(); }, 0);
  }, [report.data, rows]);

  const analyteById = useMemo(() => new Map((catalogue?.analytes ?? []).map((a) => [a.analyteId, a])), [catalogue]);
  const list = rows ?? [];
  const ids = list.map((r) => r.analyteId);
  const patientId = report.data?.patient.id;
  const ranges = useQuery({
    queryKey: ["lab-quick", "ranges", patientId, [...ids].sort().join(",")],
    queryFn: () => quickRanges(patientId!, ids),
    enabled: patientId !== undefined && ids.length > 0,
  });
  const rangeById = useMemo(() => new Map<string, QuickRange>((ranges.data?.items ?? []).map((r) => [r.analyteId, r])), [ranges.data]);

  const previewLines: QuickLine[] = list.flatMap((r) => {
    const a = analyteById.get(r.analyteId);
    if (!a) return [];
    const range = rangeById.get(r.analyteId);
    return [{
      analyteId: a.analyteId, code: a.code, nameEn: a.nameEn, unit: a.unit, value: r.value,
      low: range?.low ?? null, high: range?.high ?? null, refText: range?.text ?? null,
      flag: a.resultType === "numeric" || a.resultType === "formula" ? previewFlag(r.value, range) : null,
    }];
  });
  const shownSummary = summaryEdited ? summary : draftSummary(previewLines);

  const save = useMutation({
    mutationFn: () => saveQuickResults(id, { lines: list.filter((r) => r.value.trim() !== ""), summary: shownSummary }),
    onSuccess: (r) => {
      setSaved(r);
      setError(null);
      qc.setQueryData(["lab-quick", "report", id], r);
      void qc.invalidateQueries({ queryKey: ["lab-quick", "queue"] });
    },
    onError: (e) => setError(labErrorText(e)),
  });

  const q = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (q === "" || !catalogue) return [] as QuickAnalyte[];
    const have = new Set(ids);
    return catalogue.analytes.filter((x) => !have.has(x.analyteId) && (x.code.toLowerCase().includes(q) || x.nameEn.toLowerCase().includes(q))).slice(0, 8);
  }, [q, catalogue, ids]);

  function addParam(a: QuickAnalyte): void {
    setRows((prev) => [...(prev ?? []), { analyteId: a.analyteId, value: "" }]);
    setSearch("");
    setSaved(null);
    setTimeout(() => inputs.current.get(a.analyteId)?.focus(), 0);
  }

  function onValueKey(e: React.KeyboardEvent<HTMLInputElement>, index: number): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const next = list[index + 1];
    if (next) inputs.current.get(next.analyteId)?.focus();
    else document.getElementById("lab-quick-summary")?.focus();
  }

  if (report.isError) return <p role="alert">{labErrorText(report.error)}</p>;
  if (report.data === undefined || rows === null) return <p className="text-sm text-muted-foreground">{t("lab.quick.loading")}</p>;
  const r = report.data;
  const filledCount = list.filter((x) => x.value.trim() !== "").length;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-3 rounded border p-3" aria-label={t("lab.quick.patient")}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{r.patient.display}</div>
          <div className="text-sm text-muted-foreground">
            {r.patient.uhid} · {sexAge(r.patient.administrativeGender, r.patient.dob)}{r.encounterNo ? ` · ${r.encounterNo}` : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            {r.tests.map((x) => x.nameEn).join(", ")} · {t("lab.quick.collectedAt", { at: fmtIst(r.collectedAt) })}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>{t("lab.quick.back")}</Button>
      </section>

      <section className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2">{t("lab.quick.colParameter")}</th>
              <th className="py-1 pr-2">{t("lab.quick.colResult")}</th>
              <th className="hidden py-1 pr-2 sm:table-cell">{t("lab.quick.colUnit")}</th>
              <th className="py-1 pr-2">{t("lab.quick.colRange")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((row, i) => {
              const a = analyteById.get(row.analyteId);
              const flag: QuickFlag = previewLines.find((l) => l.analyteId === row.analyteId)?.flag ?? null;
              const range = rangeById.get(row.analyteId);
              return (
                <tr key={row.analyteId} className="border-b">
                  <td className="py-1 pr-2">
                    <div className="font-medium">{a?.nameEn ?? row.analyteId}</div>
                    {range?.note && <div className="text-xs text-muted-foreground">{range.note}</div>}
                  </td>
                  <td className="py-1 pr-2">
                    <div className="flex items-center gap-1">
                      <input
                        ref={(el) => { if (el) inputs.current.set(row.analyteId, el); else inputs.current.delete(row.analyteId); }}
                        aria-label={a?.nameEn ?? row.analyteId}
                        data-flag={flag ?? ""}
                        inputMode={a?.resultType === "numeric" ? "decimal" : "text"}
                        value={row.value}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRows((prev) => (prev ?? []).map((x) => (x.analyteId === row.analyteId ? { ...x, value: v } : x)));
                          setSaved(null);
                        }}
                        onKeyDown={(e) => onValueKey(e, i)}
                        className={`w-24 rounded border bg-background px-2 py-1 text-base ${flag ? FLAG_CLASS[flag] ?? "" : ""}`}
                      />
                      {flag !== null && flag !== "N" && (
                        <span className="text-xs font-bold" title={t(`lab.quick.flag_${flag}`)}>{flag}</span>
                      )}
                    </div>
                  </td>
                  <td className="hidden py-1 pr-2 text-muted-foreground sm:table-cell">{a?.unit ?? ""}</td>
                  <td className="py-1 pr-2 text-muted-foreground">{refText(range)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="relative">
        <input
          aria-label={t("lab.quick.addParam")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (matches[0]) addParam(matches[0]); } }}
          placeholder={t("lab.quick.addParamHint")}
          autoComplete="off"
          className="w-full rounded border bg-background px-3 py-2 text-sm"
        />
        {q !== "" && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border bg-background shadow">
            {matches.map((x) => (
              <button key={x.analyteId} type="button" onClick={() => addParam(x)} className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">
                {x.nameEn}<span className="ml-2 text-xs text-muted-foreground">{x.code}{x.unit ? ` · ${x.unit}` : ""}</span>
              </button>
            ))}
            {matches.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{t("lab.quick.noMatch")}</p>}
          </div>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="lab-quick-summary" className="text-sm font-medium">{t("lab.quick.summary")}</label>
          {summaryEdited && (
            <button type="button" className="text-xs underline" onClick={() => { setSummaryEdited(false); setSummary(""); setSaved(null); }}>
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

      {error !== null && <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={filledCount === 0 || save.isPending}>
          {r.status === "reported" ? t("lab.quick.saveChanges") : t("lab.quick.save")}
        </Button>
        {saved !== null && (
          <>
            <Button variant="outline" onClick={() => printReport(saved)}>{t("lab.quick.print")}</Button>
            <span role="status" className="text-sm text-green-700 dark:text-green-300">{t("lab.quick.saved")}</span>
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════ THE SEAT ═══════════════════════════════ */

function QueueRow({ row, current, onPick }: { row: QuickRow; current: boolean; onPick: () => void }): React.ReactElement {
  return (
    <li>
      <button type="button" onClick={onPick}
        className={`w-full rounded border px-2 py-1 text-left text-sm hover:bg-muted ${current ? "border-primary" : ""}`}>
        <span className="font-medium">{row.patient.display}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.patient.uhid} · {row.tests.map((x) => x.code).join(", ")} · {fmtIst(row.reportedAt ?? row.collectedAt)}
        </span>
      </button>
    </li>
  );
}

export function LabQuick(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayStart = can("lab.desk.operate");
  const mayReport = can("lab.results.enter");
  const [mode, setMode] = useState<Mode>({ kind: "start" });

  const catalogue = useQuery({ queryKey: ["lab-quick", "catalogue"], queryFn: quickCatalogue, staleTime: 10 * 60_000 });
  const queue = useQuery({ queryKey: ["lab-quick", "queue"], queryFn: quickQueue, enabled: mayReport, refetchInterval: 30_000 });
  const waiting = queue.data?.waiting ?? [];
  const reported = queue.data?.reportedToday ?? [];
  const current = mode.kind === "results" ? mode.id : null;

  const listPane = (
    <div className="space-y-3">
      {mayStart && (
        <Button className="w-full" variant={mode.kind === "start" ? "default" : "outline"} onClick={() => setMode({ kind: "start" })}>
          {t("lab.quick.newPatient")}
        </Button>
      )}
      {mayReport && (
        <>
          <h2 className="text-sm font-semibold">{t("lab.quick.waiting", { count: waiting.length })}</h2>
          {waiting.length === 0 && <p className="text-sm text-muted-foreground">{t("lab.quick.queueEmpty")}</p>}
          <ul className="space-y-1">
            {waiting.map((r) => <QueueRow key={r.id} row={r} current={r.id === current} onPick={() => setMode({ kind: "results", id: r.id })} />)}
          </ul>
          {reported.length > 0 && (
            <>
              <h2 className="pt-2 text-sm font-semibold">{t("lab.quick.reportedToday", { count: reported.length })}</h2>
              <ul className="space-y-1">
                {reported.map((r) => <QueueRow key={r.id} row={r} current={r.id === current} onPick={() => setMode({ kind: "results", id: r.id })} />)}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <LabStation
      station="quick"
      title={t("lab.quick.title")}
      place={mode.kind === "start" ? t("lab.quick.placeStart") : t("lab.quick.placeResults")}
      stats={[
        { label: t("lab.quick.waitingStat"), value: waiting.length, tone: waiting.length > 0 ? "waiting" : "plain" },
        { label: t("lab.quick.reportedStat"), value: reported.length, tone: "live" },
      ]}
      list={listPane}
    >
      {mode.kind === "results" && mayReport ? (
        <ResultsPanel key={mode.id} id={mode.id} catalogue={catalogue.data} onBack={() => setMode({ kind: "start" })} />
      ) : mayStart ? (
        <StartPanel catalogue={catalogue.data} onStarted={() => { void qc.invalidateQueries({ queryKey: ["lab-quick", "queue"] }); }} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("lab.quick.pickFromQueue")}</p>
      )}
    </LabStation>
  );
}
