import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { todayIst } from "../lib/desk-api";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";

/**
 * LAB NUMBERS (owner 2026-10-13, #768) — counts and turnaround times for a date range, read-only,
 * on `lab.metrics.read`. Every time is minutes: median / 90th percentile, with n. The server
 * (`modules/lab/metrics.ts`) says what each figure is anchored on; this screen only lays it out.
 */
export type LabTiming = { n: number; medianMin: number | null; p90Min: number | null };
type Counts = { orders: number; tests: number; published: number; delivered: number };
export type WireLabMetrics = {
  from: string;
  to: string;
  totals: Counts;
  bySource: (Counts & { source: "opd" | "ipd" | "walk_in" })[];
  byTest: (Counts & { serviceId: string; code: string; name: string })[];
  reportTimes: { placedToPublished: LabTiming; receivedToPublished: LabTiming; publishedToDelivered: LabTiming };
  testTimes: {
    serviceId: string; code: string; name: string;
    placedToCollected: LabTiming; collectedToReceived: LabTiming; receivedToEntered: LabTiming;
    enteredToVerified: LabTiming; placedToVerified: LabTiming;
  }[];
  parameterTimes: {
    analyteId: string; code: string; name: string; mode: "machine" | "manual";
    receivedToEntered: LabTiming; enteredToVerified: LabTiming;
  }[];
};

type Period = "today" | "week" | "month" | "custom";
const PERIODS: readonly Period[] = ["today", "week", "month", "custom"];

const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The range a preset means, ending today (IST). A week starts on Monday. */
export function rangeFor(period: Exclude<Period, "custom">, today: string): { from: string; to: string } {
  if (period === "today") return { from: today, to: today };
  const d = day(today);
  if (period === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  const back = (d.getUTCDay() + 6) % 7;
  return { from: iso(new Date(d.getTime() - back * 86_400_000)), to: today };
}

const COUNT_COLS = ["orders", "tests", "published", "delivered"] as const;
const TEST_STEPS = ["placedToCollected", "collectedToReceived", "receivedToEntered", "enteredToVerified", "placedToVerified"] as const;
const REPORT_STEPS = ["placedToPublished", "receivedToPublished", "publishedToDelivered"] as const;
const PARAM_STEPS = ["receivedToEntered", "enteredToVerified"] as const;

const th: React.CSSProperties = { textAlign: "left", padding: "0 14px 6px 0", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 14px 6px 0", borderBottom: "1px solid var(--line2, var(--line))", whiteSpace: "nowrap" };

function Time({ t }: { t: LabTiming }): React.ReactElement {
  if (t.n === 0) return <span style={{ color: "var(--faint)" }}>—</span>;
  return (
    <span>
      {String(t.medianMin)} / {String(t.p90Min)}
      <span style={{ color: "var(--faint)", fontSize: 11 }}> n {String(t.n)}</span>
    </span>
  );
}

function Table({ title, head, rows, testId }: {
  title: string; head: string[]; rows: React.ReactNode[][]; testId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="box" data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 7, padding: "13px 15px" }}>
      <h2 className="tag" style={{ margin: 0 }}>{title}</h2>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("labMetrics.empty")}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="mo" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{head.map((h) => <th key={h} className="tag" style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} style={td}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LabMetrics(): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst();
  const [period, setPeriod] = useState<Period>("today");
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: today, to: today });
  const range = period === "custom" ? custom : rangeFor(period, today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) && range.from <= range.to;

  const q = useQuery({
    queryKey: ["lab", "metrics", range.from, range.to],
    queryFn: () => api<WireLabMetrics>("GET", `/lab/metrics?from=${range.from}&to=${range.to}`),
    enabled: valid,
  });
  const m = q.data;
  const counts = (c: Counts): React.ReactNode[] => COUNT_COLS.map((k) => c[k]);

  return (
    <PaperScreen testId="lab-metrics" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("labMetrics.title")} route="/lab/metrics" />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label={t("labMetrics.period")}>
          {PERIODS.map((p) => (
            <button
              key={p} type="button" aria-pressed={p === period}
              className={p === period ? "pill on" : "pill"}
              onClick={() => { setPeriod(p); }}
            >
              {t(`labMetrics.periods.${p}`)}
            </button>
          ))}
        </div>
        {period !== "custom" ? null : (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <span className="tag">{t("labMetrics.from")}</span>
              <input className="in" type="date" value={custom.from} max={today} aria-label={t("labMetrics.from")}
                onChange={(e) => { setCustom((c) => ({ ...c, from: e.target.value })); }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <span className="tag">{t("labMetrics.to")}</span>
              <input className="in" type="date" value={custom.to} max={today} aria-label={t("labMetrics.to")}
                onChange={(e) => { setCustom((c) => ({ ...c, to: e.target.value })); }} />
            </label>
          </>
        )}
        <span className="mo" style={{ fontSize: 11, color: "var(--faint)" }}>{t("labMetrics.legend")}</span>
      </div>

      {!valid ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{t("labMetrics.badRange")}</p> : null}
      {q.isError ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{t("labMetrics.failed")}</p> : null}
      {valid && q.isLoading ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("labMetrics.loading")}</p> : null}

      {m === undefined ? null : (
        <>
          <Table
            testId="lab-metrics-source" title={t("labMetrics.bySource")}
            head={[t("labMetrics.cols.source"), ...COUNT_COLS.map((k) => t(`labMetrics.cols.${k}`))]}
            rows={[
              ...m.bySource.map((s) => [t(`labMetrics.sources.${s.source}`), ...counts(s)]),
              [<strong key="total">{t("labMetrics.total")}</strong>, ...counts(m.totals)],
            ]}
          />
          <Table
            testId="lab-metrics-test" title={t("labMetrics.byTest")}
            head={[t("labMetrics.cols.test"), ...COUNT_COLS.map((k) => t(`labMetrics.cols.${k}`))]}
            rows={m.byTest.map((r) => [r.name, ...counts(r)])}
          />
          <Table
            testId="lab-metrics-report-times" title={t("labMetrics.reportTimes")}
            head={[t("labMetrics.cols.step"), t("labMetrics.cols.time")]}
            rows={REPORT_STEPS.map((k) => [t(`labMetrics.steps.${k}`), <Time key={k} t={m.reportTimes[k]} />])}
          />
          <Table
            testId="lab-metrics-test-times" title={t("labMetrics.testTimes")}
            head={[t("labMetrics.cols.test"), ...TEST_STEPS.map((k) => t(`labMetrics.steps.${k}`))]}
            rows={m.testTimes.map((r) => [r.name, ...TEST_STEPS.map((k) => <Time key={k} t={r[k]} />)])}
          />
          <Table
            testId="lab-metrics-param-times" title={t("labMetrics.paramTimes")}
            head={[t("labMetrics.cols.parameter"), t("labMetrics.cols.entry"), ...PARAM_STEPS.map((k) => t(`labMetrics.steps.${k}`))]}
            rows={m.parameterTimes.map((r) => [r.name, t(`labMetrics.modes.${r.mode}`), ...PARAM_STEPS.map((k) => <Time key={k} t={r[k]} />)])}
          />
        </>
      )}
    </PaperScreen>
  );
}
