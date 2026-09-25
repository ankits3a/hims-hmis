import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { fetchItems, materialsErrorText } from "../../lib/materials-api";
import { csvRupees, downloadCsv, toCsv } from "../../lib/payables-api";
import { printInFrame } from "../../lib/print-api";
import { rupees } from "../../lib/purchase-api";
import {
  EXPIRY_PRESETS, RECALL_SOURCES, approveReturn, cancelCredit, cancelReturn, closeRecall, closeReturn, dispatchReturn, draftReturns,
  fetchDebitNote, fetchExpiryReport, fetchManifest, fetchOfficeReturns, fetchRecall, fetchRecallBatches, fetchReturn, fetchReturnPlan,
  fetchWriteOff, postWriteOff, qtyText, raiseRecall, raiseWriteOff, recordCredit, returnFromRecall,
} from "../../lib/returns-api";
import { Button } from "@/components/ui/button";
import { Sheet } from "./sheet";
import type {
  ExpiryPreset, RecallSource, WireDestroyCandidate, WireExpiryRow, WireRecallSummary, WireReturn, WireReturnSummary, WireWriteOff,
  WireWriteOffSummary, WriteOffReason,
} from "../../lib/returns-api";

/**
 * ═══ PHARMACY PARITY P4 — THE OFFICE RETURNS ═══
 *
 * The office's third side, one screen like the other two. It opens on what is expiring (expired,
 * 30 / 60 / 90 days, each with its value at cost), the agent's card — how many returns it would draft
 * and what can only be destroyed — and the documents in flight: returns to approve, to dispatch and
 * awaiting the vendor's credit; write-offs awaiting the medical superintendent and ready to hand over;
 * open recalls. Every row opens its sheet.
 *
 *   - E opens the EXPIRY REPORT (Healthray s13/s14): presets, Item-wise | Supplier-wise, CSV.
 *   - D reviews the agent's plan; "Make the drafts" writes one DRAFT return per vendor ticked.
 *   - A return is approved by the head (never its drafter; A), dispatched by somebody else (D), which
 *     issues our DEBIT NOTE (P prints it); the vendor's credit note is recorded on it and the next
 *     payment run sets it off.
 *   - W raises a DESTRUCTION write-off of what cannot go back; the MS approves it in /approvals; it is
 *     posted with the disposal agency's manifest, which prints.
 *   - R raises a RECALL on a batch; its sheet shows where the batch sits and who it was dispensed to
 *     (read-only, for the callback), and one tap drafts its return.
 */
type Open =
  | { kind: "expiry"; preset: ExpiryPreset }
  | { kind: "plan" }
  | { kind: "return"; id: string }
  | { kind: "writeoff"; id: string }
  | { kind: "newWriteoff"; candidates: WireDestroyCandidate[] }
  | { kind: "recall"; id: string }
  | { kind: "newRecall" };

