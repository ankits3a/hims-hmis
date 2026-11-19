import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { QrScan, cameraScanPossible } from "../components/qr-scan";
import { printDocumentHere, readPrintSetting } from "../lib/browser-print";
import {
  closeGatePass, gatePassForm, gatePassLookup, gatePassPrint, listGatePasses, raiseGatePass, scanGatePass, searchItems, storesErrorCode,
} from "../lib/stores-api";
import { useOnline } from "./stores-tickets";
import "./stores.css";
import type { GatePassRaise } from "../lib/stores-api";
import type { WireGatePass, WireGatePassLookup, WireGatePassSource } from "@hmis/contracts";

/**
 * STORES S2c (#1119, spec "## Screens") — THE GATE (the guard, phone) AND THE PASSES TAB (the store).
 *
 * Gate: opens on the camera with the typed last four digits beside it; a read names the pass (number, returnable
 * or not, items and quantities, due back) and ONE primary button, "Let out" or "Let in" — a scan is two taps at
 * most. A partial return lowers a line's number before "Let in". Every refusal is the spec's few words.
 *
 * Passes: one row per pass (number · kind · party · items · due back · status word), overdue first; "New pass" is
 * one screen (returnable: from, to whom, purpose, due back, items; non-returnable: pick the dispatched return or
 * posted write-off it stands on), then "Print pass". Both fit 390 px with no sideways scroll: rows clip with an
 * ellipsis before the numbers do. Loading is grey rows with no text.
 */

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden", minHeight: 44,
  borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0",
};
const cell: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const num: React.CSSProperties = { flexShrink: 0, fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" };
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13 };
const input: React.CSSProperties = {
  minHeight: 44, boxSizing: "border-box", width: "100%", fontSize: 16, padding: "0 10px", borderRadius: 6,
  border: "1px solid var(--ink, #222)", background: "var(--card, #fff)", color: "var(--ink, #222)",
};
const qtyBox: React.CSSProperties = { ...input, width: 64, minHeight: 40, flexShrink: 0, textAlign: "right", padding: "0 6px" };
const unit: React.CSSProperties = { flexShrink: 0, color: "var(--dim, #5c6f66)", fontSize: 14 };
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

const STATUS_KEY: Record<WireGatePass["status"], string> = {
  raised: "stores.gate.status.raised", out: "stores.gate.status.out", overdue: "stores.gate.status.overdue",
  back: "stores.gate.status.back", closed: "stores.gate.status.closed",
};
const REFUSAL_KEY: Record<string, string> = {
  pass_not_valid: "stores.gate.notValid", not_out: "stores.gate.notValid", already_out: "stores.gate.alreadyOut", own_pass: "stores.gate.ownPass",
  ambiguous_code: "stores.gate.twoMatch", not_permitted: "stores.gate.notYourRole", more_than_out: "stores.gate.moreThanOut",
  ref_required: "stores.gate.refNeeded", party_required: "stores.gate.partyNeeded", due_back_required: "stores.gate.dueNeeded",
  more_than_on_hand: "stores.shelf.moreThanOnHand", already_on_pass: "stores.gate.alreadyOnPass", pass_closed: "stores.gate.status.closed",
  reason_required: "stores.gate.reasonNeeded", bad_quantity: "stores.ticket.onlyDown",
};

function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    const code = storesErrorCode(e);
    return t(code !== null && REFUSAL_KEY[code] !== undefined ? REFUSAL_KEY[code] : "stores.shelf.failed");
  };
}

function Offline(): React.ReactElement | null {
  const { t } = useTranslation();
  return useOnline() ? null : <p role="alert" data-testid="stores-offline" style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.offline")}</p>;
}

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <>{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ ...rowStyle, background: "var(--rule, #eee)", borderRadius: 4 }} />)}</>;
}

