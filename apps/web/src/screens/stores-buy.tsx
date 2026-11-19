import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  approvePr, approveSupplierCategory, budgetsForMonth, overBudget, bulkApprovePrs, buyContext, declinePr, delegate, delegationCandidates, grnsForQc, myDelegations,
  myPrs, postQcGrn, previewLine, prsToApprove, raisePr, setBudget, setSupplierFields, signQc, suppliers,
} from "../lib/buying-api";
import { listCategories, searchItems, storesErrorCode } from "../lib/stores-api";
import { useOnline } from "./stores-tickets";
import "./stores.css";
import type { BuyContext, LinePreview, PrLineBody } from "../lib/buying-api";
import type { StoresBand, WirePurchaseRequest, WireStoresGrnForQc, WireStoresSupplier, WireSupplierKyc } from "@hmis/contracts";

/**
 * STORES S5a (#1115, spec "## Screens") — `/stores/buy`, THE FRONT OF THE BUYING DESK.
 *
 * Phone (390 px, no sideways scroll): Ask to buy (item from the list, quantity, the estimate that fills itself, the three
 * answers for equipment; Send), To approve (item · quantity · estimate, band word, "Split?", the budget line; Approve in
 * one tap, Decline with a reason; the materials head and the owner tick several and Approve all), My requests (status
 * words), Hand over (an HOD's approval to a colleague, at most 30 days). Desk (16:9): Budgets (finance), Suppliers (KYC
 * words, MSME activity, e-invoice, category approval) and QC (a non-drug delivery's QC and post, no pharmacist).
 * A notice opens here with `?pr=`, that request first. Every status is a word; loading is grey rows with no text.
 */
type Tab = "ask" | "approve" | "mine" | "handover" | "budgets" | "suppliers" | "qc";

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const btn: React.CSSProperties = { minHeight: 44, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" };
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const input: React.CSSProperties = { width: "100%", minHeight: 44 };
const card: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, borderTop: "2px solid var(--ink, #222)", paddingTop: 8 };
const line: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minHeight: 32, overflow: "hidden" };
const cell: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid var(--ink, #222)", whiteSpace: "nowrap", fontSize: 14 };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--rule, #e3e3e3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 };

const money = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const thisMonth = (): string => {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const dayOf = (iso: string, lang: string): string =>
  new Date(iso).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ height: 44, background: "var(--rule, #eee)", borderRadius: 4, marginBottom: 6 }} />)}</div>;
}

function Notice({ n }: { n: { text: string; ok: boolean } | null }): React.ReactElement | null {
  if (n === null) return null;
  return (
    <p role="status" data-tone={n.ok ? "ok" : "refused"} style={{
      margin: 0, fontWeight: 700, fontSize: 17, padding: "8px 12px", borderRadius: 6,
      borderLeft: `6px solid ${n.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`, background: "var(--line, #eef2ef)",
    }}>{n.text}</p>
  );
}

/** A refusal's few words: the server's code, "No connection" when the network failed, else "Could not save". */
function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    if (!(e instanceof ApiError)) return t("stores.ticket.offline");
    const code = storesErrorCode(e);
    if (code === "not_permitted") return t("stores.buy.nothingToAsk");
    return code === null ? t("stores.err.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.err.failed") });
  };
}

function BandWord({ band }: { band: StoresBand }): React.ReactElement {
  const { t } = useTranslation();
  return <span data-band={band} style={{ ...word, borderStyle: band === "C" ? "double" : "solid", borderWidth: band === "C" ? 3 : 1 }}>{t(`stores.buy.band.${band}`)}</span>;
}

function StatusWord({ status }: { status: WirePurchaseRequest["status"] }): React.ReactElement {
  const { t } = useTranslation();
  return <span data-status={status} style={{ ...word, borderStyle: status === "declined" || status === "cancelled" ? "dashed" : "solid" }}>{t(`stores.buy.status.${status}`)}</span>;
}

function BudgetLine({ b }: { b: WirePurchaseRequest["budget"] }): React.ReactElement | null {
  const { t } = useTranslation();
  if (b === null) return null;
  const text = b.noBudget ? t("stores.buy.noBudget") : b.over ? t("stores.buy.overBudget") : t("stores.buy.budgetUsed", { pct: b.pct ?? 0 });
  return <span data-testid="budget-line" style={{ ...word, fontWeight: b.over ? 800 : 600, borderStyle: b.over ? "dashed" : "solid" }}>{text}</span>;
}

