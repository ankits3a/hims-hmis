import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { downloadCsv, toCsv } from "../../lib/payables-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import {
  MARGIN_GROUPS, NON_MOVING_DAYS, RECON_BUCKETS, REPORT_PRESETS, SALES_GROUPS, STOCK_IN_KINDS, STOCK_OUT_KINDS, fetchActivity, fetchActivityFeed,
  fetchCatalogue, fetchDailyStock, fetchGstr3b, fetchHsn, fetchLossRegister, fetchMargin, fetchNonMoving, fetchPurchaseRegister, fetchReportStores,
  fetchSalesRegister, fetchTopSelling, fetchValuation, money, pct, printReport, reconcileGstr2b, todayIst, trimGstr2bJson,
} from "../../lib/reports-api";
import { downloadXlsx, toXlsx } from "../../lib/xlsx";
import { Button } from "@/components/ui/button";
import { TallyReport } from "./tally";
import type {
  AbcClass, MarginGroupBy, RangeInput, ReconBucket, ReportPreset, SalesGroupBy, WireActivity, WireActivityEntry, WireCatalogueRow, WireDailyStockRow,
  WireGstr2b, WireLossRow, WireSalesRow, WireTopSellingRow,
} from "../../lib/reports-api";

/**
 * ═══ PHARMACY PARITY P5 — THE OFFICE'S REPORTS ═══
 *
 * The office's fourth side. It opens on the list of reports, each on a number key; a report is one
 * screen: its filters (a range — today, this week, this month, this financial year or custom — and a
 * store, and what it groups by), a table with a totals row, a row that opens to its lines where that
 * helps, and E to export it as an Excel workbook (.xlsx, typed cells — stage C), C as CSV, and P to
 * print it on A4 (save as PDF from the dialog). Esc goes back to the list. Everything here READS;
 * nothing is changed from a report.
 *
 * Cost, profit and margin appear only for a holder of `pharmacy.reports.margin` — the server leaves
 * them out for anybody else, and the margin report is not offered.
 */
export type ReportKey =
  | "sales" | "purchases" | "margin" | "valuation" | "nonMoving" | "hsn" | "gstr2b" | "gstr3b" | "activity" | "tally"
  | "topSelling" | "losses" | "dailyStock" | "catalogue";
const ALL_REPORTS: readonly ReportKey[] = [
  "sales", "purchases", "margin", "valuation", "nonMoving", "hsn", "gstr2b", "gstr3b", "activity", "tally",
  "topSelling", "losses", "dailyStock", "catalogue",
];
/**
 * The list's keys: 1–9, then 0 for the tenth (GAP A4 made it ten), then letters (stage C made it
 * fourteen). The letters skip every key a report screen answers (T W M Y presets, E C P exports, the
 * Tally export's X and L) and the office board's side keys (B Y R S I L P), so no key means two things.
 */
const EXTRA_KEYS = ["A", "D", "F", "G", "H", "J", "K", "N", "O", "U", "V", "Z"] as const;
export const keyOf = (i: number): string => (i < 9 ? String(i + 1) : i === 9 ? "0" : EXTRA_KEYS[i - 10] ?? "");

type Col<R> = { key: string; label: string; num?: boolean; money?: boolean; value: (r: R) => string | number | null };
type Totals = Record<string, string | number | null>;

const cellText = (c: { money?: boolean }, v: string | number | null): string =>
  v === null ? "—" : c.money === true && typeof v === "number" ? money(v) : typeof v === "number" ? v.toLocaleString("en-IN") : v;
const csvText = (c: { money?: boolean }, v: string | number | null): string | number =>
  v === null ? "" : c.money === true && typeof v === "number" ? (v / 100).toFixed(2) : v;

/** What E and P act on: the table as the person sees it. */
type Sheet = { title: string; subtitle: string; file: string; cols: Col<never>[]; rows: unknown[]; totals: Totals | null };

function exportCsv(s: Sheet): void {
  const cols = s.cols as Col<unknown>[];
  const body = s.rows.map((r) => cols.map((c) => csvText(c, c.value(r))));
  const tail = s.totals === null ? [] : [cols.map((c) => csvText(c, s.totals![c.key] ?? null))];
  downloadCsv(`${s.file}.csv`, toCsv(cols.map((c) => c.label), [...body, ...tail]));
}
/** A cell as Excel should hold it: money as rupees (a number, formatted), a count as a number, the rest as text. */
const xlsxValue = (c: { money?: boolean }, v: string | number | null): string | number | null =>
  v === null ? null : c.money === true && typeof v === "number" ? v / 100 : v;
/** STAGE C — the same table as a real .xlsx: typed cells, money as rupees, a bold header and totals row. */
export function sheetToXlsx(s: Sheet): Uint8Array {
  const cols = s.cols as Col<unknown>[];
  return toXlsx({
    name: s.title, header: cols.map((c) => c.label), money: cols.map((c) => c.money === true),
    rows: s.rows.map((r) => cols.map((c) => xlsxValue(c, c.value(r)))),
    totals: s.totals === null ? null : cols.map((c) => xlsxValue(c, s.totals![c.key] ?? null)),
  });
}
function exportXlsx(s: Sheet): void { downloadXlsx(`${s.file}.xlsx`, sheetToXlsx(s)); }
function printSheet(s: Sheet): boolean {
  const cols = s.cols as Col<unknown>[];
  return printReport(
    s.title, s.subtitle, cols.map((c) => c.label), s.rows.map((r) => cols.map((c) => cellText(c, c.value(r)))),
    s.totals === null ? null : cols.map((c) => { const v = s.totals![c.key]; return v === undefined ? "" : cellText(c, v); }), cols.map((c) => c.num === true || c.money === true),
  );
}

