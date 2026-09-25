import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { materialsErrorText } from "../../lib/materials-api";
import { rupees } from "../../lib/purchase-api";
import {
  AGE_BUCKETS, PAYMENT_MODES, acceptBill, acceptDifference, cancelBill, cancelRun, createBill, csvRupees, downloadCsv, draftRun,
  fetchBill, fetchBillDraft, fetchLedger, fetchOfficePay, fetchPayables, fetchRun, matchBill, recordPayment, submitRun, toCsv,
  updateRun,
} from "../../lib/payables-api";
import { Button } from "@/components/ui/button";
import { Sheet } from "./sheet";
import type {
  PaymentMode, WireBill, WireBillSummary, WirePayableRow, WireRun, WireRunSummary, WireUnbilledGrn,
} from "../../lib/payables-api";

/**
 * ═══ PHARMACY PARITY P3 — THE OFFICE PAYS ═══
 *
 * The office's second half, one screen like the first: it opens on what needs paying attention —
 * GRNs with no bill yet, bills held outside the match, bills due this week and overdue (MSME first),
 * and runs waiting on the owner — and every row opens its sheet.
 *
 *   - A GRN row opens a BILL the agent prefilled from it: the person types the vendor's bill number
 *     and date (⏎ saves and matches), changes any line that differs, and sees the match per line.
 *   - The agent's card drafts a PAYMENT RUN of what is due; the run sheet is the Healthray grid —
 *     Inv date, our no., vendor bill no., total, previously paid, credit (P4), pay now, remaining,
 *     full-pay per row and for the vendor. The owner authorises it in /approvals; somebody else
 *     records each vendor paid with the mode and the UTR or cheque number.
 *   - "Payables" opens ageing and the Supplier Summary; a supplier opens its ledger. Both export CSV.
 *
 * Keys: ↑/↓ walk the rows, ⏎ opens one; D makes the agent's draft run; P opens payables; in a sheet
 * ⏎ on the bill number saves and matches, A accepts a matched bill, Esc closes.
 */
type Open =
  | { kind: "grn"; grnId: string }
  | { kind: "bill"; billId: string }
  | { kind: "run"; runId: string }
  | { kind: "payables" }
  | { kind: "ledger"; vendorId: string };

const BILL_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", matched: "bg-sky-100 text-sky-900", held_for_match: "bg-amber-100 text-amber-900",
  accepted: "bg-indigo-100 text-indigo-900", part_paid: "bg-violet-100 text-violet-900", paid: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};
const RUN_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", pending_authorisation: "bg-amber-100 text-amber-900", authorised: "bg-sky-100 text-sky-900",
  completed: "bg-green-100 text-green-800", cancelled: "bg-red-100 text-red-800",
};

const toPaise = (text: string): number => Math.round(Number(text || "0") * 100);
const toRupeeText = (paise: number): string => (paise / 100).toFixed(2);

