import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtPaise } from "../lib/format";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { LabMetricsPanel, PeriodPicker, QueryState, Table, Time, usePeriodRange } from "./lab-metrics";
import type { LabTiming } from "./lab-metrics";

/**
 * HOSPITAL NUMBERS (owner 2026-10-13, #777) — one read-only screen, a tab per department: Lab (the
 * Lab numbers of #768, unchanged), Imaging and Pharmacy. A tab is shown only to a holder of its
 * permission; with none of the three there is nothing here. The server says what each figure is
 * anchored on (`modules/{lab,radiology,pharmacy}/metrics.ts`); this screen only lays it out. Money
 * comes as paise and is shown in rupees, Indian grouping. A figure the server did not send is a dash.
 */
export type NumbersTab = "lab" | "imaging" | "pharmacy";
export const NUMBERS_TABS: readonly NumbersTab[] = ["lab", "imaging", "pharmacy"];
export const TAB_PERMISSION: Record<NumbersTab, string> = {
  lab: "lab.metrics.read",
  imaging: "radiology.metrics.read",
  pharmacy: "pharmacy.metrics.read",
};

type ImagingCounts = { orders: number | null; studies: number | null; signed: number | null; delivered: number | null };
export type WireImagingMetrics = {
  from: string;
  to: string;
  totals: ImagingCounts;
  bySource: (ImagingCounts & { source: "opd" | "ipd" | "walk_in" })[];
  byModality: (ImagingCounts & { modality: string })[];
  times: { placedToDone: LabTiming; doneToSigned: LabTiming; signedToDelivered: LabTiming; placedToSigned: LabTiming };
};

export type WirePharmacyMetrics = {
  from: string;
  to: string;
  bills: number;
  salesPaise: number;
  returnsPaise: number;
  netPaise: number;
  prescriptions: { received: number; full: number; part: number; none: number };
  receivedToDispensed: LabTiming;
  topItems: { itemId: string; itemCode: string; itemName: string; qtyBase: number; amountPaise: number }[];
  purchases: { grns: number; valuePaise: number };
  margin?: { revenuePaise: number; costPaise: number; profitPaise: number; marginBps: number | null };
};

const DASH = <span style={{ color: "var(--faint)" }}>—</span>;
const count = (n: number | null | undefined): React.ReactNode => (n === null || n === undefined ? DASH : n);
const money = (p: number | null | undefined): React.ReactNode => (p === null || p === undefined ? DASH : fmtPaise(p));
const percent = (bps: number | null | undefined): React.ReactNode => (bps === null || bps === undefined ? DASH : `${(bps / 100).toFixed(2)}%`);

const IMAGING_COLS = ["orders", "studies", "signed", "delivered"] as const;
const IMAGING_STEPS = ["placedToDone", "doneToSigned", "signedToDelivered", "placedToSigned"] as const;

function ImagingPanel({ range, valid }: { range: { from: string; to: string }; valid: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["radiology", "metrics", range.from, range.to],
    queryFn: () => api<WireImagingMetrics>("GET", `/radiology/metrics?from=${range.from}&to=${range.to}`),
    enabled: valid,
  });
  const m = q.data;
  const counts = (c: ImagingCounts): React.ReactNode[] => IMAGING_COLS.map((k) => count(c[k]));
  const head = (first: string): string[] => [first, ...IMAGING_COLS.map((k) => t(`hospitalNumbers.imaging.cols.${k}`))];
  return (
    <>
      <QueryState valid={valid} isLoading={q.isLoading} isError={q.isError} />
      {m === undefined ? null : (
        <>
          <Table
            testId="imaging-metrics-source" title={t("hospitalNumbers.imaging.bySource")}
            head={head(t("hospitalNumbers.imaging.cols.source"))}
            rows={[
              ...m.bySource.map((s) => [t(`labMetrics.sources.${s.source}`), ...counts(s)]),
              [<strong key="total">{t("labMetrics.total")}</strong>, ...counts(m.totals)],
            ]}
          />
          <Table
            testId="imaging-metrics-modality" title={t("hospitalNumbers.imaging.byModality")}
            head={head(t("hospitalNumbers.imaging.cols.modality"))}
            rows={m.byModality.map((r) => [t(`hospitalNumbers.imaging.modalities.${r.modality}`, { defaultValue: r.modality }), ...counts(r)])}
          />
          <Table
            testId="imaging-metrics-times" title={t("hospitalNumbers.imaging.times")}
            head={[t("labMetrics.cols.step"), t("labMetrics.cols.time")]}
            rows={IMAGING_STEPS.map((k) => [t(`hospitalNumbers.imaging.steps.${k}`), <Time key={k} t={m.times[k]} />])}
          />
        </>
      )}
    </>
  );
}

