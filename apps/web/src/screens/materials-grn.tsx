import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  captureGrn, fetchDiscrepancies, fetchExpiring, fetchGrn, fetchGrns, fetchItems, fetchStores,
  fetchVendors, materialsErrorText, postGrn, requestNearExpiry, runGrnQc,
} from "../lib/materials-api";
import { Button } from "@/components/ui/button";
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
 * ═══ THE SECOND TAB IS THE TWO WORKLISTS (DD16) ═══
 *
 * `expiring` and `discrepancy` transfers are read routes with tables, not screens of their own —
 * the owner's ruling, and the reason there is no Lane-2 generator to make them cheaply.
 */
type Tab = "gate" | "worklists";

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

export function MaterialsGrn(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [tab, setTab] = useState<Tab>("gate");
  const [vendorId, setVendorId] = useState("");
  const [source, setSource] = useState("challan");
  const [storeId, setStoreId] = useState("");
  const [challanNo, setChallanNo] = useState("");
  const [challanDate, setChallanDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [openGrnId, setOpenGrnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const vendors = useQuery({ queryKey: ["materials", "vendors"], queryFn: () => fetchVendors({ status: "active" }) });
  const stores = useQuery({ queryKey: ["materials", "stores"], queryFn: fetchStores });
  const items = useQuery({ queryKey: ["materials", "items"], queryFn: () => fetchItems({}) });
  const grns = useQuery({ queryKey: ["materials", "grns"], queryFn: fetchGrns });
  const openGrn = useQuery({
    queryKey: ["materials", "grn", openGrnId],
    queryFn: () => fetchGrn(openGrnId as string),
    enabled: openGrnId !== null,
  });
  const expiring = useQuery({
    queryKey: ["materials", "expiring"], queryFn: fetchExpiring, enabled: tab === "worklists",
  });
  const discrepancies = useQuery({
    queryKey: ["materials", "discrepancies"], queryFn: fetchDiscrepancies, enabled: tab === "worklists",
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
      lines: payload,
    });
    setOpenGrnId(grnId);
    setLines([emptyLine()]);
    setChallanNo("");
    setDone(t("materialsGrn.captured", { grnNo }));
  }, t("materialsGrn.capturedGeneric"));

  const grn: WireGrn | undefined = openGrn.data;
  const hasNearExpiry = grn?.lines.some((l) => l.nearExpiry) === true;

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">{t("materialsGrn.title")}</h1>

      <div className="flex gap-2">
        <Button variant={tab === "gate" ? "default" : "secondary"} onClick={() => setTab("gate")}>
          {t("materialsGrn.tabGate")}
        </Button>
        <Button variant={tab === "worklists" ? "default" : "secondary"} onClick={() => setTab("worklists")}>
          {t("materialsGrn.tabWorklists")}
        </Button>
      </div>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      {tab === "gate" && (
        <>
          <section className="space-y-3 rounded border p-4">
            <h2 className="font-medium">{t("materialsGrn.newGrn")}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.vendor")}
                <select className="rounded border px-2 py-1" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">—</option>
                  {(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.code}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.source")}
                <select className="rounded border px-2 py-1" value={source} onChange={(e) => setSource(e.target.value)}>
                  {["challan", "consignment_challan", "donation"]
                    .map((s) => <option key={s} value={s}>{t(`materialsGrn.source_${s}`)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.store")}
                <select className="rounded border px-2 py-1" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  <option value="">—</option>
                  {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.challanNo")}
                <input className="rounded border px-2 py-1" value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsGrn.challanDate")}
                <input className="rounded border px-2 py-1" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
              </label>
            </div>

            <h3 className="text-sm font-medium">{t("materialsGrn.lines")}</h3>
            {lines.map((l, i) => (
              <div key={i} className="grid gap-2 border-t pt-2 sm:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.item")}
                  <select
                    className="rounded border px-2 py-1" value={l.itemId}
                    onChange={(e) => setLine(i, { itemId: e.target.value })}
                  >
                    <option value="">—</option>
                    {(items.data ?? []).map((it) => <option key={it.id} value={it.id}>{it.code}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.uom")}
                  <input className="rounded border px-2 py-1" value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.qty")}
                  <input
                    className="rounded border px-2 py-1" inputMode="numeric" value={l.qtyInUom}
                    onChange={(e) => setLine(i, { qtyInUom: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.batchNo")}
                  <input className="rounded border px-2 py-1" value={l.batchNo} onChange={(e) => setLine(i, { batchNo: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.expiry")}
                  <input className="rounded border px-2 py-1" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrp")}
                  <input className="rounded border px-2 py-1" inputMode="decimal" value={l.mrpRupees} onChange={(e) => setLine(i, { mrpRupees: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.mrpUom")}
                  <input className="rounded border px-2 py-1" value={l.mrpUom} onChange={(e) => setLine(i, { mrpUom: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  {t("materialsGrn.cost")}
                  <input
                    className="rounded border px-2 py-1" inputMode="decimal" value={l.costRupees}
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
            <Button variant="secondary" onClick={() => setLines((p) => [...p, emptyLine()])}>
              {t("materialsGrn.addLine")}
            </Button>
            <Button onClick={capture}>{t("materialsGrn.capture")}</Button>
          </section>

          {grn !== undefined && (
            <section className="space-y-3 rounded border p-4">
              <h2 className="font-medium">
                {grn.grnNo} · {t(`materialsGrn.status_${grn.status}`)}
              </h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th>{t("materialsGrn.item")}</th>
                    <th>{t("materialsGrn.qtyBase")}</th>
                    <th>{t("materialsGrn.batchNo")}</th>
                    <th>{t("materialsGrn.verdict")}</th>
                  </tr>
                </thead>
                <tbody>
                  {grn.lines.map((l) => (
                    <tr key={l.id} className="border-t">
                      <td>{l.itemId}</td>
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
              <div className="flex gap-2">
                <Button onClick={() => void run(
                  async () => { await runGrnQc(grn.id); }, t("materialsGrn.qcDone"),
                )}>
                  {t("materialsGrn.runQc")}
                </Button>
                {hasNearExpiry && (
                  <Button variant="secondary" onClick={() => void run(
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
            </section>
          )}

          <section>
            <h2 className="font-medium">{t("materialsGrn.recent")}</h2>
            {(grns.data ?? []).length === 0 && <p className="text-sm">{t("materialsGrn.noGrns")}</p>}
            <ul className="text-sm">
              {(grns.data ?? []).map((g) => (
                <li key={g.id}>
                  <button className="underline" onClick={() => setOpenGrnId(g.id)}>
                    {g.grnNo}
                  </button>
                  {" · "}{t(`materialsGrn.status_${g.status}`)}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {tab === "worklists" && (
        <>
          <section>
            <h2 className="font-medium">{t("materialsGrn.expiringTitle")}</h2>
            {(expiring.data ?? []).length === 0 && <p className="text-sm">{t("materialsGrn.nothingExpiring")}</p>}
            <ul className="text-sm">
              {(expiring.data ?? []).map((b) => (
                <li key={b.batchId}>
                  {b.batchNo} · {t("materialsGrn.daysRemaining", { days: b.daysRemaining })}
                  {" · "}{t("materialsGrn.onHand", { qty: b.qtyOnHandTotal })}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-medium">{t("materialsGrn.discrepancyTitle")}</h2>
            {(discrepancies.data ?? []).length === 0 && <p className="text-sm">{t("materialsGrn.noDiscrepancies")}</p>}
            <ul className="text-sm">
              {(discrepancies.data ?? []).map((tr) => (
                <li key={tr.id} className="text-red-600">
                  {tr.id} · {t("materialsGrn.shortLines", { count: tr.lines.filter((l) => l.discrepancyReason !== null).length })}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