/* ═══════════════════════════════ the screen ═══════════════════════════════ */

export function StoresBuy(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { pr?: string; tab?: string; month?: string };
  const ctx = useQuery({ queryKey: ["stores", "buy", "context"], queryFn: buyContext, retry: false });
  const tabs = tabsOf(ctx.data);
  const [tab, setTab] = useState<Tab | null>(null);
  const first: Tab | null = search.pr !== undefined && tabs.includes("approve") ? "approve"
    : (search.tab !== undefined && (tabs as string[]).includes(search.tab) ? search.tab as Tab : tabs[0] ?? null);
  const shown = tab !== null && tabs.includes(tab) ? tab : first;
  const online = useOnline();
  return (
    <div data-testid="stores-buy" className="stores-ui" style={page}>
      {!online && <p role="alert" style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.offline")}</p>}
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.buy.title")}</h1>
      {ctx.data === undefined && !ctx.isError ? <GreyRows n={4} />
        : shown === null ? <p data-testid="buy-denied" style={{ margin: 0, fontWeight: 700 }}>{t("stores.buy.nothingToAsk")}</p>
        : (
          <>
            <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {tabs.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={shown === k} style={shown === k ? primary : btn} onClick={() => setTab(k)}>{t(`stores.buy.tab.${k}`)}</button>
              ))}
            </div>
            {shown === "ask" && <AskTab ctx={ctx.data!} />}
            {shown === "approve" && <ApproveTab ctx={ctx.data!} focus={search.pr} />}
            {shown === "mine" && <MineTab />}
            {shown === "handover" && <HandoverTab ctx={ctx.data!} />}
            {shown === "budgets" && <BudgetsTab initialMonth={search.month} />}
            {shown === "suppliers" && <SuppliersTab masters={ctx.data!.can.masters} />}
            {shown === "qc" && <QcTab />}
          </>
        )}
    </div>
  );
}

function tabsOf(c: BuyContext | undefined): Tab[] {
  if (c === undefined) return [];
  const out: Tab[] = [];
  const ask = c.departments.some((d) => d.canAsk) || c.can.buying;
  if (ask) out.push("ask");
  if (c.departments.some((d) => d.canApprove) || c.can.masters) out.push("approve");
  if (ask) out.push("mine");
  if (c.departments.some((d) => d.ownHod)) out.push("handover");
  if (c.can.budget) out.push("budgets");
  if (c.can.buying) out.push("suppliers");
  if (c.can.qc) out.push("qc");
  return out;
}

/* ─────────────── Ask to buy (phone) ─────────────── */

type Draft = { preview: LinePreview; qty: string; estimate: string; why: string; replacesTag: string; usePerDay: string };