const RETURN_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", approved: "bg-sky-100 text-sky-900", dispatched: "bg-amber-100 text-amber-900",
  credited: "bg-green-100 text-green-800", closed: "bg-slate-200 text-slate-800", cancelled: "bg-red-100 text-red-800",
};
const rowCls = "flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none";
const toPaise = (text: string): number => Math.round(Number(text || "0") * 100);
const todayIst = (): string => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function ReturnsView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["pharmacy", "office", "returns"], queryFn: fetchOfficeReturns });
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const d = q.data;
  const canManage = can("materials.returns.manage");
  const canWriteOff = can("materials.writeoffs.manage");
  const canRecall = can("materials.recall.manage");

  const openWriteOff = async (): Promise<void> => {
    try { setOpen({ kind: "newWriteoff", candidates: (await fetchReturnPlan()).toDestroy }); } catch { setOpen({ kind: "newWriteoff", candidates: [] }); }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || open !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "e") { e.preventDefault(); setOpen({ kind: "expiry", preset: "90" }); return; }
    if (k === "d" && canManage && d !== undefined && d.plan.vendors > 0) { e.preventDefault(); setOpen({ kind: "plan" }); return; }
    if (k === "w" && canWriteOff) { e.preventDefault(); void openWriteOff(); return; }
    if (k === "r" && canRecall) { e.preventDefault(); setOpen({ kind: "newRecall" }); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-ret-row]") ?? []);
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[i < 0 ? 0 : e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };

  const returnRow = (r: WireReturnSummary): React.ReactElement => (
    <button type="button" data-ret-row data-testid={`return-row-${r.returnNo}`} className={rowCls} onClick={() => setOpen({ kind: "return", id: r.id })}>
      <span className="font-mono text-xs">{r.debitNoteNo ?? r.returnNo}</span>
      <span className="flex-1 font-medium">{r.vendorName}</span>
      {r.source === "agent" && <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.agent.drafted")}</span>}
      {r.source === "recall" && <span className="rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyOffice.returns.fromRecall")}</span>}
      <span className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.batches", { count: r.lineCount })}</span>
      <span className="tabular-nums">{rupees(r.totalPaise)}</span>
      <span className={`rounded px-1 text-xs ${RETURN_TONE[r.status] ?? ""}`}>{t(`pharmacyOffice.returns.status.${r.status}`)}</span>
    </button>
  );
  const writeOffRow = (w: WireWriteOffSummary): React.ReactElement => (
    <button type="button" data-ret-row data-testid={`writeoff-row-${w.writeOffNo}`} className={rowCls} onClick={() => setOpen({ kind: "writeoff", id: w.id })}>
      <span className="font-mono text-xs">{w.writeOffNo}</span>
      <span className="flex-1 font-medium">{w.storeName}</span>
      <span className="text-xs text-muted-foreground">{t(`pharmacyOffice.returns.writeOff.reason.${w.reason}`)} · {t("pharmacyOffice.returns.batches", { count: w.lineCount })}</span>
      <span className="tabular-nums">{rupees(w.totalValuePaise)}</span>
      <span className="rounded bg-amber-100 px-1 text-xs text-amber-900">{t(`pharmacyOffice.returns.approval.${w.approvalStatus}`, { defaultValue: w.approvalStatus })}</span>
    </button>
  );
  const recallRow = (r: WireRecallSummary): React.ReactElement => (
    <button type="button" data-ret-row data-testid={`recall-row-${r.recallNo}`} className={rowCls} onClick={() => setOpen({ kind: "recall", id: r.id })}>
      <span className="font-mono text-xs">{r.recallNo}</span>
      <span className="flex-1 font-medium">{r.itemName} · {r.batchNo}</span>
      <span className="text-xs text-muted-foreground">{t(`pharmacyOffice.returns.recall.source.${r.source}`)}{r.reference === null ? "" : ` ${r.reference}`}</span>
      <span className="text-xs">{t("pharmacyOffice.returns.recall.left", { count: r.onHand })}</span>
    </button>
  );

  const e = d?.expiring;
  return (
    <div className="space-y-5 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid="returns-view">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {d !== undefined && e !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="returns-counts">
            {([
              ["expired", e.expired, e.expiredValuePaise, "expired"], ["d30", e.d30, e.d30ValuePaise, "30"],
              ["d60", e.d60, e.d60ValuePaise, "60"], ["d90", e.d90, e.d90ValuePaise, "90"],
            ] as const).map(([k, n, v, preset]) => (
              <button key={k} type="button" className={`rounded border p-3 text-left hover:bg-muted ${k === "expired" && n > 0 ? "border-red-400" : k === "d30" && n > 0 ? "border-amber-400" : ""}`}
                data-testid={`returns-count-${k}`} onClick={() => setOpen({ kind: "expiry", preset })}>
                <div className="text-2xl font-semibold tabular-nums">{n}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.returns.count.${k}`)}</div>
                <div className="text-xs tabular-nums">{rupees(v)}</div>
              </button>
            ))}
            <div className="rounded border p-3" data-testid="returns-count-awaitingCredit">
              <div className="text-2xl font-semibold tabular-nums">{d.awaitingCredit.length}</div>
              <div className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.count.awaitingCredit")}</div>
            </div>
            <div className={`rounded border p-3 ${d.writeOffsAwaiting.length > 0 ? "border-amber-400" : ""}`} data-testid="returns-count-writeOffs">
              <div className="text-2xl font-semibold tabular-nums">{d.writeOffsAwaiting.length}</div>
              <div className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.count.writeOffs")}</div>
            </div>
            <div className={`rounded border p-3 ${d.openRecalls.length > 0 ? "border-red-400" : ""}`} data-testid="returns-count-recalls">
              <div className="text-2xl font-semibold tabular-nums">{d.openRecalls.length}</div>
              <div className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.count.recalls")}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" variant="outline" onClick={() => setOpen({ kind: "expiry", preset: "90" })}>
              {t("pharmacyOffice.returns.openExpiry")} <kbd className="ml-1 rounded border px-1 text-xs">E</kbd>
            </Button>
            {canWriteOff && (
              <Button type="button" variant="outline" onClick={() => void openWriteOff()}>
                {t("pharmacyOffice.returns.newWriteOff")} <kbd className="ml-1 rounded border px-1 text-xs">W</kbd>
              </Button>
            )}
            {canRecall && (
              <Button type="button" variant="outline" onClick={() => setOpen({ kind: "newRecall" })}>
                {t("pharmacyOffice.returns.newRecall")} <kbd className="ml-1 rounded border px-1 text-xs">R</kbd>
              </Button>
            )}
            {d.creditPaise > 0 && <span className="text-xs text-muted-foreground" data-testid="returns-credit">{t("pharmacyOffice.returns.creditWaiting", { amount: rupees(d.creditPaise) })}</span>}
          </div>

          {canManage && (
            <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3" data-testid="returns-agent">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
                <span className="flex-1 text-sm">
                  {d.plan.vendors === 0
                    ? t("pharmacyOffice.returns.agent.nothing")
                    : t("pharmacyOffice.returns.agent.can", { vendors: d.plan.vendors, lines: d.plan.lines, amount: rupees(d.plan.taxablePaise) })}
                  {d.plan.toDestroy > 0 && <span className="block text-xs text-muted-foreground">{t("pharmacyOffice.returns.agent.destroy", { count: d.plan.toDestroy, amount: rupees(d.plan.toDestroyValuePaise) })}</span>}
                </span>
                <Button type="button" disabled={d.plan.vendors === 0} onClick={() => setOpen({ kind: "plan" })}>
                  {t("pharmacyOffice.returns.agent.review")} <kbd className="ml-1 rounded border px-1 text-xs">D</kbd>
                </Button>
              </div>
            </section>
          )}

          <div ref={listRef} className="space-y-4">
            <Rows title={t("pharmacyOffice.returns.section.drafts")} testId="returns-section-drafts" rows={d.drafts} render={returnRow} />
            <Rows title={t("pharmacyOffice.returns.section.toDispatch")} testId="returns-section-toDispatch" rows={d.toDispatch} render={returnRow} />
            <Rows title={t("pharmacyOffice.returns.section.awaitingCredit")} testId="returns-section-awaitingCredit" rows={d.awaitingCredit} render={returnRow} />
            <Rows title={t("pharmacyOffice.returns.section.writeOffsToPost")} testId="returns-section-writeOffsToPost" rows={d.writeOffsToPost} render={writeOffRow} />
            <Rows title={t("pharmacyOffice.returns.section.writeOffsAwaiting")} testId="returns-section-writeOffsAwaiting" rows={d.writeOffsAwaiting} render={writeOffRow} />
            <Rows title={t("pharmacyOffice.returns.section.recalls")} testId="returns-section-recalls" rows={d.openRecalls} render={recallRow} />
            {d.drafts.length + d.toDispatch.length + d.awaitingCredit.length + d.writeOffsAwaiting.length + d.writeOffsToPost.length + d.openRecalls.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("pharmacyOffice.returns.empty")}</p>
            )}
          </div>
        </>
      )}

      {open?.kind === "expiry" && <ExpirySheet initial={open.preset} onClose={() => setOpen(null)} onReturn={(id) => setOpen({ kind: "return", id })} />}
      {open?.kind === "plan" && <PlanSheet onClose={() => setOpen(null)} onWriteOff={(c) => setOpen({ kind: "newWriteoff", candidates: c })}
        onMade={(n, first) => { setNotice(t("pharmacyOffice.returns.made", { count: n })); setOpen(first === null ? null : { kind: "return", id: first }); }} />}
      {open?.kind === "return" && <ReturnSheet id={open.id} onClose={() => setOpen(null)} onDone={setNotice} />}
      {open?.kind === "newWriteoff" && <NewWriteOffSheet candidates={open.candidates} onClose={() => setOpen(null)} onRaised={(w) => { setNotice(t("pharmacyOffice.returns.writeOff.raised", { no: w.writeOffNo })); setOpen({ kind: "writeoff", id: w.id }); }} />}
      {open?.kind === "writeoff" && <WriteOffSheet id={open.id} onClose={() => setOpen(null)} onDone={setNotice} />}
      {open?.kind === "newRecall" && <NewRecallSheet onClose={() => setOpen(null)} onRaised={(id, no) => { setNotice(t("pharmacyOffice.returns.recall.raised", { no })); setOpen({ kind: "recall", id }); }} />}
      {open?.kind === "recall" && <RecallSheet id={open.id} onClose={() => setOpen(null)} onReturn={(id) => setOpen({ kind: "return", id })} onDone={setNotice} />}
    </div>
  );
}

function Rows<T>({ title, rows, render, testId }: { title: string; rows: readonly T[]; render: (r: T) => React.ReactElement; testId: string }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="divide-y rounded border">{rows.map((r, i) => <li key={i}>{render(r)}</li>)}</ul>
    </section>
  );
}

async function print(fetchDoc: () => Promise<Parameters<typeof printInFrame>[0]>, onError: (msg: string) => void, failed: string, t: (k: string) => string): Promise<void> {
  try {
    if (!printInFrame(await fetchDoc())) onError(failed);
  } catch (e) { onError(materialsErrorText(e, t)); }
}

// ═══════════════════════════════════ the expiry report ═══════════════════════════════════

/**
 * THE EXPIRY REPORT (Healthray s13/s14): a preset or a custom range, Item-wise or Supplier-wise; qty
 * in packs and base units, MRP, cost value, the supplier (OPENING / TRIAL stock shown as such), the
 * last day it may go back, and the return or write-off raised for it. CSV of the tab on screen.
 */
function ExpirySheet({ initial, onClose, onReturn }: { initial: ExpiryPreset; onClose: () => void; onReturn: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<ExpiryPreset>(initial);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tab, setTab] = useState<"items" | "suppliers">("items");
  const ready = preset !== "custom" || (from !== "" && to !== "");
  const q = useQuery({ queryKey: ["pharmacy", "office", "expiry", preset, from, to], queryFn: () => fetchExpiryReport({ preset, from, to }), enabled: ready });
  const r = q.data;
  const kind = (row: { supplierKind: string; supplierName: string }): string => row.supplierKind === "supplier" ? row.supplierName : t(`pharmacyOffice.returns.supplierKind.${row.supplierKind}`);
  const flag = (row: WireExpiryRow): string => row.returnRaised !== null ? `${row.returnRaised.returnNo} (${t(`pharmacyOffice.returns.status.${row.returnRaised.status}`)})`
    : row.writeOffRaised !== null ? `${row.writeOffRaised.writeOffNo}` : "";
  const exportCsv = (): void => {
    if (r === undefined) return;
    if (tab === "items") {
      downloadCsv(`expiry-${r.preset}-${r.asOf}.csv`, toCsv(
        ["Item", "Code", "Batch", "Expiry", "Days", "Store", "Qty (base)", "Packs", "Loose", "MRP", "MRP per", "Cost value", "Supplier", "Returnable until", "Return / write-off raised"],
        r.rows.map((x) => [x.itemName, x.itemCode, x.batchNo, x.expiryDate, x.daysToExpiry, x.storeCode, x.qtyBase, x.packs, x.loose, x.mrpPaise === null ? "" : csvRupees(x.mrpPaise), x.mrpUom ?? "",
          csvRupees(x.costValuePaise), kind(x), x.returnableUntil ?? "", flag(x)]),
      ));
    } else {
      downloadCsv(`expiry-suppliers-${r.preset}-${r.asOf}.csv`, toCsv(
        ["Supplier", "Batches", "Qty (base)", "Cost value", "Returnable value"],
        r.suppliers.map((s) => [kind(s), s.rows, s.qtyBase, csvRupees(s.costValuePaise), csvRupees(s.returnableValuePaise)]),
      ));
    }
  };
  const rowsTable = (rows: readonly WireExpiryRow[]): React.ReactElement => (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-muted-foreground">
        <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.col.batch")}</th>
        <th className="py-1 pr-2">{t("pharmacyOffice.returns.col.expiry")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th>
        <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.mrp")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.returns.col.cost")}</th>
        {tab === "items" && <th className="py-1 pr-2">{t("pharmacyOffice.returns.col.supplier")}</th>}
        <th className="py-1 pr-2">{t("pharmacyOffice.returns.col.until")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.col.raised")}</th>
      </tr></thead>
      <tbody>
        {rows.map((x) => (
          <tr key={`${x.storeResourceId}-${x.batchId}`} className="border-t" data-testid={`expiry-row-${x.batchNo}`}>
            <td className="py-1 pr-2">{x.itemName} <span className="text-xs text-muted-foreground">{x.itemCode} · {x.storeCode}</span>
              {x.recalled && <span className="ml-1 rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyOffice.returns.recalled")}</span>}</td>
            <td className="py-1 pr-2 font-mono text-xs">{x.batchNo}</td>
            <td className={`py-1 pr-2 text-xs ${x.daysToExpiry < 0 ? "font-medium text-red-700" : x.daysToExpiry <= 30 ? "text-amber-800" : ""}`}>{x.expiryDate}</td>
            <td className="py-1 pr-2 text-right text-xs">{qtyText(x.qtyBase, x.baseUom, x.pack)}<div className="text-muted-foreground">{x.qtyBase} {x.baseUom}</div></td>
            <td className="py-1 pr-2 text-right tabular-nums text-xs">{x.mrpPaise === null ? "—" : `${rupees(x.mrpPaise)}/${x.mrpUom ?? ""}`}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{rupees(x.costValuePaise)}</td>
            {tab === "items" && <td className="py-1 pr-2 text-xs">{kind(x)}</td>}
            <td className="py-1 pr-2 text-xs">{x.returnableUntil ?? (x.supplierKind === "supplier" ? "—" : t("pharmacyOffice.returns.destroyOnly"))}</td>
            <td className="py-1 pr-2 text-xs">
              {x.returnRaised !== null
                ? <button type="button" className="underline" onClick={() => onReturn(x.returnRaised!.returnId)}>{flag(x)}</button>
                : flag(x)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Sheet title={t("pharmacyOffice.returns.expiry.title")} onClose={onClose} testId="expiry-sheet">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-end gap-2" role="tablist" aria-label={t("pharmacyOffice.returns.expiry.presets")}>
          {EXPIRY_PRESETS.map((p) => (
            <Button key={p} type="button" role="tab" aria-selected={p === preset} data-testid={`expiry-preset-${p}`} variant={p === preset ? "default" : "outline"} onClick={() => setPreset(p)}>
              {t(`pharmacyOffice.returns.expiry.preset.${p}`)}
            </Button>
          ))}
          {preset === "custom" && (
            <>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.pay.ledger.from")}<input type="date" aria-label={t("pharmacyOffice.pay.ledger.from")} className="rounded border px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.pay.ledger.to")}<input type="date" aria-label={t("pharmacyOffice.pay.ledger.to")} className="rounded border px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" data-testid="expiry-tab-items" variant={tab === "items" ? "default" : "outline"} onClick={() => setTab("items")}>{t("pharmacyOffice.returns.expiry.itemWise")}</Button>
          <Button type="button" data-testid="expiry-tab-suppliers" variant={tab === "suppliers" ? "default" : "outline"} onClick={() => setTab("suppliers")}>{t("pharmacyOffice.returns.expiry.supplierWise")}</Button>
          <span className="flex-1 text-xs text-muted-foreground">{r === undefined ? "" : t("pharmacyOffice.returns.expiry.summary", { count: r.rows.length, amount: rupees(r.costValuePaise) })}</span>
          <Button type="button" variant="outline" onClick={exportCsv} disabled={r === undefined}>{t("pharmacyOffice.pay.csv")}</Button>
        </div>
        {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
        {r !== undefined && r.rows.length === 0 && <p className="text-muted-foreground">{t("pharmacyOffice.returns.expiry.none")}</p>}
        {r !== undefined && r.rows.length > 0 && (
          <div className="overflow-x-auto" data-testid={tab === "items" ? "expiry-items" : "expiry-suppliers"}>
            {tab === "items" ? rowsTable(r.rows) : r.suppliers.map((s) => (
              <section key={s.vendorId ?? "none"} className="mb-3 rounded border" data-testid={`expiry-supplier-${s.supplierKind === "supplier" ? s.supplierName : s.supplierKind}`}>
                <div className="flex flex-wrap gap-3 bg-muted/40 px-2 py-1 font-medium">
                  <span className="flex-1">{kind(s)}</span>
                  <span className="text-xs">{t("pharmacyOffice.returns.batches", { count: s.rows })}</span>
                  <span className="tabular-nums">{rupees(s.costValuePaise)}</span>
                  <span className="text-xs text-emerald-800">{t("pharmacyOffice.returns.expiry.returnable", { amount: rupees(s.returnableValuePaise) })}</span>
                </div>
                {rowsTable(r.rows.filter((x) => (x.vendorId ?? null) === s.vendorId))}
              </section>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ═══════════════════════════════════ the agent's plan ═══════════════════════════════════

function PlanSheet({ onClose, onMade, onWriteOff }: { onClose: () => void; onMade: (n: number, first: string | null) => void; onWriteOff: (c: WireDestroyCandidate[]) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["pharmacy", "office", "returns", "plan"], queryFn: fetchReturnPlan });
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = plan.data;
  const chosen = (p?.groups ?? []).filter((g) => ticked[g.vendorId] !== false).map((g) => g.vendorId);
  const make = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const drafts = await draftReturns(chosen);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onMade(drafts.length, drafts[0]?.id ?? null);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("pharmacyOffice.returns.plan.title")} onClose={onClose} testId="return-plan-sheet">
      {plan.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(plan.error, t)}</p>}
      {p !== undefined && (
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">{t("pharmacyOffice.returns.plan.intro")}</p>
          {p.groups.map((g) => (
            <section key={g.vendorId} className="rounded border p-2" data-testid={`return-plan-${g.vendorCode}`}>
              <label className="flex items-center gap-3 font-medium">
                <input type="checkbox" checked={ticked[g.vendorId] !== false} onChange={(e) => setTicked((x) => ({ ...x, [g.vendorId]: e.target.checked }))} aria-label={t("pharmacyOffice.returns.plan.include", { vendor: g.vendorName })} />
                <span className="flex-1">{g.vendorName} {g.gstin !== null && <span className="font-mono text-xs text-muted-foreground">{g.gstin}</span>}</span>
                <span className="tabular-nums">{rupees(g.taxablePaise)}</span>
              </label>
              <ul className="mt-1 space-y-0.5">
                {g.lines.map((l) => (
                  <li key={`${l.storeResourceId}-${l.batchId}`} className="flex flex-wrap gap-3">
                    <span className="flex-1">{l.itemName} <span className="text-xs text-muted-foreground">{l.batchNo} · exp {l.expiryDate ?? "—"} · {l.storeCode}</span></span>
                    <span className="text-xs">{t(`pharmacyOffice.returns.reason.${l.reason}`)}</span>
                    <span>{qtyText(l.qtyBase, l.baseUom, l.pack)}</span>
                    <span className="tabular-nums">{rupees(l.taxablePaise)}</span>
                    <span className="text-xs text-muted-foreground">{l.returnableUntil === null ? "" : t("pharmacyOffice.returns.until", { date: l.returnableUntil })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {p.toDestroy.length > 0 && (
            <section className="rounded border border-red-300 p-2" data-testid="return-plan-destroy">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="flex-1 font-medium">{t("pharmacyOffice.returns.plan.destroy", { count: p.toDestroy.length })}</h3>
                {can("materials.writeoffs.manage") && <Button type="button" variant="outline" onClick={() => onWriteOff(p.toDestroy)}>{t("pharmacyOffice.returns.newWriteOff")}</Button>}
              </div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {p.toDestroy.map((x) => (
                  <li key={`${x.storeResourceId}-${x.batchId}`}>{x.itemName} · {x.batchNo} · {x.storeCode} · {x.qtyBase} {x.baseUom} · {rupees(x.valuePaise)} — {t(`pharmacyOffice.returns.why.${x.why}`)}</li>
                ))}
              </ul>
            </section>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" disabled={busy || chosen.length === 0} onClick={() => void make()}>{t("pharmacyOffice.returns.plan.make", { count: chosen.length })}</Button>
            <Button type="button" variant="outline" onClick={onClose}>{t("pharmacyOffice.plan.notNow")}</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ═══════════════════════════════════ the return ═══════════════════════════════════

/**
 * THE RETURN: its lines and GST, and the one act its status allows — approve (A, the head, never
 * the drafter), dispatch (D, never the approver) which issues the debit note, record the vendor's
 * credit note, print (P). Exceptions (cancel, close without credit, cancel the credit) behind ⋯.
 */
function ReturnSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pharmacy", "office", "return", id], queryFn: () => fetchReturn(id) });
  const [credit, setCredit] = useState<{ no: string; date: string; amount: string; reason: string } | null>(null);
  const [more, setMore] = useState(false);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = q.data;
  useEffect(() => {
    if (r !== undefined && credit === null && r.status === "dispatched") setCredit({ no: "", date: todayIst(), amount: (r.totalPaise / 100).toFixed(2), reason: "" });
  }, [r, credit]);
  const act = async (fn: () => Promise<WireReturn>, msg: string, close = false): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = await fn();
      qc.setQueryData(["pharmacy", "office", "return", id], next);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(msg);
      if (close) onClose();
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const me = actor?.id;
  const approvable = r?.status === "draft" && can("materials.returns.approve") && r.createdBy !== me;
  const dispatchable = r?.status === "approved" && can("materials.returns.manage") && r.approvedBy !== me;
  const creditable = r?.status === "dispatched" && can("materials.bills.manage");
  const approve = (): void => void act(() => approveReturn(id), t("pharmacyOffice.returns.sheet.approved"));
  const dispatch = (): void => void act(() => dispatchReturn(id), t("pharmacyOffice.returns.sheet.dispatched"));
  const doPrint = (): void => void print(() => fetchDebitNote(id), setError, t("pharmacyOffice.sheet.printFailed"), t);
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || busy || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "a" && approvable) { e.preventDefault(); approve(); }
    if (k === "d" && dispatchable) { e.preventDefault(); dispatch(); }
    if (k === "p" && r !== undefined) { e.preventDefault(); doPrint(); }
  };
  const short = r !== undefined && credit !== null && toPaise(credit.amount) < r.totalPaise;
  return (
    <Sheet title={r === undefined ? t("pharmacyOffice.sheet.loading") : `${r.debitNoteNo ?? r.returnNo} · ${r.vendorName}`} onClose={onClose} testId="return-sheet" onKey={onKey}>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {r !== undefined && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-1 text-xs ${RETURN_TONE[r.status] ?? ""}`} data-testid="return-status">{t(`pharmacyOffice.returns.status.${r.status}`)}</span>
            <span className="font-mono text-xs">{r.returnNo}</span>
            {r.debitNoteNo !== null && <span className="font-mono text-xs" data-testid="return-debit-note">{t("pharmacyOffice.returns.sheet.debitNote", { no: r.debitNoteNo, date: r.debitNoteDate ?? "" })}</span>}
            {r.recallNo !== null && <span className="rounded bg-red-100 px-1 text-xs text-red-800">{t("pharmacyOffice.returns.sheet.recall", { no: r.recallNo })}</span>}
            <span className="text-xs text-muted-foreground">{r.vendorGstin === null ? "" : `GSTIN ${r.vendorGstin}`} · {r.interState ? "IGST" : "CGST + SGST"}</span>
            <span className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.sheet.draftedBy", { name: r.names[r.createdBy] ?? "" })}</span>
            {r.approvedBy !== null && <span className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.sheet.approvedBy", { name: r.names[r.approvedBy] ?? "" })}</span>}
          </div>
          {r.note !== null && <p className="text-xs text-muted-foreground">{r.note}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="return-lines">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.col.batch")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.returns.col.reason")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.rate")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.taxable")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.gst")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.amount")}</th>
              </tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id} className="border-t" data-testid={`return-line-${l.batchNo}`}>
                    <td className="py-1 pr-2">{l.itemName} <span className="text-xs text-muted-foreground">{l.itemCode} · {l.storeCode}</span></td>
                    <td className="py-1 pr-2 text-xs"><span className="font-mono">{l.batchNo}</span> · {l.expiryDate ?? "—"}</td>
                    <td className="py-1 pr-2 text-xs">{t(`pharmacyOffice.returns.reason.${l.reason}`)}</td>
                    <td className="py-1 pr-2 text-right text-xs">{qtyText(l.qtyBase, l.baseUom, l.pack)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.ratePaise)}/{l.baseUom}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.taxablePaise)}</td>
                    <td className="py-1 pr-2 text-right text-xs">{(l.gstRateBps / 100).toFixed(l.gstRateBps % 100 === 0 ? 0 : 2)}% · {rupees(l.cgstPaise + l.sgstPaise + l.igstPaise)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.totalPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-end gap-6" data-testid="return-totals">
            <span>{t("pharmacyOffice.sheet.taxable")} <b className="tabular-nums">{rupees(r.taxablePaise)}</b></span>
            {r.interState
              ? <span>IGST <b className="tabular-nums">{rupees(r.igstPaise)}</b></span>
              : <><span>CGST <b className="tabular-nums">{rupees(r.cgstPaise)}</b></span><span>SGST <b className="tabular-nums">{rupees(r.sgstPaise)}</b></span></>}
            <span>{t("pharmacyOffice.sheet.total")} <b className="tabular-nums">{rupees(r.totalPaise)}</b></span>
          </div>

          {r.credit !== null && (
            <p className="rounded bg-green-50 p-2 text-green-900" data-testid="return-credit">
              {t("pharmacyOffice.returns.sheet.credited", { no: r.credit.vendorCreditNoteNo, ours: r.credit.creditNo, date: r.credit.creditNoteDate, amount: rupees(r.credit.amountPaise) })}
              {r.credit.differencePaise > 0 && <span className="block text-xs">{t("pharmacyOffice.returns.sheet.short", { amount: rupees(r.credit.differencePaise), reason: r.credit.differenceReason ?? "" })}</span>}
            </p>
          )}
          {r.closeReason !== null && <p className="rounded bg-slate-100 p-2">{t("pharmacyOffice.returns.sheet.closedWhy", { reason: r.closeReason })}</p>}

          {creditable && credit !== null && (
            <div className="space-y-2 rounded border p-2" data-testid="return-credit-form">
              <h3 className="font-medium">{t("pharmacyOffice.returns.sheet.recordCredit")}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.sheet.creditNo")}
                  <input className="w-40 rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.sheet.creditNo")} value={credit.no} onChange={(e) => setCredit({ ...credit, no: e.target.value })} /></label>
                <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.sheet.creditDate")}
                  <input type="date" className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.sheet.creditDate")} value={credit.date} onChange={(e) => setCredit({ ...credit, date: e.target.value })} /></label>
                <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.sheet.creditAmount")}
                  <input className="w-28 rounded border px-2 py-1 text-right" inputMode="decimal" aria-label={t("pharmacyOffice.returns.sheet.creditAmount")} value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} /></label>
                {short && (
                  <label className="flex flex-1 flex-col gap-1 text-xs">{t("pharmacyOffice.returns.sheet.shortReason", { amount: rupees(r.totalPaise - toPaise(credit.amount)) })}
                    <input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.sheet.shortReasonLabel")} value={credit.reason} onChange={(e) => setCredit({ ...credit, reason: e.target.value })} /></label>
                )}
                <Button type="button" disabled={busy || credit.no.trim() === "" || (short && credit.reason.trim() === "")}
                  onClick={() => void act(() => recordCredit(id, { vendorCreditNoteNo: credit.no.trim(), creditNoteDate: credit.date, amountPaise: toPaise(credit.amount), differenceReason: short ? credit.reason.trim() : null }), t("pharmacyOffice.returns.sheet.creditRecorded"))}>
                  {t("pharmacyOffice.returns.sheet.saveCredit")}
                </Button>
              </div>
              {short && !can("materials.bills.accept_difference") && <p className="text-xs text-amber-800">{t("pharmacyOffice.returns.sheet.shortNeedsHead")}</p>}
            </div>
          )}

          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {approvable && <Button type="button" disabled={busy} onClick={approve}>{t("pharmacyOffice.returns.sheet.approve")} <kbd className="ml-1 rounded border px-1 text-xs">A</kbd></Button>}
            {r.status === "draft" && !approvable && <span className="text-muted-foreground">{t(r.createdBy === me ? "pharmacyOffice.returns.sheet.notYourApproval" : "pharmacyOffice.returns.sheet.waitingHead")}</span>}
            {dispatchable && <Button type="button" disabled={busy} onClick={dispatch}>{t("pharmacyOffice.returns.sheet.dispatch")} <kbd className="ml-1 rounded border px-1 text-xs">D</kbd></Button>}
            {r.status === "approved" && r.approvedBy === me && <span className="text-muted-foreground">{t("pharmacyOffice.returns.sheet.notYourDispatch")}</span>}
            <Button type="button" variant="outline" onClick={doPrint}>{t(r.debitNoteNo === null ? "pharmacyOffice.returns.sheet.printReturn" : "pharmacyOffice.returns.sheet.printDebit")} <kbd className="ml-1 rounded border px-1 text-xs">P</kbd></Button>
            {["draft", "approved", "dispatched", "credited"].includes(r.status) && <Button type="button" variant="ghost" aria-label={t("pharmacyOffice.sheet.more")} onClick={() => setMore((m) => !m)}>⋯</Button>}
          </div>
          {more && (
            <div className="flex flex-wrap items-center gap-2 rounded border p-2" data-testid="return-more">
              <input className="flex-1 rounded border px-2 py-1" placeholder={t("pharmacyOffice.returns.sheet.why")} aria-label={t("pharmacyOffice.returns.sheet.why")} value={why} onChange={(e) => setWhy(e.target.value)} />
              {(r.status === "draft" || r.status === "approved") && can("materials.returns.manage") && (
                <Button type="button" variant="outline" disabled={busy || why.trim() === ""} onClick={() => void act(() => cancelReturn(id, why.trim()), t("pharmacyOffice.returns.sheet.cancelled"), true)}>{t("pharmacyOffice.returns.sheet.cancel")}</Button>
              )}
              {r.status === "dispatched" && can("materials.bills.accept_difference") && (
                <Button type="button" variant="outline" disabled={busy || why.trim() === ""} onClick={() => void act(() => closeReturn(id, why.trim()), t("pharmacyOffice.returns.sheet.closed"))}>{t("pharmacyOffice.returns.sheet.close")}</Button>
              )}
              {r.status === "credited" && can("materials.bills.manage") && (
                <Button type="button" variant="outline" disabled={busy || why.trim() === ""} onClick={() => void act(() => cancelCredit(id, why.trim()), t("pharmacyOffice.returns.sheet.creditCancelled"))}>{t("pharmacyOffice.returns.sheet.cancelCredit")}</Button>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ═══════════════════════════════════ destruction ═══════════════════════════════════

/**
 * A NEW DESTRUCTION WRITE-OFF: the agent's "cannot go back" list for one store, ticked and counted,
 * the reason, and (if already known) the disposal agency and its manifest. Sent to the MS.
 */
function NewWriteOffSheet({ candidates, onClose, onRaised }: { candidates: WireDestroyCandidate[]; onClose: () => void; onRaised: (w: WireWriteOff) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stores = [...new Map(candidates.map((c) => [c.storeResourceId, { id: c.storeResourceId, name: c.storeName, code: c.storeCode }])).values()];
  const [store, setStore] = useState(stores[0]?.id ?? "");
  const [reason, setReason] = useState<WriteOffReason>("expiry");
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(candidates.map((c) => [`${c.storeResourceId}|${c.batchId}`, String(c.qtyBase)])));
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [disposal, setDisposal] = useState({ agency: "", manifest: "", date: "" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = candidates.filter((c) => c.storeResourceId === store);
  const key = (c: WireDestroyCandidate): string => `${c.storeResourceId}|${c.batchId}`;
  const chosen = mine.filter((c) => on[key(c)] !== false && Number(qty[key(c)] ?? "0") > 0);
  const raise = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const w = await raiseWriteOff({
        storeResourceId: store, reason, note: note.trim() === "" ? null : note.trim(),
        lines: chosen.map((c) => ({ batchId: c.batchId, qtyBase: Math.round(Number(qty[key(c)] ?? "0")) })),
        disposal: { disposalAgency: disposal.agency.trim() || null, manifestNo: disposal.manifest.trim() || null, disposalDate: disposal.date || null },
      });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onRaised(w);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("pharmacyOffice.returns.writeOff.newTitle")} onClose={onClose} testId="new-writeoff-sheet">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("pharmacyOffice.returns.writeOff.intro")}</p>
        {candidates.length === 0 ? <p>{t("pharmacyOffice.returns.writeOff.nothing")}</p> : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.store")}
                <select className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.store")} value={store} onChange={(e) => setStore(e.target.value)}>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                </select></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.col.reason")}
                <select className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.col.reason")} value={reason} onChange={(e) => setReason(e.target.value as WriteOffReason)}>
                  {(["expiry", "damage", "recall"] as const).map((r) => <option key={r} value={r}>{t(`pharmacyOffice.returns.writeOff.reason.${r}`)}</option>)}
                </select></label>
            </div>
            <table className="w-full text-sm" data-testid="new-writeoff-lines">
              <tbody>
                {mine.map((c) => (
                  <tr key={key(c)} className="border-t">
                    <td className="py-1 pr-2"><input type="checkbox" checked={on[key(c)] !== false} aria-label={t("pharmacyOffice.returns.writeOff.include", { batch: c.batchNo })} onChange={(e) => setOn((x) => ({ ...x, [key(c)]: e.target.checked }))} /></td>
                    <td className="py-1 pr-2">{c.itemName} <span className="text-xs text-muted-foreground">{c.batchNo} · exp {c.expiryDate ?? "—"} · {c.supplierName}</span></td>
                    <td className="py-1 pr-2 text-xs">{t(`pharmacyOffice.returns.why.${c.why}`)}</td>
                    <td className="py-1 pr-2 text-right"><input className="w-20 rounded border px-1 text-right" inputMode="numeric" aria-label={t("pharmacyOffice.returns.writeOff.qtyFor", { batch: c.batchNo })} value={qty[key(c)] ?? ""} onChange={(e) => setQty((x) => ({ ...x, [key(c)]: e.target.value }))} /> {c.baseUom}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{rupees(c.valuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.agency")}<input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.agency")} value={disposal.agency} onChange={(e) => setDisposal({ ...disposal, agency: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.manifest")}<input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.manifest")} value={disposal.manifest} onChange={(e) => setDisposal({ ...disposal, manifest: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.date")}<input type="date" className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.date")} value={disposal.date} onChange={(e) => setDisposal({ ...disposal, date: e.target.value })} /></label>
            </div>
            <input className="w-full rounded border px-2 py-1" placeholder={t("pharmacyOffice.returns.writeOff.note")} aria-label={t("pharmacyOffice.returns.writeOff.note")} value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
        {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || chosen.length === 0} onClick={() => void raise()}>{t("pharmacyOffice.returns.writeOff.send")}</Button>
          <Button type="button" variant="outline" onClick={onClose}>{t("pharmacyOffice.plan.notNow")}</Button>
        </div>
      </div>
    </Sheet>
  );
}

/** A WRITE-OFF: its lines, the MS's decision, and — once granted — the handover with the manifest. */
function WriteOffSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pharmacy", "office", "writeoff", id], queryFn: () => fetchWriteOff(id) });
  const [disposal, setDisposal] = useState<{ agency: string; manifest: string; date: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const w = q.data;
  useEffect(() => {
    if (w !== undefined && disposal === null) setDisposal({ agency: w.disposalAgency ?? "", manifest: w.manifestNo ?? "", date: w.disposalDate ?? todayIst() });
  }, [w, disposal]);
  const post = async (): Promise<void> => {
    if (disposal === null) return;
    setBusy(true); setError(null);
    try {
      const next = await postWriteOff(id, { disposalAgency: disposal.agency.trim() || null, manifestNo: disposal.manifest.trim() || null, disposalDate: disposal.date || null });
      qc.setQueryData(["pharmacy", "office", "writeoff", id], next);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(t("pharmacyOffice.returns.writeOff.posted", { no: next.writeOffNo }));
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const granted = w?.status === "requested" && w.approvalStatus === "granted";
  return (
    <Sheet title={w === undefined ? t("pharmacyOffice.sheet.loading") : `${w.writeOffNo} · ${w.storeName}`} onClose={onClose} testId="writeoff-sheet">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {w !== undefined && disposal !== null && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded bg-amber-100 px-1 text-xs text-amber-900" data-testid="writeoff-status">{t(`pharmacyOffice.returns.writeOff.status.${w.status}`)}</span>
            <span className="text-xs">{t(`pharmacyOffice.returns.writeOff.reason.${w.reason}`)}</span>
            <span className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.writeOff.approvalIs", { status: t(`pharmacyOffice.returns.approval.${w.approvalStatus}`, { defaultValue: w.approvalStatus }) })}</span>
            {w.approval?.decisionNote != null && <span className="text-xs text-muted-foreground">“{w.approval.decisionNote}”</span>}
          </div>
          <table className="w-full text-sm" data-testid="writeoff-lines">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.col.batch")}</th>
              <th className="py-1 pr-2">{t("pharmacyOffice.returns.col.expiry")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th>
              <th className="py-1 pr-2 text-right">{t("pharmacyOffice.returns.col.cost")}</th>
            </tr></thead>
            <tbody>
              {w.lines.map((l) => (
                <tr key={l.id} className="border-t"><td className="py-1 pr-2">{l.itemName}</td><td className="py-1 pr-2 font-mono text-xs">{l.batchNo}</td>
                  <td className="py-1 pr-2 text-xs">{l.expiryDate ?? "—"}</td><td className="py-1 pr-2 text-right">{l.qtyBase} {l.baseUom}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.valuePaise)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end">{t("pharmacyOffice.sheet.total")} <b className="ml-2 tabular-nums">{rupees(w.totalValuePaise)}</b></div>
          {w.status === "posted" && (
            <p className="rounded bg-green-50 p-2 text-green-900" data-testid="writeoff-posted">
              {t("pharmacyOffice.returns.writeOff.handedOver", { agency: w.disposalAgency ?? "", manifest: w.manifestNo ?? "", date: w.disposalDate ?? "" })}
            </p>
          )}
          {w.status === "requested" && w.approvalStatus === "pending" && <p className="text-muted-foreground">{t("pharmacyOffice.returns.writeOff.waitingMs")}</p>}
          {granted && can("materials.writeoffs.manage") && (
            <div className="flex flex-wrap items-end gap-2 rounded border p-2" data-testid="writeoff-handover">
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.agency")}<input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.agency")} value={disposal.agency} onChange={(e) => setDisposal({ ...disposal, agency: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.manifest")}<input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.manifest")} value={disposal.manifest} onChange={(e) => setDisposal({ ...disposal, manifest: e.target.value })} /></label>
              <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.writeOff.date")}<input type="date" className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.writeOff.date")} value={disposal.date} onChange={(e) => setDisposal({ ...disposal, date: e.target.value })} /></label>
              <Button type="button" disabled={busy || disposal.agency.trim() === "" || disposal.manifest.trim() === "" || disposal.date === ""} onClick={() => void post()}>{t("pharmacyOffice.returns.writeOff.post")}</Button>
            </div>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <Button type="button" variant="outline" onClick={() => void print(() => fetchManifest(id), setError, t("pharmacyOffice.sheet.printFailed"), t)}>{t("pharmacyOffice.returns.writeOff.print")}</Button>
        </div>
      )}
    </Sheet>
  );
}

// ═══════════════════════════════════ recalls ═══════════════════════════════════

/** A NEW RECALL: find the item, pick the batch, say which alert and why. One press freezes it everywhere. */
function NewRecallSheet({ onClose, onRaised }: { onClose: () => void; onRaised: (id: string, no: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState("");
  const [source, setSource] = useState<RecallSource>("cdsco");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const found = useQuery({ queryKey: ["pharmacy", "office", "recall-items", search], queryFn: () => fetchItems({ search }), enabled: search.trim().length >= 2 });
  const batches = useQuery({ queryKey: ["pharmacy", "office", "recall-batches", itemId], queryFn: () => fetchRecallBatches(itemId!), enabled: itemId !== null });
  const raise = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const { recall } = await raiseRecall({ batchId, source, reference: reference.trim() || null, reason: reason.trim() });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onRaised(recall.id, recall.recallNo);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("pharmacyOffice.returns.recall.newTitle")} onClose={onClose} testId="new-recall-sheet">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("pharmacyOffice.returns.recall.intro")}</p>
        <input className="w-full rounded border px-2 py-1" placeholder={t("pharmacyOffice.returns.recall.findItem")} aria-label={t("pharmacyOffice.returns.recall.findItem")} value={search} onChange={(e) => { setSearch(e.target.value); setItemId(null); setBatchId(""); }} />
        {itemId === null && (found.data ?? []).length > 0 && (
          <ul className="divide-y rounded border">
            {(found.data ?? []).slice(0, 12).map((i) => (
              <li key={i.id}><button type="button" className={rowCls} onClick={() => setItemId(i.id)}>{i.name} <span className="text-xs text-muted-foreground">{i.code}</span></button></li>
            ))}
          </ul>
        )}
        {itemId !== null && (
          <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.col.batch")}
            <select className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.col.batch")} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">—</option>
              {(batches.data ?? []).map((b) => <option key={b.batchId} value={b.batchId} disabled={b.recalled}>{b.batchNo} · exp {b.expiryDate ?? "—"} · {b.onHand} · {b.supplierName ?? "—"}{b.recalled ? ` (${t("pharmacyOffice.returns.recalled")})` : ""}</option>)}
            </select></label>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.recall.sourceLabel")}
            <select className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.recall.sourceLabel")} value={source} onChange={(e) => setSource(e.target.value as RecallSource)}>
              {RECALL_SOURCES.map((s) => <option key={s} value={s}>{t(`pharmacyOffice.returns.recall.source.${s}`)}</option>)}
            </select></label>
          <label className="flex flex-col gap-1 text-xs">{t("pharmacyOffice.returns.recall.reference")}<input className="rounded border px-2 py-1" aria-label={t("pharmacyOffice.returns.recall.reference")} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        </div>
        <input className="w-full rounded border px-2 py-1" placeholder={t("pharmacyOffice.returns.recall.reason")} aria-label={t("pharmacyOffice.returns.recall.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || batchId === "" || reason.trim() === ""} onClick={() => void raise()}>{t("pharmacyOffice.returns.recall.freeze")}</Button>
          <Button type="button" variant="outline" onClick={onClose}>{t("pharmacyOffice.plan.notNow")}</Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * A RECALL: where the batch still sits, who it was dispensed to (READ-ONLY — names and phone numbers
 * for the callback, logged as a PHI read), its return and write-off, one tap to draft the return.
 */
function RecallSheet({ id, onClose, onReturn, onDone }: { id: string; onClose: () => void; onReturn: (id: string) => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pharmacy", "office", "recall", id], queryFn: () => fetchRecall(id) });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const r = q.data;
  const toReturn = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const ret = await returnFromRecall(id);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(t("pharmacyOffice.returns.recall.returnDrafted", { no: ret.returnNo }));
      onReturn(ret.id);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const close = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = await closeRecall(id, note.trim());
      qc.setQueryData(["pharmacy", "office", "recall", id], { ...r, ...next });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(t("pharmacyOffice.returns.recall.closed", { no: next.recallNo }));
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={r === undefined ? t("pharmacyOffice.sheet.loading") : `${r.recallNo} · ${r.itemName} · ${r.batchNo}`} onClose={onClose} testId="recall-sheet">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {r !== undefined && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-1 text-xs ${r.status === "open" ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"}`} data-testid="recall-status">{t(`pharmacyOffice.returns.recall.status.${r.status}`)}</span>
            <span className="text-xs">{t(`pharmacyOffice.returns.recall.source.${r.source}`)}{r.reference === null ? "" : ` · ${r.reference}`}</span>
            <span className="text-xs text-muted-foreground">{r.reason}</span>
            <span className="text-xs text-muted-foreground">{r.supplierName ?? "—"}</span>
          </div>
          <section data-testid="recall-locations">
            <h3 className="font-medium">{t("pharmacyOffice.returns.recall.where")}</h3>
            {r.locations.length === 0 ? <p className="text-muted-foreground">{t("pharmacyOffice.returns.recall.nowhere")}</p> : (
              <ul className="text-xs">{r.locations.map((l) => <li key={l.storeResourceId}>{l.storeName} ({l.storeCode}) — {l.onHand} · {t("pharmacyOffice.returns.recall.frozen", { count: l.frozen })}</li>)}</ul>
            )}
          </section>
          <section data-testid="recall-dispensed">
            <h3 className="font-medium">{t("pharmacyOffice.returns.recall.dispensedTo", { count: r.dispensed.length })}</h3>
            <p className="text-xs text-muted-foreground">{t("pharmacyOffice.returns.recall.readOnly")}</p>
            {r.dispensed.length > 0 && (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">{t("pharmacyOffice.returns.recall.when")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.recall.patient")}</th><th className="py-1 pr-2">UHID</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.recall.phone")}</th><th className="py-1 pr-2">{t("pharmacyOffice.returns.recall.visit")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th></tr></thead>
                <tbody>
                  {r.dispensed.map((x) => {
                    const p = x.patientId === null ? undefined : r.patients?.[x.patientId];
                    return (
                      <tr key={x.ledgerEntryId} className="border-t">
                        <td className="py-1 pr-2">{x.occurredAt.slice(0, 10)}</td>
                        <td className="py-1 pr-2">{p?.restricted === true ? t("pharmacyOffice.returns.recall.restricted") : (p?.name ?? "—")}</td>
                        <td className="py-1 pr-2 font-mono">{p?.uhid ?? "—"}</td>
                        <td className="py-1 pr-2">{p?.phone ?? "—"}</td>
                        <td className="py-1 pr-2 font-mono">{x.encounterId ?? "—"}</td>
                        <td className="py-1 pr-2 text-right">{x.qtyBase}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          {(r.returns.length > 0 || r.writeOffs.length > 0) && (
            <p className="text-xs">
              {r.returns.map((x) => <button key={x.returnId} type="button" className="mr-2 underline" onClick={() => onReturn(x.returnId)}>{x.returnNo} · {t(`pharmacyOffice.returns.status.${x.status}`, { defaultValue: x.status })} · {x.qtyBase}</button>)}
              {r.writeOffs.map((x) => <span key={x.writeOffId} className="mr-2">{x.writeOffNo} · {x.status} · {x.qtyBase}</span>)}
            </p>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {r.status === "open" && (
            <div className="flex flex-wrap items-center gap-2">
              {can("materials.returns.manage") && r.onHand > 0 && r.supplierKind === "supplier" && (
                <Button type="button" disabled={busy} onClick={() => void toReturn()}>{t("pharmacyOffice.returns.recall.toReturn")}</Button>
              )}
              {r.onHand === 0 && can("materials.recall.manage") && (
                <>
                  <input className="flex-1 rounded border px-2 py-1" placeholder={t("pharmacyOffice.returns.recall.closeNote")} aria-label={t("pharmacyOffice.returns.recall.closeNote")} value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void close()}>{t("pharmacyOffice.returns.recall.close")}</Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
