import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  cancelGrn, captureGrn, fetchDiscrepancies, fetchExpiring, fetchGrn, fetchGrns, fetchItem, fetchItems, fetchMaterialsSettings, fetchStores,
  fetchVendors, materialsErrorText, postGrn, requestMrpRevision, requestNearExpiry, runGrnQc,
} from "../lib/materials-api";
import { useAuth } from "../lib/auth";
import { fetchPurchaseOrders, fetchReceivable, rupees } from "../lib/purchase-api";
import { expiryFromLabel } from "../../../../packages/contracts/src/drug-expiry";
import { Button } from "@/components/ui/button";
import { OpeningStockSheet } from "./materials-grn-opening";
import { NewButton, OfficeHead, fieldCls, useNewKey } from "./pharmacy-office/office-page";
import { PriceCheckNote, priceAnswered } from "./pharmacy-office/price-check-note";
import { Sheet } from "./pharmacy-office/sheet";
import { ApiError } from "../lib/api";
import type { WirePriceCheck } from "../lib/stock-entry-api";
import type { CaptureLineInput, WireGrn } from "../lib/materials-api";

/**
 * PLAN 14 T9 / DD16 — **THE GRN GATE, keyboard-first, and the reason it is a screen at all.**
 *
 * The owner ruled it in: *"the mini-OT's first consignment challan is received on the GRN gate."*
 * A lorry is waiting, so the flow is typed and not clicked — vendor → source → store → lines →
 * QC verdict per line → post.
 *
 * ═══ THE RULE CODE IS RENDERED AS ITS LOCALE STRING, NEVER RAW ═══
 *
 * `qcLine` returns a `RuleCode` — `mrp_below_cost`, `near_expiry`, `agreement_missing` — and the
 * server sends it on the line as `rejectReason`. **The screen renders `t("materialsGrn.rule_<code>")`.**
 * A storekeeper reading `mrp_below_cost` off a screen learns nothing they can act on; "the MRP is
 * below the landed cost — check the price or the pack size" is the same fact in a form that names
 * the next step. That is why the codes are a closed union and not free text.
 *
 * ═══ NOTHING ON THIS SCREEN MOVES STOCK UNTIL `post` ═══
 *
 * Capture writes the paperwork, QC writes the verdicts, and POST is the only button that touches
 * the ledger — which mirrors `grn.ts` exactly, and is what lets a storekeeper capture a delivery at
 * the gate and leave the verdict to the pharmacist without anything being committed in between.
 *
 * ═══ THE TWO WORKLISTS SIT UNDER THE DELIVERIES (DD16, gap-closure B5) ═══
 *
 * `expiring` and `discrepancy` transfers are read routes with tables, not screens of their own —
 * the owner's ruling, and the reason there is no Lane-2 generator to make them cheaply. They were a
 * second tab; the office board has no tabs ("one list, no filter tabs"), so they are groups of the
 * same page, under the deliveries. Receiving a delivery is a sheet (N), and so is an opened GRN.
 */

type DraftLine = {
  itemId: string; uom: string; qtyInUom: string;
  /** A medicine's is typed as its label prints it, MM/YY; any other class's is the date picker's YYYY-MM-DD. */
  batchNo: string; expiryDate: string;
  mrpRupees: string; mrpUom: string; costRupees: string; freeGoods: boolean;
  /** B5 — what the supplier's bill says one pack costs. A helper only: it fills `costRupees`, and is never sent. */
  packRupees: string;
  /**
   * #1061 — the server's price check, from its `price_reason_required` refusal: the line is more than 2% above the
   * item's last paid receipt or the supplier's contract rate, and the next capture sends the reason chosen here.
   */
  priceCheck: WirePriceCheck | null; priceReason: string; priceReasonText: string;
};

const emptyLine = (): DraftLine => ({
  itemId: "", uom: "", qtyInUom: "", batchNo: "", expiryDate: "",
  mrpRupees: "", mrpUom: "", costRupees: "", freeGoods: false, packRupees: "",
  priceCheck: null, priceReason: "", priceReasonText: "",
});