function AskTab({ ctx }: { ctx: BuyContext }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const askable = ctx.departments.filter((d) => d.canAsk);
  const central = askable.length === 0 && ctx.can.buying;
  const [deptId, setDeptId] = useState<string>(askable[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [priority, setPriority] = useState<"routine" | "urgent" | "emergency">("routine");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const found = useQuery({ queryKey: ["stores", "search", q.trim()], queryFn: () => searchItems(q), enabled: q.trim().length >= 2, retry: false });
  const dept = askable.find((d) => d.id === deptId);
  const pick = (itemId: string): void => {
    setQ("");
    previewLine(itemId, central ? null : deptId).then((p) => {
      if (p.stockItem && !central) { setNotice({ text: t("stores.buy.stockItem"), ok: false }); return; }
      if (lines.some((l) => l.preview.itemId === p.itemId)) return;
      setNotice(null);
      setLines([...lines, { preview: p, qty: "1", estimate: "", why: "", replacesTag: "", usePerDay: "" }]);
    }).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }));
  };
  const set = (i: number, patch: Partial<Draft>): void => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ready = lines.length > 0 && lines.every((l) => Number(l.qty) > 0 && Number.isInteger(Number(l.qty))
    && (l.preview.unitEstimatePaise !== null || Number(l.estimate) > 0)
    && (!l.preview.equipment || central || (l.why.trim() !== "" && l.usePerDay.trim() !== "")));
  const send = (): void => {
    setBusy(true);
    const body: PrLineBody[] = lines.map((l) => ({
      itemId: l.preview.itemId, qtyBase: Number(l.qty),
      ...(l.preview.unitEstimatePaise === null ? { estimatePaise: Math.round(Number(l.estimate) * 100) } : {}),
      ...(l.preview.equipment ? { equipment: { why: l.why.trim(), replacesTag: l.replacesTag.trim() || null, usePerDay: l.usePerDay.trim() } } : {}),
    }));
    raisePr(central ? { source: "central", priority, lines: body } : { source: "department", departmentId: deptId, shelfId: dept?.shelves[0]?.id ?? null, priority, lines: body })
      .then((pr) => {
        setLines([]);
        setNotice({ text: `${t("stores.buy.sent")} · ${pr.prNo}`, ok: true });
        void qc.invalidateQueries({ queryKey: ["stores", "buy"] });
      })
      .catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))
      .finally(() => setBusy(false));
  };
  return (
    <section data-testid="buy-ask" style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
      <Notice n={notice} />
      {askable.length > 1 && (
        <label style={stack}>
          <span>{t("stores.buy.department")}</span>
          <select aria-label={t("stores.buy.department")} value={deptId} onChange={(e) => setDeptId(e.target.value)} style={input}>
            {askable.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      {askable.length === 1 && <p style={{ margin: 0, fontWeight: 600 }}>{askable[0]!.name}</p>}
      <label style={stack}>
        <span>{t("stores.buy.item")}</span>
        <input aria-label={t("stores.buy.item")} placeholder={t("stores.buy.searchItem")} value={q} onChange={(e) => setQ(e.target.value)} style={input} />
      </label>
      {q.trim().length >= 2 && (
        <div data-testid="buy-results" style={{ display: "flex", flexDirection: "column" }}>
          {found.data === undefined ? <GreyRows n={2} />
            : found.data.items.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.chooseFromList")}</p>
            : found.data.items.slice(0, 8).map((it) => (
              <button key={it.id} type="button" style={{ ...btn, textAlign: "left", borderWidth: 0, borderBottomWidth: 1, borderRadius: 0, display: "flex", gap: 8 }} onClick={() => pick(it.id)}>
                <span style={cell}>{it.name}</span><span style={{ color: "var(--dim, #5c6f66)" }}>{it.code.slice(-4)}</span>
              </button>
            ))}
        </div>
      )}
      {lines.map((l, i) => (
        <div key={l.preview.itemId} data-testid={`ask-line-${String(i)}`} style={card}>
          <div style={line}>
            <strong style={cell}>{l.preview.name}</strong>
            <button type="button" style={{ ...btn, minHeight: 36 }} onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("stores.buy.remove")}</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ ...stack, flex: 1 }}>
              <span>{t("stores.buy.qty")}</span>
              <input aria-label={t("stores.buy.qty")} inputMode="numeric" value={l.qty} onChange={(e) => set(i, { qty: e.target.value.replace(/\D/g, "") })} style={input} />
            </label>
            {l.preview.unitEstimatePaise === null ? (
              <label style={{ ...stack, flex: 1 }}>
                <span>{t("stores.buy.estimate", { uom: l.preview.baseUom })}</span>
                <input aria-label={t("stores.buy.estimate", { uom: l.preview.baseUom })} inputMode="decimal" value={l.estimate} onChange={(e) => set(i, { estimate: e.target.value.replace(/[^\d.]/g, "") })} style={input} />
              </label>
            ) : (
              <div style={{ ...stack, flex: 1, justifyContent: "flex-end" }}>
                <span style={{ fontWeight: 600 }}>{t("stores.buy.each", { amount: money(l.preview.unitEstimatePaise) })}</span>
                <span style={{ fontSize: 13 }}>{t(`stores.buy.estimateFrom.${l.preview.estimateSource ?? "last"}`)}</span>
              </div>
            )}
          </div>
          {l.preview.equipment && !central && (
            <>
              <label style={stack}><span>{t("stores.buy.why")}</span>
                <input aria-label={t("stores.buy.why")} maxLength={200} value={l.why} onChange={(e) => set(i, { why: e.target.value })} style={input} /></label>
              <label style={stack}><span>{t("stores.buy.replacesTag")}</span>
                <input aria-label={t("stores.buy.replacesTag")} maxLength={40} value={l.replacesTag} onChange={(e) => set(i, { replacesTag: e.target.value })} style={input} /></label>
              <label style={stack}><span>{t("stores.buy.usePerDay")}</span>
                <input aria-label={t("stores.buy.usePerDay")} maxLength={60} value={l.usePerDay} onChange={(e) => set(i, { usePerDay: e.target.value })} style={input} /></label>
            </>
          )}
        </div>
      ))}
      {lines.length > 0 && (
        <div role="radiogroup" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["routine", "urgent", "emergency"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={priority === p} style={priority === p ? primary : btn} onClick={() => setPriority(p)}>{t(`stores.buy.priority.${p}`)}</button>
          ))}
        </div>
      )}
      <button type="button" data-testid="buy-send" style={{ ...primary, minHeight: 52 }} disabled={!ready || busy} onClick={send}>{t("stores.buy.send")}</button>
    </section>
  );
}

