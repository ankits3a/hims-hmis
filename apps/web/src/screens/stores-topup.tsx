import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { myTopUps, notNowTopUp, returnSlowStock, sendTopUp } from "../lib/planner-api";
import { storesErrorCode } from "../lib/stores-api";
import { Refused } from "./stores-tickets";
import "./stores.css";
import type { WireSlowStockCard, WireTopUpLine, WireTopUpProposal, WireTopUpSection } from "@hmis/contracts";

/**
 * STORES S7 (#1117, flow 2; spec "## Screens", D14) — THE PLANNER'S TOP-UP, on the department in-charge's 390 px phone.
 *
 * The Now card ("3 run out in 2 days") opens this screen; each shelf's section is sent with ONE tap on Send (the third
 * at most, after an optional edit). Each line is ONE row on one line: name (gives way first) · status word · the one-line
 * why from the forecast · the quantity (editable). Every status is a word. The budget is a word ("Budget 80% used",
 * "Over budget"), never a refusal and never money. "Not now" asks a reason chip. A slow-stock card returns in one tap.
 */
const KEY = ["stores", "planner", "topup"] as const;
type Done = { draftId: string; text: string };

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 12,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", overflow: "hidden", minHeight: 44, borderBottom: "1px solid var(--rule, #e3e3e3)",
  padding: "4px 0",
};
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { fontSize: 12, fontWeight: 700, border: "1px solid currentColor", borderRadius: 4, padding: "1px 4px", flexShrink: 0 };
const card: React.CSSProperties = { border: "1px solid var(--rule, #ddd)", borderRadius: 8, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 };

export function StoresTopUp(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: KEY, queryFn: myTopUps, retry: false });
  if (q.isError) {
    return <div data-testid="stores-topup" className="stores-ui" style={page}><p style={{ margin: 0 }}>{t("stores.planner.failed")}</p></div>;
  }
  if (q.data === undefined) {
    return (
      <div data-testid="stores-topup" className="stores-ui" style={page} aria-busy="true">
        {[0, 1, 2, 3].map((i) => <div key={i} style={{ ...rowStyle, background: "var(--rule, #eee)", borderRadius: 4 }} />)}
      </div>
    );
  }
  return (
    <div data-testid="stores-topup" className="stores-ui" style={page}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.planner.title")}</h1>
      {q.data.length === 0 ? <p style={{ margin: 0 }}>{t("stores.planner.empty")}</p> : q.data.map((p) => <Proposal key={p.departmentId} p={p} />)}
    </div>
  );
}

function RunOut({ p }: { p: WireTopUpProposal }): React.ReactElement | null {
  const { t } = useTranslation();
  if (p.runOut.count === 0) return null;
  const text = p.runOut.urgent ? t("stores.planner.today")
    : p.runOut.days <= 1 ? t("stores.planner.runOutDay", { count: p.runOut.count }) : t("stores.planner.runOut", { count: p.runOut.count, days: p.runOut.days });
  return <p data-testid="topup-runout" style={{ margin: 0, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</p>;
}

function Proposal({ p }: { p: WireTopUpProposal }): React.ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", whiteSpace: "nowrap", overflow: "hidden" }}>
        <b style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.departmentName}</b>
      </div>
      <RunOut p={p} />
      {p.sections.map((s) => <Section key={s.draftId} s={s} />)}
      {p.slow.map((s) => <Slow key={s.draftId} s={s} />)}
    </section>
  );
}

function Line({ l, qty, onQty }: { l: WireTopUpLine; qty: number; onQty: (n: number) => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const hi = i18n.language.startsWith("hi") ? 1 : 0;
  return (
    <div data-testid={`topup-line-${l.itemId}`} style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span title={l.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>{l.name}</span>
        <span style={word}>{t(`stores.planner.word.${l.word}`)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--dim, #555)", overflow: "hidden", textOverflow: "ellipsis" }}>{l.why[hi]}</span>
        <input
          aria-label={`${t("stores.planner.qty")} ${l.name}`} inputMode="numeric" value={String(qty)} style={{ width: 64, flexShrink: 0, textAlign: "right" }}
          onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); onQty(Number.isFinite(n) ? n : 0); }}
        />
      </div>
    </div>
  );
}

