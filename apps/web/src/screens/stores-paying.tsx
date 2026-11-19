import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import {
  billHolds, bookBill, bookDraft, decideRun, draftRun, holdsDryRun, keepHold, msmeDryRun, payablesByGroup, payingDesk, recordPayment, releaseHold, runToAuthorise,
  runVendors, setPayingSwitch, submitRun, tdsDryRun,
} from "../lib/paying-api";
import { dateLocale } from "../lib/date-locale";
import { storesErrorCode } from "../lib/stores-api";
import { AuditFlags, MsmeObjections, MsmeReport, TallyLedgers, TaxTab } from "./stores-paying-tax";
import "./stores.css";
import type { WireGstCredit, WirePayDue, WirePayHold, WirePayRun, WirePayToBook, WirePayingDesk, WireRunToAuthorise } from "@hmis/contracts";

/**
 * STORES S6a (#1116, spec "## Screens") — `/stores/pay`, THE PAYING DESK (16:9, fits 1366 × 768) and, from a notice, the
 * owner's PHONE SHEET that authorises one run (`?run=`) in one tap at 390 px, and a bill's hold cards (`?bill=`).
 *
 * Tabs (one primary each): To book (Book bill: only the supplier's number and date are typed; the lines are prefilled from
 * the GRN or the service entry), Holds (hold cards: the rule as words, the documents behind it, Release with a reason or
 * Keep with a reason and a review date; a refusal names who to ask), Due (MSME bills due in ≤ 5 days on top with "Due
 * soon"; "Overdue" and "Interest accrues" past the date), Runs (Draft run; Submit; the owner's line), Payments (Record
 * payment: mode and UTR), Exports (payables by item group and by department, Download). The owner's switches sit under
 * the tabs: each Off / On, "See what changes" (the dry run) before "Switch on". Every status is a word; loading is grey
 * rows with no text; empty is "Nothing here".
 *
 * S6b (#1116): Book bill proposes per Stores or service line the GST credit mark (Eligible / Not available / Shared) and
 * Reverse charge, which the officer confirms; it takes the IRN, and says "IRN missing" for a supplier declared for
 * e-invoicing whose bill claims credit, and "TDS not checked" while no CA-signed TDS table exists. The owner's MSME
 * 15-day rule and TDS on goods switches work like the pharmacy-holds one (see what changes, then switch on).
 *
 * S6c (#1116): a Tax button beside the six tabs (the CA's TDS and GST-credit tables: in force, drafts, "Record signature"; certificates),
 * the Tally ledger names under Exports, MSME objections and the half-yearly MSME dues report under Due, and `?flags=1`, the
 * auditor's flags (`stores-paying-tax.tsx`).
 */
type Tab = "toBook" | "holds" | "due" | "runs" | "payments" | "exports" | "tax";
const TABS: Tab[] = ["toBook", "holds", "due", "runs", "payments", "exports"];
/** S6c (#1116): "Tax" holds the CA's tables and the certificates (the accounts officer's) — beside the spec's six tabs, not one of them. */
const ALL_TABS: Tab[] = [...TABS, "tax"];

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" };
const red: React.CSSProperties = { ...word, borderColor: "var(--state-danger, #b42318)", color: "var(--state-danger, #b42318)" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid var(--rule, #e3e3e3)", minWidth: 0 };
const cut: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const input: React.CSSProperties = { minHeight: 40, minWidth: 0, boxSizing: "border-box", maxWidth: "100%" };
const card: React.CSSProperties = { border: "1px solid var(--rule, #e3e3e3)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };

const money = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", paise % 100 === 0 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A supplier's name wraps rather than hides: long legal names are the norm. */
const wrap: React.CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const rupeesToPaise = (s: string): number => Math.round(Number(s) * 100);
const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ height: 40, background: "var(--rule, #eee)", borderRadius: 4, marginBottom: 6 }} />)}</div>;
}

function Notice({ n }: { n: { text: string; ok: boolean } | null }): React.ReactElement | null {
  if (n === null) return null;
  return (
    <p role="status" data-tone={n.ok ? "ok" : "refused"} style={{
      margin: 0, fontWeight: 700, fontSize: 16, padding: "6px 10px", borderRadius: 6,
      borderLeft: `6px solid ${n.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`, background: "var(--line, #eef2ef)",
    }}>{n.text}</p>
  );
}