/* ─────────────── To approve (phone; bulk for the materials head and the owner) ─────────────── */

function ApproveTab({ ctx, focus }: { ctx: BuyContext; focus?: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const q = useQuery({ queryKey: ["stores", "buy", "to-approve"], queryFn: prsToApprove, retry: false });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const rows = [...(q.data?.requests ?? [])].sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  const after = (text: string): void => { setNotice({ text, ok: true }); setTicked([]); void qc.invalidateQueries({ queryKey: ["stores", "buy"] }); };
  const failed = (e: unknown): void => { setNotice({ text: refusal(e), ok: false }); void qc.invalidateQueries({ queryKey: ["stores", "buy"] }); };
  return (
    <section data-testid="buy-approve" style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
      <Notice n={notice} />
      {ctx.can.bulk && rows.length > 1 && (
        <button type="button" data-testid="buy-approve-all" style={{ ...primary, minHeight: 48 }} disabled={ticked.length === 0}
          onClick={() => bulkApprovePrs(ticked).then((r) => after(t("stores.buy.approvedAll", { n: r.requests.length }))).catch(failed)}>
          {`${t("stores.buy.approveAll")}${ticked.length > 0 ? ` (${String(ticked.length)})` : ""}`}
        </button>
      )}
      {q.data === undefined && !q.isError ? <GreyRows n={3} />
        : q.isError ? <p style={{ margin: 0, fontWeight: 700 }}>{refusal(q.error)}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.nothingToApprove")}</p>
        : rows.map((pr) => (
          <PrCard key={pr.id} pr={pr} bulk={ctx.can.bulk && rows.length > 1} ticked={ticked.includes(pr.id)}
            onTick={(on) => setTicked(on ? [...ticked, pr.id] : ticked.filter((x) => x !== pr.id))}
            onDone={after} onFail={failed} />
        ))}
    </section>
  );
}

function PrCard({ pr, bulk, ticked, onTick, onDone, onFail }: {
  pr: WirePurchaseRequest; bulk: boolean; ticked: boolean; onTick: (on: boolean) => void; onDone: (text: string) => void; onFail: (e: unknown) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <article data-testid={`pr-${pr.id}`} style={card}>
      <div style={line}>
        {bulk && <input type="checkbox" aria-label={pr.prNo} checked={ticked} onChange={(e) => onTick(e.target.checked)} style={{ width: 24, height: 24, flexShrink: 0 }} />}
        <strong style={cell}>{pr.department?.name ?? pr.prNo}</strong>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>{pr.prNo.slice(-4)}</span>
      </div>
      {pr.lines.map((l) => (
        <div key={l.lineIdx} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ ...line, alignItems: "flex-start" }}>
            {/* The HOD reads the whole name: it wraps to a second line rather than being cut. */}
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{l.itemName}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{`× ${String(l.qtyBase)}`}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 80, textAlign: "right" }}>{money(l.qtyBase * l.unitEstimatePaise)}</span>
          </div>
          {l.answers !== null && (
            <span data-testid="equipment-answers" style={{ fontSize: 14, color: "var(--dim, #5c6f66)", overflowWrap: "anywhere" }}>
              {[l.answers.why, l.answers.replacesTag === null ? null : `${t("stores.buy.replacesTag")} ${l.answers.replacesTag}`, `${t("stores.buy.usePerDay")}: ${l.answers.usePerDay}`]
                .filter((x): x is string => x !== null && x !== "").join(" · ")}
            </span>
          )}
        </div>
      ))}
      <div style={{ ...line, flexWrap: "wrap", minHeight: 0 }}>
        <BandWord band={pr.band} />
        {pr.split !== null && <span data-testid="split" style={{ ...word, borderStyle: "dashed" }}>{t("stores.buy.split")}</span>}
        {pr.lines.some((l) => l.equipment) && <span style={word}>{t("stores.buy.equipment")}</span>}
        <BudgetLine b={pr.budget} />
      </div>
      {declining ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={stack}><span>{t("stores.buy.reason")}</span>
            <input aria-label={t("stores.buy.reason")} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} style={input} autoFocus /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={{ ...primary, flex: 1, minHeight: 48 }} disabled={why.trim() === ""}
              onClick={() => declinePr(pr.id, why.trim()).then(() => onDone(t("stores.buy.declined"))).catch(onFail)}>{t("stores.buy.decline")}</button>
            <button type="button" style={btn} onClick={() => setDeclining(false)}>{t("stores.assets.cancel")}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" data-testid={`approve-${pr.id}`} style={{ ...primary, flex: 1, minHeight: 48 }}
            onClick={() => approvePr(pr.id).then(() => onDone(t("stores.buy.approved"))).catch(onFail)}>{t("stores.buy.approve")}</button>
          <button type="button" style={{ ...btn, minHeight: 48 }} onClick={() => setDeclining(true)}>{t("stores.buy.decline")}</button>
        </div>
      )}
    </article>
  );
}

