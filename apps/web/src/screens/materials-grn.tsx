import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  captureGrn, fetchDiscrepancies, fetchExpiring, fetchGrn, fetchGrns, fetchItems, fetchStores,
  fetchVendors, materialsErrorText, postGrn, requestNearExpiry, runGrnQc,
} from "../lib/materials-api";
import { fetchPurchaseOrders, fetchReceivable } from "../lib/purchase-api";
import { Button } from "@/components/ui/button";
import { OpeningStockSheet } from "./materials-grn-opening";
import { NewButton, OfficeHead, fieldCls, useNewKey } from "./pharmacy-office/office-page";
import { Sheet } from "./pharmacy-office/sheet";
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
  batchNo: string; expiryDate: string;
  mrpRupees: string; mrpUom: string; costRupees: string; freeGoods: boolean;
};

const emptyLine = (): DraftLine => ({
  itemId: "", uom: "", qtyInUom: "", batchNo: "", expiryDate: "",
  mrpRupees: "", mrpUom: "", costRupees: "", freeGoods: false,
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
  if (status === "rejected") return "pill rd";
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

  const capture = (): void => void run(async () => {
    const payload: CaptureLineInput[] = lines
      .filter((l) => l.itemId !== "" && l.qtyInUom.trim() !== "")
      .map((l) => ({
        itemId: l.itemId, uom: l.uom.trim(), qtyInUom: Number(l.qtyInUom),
        ...(l.batchNo.trim() === "" ? {} : { batchNo: l.batchNo.trim() }),
        ...(l.expiryDate.trim() === "" ? {} : { expiryDate: l.expiryDate.trim() }),
        ...(toPaise(l.mrpRupees) === null ? {} : { mrpPaise: toPaise(l.mrpRupees), mrpUom: l.mrpUom.trim() }),
        // Free goods are a zero-cost line with FULL batch discipline (DD8), never a discount.
        unitCostPaise: l.freeGoods ? 0 : (toPaise(l.costRupees) ?? 0),
        ...(l.freeGoods ? { freeGoods: true } : {}),
      }));
    const { grnId, grnNo } = await captureGrn({
      vendorId, source, storeResourceId: storeId,
      challanNo: challanNo.trim(), challanDate: challanDate.trim(),
      ...(purchaseOrderId === "" ? {} : { purchaseOrderId }),
      lines: payload,
    });
    setPurchaseOrderId("");
    setReceiving(false);
    setOpenGrnId(grnId);
    setLines([emptyLine()]);
    setChallanNo("");
    setDone(t("materialsGrn.captured", { grnNo }));
  }, t("materialsGrn.capturedGeneric"));

  const grn: WireGrn | undefined = openGrn.data;
  const hasNearExpiry = grn?.lines.some((l) => l.nearExpiry) === true;

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
                <input className={fieldCls} value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
              </label>
            </div>

            <h3 className="text-sm font-medium">{t("materialsGrn.lines")}</h3>
            {lines.map((l, i) => (
              <div key={i} className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.item")}
                  <select
                    className={fieldCls} value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value })}
                  >
                    <option value="">—</option>
                    {(items.data ?? []).map((it) => <option key={it.id} value={it.id}>{it.code}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.uom")}
                  <input className={fieldCls} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
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
                  <input className={fieldCls} value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrp")}
                  <input className={fieldCls} inputMode="decimal" value={l.mrpRupees} onChange={(e) => setLine(i, { mrpRupees: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrpUom")}
                  <input className={fieldCls} value={l.mrpUom} onChange={(e) => setLine(i, { mrpUom: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.cost")}
                  <input
                    className={fieldCls} inputMode="decimal" value={l.costRupees}
                    disabled={l.freeGoods}
                    onChange={(e) => setLine(i, { costRupees: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox" checked={l.freeGoods}
                    onChange={(e) => setLine(i, { freeGoods: e.target.checked })}
                  />
                  {t("materialsGrn.freeGoods")}
                </label>
              </div>
            ))}
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
        <Sheet title={grn.grnNo} testId="grn-sheet" onClose={() => { setOpenGrnId(null); }}>
            <div className="space-y-3" data-testid="grn-open">
              {feedback}
              <p><span className={grnPill(grn.status)}>{t(`materialsGrn.status_${grn.status}`, { defaultValue: grn.status })}</span></p>
              <div className="ofp-box ofp-scroll">
              <table className="ofp-table min-w-[32rem]">
                <thead>
                  <tr>
                    <th>{t("materialsGrn.item")}</th>
                    <th>{t("materialsGrn.qtyBase")}</th>
                    <th>{t("materialsGrn.batchNo")}</th>
                    <th>{t("materialsGrn.verdict")}</th>
                  </tr>
                </thead>
                <tbody>
                  {grn.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{(items.data ?? []).find((it) => it.id === l.itemId)?.code ?? l.itemId}</td>
                      <td>{l.qtyBase}</td>
                      <td>{l.batchNo ?? "—"}</td>
                      <td>
                        {/* THE RULE, AS A SENTENCE. Never the raw code — see the header. */}
                        {l.rejectReason !== null
                          ? <span className="text-red-600">{t(`materialsGrn.rule_${l.rejectReason}`)}</span>
                          : l.nearExpiry
                            ? <span className="text-amber-700">{t("materialsGrn.rule_near_expiry")}</span>
                            : <span className="text-green-700">{t("materialsGrn.verdictPass")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void run(
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
                <Button onClick={() => void run(
                  async () => { await postGrn(grn.id); }, t("materialsGrn.posted"),
                )}>
                  {t("materialsGrn.post")}
                </Button>
              </div>
            </div>
        </Sheet>
      )}
    </div>
  );
}