export function PayView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const pay = useQuery({ queryKey: ["pharmacy", "office", "pay"], queryFn: fetchOfficePay });
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const d = pay.data;
  const canPrepare = can("materials.payments.prepare");

  const makeDraft = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const run = await draftRun();
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
      setNotice(t("pharmacyOffice.pay.agent.made", { runNo: run.runNo }));
      setOpen({ kind: "run", runId: run.id });
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    const typing = (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT";
    if (typing || open !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "d" || e.key === "D") && canPrepare && d !== undefined && d.plan.bills > 0 && !busy) { e.preventDefault(); void makeDraft(); return; }
    if (e.key === "p" || e.key === "P") { e.preventDefault(); setOpen({ kind: "payables" }); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-pay-row]") ?? []);
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[i < 0 ? 0 : e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };

  const awaiting = d?.runs.filter((r) => r.status === "pending_authorisation") ?? [];
  const msmeOverdue = d?.overdue.filter((b) => b.msme).length ?? 0;

  return (
    <div className="space-y-5 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid="pay-view">
      {pay.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(pay.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {d !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="pay-counts">
            {([
              ["toMatch", d.toMatch.length + d.drafts.length + d.matched.length, false],
              ["held", d.held.length, d.held.length > 0],
              ["dueThisWeek", d.dueThisWeek.length, false],
              ["overdue", d.overdue.length, d.overdue.length > 0],
              ["awaitingAuth", awaiting.length, false],
            ] as const).map(([k, n, warn]) => (
              <div key={k} className={`rounded border p-3 ${warn ? "border-amber-400" : ""}`} data-testid={`pay-count-${k}`}>
                <div className="text-2xl font-semibold tabular-nums">{n}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.pay.count.${k}`)}</div>
                {k === "overdue" && msmeOverdue > 0 && (
                  <div className="mt-1 text-xs font-medium text-red-700" data-testid="pay-msme-overdue">{t("pharmacyOffice.pay.msmeOverdue", { count: msmeOverdue })}</div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>{t("pharmacyOffice.pay.outstanding")} <b className="tabular-nums">{rupees(d.outstandingPaise)}</b></span>
            <span>{t("pharmacyOffice.pay.overdueAmount")} <b className="tabular-nums text-red-700">{rupees(d.overduePaise)}</b></span>
            <Button type="button" variant="outline" onClick={() => setOpen({ kind: "payables" })}>
              {t("pharmacyOffice.pay.openPayables")} <kbd className="ml-1 rounded border px-1 text-xs">P</kbd>
            </Button>
          </div>

          {canPrepare && (
            <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3" data-testid="pay-agent">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
                <span className="flex-1 text-sm">
                  {d.plan.bills === 0
                    ? t("pharmacyOffice.pay.agent.nothing", { until: d.plan.until })
                    : t("pharmacyOffice.pay.agent.can", { vendors: d.plan.vendors, bills: d.plan.bills, amount: rupees(d.plan.totalPaise), until: d.plan.until })}
                  {d.plan.blocked > 0 && <span className="block text-xs text-muted-foreground">{t("pharmacyOffice.pay.agent.blocked", { count: d.plan.blocked })}</span>}
                </span>
                <Button type="button" disabled={busy || d.plan.bills === 0} onClick={() => void makeDraft()}>
                  {t("pharmacyOffice.pay.agent.make")} <kbd className="ml-1 rounded border px-1 text-xs">D</kbd>
                </Button>
              </div>
            </section>
          )}

          <div ref={listRef} className="space-y-4">
            <Rows title={t("pharmacyOffice.pay.count.toMatch")} testId="pay-section-toMatch" rows={d.toMatch} render={(g: WireUnbilledGrn) => (
              <button type="button" data-pay-row data-testid={`grn-row-${g.grnNo}`} className={rowCls} onClick={() => setOpen({ kind: "grn", grnId: g.grnId })}>
                <span className="font-mono text-xs">{g.grnNo}</span>
                <span className="flex-1 font-medium">{g.vendorName}</span>
                {g.poNo !== null && <span className="font-mono text-xs text-muted-foreground">{g.poNo}</span>}
                <span className="text-xs text-muted-foreground">{g.invoiceNo ?? t("pharmacyOffice.pay.noInvoiceNo")}</span>
                <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.pay.billReady")}</span>
              </button>
            )} />
            {([["held", d.held], ["drafts", d.drafts], ["matched", d.matched]] as const).map(([k, rows]) => (
              <Rows key={k} title={t(`pharmacyOffice.pay.section.${k}`)} testId={`pay-section-${k}`} rows={rows as WireBillSummary[]} render={(b: WireBillSummary) => (
                <BillRow b={b} onOpen={() => setOpen({ kind: "bill", billId: b.id })} />
              )} />
            ))}
            {([["overdue", d.overdue], ["dueThisWeek", d.dueThisWeek]] as const).map(([k, rows]) => (
              <Rows key={k} title={t(`pharmacyOffice.pay.count.${k}`)} testId={`pay-section-${k}`} rows={rows as WirePayableRow[]} render={(b: WirePayableRow) => (
                <BillRow b={b} due onOpen={() => setOpen({ kind: "bill", billId: b.id })} />
              )} />
            ))}
            <Rows title={t("pharmacyOffice.pay.section.runs")} testId="pay-section-runs" rows={d.runs} render={(r: WireRunSummary) => (
              <button type="button" data-pay-row data-testid={`run-row-${r.runNo}`} className={rowCls} onClick={() => setOpen({ kind: "run", runId: r.id })}>
                <span className="font-mono text-xs">{r.runNo}</span>
                <span className="flex-1">{t("pharmacyOffice.pay.runLine", { vendors: r.vendorCount, bills: r.billCount })}</span>
                {r.source === "agent" && <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.agent.drafted")}</span>}
                <span className="tabular-nums">{rupees(r.totalPaise)}</span>
                <span className={`rounded px-1 text-xs ${RUN_TONE[r.status] ?? ""}`}>{t(`pharmacyOffice.pay.runStatus.${r.status}`)}</span>
              </button>
            )} />
            {d.toMatch.length + d.held.length + d.drafts.length + d.matched.length + d.overdue.length + d.dueThisWeek.length + d.runs.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("pharmacyOffice.pay.empty")}</p>
            )}
          </div>
        </>
      )}

      {open?.kind === "grn" && <NewBillSheet grnId={open.grnId} onClose={() => setOpen(null)} onSaved={(b) => setOpen({ kind: "bill", billId: b.id })} />}
      {open?.kind === "bill" && <BillSheet id={open.billId} onClose={() => setOpen(null)} onDone={setNotice} />}
      {open?.kind === "run" && <RunSheet id={open.runId} onClose={() => setOpen(null)} onDone={setNotice} />}
      {open?.kind === "payables" && <PayablesSheet onClose={() => setOpen(null)} onLedger={(vendorId) => setOpen({ kind: "ledger", vendorId })} />}
      {open?.kind === "ledger" && <LedgerSheet vendorId={open.vendorId} onClose={() => setOpen({ kind: "payables" })} />}
    </div>
  );
}

const rowCls = "flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none";

function Rows<T>({ title, rows, render, testId }: { title: string; rows: readonly T[]; render: (r: T) => React.ReactElement; testId: string }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="divide-y rounded border">{rows.map((r, i) => <li key={i}>{render(r)}</li>)}</ul>
    </section>
  );
}

function BillRow({ b, due, onOpen }: { b: WireBillSummary | WirePayableRow; due?: boolean; onOpen: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const overdue = "overdueDays" in b ? b.overdueDays : 0;
  return (
    <button type="button" data-pay-row data-testid={`bill-row-${b.billNo}`} className={rowCls} onClick={onOpen}>
      <span className="font-mono text-xs">{b.billNo}</span>
      <span className="flex-1 font-medium">{b.vendorName}</span>
      {b.msme && <span className="rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}
      <span className="text-xs text-muted-foreground">{b.vendorBillNo}</span>
      <span className="tabular-nums">{rupees(due === true ? b.outstandingPaise : b.totalPaise)}</span>
      {due === true
        ? <span className={`text-xs ${overdue > 0 ? "font-medium text-red-700" : "text-muted-foreground"}`}>{overdue > 0 ? t("pharmacyOffice.pay.daysOverdue", { count: overdue }) : t("pharmacyOffice.pay.dueOn", { date: b.dueDate ?? "" })}</span>
        : <span className={`rounded px-1 text-xs ${BILL_TONE[b.status] ?? ""}`}>{t(`pharmacyOffice.pay.billStatus.${b.status}`)}</span>}
    </button>
  );
}

// ═══════════════════════════════════ the bill ═══════════════════════════════════

type EditLine = { grnId: string; itemId: string; code: string; name: string; uom: string; multiplier: number; expectedBase: number; expectedRate: number; expectedGst: number; qty: string; rate: string; gst: string };

/**
 * A NEW BILL from the agent's prefill of a GRN: bill number and date first (⏎ on either saves and
 * matches), the lines below, each showing what the gate received and at what rate, and its difference.
 */
function NewBillSheet({ grnId, onClose, onSaved }: { grnId: string; onClose: () => void; onSaved: (b: WireBill) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const draft = useQuery({ queryKey: ["pharmacy", "office", "bill-draft", grnId], queryFn: () => fetchBillDraft(grnId) });
  const [no, setNo] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [interState, setInterState] = useState(false);
  const [roundOff, setRoundOff] = useState("0");
  const [lines, setLines] = useState<EditLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noRef = useRef<HTMLInputElement>(null);
  const dd = draft.data;
  useEffect(() => {
    if (dd === undefined || lines !== null) return;
    setNo(dd.vendorBillNo); setDate(dd.billDate); setInterState(dd.interState);
    setLines(dd.lines.map((l) => ({
      grnId: l.grnId, itemId: l.itemId, code: l.itemCode, name: l.itemName, uom: l.uom, multiplier: l.multiplier, expectedBase: l.expectedBase,
      expectedRate: l.ratePaise, expectedGst: l.gstRateBps, qty: String(l.qtyPacks), rate: toRupeeText(l.ratePaise), gst: String(l.gstRateBps / 100),
    })));
    setTimeout(() => { noRef.current?.focus(); noRef.current?.select(); }, 0);
  }, [dd, lines]);

  const save = async (): Promise<void> => {
    if (dd === undefined || lines === null) return;
    if ((no ?? "").trim() === "") { setError(t("pharmacyOffice.pay.bill.needNo")); noRef.current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      const created = await createBill({
        vendorId: dd.vendorId, vendorBillNo: (no ?? "").trim(), billDate: date, interState, roundOffPaise: toPaise(roundOff),
        lines: lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: Number(l.qty || "0"), ratePaise: toPaise(l.rate), gstRateBps: Math.round(Number(l.gst || "0") * 100) })),
      });
      const matched = await matchBill(created.id);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
      onSaved(matched);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const set = (i: number, patch: Partial<EditLine>): void => setLines((prev) => (prev ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const enter = (e: React.KeyboardEvent): void => { if (e.key === "Enter") { e.preventDefault(); void save(); } };

  return (
    <Sheet title={dd === undefined ? t("pharmacyOffice.sheet.loading") : t("pharmacyOffice.pay.bill.newTitle", { grn: dd.grnNo, vendor: dd.vendorName })} onClose={onClose} testId="bill-new-sheet">
      {draft.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(draft.error, t)}</p>}
      {dd !== undefined && lines !== null && (
        <div className="space-y-3 text-sm">
          <p className="rounded bg-emerald-50 p-2 text-xs text-emerald-900">{t("pharmacyOffice.pay.bill.prefilled", { grn: dd.grnNo, po: dd.poNo ?? "—" })}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">{t("pharmacyOffice.pay.bill.vendorBillNo")}
              <input ref={noRef} className="w-48 rounded border px-2 py-1" value={no ?? ""} onChange={(e) => setNo(e.target.value)} onKeyDown={enter} aria-label={t("pharmacyOffice.pay.bill.vendorBillNo")} />
            </label>
            <label className="flex flex-col gap-1">{t("pharmacyOffice.pay.bill.billDate")}
              <input type="date" className="rounded border px-2 py-1" value={date} onChange={(e) => setDate(e.target.value)} onKeyDown={enter} aria-label={t("pharmacyOffice.pay.bill.billDate")} />
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} /> {t("pharmacyOffice.pay.bill.interState")}</label>
            <label className="flex flex-col gap-1">{t("pharmacyOffice.pay.bill.roundOff")}
              <input className="w-20 rounded border px-2 py-1 text-right" inputMode="decimal" value={roundOff} onChange={(e) => setRoundOff(e.target.value)} aria-label={t("pharmacyOffice.pay.bill.roundOff")} />
            </label>
            {dd.msme && <span className="rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="bill-new-lines">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.bill.received")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.rate")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.gst")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.taxable")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.bill.difference")}</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const taxable = Number(l.qty || "0") * toPaise(l.rate);
                  const expected = Math.round((l.expectedBase / l.multiplier) * l.expectedRate);
                  const diff = taxable - expected;
                  return (
                    <tr key={`${l.grnId}-${l.itemId}`} className="border-t" data-testid={`bill-new-line-${l.code}`}>
                      <td className="py-1 pr-2">{l.name} <span className="text-xs text-muted-foreground">{l.code}</span></td>
                      <td className="py-1 pr-2 text-xs">{l.expectedBase / l.multiplier} {l.uom} @ {rupees(l.expectedRate)}</td>
                      <td className="py-1 pr-2 text-right"><input aria-label={`${t("pharmacyOffice.sheet.qty")} ${l.code}`} className="w-14 rounded border px-1 text-right" inputMode="numeric" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                      <td className="py-1 pr-2 text-right"><input aria-label={`${t("pharmacyOffice.sheet.rate")} ${l.code}`} className="w-20 rounded border px-1 text-right" inputMode="decimal" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} /></td>
                      <td className="py-1 pr-2 text-right"><input aria-label={`${t("pharmacyOffice.sheet.gst")} ${l.code}`} className="w-12 rounded border px-1 text-right" inputMode="decimal" value={l.gst} onChange={(e) => set(i, { gst: e.target.value })} /></td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(taxable)}</td>
                      <td className={`py-1 pr-2 text-right tabular-nums ${diff === 0 ? "text-muted-foreground" : "text-amber-800"}`}>{diff === 0 ? "—" : `${diff > 0 ? "+" : "−"}${rupees(Math.abs(diff))}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.bill.expected", { amount: rupees(dd.expectedTotalPaise) })}</p>
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <Button type="button" disabled={busy} onClick={() => void save()}>{t("pharmacyOffice.pay.bill.saveMatch")} <kbd className="ml-1 rounded border px-1 text-xs">⏎</kbd></Button>
        </div>
      )}
    </Sheet>
  );
}

const MISMATCH_TONE = (out: boolean): string => (out ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground");

/** A bill that exists: its match line by line, and the act its status allows. */
function BillSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const bill = useQuery({ queryKey: ["pharmacy", "office", "bill", id], queryFn: () => fetchBill(id) });
  const [reason, setReason] = useState("");
  const [more, setMore] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const b = bill.data;
  const act = async (fn: () => Promise<WireBill>, msg: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      qc.setQueryData(["pharmacy", "office", "bill", id], await fn());
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
      onDone(msg);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const canAccept = b?.status === "matched" && can("materials.bills.manage");
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (typing || busy || !canAccept || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "a" || e.key === "A") { e.preventDefault(); void act(() => acceptBill(id), t("pharmacyOffice.pay.bill.accepted")); }
  };
  return (
    <Sheet title={b === undefined ? t("pharmacyOffice.sheet.loading") : `${b.billNo} · ${b.vendorName}`} onClose={onClose} testId="bill-sheet" onKey={onKey}>
      {bill.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(bill.error, t)}</p>}
      {b !== undefined && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-1 text-xs ${BILL_TONE[b.status] ?? ""}`} data-testid="bill-status">{t(`pharmacyOffice.pay.billStatus.${b.status}`)}</span>
            <span>{t("pharmacyOffice.pay.bill.vendorBillNo")}: <b>{b.vendorBillNo}</b></span>
            <span>{b.billDate}</span>
            {b.poNo !== null && <span className="font-mono text-xs">{b.poNo}</span>}
            {b.msme && <span className="rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}
            {b.dueDate !== null && <span>{t("pharmacyOffice.pay.dueOn", { date: b.dueDate })}</span>}
          </div>
          {b.heldReason !== null && <p className="rounded bg-amber-50 p-2 text-amber-900" data-testid="bill-held">{t("pharmacyOffice.pay.bill.heldBecause", { reason: b.heldReason })}</p>}
          {b.differenceReason !== null && <p className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.bill.differenceAccepted", { reason: b.differenceReason, by: b.names[b.differenceAcceptedBy ?? ""] ?? "" })}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="bill-lines">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th><th className="py-1 pr-2">GRN</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.bill.billed")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.bill.expectedCol")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.bill.difference")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.bill.match")}</th>
              </tr></thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.id} className="border-t" data-testid={`bill-line-${l.itemCode}`}>
                    <td className="py-1 pr-2">{l.itemName} <span className="text-xs text-muted-foreground">{l.itemCode}</span></td>
                    <td className="py-1 pr-2 font-mono text-xs">{l.grnNo}</td>
                    <td className="py-1 pr-2 text-right text-xs">{l.qtyPacks} {l.uom} × {rupees(l.ratePaise)} @ {l.gstRateBps / 100}% = <b className="tabular-nums">{rupees(l.taxablePaise)}</b></td>
                    <td className="py-1 pr-2 text-right text-xs">{l.expectedPacks} × {rupees(l.expectedRatePaise)} @ {l.expectedGstRateBps / 100}% = <span className="tabular-nums">{rupees(l.expectedTaxablePaise)}</span></td>
                    <td className="py-1 pr-2 text-right tabular-nums">{l.differencePaise === 0 ? "—" : `${l.differencePaise > 0 ? "+" : "−"}${rupees(Math.abs(l.differencePaise))}`}</td>
                    <td className="py-1 pr-2">
                      {l.mismatch.length === 0
                        ? <span className="text-xs text-green-700">{t("pharmacyOffice.pay.bill.ok")}</span>
                        : l.mismatch.map((m) => <span key={m} className={`mr-1 rounded px-1 text-xs ${MISMATCH_TONE(l.out)}`}>{t(`pharmacyOffice.pay.mismatch.${m}`)}</span>)}
                    </td>
                  </tr>
                ))}
                {b.unbilled.map((u) => (
                  <tr key={`${u.grnId}-${u.itemId}`} className="border-t text-amber-900">
                    <td className="py-1 pr-2">{u.itemName}</td><td className="py-1 pr-2 font-mono text-xs">{u.grnNo}</td>
                    <td className="py-1 pr-2 text-right">—</td><td className="py-1 pr-2 text-right tabular-nums">{rupees(u.expectedTaxablePaise)}</td>
                    <td /><td className="py-1 pr-2"><span className="rounded bg-amber-100 px-1 text-xs">{t("pharmacyOffice.pay.mismatch.not_billed")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-end gap-5" data-testid="bill-totals">
            <span>{t("pharmacyOffice.sheet.taxable")} <b className="tabular-nums">{rupees(b.taxablePaise)}</b></span>
            {b.interState ? <span>IGST <b className="tabular-nums">{rupees(b.igstPaise)}</b></span> : (<>
              <span>CGST <b className="tabular-nums">{rupees(b.cgstPaise)}</b></span><span>SGST <b className="tabular-nums">{rupees(b.sgstPaise)}</b></span>
            </>)}
            {b.roundOffPaise !== 0 && <span>{t("pharmacyOffice.pay.bill.roundOff")} {rupees(b.roundOffPaise)}</span>}
            <span>{t("pharmacyOffice.sheet.total")} <b className="tabular-nums">{rupees(b.totalPaise)}</b></span>
            <span className="text-muted-foreground">{t("pharmacyOffice.pay.bill.expectedShort")} {rupees(b.expectedTotalPaise)}</span>
            {b.paidPaise > 0 && <span>{t("pharmacyOffice.pay.paid")} <b className="tabular-nums">{rupees(b.paidPaise)}</b></span>}
          </div>
          {b.payments.length > 0 && (
            <ul className="text-xs text-muted-foreground" data-testid="bill-payments">
              {b.payments.map((p) => <li key={p.paymentId}>{p.paymentNo} · {p.runNo} · {p.mode.toUpperCase()} {p.reference ?? ""} · {p.paidOn} · {rupees(p.paidPaise)}</li>)}
            </ul>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {b.status === "draft" && can("materials.bills.manage") && (
              <Button type="button" disabled={busy} onClick={() => void act(() => matchBill(id), t("pharmacyOffice.pay.bill.matchedMsg"))}>{t("pharmacyOffice.pay.bill.match")}</Button>
            )}
            {canAccept && (
              <Button type="button" disabled={busy} onClick={() => void act(() => acceptBill(id), t("pharmacyOffice.pay.bill.accepted"))}>
                {t("pharmacyOffice.pay.bill.accept")} <kbd className="ml-1 rounded border px-1 text-xs">A</kbd>
              </Button>
            )}
            {b.status === "held_for_match" && can("materials.bills.accept_difference") && (
              <>
                <input className="flex-1 rounded border px-2 py-1" placeholder={t("pharmacyOffice.pay.bill.differenceReason")} aria-label={t("pharmacyOffice.pay.bill.differenceReason")} value={reason} onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && reason.trim() !== "") { e.preventDefault(); void act(() => acceptDifference(id, reason.trim()), t("pharmacyOffice.pay.bill.accepted")); } }} />
                <Button type="button" disabled={busy || reason.trim() === ""} onClick={() => void act(() => acceptDifference(id, reason.trim()), t("pharmacyOffice.pay.bill.accepted"))}>{t("pharmacyOffice.pay.bill.acceptDifference")}</Button>
              </>
            )}
            {b.status === "held_for_match" && !can("materials.bills.accept_difference") && <span className="text-muted-foreground">{t("pharmacyOffice.pay.bill.waitingHead")}</span>}
            {["draft", "matched", "held_for_match", "accepted"].includes(b.status) && b.paidPaise === 0 && can("materials.bills.manage") && (
              <Button type="button" variant="ghost" aria-label={t("pharmacyOffice.sheet.more")} onClick={() => setMore((m) => !m)}>⋯</Button>
            )}
          </div>
          {more && (
            <div className="flex flex-wrap items-center gap-2 rounded border p-2">
              <input className="flex-1 rounded border px-2 py-1" placeholder={t("pharmacyOffice.pay.bill.cancelReason")} aria-label={t("pharmacyOffice.pay.bill.cancelReason")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <Button type="button" variant="outline" disabled={busy || cancelReason.trim() === ""} onClick={() => void act(() => cancelBill(id, cancelReason.trim()), t("pharmacyOffice.pay.bill.cancelled"))}>{t("pharmacyOffice.pay.bill.cancel")}</Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ═══════════════════════════════════ the payment run ═══════════════════════════════════

/**
 * THE RUN — the Healthray grid, grouped by vendor: each bill's total, what was paid before, the
 * credit to offset (P4), what to pay now, what remains, and a Full tick per row and per vendor. A
 * draft is edited in place; an authorised run records each vendor paid.
 */
function RunSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const run = useQuery({ queryKey: ["pharmacy", "office", "run", id], queryFn: () => fetchRun(id) });
  const [pay, setPay] = useState<Record<string, string> | null>(null);
  const [record, setRecord] = useState<Record<string, { mode: PaymentMode; reference: string; paidOn: string }>>({});
  const [more, setMore] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = run.data;
  useEffect(() => {
    if (r === undefined || pay !== null) return;
    setPay(Object.fromEntries(r.vendors.flatMap((v) => v.lines.map((l) => [l.billId, toRupeeText(l.payPaise)]))));
  }, [r, pay]);
  const isDraft = r?.status === "draft" && can("materials.payments.prepare");
  const act = async (fn: () => Promise<WireRun>, msg: string, reset = false): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = await fn();
      qc.setQueryData(["pharmacy", "office", "run", id], next);
      if (reset) setPay(null);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
      onDone(msg);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const maxFor = (l: { totalPaise: number; prevPaidPaise: number; creditPaise: number }): number => l.totalPaise - l.prevPaidPaise - l.creditPaise;
  const linesOut = (): { billId: string; payPaise: number }[] =>
    Object.entries(pay ?? {}).map(([billId, v]) => ({ billId, payPaise: toPaise(v) })).filter((l) => l.payPaise > 0);
  const save = (): Promise<WireRun> => updateRun(id, { lines: linesOut() });
  const total = r === undefined ? 0 : isDraft ? linesOut().reduce((s, l) => s + l.payPaise, 0) : r.totalPaise;
  const recordFor = (vendorId: string): { mode: PaymentMode; reference: string; paidOn: string } => record[vendorId] ?? { mode: "neft", reference: "", paidOn: "" };
  const iAuthorised = r?.authorisedBy !== null && r?.authorisedBy === actor?.id;

  return (
    <Sheet title={r === undefined ? t("pharmacyOffice.sheet.loading") : `${r.runNo} · ${t(`pharmacyOffice.pay.runStatus.${r.status}`)}`} onClose={onClose} testId="run-sheet">
      {run.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(run.error, t)}</p>}
      {r !== undefined && pay !== null && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-1 text-xs ${RUN_TONE[r.status] ?? ""}`} data-testid="run-status">{t(`pharmacyOffice.pay.runStatus.${r.status}`)}</span>
            {r.source === "agent" && <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.agent.drafted")}</span>}
            <span className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.run.preparedBy", { name: r.names[r.createdBy] ?? "" })}</span>
            {r.authorisedBy !== null && <span className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.run.authorisedBy", { name: r.names[r.authorisedBy] ?? "" })}</span>}
          </div>
          {r.rejectionNote !== null && r.status === "draft" && <p className="rounded bg-red-50 p-2 text-red-800">{t("pharmacyOffice.pay.run.refused", { note: r.rejectionNote })}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="run-grid">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.invDate")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.run.ourNo")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.vendorNo")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.total")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.prevPaid")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.credit")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.payNow")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.remaining")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.full")}</th>
              </tr></thead>
              {r.vendors.map((v) => {
                const allFull = v.lines.every((l) => toPaise(pay[l.billId] ?? "0") === maxFor(l));
                const rec = recordFor(v.vendorId);
                return (
                  <tbody key={v.vendorId} data-testid={`run-vendor-${v.vendorCode}`}>
                    <tr className="border-t bg-muted/40">
                      <td colSpan={6} className="py-1 pr-2 font-medium">
                        {v.vendorName} {v.msme && <span className="ml-1 rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}
                        {v.coolingOffUntil !== null && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-900">{t("pharmacyOffice.pay.run.coolingOff", { date: v.coolingOffUntil.slice(0, 10) })}</span>}
                      </td>
                      <td className="py-1 pr-2 text-right font-medium tabular-nums">{rupees(isDraft ? v.lines.reduce((s, l) => s + toPaise(pay[l.billId] ?? "0"), 0) : v.payPaise)}</td>
                      <td />
                      <td className="py-1 pr-2">
                        {isDraft && <input type="checkbox" aria-label={t("pharmacyOffice.pay.run.fullVendor", { vendor: v.vendorName })} checked={allFull}
                          onChange={(e) => setPay((p) => ({ ...(p ?? {}), ...Object.fromEntries(v.lines.map((l) => [l.billId, e.target.checked ? toRupeeText(maxFor(l)) : "0.00"])) }))} />}
                      </td>
                    </tr>
                    {v.lines.map((l) => {
                      const now = isDraft ? toPaise(pay[l.billId] ?? "0") : l.payPaise;
                      return (
                        <tr key={l.id} className="border-t" data-testid={`run-line-${l.billNo}`}>
                          <td className="py-1 pr-2 text-xs">{l.billDate}</td>
                          <td className="py-1 pr-2 font-mono text-xs">{l.billNo}</td>
                          <td className="py-1 pr-2 text-xs">{l.vendorBillNo}{l.overdueDays > 0 && <span className="ml-1 text-red-700">{t("pharmacyOffice.pay.daysOverdue", { count: l.overdueDays })}</span>}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.totalPaise)}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.prevPaidPaise)}</td>
                          <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{l.creditPaise === 0 ? "—" : rupees(l.creditPaise)}</td>
                          <td className="py-1 pr-2 text-right">
                            {isDraft
                              ? <input aria-label={`${t("pharmacyOffice.pay.run.payNow")} ${l.billNo}`} className="w-24 rounded border px-1 text-right" inputMode="decimal" value={pay[l.billId] ?? ""} onChange={(e) => setPay((p) => ({ ...(p ?? {}), [l.billId]: e.target.value }))} />
                              : <span className="tabular-nums">{rupees(l.payPaise)}</span>}
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums">{rupees(maxFor(l) - now)}</td>
                          <td className="py-1 pr-2">
                            {isDraft
                              ? <input type="checkbox" aria-label={`${t("pharmacyOffice.pay.run.full")} ${l.billNo}`} checked={now === maxFor(l)} onChange={(e) => setPay((p) => ({ ...(p ?? {}), [l.billId]: e.target.checked ? toRupeeText(maxFor(l)) : "0.00" }))} />
                              : l.paid ? <span className="text-xs text-green-700">{t("pharmacyOffice.pay.paid")}</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                    {r.status === "authorised" && v.payment === null && can("materials.payments.record") && (
                      <tr className="border-t" data-testid={`run-record-${v.vendorCode}`}>
                        <td colSpan={9} className="py-2">
                          {iAuthorised ? <span className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.run.notYours")}</span> : (
                            <div className="flex flex-wrap items-center gap-2">
                              <select aria-label={t("pharmacyOffice.pay.run.mode", { vendor: v.vendorName })} className="rounded border px-1" value={rec.mode}
                                onChange={(e) => setRecord((x) => ({ ...x, [v.vendorId]: { ...rec, mode: e.target.value as PaymentMode } }))}>
                                {PAYMENT_MODES.map((m) => <option key={m} value={m}>{t(`pharmacyOffice.pay.mode.${m}`)}</option>)}
                              </select>
                              {rec.mode !== "cash" && (
                                <input aria-label={t("pharmacyOffice.pay.run.reference", { vendor: v.vendorName })} className="w-40 rounded border px-1" placeholder={rec.mode === "cheque" ? t("pharmacyOffice.pay.run.chequeNo") : t("pharmacyOffice.pay.run.utr")}
                                  value={rec.reference} onChange={(e) => setRecord((x) => ({ ...x, [v.vendorId]: { ...rec, reference: e.target.value } }))} />
                              )}
                              <input type="date" aria-label={t("pharmacyOffice.pay.run.paidOn", { vendor: v.vendorName })} className="rounded border px-1" value={rec.paidOn} onChange={(e) => setRecord((x) => ({ ...x, [v.vendorId]: { ...rec, paidOn: e.target.value } }))} />
                              <Button type="button" disabled={busy || (rec.mode !== "cash" && rec.reference.trim() === "")}
                                onClick={() => void act(() => recordPayment(id, v.vendorId, { mode: rec.mode, reference: rec.mode === "cash" ? null : rec.reference.trim(), paidOn: rec.paidOn === "" ? null : rec.paidOn }), t("pharmacyOffice.pay.run.recorded", { vendor: v.vendorName }))}>
                                {t("pharmacyOffice.pay.run.markPaid", { amount: rupees(v.payPaise) })}
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    {v.payment !== null && (
                      <tr className="border-t text-xs text-green-800"><td colSpan={9} className="py-1">{t("pharmacyOffice.pay.run.paidWith", { no: v.payment.paymentNo, mode: t(`pharmacyOffice.pay.mode.${v.payment.mode}`), ref: v.payment.reference ?? "", date: v.payment.paidOn, amount: rupees(v.payment.amountPaise) })}</td></tr>
                    )}
                  </tbody>
                );
              })}
            </table>
          </div>
          <div className="flex justify-end text-sm" data-testid="run-total"><span>{t("pharmacyOffice.pay.run.total")} <b className="tabular-nums">{rupees(total)}</b></span></div>
          <p className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.run.creditNote")}</p>
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void act(save, t("pharmacyOffice.sheet.saved"), true)}>{t("pharmacyOffice.sheet.save")}</Button>
                {r.createdBy === actor?.id && (
                  <Button type="button" disabled={busy} onClick={() => void act(async () => { await save(); return submitRun(id); }, t("pharmacyOffice.pay.run.submitted"), true)}>{t("pharmacyOffice.pay.run.submit")}</Button>
                )}
              </>
            )}
            {r.status === "pending_authorisation" && <span className="text-muted-foreground" data-testid="run-waiting">{t("pharmacyOffice.pay.run.waitingOwner")}</span>}
            {["draft", "pending_authorisation", "authorised"].includes(r.status) && can("materials.payments.prepare") && r.vendors.every((v) => v.payment === null) && (
              <Button type="button" variant="ghost" aria-label={t("pharmacyOffice.sheet.more")} onClick={() => setMore((m) => !m)}>⋯</Button>
            )}
          </div>
          {more && (
            <div className="flex flex-wrap items-center gap-2 rounded border p-2">
              <input className="flex-1 rounded border px-2 py-1" placeholder={t("pharmacyOffice.pay.run.cancelReason")} aria-label={t("pharmacyOffice.pay.run.cancelReason")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <Button type="button" variant="outline" disabled={busy || cancelReason.trim() === ""} onClick={() => void act(() => cancelRun(id, cancelReason.trim()), t("pharmacyOffice.pay.run.cancelled"))}>{t("pharmacyOffice.pay.run.cancel")}</Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ═══════════════════════════════════ payables, ageing, the supplier summary, the ledger ═══════════════════════════════════

function PayablesSheet({ onClose, onLedger }: { onClose: () => void; onLedger: (vendorId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "office", "payables"], queryFn: () => fetchPayables() });
  const [tab, setTab] = useState<"ageing" | "suppliers">("ageing");
  const p = q.data;
  const exportAgeing = (): void => {
    if (p === undefined) return;
    downloadCsv(`payables-ageing-${p.asOf}.csv`, toCsv(
      ["Our no", "Vendor", "Vendor bill no", "Bill date", "Due date", "Age (days)", "Bucket", "Total", "Paid", "Outstanding", "Overdue (days)", "MSME"],
      p.bills.map((b) => [b.billNo, b.vendorName, b.vendorBillNo, b.billDate, b.dueDate ?? "", b.ageDays, b.bucket, csvRupees(b.totalPaise), csvRupees(b.paidPaise), csvRupees(b.outstandingPaise), b.overdueDays, b.msme ? "yes" : "no"]),
    ));
  };
  const exportSuppliers = (): void => {
    if (p === undefined) return;
    downloadCsv(`supplier-summary-${p.asOf}.csv`, toCsv(
      ["Supplier", "Code", "GSTIN", "MSME", "Total", "Paid", "Remaining", "Overdue", "0-30", "31-60", "61-90", "90+"],
      p.suppliers.map((s) => [s.vendorName, s.vendorCode, s.gstin ?? "", s.msme ? "yes" : "no", csvRupees(s.totalPaise), csvRupees(s.paidPaise), csvRupees(s.remainingPaise), csvRupees(s.overduePaise), ...AGE_BUCKETS.map((k) => csvRupees(s.buckets[k]))]),
    ));
  };
  return (
    <Sheet title={t("pharmacyOffice.pay.payables.title")} onClose={onClose} testId="payables-sheet">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {p !== undefined && (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="ageing-buckets">
            {AGE_BUCKETS.map((k) => (
              <div key={k} className={`rounded border p-2 ${k === "90_plus" && p.buckets[k] > 0 ? "border-red-400" : ""}`}>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.pay.bucket.${k}`)}</div>
                <div className="font-semibold tabular-nums">{rupees(p.buckets[k])}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant={tab === "ageing" ? "default" : "outline"} onClick={() => setTab("ageing")}>{t("pharmacyOffice.pay.payables.ageing")}</Button>
            <Button type="button" variant={tab === "suppliers" ? "default" : "outline"} onClick={() => setTab("suppliers")}>{t("pharmacyOffice.pay.payables.suppliers")}</Button>
            <span className="flex-1" />
            <Button type="button" variant="outline" onClick={tab === "ageing" ? exportAgeing : exportSuppliers}>{t("pharmacyOffice.pay.csv")}</Button>
          </div>
          {tab === "ageing" ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="ageing-table">
                <thead><tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.ourNo")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.payables.supplier")}</th>
                  <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.vendorNo")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.run.invDate")}</th>
                  <th className="py-1 pr-2">{t("pharmacyOffice.pay.payables.due")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.payables.age")}</th>
                  <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.payables.outstanding")}</th>
                </tr></thead>
                <tbody>
                  {p.bills.map((b) => (
                    <tr key={b.id} className="border-t" data-testid={`ageing-${b.billNo}`}>
                      <td className="py-1 pr-2 font-mono text-xs">{b.billNo}</td>
                      <td className="py-1 pr-2">{b.vendorName} {b.msme && <span className="rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}</td>
                      <td className="py-1 pr-2 text-xs">{b.vendorBillNo}</td><td className="py-1 pr-2 text-xs">{b.billDate}</td>
                      <td className={`py-1 pr-2 text-xs ${b.overdueDays > 0 ? "font-medium text-red-700" : ""}`}>{b.dueDate}{b.overdueDays > 0 ? ` (${t("pharmacyOffice.pay.daysOverdue", { count: b.overdueDays })})` : ""}</td>
                      <td className="py-1 pr-2 text-right text-xs">{b.ageDays} · {t(`pharmacyOffice.pay.bucket.${b.bucket}`)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(b.outstandingPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="supplier-summary">
                <thead><tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-2">{t("pharmacyOffice.pay.payables.supplier")}</th><th className="py-1 pr-2">GSTIN</th>
                  <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.total")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.paid")}</th>
                  <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.remaining")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.overdueAmount")}</th><th />
                </tr></thead>
                <tbody>
                  {p.suppliers.map((s) => (
                    <tr key={s.vendorId} className="border-t" data-testid={`supplier-${s.vendorCode}`}>
                      <td className="py-1 pr-2">{s.vendorName} {s.msme && <span className="rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}</td>
                      <td className="py-1 pr-2 font-mono text-xs">{s.gstin ?? "—"}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(s.totalPaise)}</td><td className="py-1 pr-2 text-right tabular-nums">{rupees(s.paidPaise)}</td>
                      <td className="py-1 pr-2 text-right font-medium tabular-nums">{rupees(s.remainingPaise)}</td>
                      <td className={`py-1 pr-2 text-right tabular-nums ${s.overduePaise > 0 ? "text-red-700" : ""}`}>{rupees(s.overduePaise)}</td>
                      <td className="py-1 pr-2"><Button type="button" variant="outline" onClick={() => onLedger(s.vendorId)}>{t("pharmacyOffice.pay.payables.ledger")}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function LedgerSheet({ vendorId, onClose }: { vendorId: string; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = useQuery({ queryKey: ["pharmacy", "office", "ledger", vendorId, from, to], queryFn: () => fetchLedger(vendorId, { from, to }) });
  const l = q.data;
  const exportCsv = (): void => {
    if (l === undefined) return;
    downloadCsv(`ledger-${l.vendorCode}-${l.from ?? "start"}-${l.to ?? "today"}.csv`, toCsv(
      ["Date", "Kind", "Voucher", "Reference", "Bill (credit)", "Payment (debit)", "Balance"],
      [["", "opening", "", "", "", "", csvRupees(l.openingPaise)], ...l.entries.map((e) => [e.date, e.kind, e.voucherNo, e.reference, csvRupees(e.creditPaise), csvRupees(e.debitPaise), csvRupees(e.balancePaise)])],
    ));
  };
  return (
    <Sheet title={l === undefined ? t("pharmacyOffice.sheet.loading") : t("pharmacyOffice.pay.ledger.title", { vendor: l.vendorName })} onClose={onClose} testId="ledger-sheet">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">{t("pharmacyOffice.pay.ledger.from")}<input type="date" className="rounded border px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("pharmacyOffice.pay.ledger.from")} /></label>
        <label className="flex flex-col gap-1">{t("pharmacyOffice.pay.ledger.to")}<input type="date" className="rounded border px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("pharmacyOffice.pay.ledger.to")} /></label>
        <Button type="button" variant="outline" onClick={exportCsv}>{t("pharmacyOffice.pay.csv")}</Button>
      </div>
      {l !== undefined && (
        <div className="overflow-x-auto text-sm">
          <table className="w-full" data-testid="ledger-table">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2">{t("pharmacyOffice.pay.ledger.date")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.ledger.voucher")}</th>
              <th className="py-1 pr-2">{t("pharmacyOffice.pay.ledger.reference")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.ledger.bill")}</th>
              <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.ledger.payment")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.ledger.balance")}</th>
            </tr></thead>
            <tbody>
              <tr className="border-t text-muted-foreground"><td className="py-1 pr-2" colSpan={5}>{t("pharmacyOffice.pay.ledger.opening")}</td><td className="py-1 pr-2 text-right tabular-nums">{rupees(l.openingPaise)}</td></tr>
              {l.entries.map((e) => (
                <tr key={`${e.kind}-${e.id}`} className="border-t" data-testid={`ledger-${e.voucherNo}`}>
                  <td className="py-1 pr-2 text-xs">{e.date}</td>
                  <td className="py-1 pr-2 font-mono text-xs">{e.voucherNo}</td>
                  <td className="py-1 pr-2 text-xs">{e.reference}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{e.creditPaise === 0 ? "" : rupees(e.creditPaise)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{e.debitPaise === 0 ? "" : rupees(e.debitPaise)}</td>
                  <td className="py-1 pr-2 text-right font-medium tabular-nums">{rupees(e.balancePaise)}</td>
                </tr>
              ))}
              <tr className="border-t font-medium"><td className="py-1 pr-2" colSpan={3}>{t("pharmacyOffice.pay.ledger.closing")}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.billedPaise)}</td><td className="py-1 pr-2 text-right tabular-nums">{rupees(l.paidPaise)}</td>
                <td className="py-1 pr-2 text-right tabular-nums" data-testid="ledger-closing">{rupees(l.closingPaise)}</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">{t("pharmacyOffice.pay.ledger.notesLater")}</p>
        </div>
      )}
    </Sheet>
  );
}