/* ─────────────── My requests ─────────────── */

function MineTab(): React.ReactElement {
  const { t } = useTranslation();
  const refusal = useRefusal();
  const q = useQuery({ queryKey: ["stores", "buy", "mine"], queryFn: myPrs, retry: false });
  const rows = q.data?.requests ?? [];
  return (
    <section data-testid="buy-mine" style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 640 }}>
      {q.data === undefined && !q.isError ? <GreyRows n={3} />
        : q.isError ? <p style={{ margin: 0, fontWeight: 700 }}>{refusal(q.error)}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.nothingYet")}</p>
        : rows.map((pr) => (
          <div key={pr.id} style={{ ...line, minHeight: 44, borderBottom: "1px solid var(--rule, #e3e3e3)" }}>
            <span style={cell}>{pr.lines.map((l) => l.itemName).join(", ")}</span>
            <BandWord band={pr.band} />
            <StatusWord status={pr.status} />
          </div>
        ))}
    </section>
  );
}

/* ─────────────── Hand over (the HOD) ─────────────── */

function HandoverTab({ ctx }: { ctx: BuyContext }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const own = ctx.departments.filter((d) => d.ownHod);
  const meId = useAuth().actor?.id ?? "";
  const [deptId, setDeptId] = useState(own[0]?.id ?? "");
  const people = useQuery({ queryKey: ["stores", "buy", "candidates", deptId], queryFn: () => delegationCandidates(deptId), enabled: deptId !== "", retry: false });
  const mine = useQuery({ queryKey: ["stores", "buy", "delegations"], queryFn: myDelegations, retry: false });
  const [to, setTo] = useState("");
  const [until, setUntil] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => { setTo(people.data?.people[0]?.id ?? ""); }, [people.data]);
  const max = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const go = (): void => {
    const now = new Date();
    delegate({ toUserId: to, scope: "hod_approval", departmentId: deptId, from: now.toISOString(), to: new Date(`${until}T23:59:00+05:30`).toISOString() })
      .then(() => { setNotice({ text: t("stores.buy.handedOver"), ok: true }); void qc.invalidateQueries({ queryKey: ["stores", "buy", "delegations"] }); })
      .catch((e: unknown) => setNotice({ text: refusal(e), ok: false }));
  };
  return (
    <section data-testid="buy-handover" style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t("stores.buy.handoverTitle")}</h2>
      <Notice n={notice} />
      {own.length > 1 && (
        <label style={stack}><span>{t("stores.buy.department")}</span>
          <select aria-label={t("stores.buy.department")} value={deptId} onChange={(e) => setDeptId(e.target.value)} style={input}>
            {own.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
      )}
      {people.data !== undefined && people.data.people.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.noColleagues")}</p> : (
        <>
          <label style={stack}><span>{t("stores.buy.to")}</span>
            <select aria-label={t("stores.buy.to")} value={to} onChange={(e) => setTo(e.target.value)} style={input}>
              {(people.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          <label style={stack}><span>{t("stores.buy.until")}</span>
            <input aria-label={t("stores.buy.until")} type="date" value={until} max={max} onChange={(e) => setUntil(e.target.value)} style={input} /></label>
          <button type="button" style={{ ...primary, minHeight: 48 }} disabled={to === "" || until === ""} onClick={go}>{t("stores.buy.handOver")}</button>
        </>
      )}
      {(mine.data?.delegations ?? []).map((d) => (
        <div key={d.id} style={{ ...line, minHeight: 44, borderBottom: "1px solid var(--rule, #e3e3e3)" }}>
          <span style={cell}>{d.from.id === meId
            ? t("stores.buy.delegationTo", { name: d.to.name, day: dayOf(d.toAt, i18n.language) })
            : t("stores.buy.delegationFrom", { name: d.from.name, day: dayOf(d.toAt, i18n.language) })}</span>
          <span style={{ ...word, borderStyle: d.live ? "solid" : "dashed" }}>{d.live ? t("stores.buy.live") : t("stores.buy.ended")}</span>
        </div>
      ))}
    </section>
  );
}