export function ReportsView({ initial = null }: { initial?: ReportKey | null }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const reports = ALL_REPORTS.filter((r) => (r !== "margin" || can("pharmacy.reports.margin")) && (r !== "tally" || can("pharmacy.tally.export")));
  const [open, setOpen] = useState<ReportKey | null>(initial !== null && reports.includes(initial) ? initial : null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open === null) listRef.current?.focus(); }, [open]);
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || open !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = reports.findIndex((_, k) => keyOf(k) !== "" && keyOf(k) === e.key.toUpperCase());
    if (i >= 0) { e.preventDefault(); setOpen(reports[i]!); }
  };
  if (open !== null) return <ReportScreen report={open} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-3 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid="reports-view" ref={listRef}>
      <p className="text-sm text-muted-foreground">{t("pharmacyOffice.reports.intro")}</p>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {reports.map((r, i) => (
          <li key={r}>
            <button type="button" data-testid={`report-${r}`} className="flex h-full w-full flex-col items-start gap-1 rounded border p-3 text-left hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => setOpen(r)}>
              <span className="flex w-full items-center gap-2 font-medium">
                <kbd className="rounded border px-1 text-xs">{keyOf(i)}</kbd>
                <span className="flex-1">{t(`pharmacyOffice.reports.name.${r}`)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{t(`pharmacyOffice.reports.about.${r}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportScreen({ report, onBack }: { report: ReportKey; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const sheet = useRef<Sheet | null>(null);
  const presetRef = useRef<((p: ReportPreset) => void) | null>(null);
  const keysRef = useRef<((key: string) => boolean) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const exportNow = (): void => { if (sheet.current !== null) exportXlsx(sheet.current); };
  const exportCsvNow = (): void => { if (sheet.current !== null) exportCsv(sheet.current); };
  const printNow = (): void => { if (sheet.current !== null && !printSheet(sheet.current)) setNotice(t("pharmacyOffice.reports.printFailed")); };
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (e.key === "Escape" && !typing) { e.preventDefault(); onBack(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (keysRef.current !== null && keysRef.current(k)) { e.preventDefault(); return; }
    if (k === "e") { e.preventDefault(); exportNow(); return; }
    if (k === "c") { e.preventDefault(); exportCsvNow(); return; }
    if (k === "p") { e.preventDefault(); printNow(); return; }
    const preset = ({ t: "today", w: "week", m: "month", y: "fy" } as Record<string, ReportPreset | undefined>)[k];
    if (preset !== undefined && presetRef.current !== null) { e.preventDefault(); presetRef.current(preset); }
  };
  const bind = { sheet, presetRef, keysRef };
  // Focus lands on the report once, when it opens, so its keys work at once; never again on a re-render.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  return (
    <div className="space-y-3 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid={`report-screen-${report}`} ref={box}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>← {t("pharmacyOffice.reports.back")} <kbd className="ml-1 rounded border px-1 text-xs">Esc</kbd></Button>
        <h2 className="flex-1 text-lg font-semibold">{t(`pharmacyOffice.reports.name.${report}`)}</h2>
        {report !== "tally" && (<>
          <Button type="button" variant="outline" data-testid="report-export" onClick={exportNow}>{t("pharmacyOffice.reports.exportXlsx")} <kbd className="ml-1 rounded border px-1 text-xs">E</kbd></Button>
          <Button type="button" variant="outline" data-testid="report-export-csv" onClick={exportCsvNow}>{t("pharmacyOffice.reports.exportCsv")} <kbd className="ml-1 rounded border px-1 text-xs">C</kbd></Button>
          <Button type="button" variant="outline" data-testid="report-print" onClick={printNow}>{t("pharmacyOffice.reports.print")} <kbd className="ml-1 rounded border px-1 text-xs">P</kbd></Button>
        </>)}
      </div>
      {notice !== null && <p role="alert" className="text-sm text-red-600">{notice}</p>}
      {report === "sales" && <SalesReport {...bind} />}
      {report === "purchases" && <PurchaseReport {...bind} />}
      {report === "margin" && <MarginReport {...bind} />}
      {report === "valuation" && <ValuationReport {...bind} />}
      {report === "nonMoving" && <NonMovingReport {...bind} />}
      {report === "hsn" && <HsnReport {...bind} />}
      {report === "gstr2b" && <Gstr2bReport {...bind} />}
      {report === "gstr3b" && <Gstr3bReport {...bind} />}
      {report === "activity" && <ActivityReport {...bind} />}
      {report === "tally" && <TallyScreen {...bind} />}
      {report === "topSelling" && <TopSellingReport {...bind} />}
      {report === "losses" && <LossReport {...bind} />}
      {report === "dailyStock" && <DailyStockReport {...bind} />}
      {report === "catalogue" && <CatalogueReport {...bind} />}
    </div>
  );
}

type Bind = {
  sheet: React.MutableRefObject<Sheet | null>;
  presetRef: React.MutableRefObject<((p: ReportPreset) => void) | null>;
  /** A report's own keys (the Tally export's X and L), asked before the screen's. */
  keysRef: React.MutableRefObject<((key: string) => boolean) | null>;
};

// ═══════════════════════════════════ 9. the Tally export ═══════════════════════════════════

function TallyScreen({ sheet, presetRef, keysRef }: Bind): React.ReactElement {
  const [range, setRange] = useRange(presetRef, "month");
  sheet.current = null; // the export is its own file, not a table to print
  return <TallyReport range={range} rangeBar={<RangeBar range={range} onChange={setRange} store={false} />} keysRef={keysRef} />;
}

// ═══════════════════════════════════ the shared pieces ═══════════════════════════════════

function useRange(presetRef: Bind["presetRef"], initial: ReportPreset = "today"): [RangeInput, (r: RangeInput) => void] {
  const [range, setRange] = useState<RangeInput>({ preset: initial, from: todayIst(), to: todayIst(), store: "" });
  presetRef.current = (preset) => setRange((r) => ({ ...r, preset }));
  return [range, setRange];
}

function RangeBar({ range, onChange, store = true }: { range: RangeInput; onChange: (r: RangeInput) => void; store?: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const stores = useQuery({ queryKey: ["pharmacy", "reports", "stores"], queryFn: fetchReportStores, enabled: store });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="range-bar">
      <div className="flex gap-1" role="group" aria-label={t("pharmacyOffice.reports.range")}>
        {REPORT_PRESETS.map((p) => (
          <Button key={p} type="button" size="sm" variant={range.preset === p ? "default" : "outline"} data-testid={`preset-${p}`} onClick={() => onChange({ ...range, preset: p })}>
            {t(`pharmacyOffice.reports.preset.${p}`)}
          </Button>
        ))}
      </div>
      {range.preset === "custom" && (
        <>
          <input type="date" aria-label={t("pharmacyOffice.reports.from")} className="rounded border px-1" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} />
          <span>–</span>
          <input type="date" aria-label={t("pharmacyOffice.reports.to")} className="rounded border px-1" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} />
        </>
      )}
      {store && (
        <select aria-label={t("pharmacyOffice.reports.store")} className="rounded border px-1 py-0.5" value={range.store} onChange={(e) => onChange({ ...range, store: e.target.value })}>
          <option value="">{t("pharmacyOffice.reports.allStores")}</option>
          {(stores.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}

function Choice<T extends string | number>({ label, value, options, onChange, text, testId }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; text: (v: T) => string; testId: string;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-1 text-sm">
      {label}
      <select data-testid={testId} className="rounded border px-1 py-0.5" value={String(value)} onChange={(e) => onChange(options.find((o) => String(o) === e.target.value)!)}>
        {options.map((o) => <option key={String(o)} value={String(o)}>{text(o)}</option>)}
      </select>
    </label>
  );
}

function Table<R>({ testId, cols, rows, rowKey, totals, expand, rowClass }: {
  testId: string; cols: Col<R>[]; rows: readonly R[]; rowKey: (r: R) => string; totals: Totals | null;
  expand?: (r: R) => React.ReactNode | null; rowClass?: (r: R) => string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {expand !== undefined && <th className="w-6" />}
            {cols.map((c) => <th key={c.key} className={`py-1 pr-2 ${c.num === true || c.money === true ? "text-right" : ""}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="py-3 text-muted-foreground">{t("pharmacyOffice.reports.empty")}</td></tr>}
          {rows.map((r) => {
            const k = rowKey(r);
            const inner = openKey === k && expand !== undefined ? expand(r) : null;
            return (
              <Fragment key={k}>
                <tr className={`border-t ${rowClass?.(r) ?? ""}`} data-testid={`${testId}-row-${k}`}>
                  {expand !== undefined && (
                    <td>
                      <button type="button" aria-label={t("pharmacyOffice.reports.lines")} aria-expanded={openKey === k} className="px-1 text-xs" onClick={() => setOpenKey(openKey === k ? null : k)}>
                        {openKey === k ? "▾" : "▸"}
                      </button>
                    </td>
                  )}
                  {cols.map((c) => <td key={c.key} className={`py-1 pr-2 ${c.num === true || c.money === true ? "text-right tabular-nums" : ""}`}>{cellText(c, c.value(r))}</td>)}
                </tr>
                {inner !== null && <tr><td /><td colSpan={cols.length} className="bg-muted/40 p-2">{inner}</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
        {totals !== null && rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 font-semibold" data-testid={`${testId}-totals`}>
              {expand !== undefined && <td />}
              {cols.map((c) => { const v = totals[c.key]; return <td key={c.key} className={`py-1 pr-2 ${c.num === true || c.money === true ? "text-right tabular-nums" : ""}`}>{v === undefined ? "" : cellText(c, v)}</td>; })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Status({ loading, error }: { loading: boolean; error: unknown }): React.ReactElement | null {
  const { t } = useTranslation();
  if (error !== null && error !== undefined) return <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(error, t)}</p>;
  if (loading) return <p className="text-sm text-muted-foreground">{t("pharmacyOffice.reports.loading")}</p>;
  return null;
}

const rangeText = (from: string, to: string): string => (from === to ? from : `${from} – ${to}`);

// ═══════════════════════════════════ 1. the sales register ═══════════════════════════════════

function SalesReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef);
  const [groupBy, setGroupBy] = useState<SalesGroupBy>("document");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "sales", range, groupBy], queryFn: () => fetchSalesRegister(range, groupBy) });
  const d = q.data;
  const m = d?.margin === true;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const sign = (r: WireSalesRow, v: number): number => (r.kind === "refund" && v !== 0 ? -v : v);
  const docCols: Col<WireSalesRow>[] = [
    { key: "date", label: L("date"), value: (r) => r.date },
    { key: "time", label: L("time"), value: (r) => new Date(r.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) },
    { key: "no", label: L("docNo"), value: (r) => r.docNo },
    { key: "kind", label: L("mode"), value: (r) => t(`pharmacyOffice.reports.kind.${r.kind}`) },
    { key: "patient", label: L("patient"), value: (r) => r.patientName },
    { key: "uhid", label: L("uhid"), value: (r) => r.uhid },
    { key: "source", label: L("customerType"), value: (r) => t(`pharmacyOffice.reports.source.${r.source}`) },
    { key: "doctor", label: L("doctor"), value: (r) => r.prescriber ?? "—" },
    { key: "operator", label: L("operator"), value: (r) => r.operatorName },
    { key: "tender", label: L("method"), value: (r) => (r.tender === null ? "—" : t(`pharmacyOffice.reports.tender.${r.tender}`)) },
    { key: "discount", label: L("discount"), money: true, value: (r) => sign(r, r.discountPaise) },
    { key: "taxable", label: L("taxable"), money: true, value: (r) => sign(r, r.taxablePaise) },
    { key: "cgst", label: L("cgst"), money: true, value: (r) => sign(r, r.cgstPaise) },
    { key: "sgst", label: L("sgst"), money: true, value: (r) => sign(r, r.sgstPaise) },
    { key: "net", label: L("total"), money: true, value: (r) => sign(r, r.netPaise) },
    { key: "remaining", label: L("remaining"), money: true, value: (r) => r.outstandingPaise },
    ...(m ? [
      { key: "profit", label: L("profit"), money: true, value: (r: WireSalesRow) => (r.profitPaise === null ? null : sign(r, r.profitPaise)) },
      { key: "margin", label: L("marginPct"), value: (r: WireSalesRow) => pct(r.marginBps) },
    ] : []),
  ];
  const groupCols: Col<NonNullable<typeof d>["groups"][number]>[] = [
    { key: "label", label: t(`pharmacyOffice.reports.group.${groupBy}`), value: (g) => (groupBy === "tender" ? t(`pharmacyOffice.reports.tender.${g.label}`) : g.label) },
    { key: "sub", label: groupBy === "item" ? L("code") : groupBy === "patient" ? L("uhid") : "", value: (g) => g.sub ?? "" },
    { key: "sales", label: L("bills"), num: true, value: (g) => g.sales },
    { key: "refunds", label: L("refunds"), num: true, value: (g) => g.refunds },
    ...(groupBy === "item" ? [{ key: "qty", label: L("qty"), num: true, value: (g: NonNullable<typeof d>["groups"][number]) => g.qtyBase }] : []),
    { key: "discount", label: L("discount"), money: true, value: (g) => g.discountPaise },
    { key: "taxable", label: L("taxable"), money: true, value: (g) => g.taxablePaise },
    { key: "cgst", label: L("cgst"), money: true, value: (g) => g.cgstPaise },
    { key: "sgst", label: L("sgst"), money: true, value: (g) => g.sgstPaise },
    { key: "returns", label: L("returns"), money: true, value: (g) => g.returnsPaise },
    { key: "net", label: L("net"), money: true, value: (g) => g.netPaise },
    ...(m ? [{ key: "profit", label: L("profit"), money: true, value: (g: NonNullable<typeof d>["groups"][number]) => g.profitPaise }] : []),
  ];
  const totals: Totals | null = d === undefined ? null : {
    date: t("pharmacyOffice.reports.totals"), label: t("pharmacyOffice.reports.totals"),
    discount: d.totals.sales.discountPaise - d.totals.refunds.discountPaise, taxable: d.totals.net.taxablePaise, cgst: d.totals.net.cgstPaise,
    sgst: d.totals.net.sgstPaise, net: d.totals.net.netPaise, returns: d.totals.refunds.netPaise, sales: d.totals.sales.count, refunds: d.totals.refunds.count,
    ...(m ? { profit: d.totals.profitPaise, margin: pct(d.totals.marginBps) } : {}),
  };
  const byDoc = groupBy === "document";
  if (d !== undefined) {
    sheet.current = {
      title: `${t("pharmacyOffice.reports.name.sales")}${byDoc ? "" : ` · ${t(`pharmacyOffice.reports.group.${groupBy}`)}`}`, subtitle: rangeText(d.from, d.to),
      file: `sales-register-${d.from}-${d.to}`, cols: (byDoc ? docCols : groupCols) as Col<never>[], rows: byDoc ? d.rows : d.groups, totals,
    };
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <RangeBar range={range} onChange={setRange} />
        <Choice label={L("groupBy")} testId="sales-group" value={groupBy} options={SALES_GROUPS} onChange={setGroupBy} text={(g) => t(`pharmacyOffice.reports.group.${g}`)} />
      </div>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <div className="flex flex-wrap gap-4 text-sm" data-testid="sales-summary">
            <span>{t("pharmacyOffice.reports.salesCount", { count: d.totals.sales.count })} <b className="tabular-nums">{money(d.totals.sales.netPaise)}</b></span>
            <span>{t("pharmacyOffice.reports.refundCount", { count: d.totals.refunds.count })} <b className="tabular-nums">{money(d.totals.refunds.netPaise)}</b></span>
            <span>{L("net")} <b className="tabular-nums">{money(d.totals.net.netPaise)}</b></span>
            {m && <span>{L("profit")} <b className="tabular-nums">{money(d.totals.profitPaise)}</b> ({pct(d.totals.marginBps)})</span>}
          </div>
          {byDoc
            ? <Table testId="sales-table" cols={docCols} rows={d.rows} rowKey={(r) => r.id} totals={totals}
                rowClass={(r) => (r.kind === "refund" ? "text-red-700" : "")}
                expand={(r) => (
                  <table className="w-full text-xs [&_td]:px-1.5 [&_th]:px-1.5" data-testid={`sales-lines-${r.id}`}>
                    <thead><tr className="text-left text-muted-foreground"><th>{L("item")}</th><th>{L("batch")}</th><th>{L("expiry")}</th><th className="text-right">{L("qty")}</th><th>{L("hsn")}</th><th className="text-right">{L("taxable")}</th><th className="text-right">{L("gst")}</th><th className="text-right">{L("total")}</th>{m && <th className="text-right">{L("cost")}</th>}{m && <th className="text-right">{L("profit")}</th>}</tr></thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={`${l.itemId}-${l.batchId}`}>
                          <td>{l.itemName} <span className="text-muted-foreground">{l.itemCode}</span></td><td>{l.batchNo}</td><td>{l.expiryDate ?? "—"}</td>
                          <td className="text-right">{l.qtyBase}</td><td>{l.hsn} · {l.rateBps / 100}%</td><td className="text-right">{money(l.taxablePaise)}</td>
                          <td className="text-right">{money(l.cgstPaise + l.sgstPaise)}</td><td className="text-right">{money(l.netPaise)}</td>
                          {m && <td className="text-right">{money(l.costPaise)}</td>}{m && <td className="text-right">{money(l.profitPaise)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )} />
            : <Table testId="sales-groups" cols={groupCols} rows={d.groups} rowKey={(g) => g.key || "—"} totals={totals} />}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 2. the purchase register ═══════════════════════════════════

function PurchaseReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "purchases", range], queryFn: () => fetchPurchaseRegister(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = NonNullable<typeof d>["rows"][number];
  const neg = (r: Row, v: number): number => (r.kind === "bill" || v === 0 ? v : -v);
  const cols: Col<Row>[] = [
    { key: "date", label: L("date"), value: (r) => r.date },
    { key: "kind", label: L("mode"), value: (r) => t(`pharmacyOffice.reports.purchaseKind.${r.kind}`) },
    { key: "no", label: L("ourNo"), value: (r) => r.docNo },
    { key: "vendorNo", label: L("vendorNo"), value: (r) => r.vendorDocNo ?? r.ref ?? "—" },
    { key: "vendor", label: L("supplier"), value: (r) => r.vendorName },
    { key: "gstin", label: L("gstin"), value: (r) => r.gstin ?? "—" },
    { key: "taxable", label: L("taxable"), money: true, value: (r) => neg(r, r.taxablePaise) },
    { key: "cgst", label: L("cgst"), money: true, value: (r) => neg(r, r.cgstPaise) },
    { key: "sgst", label: L("sgst"), money: true, value: (r) => neg(r, r.sgstPaise) },
    { key: "igst", label: L("igst"), money: true, value: (r) => neg(r, r.igstPaise) },
    { key: "total", label: L("total"), money: true, value: (r) => neg(r, r.totalPaise) },
    { key: "paid", label: L("paid"), money: true, value: (r) => r.paidPaise },
    { key: "due", label: L("due"), money: true, value: (r) => r.duePaise },
  ];
  const totals: Totals | null = d === undefined ? null : {
    date: t("pharmacyOffice.reports.netOfReturns"), taxable: d.totals.net.taxablePaise, cgst: d.totals.net.cgstPaise, sgst: d.totals.net.sgstPaise,
    igst: d.totals.net.igstPaise, total: d.totals.net.totalPaise, paid: d.totals.bills.paidPaise, due: d.totals.bills.duePaise,
  };
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.purchases"), subtitle: rangeText(d.from, d.to), file: `purchase-register-${d.from}-${d.to}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} store={false} />
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <div className="flex flex-wrap gap-4 text-sm" data-testid="purchase-summary">
            <span>{t("pharmacyOffice.reports.billCount", { count: d.totals.bills.count })} <b className="tabular-nums">{money(d.totals.bills.totalPaise)}</b></span>
            <span>{t("pharmacyOffice.reports.debitNoteCount", { count: d.totals.debitNotes.count })} <b className="tabular-nums">{money(d.totals.debitNotes.totalPaise)}</b></span>
            <span>{t("pharmacyOffice.reports.creditNoteCount", { count: d.totals.creditNotes.count })} <b className="tabular-nums">{money(d.totals.creditNotes.totalPaise)}</b></span>
          </div>
          <Table testId="purchase-table" cols={cols} rows={d.rows} rowKey={(r) => `${r.kind}-${r.id}`} totals={totals}
            rowClass={(r) => (r.kind === "bill" ? "" : "text-red-700")}
            expand={(r) => r.lines.length === 0 ? <span className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.creditAnswers", { no: r.ref ?? "—" })}</span> : (
              <table className="w-full text-xs [&_td]:px-1.5 [&_th]:px-1.5">
                <thead><tr className="text-left text-muted-foreground"><th>{L("item")}</th><th>{L("hsn")}</th><th>{L("batch")}</th><th className="text-right">{L("qty")}</th><th className="text-right">{L("rate")}</th><th className="text-right">{L("taxable")}</th><th className="text-right">{L("gst")}</th></tr></thead>
                <tbody>{r.lines.map((l) => (
                  <tr key={`${l.itemId}-${l.batchNo ?? ""}`}><td>{l.itemName}</td><td>{l.hsnCode ?? "—"}</td><td>{l.batchNo ?? "—"}</td><td className="text-right">{l.qty} {l.uom}</td>
                    <td className="text-right">{money(l.ratePaise)}</td><td className="text-right">{money(l.taxablePaise)}</td><td className="text-right">{money(l.cgstPaise + l.sgstPaise + l.igstPaise)} ({l.gstRateBps / 100}%)</td></tr>
                ))}</tbody>
              </table>
            )} />
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 3. margin ═══════════════════════════════════

function MarginReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const [groupBy, setGroupBy] = useState<MarginGroupBy>("item");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "margin", range, groupBy], queryFn: () => fetchMargin(range, groupBy) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = NonNullable<typeof d>["rows"][number];
  const cols: Col<Row>[] = [
    { key: "label", label: t(`pharmacyOffice.reports.group.${groupBy}`), value: (r) => r.label },
    ...(groupBy === "item" ? [{ key: "sub", label: L("code"), value: (r: Row) => r.sub ?? "" }, { key: "qty", label: L("qty"), num: true, value: (r: Row) => r.qtyBase }] : []),
    { key: "revenue", label: L("revenue"), money: true, value: (r) => r.revenuePaise },
    { key: "cost", label: L("cost"), money: true, value: (r) => r.costPaise },
    { key: "margin", label: L("margin"), money: true, value: (r) => r.marginPaise },
    { key: "pct", label: L("marginPct"), value: (r) => pct(r.marginBps) },
  ];
  const totals: Totals | null = d === undefined ? null : {
    label: t("pharmacyOffice.reports.totals"), revenue: d.totals.revenuePaise, cost: d.totals.costPaise, margin: d.totals.marginPaise, pct: pct(d.totals.marginBps),
  };
  if (d !== undefined) sheet.current = { title: `${t("pharmacyOffice.reports.name.margin")} · ${t(`pharmacyOffice.reports.group.${groupBy}`)}`, subtitle: rangeText(d.from, d.to), file: `margin-${groupBy}-${d.from}-${d.to}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <RangeBar range={range} onChange={setRange} />
        <Choice label={L("groupBy")} testId="margin-group" value={groupBy} options={MARGIN_GROUPS} onChange={setGroupBy} text={(g) => t(`pharmacyOffice.reports.group.${g}`)} />
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.marginNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && <Table testId="margin-table" cols={cols} rows={d.rows} rowKey={(r) => r.key || "—"} totals={totals} />}
    </div>
  );
}

// ═══════════════════════════════════ 4. stock valuation ═══════════════════════════════════

function ValuationReport({ sheet }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [asOf, setAsOf] = useState(todayIst());
  const [store, setStore] = useState("");
  const [view, setView] = useState<"batch" | "item" | "store">("batch");
  const stores = useQuery({ queryKey: ["pharmacy", "reports", "stores"], queryFn: fetchReportStores });
  const q = useQuery({ queryKey: ["pharmacy", "reports", "valuation", asOf, store], queryFn: () => fetchValuation(asOf, store) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = NonNullable<typeof d>["rows"][number];
  type Group = NonNullable<typeof d>["byStore"][number];
  const batchCols: Col<Row>[] = [
    { key: "store", label: L("store"), value: (r) => r.storeCode },
    { key: "item", label: L("item"), value: (r) => r.itemName },
    { key: "code", label: L("code"), value: (r) => r.itemCode },
    { key: "batch", label: L("batch"), value: (r) => r.batchNo },
    { key: "expiry", label: L("expiry"), value: (r) => r.expiryDate ?? "—" },
    { key: "qty", label: L("qty"), num: true, value: (r) => r.qtyBase },
    { key: "uom", label: L("unit"), value: (r) => r.baseUom },
    { key: "rate", label: L("costPerUnit"), money: true, value: (r) => r.landedCostPaise },
    { key: "cost", label: L("costValue"), money: true, value: (r) => r.costValuePaise },
    { key: "mrp", label: L("mrpValue"), money: true, value: (r) => r.mrpValuePaise },
  ];
  const groupCols: Col<Group>[] = [
    { key: "store", label: view === "store" ? L("store") : L("item"), value: (g) => g.name },
    { key: "code", label: L("code"), value: (g) => g.code },
    { key: "batches", label: L("batches"), num: true, value: (g) => g.batches },
    ...(view === "item" ? [{ key: "qty", label: L("qty"), num: true, value: (g: Group) => g.qtyBase }] : []),
    { key: "cost", label: L("costValue"), money: true, value: (g) => g.costValuePaise },
    { key: "mrp", label: L("mrpValue"), money: true, value: (g) => g.mrpValuePaise },
  ];
  const totals: Totals | null = d === undefined ? null : { store: t("pharmacyOffice.reports.totals"), batches: d.totals.batches, cost: d.totals.costValuePaise, mrp: d.totals.mrpValuePaise };
  if (d !== undefined) {
    sheet.current = {
      title: t("pharmacyOffice.reports.name.valuation"), subtitle: t("pharmacyOffice.reports.asOfDay", { day: d.asOf }), file: `stock-valuation-${d.asOf}-${view}`,
      cols: (view === "batch" ? batchCols : groupCols) as Col<never>[], rows: view === "batch" ? d.rows : view === "item" ? d.byItem : d.byStore, totals,
    };
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">{L("asOf")} <input type="date" aria-label={L("asOf")} className="rounded border px-1" max={todayIst()} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <select aria-label={t("pharmacyOffice.reports.store")} className="rounded border px-1 py-0.5" value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">{t("pharmacyOffice.reports.allStores")}</option>
          {(stores.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <Choice label={L("view")} testId="valuation-view" value={view} options={["batch", "item", "store"] as const} onChange={setView} text={(v) => t(`pharmacyOffice.reports.valuationView.${v}`)} />
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.valuationNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <div className="flex flex-wrap gap-4 text-sm" data-testid="valuation-summary">
            <span>{L("costValue")} <b className="tabular-nums">{money(d.totals.costValuePaise)}</b></span>
            <span>{L("mrpValue")} <b className="tabular-nums">{money(d.totals.mrpValuePaise)}</b></span>
            {d.vendorOwned.batches > 0 && <span className="text-muted-foreground">{t("pharmacyOffice.reports.vendorOwned", { count: d.vendorOwned.batches })}</span>}
            {d.totals.noMrpBatches > 0 && <span className="text-muted-foreground">{t("pharmacyOffice.reports.noMrp", { count: d.totals.noMrpBatches })}</span>}
          </div>
          {view === "batch"
            ? <Table testId="valuation-table" cols={batchCols} rows={d.rows} rowKey={(r) => `${r.storeResourceId}-${r.batchId}`} totals={totals} />
            : <Table testId="valuation-table" cols={groupCols} rows={view === "item" ? d.byItem : d.byStore} rowKey={(g) => g.key} totals={totals} />}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 5. non-moving stock ═══════════════════════════════════

function NonMovingReport({ sheet }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(90);
  const [store, setStore] = useState("");
  const stores = useQuery({ queryKey: ["pharmacy", "reports", "stores"], queryFn: fetchReportStores });
  const q = useQuery({ queryKey: ["pharmacy", "reports", "non-moving", days, store], queryFn: () => fetchNonMoving(days, store) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = NonNullable<typeof d>["rows"][number];
  const cols: Col<Row>[] = [
    { key: "item", label: L("item"), value: (r) => r.itemName },
    { key: "batch", label: L("batch"), value: (r) => r.batchNo },
    { key: "expiry", label: L("expiry"), value: (r) => r.expiryDate ?? "—" },
    { key: "store", label: L("store"), value: (r) => r.storeCode },
    { key: "qty", label: L("qty"), num: true, value: (r) => r.qtyBase },
    { key: "cost", label: L("costValue"), money: true, value: (r) => r.costValuePaise },
    { key: "last", label: L("lastMoved"), value: (r) => (r.lastMovedAt === null ? t("pharmacyOffice.reports.never") : r.lastMovedAt.slice(0, 10)) },
    { key: "idle", label: L("idleDays"), num: true, value: (r) => r.idleDays },
    { key: "supplier", label: L("supplier"), value: (r) => r.supplierName },
    { key: "suggestion", label: L("agent"), value: (r) => t(`pharmacyOffice.reports.suggest.${r.suggestion}`) },
  ];
  const totals: Totals | null = d === undefined ? null : { item: t("pharmacyOffice.reports.totals"), cost: d.totals.costValuePaise };
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.nonMoving"), subtitle: t("pharmacyOffice.reports.idleSince", { days: d.days, since: d.since }), file: `non-moving-${String(d.days)}d-${d.asOf}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex gap-1" role="group" aria-label={L("idleDays")}>
          {NON_MOVING_DAYS.map((n) => <Button key={n} type="button" size="sm" data-testid={`days-${String(n)}`} variant={days === n ? "default" : "outline"} onClick={() => setDays(n)}>{t("pharmacyOffice.reports.days", { count: n })}</Button>)}
        </div>
        <select aria-label={t("pharmacyOffice.reports.store")} className="rounded border px-1 py-0.5" value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">{t("pharmacyOffice.reports.allStores")}</option>
          {(stores.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </div>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3 text-sm" data-testid="non-moving-agent">
            <span className="mr-2 rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
            {t("pharmacyOffice.reports.agentSays", { batches: d.totals.batches, value: money(d.totals.costValuePaise), back: money(d.totals.returnValuePaise), destroy: money(d.totals.writeOffValuePaise) })}
            {(d.totals.returnValuePaise > 0 || d.totals.writeOffValuePaise > 0) && (
              <a className="ml-2 underline" href="/pharmacy/office?view=returns">{t("pharmacyOffice.reports.openReturns")}</a>
            )}
          </section>
          <Table testId="non-moving-table" cols={cols} rows={d.rows} rowKey={(r) => `${r.storeResourceId}-${r.batchId}`} totals={totals}
            rowClass={(r) => (r.suggestion === "write_off" ? "text-red-700" : r.suggestion === "return" ? "text-amber-800" : "")} />
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 6. the HSN summary ═══════════════════════════════════

function HsnReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "hsn", range], queryFn: () => fetchHsn(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = NonNullable<typeof d>["rows"][number];
  const cols: Col<Row>[] = [
    { key: "hsn", label: L("hsn"), value: (r) => r.hsn },
    { key: "rate", label: L("gstRate"), value: (r) => (r.exempt ? t("pharmacyOffice.reports.exempt") : `${String(r.rateBps / 100)}%`) },
    { key: "uqc", label: L("uqc"), value: (r) => r.uqc },
    { key: "qty", label: L("qty"), num: true, value: (r) => r.qty },
    { key: "taxable", label: L("taxable"), money: true, value: (r) => r.taxablePaise },
    { key: "igst", label: L("igst"), money: true, value: (r) => r.igstPaise },
    { key: "cgst", label: L("cgst"), money: true, value: (r) => r.cgstPaise },
    { key: "sgst", label: L("sgst"), money: true, value: (r) => r.sgstPaise },
    { key: "tax", label: L("tax"), money: true, value: (r) => r.taxPaise },
    { key: "value", label: L("value"), money: true, value: (r) => r.valuePaise },
  ];
  const totals: Totals | null = d === undefined ? null : {
    hsn: t("pharmacyOffice.reports.totals"), qty: d.totals.qty, taxable: d.totals.taxablePaise, igst: d.totals.igstPaise, cgst: d.totals.cgstPaise,
    sgst: d.totals.sgstPaise, tax: d.totals.taxPaise, value: d.totals.valuePaise,
  };
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.hsn"), subtitle: rangeText(d.from, d.to), file: `hsn-summary-${d.from}-${d.to}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} />
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.hsnNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && <Table testId="hsn-table" cols={cols} rows={d.rows} rowKey={(r) => `${r.hsn}-${String(r.rateBps)}-${r.uqc}`} totals={totals} />}
    </div>
  );
}

// ═══════════════════════════════════ GSTR-3B from the books (GAP A4) ═══════════════════════════════════

/**
 * One table in the return's own order — 3.1(a), 3.1(c), 4(A)(5), 4(B)(2), 4(C), 6.1 — so E and P hand the
 * accountant the figures to key into the portal. Read-only: filing stays theirs.
 */
function Gstr3bReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "gstr3b", range], queryFn: () => fetchGstr3b(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  type Row = { key: string; section: string; what: string; taxable: number | null; igst: number | null; cgst: number | null; sgst: number | null; strong?: boolean };
  const G = (k: string, o?: Record<string, unknown>): string => t(`pharmacyOffice.reports.gstr3b.${k}`, o);
  const rows: Row[] = d === undefined ? [] : [
    ...d.outward.byRate.map((b) => ({ key: `r${String(b.rateBps)}`, section: "3.1(a)", what: G("outwardAt", { rate: b.rateBps / 100 }), taxable: b.taxablePaise, igst: 0, cgst: b.cgstPaise, sgst: b.sgstPaise })),
    { key: "a", section: "3.1(a)", what: G("outward"), taxable: d.outward.taxable.taxablePaise, igst: d.outward.taxable.igstPaise, cgst: d.outward.taxable.cgstPaise, sgst: d.outward.taxable.sgstPaise, strong: true },
    { key: "c", section: "3.1(c)", what: G("nilExempt"), taxable: d.outward.nilExempt.taxablePaise, igst: null, cgst: null, sgst: null },
    { key: "itc", section: "4(A)(5)", what: G("itcAvailable", { count: d.itc.bills }), taxable: d.itc.available.taxablePaise, igst: d.itc.available.igstPaise, cgst: d.itc.available.cgstPaise, sgst: d.itc.available.sgstPaise },
    { key: "rev", section: "4(B)(2)", what: G("itcReversed", { count: d.itc.debitNotes }), taxable: d.itc.reversed.taxablePaise, igst: d.itc.reversed.igstPaise, cgst: d.itc.reversed.cgstPaise, sgst: d.itc.reversed.sgstPaise },
    { key: "net", section: "4(C)", what: G("itcNet"), taxable: null, igst: d.itc.net.igstPaise, cgst: d.itc.net.cgstPaise, sgst: d.itc.net.sgstPaise, strong: true },
    { key: "byIgst", section: "6.1", what: G("paidByIgst"), taxable: null, igst: d.payable.igst.byIgstPaise, cgst: d.payable.cgst.byIgstPaise, sgst: d.payable.sgst.byIgstPaise },
    { key: "byOwn", section: "6.1", what: G("paidByOwn"), taxable: null, igst: d.payable.igst.byOwnPaise, cgst: d.payable.cgst.byOwnPaise, sgst: d.payable.sgst.byOwnPaise },
    { key: "cash", section: "6.1", what: G("cash"), taxable: null, igst: d.payable.igst.cashPaise, cgst: d.payable.cgst.cashPaise, sgst: d.payable.sgst.cashPaise, strong: true },
    { key: "carry", section: "", what: G("carry"), taxable: null, igst: d.payable.igst.carryForwardPaise, cgst: d.payable.cgst.carryForwardPaise, sgst: d.payable.sgst.carryForwardPaise },
  ];
  const cols: Col<Row>[] = [
    { key: "section", label: G("section"), value: (r) => r.section },
    { key: "what", label: G("what"), value: (r) => r.what },
    { key: "taxable", label: L("taxable"), money: true, value: (r) => r.taxable },
    { key: "igst", label: L("igst"), money: true, value: (r) => r.igst },
    { key: "cgst", label: L("cgst"), money: true, value: (r) => r.cgst },
    { key: "sgst", label: L("sgst"), money: true, value: (r) => r.sgst },
  ];
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.gstr3b"), subtitle: rangeText(d.from, d.to), file: `gstr3b-${d.from}-${d.to}`, cols: cols as Col<never>[], rows, totals: null };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} />
      <p className="text-xs text-muted-foreground">{G("note")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <Table testId="gstr3b-table" cols={cols} rows={rows} rowKey={(r) => r.key} totals={null} rowClass={(r) => (r.strong === true ? "font-semibold" : "")} />
          <p className="text-sm font-medium" data-testid="gstr3b-cash">{G("cashTotal", { amount: money(d.payable.cashPaise) })}</p>
          {d.creditNotesUnsplitPaise > 0 && <p className="text-sm text-amber-700">{G("creditNotes", { amount: money(d.creditNotesUnsplitPaise) })}</p>}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 7. GSTR-2B against the books ═══════════════════════════════════

function Gstr2bReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const [result, setResult] = useState<WireGstr2b | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bucket, setBucket] = useState<ReconBucket | null>(null);
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const onFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setBusy(true); setError(null);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
        reader.readAsText(file);
      });
      const csv = /\.csv$/i.test(file.name) || !/^\s*[{[]/.test(text);
      setResult(await reconcileGstr2b({ format: csv ? "csv" : "json", content: csv ? text : trimGstr2bJson(text), preset: range.preset, from: range.from, to: range.to }));
      setBucket(null);
    } catch (e) {
      setError(e instanceof SyntaxError ? t("pharmacyErrors.gst_statement_unreadable") : pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  type Row = WireGstr2b["rows"][number];
  const tax = (m: { igstPaise: number; cgstPaise: number; sgstPaise: number } | null): number | null => (m === null ? null : m.igstPaise + m.cgstPaise + m.sgstPaise);
  const cols: Col<Row>[] = [
    { key: "bucket", label: L("result"), value: (r) => t(`pharmacyOffice.reports.bucket.${r.bucket}`) },
    { key: "supplier", label: L("supplier"), value: (r) => r.supplier },
    { key: "gstin", label: L("gstin"), value: (r) => r.gstin },
    { key: "invoice", label: L("invoiceNo"), value: (r) => r.invoiceNo },
    { key: "ourNo", label: L("ourNo"), value: (r) => r.books?.billNo ?? "—" },
    { key: "date2b", label: L("date2b"), value: (r) => r.twoB?.date ?? "—" },
    { key: "dateBooks", label: L("dateBooks"), value: (r) => r.books?.date ?? "—" },
    { key: "taxable2b", label: L("taxable2b"), money: true, value: (r) => r.twoB?.taxablePaise ?? null },
    { key: "taxableBooks", label: L("taxableBooks"), money: true, value: (r) => r.books?.taxablePaise ?? null },
    { key: "tax2b", label: L("tax2b"), money: true, value: (r) => tax(r.twoB) },
    { key: "taxBooks", label: L("taxBooks"), money: true, value: (r) => tax(r.books) },
    { key: "diff", label: L("differs"), value: (r) => r.diffs.map((x) => t(`pharmacyOffice.reports.diffField.${x.field}`)).join(", ") },
  ];
  const rows = result === null ? [] : result.rows.filter((r) => bucket === null || r.bucket === bucket);
  const totals: Totals | null = result === null ? null : {
    bucket: t("pharmacyOffice.reports.totals"), taxable2b: result.totals.twoB.taxablePaise, taxableBooks: result.totals.books.taxablePaise,
    tax2b: tax(result.totals.twoB), taxBooks: tax(result.totals.books),
  };
  if (result !== null) sheet.current = { title: t("pharmacyOffice.reports.name.gstr2b"), subtitle: `${result.period ?? rangeText(result.from, result.to)}`, file: `gstr2b-reconciliation-${result.from}-${result.to}`, cols: cols as Col<never>[], rows, totals };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} store={false} />
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t("pharmacyOffice.reports.upload2b")}</span>
        <input type="file" accept=".json,.csv,application/json,text/csv" data-testid="gstr2b-file" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
      </label>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.upload2bNote")}</p>
      {busy && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.reports.loading")}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {result !== null && (
        <>
          <div className="grid gap-2 sm:grid-cols-4" data-testid="gstr2b-counts">
            {RECON_BUCKETS.map((b) => (
              <button key={b} type="button" data-testid={`bucket-${b}`} className={`rounded border p-2 text-left hover:bg-muted ${bucket === b ? "ring-2 ring-sky-600" : ""} ${b !== "matched" && result.counts[b] > 0 ? "border-amber-400" : ""}`}
                onClick={() => setBucket(bucket === b ? null : b)}>
                <div className="text-xl font-semibold tabular-nums">{result.counts[b]}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.reports.bucket.${b}`)}</div>
              </button>
            ))}
          </div>
          {result.notes.count > 0 && <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.notesApart", { count: result.notes.count, value: money(result.notes.valuePaise) })}</p>}
          <Table testId="gstr2b-table" cols={cols} rows={rows} rowKey={(r) => `${r.bucket}-${r.gstin}-${r.invoiceNo}-${r.books?.billId ?? ""}`} totals={totals}
            rowClass={(r) => (r.bucket === "matched" ? "" : "text-amber-900")} />
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ 8. activity, and what changed ═══════════════════════════════════

function ActivityReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "week");
  const [no, setNo] = useState("");
  const [doc, setDoc] = useState<WireActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** STAGE C — the entry whose two versions are shown side by side. */
  const [compare, setCompare] = useState<number | null>(null);
  const feed = useQuery({ queryKey: ["pharmacy", "reports", "activity", range], queryFn: () => fetchActivityFeed(range) });
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const open = async (docNo: string): Promise<void> => {
    if (docNo.trim() === "") return;
    setError(null);
    try { setDoc(await fetchActivity(docNo.trim())); setNo(docNo.trim()); setCompare(null); } catch (e) { setDoc(null); setError(pharmacyErrorText(e, t)); }
  };
  type FeedRow = NonNullable<typeof feed.data>["rows"][number];
  const feedCols: Col<FeedRow>[] = [
    { key: "at", label: L("time"), value: (r) => new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }) },
    { key: "doc", label: L("docNo"), value: (r) => r.docNo },
    { key: "what", label: L("event"), value: (r) => t(`pharmacyOffice.reports.event.${r.name.replace(".", "_")}`, { defaultValue: r.name }) },
    { key: "who", label: L("by"), value: (r) => r.actorName },
    { key: "amount", label: L("amount"), money: true, value: (r) => r.amountPaise },
  ];
  const fmt = (field: string, v: string | number | boolean | null): string =>
    v === null ? "—" : typeof v === "number" && /Paise$/.test(field) ? money(v) : typeof v === "number" && /Bps$/.test(field) ? `${String(v / 100)}%` : field === "status" ? String(v).replace(/_/g, " ") : String(v);
  if (doc === null && feed.data !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.activity"), subtitle: rangeText(feed.data.from, feed.data.to), file: `activity-${feed.data.from}-${feed.data.to}`, cols: feedCols as Col<never>[], rows: feed.data.rows, totals: null };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <RangeBar range={range} onChange={setRange} store={false} />
        <form className="flex items-center gap-1 text-sm" onSubmit={(e) => { e.preventDefault(); void open(no); }}>
          <input aria-label={L("docNo")} placeholder={t("pharmacyOffice.reports.docNoHint")} className="w-56 rounded border px-2 py-0.5" value={no} onChange={(e) => setNo(e.target.value)} data-testid="activity-no" />
          <Button type="submit" size="sm">{t("pharmacyOffice.reports.open")}</Button>
        </form>
      </div>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {doc !== null ? (
        <section className="space-y-2" data-testid="activity-timeline">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 font-medium">{doc.no} · {doc.label}</h3>
            <Button type="button" size="sm" variant="outline" onClick={() => setDoc(null)}>{t("pharmacyOffice.reports.backToFeed")}</Button>
          </div>
          <ol className="space-y-2">
            {doc.entries.map((e, i) => (
              <li key={`${e.at}-${String(i)}`} className="rounded border p-2 text-sm" data-testid={`activity-entry-${String(i)}`}>
                <div className="flex flex-wrap gap-2">
                  <span className="font-medium">{t(`pharmacyOffice.reports.event.${e.name.replace(".", "_")}`, { defaultValue: e.name })}</span>
                  {e.status !== null && <span className="rounded bg-muted px-1 text-xs">{e.status.replace(/_/g, " ")}</span>}
                  <span className="flex-1 text-xs text-muted-foreground">{e.actorName} · {new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
                  {e.changes.length > 0 && e.state !== undefined && (
                    <Button type="button" size="sm" variant={compare === i ? "default" : "outline"} data-testid={`activity-compare-${String(i)}`} aria-pressed={compare === i}
                      onClick={() => setCompare(compare === i ? null : i)}>
                      {t("pharmacyOffice.reports.sideBySide")}
                    </Button>
                  )}
                </div>
                {Object.keys(e.facts).length > 0 && (
                  <div className="text-xs text-muted-foreground">{Object.entries(e.facts).map(([k, v]) => `${k}: ${fmt(k, v)}`).join(" · ")}</div>
                )}
                {e.changes.length > 0 && (
                  <table className="mt-1 w-full max-w-3xl text-xs [&_td]:px-1.5 [&_th]:px-1.5" data-testid={`activity-changes-${String(i)}`}>
                    <thead><tr className="text-left text-muted-foreground"><th>{L("field")}</th><th>{L("before")}</th><th>{L("after")}</th></tr></thead>
                    <tbody>{e.changes.map((c) => (
                      <tr key={c.field}><td>{c.label}</td><td className="bg-red-50 line-through decoration-red-400">{fmt(c.field, c.before)}</td><td className="bg-green-50">{fmt(c.field, c.after)}</td></tr>
                    ))}</tbody>
                  </table>
                )}
                {compare === i && <VersionsSideBySide doc={doc} i={i} fmt={fmt} />}
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <>
          <Status loading={feed.isLoading} error={feed.error} />
          {feed.data !== undefined && (
            <ul className="divide-y rounded border" data-testid="activity-feed">
              {feed.data.rows.length === 0 && <li className="p-2 text-sm text-muted-foreground">{t("pharmacyOffice.reports.empty")}</li>}
              {feed.data.rows.map((r, i) => (
                <li key={`${r.at}-${String(i)}`}>
                  <button type="button" className="flex w-full flex-wrap gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => void open(r.docNo ?? "")}>
                    <span className="w-32 text-xs text-muted-foreground">{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" })}</span>
                    <span className="font-mono text-xs">{r.docNo}</span>
                    <span className="flex-1">{t(`pharmacyOffice.reports.event.${r.name.replace(".", "_")}`, { defaultValue: r.name })}</span>
                    <span className="text-xs text-muted-foreground">{r.actorName}</span>
                    <span className="tabular-nums">{money(r.amountPaise)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ STAGE C — top-selling items ═══════════════════════════════════

const ABC_TONE: Record<AbcClass, string> = { A: "bg-emerald-800 text-white", B: "bg-amber-600 text-white", C: "bg-slate-400 text-white" };

function TopSellingReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const [by, setBy] = useState<"value" | "units">("value");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "top-selling", range], queryFn: () => fetchTopSelling(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const cols: Col<WireTopSellingRow>[] = [
    { key: "rank", label: L("rank"), num: true, value: (r) => r.rank },
    { key: "code", label: L("code"), value: (r) => r.itemCode },
    { key: "item", label: L("item"), value: (r) => r.itemName },
    { key: "qty", label: L("qty"), num: true, value: (r) => r.qtyBase },
    { key: "unitShare", label: L("unitShare"), num: true, value: (r) => pct(r.unitShareBps) },
    { key: "value", label: L("salesValue"), money: true, value: (r) => r.valuePaise },
    { key: "valueShare", label: L("valueShare"), num: true, value: (r) => pct(r.valueShareBps) },
    { key: "cumulative", label: L("cumulative"), num: true, value: (r) => pct(r.cumulativeValueBps) },
    { key: "abc", label: L("abc"), value: (r) => r.abc },
  ];
  const rows = d === undefined ? [] : by === "value" ? d.byValue : d.byUnits;
  const totals: Totals | null = d === undefined ? null : { rank: null, item: t("pharmacyOffice.reports.allItems", { count: d.totals.items }), qty: d.totals.qtyBase, value: d.totals.valuePaise };
  if (d !== undefined) {
    sheet.current = {
      title: `${t("pharmacyOffice.reports.name.topSelling")} · ${t(`pharmacyOffice.reports.topBy.${by}`)}`, subtitle: rangeText(d.from, d.to),
      file: `top-selling-${by}-${d.from}-${d.to}`, cols: cols as Col<never>[], rows, totals,
    };
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <RangeBar range={range} onChange={setRange} />
        <Choice label={L("rankBy")} testId="top-by" value={by} options={["value", "units"] as const} onChange={setBy} text={(v) => t(`pharmacyOffice.reports.topBy.${v}`)} />
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.topNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <div className="grid gap-2 sm:grid-cols-3" data-testid="abc-classes">
            {(["A", "B", "C"] as const).map((c) => (
              <div key={c} className="flex items-center gap-2 rounded border p-2 text-sm" data-testid={`abc-${c}`}>
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${ABC_TONE[c]}`}>{c}</span>
                <span className="flex-1">{t(`pharmacyOffice.reports.abc.${c}`, { count: d.classes[c].items })}</span>
                <b className="tabular-nums">{money(d.classes[c].valuePaise)}</b>
              </div>
            ))}
          </div>
          <Table testId="top-table" cols={cols} rows={rows} rowKey={(r) => r.itemId} totals={totals} />
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ STAGE C — the loss-booking register ═══════════════════════════════════

function LossReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "month");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "losses", range], queryFn: () => fetchLossRegister(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const reason = (r: string): string => t(`pharmacyOffice.reports.lossReason.${r}`, { defaultValue: r });
  const cols: Col<WireLossRow>[] = [
    { key: "date", label: L("date"), value: (r) => r.date },
    { key: "no", label: L("docNo"), value: (r) => r.docNo ?? t("pharmacyOffice.reports.countVariance") },
    { key: "store", label: L("store"), value: (r) => r.storeCode },
    { key: "item", label: L("item"), value: (r) => r.itemName },
    { key: "batch", label: L("batch"), value: (r) => r.batchNo },
    { key: "expiry", label: L("expiry"), value: (r) => r.expiryDate ?? "—" },
    { key: "qty", label: L("qty"), num: true, value: (r) => r.qtyBase },
    { key: "value", label: L("costLost"), money: true, value: (r) => r.valuePaise },
    { key: "reason", label: L("reason"), value: (r) => reason(r.reason) },
    { key: "approvedBy", label: L("approvedBy"), value: (r) => r.approvedBy ?? "—" },
    { key: "disposal", label: L("disposal"), value: (r) => (r.disposalAgency === null ? "—" : `${r.disposalAgency} · ${r.manifestNo ?? ""}`) },
  ];
  const totals: Totals | null = d === undefined ? null : { date: t("pharmacyOffice.reports.totals"), qty: d.totals.qtyBase, value: d.totals.valuePaise };
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.losses"), subtitle: rangeText(d.from, d.to), file: `loss-register-${d.from}-${d.to}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} />
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <>
          <div className="flex flex-wrap gap-2 text-sm" data-testid="loss-by-reason">
            {d.byReason.map((g) => (
              <span key={g.reason} className="rounded border px-2 py-1" data-testid={`loss-reason-${g.reason}`}>
                {reason(g.reason)} · {t("pharmacyOffice.reports.lossLines", { count: g.lines })} · <b className="tabular-nums">{money(g.valuePaise)}</b>
              </span>
            ))}
            <span className="rounded border border-red-300 bg-red-50 px-2 py-1 font-medium">{L("costLost")} <b className="tabular-nums">{money(d.totals.valuePaise)}</b></span>
          </div>
          <Table testId="loss-table" cols={cols} rows={d.rows} rowKey={(r) => `${r.source}-${r.docId}-${r.batchId}`} totals={totals} />
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════ STAGE C — daily stock ═══════════════════════════════════

function DailyStockReport({ sheet, presetRef }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [range, setRange] = useRange(presetRef, "today");
  const q = useQuery({ queryKey: ["pharmacy", "reports", "daily-stock", range], queryFn: () => fetchDailyStock(range) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const cols: Col<WireDailyStockRow>[] = [
    { key: "item", label: L("item"), value: (r) => r.itemName },
    { key: "code", label: L("code"), value: (r) => r.itemCode },
    { key: "uom", label: L("unit"), value: (r) => r.baseUom },
    { key: "opening", label: L("opening"), num: true, value: (r) => r.openingQty },
    ...STOCK_IN_KINDS.map((k): Col<WireDailyStockRow> => ({ key: `in.${k}`, label: t(`pharmacyOffice.reports.stockIn.${k}`), num: true, value: (r) => r.in[k] })),
    { key: "inQty", label: L("totalIn"), num: true, value: (r) => r.inQty },
    ...STOCK_OUT_KINDS.map((k): Col<WireDailyStockRow> => ({ key: `out.${k}`, label: t(`pharmacyOffice.reports.stockOut.${k}`), num: true, value: (r) => r.out[k] })),
    { key: "outQty", label: L("totalOut"), num: true, value: (r) => r.outQty },
    { key: "closing", label: L("closing"), num: true, value: (r) => r.closingQty },
  ];
  const totals: Totals | null = d === undefined ? null : {
    item: t("pharmacyOffice.reports.totals"), opening: d.totals.openingQty, inQty: d.totals.inQty, outQty: d.totals.outQty, closing: d.totals.closingQty,
    ...Object.fromEntries(STOCK_IN_KINDS.map((k) => [`in.${k}`, d.rows.reduce((s, r) => s + r.in[k], 0)])),
    ...Object.fromEntries(STOCK_OUT_KINDS.map((k) => [`out.${k}`, d.rows.reduce((s, r) => s + r.out[k], 0)])),
  };
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.dailyStock"), subtitle: `${rangeText(d.from, d.to)}${range.store === "" ? "" : ` · ${range.store}`}`, file: `daily-stock-${range.store || "all"}-${d.from}-${d.to}`, cols: cols as Col<never>[], rows: d.rows, totals };
  return (
    <div className="space-y-3">
      <RangeBar range={range} onChange={setRange} />
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.dailyStockNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && (
        <Table testId="daily-stock-table" cols={cols} rows={d.rows} rowKey={(r) => r.itemId} totals={totals}
          rowClass={(r) => (r.openingQty + r.inQty - r.outQty !== r.closingQty ? "bg-red-50 text-red-700" : "")} />
      )}
    </div>
  );
}

// ═══════════════════════════════════ STAGE C — the item catalogue ═══════════════════════════════════

function CatalogueReport({ sheet }: Bind): React.ReactElement {
  const { t } = useTranslation();
  const [store, setStore] = useState("");
  const [find, setFind] = useState("");
  const stores = useQuery({ queryKey: ["pharmacy", "reports", "stores"], queryFn: fetchReportStores });
  const q = useQuery({ queryKey: ["pharmacy", "reports", "catalogue", store], queryFn: () => fetchCatalogue(store) });
  const d = q.data;
  const L = (k: string): string => t(`pharmacyOffice.reports.col.${k}`);
  const yes = (b: boolean): string => (b ? t("pharmacyOffice.reports.yes") : "");
  const one = store !== "";
  const level = (r: WireCatalogueRow): WireCatalogueRow["levels"][number] | null => r.levels[0] ?? null;
  const cols: Col<WireCatalogueRow>[] = [
    { key: "code", label: L("code"), value: (r) => r.code },
    { key: "name", label: L("item"), value: (r) => r.name },
    { key: "class", label: L("class"), value: (r) => r.class },
    { key: "hsn", label: L("hsn"), value: (r) => r.hsnCode ?? "—" },
    { key: "gst", label: L("gstRate"), value: (r) => (r.gstRateBps === null ? "—" : `${String(r.gstRateBps / 100)}%`) },
    { key: "schedule", label: L("schedule"), value: (r) => r.schedule ?? "—" },
    { key: "storage", label: L("storage"), value: (r) => t(`pharmacyOffice.reports.storage.${r.storageClass}`, { defaultValue: r.storageClass }) },
    { key: "manufacturer", label: L("manufacturer"), value: (r) => r.manufacturer ?? "—" },
    { key: "lead", label: L("leadDays"), num: true, value: (r) => r.leadTimeDays },
    { key: "lasa", label: L("lasa"), value: (r) => yes(r.lasa) },
    { key: "highAlert", label: L("highAlert"), value: (r) => yes(r.highAlert) },
    { key: "packs", label: L("packs"), value: (r) => [`1 ${r.baseUom}`, ...r.packs.map((p) => `${p.uom} = ${String(p.toBase)}`)].join(" · ") },
    ...(one ? [
      { key: "min", label: L("min"), num: true, value: (r: WireCatalogueRow) => level(r)?.minBase ?? null },
      { key: "reorder", label: L("reorder"), num: true, value: (r: WireCatalogueRow) => level(r)?.reorderBase ?? null },
      { key: "max", label: L("max"), num: true, value: (r: WireCatalogueRow) => level(r)?.maxBase ?? null },
    ] : [
      { key: "levels", label: L("levels"), value: (r: WireCatalogueRow) => r.levels.map((l) => `${l.storeCode} ${String(l.minBase)}/${String(l.reorderBase)}/${String(l.maxBase)}`).join(" · ") || "—" },
    ]),
    { key: "rack", label: L("rack"), value: (r) => r.racks.map((x) => (one ? x.location : `${x.storeCode} ${x.location}`)).join(" · ") || "—" },
  ];
  const needle = find.trim().toLowerCase();
  const rows = d === undefined ? [] : needle === "" ? d.rows : d.rows.filter((r) => r.code.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle));
  if (d !== undefined) sheet.current = { title: t("pharmacyOffice.reports.name.catalogue"), subtitle: `${todayIst()}${one ? ` · ${store}` : ""}`, file: `item-catalogue-${store || "all"}-${todayIst()}`, cols: cols as Col<never>[], rows, totals: null };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select aria-label={t("pharmacyOffice.reports.store")} className="rounded border px-1 py-0.5" value={store} onChange={(e) => setStore(e.target.value)} data-testid="catalogue-store">
          <option value="">{t("pharmacyOffice.reports.allStores")}</option>
          {(stores.data ?? []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <input aria-label={t("pharmacyOffice.reports.findItem")} placeholder={t("pharmacyOffice.reports.findItem")} className="w-56 max-w-full rounded border px-2 py-0.5" value={find} onChange={(e) => setFind(e.target.value)} data-testid="catalogue-find" />
        {d !== undefined && <span className="text-muted-foreground">{t("pharmacyOffice.reports.itemCount", { count: rows.length })}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.reports.catalogueNote")}</p>
      <Status loading={q.isLoading} error={q.error} />
      {d !== undefined && <Table testId="catalogue-table" cols={cols} rows={rows} rowKey={(r) => r.id} totals={null}
        rowClass={(r) => (r.highAlert ? "text-red-800" : r.lasa ? "text-amber-800" : "")} />}
    </div>
  );
}

// ═══════════════════════════════════ STAGE C — two versions of a document, side by side ═══════════════════════════════════

type Scalar = string | number | boolean | null;

/**
 * The document before and after one entry of its timeline (Healthray s17): the version before is the
 * previous entry's state with this entry's own `before` values laid over it; the version after is the
 * entry's state. Every field either version has is listed, in the same order on both sides, and a
 * field that changed is marked on both.
 */
export function versionsOf(doc: WireActivity, i: number): { fields: string[]; before: Record<string, Scalar>; after: Record<string, Scalar>; changed: Set<string> } | null {
  const e = doc.entries[i];
  if (e === undefined || e.state === undefined) return null;
  const before: Record<string, Scalar> = { ...(i > 0 ? doc.entries[i - 1]!.state ?? {} : {}) };
  for (const c of e.changes) before[c.field] = c.before;
  const after = e.state;
  const all = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const lineField = (f: string): boolean => f.startsWith("lines.");
  const fields = [...all.filter((f) => f === "status"), ...all.filter((f) => f !== "status" && !lineField(f)), ...all.filter(lineField).sort()];
  const changed = new Set(fields.filter((f) => (before[f] ?? null) !== (after[f] ?? null)));
  return { fields, before, after, changed };
}

function VersionsSideBySide({ doc, i, fmt }: { doc: WireActivity; i: number; fmt: (field: string, v: Scalar) => string }): React.ReactElement | null {
  const { t } = useTranslation();
  const v = versionsOf(doc, i);
  if (v === null) return null;
  const e = doc.entries[i]!;
  const prev = i > 0 ? doc.entries[i - 1]! : null;
  const label = (f: string): string => doc.labels?.[f] ?? e.changes.find((c) => c.field === f)?.label ?? f;
  const when = (x: WireActivityEntry): string => new Date(x.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" });
  const event = (x: WireActivityEntry): string => t(`pharmacyOffice.reports.event.${x.name.replace(".", "_")}`, { defaultValue: x.name });
  const side = (which: "before" | "after"): React.ReactElement => {
    const values = which === "before" ? v.before : v.after;
    const head = which === "before"
      ? (prev === null ? t("pharmacyOffice.reports.versionNone") : `${event(prev)} · ${when(prev)}`)
      : `${event(e)} · ${when(e)}`;
    return (
      <div className="min-w-0 rounded border" data-testid={`version-${which}`}>
        <div className={`border-b px-2 py-1 text-xs font-medium ${which === "before" ? "bg-red-50" : "bg-green-50"}`}>
          {t(`pharmacyOffice.reports.version.${which}`)} <span className="font-normal text-muted-foreground">· {head}</span>
        </div>
        <table className="w-full text-xs [&_td]:px-2 [&_td]:py-0.5">
          <tbody>
            {v.fields.map((f) => {
              const moved = v.changed.has(f);
              const has = Object.prototype.hasOwnProperty.call(values, f);
              return (
                <tr key={f} data-testid={`version-${which}-${f}`} data-changed={moved ? "yes" : "no"} className={moved ? (which === "before" ? "bg-red-50" : "bg-green-50 font-medium") : ""}>
                  <td className="w-1/2 break-words text-muted-foreground">{label(f)}</td>
                  <td className={`break-words tabular-nums ${moved && which === "before" ? "line-through decoration-red-400" : ""}`}>{has ? fmt(f, values[f] ?? null) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2" data-testid={`activity-versions-${String(i)}`}>
      {side("before")}
      {side("after")}
    </div>
  );
}