const dayLabel = (d: string, lang: string): string =>
  new Date(`${d}T00:00:00+05:30`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** "Electric drill 2 · Bulb 4" — the pass's items in one clipped line. */
const itemsLine = (p: WireGatePass): string => p.lines.map((l) => `${l.itemName} ${String(l.qty)}`).join(" · ");

// ═══════════════════════════════ Gate (the guard) ═══════════════════════════════

export function StoresGate(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const refusal = useRefusal();
  const [scanning, setScanning] = useState(cameraScanPossible());
  const [noCamera, setNoCamera] = useState(false);
  const [code, setCode] = useState("");
  const [found, setFound] = useState<WireGatePassLookup | null>(null);
  const [back, setBack] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const reset = (msg: { text: string; ok: boolean } | null): void => {
    setFound(null);
    setCode("");
    setBack({});
    setNotice(msg);
    setScanning(!noCamera && cameraScanPossible());
  };
  const find = (c: string): void => {
    setNotice(null);
    setScanning(false);
    setBusy(true);
    gatePassLookup(c).then((r) => { setFound(r); setBack({}); }).catch((e: unknown) => reset({ text: refusal(e), ok: false })).finally(() => setBusy(false));
  };
  const act = (): void => {
    if (found === null) return;
    const lines = found.act === "entry"
      ? found.pass.lines.filter((l) => l.out > 0).map((l) => ({ itemId: l.itemId, qty: Number(back[l.itemId] ?? String(l.out)) })).filter((l) => l.qty > 0)
      : undefined;
    if (lines !== undefined && lines.length === 0) { setNotice({ text: t("stores.gate.nothingIn"), ok: false }); return; }
    setBusy(true);
    scanGatePass(found.pass.passNo, found.act, lines)
      .then(() => reset({ text: t("stores.gate.recorded"), ok: true }))
      .catch((e: unknown) => reset({ text: refusal(e), ok: false }))
      .finally(() => setBusy(false));
  };
  const p = found?.pass ?? null;

  return (
    <div data-testid="stores-gate" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.gate.title")}</h1>
      {notice !== null && (
        <p role="status" data-tone={notice.ok ? "ok" : "refused"} style={{
          margin: 0, fontWeight: 700, fontSize: 18, padding: "8px 12px", borderRadius: 6,
          borderLeft: `6px solid ${notice.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`, background: "var(--line, #eef2ef)",
        }}>{notice.text}</p>
      )}
      {p !== null && found !== null ? (
        <section data-testid="gate-pass" style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
          <div style={{ ...rowStyle, borderBottom: "none", minHeight: 0 }}>
            <strong style={cell}>{p.passNo}</strong>
            <span style={word}>{t(STATUS_KEY[p.status])}</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span style={{ ...word, borderStyle: "dashed" }}>{t(p.kind === "returnable" ? "stores.gate.returnable" : "stores.gate.nonReturnable")}</span>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{p.party}</span>
          </div>
          {p.dueBack !== null && <span>{t("stores.gate.dueBack", { date: dayLabel(p.dueBack, i18n.language) })}</span>}
          {p.lines.map((l) => (
            <div key={l.itemId} data-testid={`gate-line-${l.itemId}`} style={rowStyle}>
              <span style={cell}>{l.itemName}</span>
              {found.act === "entry" && l.out > 0 ? (
                <input
                  type="number" inputMode="numeric" min={0} max={l.out} aria-label={`${t("stores.gate.comingIn")} · ${l.itemName}`}
                  value={back[l.itemId] ?? String(l.out)}
                  onChange={(e) => setBack((b) => ({ ...b, [l.itemId]: String(Math.max(0, Math.min(l.out, Number(e.target.value.replace(/\D/g, "") || "0")))) }))}
                  style={qtyBox}
                />
              ) : (
                <span style={num}>{String(found.act === "entry" ? l.out : l.qty)}</span>
              )}
              <span style={unit}>{l.baseUom}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={{ ...primary, flex: 1, minHeight: 48 }} disabled={busy} onClick={act}>
              {t(found.act === "exit" ? "stores.gate.letOut" : "stores.gate.letIn")}
            </button>
            <button type="button" style={btn} disabled={busy} onClick={() => reset(null)}>{t("stores.ticket.cancel")}</button>
          </div>
        </section>
      ) : busy ? (
        <div aria-busy="true"><GreyRows /></div>
      ) : (
        <>
          {scanning && (
            <QrScan
              onRead={(text) => find(text)}
              onClose={(why) => { setScanning(false); if (why === "unavailable") { setNoCamera(true); setNotice({ text: t("stores.ticket.cameraOff"), ok: false }); } }}
            />
          )}
          {!scanning && !noCamera && cameraScanPossible() && (
            <button type="button" style={{ ...primary, minHeight: 48 }} onClick={() => { setNotice(null); setScanning(true); }}>{t("stores.gate.scan")}</button>
          )}
          <label style={stack}>
            <span>{t("stores.gate.typeLast4")}</span>
            <input
              inputMode="numeric" autoComplete="off" maxLength={4} aria-label={t("stores.gate.typeLast4")} value={code}
              onChange={(e) => {
                const c = e.target.value.replace(/\D/g, "").slice(0, 4);
                setCode(c);
                if (c.length === 4) find(c);
              }}
              style={{ ...input, fontSize: 20, letterSpacing: 4 }}
            />
          </label>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════ Passes (the store) ═══════════════════════════════

export function StoresPasses(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "gate-passes"], queryFn: listGatePasses, retry: false });
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const passes = q.data?.passes ?? [];

  if (making) return <NewPass onDone={(msg) => { setMaking(false); setNotice(msg); }} />;
  return (
    <div data-testid="stores-passes" className="stores-ui" style={page}>
      <Offline />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 18, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("stores.gate.passesTitle")}</h1>
        <button type="button" style={primary} onClick={() => { setNotice(null); setMaking(true); }}>{t("stores.gate.newPass")}</button>
      </div>
      {notice !== null && <p role="status" style={{ margin: 0, fontWeight: 700 }}>{notice}</p>}
      {q.data === undefined && !q.isError ? <div aria-busy="true"><GreyRows /></div>
        : q.isError ? <p role="status" style={{ margin: 0 }}>{t(storesErrorCode(q.error) === "not_permitted" ? "stores.gate.notYourRole" : "stores.shelf.failed")}</p>
        : passes.length === 0 ? <p style={{ margin: 0 }}>{t("stores.gate.empty")}</p>
        : passes.map((p) => <PassRow key={p.id} pass={p} open={open === p.id} onToggle={() => setOpen((o) => (o === p.id ? null : p.id))} />)}
    </div>
  );
}

function printPass(passId: string): Promise<void> {
  if (readPrintSetting().mode === "relay") return Promise.resolve();
  return gatePassPrint(passId).then((doc) => { if (doc !== null) void printDocumentHere(doc); });
}

function PassRow({ pass, open, onToggle }: { pass: WireGatePass; open: boolean; onToggle: () => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const hot = pass.status === "overdue";
  return (
    <div data-testid={`pass-${pass.id}`} style={{ display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid var(--rule, #e3e3e3)" }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        style={{ display: "flex", flexDirection: "column", gap: 2, border: "none", background: "transparent", color: "inherit", textAlign: "left", padding: "6px 0", width: "100%", font: "inherit", minHeight: 44 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", whiteSpace: "nowrap", overflow: "hidden" }}>
          <strong style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{pass.passNo.slice(-4)}</strong>
          <span style={cell}>{pass.party}</span>
          <span style={{ ...word, ...(hot ? { background: "var(--ink, #222)", color: "var(--paper, #fff)" } : {}) }}>{t(STATUS_KEY[pass.status])}</span>
        </span>
        <span style={{ display: "flex", gap: 8, width: "100%", whiteSpace: "nowrap", overflow: "hidden", fontSize: 14, color: "var(--dim, #5c6f66)" }}>
          <span style={cell}>{`${t(pass.kind === "returnable" ? "stores.gate.returnable" : "stores.gate.nonReturnable")} · ${itemsLine(pass)}`}</span>
          {pass.dueBack !== null && <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{t("stores.gate.dueBack", { date: dayLabel(pass.dueBack, i18n.language) })}</span>}
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>{pass.passNo}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`${pass.store.name} → ${pass.party}`}</span>
          {pass.ref !== null && <span>{pass.ref.no}</span>}
          {pass.lines.map((l) => (
            <div key={l.itemId} style={{ ...rowStyle, minHeight: 32 }}>
              <span style={cell}>{l.itemName}</span>
              <span style={num}>{String(l.qty)}</span>
              {pass.kind === "returnable" && l.back > 0 && <span style={{ flexShrink: 0 }}>{t("stores.gate.backCount", { n: l.back })}</span>}
            </div>
          ))}
          {pass.scans.map((s, i) => (
            <span key={i} style={{ fontSize: 13, color: "var(--dim, #5c6f66)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {`${t(`stores.gate.scanKind.${s.kind}`)} · ${s.by.name} · ${new Date(s.at).toLocaleString(i18n.language === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${s.flag === "late" ? ` · ${t("stores.ticket.syncedLate")}` : ""}`}
            </span>
          ))}
          {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
          {closing ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input aria-label={t("stores.gate.reason")} placeholder={t("stores.gate.reason")} value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...input, flex: 1, minWidth: 0 }} />
              <button type="button" style={primary} onClick={() => {
                closeGatePass(pass.id, reason).then(() => qc.invalidateQueries({ queryKey: ["stores", "gate-passes"] })).catch((e: unknown) => setNotice(refusal(e)));
              }}>{t("stores.gate.closePass")}</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={primary} onClick={() => { printPass(pass.id).catch(() => setNotice(t("stores.shelf.failed"))); }}>{t("stores.gate.printPass")}</button>
              {pass.status === "raised" && <button type="button" style={btn} onClick={() => setClosing(true)}>{t("stores.gate.closePass")}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PURPOSES = ["repair", "calibration", "refill", "loan"] as const;
type Purpose = (typeof PURPOSES)[number];

/** A week from today, the IST calendar day, as the default due-back. */
function inAWeek(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function NewPass({ onDone }: { onDone: (notice: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const form = useQuery({ queryKey: ["stores", "gate-pass-form"], queryFn: gatePassForm, retry: false });
  const [kind, setKind] = useState<"returnable" | "non_returnable">("returnable");
  const [storeId, setStoreId] = useState<string | null>(null);
  const [party, setParty] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("repair");
  const [dueBack, setDueBack] = useState(inAWeek());
  const [lines, setLines] = useState<{ itemId: string; name: string; uom: string; qty: string }[]>([]);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<WireGatePassSource | null>(null);
  const [made, setMade] = useState<WireGatePass | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const found = useQuery({ queryKey: ["stores", "search", q.trim()], queryFn: () => searchItems(q), enabled: q.trim().length >= 2 });
  const stores = form.data?.stores ?? [];
  const sources = form.data?.sources ?? [];
  const from = storeId ?? stores[0]?.id ?? null;

  if (made !== null) {
    return (
      <div data-testid="stores-new-pass" className="stores-ui" style={page}>
        <p role="status" style={{ margin: 0, fontWeight: 700 }}>{t("stores.gate.raised")}</p>
        <strong>{made.passNo}</strong>
        <span>{made.party}</span>
        <span style={{ color: "var(--dim, #5c6f66)" }}>{itemsLine(made)}</span>
        <button type="button" style={{ ...primary, minHeight: 48 }} onClick={() => { printPass(made.id).catch(() => setNotice(t("stores.shelf.failed"))); }}>{t("stores.gate.printPass")}</button>
        <button type="button" style={btn} onClick={() => onDone(null)}>{t("stores.shelf.back")}</button>
        {notice !== null && <p role="status" style={{ margin: 0 }}>{notice}</p>}
      </div>
    );
  }

  const raise = (): void => {
    let body: GatePassRaise;
    if (kind === "returnable") {
      if (from === null) { setNotice(t("stores.shelf.failed")); return; }
      if (party.trim() === "") { setNotice(t("stores.gate.partyNeeded")); return; }
      const ls = lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })).filter((l) => l.qty > 0);
      if (ls.length === 0) { setNotice(t("stores.gate.addItems")); return; }
      body = { kind, storeId: from, purpose, party: party.trim(), dueBack, lines: ls };
    } else {
      if (source === null) { setNotice(t("stores.gate.refNeeded")); return; }
      body = { kind, refType: source.type, refId: source.id };
    }
    setBusy(true);
    setNotice(null);
    raiseGatePass(body)
      .then((p) => { setMade(p); return qc.invalidateQueries({ queryKey: ["stores", "gate-passes"] }); })
      .catch((e: unknown) => setNotice(refusal(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="stores-new-pass" className="stores-ui" style={page}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.gate.newPass")}</h1>
      <div role="radiogroup" aria-label={t("stores.gate.newPass")} style={{ display: "flex", gap: 6 }}>
        {(["returnable", "non_returnable"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} style={{ ...(kind === k ? primary : btn), flex: 1, minWidth: 0, padding: "0 6px" }}
            onClick={() => { setKind(k); setNotice(null); }}>
            {t(k === "returnable" ? "stores.gate.returnable" : "stores.gate.nonReturnable")}
          </button>
        ))}
      </div>
      {form.data === undefined && !form.isError ? <div aria-busy="true"><GreyRows n={4} /></div>
        : form.isError ? <p role="status" style={{ margin: 0 }}>{t(storesErrorCode(form.error) === "not_permitted" ? "stores.gate.notYourRole" : "stores.shelf.failed")}</p>
        : kind === "returnable" ? (
          <>
            {stores.length > 1 && (
              <label style={stack}>
                <span>{t("stores.gate.from")}</span>
                <select value={from ?? ""} onChange={(e) => setStoreId(e.target.value)} style={input}>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label style={stack}>
              <span>{t("stores.gate.party")}</span>
              <input value={party} onChange={(e) => setParty(e.target.value)} maxLength={200} style={input} />
            </label>
            <div role="radiogroup" aria-label={t("stores.gate.purpose")} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {PURPOSES.map((pp) => (
                <button key={pp} type="button" role="radio" aria-checked={purpose === pp} style={purpose === pp ? primary : btn} onClick={() => setPurpose(pp)}>
                  {t(`stores.gate.purposes.${pp}`)}
                </button>
              ))}
            </div>
            <label style={stack}>
              <span>{t("stores.gate.dueBackLabel")}</span>
              <input type="date" value={dueBack} onChange={(e) => setDueBack(e.target.value)} style={input} />
            </label>
            {lines.map((l) => (
              <div key={l.itemId} style={rowStyle}>
                <span style={cell}>{l.name}</span>
                <input inputMode="numeric" aria-label={`${t("stores.shelf.qty")} · ${l.name}`} value={l.qty}
                  onChange={(e) => setLines((ls) => ls.map((x) => (x.itemId === l.itemId ? { ...x, qty: e.target.value.replace(/\D/g, "") } : x)))}
                  style={qtyBox} />
                <span style={unit}>{l.uom}</span>
                <button type="button" aria-label={`${t("stores.gate.remove")} · ${l.name}`} style={{ ...btn, padding: "0 10px" }}
                  onClick={() => setLines((ls) => ls.filter((x) => x.itemId !== l.itemId))}>×</button>
              </div>
            ))}
            <input type="search" aria-label={t("stores.shelf.search")} placeholder={t("stores.shelf.search")} value={q} onChange={(e) => setQ(e.target.value)} style={input} />
            {q.trim().length >= 2 && found.data !== undefined && (found.data.items.length === 0
              ? <p style={{ margin: 0 }}>{t("stores.gate.noItem")}</p>
              : found.data.items.slice(0, 8).map((it) => (
                <button key={it.id} type="button" style={{ ...btn, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => {
                  if (!lines.some((l) => l.itemId === it.id)) setLines((ls) => [...ls, { itemId: it.id, name: it.name, uom: it.baseUom, qty: "1" }]);
                  setQ("");
                }}>{it.name}</button>
              )))}
          </>
        ) : sources.length === 0 ? (
          <p role="status" style={{ margin: 0 }}>{t("stores.gate.noRecords")}</p>
        ) : (
          <div role="radiogroup" aria-label={t("stores.gate.pickRecord")} style={{ display: "flex", flexDirection: "column" }}>
            {sources.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={source?.id === s.id}
                style={{ display: "flex", flexDirection: "column", gap: 2, border: "none", borderBottom: "1px solid var(--rule, #e3e3e3)", background: source?.id === s.id ? "var(--line, #dfe7e1)" : "transparent", color: "inherit", textAlign: "left", width: "100%", font: "inherit", padding: "6px 8px", minHeight: 44, borderRadius: 6 }}
                onClick={() => setSource(s)}>
                <span style={{ display: "flex", gap: 8, width: "100%", whiteSpace: "nowrap", overflow: "hidden" }}>
                  <strong style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{s.no}</strong>
                  <span style={cell}>{s.party}</span>
                </span>
                <span style={{ display: "flex", gap: 8, width: "100%", whiteSpace: "nowrap", overflow: "hidden", fontSize: 14, color: "var(--dim, #5c6f66)" }}>
                  <span style={cell}>{`${t(s.type === "supplier_return" ? "stores.gate.supplierReturn" : s.type === "scrap_sale" ? "stores.gate.scrapSale" : "stores.gate.writeOff")} · ${s.lines.map((l) => `${l.itemName} ${String(l.qty)}`).join(" · ")}`}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      {notice !== null && <p role="status" style={{ margin: 0, fontWeight: 700 }}>{notice}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...primary, flex: 1, minHeight: 48 }} disabled={busy || form.data === undefined} onClick={raise}>{t("stores.gate.raise")}</button>
        <button type="button" style={btn} onClick={() => onDone(null)}>{t("stores.ticket.cancel")}</button>
      </div>
    </div>
  );
}
