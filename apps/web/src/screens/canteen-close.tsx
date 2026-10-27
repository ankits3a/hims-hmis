import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { canteenRefusal, closeTillApi, fetchCanteenDay, fetchMySession, paiseOf, rupees } from "../lib/canteen-api";
import { todayIst } from "../lib/opd-api";
import type { CanteenPayMode, CanteenTillClose } from "@hmis/contracts";
import "./canteen.css";

/**
 * ═══ CN-1 CANTEEN (issue #977) — THE DAY CLOSE (D1, D7) ═══
 *
 * The cashier counts the drawer and closes their session: cash expected (opening + cash sales) against cash counted; a
 * difference waits for the billing manager on the finance screen. Below, every till of the day with its takings by mode.
 * A caterer's till is listed for its own report and marked; the hospital's takings line adds in-house tills only.
 */
export function CanteenClose(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIst());
  const session = useQuery({ queryKey: ["canteen", "session"], queryFn: fetchMySession });
  const day = useQuery({ queryKey: ["canteen", "day", date], queryFn: () => fetchCanteenDay(date) });
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<CanteenTillClose | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const close = useMutation({
    mutationFn: () => closeTillApi(session.data!.sessionId, paiseOf(counted)!, note.trim() || undefined),
    onSuccess: (r) => { setResult(r); setErr(null); void qc.invalidateQueries({ queryKey: ["canteen"] }); },
    onError: (e) => setErr(t(`canteen.refusal.${canteenRefusal(e) ?? "failed"}`, { defaultValue: t("canteen.refusal.failed") })),
  });
  const s = session.data ?? null;
  const modes = (m: Partial<Record<CanteenPayMode, number>>) =>
    Object.entries(m).map(([k, v]) => `${t(`canteen.mode.${k}`)} ${rupees(v)}`).join(" · ") || "—";

  return (
    <PaperScreen testId="canteen-close">
      <div className="cn-page">
        <header className="cn-head"><h1>{t("canteen.close.title")}</h1></header>
        {err !== null && <p role="alert" className="cn-notice">{err}</p>}
        {s !== null && (
          <section className="box cn-card cn-narrow">
            <h2>{t("canteen.close.mySession")}</h2>
            <dl className="cn-kv">
              <dt>{t("canteen.close.opening")}</dt><dd>{rupees(s.openingCashPaise)}</dd>
              <dt>{t("canteen.close.cashSales")}</dt><dd>{rupees(s.cashSalesPaise)}</dd>
              <dt>{t("canteen.close.expected")}</dt><dd data-testid="cn-expected"><b>{rupees(s.expectedCashPaise)}</b></dd>
            </dl>
            <label>{t("canteen.close.counted")}<input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} data-testid="cn-counted" /></label>
            <label>{t("canteen.till.note")}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="cn-btn big" disabled={paiseOf(counted) === null || close.isPending} onClick={() => close.mutate()} data-testid="cn-close">
              {t("canteen.close.close")}
            </button>
          </section>
        )}
        {result !== null && (
          <p role="status" className={result.variancePaise === 0 ? "cn-notice ok" : "cn-notice"} data-testid="cn-closed">
            {result.variancePaise === 0 ? t("canteen.close.exact") : t("canteen.close.variance", { amount: rupees(Math.abs(result.variancePaise)), dir: t(result.variancePaise < 0 ? "canteen.close.short" : "canteen.close.over") })}
          </p>
        )}
        <section className="box cn-card">
          <h2 className="cn-row">{t("canteen.close.day")} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("canteen.close.day")} /></h2>
          <div className="cn-table-wrap">
            <table className="cn-table" data-testid="cn-day">
              <thead><tr><th>{t("canteen.close.till")}</th><th>{t("canteen.close.expected")}</th><th>{t("canteen.close.counted")}</th><th>{t("canteen.close.byMode")}</th></tr></thead>
              <tbody>
                {(day.data?.tills ?? []).map((x) => (
                  <tr key={x.tillId} className={x.outletKind === "caterer" ? "caterer" : undefined}>
                    <td>{x.tillCode}{x.outletKind === "caterer" && <span className="cn-tag">{t("canteen.outlet.caterer")}</span>}</td>
                    <td>{rupees(x.expectedCashPaise)}</td>
                    <td>{x.countedCashPaise === null ? t("canteen.close.open") : rupees(x.countedCashPaise)}</td>
                    <td>{modes(x.byMode)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th>{t("canteen.close.hospital")}</th><th colSpan={2} data-testid="cn-hospital">{rupees(day.data?.hospital.salesPaise ?? 0)}</th><th>{modes(day.data?.hospital.byMode ?? {})}</th></tr></tfoot>
            </table>
          </div>
        </section>
      </div>
    </PaperScreen>
  );
}
