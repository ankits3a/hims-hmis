import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { acceptPar, keepPar, parSuggestions, plannerMonthly } from "../lib/planner-api";
import { storesErrorCode } from "../lib/stores-api";
import "./stores.css";
import type { StoresPar, WireParSuggestion } from "@hmis/contracts";

/**
 * STORES S7 (#1117, flow 5; spec "## Screens", D15) — PAR SUGGESTIONS, the materials head's 16:9 desk.
 *
 * One row per shelf item: shelf · item · min / reorder / max now · suggested · why · status word · Accept / Keep. Old and
 * suggested sit side by side; 50 rows fit a 1366 × 768 screen as a dense table that scrolls inside its own box. Only the
 * person's Accept changes a par (the server writes S1's par event). The monthly line heads the page: "Stock-outs without
 * warning: 0 · Drafts unchanged: 93%".
 */
const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8,
  background: "var(--paper, #fff)", height: "100%", minHeight: 0,
};
const cell: React.CSSProperties = { padding: "2px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderBottom: "1px solid var(--rule, #e3e3e3)", height: 26 };
const btn: React.CSSProperties = { minHeight: 24, padding: "0 10px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", fontSize: 13 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const fmt = (p: StoresPar | null): string => (p === null ? "—" : `${String(p.minBase)} / ${String(p.reorderBase)} / ${String(p.maxBase)}`);

export function StoresParSuggestions(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "planner", "par"], queryFn: parSuggestions, retry: false });
  const monthly = useQuery({ queryKey: ["stores", "planner", "monthly"], queryFn: () => plannerMonthly(), retry: false });
  const [status, setStatus] = useState<Record<string, WireParSuggestion["status"]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hi = i18n.language.startsWith("hi") ? 1 : 0;
  const act = async (id: string, what: "accept" | "keep"): Promise<void> => {
    setBusy(id); setError(null);
    try {
      if (what === "accept") await acceptPar(id); else await keepPar(id);
      setStatus((m) => ({ ...m, [id]: what === "accept" ? "accepted" : "kept" }));
    } catch (e) {
      const code = storesErrorCode(e);
      setError(code === null ? t("stores.planner.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.planner.failed") }));
    } finally { setBusy(null); }
  };
  const m = monthly.data;
  return (
    <div data-testid="stores-par" className="stores-ui" style={page}>
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", whiteSpace: "nowrap", overflow: "hidden" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.planner.parTitle")}</h1>
        {m !== undefined && (
          <span data-testid="planner-monthly" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {`${t("stores.planner.outs", { n: m.stockOutsWithoutWarning })} · ${m.unchangedPct === null ? t("stores.planner.unchangedNone") : t("stores.planner.unchanged", { pct: m.unchangedPct })}`}
          </span>
        )}
      </div>
      {error !== null && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      {q.isError ? <p style={{ margin: 0 }}>{storesErrorCode(q.error) === "not_permitted" ? t("stores.ticket.notYourDept") : t("stores.planner.failed")}</p>
        : q.data === undefined ? (
          <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ height: 22, background: "var(--rule, #eee)", borderRadius: 4 }} />)}
          </div>
        ) : q.data.length === 0 ? <p style={{ margin: 0 }}>{t("stores.planner.none")}</p> : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: 13 }}>
              <colgroup>
                <col style={{ width: "13%" }} /><col style={{ width: "20%" }} /><col style={{ width: "14%" }} /><col style={{ width: "13%" }} />
                <col style={{ width: "21%" }} /><col style={{ width: "8%" }} /><col style={{ width: "11%" }} />
              </colgroup>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  {(["shelf", "item", "now", "suggested", "why", "status"] as const).map((c) => <th key={c} style={{ ...cell, fontWeight: 700 }}>{t(`stores.planner.col.${c}`)}</th>)}
                  <th style={cell} />
                </tr>
              </thead>
              <tbody>
                {q.data.map((r) => {
                  const st = status[r.id] ?? r.status;
                  return (
                    <tr key={r.id} data-testid={`par-row-${r.id}`}>
                      <td style={cell} title={r.shelfName}>{r.shelfName}</td>
                      <td style={cell} title={r.itemName}>{r.itemName}</td>
                      <td style={cell} data-testid="par-now">{fmt(r.now)}</td>
                      <td style={{ ...cell, fontWeight: 700 }} data-testid="par-suggested">{fmt(r.suggested)}</td>
                      <td style={cell} title={r.why[hi]}>{r.why[hi]}</td>
                      <td style={cell}>{t(`stores.planner.parStatus.${st}`)}</td>
                      <td style={{ ...cell, display: "flex", gap: 4 }}>
                        {st === "open" && (
                          <>
                            <button type="button" style={primary} disabled={busy !== null} onClick={() => { void act(r.id, "accept"); }}>{t("stores.planner.accept")}</button>
                            <button type="button" style={btn} disabled={busy !== null} onClick={() => { void act(r.id, "keep"); }}>{t("stores.planner.keep")}</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