function PharmacyPanel({ range, valid }: { range: { from: string; to: string }; valid: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["pharmacy", "metrics", range.from, range.to],
    queryFn: () => api<WirePharmacyMetrics>("GET", `/pharmacy/metrics?from=${range.from}&to=${range.to}`),
    enabled: valid,
  });
  const m = q.data;
  const row = (key: string, value: React.ReactNode): React.ReactNode[] => [t(`hospitalNumbers.pharmacy.rows.${key}`), value];
  return (
    <>
      <QueryState valid={valid} isLoading={q.isLoading} isError={q.isError} />
      {m === undefined ? null : (
        <>
          <Table
            testId="pharmacy-metrics-sales" title={t("hospitalNumbers.pharmacy.sales")}
            head={[t("hospitalNumbers.pharmacy.cols.figure"), t("hospitalNumbers.pharmacy.cols.value")]}
            rows={[
              row("bills", count(m.bills)),
              row("sales", money(m.salesPaise)),
              row("returns", money(m.returnsPaise)),
              row("net", <strong key="net">{money(m.netPaise)}</strong>),
              ...(m.margin === undefined ? [] : [
                row("revenue", money(m.margin.revenuePaise)),
                row("cost", money(m.margin.costPaise)),
                row("profit", money(m.margin.profitPaise)),
                row("margin", percent(m.margin.marginBps)),
              ]),
            ]}
          />
          <Table
            testId="pharmacy-metrics-rx" title={t("hospitalNumbers.pharmacy.rx")}
            head={[t("hospitalNumbers.pharmacy.cols.figure"), t("hospitalNumbers.pharmacy.cols.value")]}
            rows={[
              row("received", count(m.prescriptions.received)),
              row("full", count(m.prescriptions.full)),
              row("part", count(m.prescriptions.part)),
              row("none", count(m.prescriptions.none)),
              row("time", <Time key="time" t={m.receivedToDispensed} />),
            ]}
          />
          <Table
            testId="pharmacy-metrics-top" title={t("hospitalNumbers.pharmacy.top")}
            head={[t("hospitalNumbers.pharmacy.cols.item"), t("hospitalNumbers.pharmacy.cols.qty"), t("hospitalNumbers.pharmacy.cols.amount")]}
            rows={m.topItems.map((i) => [i.itemName, count(i.qtyBase), money(i.amountPaise)])}
          />
          <Table
            testId="pharmacy-metrics-purchases" title={t("hospitalNumbers.pharmacy.purchases")}
            head={[t("hospitalNumbers.pharmacy.cols.figure"), t("hospitalNumbers.pharmacy.cols.value")]}
            rows={[row("grns", count(m.purchases.grns)), row("value", money(m.purchases.valuePaise))]}
          />
        </>
      )}
    </>
  );
}

export function HospitalNumbers({ initialTab }: { initialTab?: NumbersTab }): React.ReactElement {
  const { t } = useTranslation();
  const { can, ready } = useAuth();
  const state = usePeriodRange();
  const [chosen, setChosen] = useState<NumbersTab | undefined>(initialTab);
  const tabs = NUMBERS_TABS.filter((k) => can(TAB_PERMISSION[k]));
  const tab = chosen !== undefined && tabs.includes(chosen) ? chosen : tabs[0];

  return (
    <PaperScreen testId="hospital-numbers" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("hospitalNumbers.title")} route="/reports/numbers" />
      {!ready ? null : tab === undefined ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("hospitalNumbers.none")}</p>
      ) : (
        <>
          <div role="tablist" aria-label={t("hospitalNumbers.tabsLabel")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {tabs.map((k) => (
              <button
                key={k} type="button" role="tab" aria-selected={k === tab}
                className={k === tab ? "pill on" : "pill"}
                onClick={() => { setChosen(k); }}
              >
                {t(`hospitalNumbers.tabs.${k}`)}
              </button>
            ))}
          </div>
          <PeriodPicker state={state} />
          <div role="tabpanel" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {tab === "lab" ? <LabMetricsPanel range={state.range} valid={state.valid} /> : null}
            {tab === "imaging" ? <ImagingPanel range={state.range} valid={state.valid} /> : null}
            {tab === "pharmacy" ? <PharmacyPanel range={state.range} valid={state.valid} /> : null}
          </div>
        </>
      )}
    </PaperScreen>
  );
}