/** Rupees typed by a human → integer paise (DD7). The ONE place this screen converts money. */
function toPaise(rupees: string): number | null {
  const trimmed = rupees.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** A GRN's state as the board's pill: waiting on a person is gold, posted is pine, refused is red. */
function grnPill(status: string): string {
  if (status === "posted") return "pill on";
  if (status === "rejected" || status === "cancelled") return "pill rd";
  return "pill gd";
}

export function MaterialsGrn(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  /* B5 — the capture form is a sheet over the list. */
  const [receiving, setReceiving] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [source, setSource] = useState("challan");
  const [storeId, setStoreId] = useState("");
  const [challanNo, setChallanNo] = useState("");
  const [challanDate, setChallanDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  /* PARITY P2 — the order this delivery is received against: picking one fills the lines. */
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [openGrnId, setOpenGrnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const vendors = useQuery({ queryKey: ["materials", "vendors"], queryFn: () => fetchVendors({ status: "active" }) });
  const stores = useQuery({ queryKey: ["materials", "stores"], queryFn: fetchStores });
  const items = useQuery({ queryKey: ["materials", "items"], queryFn: () => fetchItems({}) });
  const grns = useQuery({ queryKey: ["materials", "grns"], queryFn: fetchGrns });
  /*
   * OWNER RULING 2026-09-30 — the two-person GRN setting (Stock → Stores settings). OFF (the default):
   * nothing is blocked, and a GRN checked by the person who captured it says so. ON: the server refuses
   * the capturer, so the sheet says who must act instead of offering buttons that will be refused.
   */
  const settings = useQuery({ queryKey: ["materials", "settings"], queryFn: fetchMaterialsSettings });
  const auth = useAuth();
  const me = auth.actor?.id ?? null;
  const twoPerson = settings.data?.grnQcNeedsSecondPerson === true;
  /**
   * Checked by its capturer — once QC has happened. Walk 2026-11-13: it used to say so before QC too (the capturer
   * having it open), which read as a check that had not happened.
   */
  const selfChecked = (g: WireGrn): boolean => g.qcBy !== null && g.qcBy === g.capturedBy;
  const capturerBlocked = (g: WireGrn): boolean => twoPerson && me !== null && me === g.capturedBy && g.status !== "posted" && g.status !== "rejected";
  const orders = useQuery({
    queryKey: ["materials", "purchase-orders", "receivable", vendorId],
    queryFn: () => fetchPurchaseOrders({ vendorId, status: ["approved", "sent", "part_received"] }),
    enabled: vendorId !== "",
  });
  const pickOrder = (id: string): void => void run(async () => {
    setPurchaseOrderId(id);
    if (id === "") return;
    const r = await fetchReceivable(id);
    setStoreId(r.purchaseOrder.storeResourceId);
    setSource("challan");
    setLines(r.lines.map((l) => ({
      ...emptyLine(), itemId: l.itemId, uom: l.uom, qtyInUom: String(l.remainingPacks),
      costRupees: (l.unitCostPaise / 100).toFixed(2),
      ...(l.mrpPaise === null ? {} : { mrpRupees: (l.mrpPaise / 100).toFixed(2), mrpUom: l.uom }),
    })));
  }, t("materialsGrn.po.prefilled", { poNo: orders.data?.find((o) => o.id === id)?.poNo ?? "" }));
  const openGrn = useQuery({
    queryKey: ["materials", "grn", openGrnId],
    queryFn: () => fetchGrn(openGrnId as string),
    enabled: openGrnId !== null,
  });
  const expiring = useQuery({
    queryKey: ["materials", "expiring"], queryFn: fetchExpiring,
  });
  const discrepancies = useQuery({
    queryKey: ["materials", "discrepancies"], queryFn: fetchDiscrepancies,
  });

  const run = async (fn: () => Promise<void>, message: string): Promise<void> => {
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(message);
      await qc.invalidateQueries({ queryKey: ["materials"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };

  const setLine = (i: number, patch: Partial<DraftLine>): void => {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  /**
   * 2026-11-13 — a medicine's expiry is a MONTH: its label prints MM/YYYY and means the month's last day, which is
   * what the opening sheet stores. Its field takes MM/YY (as the stock-entry grid does) and sends that month's last
   * day, through the one rule both sides share; a reagent, a consumable or an implant keeps its date picker and day.
   */
  const expiryIsAMonth = (itemId: string): boolean => (items.data ?? []).find((x) => x.id === itemId)?.class === "drug";
  const sentExpiry = (l: DraftLine): string | null => {
    const typed = l.expiryDate.trim();
    if (typed === "" || !expiryIsAMonth(l.itemId)) return typed;
    return expiryFromLabel(typed);
  };

  const capture = (): void => void run(async () => {
    const chosen = lines.filter((l) => l.itemId !== "" && l.qtyInUom.trim() !== "");
    const unreadable = chosen.find((l) => sentExpiry(l) === null);
    if (unreadable !== undefined) throw new Error(t("materialsGrn.expiryMonthUnreadable", { typed: unreadable.expiryDate.trim() }));
    const payload: CaptureLineInput[] = chosen
      .map((l) => ({
        itemId: l.itemId, uom: l.uom.trim(), qtyInUom: Number(l.qtyInUom),
        ...(l.batchNo.trim() === "" ? {} : { batchNo: l.batchNo.trim() }),
        ...(sentExpiry(l) === "" ? {} : { expiryDate: sentExpiry(l)! }),
        ...(toPaise(l.mrpRupees) === null ? {} : { mrpPaise: toPaise(l.mrpRupees), mrpUom: l.mrpUom.trim() }),
        // Free goods are a zero-cost line with FULL batch discipline (DD8), never a discount.
        unitCostPaise: l.freeGoods ? 0 : (toPaise(l.costRupees) ?? 0),
        ...(l.freeGoods ? { freeGoods: true } : {}),
        ...(priceAnswered(l.priceReason, l.priceReasonText) ? { priceReason: { code: l.priceReason, text: l.priceReasonText.trim() || null } } : {}),
      }));
    let captured: { grnId: string; grnNo: string };
    try {
      captured = await captureGrn({
        vendorId, source, storeResourceId: storeId,
        challanNo: challanNo.trim(), challanDate: challanDate.trim(),
        ...(purchaseOrderId === "" ? {} : { purchaseOrderId }),
        lines: payload,
      });
    } catch (e) {
      // #1061 — the refusal names each amber line (its index in what was sent) with its check: shown under the line.
      const body = e instanceof ApiError ? e.body as { code?: string; detail?: { lines?: { index: number; check: WirePriceCheck }[] } } : null;
      if (body?.code === "price_reason_required") {
        const amber = new Map((body.detail?.lines ?? []).map((x) => [chosen[x.index], x.check] as const));
        setLines((prev) => prev.map((l) => (amber.has(l) ? { ...l, priceCheck: amber.get(l) ?? null } : l)));
      }
      throw e;
    }
    const { grnId, grnNo } = captured;
    setPurchaseOrderId("");
    setReceiving(false);
    setOpenGrnId(grnId);
    setLines([emptyLine()]);
    setChallanNo("");
    setDone(t("materialsGrn.captured", { grnNo }));
  }, t("materialsGrn.capturedGeneric"));

  const grn: WireGrn | undefined = openGrn.data;
  const hasNearExpiry = grn?.lines.some((l) => l.nearExpiry) === true;
  // #1047 — the same batch at a new MRP: the post waits for the materials head's MRP approval.
  const hasMrpRevised = grn?.lines.some((l) => l.mrpRevised === true) === true;
  // #1047 — a captured GRN may be cancelled with a reason until it posts.
  const [cancelling, setCancelling] = useState(false);
  const [cancelWhy, setCancelWhy] = useState("");
  const isOpen = grn !== undefined && grn.status !== "posted" && grn.status !== "cancelled";
  /** The opened GRN's columns; each cell carries its column's name for the phone's stacked line. */
  const cols = [
    t("materialsGrn.item"), t("materialsGrn.qtyBase"), t("materialsGrn.batchNo"), t("materialsGrn.expiry"), t("materialsGrn.mrp"),
    t("materialsGrn.cost"), t("materialsGrn.verdict"),
  ];
  /** Captured and not yet through QC: every line's verdict is still to come, whatever its fields say. */
  const awaitingQc = grn?.status === "gate_qc" || grn?.status === "draft";
  /** An older server's list carries no supplier name: the code of an active one, else nothing to show. */
  const vendorCode = (id: string): string => (vendors.data ?? []).find((v) => v.id === id)?.code ?? "";
  const itemLabel = (itemId: string): string => {
    const it = (items.data ?? []).find((i) => i.id === itemId);
    return it === undefined ? itemId : `${it.code} · ${it.name}`;
  };

  /*
   * The walk of 2026-09-30 / B5 — a line's Unit and "MRP per" are PICKED from the item's own units
   * (its base unit and its packs), never typed: a typed "Strip" or "stp" is a unit the item does not
   * have. The item's detail carries its packs; one read per item chosen on the sheet.
   */
  const chosenIds = [...new Set(lines.map((l) => l.itemId).filter((id) => id !== ""))];
  const details = useQueries({
    queries: chosenIds.map((id) => ({ queryKey: ["materials", "item", id], queryFn: () => fetchItem(id) })),
  });
  const baseOf = (itemId: string): string | null => (items.data ?? []).find((x) => x.id === itemId)?.baseUom ?? null;
  const unitsOf = (itemId: string, keep: string[]): { uom: string; mult: number | null }[] => {
    const base = baseOf(itemId);
    const packs = details[chosenIds.indexOf(itemId)]?.data?.uoms ?? [];
    const out: { uom: string; mult: number | null }[] = base === null ? [] : [{ uom: base, mult: 1 }];
    for (const u of packs) if (!out.some((o) => o.uom === u.uom)) out.push({ uom: u.uom, mult: u.toBaseMultiplier });
    // A unit already on the line (an order's pack) stays choosable even before the item's packs arrive.
    for (const k of keep) if (k !== "" && !out.some((o) => o.uom === k)) out.push({ uom: k, mult: null });
    return out;
  };
  const unitLabel = (u: { uom: string; mult: number | null }, base: string | null): string =>
    (u.mult !== null && u.mult > 1 && base !== null ? `${u.uom} (${String(u.mult)} ${base})` : u.uom);
  /** A pack price typed on the bill → the cost of ONE base unit, to the paisa (DD7: the server still gets per base unit). */
  const fromPack = (pack: string, mult: number): string => {
    const n = Number(pack);
    return pack.trim() === "" || !Number.isFinite(n) ? "" : (n / mult).toFixed(2);
  };

  /* B5 — ONE list of deliveries: what still needs a hand (QC, post) first, then the settled ones. */
  const settled = (st: string): boolean => st === "posted" || st === "rejected";
  const deliveries = [...(grns.data ?? [])].sort((a, b) => Number(settled(a.status)) - Number(settled(b.status)));
  const openCapture = (): void => { setError(null); setDone(null); setReceiving(true); };
  useNewKey(openCapture);
  const sheetOpen = receiving || (grn !== undefined && openGrnId !== null);
  const feedback = (
    <>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}
    </>
  );

  return (
    <div className="space-y-4" data-testid="materials-grn">
      <OfficeHead title={t("materialsGrn.title")} lead={t("materialsGrn.lead")}>
        <NewButton label={t("materialsGrn.newGrn")} onClick={openCapture} testId="grn-new" />
      </OfficeHead>

      {!sheetOpen && feedback}

      <div className="ofp-box">
        <section data-testid="grn-deliveries">
          <h2 className="ofp-group ofp-label">{t("materialsGrn.recent")} · {grns.data?.length ?? "…"}</h2>
          {grns.data !== undefined && deliveries.length === 0 && <p className="ofp-empty">{t("materialsGrn.noGrns")}</p>}
          {deliveries.length > 0 && (
            <ul className="ofp-rows">
              {deliveries.map((g) => (
                <li key={g.id} className={settled(g.status) ? "text-muted-foreground" : ""}>
                  <button type="button" className="ofp-code underline" onClick={() => { setError(null); setDone(null); setOpenGrnId(g.id); }}>
                    {g.grnNo}
                  </button>
                  <span className={grnPill(g.status)}>{t(`materialsGrn.status_${g.status}`, { defaultValue: g.status })}</span>
                  {/* Walk 2026-11-13 — which delivery it is: the supplier, its invoice (else challan) and its value. */}
                  <span data-testid={`grn-vendor-${g.id}`}>{g.vendorName ?? vendorCode(g.vendorId)}</span>
                  <span className="text-xs text-muted-foreground">
                    {g.invoiceNo !== null ? t("materialsGrn.listInvoice", { no: g.invoiceNo }) : t("materialsGrn.listChallan", { no: g.challanNo })}
                  </span>
                  {selfChecked(g) && (
                    <span className="text-xs text-amber-800" data-testid={`grn-self-checked-${g.id}`}>{t("materialsGrn.sameCapturer")}</span>
                  )}
                  {g.valuePaise !== undefined && (
                    <span className="ml-auto tabular-nums" data-testid={`grn-value-${g.id}`}>{t("materialsGrn.listValue", { amount: rupees(g.valuePaise) })}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-testid="grn-expiring">
          <h2 className="ofp-group ofp-label">{t("materialsGrn.expiringTitle")} · {expiring.data?.length ?? "…"}</h2>
          {expiring.data !== undefined && expiring.data.length === 0 && <p className="ofp-empty">{t("materialsGrn.nothingExpiring")}</p>}
          {(expiring.data ?? []).length > 0 && (
            <ul className="ofp-rows">
              {[...(expiring.data ?? [])].sort((a, b) => a.daysRemaining - b.daysRemaining).map((b) => (
                <li key={b.batchId}>
                  <span className="ofp-code">{b.batchNo}</span>
                  <span className={b.daysRemaining <= 30 ? "pill rd" : "pill gd"}>{t("materialsGrn.daysRemaining", { days: b.daysRemaining })}</span>
                  <span>{t("materialsGrn.onHand", { qty: b.qtyOnHandTotal })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-testid="grn-discrepancies">
          <h2 className="ofp-group ofp-label">{t("materialsGrn.discrepancyTitle")} · {discrepancies.data?.length ?? "…"}</h2>
          {discrepancies.data !== undefined && discrepancies.data.length === 0 && <p className="ofp-empty">{t("materialsGrn.noDiscrepancies")}</p>}
          {(discrepancies.data ?? []).length > 0 && (
            <ul className="ofp-rows">
              {(discrepancies.data ?? []).map((tr) => (
                <li key={tr.id} className="text-red-700">
                  {tr.id} · {t("materialsGrn.shortLines", { count: tr.lines.filter((l) => l.discrepancyReason !== null).length })}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* GAP CLOSURE A1 — the pharmacist's opening-stock sheet lands here as GRNs awaiting QC. */}
      <OpeningStockSheet onOpenGrn={setOpenGrnId} />

      {receiving && (
        <Sheet title={t("materialsGrn.newGrn")} testId="grn-capture-sheet" onClose={() => setReceiving(false)}>
          <div className="space-y-3" data-testid="grn-capture">
            {feedback}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.vendor")}
                <select className={fieldCls} value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPurchaseOrderId(""); }}>
                  <option value="">—</option>
                  {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.po.label")}
                <select
                  className={fieldCls} value={purchaseOrderId} disabled={vendorId === ""}
                  onChange={(e) => pickOrder(e.target.value)}
                >
                  <option value="">{t("materialsGrn.po.none")}</option>
                  {(orders.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.poNo} · {o.expectedDate ?? ""}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.source")}
                <select className={fieldCls} value={source} onChange={(e) => setSource(e.target.value)}>
                  {["challan", "consignment_challan", "donation"]
                    .map((s) => <option key={s} value={s}>{t(`materialsGrn.source_${s}`)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.store")}
                <select className={fieldCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  <option value="">—</option>
                  {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.challanNo")}
                <input className={fieldCls} value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.challanDate")}
                <input type="date" className={fieldCls} value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
              </label>
            </div>

            <h3 className="text-sm font-medium">{t("materialsGrn.lines")}</h3>
            {lines.map((l, i) => {
              const base = baseOf(l.itemId);
              const units = unitsOf(l.itemId, [l.uom, l.mrpUom]);
              const pack = units.find((u) => u.uom === l.uom);
              const mult = pack?.mult != null && pack.mult > 1 ? pack.mult : null;
              const costNum = Number(l.costRupees);
              return (
              <div key={i} className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.item")}
                  <select
                    className={fieldCls} value={l.itemId}
                    onChange={(e) => setLine(i, {
                      itemId: e.target.value, uom: "", mrpUom: "", packRupees: "",
                      // A month typed for a medicine is not a date for a reagent, nor the other way round.
                      ...(expiryIsAMonth(e.target.value) === expiryIsAMonth(l.itemId) ? {} : { expiryDate: "" }),
                    })}
                  >
                    <option value="">—</option>
                    {(items.data ?? []).map((it) => <option key={it.id} value={it.id}>{`${it.code} · ${it.name}`}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.uom")}
                  <select className={fieldCls} value={l.uom} disabled={l.itemId === ""} onChange={(e) => setLine(i, { uom: e.target.value, packRupees: "" })}>
                    <option value="">—</option>
                    {units.map((u) => <option key={u.uom} value={u.uom}>{unitLabel(u, base)}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.qty")}
                  <input
                    className={fieldCls} inputMode="numeric" value={l.qtyInUom}
                    onChange={(e) => setLine(i, { qtyInUom: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.batchNo")}
                  <input className={fieldCls} value={l.batchNo} onChange={(e) => setLine(i, { batchNo: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.expiry")}
                  {expiryIsAMonth(l.itemId)
                    ? <input className={fieldCls} placeholder="MM/YY" inputMode="numeric" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
                    : <input type="date" className={fieldCls} value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />}
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrp")}
                  <input className={fieldCls} inputMode="decimal" value={l.mrpRupees} onChange={(e) => setLine(i, { mrpRupees: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrpUom")}
                  <select className={fieldCls} value={l.mrpUom} disabled={l.itemId === ""} onChange={(e) => setLine(i, { mrpUom: e.target.value })}>
                    <option value="">—</option>
                    {units.map((u) => <option key={u.uom} value={u.uom}>{unitLabel(u, base)}</option>)}
                  </select>
                </label>
                {/* B5 — where people type the strip's price. The field says in words that it is ONE base unit, the
                    pack price (when the unit is a pack) fills it, and the line under it shows what a pack then costs. */}
                <div className="flex flex-col gap-1 text-xs">
                  {mult !== null && !l.freeGoods && (
                    <label className="flex flex-col gap-1">
                      {t("materialsGrn.packPrice", { pack: l.uom })}
                      <input
                        className={fieldCls} inputMode="decimal" value={l.packRupees}
                        onChange={(e) => setLine(i, { packRupees: e.target.value, costRupees: fromPack(e.target.value, mult) })}
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    {t("materialsGrn.costPer", { unit: base ?? t("materialsGrn.baseUnit") })}
                    <input
                      className={fieldCls} inputMode="decimal" value={l.costRupees}
                      disabled={l.freeGoods}
                      onChange={(e) => setLine(i, { costRupees: e.target.value, packRupees: "" })}
                    />
                  </label>
                  {mult !== null && !l.freeGoods && l.costRupees.trim() !== "" && Number.isFinite(costNum) && (
                    <span className="text-muted-foreground" data-testid={`grn-line-${String(i)}-per-pack`}>
                      {t("materialsGrn.perPack", { cost: (costNum * mult).toFixed(2), pack: l.uom, mult, unit: base ?? "" })}
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox" checked={l.freeGoods}
                    onChange={(e) => setLine(i, { freeGoods: e.target.checked })}
                  />
                  {t("materialsGrn.freeGoods")}
                </label>
                {l.priceCheck !== null && (
                  <div className="sm:col-span-full">
                    <PriceCheckNote
                      check={l.priceCheck} index={i} reason={l.priceReason} reasonText={l.priceReasonText}
                      onReason={(p) => setLine(i, { ...(p.priceReason === undefined ? {} : { priceReason: p.priceReason }), ...(p.priceReasonText === undefined ? {} : { priceReasonText: p.priceReasonText }) })}
                    />
                  </div>
                )}
              </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setLines((p) => [...p, emptyLine()])}>
                {t("materialsGrn.addLine")}
              </Button>
              <Button onClick={capture}>{t("materialsGrn.capture")}</Button>
            </div>
          </div>
        </Sheet>
      )}

      {grn !== undefined && openGrnId !== null && !receiving && (
        <Sheet title={grn.grnNo} testId="grn-sheet" onClose={() => { setOpenGrnId(null); setCancelling(false); }}>
            <div className="space-y-3" data-testid="grn-open">
              {feedback}
              <p className="flex flex-wrap items-center gap-2">
                <span className={grnPill(grn.status)}>{t(`materialsGrn.status_${grn.status}`, { defaultValue: grn.status })}</span>
                {selfChecked(grn) && <span className="text-xs text-amber-800" data-testid="grn-open-self-checked">{t("materialsGrn.sameCapturer")}</span>}
                {grn.invoiceNo !== null && (
                  <span className="text-xs text-muted-foreground" data-testid="grn-open-invoice">
                    {t("materialsGrn.invoiceLine", { no: grn.invoiceNo, date: grn.invoiceDate ?? grn.challanDate })}
                  </span>
                )}
              </p>
              {grn.status === "cancelled" && (
                <p role="note" className="text-sm text-red-700" data-testid="grn-cancelled">{t("materialsGrn.cancelledWhy", { reason: grn.cancelReason ?? "" })}</p>
              )}
              {capturerBlocked(grn) && <p role="note" className="text-sm text-amber-800" data-testid="grn-capturer-blocked">{t("materialsGrn.capturerMayNotCheck")}</p>}
              {/* Walk 2026-11-13 — on a phone the table cut off expiry, MRP, cost and verdict: below 640 px each line
                  stacks, every cell under its column's name (`data-label`, office-page.css `.grn-lines`). */}
              <div className="ofp-box ofp-scroll">
              <table className="ofp-table grn-lines min-w-[48rem]">
                <thead>
                  <tr>
                    {cols.map((c) => <th key={c}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {grn.lines.map((l) => (
                    <tr key={l.id}>
                      {/* The walk of 2026-09-30: the person running QC holds the strip against THIS row, so it
                          names the drug and carries what QC checks — never an id, never a verdict before QC. */}
                      <td data-label={cols[0]}>{itemLabel(l.itemId)}</td>
                      <td data-label={cols[1]}>{l.qtyBase}</td>
                      <td data-label={cols[2]}>{l.batchNo ?? "—"}</td>
                      <td data-label={cols[3]} className="whitespace-nowrap">{l.expiryDate ?? "—"}</td>
                      <td data-label={cols[4]} className="whitespace-nowrap">{l.mrpPaise === null ? "—" : `₹${(l.mrpPaise / 100).toFixed(2)}${l.mrpUom === null ? "" : ` / ${l.mrpUom}`}`}</td>
                      <td data-label={cols[5]} className="whitespace-nowrap">
                        {`₹${(l.unitCostPaise / 100).toFixed(2)}`}
                        {/* #1047 / 0093 — an opening row with no rate is costed at the estimate; the grid said so, and so does the GRN (walk 2026-11-13). */}
                        {l.estimatedCost === true ? <span className="ml-1 text-xs text-amber-800" data-testid="grn-line-estimated">{t("materialsGrn.costEstimated")}</span> : null}
                      </td>
                      <td data-label={cols[6]}>
                        {/* THE RULE, AS A SENTENCE. Never the raw code — see the header. A cancelled GRN's lines carry
                            no verdict (walk 2026-11-13: they read "Accepted" although nobody had checked them). */}
                        {grn.status === "cancelled"
                          ? <span className="text-neutral-600">{t("materialsGrn.status_cancelled")}</span>
                          : awaitingQc
                          ? <span className="text-neutral-600">{t("materialsGrn.status_gate_qc")}</span>
                          : l.rejectReason !== null
                          ? <span className="text-red-600">{t(`materialsGrn.rule_${l.rejectReason}`)}</span>
                          : l.nearExpiry || l.mrpRevised === true
                            ? <span className="text-amber-700">{[
                                ...(l.nearExpiry ? [t("materialsGrn.rule_near_expiry")] : []),
                                ...(l.mrpRevised === true ? [t("materialsGrn.rule_mrp_revised")] : []),
                              ].join(" · ")}</span>
                            : <span className="text-green-700">{t("materialsGrn.verdictPass")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {isOpen && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={capturerBlocked(grn)} onClick={() => void run(
                  async () => { await runGrnQc(grn.id); }, t("materialsGrn.qcDone"),
                )}>
                  {t("materialsGrn.runQc")}
                </Button>
                {hasNearExpiry && (
                  <Button variant="outline" onClick={() => void run(
                    async () => { await requestNearExpiry(grn.id); }, t("materialsGrn.approvalRequested"),
                  )}>
                    {t("materialsGrn.requestNearExpiry")}
                  </Button>
                )}
                {hasMrpRevised && (
                  <Button variant="outline" data-testid="grn-request-mrp" onClick={() => void run(
                    async () => { await requestMrpRevision(grn.id); }, t("materialsGrn.approvalRequested"),
                  )}>
                    {t("materialsGrn.requestMrpRevision")}
                  </Button>
                )}
                <Button disabled={capturerBlocked(grn)} onClick={() => void run(
                  async () => { await postGrn(grn.id); }, t("materialsGrn.posted"),
                )}>
                  {t("materialsGrn.post")}
                </Button>
                {auth.can("materials.grn.capture") && !cancelling && (
                  <Button variant="outline" data-testid="grn-cancel" onClick={() => { setCancelling(true); setCancelWhy(""); }}>
                    {t("materialsGrn.cancel")}
                  </Button>
                )}
              </div>
              )}
              {isOpen && cancelling && (
                <div className="flex flex-wrap items-end gap-2 rounded bg-red-50 p-2" data-testid="grn-cancel-form">
                  <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
                    {t("materialsGrn.cancelReason")}
                    <input className="rounded border px-2 py-1" value={cancelWhy} maxLength={500} onChange={(e) => setCancelWhy(e.target.value)} />
                  </label>
                  <Button variant="destructive" disabled={cancelWhy.trim() === ""} data-testid="grn-cancel-confirm" onClick={() => void run(
                    async () => { await cancelGrn(grn.id, cancelWhy.trim()); setCancelling(false); }, t("materialsGrn.cancelled"),
                  )}>
                    {t("materialsGrn.cancelConfirm")}
                  </Button>
                  <Button variant="ghost" onClick={() => setCancelling(false)}>{t("materialsGrn.cancelKeep")}</Button>
                </div>
              )}
            </div>
        </Sheet>
      )}
    </div>
  );
}