function Section({ s }: { s: WireTopUpSection }): React.ReactElement {
  const { t } = useTranslation();
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(s.lines.map((l) => [l.itemId, l.qty])));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const edited = s.lines.filter((l) => qty[l.itemId] !== l.qty).map((l) => ({ itemId: l.itemId, qty: qty[l.itemId] ?? l.qty }));
  const valid = s.lines.every((l) => (qty[l.itemId] ?? 0) > 0);
  const fail = (e: unknown): void => {
    const code = storesErrorCode(e);
    if (code === "not_permitted") setRefused(true);
    else setError(code === null ? t("stores.planner.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.planner.failed") }));
  };
  const send = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await sendTopUp(s.draftId, edited.length === 0 ? undefined : edited);
      // The card stays and says "Sent" (the list is read afresh on the next visit, where this section is gone).
      setDone({ draftId: s.draftId, text: t("stores.planner.sent") });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const notNow = async (reason: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await notNowTopUp(s.draftId, reason);
      setDone({ draftId: s.draftId, text: t("stores.planner.notNow") });
    } catch (e) { fail(e); } finally { setBusy(false); setAsking(false); }
  };
  if (refused) return <Refused at={{ shelfId: s.shelfId }} testId="topup-refused" />;
  return (
    <div data-testid={`topup-section-${s.draftId}`} style={card}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap", overflow: "hidden" }}>
        <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{s.shelfName}</b>
        {s.storeShort === true && <span style={word}>{t("stores.planner.storeShort")}</span>}
      </div>
      {s.budget !== null && <p style={{ margin: 0, fontWeight: 600 }}>{t(s.budget.over ? "stores.planner.over" : "stores.planner.budget80")}</p>}
      {s.lines.map((l) => <Line key={l.itemId} l={l} qty={qty[l.itemId] ?? l.qty} onQty={(n) => setQty((m) => ({ ...m, [l.itemId]: n }))} />)}
      {done !== null ? <p role="status" style={{ margin: 0, fontWeight: 700 }}>{done.text}</p> : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={primary} disabled={busy || !valid} onClick={() => { void send(); }}>{t("stores.planner.send")}</button>
          {!asking
            ? <button type="button" style={btn} disabled={busy} onClick={() => setAsking(true)}>{t("stores.planner.notNow")}</button>
            : (["stock_arrived", "use_changed", "other"] as const).map((r) => (
              <button key={r} type="button" style={btn} disabled={busy} onClick={() => { void notNow(r); }}>{t(`stores.planner.reason.${r}`)}</button>
            ))}
        </div>
      )}
      {error !== null && <p role="alert" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

function Slow({ s }: { s: WireSlowStockCard }): React.ReactElement {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid={`topup-slow-${s.draftId}`} style={card}>
      <b style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("stores.planner.slow")}</b>
      {s.lines.map((l) => (
        <div key={l.itemId} style={rowStyle}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
          <span style={{ flexShrink: 0 }}>{l.onHand}</span>
        </div>
      ))}
      {done ? <p role="status" style={{ margin: 0, fontWeight: 700 }}>{t("stores.planner.returned")}</p> : (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={primary} disabled={busy} onClick={() => {
            setBusy(true);
            void returnSlowStock(s.draftId).then(() => setDone(true)).finally(() => setBusy(false));
          }}>{t("stores.planner.return")}</button>
          <Link to="/stores/shelf/$shelfId" params={{ shelfId: s.shelfId }} className="stores-btn">{s.shelfName}</Link>
        </div>
      )}
    </div>
  );
}