function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    if (!(e instanceof ApiError)) return t("stores.ticket.offline");
    const code = storesErrorCode(e);
    return code === null ? t("stores.err.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.err.failed") });
  };
}

function useAct(): { busy: boolean; note: { text: string; ok: boolean } | null; run: (f: () => Promise<unknown>, done: string) => Promise<boolean> } {
  const qc = useQueryClient();
  const refused = useRefusal();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  return {
    busy, note,
    run: async (f, done) => {
      setBusy(true);
      try { await f(); setNote({ text: done, ok: true }); await qc.invalidateQueries({ queryKey: ["stores-paying"] }); return true; }
      catch (e) { setNote({ text: refused(e), ok: false }); return false; }
      finally { setBusy(false); }
    },
  };
}

const Empty = (): React.ReactElement => { const { t } = useTranslation(); return <p>{t("stores.paying.empty")}</p>; };

export function StoresPaying(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { run?: string; bill?: string; tab?: string; flags?: string | number };
  const [tab, setTab] = useState<Tab>(ALL_TABS.includes(search.tab as Tab) ? (search.tab as Tab) : "toBook");
  // S6c (#1116): the auditor's flags (the materials head's and the stores auditor's; the owner's monthly list), from the notice.
  if (search.flags !== undefined) return <AuditFlags />;
  if (search.run !== undefined) return <div className="stores-ui" data-testid="stores-paying" style={page}><AuthoriseSheet id={search.run} /></div>;
  if (search.bill !== undefined) return <div className="stores-ui" data-testid="stores-paying" style={page}><BillHolds billId={search.bill} /></div>;
  return (
    <div className="stores-ui" data-testid="stores-paying" style={page}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.paying.title")}</h1>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} style={tab === k ? primary : btn} onClick={() => setTab(k)}>{t(`stores.paying.tab.${k}`)}</button>
          ))}
        </div>
        <button type="button" aria-pressed={tab === "tax"} style={tab === "tax" ? primary : btn} onClick={() => setTab("tax")}>{t("stores.paying.tab.tax")}</button>
      </div>
      <Desk tab={tab} />
    </div>
  );
}

function Desk({ tab }: { tab: Tab }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "desk"], queryFn: payingDesk });
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: t("stores.paying.notYours"), ok: false }} />;
  const d: WirePayingDesk = q.data;
  return (
    <>
      {tab === "toBook" && <ToBook rows={d.toBook} can={d.can.book} />}
      {tab === "holds" && (d.holds.length === 0 ? <Empty /> : <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>{d.holds.map((h) => <HoldCard key={h.id} h={h} />)}</div>)}
      {tab === "due" && <Due rows={d.due} />}
      {tab === "due" && <MsmeObjections docs={d.toBook} />}
      {tab === "due" && <MsmeReport />}
      {tab === "runs" && <Runs runs={d.runs} desk={d} />}
      {tab === "payments" && <Payments desk={d} />}
      {tab === "exports" && <Exports />}
      {tab === "exports" && d.can.export && <TallyLedgers />}
      {tab === "tax" && <TaxTab />}
      {d.can.owner && <Settings desk={d} />}
    </>
  );
}

/* ─────────────── To book ─────────────── */

