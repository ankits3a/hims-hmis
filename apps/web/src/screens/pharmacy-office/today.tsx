import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { NeedTone, WireNeedClock, WireNeedFact, WireNeedRow, WireOfficeNeeds } from "../../lib/office-needs-api";

/**
 * ═══ GAP-CLOSURE B2 — THE OFFICE'S "NEEDS YOU TODAY" DESK ═══
 *
 * The owner-approved office board's Main artboard (and its Phone artboard at 390), ported 1:1: the
 * document in hand on the left with its facts, why it is here and the one act pinned at the bottom;
 * one unfiltered list in the centre, most urgent first (`GET /pharmacy/office/needs` ranks it); the
 * copilot's drafts and the clocks running on the right. No filter tabs; every act a person confirms,
 * in the existing sheet or screen for that document — the copilot only drafts.
 *
 * Keys: ↑↓ move · ⏎ open · A the act · Esc clear · F2 ask · F8 command.
 */
export type OfficeView = "today" | "buy" | "pay" | "returns" | "stock" | "items" | "law" | "reports";

/** Where an act goes: an existing sheet on this screen, an existing side opened on a document, or an existing screen. */
export type Go =
  | { to: "po"; id: string; decide: boolean; reject?: boolean }
  | { to: "plan" }
  | { to: "view"; view: OfficeView; page?: string; open?: { kind: string; [k: string]: unknown } }
  | { to: "route"; path: string };

const MONEY_PARAMS = new Set(["total", "over", "value", "expiredValue", "returnableValue", "destroyValue"]);
const DATE_PARAMS = new Set(["until", "expected", "from"]);

