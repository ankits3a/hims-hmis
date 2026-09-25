import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { useScreenKeys } from "../../lib/keyboard";
import { materialsErrorText } from "../../lib/materials-api";
import { printInFrame } from "../../lib/print-api";
import {
  cancelPurchaseOrder, decidePurchaseOrder, draftOrders, fetchOfficeToday, fetchPoDocument, fetchPurchasePlan,
  fetchPurchaseOrder, fetchPurchaseVendors, rupees, sendPurchaseOrder, submitPurchaseOrder, updatePurchaseOrder,
} from "../../lib/purchase-api";
import { Button } from "@/components/ui/button";
import { PayView } from "./pay";
import { Sheet } from "./sheet";
import type { WireOfficeToday, WirePo, WirePoSummary } from "../../lib/purchase-api";

/**
 * ═══ PHARMACY PARITY P2 — THE BACK OFFICE ═══
 *
 * One screen (the Desk One pattern): it opens on what needs this person today — orders awaiting
 * their approval, drafts to review, orders overdue, orders waiting on somebody else, orders to
 * receive, and the counter's open shortages — and every row opens its sheet. The agent's card says
 * what it would draft and a person presses the button; nothing is submitted, approved or sent by
 * anybody but a person.
 *
 * Keys: ↑/↓ move between orders, ⏎ opens one; on the sheet A approves and R rejects (when the order
 * is this person's to decide), Esc closes. Exceptions (cancel) sit behind ⋯.
 */
type Section = { key: keyof Pick<WireOfficeToday, "awaitingYou" | "drafts" | "overdue" | "waiting" | "toReceive">; rows: WirePoSummary[] };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", pending_approval: "bg-amber-100 text-amber-900", approved: "bg-sky-100 text-sky-900",
  sent: "bg-indigo-100 text-indigo-900", part_received: "bg-violet-100 text-violet-900", received: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
};