/* ─────────────── Budgets (finance, 16:9) ─────────────── */

function BudgetsTab({ initialMonth }: { initialMonth?: string | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const [month, setMonth] = useState(initialMonth !== undefined && /^\d{4}-\d{2}$/.test(initialMonth) ? initialMonth : thisMonth());
  const q = useQuery({ queryKey: ["stores", "buy", "budgets", month], queryFn: () => budgetsForMonth(month), retry: false });
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [year, setYear] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const save = (departmentId: string): void => {
    const rupees = Number(typed[departmentId] ?? "");
    setBudget({ departmentId, month, amountPaise: Math.round(rupees * 100), annual: year })
      .then(() => { setNotice({ text: t("stores.buy.saved"), ok: true }); setTyped({ ...typed, [departmentId]: "" }); void qc.invalidateQueries({ queryKey: ["stores", "buy", "budgets"] }); })
      .catch((e: unknown) => setNotice({ text: refusal(e), ok: false }));
  };
  const rows = q.data?.departments ?? [];
  return (
    <section data-testid="buy-budgets" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Notice n={notice} />
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={stack}><span>{t("stores.buy.month")}</span>
          <input aria-label={t("stores.buy.month")} type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ minHeight: 44 }} /></label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44 }}>
          <input type="checkbox" checked={year} onChange={(e) => setYear(e.target.checked)} style={{ width: 22, height: 22 }} />
          <span>{t("stores.buy.wholeYear")}</span></label>
      </div>
      {q.data === undefined && !q.isError ? <GreyRows n={4} />
        : q.isError ? <p style={{ margin: 0, fontWeight: 700 }}>{refusal(q.error)}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.noDepartments")}</p> : (
          // One card per department, so the row fits a phone as well as the desk (the walk found Save off-screen at 390 px).
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 1fr))", gap: 12 }}>
            {rows.map((d) => (
              <article key={d.departmentId} data-testid={`budget-${d.code}`} style={card}>
                <div style={line}>
                  <strong style={cell}>{d.name}</strong>
                  {d.pct === null ? <span style={{ ...word, borderStyle: "dashed" }}>{t("stores.buy.noBudget")}</span>
                    : <span style={{ ...word, borderStyle: d.pct >= 100 ? "dashed" : "solid" }}>{d.pct >= 100 ? t("stores.buy.overBudget") : t("stores.buy.budgetUsed", { pct: d.pct })}</span>}
                </div>
                <div style={line}>
                  <span style={cell}>{`${t("stores.buy.spent")} ${money(d.spentPaise)}`}</span>
                  {(d.committedPaise ?? 0) > 0 && <span style={word}>{`${t("stores.buy.onOrder")} ${money(d.committedPaise)}`}</span>}
                  {d.equipment.requests.length > 0 && <span style={word}>{`${t("stores.buy.equipment")} ${money(d.equipment.requests.reduce((a, r) => a + r.estimatePaise, 0))}`}</span>}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <label style={{ ...stack, flex: 1 }}><span>{t("stores.buy.budget")}</span>
                    <input aria-label={`${t("stores.buy.budget")} ${d.name}`} inputMode="decimal" placeholder={d.budgetPaise === null ? t("stores.buy.noBudget") : money(d.budgetPaise)}
                      value={typed[d.departmentId] ?? ""} onChange={(e) => setTyped({ ...typed, [d.departmentId]: e.target.value.replace(/[^\d.]/g, "") })} style={input} /></label>
                  <button type="button" style={primary} disabled={(typed[d.departmentId] ?? "") === ""} onClick={() => save(d.departmentId)}>{t("stores.buy.save")}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      <OverBudgetList month={month} />
    </section>
  );
}

/** S5c (#1115, decision 15) — the owner's monthly over-budget list: departments past 100 % and the approvals marked "over budget". */
function OverBudgetList({ month }: { month: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "buy", "over", month], queryFn: () => overBudget(month), retry: false });
  if (q.isError) return null;
  if (q.data === undefined) return <GreyRows n={2} />;
  return (
    <section data-testid="over-budget-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t("stores.buy.overList")}</h2>
      {q.data.departments.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.overListNone")}</p> : q.data.departments.map((d) => (
        <article key={d.departmentId} style={card}>
          <div style={line}>
            <strong style={cell}>{d.name}</strong>
            <span style={{ ...word, borderStyle: "dashed" }}>{t("stores.buy.overBudget")}</span>
          </div>
          <div style={line}><span style={cell}>{`${t("stores.buy.spent")} ${money(d.spentPaise)} / ${money(d.budgetPaise)} · ${String(d.pct)}%`}</span></div>
          {d.marks.length > 0 && <div style={{ ...line, flexWrap: "wrap" }}><span style={{ overflowWrap: "anywhere" }}>{`${t("stores.buy.overMarks")}: ${d.marks.map((m) => m.no).join(", ")}`}</span></div>}
        </article>
      ))}
    </section>
  );
}

