import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdEmarDose, IpdEmarWardChart } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { fmtIst } from "../lib/format";
import { getWardChart } from "../lib/ipd-emar-api";
import { LiveLine, useLiveLoad } from "./ipd-nursing-shared";
import "./ipd-emar.css";

/**
 * E4.3 (#735) — THE WARD MAR CHART (16:9 desktop and the ward wall; spec §4.6, §4.9 C, §4.10 edge 27). One row per
 * patient's drug order, one column per IST hour of the day; each dose sits in its hour with its state as a SYMBOL AND A
 * WORD (colour never alone, §0A principle 10): ✓ given, ◷ due, ✕ missed, ⏸ held, ⊘ refused, — cancelled, ! corrected.
 * Prints as the paper MAR for downtime. No money (0058).
 */
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MARK: Record<string, string> = { given: "✓", scheduled: "◷", missed: "✕", held: "⏸", refused: "⊘", cancelled: "—" };

export function IpdMar(): React.ReactElement {
  const { t } = useTranslation();
  const [chart, setChart] = useState<IpdEmarWardChart | null>(null);
  const [wardId, setWardId] = useState<string | null>(null);
  const [error, setError] = useState<"forbidden" | null>(null);
  const load = useCallback(() => getWardChart(wardId).then((c) => { setChart(c); setError(null); }, (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) setError("forbidden");
    throw e;
  }), [wardId]);
  const live = useLiveLoad(load);
  const dayStart = chart === null ? 0 : new Date(chart.dayStart).getTime();
  const hourOf = (d: IpdEmarDose): number => Math.floor((new Date(d.dueAt).getTime() - dayStart) / 3_600_000);
  const nowHour = chart === null ? -1 : Math.floor((new Date(chart.asOf).getTime() - dayStart) / 3_600_000);
  return (
    <main className="ipde ipde-mar" data-testid="ipd-mar">
      <header className="ipde-head">
        <h1>{t("ipdEmar.mar.title")}{chart?.ward ? ` · ${chart.ward.name}` : ""}</h1>
        {chart !== null ? <span className="dim">{t("ipdEmar.mar.day", { day: new Date(new Date(chart.dayStart).getTime() + 12 * 3_600_000).toISOString().slice(0, 10) })}</span> : null}
        <LiveLine online={live.online} lastUpdate={live.lastUpdate} />
        {chart !== null && chart.wards.length > 1 ? (
          <nav className="ipde-chips noprint" aria-label={t("ipdNursing.ward.wards")}>
            {chart.wards.map((w) => <button key={w.id} type="button" className="ipde-chip" aria-pressed={chart.ward?.id === w.id} onClick={() => setWardId(w.id)}>{w.code}</button>)}
          </nav>
        ) : null}
        <button type="button" className="ipde-btn noprint" onClick={() => window.print()}>{t("ipdEmar.mar.print")}</button>
      </header>
      <p className="ipde-legend">{Object.entries(MARK).map(([k, m]) => <span key={k}><b>{m}</b> {t(`ipdEmar.status.${k}`)}</span>)}<span><b>!</b> {t("ipdEmar.status.corrected")}</span></p>
      {error === "forbidden" ? <div className="ipde-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {chart !== null && chart.patients.length === 0 ? <div className="ipde-empty">{t("ipdEmar.mar.empty")}</div> : null}
      {chart !== null && chart.patients.length > 0 ? (
        <div className="ipde-grid-wrap">
          <table className="ipde-grid">
            <thead>
              <tr>
                <th className="pt">{t("ipdEmar.mar.patient")}</th>
                <th className="dr">{t("ipdEmar.mar.drug")}</th>
                {HOURS.map((h) => <th key={h} className={h === nowHour ? "now" : ""}>{String(h).padStart(2, "0")}</th>)}
              </tr>
            </thead>
            <tbody>
              {chart.patients.flatMap((p) => {
                const orders = p.orders.length === 0 ? [null] : p.orders;
                return orders.map((o, i) => (
                  <tr key={`${p.admissionId}-${o?.orderId ?? "none"}`} className={i === 0 ? "first" : ""}>
                    {i === 0 ? (
                      <th rowSpan={orders.length} className="pt" scope="rowgroup">
                        <b>{p.bedCode ?? "—"}</b> {p.identity.name}
                        <div className="dim">{p.alerts.filter((a) => !a.endsWith("none recorded")).map((a) => `⚠ ${a.replace("Allergy: ", "")}`).join(" · ")}{p.npo ? " · ✕ NPO" : ""}</div>
                      </th>
                    ) : null}
                    {o === null ? <td className="dr dim" colSpan={25}>{t("ipdEmar.mar.noOrders")}</td> : (
                      <>
                        <td className="dr">
                          <b>{o.tallMan ?? o.title}</b>{o.highAlert ? " ⚠" : ""}
                          <div className="dim">{o.doseWords}{o.status !== "active" ? ` · ${t(`ipdEmar.orderStatus.${o.status}`)}` : ""}{o.verification === "pending" ? ` · ${t("ipdEmar.mar.withPharmacy")}` : ""}</div>
                        </td>
                        {HOURS.map((h) => {
                          const here = p.doses.filter((d) => d.orderId === o.orderId && hourOf(d) === h);
                          return (
                            <td key={h} className={`c${h === nowHour ? " now" : ""}`}>
                              {here.map((d) => {
                                const shown = d.outcome?.corrected ? "!" : MARK[d.status] ?? "?";
                                const word = d.outcome?.corrected ? t("ipdEmar.status.corrected") : t(`ipdEmar.status.${d.status}`);
                                return (
                                  <span key={d.doseId} className={`ipde-mark s-${d.status}`} title={`${fmtIst(d.dueAt)} · ${word}${d.outcome ? ` · ${d.outcome.byName} ${fmtIst(d.outcome.at)}` : ""}`}>
                                    <b>{shown}</b><i>{d.outcome !== null && d.status === "given" ? fmtIst(d.outcome.at) : word}</i>
                                  </span>
                                );
                              })}
                            </td>
                          );
                        })}
                      </>
                    )}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