/** ₹1,84,300 — whole rupees, Indian grouping, as the board writes money in a list. */
export const money0 = (paise: number): string => `${paise < 0 ? "−" : ""}₹${Math.round(Math.abs(paise) / 100).toLocaleString("en-IN")}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** `2026-10-04` → `Sun 4 Oct` (params) or `04 Oct 2026` (facts). A calendar date, so no clock zone applies. */
export function dayWords(iso: string, long = false): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const m = MONTHS[d.getUTCMonth()] ?? "";
  return long ? `${String(d.getUTCDate()).padStart(2, "0")} ${m} ${String(d.getUTCFullYear())}` : `${WEEKDAYS[d.getUTCDay()] ?? ""} ${String(d.getUTCDate())} ${m}`;
}

function paramsOf(row: WireNeedRow, t: TFunction): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(row.params)) {
    if (MONEY_PARAMS.has(k) && typeof v === "number") out[k] = money0(v);
    else if (DATE_PARAMS.has(k) && typeof v === "string" && v !== "") out[k] = dayWords(v);
    else out[k] = v;
  }
  if (typeof row.params.licence === "string") out.licenceName = t(`pharmacyOffice.today.licence.${row.params.licence}`);
  if (typeof row.params.count === "number") out.count = row.params.count;
  return out;
}

export function needText(row: WireNeedRow, part: "title" | "sub" | "act" | "why" | "pri" | "sec" | "who" | "head", t: TFunction): string {
  const key = `pharmacyOffice.today.need.${row.kind}.${part}`;
  const text = t(key, paramsOf(row, t));
  return text === key ? "" : text;
}

export function clockText(c: WireNeedClock, t: TFunction): string {
  const n = c.n ?? 0;
  if (c.code === "waited") {
    if (n < 60) return t("pharmacyOffice.today.clock.waited_m", { m: n });
    if (n < 24 * 60) return t("pharmacyOffice.today.clock.waited_hm", { h: Math.floor(n / 60), m: n % 60 });
    return t("pharmacyOffice.today.clock.waited_d", { d: Math.floor(n / (24 * 60)) });
  }
  if (c.code === "days_ago" && n === 0) return t("pharmacyOffice.today.clock.today");
  return t(`pharmacyOffice.today.clock.${c.code}`, { n });
}

export const pillCls = (tone: NeedTone): string => (tone === "no" ? "pill" : `pill ${tone}`);

function factValue(f: WireNeedFact): string {
  if (f.as === "money" && typeof f.v === "number") return money0(f.v);
  if (f.as === "date" && typeof f.v === "string") return dayWords(f.v, true);
  return String(f.v);
}

/** The route every row's two acts take — the existing sheet, side or screen for that document. */
export function routeOf(row: WireNeedRow, which: "pri" | "sec"): Go | null {
  const id = row.ref.id;
  const pri = which === "pri";
  switch (row.kind) {
    case "po_approve": return id === null ? null : { to: "po", id, decide: true, reject: !pri };
    case "po_overdue": return pri ? (id === null ? null : { to: "po", id, decide: false }) : { to: "route", path: "/materials/grn" };
    case "po_draft": return pri && id !== null ? { to: "po", id, decide: false } : null;
    case "po_receive": return pri ? { to: "route", path: "/materials/grn" } : { to: "view", view: "buy" };
    case "shortages": return pri ? { to: "plan" } : { to: "route", path: "/pharmacy/reorder" };
    case "pay_overdue": case "pay_msme_due": case "pay_due":
      return pri ? { to: "view", view: "pay" } : { to: "view", view: "pay", open: { kind: "payables" } };
    case "run_authorise": return pri ? { to: "view", view: "pay", open: { kind: "run", runId: id } } : { to: "route", path: "/approvals" };
    case "bill_held": return pri ? { to: "view", view: "pay", open: { kind: "bill", billId: id } } : { to: "view", view: "pay", open: { kind: "payables" } };
    case "recall_open": return pri ? { to: "view", view: "returns", open: { kind: "recall", id } } : null;
    case "credit_awaited": return pri ? { to: "view", view: "returns", open: { kind: "return", id } } : { to: "view", view: "returns" };
    case "writeoff_post": return pri ? { to: "view", view: "returns", open: { kind: "writeoff", id } } : null;
    case "writeoff_approval": return pri ? { to: "view", view: "returns", open: { kind: "writeoff", id } } : { to: "route", path: "/approvals" };
    case "expiry": case "expiry_expired":
      return pri ? { to: "view", view: "returns", open: { kind: "plan" } } : { to: "view", view: "returns", open: { kind: "expiry", preset: row.kind === "expiry" ? "90" : "expired" } };
    case "grn_qc": case "opening_qc": return pri ? { to: "route", path: "/materials/grn" } : null;
    case "pharmacist_trial": case "pharmacist_expiring": case "pharmacist_lapsed": return pri ? { to: "route", path: "/pharmacy/pharmacists" } : null;
    // Stage D1 — an ADR not yet sent to PvPI: the register is a page of Law.
    case "adr_pvpi_overdue": case "adr_pvpi_serious": case "adr_pvpi": return pri ? { to: "view", view: "law", page: "adr" } : null;
    // Stage D2 — a medication incident not yet reviewed: the log is a page of Law.
    case "incident_review_overdue": case "incident_review": return pri ? { to: "view", view: "law", page: "incidents" } : null;
    // Stage D3 — the fridge log is a page of Stock: an open excursion to decide, a reading missed today.
    case "cold_excursion_open": case "cold_reading_missed": return pri ? { to: "view", view: "stock", page: "cold" } : null;
    // Stage D4 — the emergency trays are a page of Stock: a deficient tray to restock, a check missed, stock expiring.
    case "tray_deficient": case "tray_daily_missed": case "tray_monthly_missed": case "tray_expiring": return pri ? { to: "view", view: "stock", page: "trays" } : null;
    // Stage D5 — the steward is appointed at users and roles; an ask waiting is decided in Approvals.
    case "steward_not_appointed": return pri ? { to: "route", path: "/admin/users" } : null;
    case "steward_approval_waiting": return pri ? { to: "route", path: "/approvals" } : null;
    default:
      if (row.kind.startsWith("retail_licence_")) return pri ? { to: "route", path: "/pharmacy/retail-licence" } : null;
      if (row.kind.startsWith("cabinet_")) return pri ? { to: "view", view: "law", page: "controlled" } : null;
      return null;
  }
}

type DeskProps = {
  data: WireOfficeNeeds | undefined;
  error: string | null;
  narrow: boolean;
  /** False while a sheet is open over the desk — its keys are the sheet's then. */
  keysLive: boolean;
  onGo: (go: Go) => void;
  onCopilot: (which: "po" | "pay" | "returns") => void;
  onAsk: (q: string) => void;
  answer: string | null;
  busy: boolean;
  onCommand: (() => void) | null;
  /** Phone: a row opened full screen; the frame hides its header while it is. */
  onFullScreen?: (open: boolean) => void;
};

export function TodayDesk(p: DeskProps): React.ReactElement {
  const { t } = useTranslation();
  const rows = useMemo(() => p.data?.rows ?? [], [p.data]);
  const [inHandId, setInHandId] = useState<string | null>(null);
  const inHand = rows.find((r) => r.id === inHandId) ?? null;
  const listRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [clocksOpen, setClocksOpen] = useState(false);

  // A row that left the list (acted on elsewhere) leaves the lane too.
  useEffect(() => { if (inHandId !== null && p.data !== undefined && inHand === null) setInHandId(null); }, [inHandId, inHand, p.data]);
  const onFullScreen = p.onFullScreen;
  const full = p.narrow && inHand !== null;
  useEffect(() => { onFullScreen?.(full); }, [onFullScreen, full]);

  const act = (row: WireNeedRow, which: "pri" | "sec"): void => {
    const go = routeOf(row, which);
    if (go !== null) p.onGo(go);
  };

  useEffect(() => {
    if (!p.keysLive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing = el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "F2") { e.preventDefault(); askRef.current?.focus(); return; }
      if (e.key === "F8" && p.onCommand !== null) { e.preventDefault(); p.onCommand(); return; }
      if (typing) { if (e.key === "Escape") el.blur(); return; }
      if (e.key === "Escape") { if (inHandId !== null) { e.preventDefault(); setInHandId(null); } return; }
      if ((e.key === "a" || e.key === "A") && inHand !== null) { e.preventDefault(); act(inHand, "pri"); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-need-row]") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const from = i >= 0 ? i : Math.max(-1, rows.findIndex((r) => r.id === inHandId));
      const next = e.key === "ArrowDown" ? Math.min(buttons.length - 1, from + 1) : Math.max(0, from < 0 ? 0 : from - 1);
      buttons[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const submitAsk = (e: React.FormEvent): void => { e.preventDefault(); if (q.trim() !== "") p.onAsk(q); };
  const clocks = rows.filter((r) => r.clock.n !== undefined && r.clock.code !== "window").slice(0, 5);
  const sides = (p.data?.sides ?? []).map((s) => t(`pharmacyOffice.today.side.${s}`));
  const cp = p.data?.copilot;
  const drafts: { which: "po" | "pay" | "returns"; what: string; rest: string }[] = [];
  if (cp?.po != null && cp.po.orders + cp.po.unassigned > 0) {
    drafts.push({ which: "po", what: t("pharmacyOffice.today.copilot.poWhat", { count: cp.po.orders + cp.po.unassigned }), rest: t("pharmacyOffice.today.copilot.poRest", { lines: cp.po.lines, unassigned: cp.po.unassigned }) });
  }
  if (cp?.pay != null && cp.pay.bills > 0) {
    drafts.push({ which: "pay", what: t("pharmacyOffice.today.copilot.payWhat"), rest: cp.pay.creditPaise > 0
      ? t("pharmacyOffice.today.copilot.payRestCredit", { count: cp.pay.bills, until: dayWords(cp.pay.until), credit: money0(cp.pay.creditPaise), total: money0(Math.max(0, cp.pay.totalPaise - cp.pay.creditPaise)) })
      : t("pharmacyOffice.today.copilot.payRest", { count: cp.pay.bills, until: dayWords(cp.pay.until), total: money0(cp.pay.totalPaise) }) });
  }
  if (cp?.returns != null && cp.returns.vendors > 0) {
    drafts.push({ which: "returns", what: t("pharmacyOffice.today.copilot.retWhat", { count: cp.returns.vendors }), rest: t("pharmacyOffice.today.copilot.retRest", { total: money0(cp.returns.taxablePaise) }) });
  }

  const laneBody = inHand === null ? null : (
    <>
      <div style={{ padding: "18px 18px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="src">{t(`pharmacyOffice.today.src.${inHand.source}`)}</span>
          <span className="mo" style={{ fontSize: 11, color: "var(--dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{docOf(inHand)}</span>
        </div>
        <h2 style={{ margin: "10px 0 0", fontSize: 16, lineHeight: "22px", fontWeight: 600 }} data-testid="in-hand-head">{needText(inHand, "head", t) || needText(inHand, "title", t)}</h2>
      </div>
      <div style={{ padding: "0 18px", flexGrow: 1, overflow: "auto", minHeight: 0 }}>
        {inHand.facts.map((f, i) => (
          <div key={`${f.k}-${String(i)}`} className="fact"><span style={{ color: "var(--dim)" }}>{f.raw === true ? f.k : t(`pharmacyOffice.today.fact.${f.k}`)}</span><span className="mo">{factValue(f)}</span></div>
        ))}
        <div className="tag" style={{ margin: "16px 0 6px" }}>{t("pharmacyOffice.today.why")}</div>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: "18px" }} data-testid="in-hand-why">{needText(inHand, "why", t)}</p>
      </div>
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="pri" style={{ width: "100%" }} data-testid="in-hand-pri" onClick={() => act(inHand, "pri")}>
          {needText(inHand, "pri", t)} <span className="kb" style={{ background: "transparent", color: "#cfe8dc", borderColor: "#3f8a70" }}>A</span>
        </button>
        {routeOf(inHand, "sec") !== null && needText(inHand, "sec", t) !== "" && (
          <button type="button" className="sec" style={{ width: "100%" }} data-testid="in-hand-sec" onClick={() => act(inHand, "sec")}>{needText(inHand, "sec", t)}</button>
        )}
        <span style={{ fontSize: 11, color: "var(--dim)" }}>{needText(inHand, "who", t)}</span>
      </div>
    </>
  );

  if (p.narrow) {
    if (inHand !== null) {
      return (
        <div className="pof-full" role="dialog" aria-modal="true" aria-label={needText(inHand, "title", t)} data-testid="in-hand">
          <div className="pof-ptop">
            <button type="button" className="pof-pmenu" onClick={() => setInHandId(null)} data-testid="in-hand-back">‹ {t("pharmacyOffice.today.back")}</button>
          </div>
          <div style={{ flexGrow: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>{laneBody}</div>
        </div>
      );
    }
    return (
      <div className="pof-pscroll">
        <div style={{ padding: "12px 12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {drafts.length > 0 && (
            <button type="button" data-testid="office-copilot" onClick={() => p.onCopilot(drafts[0]!.which)}
              style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "8px 12px", border: "1px solid var(--green-line)", borderRadius: 8, background: "var(--card)", boxShadow: "inset 3px 0 0 var(--mint)" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--mint)", flexShrink: 0 }} />
              <span style={{ flexGrow: 1, fontSize: 12, lineHeight: "16px" }}>
                {t("pharmacyOffice.today.copilot.phoneLead")} {drafts.map((d, i) => <span key={d.which}>{i === 0 ? "" : i === drafts.length - 1 ? ` ${t("pharmacyOffice.today.copilot.and")} ` : ", "}<b>{d.what}</b></span>)} — {t("pharmacyOffice.today.copilot.review").toLowerCase()}
              </span>
              <span aria-hidden="true" style={{ color: "var(--dim)" }}>›</span>
            </button>
          )}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{t("pharmacyOffice.today.title")}</h1>
            <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{rows.length}</span>
          </div>
        </div>
        {p.error !== null && <p role="alert" style={{ margin: "8px 12px 0", color: "var(--red)", fontSize: 12.5 }}>{p.error}</p>}
        {rows.length > 0 && (
          <div ref={listRef} className="box" style={{ margin: "8px 12px 0", overflow: "hidden" }} data-testid="needs-list">
            {rows.map((r) => (
              <button key={r.id} type="button" className="prow" data-need-row data-testid={`need-${r.id}`} onClick={() => setInHandId(r.id)}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="src">{t(`pharmacyOffice.today.src.${r.source}`)}</span><span className={pillCls(r.clock.tone)}>{clockText(r.clock, t)}</span></span>
                <span style={{ fontSize: 13, fontWeight: 600, lineHeight: "18px" }}>{needText(r, "title", t)}</span>
              </button>
            ))}
          </div>
        )}
        {p.data !== undefined && rows.length === 0 && <p style={{ margin: "10px 12px", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyOffice.today.empty")}</p>}
        <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--dim)" }}>{t("pharmacyOffice.today.phoneHint")}</div>
      </div>
    );
  }

  return (
    <div className="pof-body" data-testid="office-today">
      <aside aria-label={t("pharmacyOffice.today.inHandAria")} className="pof-lane" data-testid="in-hand">
        {inHand === null ? (
          <div style={{ padding: "20px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="tag">{t("pharmacyOffice.today.nothing.tag")}</div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: "19px", color: "var(--dim)" }}>{t("pharmacyOffice.today.nothing.body")}</p>
            <div>
              <div className="tag" style={{ marginBottom: 6 }}>{t("pharmacyOffice.today.nothing.keys")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12 }}>
                {([["↑↓", "move"], ["⏎", "open"], ["A", "act"], ["Esc", "clear"], ["F2", "ask"], ...(p.onCommand === null ? [] : [["F8", "command"]])] as const).map(([k, w]) => (
                  <div key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="kb">{k}</span>{t(`pharmacyOffice.today.nothing.${w}`)}</div>
                ))}
              </div>
            </div>
          </div>
        ) : laneBody}
      </aside>

      <main className="pof-main">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t("pharmacyOffice.today.title")}</h1>
          <span style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="needs-sub">
            {p.data === undefined ? "" : rows.length === 0 ? t("pharmacyOffice.today.empty") : t("pharmacyOffice.today.sub", { count: rows.length, sides: sides.join(", ") })}
          </span>
        </div>
        {p.error !== null && <p role="alert" style={{ margin: "0 0 10px", color: "var(--red)", fontSize: 12.5 }}>{p.error}</p>}
        <div className="box pof-list" ref={listRef} data-testid="needs-list">
          {rows.map((r) => (
            <button key={r.id} type="button" className={r.id === inHandId ? "row sel" : "row"} data-need-row data-testid={`need-${r.id}`} aria-pressed={r.id === inHandId}
              onClick={() => setInHandId(r.id)}>
              <span className="src">{t(`pharmacyOffice.today.src.${r.source}`)}</span>
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{needText(r, "title", t)}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>{needText(r, "sub", t)}</span>
              </span>
              <span className={pillCls(r.clock.tone)}>{clockText(r.clock, t)}</span>
              <span className="mo row-act">{needText(r, "act", t)} →</span>
            </button>
          ))}
        </div>
        <div style={{ height: 16, flexShrink: 0 }} />
      </main>

      <aside aria-label={t("pharmacyOffice.today.rightAria")} className="pof-right">
        <section className="box" style={{ padding: 14, borderColor: "var(--green-line)", boxShadow: "inset 3px 0 0 var(--mint)" }} data-testid="office-copilot">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--mint)" }} />
            <span className="tag" style={{ color: "var(--green)" }}>{t("pharmacyOffice.today.copilot.tag")}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
            {drafts.length === 0 && <div style={{ padding: "9px 0", borderTop: "1px solid var(--line2)", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyOffice.today.copilot.none")}</div>}
            {drafts.map((d) => (
              <div key={d.which} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--line2)" }} data-testid={`copilot-${d.which}`}>
                <span style={{ flexGrow: 1, fontSize: 12.5, lineHeight: "17px" }}><b>{d.what}</b> {d.rest}</span>
                <button type="button" className="agdo" onClick={() => p.onCopilot(d.which)}>{t("pharmacyOffice.today.copilot.review")}</button>
              </div>
            ))}
          </div>
          <form onSubmit={submitAsk} style={{ display: "block", marginTop: 10 }}>
            <label style={{ display: "block" }}>
              <span className="tag">{t("pharmacyOffice.today.copilot.ask")}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, height: 38, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--card)" }}>
                <input ref={askRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("pharmacyOffice.today.copilot.placeholder")}
                  aria-label={t("pharmacyOffice.today.copilot.askAria")} style={{ flexGrow: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 12.5 }} />
                <span className="kb">F2</span>
              </span>
            </label>
          </form>
          {(p.busy || p.answer !== null) && (
            <p role="status" style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: "17px" }} data-testid="copilot-answer">{p.busy ? t("pharmacyOffice.today.copilot.thinking") : p.answer}</p>
          )}
          <p style={{ margin: "8px 0 0", fontSize: 11, lineHeight: "15px", color: "var(--dim)" }}>{t("pharmacyOffice.today.copilot.note")}</p>
        </section>

        <section className="box" style={{ padding: 0 }} data-testid="office-clocks">
          <button type="button" onClick={() => setClocksOpen((o) => !o)} aria-expanded={clocksOpen} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "12px 14px" }}>
            <span className="tag" style={{ flexGrow: 1, whiteSpace: "nowrap" }}>{t("pharmacyOffice.today.clocks", { count: clocks.length })}</span>
            {clocks[0] !== undefined && (
              <span style={{ fontSize: 11.5, color: clocks[0].clock.tone === "rd" ? "var(--red)" : "var(--gold-ink, #9a6208)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                {t(`pharmacyOffice.today.need.${clocks[0].kind}.clock`, { ...paramsOf(clocks[0], t), clock: clockText(clocks[0].clock, t) })}: {clockText(clocks[0].clock, t)}
              </span>
            )}
            <span aria-hidden="true" style={{ color: "var(--dim)" }}>{clocksOpen ? "▴" : "▾"}</span>
          </button>
          {clocksOpen && (
            <div style={{ padding: "0 14px 10px" }}>
              {clocks.map((c) => (
                <div key={c.id} className="fact">
                  <span>{t(`pharmacyOffice.today.need.${c.kind}.clock`, { ...paramsOf(c, t), clock: clockText(c.clock, t) })}</span>
                  <span className="mo" style={{ color: c.clock.tone === "rd" ? "var(--red)" : c.clock.tone === "gd" ? "var(--gold-ink, #9a6208)" : undefined }}>{clockText(c.clock, t)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

/** The document number the lane's header shows beside the source. */
function docOf(row: WireNeedRow): string {
  const p = row.params;
  const first = p.poNo ?? p.billNo ?? p.runNo ?? p.note ?? p.no ?? p.recallNo ?? p.grnNo ?? p.challan ?? p.form20;
  return first === undefined ? "" : String(first);
}