/* ─────────────── Suppliers (the buyer, 16:9) ─────────────── */

function KycWord({ kyc }: { kyc: WireSupplierKyc }): React.ReactElement {
  const { t } = useTranslation();
  const missing = kyc.missing.map((m) => t(`stores.buy.missing.${m}`, { defaultValue: m })).join(", ");
  return (
    <span data-kyc={kyc.level} title={missing} style={{ ...word, borderStyle: kyc.level === "complete" ? "solid" : "dashed", whiteSpace: "normal" }}>
      {kyc.level === "complete" ? t("stores.buy.kyc.complete") : `${t(`stores.buy.kyc.${kyc.level}`)} · ${t("stores.buy.kycIncomplete", { missing })}`}
    </span>
  );
}

function SuppliersTab({ masters }: { masters: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const q = useQuery({ queryKey: ["stores", "buy", "suppliers"], queryFn: suppliers, retry: false });
  const cats = useQuery({ queryKey: ["stores", "categories"], queryFn: listCategories, enabled: masters, retry: false });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [cat, setCat] = useState<Record<string, string>>({});
  const done = (): void => { setNotice({ text: t("stores.buy.saved"), ok: true }); void qc.invalidateQueries({ queryKey: ["stores", "buy", "suppliers"] }); };
  const fail = (e: unknown): void => setNotice({ text: refusal(e), ok: false });
  const rows: WireStoresSupplier[] = q.data?.suppliers ?? [];
  const tops = (cats.data?.categories ?? []).filter((c) => c.parentId === null);
  return (
    <section data-testid="buy-suppliers" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Notice n={notice} />
      {q.data === undefined && !q.isError ? <GreyRows n={4} />
        : q.isError ? <p style={{ margin: 0, fontWeight: 700 }}>{refusal(q.error)}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.noSuppliers")}</p> : (
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>
                <th style={th}>{t("stores.buy.supplier")}</th><th style={th}>KYC</th><th style={th}>{t("stores.buy.msmeActivity")}</th>
                <th style={th}>{t("stores.buy.einvoice")}</th><th style={th}>{t("stores.buy.categories")}</th>
              </tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td style={td}>{s.name}</td>
                    <td style={{ ...td, maxWidth: 360, whiteSpace: "normal" }}><KycWord kyc={s.kyc} /></td>
                    <td style={td}>
                      <select aria-label={`${t("stores.buy.msmeActivity")} ${s.name}`} value={s.msmeActivity ?? ""} onChange={(e) =>
                        setSupplierFields(s.id, { msmeActivity: e.target.value === "" ? null : e.target.value as "maker" | "service" | "trader" }).then(done).catch(fail)}>
                        <option value="">—</option>
                        {(["maker", "service", "trader"] as const).map((a) => <option key={a} value={a}>{t(`stores.buy.activity.${a}`)}</option>)}
                      </select>
                    </td>
                    <td style={td}>
                      <input type="checkbox" aria-label={`${t("stores.buy.einvoice")} ${s.name}`} checked={s.einvoiceApplicable === true}
                        onChange={(e) => setSupplierFields(s.id, { einvoiceApplicable: e.target.checked }).then(done).catch(fail)} style={{ width: 22, height: 22 }} />
                    </td>
                    <td style={{ ...td, maxWidth: 420 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        {s.categories.map((c) => <span key={c.id} style={word}>{c.name}</span>)}
                        {masters && (
                          <>
                            <select aria-label={`${t("stores.buy.approveCategory")} ${s.name}`} value={cat[s.id] ?? ""} onChange={(e) => setCat({ ...cat, [s.id]: e.target.value })}>
                              <option value="">—</option>
                              {tops.filter((c) => !s.categories.some((x) => x.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <button type="button" style={btn} disabled={(cat[s.id] ?? "") === ""}
                              onClick={() => approveSupplierCategory(s.id, cat[s.id]!).then(done).catch(fail)}>{t("stores.buy.approveCategory")}</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

/* ─────────────── QC (non-drug deliveries, 16:9) ─────────────── */

function QcTab(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const q = useQuery({ queryKey: ["stores", "buy", "qc"], queryFn: grnsForQc, retry: false });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const done = (text: string): void => { setNotice({ text, ok: true }); void qc.invalidateQueries({ queryKey: ["stores", "buy", "qc"] }); };
  const fail = (e: unknown): void => setNotice({ text: refusal(e), ok: false });
  const rows: WireStoresGrnForQc[] = q.data?.grns ?? [];
  return (
    <section data-testid="buy-qc" style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 900 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t("stores.buy.qcTitle")}</h2>
      <Notice n={notice} />
      {q.data === undefined && !q.isError ? <GreyRows n={3} />
        : q.isError ? <p style={{ margin: 0, fontWeight: 700 }}>{refusal(q.error)}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.buy.nothingToCheck")}</p>
        : rows.map((g) => (
          <article key={g.id} data-testid={`grn-${g.id}`} style={card}>
            <div style={line}>
              <strong style={cell}>{`${g.vendorName} · ${g.challanNo}`}</strong>
              <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>{g.grnNo.slice(-4)}</span>
              <span style={word}>{t(`stores.buy.grnStatus.${g.status}`, { defaultValue: g.status })}</span>
            </div>
            {g.lines.map((l, i) => (
              <div key={`${l.itemId}-${String(i)}`} style={line}>
                <span style={cell}>{l.itemName}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{`${String(l.qtyBase)} ${l.baseUom}`}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{money(l.unitCostPaise)}</span>
                {l.priceFlag && <span style={{ ...word, borderStyle: "dashed" }}>{t("stores.buy.priceAbove")}</span>}
              </div>
            ))}
            {g.status === "gate_qc"
              ? <button type="button" style={{ ...primary, minHeight: 48 }} onClick={() => signQc(g.id).then(() => done(t("stores.buy.qcSigned"))).catch(fail)}>{t("stores.buy.signQc")}</button>
              : <button type="button" style={{ ...primary, minHeight: 48 }} onClick={() => postQcGrn(g.id).then(() => done(t("stores.buy.posted"))).catch(fail)}>{t("stores.buy.post")}</button>}
          </article>
        ))}
    </section>
  );
}