export function PharmacyOffice(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  // PARITY P3 — the office's two halves: buying (P2) and paying. `?view=pay` opens on the second —
  // the copilot's payment-run card links there.
  const canPay = can("materials.bills.manage");
  const [view, setView] = useState<"buy" | "pay">(() => (new URLSearchParams(window.location.search).get("view") === "pay" ? "pay" : "buy"));
  const paying = view === "pay" && canPay;
  const today = useQuery({ queryKey: ["pharmacy", "office"], queryFn: fetchOfficeToday, enabled: !paying });
  // PARITY P3 — the shell's legend shows the office's keys, not the front desk's.
  useScreenKeys([t(paying ? "pharmacyOffice.keys.pay" : "pharmacyOffice.keys.buy")]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const d = today.data;
  const sections: Section[] = d === undefined ? [] : [
    { key: "awaitingYou", rows: d.awaitingYou },
    { key: "drafts", rows: d.drafts },
    { key: "overdue", rows: d.overdue },
    { key: "waiting", rows: d.waiting },
    { key: "toReceive", rows: d.toReceive.filter((p) => !d.overdue.some((o) => o.id === p.id)) },
  ];
  const mineToDecide = new Set(d?.awaitingYou.map((p) => p.id) ?? []);

  /* ↑/↓ walk the order rows; ⏎ is the row button's own. */
  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-po-row]") ?? []);
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[i < 0 ? 0 : next]?.focus();
    e.preventDefault();
  };

  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{t("pharmacyOffice.title")}</h1>
        <span className="text-sm text-muted-foreground">{t("pharmacyOffice.subtitle")}</span>
        {canPay && (
          <div className="ml-auto flex gap-1" role="tablist" aria-label={t("pharmacyOffice.views")}>
            {(["buy", "pay"] as const).map((v) => (
              <Button key={v} type="button" role="tab" aria-selected={(v === "pay") === paying} data-testid={`office-view-${v}`} variant={(v === "pay") === paying ? "default" : "outline"} onClick={() => setView(v)}>
                {t(`pharmacyOffice.view.${v}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      {paying ? <PayView /> : (<>
      {today.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(today.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}

      {d !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="office-counts">
            {([
              ["awaitingYou", d.awaitingYou.length], ["drafts", d.drafts.length], ["overdue", d.overdue.length],
              ["waiting", d.waiting.length], ["toReceive", d.toReceive.length], ["shortages", d.shortages.length],
            ] as const).map(([k, n]) => (
              <div key={k} className={`rounded border p-3 ${n > 0 && (k === "awaitingYou" || k === "overdue") ? "border-amber-400" : ""}`} data-testid={`count-${k}`}>
                <div className="text-2xl font-semibold tabular-nums">{n}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.count.${k}`)}</div>
              </div>
            ))}
          </div>

          <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3" data-testid="office-agent">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
              <span className="flex-1 text-sm">
                {d.plan.orders + d.plan.unassigned === 0
                  ? t("pharmacyOffice.agent.nothing", { drafted: d.plan.alreadyDrafted })
                  : t("pharmacyOffice.agent.can", { orders: d.plan.orders, lines: d.plan.lines, unassigned: d.plan.unassigned })}
                {d.plan.unmatched > 0 && <span className="block text-xs text-muted-foreground">{t("pharmacyOffice.agent.unmatched", { count: d.plan.unmatched })}</span>}
              </span>
              <Button type="button" disabled={d.plan.orders + d.plan.unassigned === 0} onClick={() => setPlanOpen(true)}>
                {t("pharmacyOffice.agent.review")}
              </Button>
            </div>
          </section>

          <div ref={listRef} onKeyDown={onListKey} className="space-y-4">
            {sections.filter((s) => s.rows.length > 0).map((s) => (
              <section key={s.key} data-testid={`section-${s.key}`}>
                <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t(`pharmacyOffice.count.${s.key}`)}</h2>
                <ul className="divide-y rounded border">
                  {s.rows.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button" data-po-row data-testid={`po-row-${p.poNo}`}
                        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                        onClick={() => setOpenId(p.id)}
                      >
                        <span className="font-mono text-xs">{p.poNo}</span>
                        <span className="flex-1 font-medium">{p.vendorName}</span>
                        {p.source === "agent" && <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.agent.drafted")}</span>}
                        <span className="text-xs text-muted-foreground">{t("pharmacyOffice.lines", { count: p.lineCount })}</span>
                        <span className="tabular-nums">{rupees(p.totalPaise)}</span>
                        <span className="text-xs text-muted-foreground">{p.expectedDate ?? ""}</span>
                        <span className={`rounded px-1 text-xs ${STATUS_TONE[p.status] ?? ""}`}>{t(`pharmacyOffice.status.${p.status}`)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {sections.every((s) => s.rows.length === 0) && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.empty")}</p>}
          </div>

          {d.shortages.length > 0 && (
            <p className="text-sm">
              {t("pharmacyOffice.shortages", { count: d.shortages.length })}{" "}
              <Link to="/pharmacy/reorder" className="underline">{t("pharmacyOffice.openReorder")}</Link>
            </p>
          )}
        </>
      )}

      {openId !== null && (
        <PoSheet id={openId} canDecide={mineToDecide.has(openId)} onClose={() => setOpenId(null)} onDone={setNotice} />
      )}
      {planOpen && (
        <PlanSheet
          onClose={() => setPlanOpen(false)}
          onMade={(n, first) => { setPlanOpen(false); setNotice(t("pharmacyOffice.agent.made", { count: n })); if (first !== null) setOpenId(first); }}
        />
      )}
      </>)}
    </div>
  );
}

type EditLine = { itemId: string; name: string; code: string; uom: string; multiplier: number; qty: string; free: string; rate: string; gst: string; mrp: string };

const toPaise = (rupeesText: string): number => Math.round(Number(rupeesText || "0") * 100);
const toRupees = (paise: number | null): string => paise === null ? "" : (paise / 100).toFixed(2);

function editable(po: WirePo): EditLine[] {
  return po.lines.map((l) => ({
    itemId: l.itemId, name: l.itemName, code: l.itemCode, uom: l.uom, multiplier: l.multiplier,
    qty: String(l.qtyPacks), free: String(l.freePacks), rate: toRupees(l.ratePaise), gst: String(l.gstRateBps / 100), mrp: toRupees(l.mrpPaise),
  }));
}

/**
 * THE PURCHASE ORDER SHEET: its lines, its totals, and the one or two acts its status allows. A
 * draft's lines are typed in place; everything else reads.
 */
function PoSheet({ id, canDecide, onClose, onDone }: { id: string; canDecide: boolean; onClose: () => void; onDone: (msg: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const po = useQuery({ queryKey: ["pharmacy", "office", "po", id], queryFn: () => fetchPurchaseOrder(id) });
  const [lines, setLines] = useState<EditLine[] | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [more, setMore] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);

  const p = po.data;
  useEffect(() => { if (p !== undefined && lines === null) { setLines(editable(p)); setExpected(p.expectedDate ?? ""); } }, [p, lines]);
  const raiser = can("materials.po.raise");
  const isDraft = p?.status === "draft" && raiser;
  const decidable = p?.status === "pending_approval" && canDecide;

  const act = async (fn: () => Promise<WirePo | void>, message: string, close = false): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = await fn();
      if (next !== undefined) { qc.setQueryData(["pharmacy", "office", "po", id], next); setLines(editable(next)); }
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(message);
      if (close) onClose();
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<WirePo> => updatePurchaseOrder(id, {
    expectedDate: expected === "" ? null : expected,
    lines: (lines ?? []).map((l) => ({
      itemId: l.itemId, uom: l.uom, qtyPacks: Number(l.qty || "0"), freePacks: Number(l.free || "0"),
      ratePaise: toPaise(l.rate), gstRateBps: Math.round(Number(l.gst || "0") * 100), mrpPaise: l.mrp === "" ? null : toPaise(l.mrp),
    })),
  });
  const approve = (): void => void act(() => decidePurchaseOrder(id, "approve", note.trim() === "" ? t("pharmacyOffice.sheet.approvedNote") : note.trim()), t("pharmacyOffice.sheet.approved"), true);
  const reject = (): void => {
    if (!rejecting) { setRejecting(true); setTimeout(() => noteRef.current?.focus(), 0); return; }
    if (note.trim() === "") { setError(t("pharmacyOffice.sheet.reasonNeeded")); return; }
    void act(() => decidePurchaseOrder(id, "reject", note.trim()), t("pharmacyOffice.sheet.rejected"), true);
  };
  const print = async (): Promise<void> => {
    setError(null);
    try {
      if (!printInFrame(await fetchPoDocument(id))) setError(t("pharmacyOffice.sheet.printFailed"));
    } catch (e) { setError(materialsErrorText(e, t)); }
  };

  /* A / R on the sheet — never while typing in a field. */
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA";
    if (typing || busy || !decidable || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "a" || e.key === "A") { e.preventDefault(); approve(); }
    if (e.key === "r" || e.key === "R") { e.preventDefault(); reject(); }
  };

  const set = (i: number, patch: Partial<EditLine>): void => setLines((prev) => (prev ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const liveTotal = (lines ?? []).reduce((s, l) => {
    const line = Number(l.qty || "0") * toPaise(l.rate);
    return s + line + Math.floor((line * Math.round(Number(l.gst || "0") * 100) + 5_000) / 10_000);
  }, 0);

  return (
    <Sheet title={p === undefined ? t("pharmacyOffice.sheet.loading") : `${p.poNo} · ${p.vendorName}`} onClose={onClose} testId="po-sheet" onKey={onKey}>
      <div className="space-y-3">
        {po.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(po.error, t)}</p>}
        {p !== undefined && lines !== null && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={`rounded px-1 text-xs ${STATUS_TONE[p.status] ?? ""}`} data-testid="po-status">{t(`pharmacyOffice.status.${p.status}`)}</span>
              <span>{t("pharmacyOffice.sheet.store", { store: p.storeName })}</span>
              <label className="flex items-center gap-1">
                {t("pharmacyOffice.sheet.expected")}
                {isDraft
                  ? <input type="date" className="rounded border px-1" value={expected ?? ""} onChange={(e) => setExpected(e.target.value)} />
                  : <span>{p.expectedDate ?? "—"}</span>}
              </label>
              {p.approvalTier !== null && <span className="text-xs text-muted-foreground">{t(`pharmacyOffice.sheet.tier_${p.approvalTier}`)}</span>}
              {p.source === "agent" && <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t("pharmacyOffice.agent.drafted")}</span>}
            </div>
            {p.rejectionNote !== null && p.status === "draft" && (
              <p className="rounded bg-red-50 p-2 text-sm text-red-800" data-testid="po-rejection">{t("pharmacyOffice.sheet.wasRejected", { note: p.rejectionNote })}</p>
            )}
            {p.note !== null && <p className="text-xs text-muted-foreground">{p.note}</p>}

            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="po-lines">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-2">{t("pharmacyOffice.sheet.item")}</th>
                    <th className="py-1 pr-2">{t("pharmacyOffice.sheet.pack")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.qty")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.free")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.rate")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.gst")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.mrp")}</th>
                    <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.amount")}</th>
                    {!isDraft && <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.received")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const src = p.lines[i];
                    const cell = (k: "qty" | "free" | "rate" | "gst" | "mrp", w = "w-16"): React.ReactElement => isDraft
                      ? <input aria-label={`${t(`pharmacyOffice.sheet.${k}`)} ${l.code}`} className={`${w} rounded border px-1 text-right`} inputMode="decimal" value={l[k]} onChange={(e) => set(i, { [k]: e.target.value })} />
                      : <span>{l[k]}</span>;
                    return (
                      <tr key={l.itemId} data-testid={`po-line-${l.code}`} className="border-t">
                        <td className="py-1 pr-2">{l.name} <span className="text-xs text-muted-foreground">{l.code}</span></td>
                        <td className="py-1 pr-2 text-xs">{l.uom} × {l.multiplier}</td>
                        <td className="py-1 pr-2 text-right">{cell("qty", "w-14")}</td>
                        <td className="py-1 pr-2 text-right">{cell("free", "w-12")}</td>
                        <td className="py-1 pr-2 text-right">{cell("rate", "w-20")}</td>
                        <td className="py-1 pr-2 text-right">{cell("gst", "w-12")}</td>
                        <td className="py-1 pr-2 text-right">{cell("mrp", "w-20")}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{rupees(Number(l.qty || "0") * toPaise(l.rate))}</td>
                        {!isDraft && src !== undefined && (
                          <td className="py-1 pr-2 text-right text-xs">{src.receivedBase}/{src.orderedBase} {src.baseUom}</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-6 text-sm" data-testid="po-totals">
              {isDraft
                ? <span>{t("pharmacyOffice.sheet.total")} <b className="tabular-nums">{rupees(liveTotal)}</b></span>
                : (<>
                  <span>{t("pharmacyOffice.sheet.taxable")} <b className="tabular-nums">{rupees(p.subtotalPaise)}</b></span>
                  <span>GST <b className="tabular-nums">{rupees(p.gstPaise)}</b></span>
                  <span>{t("pharmacyOffice.sheet.total")} <b className="tabular-nums">{rupees(p.totalPaise)}</b></span>
                </>)}
            </div>

            {(decidable || rejecting) && (
              <input
                ref={noteRef} className="w-full rounded border px-2 py-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={rejecting ? t("pharmacyOffice.sheet.rejectReason") : t("pharmacyOffice.sheet.approveNote")}
                aria-label={rejecting ? t("pharmacyOffice.sheet.rejectReason") : t("pharmacyOffice.sheet.approveNote")}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (rejecting) reject(); else approve(); } }}
              />
            )}
            {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}

            <div className="flex flex-wrap items-center gap-2">
              {isDraft && (
                <>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void act(save, t("pharmacyOffice.sheet.saved"))}>{t("pharmacyOffice.sheet.save")}</Button>
                  <Button type="button" disabled={busy} onClick={() => void act(async () => { await save(); return submitPurchaseOrder(id); }, t("pharmacyOffice.sheet.submitted"), true)}>
                    {t("pharmacyOffice.sheet.submit")}
                  </Button>
                </>
              )}
              {decidable && (
                <>
                  <Button type="button" disabled={busy} onClick={approve}>{t("pharmacyOffice.sheet.approve")} <kbd className="ml-1 rounded border px-1 text-xs">A</kbd></Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={reject}>{t("pharmacyOffice.sheet.reject")} <kbd className="ml-1 rounded border px-1 text-xs">R</kbd></Button>
                </>
              )}
              {p.status === "pending_approval" && !canDecide && <span className="text-sm text-muted-foreground">{t(`pharmacyOffice.sheet.waitingOn_${p.approvalTier ?? "head"}`)}</span>}
              {p.status === "approved" && raiser && (
                <Button type="button" disabled={busy} onClick={() => void act(() => sendPurchaseOrder(id), t("pharmacyOffice.sheet.sent"))}>{t("pharmacyOffice.sheet.send")}</Button>
              )}
              {(p.status === "sent" || p.status === "part_received" || p.status === "approved") && (
                <Link to="/materials/grn" className="text-sm underline">{t("pharmacyOffice.sheet.receive")}</Link>
              )}
              <Button type="button" variant="outline" onClick={() => void print()}>{t("pharmacyOffice.sheet.print")}</Button>
              {raiser && ["draft", "pending_approval", "approved", "sent"].includes(p.status) && (
                <Button type="button" variant="ghost" aria-label={t("pharmacyOffice.sheet.more")} onClick={() => setMore((m) => !m)}>⋯</Button>
              )}
            </div>
            {more && (
              <div className="flex flex-wrap items-center gap-2 rounded border p-2" data-testid="po-more">
                <input className="flex-1 rounded border px-2 py-1 text-sm" placeholder={t("pharmacyOffice.sheet.cancelReason")} aria-label={t("pharmacyOffice.sheet.cancelReason")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                <Button type="button" variant="outline" disabled={busy || cancelReason.trim() === ""} onClick={() => void act(() => cancelPurchaseOrder(id, cancelReason.trim()), t("pharmacyOffice.sheet.cancelled"), true)}>
                  {t("pharmacyOffice.sheet.cancel")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * THE AGENT'S PLAN, reviewed: one order per last supplier, the items nobody has supplied waiting for
 * a vendor, the drugs the stores do not carry. "Make the drafts" writes DRAFTS; each is then opened,
 * checked and submitted like any other.
 */
function PlanSheet({ onClose, onMade }: { onClose: () => void; onMade: (n: number, firstId: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["pharmacy", "office", "plan"], queryFn: fetchPurchasePlan });
  const vendors = useQuery({ queryKey: ["pharmacy", "office", "vendors"], queryFn: fetchPurchaseVendors });
  const [assign, setAssign] = useState<Record<string, { vendorId: string; rate: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const chosen = Object.entries(assign).filter(([, a]) => a.vendorId !== "")
        .map(([itemId, a]) => ({ itemId, vendorId: a.vendorId, ...(a.rate === "" ? {} : { ratePaise: Math.round(Number(a.rate) * 100) }) }));
      const { drafts } = await draftOrders(chosen);
      await qc.invalidateQueries({ queryKey: ["pharmacy"] });
      onMade(drafts.length, drafts[0]?.id ?? null);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const pl = plan.data;
  return (
    <Sheet title={t("pharmacyOffice.plan.title")} onClose={onClose} testId="plan-sheet">
      {plan.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(plan.error, t)}</p>}
      {pl !== undefined && (
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">{t("pharmacyOffice.plan.intro", { date: pl.expectedDate })}</p>
          {pl.groups.map((g) => (
            <section key={g.vendorId} className="rounded border p-2" data-testid={`plan-${g.vendorCode}`}>
              <div className="flex gap-3 font-medium"><span className="flex-1">{g.vendorName}</span><span className="tabular-nums">{rupees(g.totalPaise)}</span></div>
              <ul className="mt-1 space-y-0.5">
                {g.lines.map((l) => (
                  <li key={l.itemId} className="flex gap-3">
                    <span className="flex-1">{l.name} <span className="text-xs text-muted-foreground">{l.code}</span></span>
                    <span>{l.qtyPacks} {l.uom}</span>
                    <span className="tabular-nums">{rupees(l.ratePaise)}</span>
                    <span className="text-xs text-muted-foreground">{l.reasons.map((r) => t(`pharmacyOffice.plan.reason_${r}`)).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {pl.unassigned.length > 0 && (
            <section className="rounded border border-amber-400 p-2" data-testid="plan-unassigned">
              <h3 className="font-medium">{t("pharmacyOffice.plan.unassigned")}</h3>
              <ul className="mt-1 space-y-1">
                {pl.unassigned.map((u) => (
                  <li key={u.itemId} className="flex flex-wrap items-center gap-2">
                    <span className="flex-1">{u.name} · {u.qtyPacks} {u.uom} <span className="text-xs text-muted-foreground">{t(`pharmacyOffice.plan.why_${u.why}`)}</span></span>
                    <select
                      aria-label={t("pharmacyOffice.plan.vendorFor", { code: u.code })} className="rounded border px-1"
                      value={assign[u.itemId]?.vendorId ?? ""}
                      onChange={(e) => setAssign((a) => ({ ...a, [u.itemId]: { vendorId: e.target.value, rate: a[u.itemId]?.rate ?? "" } }))}
                    >
                      <option value="">{t("pharmacyOffice.plan.leaveOut")}</option>
                      {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <input
                      aria-label={t("pharmacyOffice.plan.rateFor", { code: u.code })} className="w-20 rounded border px-1 text-right" inputMode="decimal"
                      placeholder={t("pharmacyOffice.plan.rate")} value={assign[u.itemId]?.rate ?? ""}
                      onChange={(e) => setAssign((a) => ({ ...a, [u.itemId]: { vendorId: a[u.itemId]?.vendorId ?? "", rate: e.target.value } }))}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {pl.unmatched.length > 0 && (
            <p className="text-xs text-muted-foreground">{t("pharmacyOffice.plan.notStocked", { names: pl.unmatched.map((u) => u.drugName).join(", ") })}</p>
          )}
          {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={() => void make()}>{t("pharmacyOffice.plan.make")}</Button>
            <Button type="button" variant="outline" onClick={onClose}>{t("pharmacyOffice.plan.notNow")}</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
