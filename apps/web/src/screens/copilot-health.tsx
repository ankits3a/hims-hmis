import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCopilotHealth } from "../lib/copilot-api";
import type { CopilotHealth } from "../lib/copilot-api";

/**
 * E0.1 — COPILOT HEALTH (decision 0064). One IST day's totals for the owner, IT and the copilot
 * steward (`copilot.health.read`): questions, people who asked (a NUMBER), how questions ended, and
 * which route answered how fast. There is no per-person list and no "fewest questions" view — the
 * server sends none, and this screen has nowhere to put one (plan E0.1 check 4).
 */
const ROUTES = ["phrasebook", "chooser", "model", "none"] as const;

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

const CELL: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--line, #dfe7e1)", textAlign: "left" };
const NUM: React.CSSProperties = { ...CELL, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export function CopilotHealthScreen(): React.ReactElement {
  const { t } = useTranslation();
  const [date, setDate] = useState(istToday);
  const [health, setHealth] = useState<CopilotHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    getCopilotHealth(date).then(
      (h) => { if (live) setHealth(h); },
      () => { if (live) { setHealth(null); setFailed(true); } },
    );
    return () => { live = false; };
  }, [date]);

  const ms = (v: number | null): string => (v === null ? t("copilot.health.none") : `${v} ms`);
  const share = (v: number | null): string => (v === null ? t("copilot.health.none") : `${Math.round(v * 100)}%`);

  return (
    <main data-testid="copilot-health" style={{ padding: 16, maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>{t("copilot.health.title")}</h1>
      <label style={{ display: "inline-flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        {t("copilot.health.date")}
        <input type="date" value={date} max={istToday()} onChange={(e) => { if (e.target.value !== "") setDate(e.target.value); }} />
      </label>
      {failed ? <p role="alert">{t("copilot.health.failed")}</p> : null}
      {health === null ? null : (
        <>
          <section style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
            {([
              ["asks", String(health.asks)],
              ["askers", String(health.askers)],
              ["notUnderstoodShare", share(health.notUnderstoodShare)],
              ["acts", String(health.acts)],
            ] as const).map(([k, v]) => (
              <div key={k} data-testid={`copilot-health-${k}`} style={{ flex: "1 1 140px", padding: 12, borderRadius: 10, border: "1px solid var(--line, #dfe7e1)", background: "var(--card, #fff)" }}>
                <div style={{ fontSize: 12, color: "var(--muted, #5b6b66)" }}>{t(`copilot.health.${k}`)}</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </section>

          <h2 style={{ fontSize: 16 }}>{t("copilot.health.byRoute")}</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 20 }}>
              <thead>
                <tr>
                  <th style={CELL}>{t("copilot.health.route")}</th>
                  <th style={NUM}>{t("copilot.health.count")}</th>
                  <th style={NUM}>{t("copilot.health.p50")}</th>
                  <th style={NUM}>{t("copilot.health.p95")}</th>
                </tr>
              </thead>
              <tbody>
                {ROUTES.map((r) => (
                  <tr key={r}>
                    <td style={CELL}>{t(`copilot.health.routeName.${r}`)}</td>
                    <td style={NUM}>{health.byRoute[r].asks}</td>
                    <td style={NUM}>{ms(health.byRoute[r].p50Ms)}</td>
                    <td style={NUM}>{ms(health.byRoute[r].p95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={{ fontSize: 16 }}>{t("copilot.health.byOutcome")}</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              {Object.entries(health.byOutcome).filter(([, n]) => n > 0).map(([k, n]) => (
                <tr key={k}>
                  <td style={CELL}>{t(`copilot.health.outcome.${k}`)}</td>
                  <td style={NUM}>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