function ToBook({ rows, can }: { rows: WirePayToBook[]; can: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <Empty />;
  return (
    <div>
      {rows.map((r) => (
        <div key={`${r.kind}:${r.id}`}>
          <div style={row} data-testid={`book-row-${r.id}`}>
            <span style={word}>{t(`stores.paying.${r.kind}`)}</span>
            <strong>{r.no}</strong>
            <span style={{ ...wrap, flex: "1 1 160px" }}>{r.vendorName}</span>
            {r.poNo !== null && <span>{r.poNo}</span>}
            <span>{new Date(r.at).toLocaleDateString(dateLocale())}</span>
            {can && <button type="button" style={primary} onClick={() => setOpen(open === r.id ? null : r.id)}>{t("stores.paying.bookBill")}</button>}
          </div>
          {open === r.id && <BookForm doc={r} onDone={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}

function BookForm({ doc, onDone }: { doc: WirePayToBook; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "book", doc.kind, doc.id], queryFn: () => bookDraft(doc.kind, doc.id) });
  const act = useAct();
  const [no, setNo] = useState("");
  const [date, setDate] = useState("");
  const [lines, setLines] = useState<Record<string, { qty: string; rate: string }>>({});
  const [marks, setMarks] = useState<Record<string, { credit: WireGstCredit; rc: boolean }>>({});
  const [irn, setIrn] = useState("");
  if (q.isPending) return <GreyRows n={2} />;
  if (q.isError) return <Notice n={{ text: t("stores.err.failed"), ok: false }} />;
  const d = q.data;
  const billNo = no === "" ? d.vendorBillNo : no;
  const billDate = date === "" ? d.billDate : date;
  const markOf = (l: (typeof d.lines)[number]): { credit: WireGstCredit; rc: boolean } => marks[l.itemId] ?? { credit: l.gstCredit ?? "not_available", rc: l.reverseCharge };
  const claims = d.lines.some((l) => l.storesLine && markOf(l).credit !== "not_available");
  const irnMissing = d.einvoiceApplicable && claims && irn.trim() === "";
  return (
    <div style={{ ...card, margin: "6px 0" }}>
      <Notice n={act.note} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>{t("stores.paying.billNo")}
          <input style={input} value={billNo} onChange={(e) => setNo(e.target.value)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>{t("stores.paying.billDate")}
          <input style={input} type="date" value={billDate} onChange={(e) => setDate(e.target.value)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 200px", minWidth: 0 }}>{t("stores.paying.tax.irn")}
          <input style={input} value={irn} onChange={(e) => setIrn(e.target.value)} /></label>
        {!d.tdsChecked && <span style={{ ...word, alignSelf: "center" }}>{t("stores.paying.tax.tdsNotChecked")}</span>}
        {irnMissing && <span style={{ ...red, alignSelf: "center" }}>{t("stores.paying.tax.irnMissing")}</span>}
      </div>
      {d.lines.map((l) => {
        const v = lines[l.itemId] ?? { qty: String(l.qtyPacks), rate: String(l.ratePaise / 100) };
        return (
          <div key={l.itemId} style={row}>
            <span style={{ ...wrap, flex: "1 1 160px" }}>{l.itemName}</span>
            <input aria-label={t("stores.services.qty")} style={{ ...input, width: 90 }} inputMode="numeric" value={v.qty} onChange={(e) => setLines({ ...lines, [l.itemId]: { ...v, qty: e.target.value } })} />
            <span>{l.uom}</span>
            <input aria-label={t("stores.paying.rate")} style={{ ...input, width: 110 }} inputMode="decimal" value={v.rate} onChange={(e) => setLines({ ...lines, [l.itemId]: { ...v, rate: e.target.value } })} />
            <span>{`${String(l.gstRateBps / 100)} % GST`}</span>
            {l.storesLine && (
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select aria-label="GST" style={input} value={markOf(l).credit} onChange={(e) => setMarks({ ...marks, [l.itemId]: { ...markOf(l), credit: e.target.value as WireGstCredit } })}>
                  {(["not_available", "eligible", "shared"] as const).map((c) => <option key={c} value={c}>{t(`stores.paying.tax.${c}`)}</option>)}
                </select>
                <label style={{ display: "flex", gap: 4, alignItems: "center", minHeight: 40 }}>
                  <input type="checkbox" checked={markOf(l).rc} onChange={(e) => setMarks({ ...marks, [l.itemId]: { ...markOf(l), rc: e.target.checked } })} />
                  {t("stores.paying.tax.reverseCharge")}
                </label>
              </span>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>{t("stores.paying.expected")} {money(d.expectedTotalPaise)}</span>
        <button type="button" style={primary} disabled={act.busy || billNo.trim() === ""} onClick={() => void act.run(async () => {
          const body = { kind: doc.kind, id: doc.id, vendorBillNo: billNo.trim(), billDate, lines: d.lines.map((l) => {
            const v = lines[l.itemId];
            const m = markOf(l);
            return {
              itemId: l.itemId, qtyPacks: v === undefined ? l.qtyPacks : Number(v.qty), ratePaise: v === undefined ? l.ratePaise : rupeesToPaise(v.rate),
              ...(l.storesLine ? { gstCredit: m.credit, reverseCharge: m.rc } : {}),
            };
          }), ...(irn.trim() === "" ? {} : { irn: irn.trim() }) };
          const r = await bookBill(body);
          if (r.status === "accepted") onDone();
        }, t("stores.paying.booked"))}>{t("stores.paying.save")}</button>
      </div>
    </div>
  );
}

/* ─────────────── Holds ─────────────── */

function HoldCard({ h }: { h: WirePayHold }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [mode, setMode] = useState<"release" | "keep" | null>(null);
  const [reason, setReason] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const refusal = h.refusal;
  const refusalText = refusal === null ? null : t(`stores.paying.refusal.${refusal.code}`, {
    who: refusal.ask ?? t("stores.paying.owner"), date: refusal.on === null ? "" : new Date(refusal.on).toLocaleDateString(dateLocale()),
  });
  const closed = h.status === "released" || h.status === "ended";
  return (
    <div style={card} data-testid={`hold-${h.id}`}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{t(`stores.paying.hold.${h.kind}`)}</strong>
        <span style={h.status === "open" ? red : word}>{t(`stores.paying.holdStatus.${h.status}`)}</span>
        {h.msme && <span style={word}>{t("stores.paying.msme")}</span>}
      </div>
      <span style={wrap}>{h.vendorName}</span>
      <div style={row}><span>{h.billNo}</span><span style={{ marginLeft: "auto" }}>{money(h.totalPaise)}</span></div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {h.evidence.map((e) => <span key={`${e.type}:${e.id}`} style={{ ...word, fontWeight: 400 }}>{e.no === "" ? t(`stores.paying.doc.${e.type}`, { defaultValue: e.type }) : e.no}</span>)}
      </div>
      {h.kept !== null && <span>{t("stores.paying.keptTill", { date: new Date(`${h.kept.reviewOn}T00:00:00`).toLocaleDateString(dateLocale()) })} · {h.kept.reason}</span>}
      <Notice n={act.note} />
      {!closed && refusalText !== null && <span style={{ fontWeight: 600 }}>{refusalText}</span>}
      {!closed && h.canRelease && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={primary} onClick={() => setMode("release")}>{t("stores.paying.release")}</button>
          <button type="button" style={btn} onClick={() => setMode("keep")}>{t("stores.paying.keep")}</button>
        </div>
      )}
      {!closed && mode !== null && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 180px", minWidth: 0 }}>{t("stores.paying.reason")}
            <input style={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {mode === "keep" && <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>{t("stores.paying.reviewOn")}
            <input style={input} type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} /></label>}
          <button type="button" style={primary} disabled={act.busy || reason.trim() === "" || (mode === "keep" && reviewOn === "")} onClick={() => void act.run(
            () => (mode === "release" ? releaseHold(h.id, reason) : keepHold(h.id, reason, reviewOn)), t(mode === "release" ? "stores.paying.released" : "stores.paying.kept"),
          )}>{t("stores.paying.save")}</button>
        </div>
      )}
    </div>
  );
}

function BillHolds({ billId }: { billId: string }): React.ReactElement {
  const q = useQuery({ queryKey: ["stores-paying", "holds", billId], queryFn: () => billHolds(billId) });
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: "—", ok: false }} />;
  return q.data.length === 0 ? <Empty /> : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{q.data.map((h) => <HoldCard key={h.id} h={h} />)}</div>;
}

/* ─────────────── Due ─────────────── */

function Due({ rows }: { rows: WirePayDue[] }): React.ReactElement {
  const { t } = useTranslation();
  if (rows.length === 0) return <Empty />;
  // MSME bills due in ≤ 5 days sit on top; the rest keep the desk's order (due date).
  const top = (r: WirePayDue): number => (r.msme && r.dueWord === "due_soon" ? 0 : 1);
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => top(a.r) - top(b.r) || a.i - b.i).map((x) => x.r);
  return (
    <div>
      {sorted.map((r) => (
        <div key={r.billId} style={row} data-testid={`due-row-${r.billId}`}>
          {r.dueWord !== null && <span style={red}>{t(`stores.paying.due.${r.dueWord}`)}</span>}
          {r.dueWord === "overdue" && r.msme && <span style={red}>{t("stores.paying.due.interest")}</span>}
          {r.msme && <span style={word}>{t("stores.paying.msme")}</span>}
          <strong>{r.billNo}</strong>
          <span style={{ ...wrap, flex: "1 1 160px" }}>{r.vendorName}</span>
          <span>{new Date(`${r.dueDate}T00:00:00`).toLocaleDateString(dateLocale())}</span>
          <span>{money(r.outstandingPaise)}</span>
          <span style={word}>{t(`stores.paying.status.${r.status}`)}</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Runs ─────────────── */

function runLine(t: (k: string, o?: Record<string, unknown>) => string, r: { totalPaise: number; bills: number; msme: number; heldOut: number }): string {
  return [money(r.totalPaise), t("stores.paying.bills", { count: r.bills }), t("stores.paying.msmeCount", { count: r.msme }), t("stores.paying.heldOut", { count: r.heldOut })].join(" · ");
}

function Runs({ runs, desk }: { runs: WirePayRun[]; desk: WirePayingDesk }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  return (
    <div>
      <Notice n={act.note} />
      {desk.can.prepare && <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(() => draftRun(), t("stores.paying.drafted"))}>{t("stores.paying.draftRun")}</button>}
      {runs.length === 0 ? <Empty /> : runs.map((r) => (
        <div key={r.id} style={row} data-testid={`run-row-${r.id}`}>
          <strong>{r.runNo}</strong>
          <span style={word}>{t(`stores.paying.runStatus.${r.status}`)}</span>
          <span style={{ ...cut, flex: "1 1 200px" }}>{runLine(t, r)}</span>
          {r.status === "draft" && desk.can.prepare && (
            <button type="button" style={btn} disabled={act.busy} onClick={() => void act.run(() => submitRun(r.id), t("stores.paying.submitted"))}>{t("stores.paying.submit")}</button>
          )}
        </div>
      ))}
    </div>
  );
}

function AuthoriseSheet({ id }: { id: string }): React.ReactElement {
  const { t } = useTranslation();
  const refused = useRefusal();
  const q = useQuery({ queryKey: ["stores-paying", "run", id], queryFn: () => runToAuthorise(id) });
  const [after, setAfter] = useState<WireRunToAuthorise | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [back, setBack] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const sheet: React.CSSProperties = { maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 10 };
  if (q.isPending) return <div style={sheet}><GreyRows n={2} /></div>;
  if (q.isError) return <div data-testid="authorise-sheet" style={sheet}><Notice n={{ text: refused(q.error), ok: false }} /></div>;
  const r = after ?? q.data;
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true);
    // Done: the status word says it ("Authorised", "Draft" again when sent back); a notice would say it twice.
    try { const x = await decideRun(id, approve, approve ? undefined : reason); setAfter(x); setNote(approve ? null : { text: t("stores.paying.sentBack"), ok: true }); }
    catch (e) { setNote({ text: refused(e), ok: false }); }
    finally { setBusy(false); }
  };
  return (
    <div data-testid="authorise-sheet" style={sheet}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.paying.runToAuthorise")} · {r.runNo}</h1>
      <p style={{ margin: 0, fontSize: 18, fontWeight: 700, overflowWrap: "anywhere" }}>{runLine(t, r)}</p>
      <span style={{ ...word, alignSelf: "flex-start" }}>{t(`stores.paying.runStatus.${r.status}`)}</span>
      <Notice n={note} />
      {r.canDecide && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={{ ...primary, minHeight: 48, flex: "1 1 160px" }} disabled={busy} onClick={() => void decide(true)}>{t("stores.paying.authorise")}</button>
          <button type="button" style={{ ...btn, minHeight: 48 }} disabled={busy} onClick={() => setBack(true)}>{t("stores.paying.sendBack")}</button>
        </div>
      )}
      {r.canDecide && back && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input aria-label={t("stores.paying.reason")} style={{ ...input, flex: "1 1 180px" }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("stores.paying.reason")} />
          <button type="button" style={primary} disabled={busy || reason.trim() === ""} onClick={() => void decide(false)}>{t("stores.paying.sendBack")}</button>
        </div>
      )}
    </div>
  );
}

/* ─────────────── Payments ─────────────── */

function Payments({ desk }: { desk: WirePayingDesk }): React.ReactElement {
  const { t } = useTranslation();
  const authorised = desk.runs.filter((r) => r.status === "authorised");
  return (
    <div>
      {desk.can.record && authorised.map((r) => <RecordPayment key={r.id} run={r} />)}
      {desk.payments.length === 0 ? <Empty /> : desk.payments.map((p) => (
        <div key={p.id} style={row}>
          <strong>{p.paymentNo}</strong>
          <span>{p.runNo}</span>
          <span style={{ ...cut, flex: "1 1 160px" }}>{p.vendorName}</span>
          <span style={word}>{t(`stores.paying.modes.${p.mode}`)}</span>
          <span>{p.reference ?? ""}</span>
          <span>{money(p.amountPaise)}</span>
          <span style={word}>{t("stores.paying.status.paid")}</span>
        </div>
      ))}
    </div>
  );
}

function RecordPayment({ run }: { run: WirePayRun }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "run-vendors", run.id], queryFn: () => runVendors(run.id) });
  const act = useAct();
  const [form, setForm] = useState<Record<string, { mode: string; utr: string }>>({});
  if (q.isPending) return <GreyRows n={1} />;
  if (q.isError) return <Notice n={{ text: t("stores.err.failed"), ok: false }} />;
  return (
    <div style={{ ...card, marginBottom: 8 }}>
      <strong>{t("stores.paying.recordPayment")} · {run.runNo}</strong>
      <Notice n={act.note} />
      {q.data.filter((v) => v.payment === null).map((v) => {
        const f = form[v.vendorId] ?? { mode: "neft", utr: "" };
        return (
          <div key={v.vendorId} style={row}>
            <span style={{ ...wrap, flex: "1 1 160px" }}>{v.vendorName}</span>
            <span>{money(v.payPaise)}</span>
            <select aria-label={t("stores.paying.mode")} style={input} value={f.mode} onChange={(e) => setForm({ ...form, [v.vendorId]: { ...f, mode: e.target.value } })}>
              {["neft", "rtgs", "upi", "cheque", "cash"].map((m) => <option key={m} value={m}>{t(`stores.paying.modes.${m}`)}</option>)}
            </select>
            <input aria-label={t("stores.paying.utr")} placeholder={t("stores.paying.utr")} style={{ ...input, width: 210 }} value={f.utr} onChange={(e) => setForm({ ...form, [v.vendorId]: { ...f, utr: e.target.value } })} />
            <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(
              () => recordPayment(run.id, { vendorId: v.vendorId, mode: f.mode, reference: f.utr.trim() === "" ? null : f.utr.trim(), paidOn: today() }), t("stores.paying.recorded"),
            )}>{t("stores.paying.save")}</button>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────── Exports ─────────────── */

function Exports(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores-paying", "by-group"], queryFn: payablesByGroup });
  if (q.isPending) return <GreyRows />;
  if (q.isError) return <Notice n={{ text: t("stores.paying.notYours"), ok: false }} />;
  const d = q.data;
  const csv = (): void => {
    const lines = ["kind,code,name,paise", ...d.byGroup.map((g) => `group,${g.group},"${g.name}",${String(g.paise)}`), ...d.byDepartment.map((x) => `department,${x.costCentre},"${x.name}",${String(x.paise)}`)];
    const a = document.createElement("a");
    a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(`${lines.join("\n")}\n`)}`;
    a.download = `payables-${d.asOf}.csv`;
    a.click();
  };
  const block = (title: string, rows: { k: string; name: string; paise: number }[]): React.ReactElement => (
    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
      <strong>{title}</strong>
      {rows.length === 0 ? <Empty /> : rows.map((r) => <div key={r.k} style={row}><span style={{ ...cut, flex: "1 1 120px" }}>{r.name}</span><span>{money(r.paise)}</span></div>)}
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>{t("stores.paying.total")} {money(d.totalPaise)}</span>
        <button type="button" style={primary} onClick={csv}>{t("stores.paying.download")}</button>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {block(t("stores.paying.byGroup"), d.byGroup.map((g) => ({ k: g.group, name: g.group === "drugs" ? t("stores.paying.drugs") : g.name, paise: g.paise })))}
        {block(t("stores.paying.byDept"), d.byDepartment.map((x) => ({ k: x.costCentre, name: `${x.costCentre} · ${x.name}`, paise: x.paise })))}
      </div>
    </div>
  );
}

/* ─────────────── Settings (the owner's) ─────────────── */

type DryRow = { id: string; no: string; vendor: string; paise: number | null; words: string[] };
type SwitchKey = "holds" | "msme" | "tds";

function Settings({ desk }: { desk: WirePayingDesk }): React.ReactElement {
  const { t } = useTranslation();
  const act = useAct();
  const [dry, setDry] = useState<{ key: SwitchKey; at: string; rows: DryRow[] } | null>(null);
  const s = desk.settings;
  const onOff = (on: boolean): React.ReactElement => <span style={word}>{t(on ? "stores.paying.settings.on" : "stores.paying.settings.off")}</span>;
  const day = (d: string): string => new Date(`${d}T00:00:00`).toLocaleDateString(dateLocale());
  const see = async (key: SwitchKey): Promise<void> => {
    if (key === "holds") { const r = await holdsDryRun(); setDry({ key, at: r.at, rows: r.bills.map((b) => ({ id: b.billId, no: b.billNo, vendor: b.vendorName, paise: b.totalPaise, words: b.kinds.map((k) => t(`stores.paying.hold.${k}`)) })) }); }
    if (key === "msme") { const r = await msmeDryRun(); setDry({ key, at: r.at, rows: r.bills.map((b) => ({ id: b.billId, no: b.billNo, vendor: b.vendorName, paise: null, words: [`${day(b.dueDate)} → ${day(b.actDueDate)}`] })) }); }
    if (key === "tds") { const r = await tdsDryRun(); setDry({ key, at: r.at, rows: r.bills.map((b) => ({ id: b.billId, no: b.billNo, vendor: b.vendorName, paise: b.tdsPaise, words: ["TDS"] })) }); }
  };
  const rows: { key: SwitchKey; label: string; on: boolean; body: (on: boolean, at: string) => Parameters<typeof setPayingSwitch>[0] }[] = [
    { key: "holds", label: t("stores.paying.settings.holdsPharmacy"), on: s.holdsCoverPharmacy, body: (on, at) => ({ holdsCoverPharmacy: on, dryRunAt: at }) },
    { key: "msme", label: t("stores.paying.settings.msme"), on: s.msmeRule === "act", body: (on, at) => ({ msmeRule: on ? "act" : "as_today", dryRunAt: at }) },
    { key: "tds", label: t("stores.paying.settings.tdsGoods"), on: s.tdsGoods === true, body: (on, at) => ({ tdsGoods: on, dryRunAt: at }) },
  ];
  return (
    <section style={{ ...card, marginTop: 12 }} data-testid="paying-settings">
      <strong>{t("stores.paying.settings.title")}</strong>
      <Notice n={act.note} />
      {rows.map((r) => (
        <div key={r.key}>
          <div style={row} data-testid={`switch-${r.key}`}>
            <span style={{ flex: "1 1 200px" }}>{r.label}</span>
            {onOff(r.on)}
            <button type="button" style={btn} disabled={act.busy} onClick={() => void act.run(() => see(r.key), t("stores.paying.settings.seen"))}>{t("stores.paying.settings.see")}</button>
            {dry !== null && dry.key === r.key && (
              <button type="button" style={primary} disabled={act.busy} onClick={() => void act.run(async () => { await setPayingSwitch(r.body(!r.on, dry.at)); setDry(null); }, t("stores.paying.settings.saved"))}>
                {t(r.on ? "stores.paying.settings.switchOff" : "stores.paying.settings.switchOn")}
              </button>
            )}
          </div>
          {dry !== null && dry.key === r.key && (dry.rows.length === 0 ? <span>{t("stores.paying.settings.nothing")}</span> : dry.rows.map((b) => (
            <div key={b.id} style={row}><span>{b.no}</span><span style={{ ...wrap, flex: "1 1 120px" }}>{b.vendor}</span>{b.paise !== null && <span>{money(b.paise)}</span>}
              {b.words.map((w) => <span key={w} style={word}>{w}</span>)}</div>
          )))}
        </div>
      ))}
    </section>
  );
}
