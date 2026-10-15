import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { materialsErrorText } from "../../lib/materials-api";
import { OfficeHead, fieldCls } from "./office-page";

/**
 * ═══ A VENDOR'S RATES, AND AN ORDER AT THEM (owner 2026-10-04, step 2 of buying from Aptus Drugs) ═══
 *
 * Pick a vendor: its contracted items, each with the quoted rate (ex-GST, per pack), the MRP, the margin, and
 * what the hospital last paid for it. Type the packs wanted (and any free packs the vendor promised) and make a
 * DRAFT order: the server prices every line from the contract, never from this screen; the draft then goes
 * through the usual submit → approval → send. Whoever keeps vendors may also end a rate here.
 */
type Vendor = { id: string; code: string; name: string };
type Line = {
  id: string; itemId: string; itemCode: string; itemName: string; baseUom: string; uom: string; multiplier: number;
  ratePaise: number; gstRateBps: number; mrpPaise: number | null; validFrom: string; validTo: string | null; source: string | null;
  lastPaidPaise: number | null; lastVendorId: string | null;
};
type Order = { id: string; poNo: string; totalPaise: number };

const rupees = (p: number | null): string => (p === null ? "—" : `₹${(p / 100).toFixed(2)}`);
const whole = (s: string): number => { const n = Number(s.replace(/\D/g, "")); return Number.isSafeInteger(n) ? n : 0; };

export function VendorRatesView(): React.ReactElement {
  const { t } = useTranslation();
  const R = (k: string, o?: Record<string, unknown>): string => t(`pharmacyOffice.rates.${k}`, o);
  const { can } = useAuth();
  const qc = useQueryClient();
  const [vendorId, setVendorId] = useState("");
  const [qty, setQty] = useState<Record<string, { packs: string; free: string }>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Order | null>(null);

  const vendors = useQuery({ queryKey: ["pharmacy", "office", "po-vendors"], queryFn: () => api<{ vendors: Vendor[] }>("GET", "/materials/purchase-vendors") });
  const sheet = useQuery({
    queryKey: ["pharmacy", "office", "vendor-rates", vendorId], enabled: vendorId !== "",
    queryFn: () => api<{ lines: Line[] }>("GET", `/pharmacy/office/vendor-rates/${vendorId}`),
  });
  const lines = (sheet.data?.lines ?? []).filter((l) => filter === "" || `${l.itemName} ${l.itemCode}`.toLowerCase().includes(filter.toLowerCase()));
  const wanted = (sheet.data?.lines ?? []).filter((l) => whole(qty[l.itemId]?.packs ?? "") > 0);
  const subtotal = wanted.reduce((s, l) => s + whole(qty[l.itemId]!.packs) * l.ratePaise, 0);
  const gst = wanted.reduce((s, l) => s + Math.floor((whole(qty[l.itemId]!.packs) * l.ratePaise * l.gstRateBps + 5_000) / 10_000), 0);

  const order = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const res = await api<{ order: Order }>("POST", "/pharmacy/office/order-from-rates", {
        vendorId, lines: wanted.map((l) => ({ itemId: l.itemId, qtyPacks: whole(qty[l.itemId]!.packs), ...(whole(qty[l.itemId]!.free) > 0 ? { freePacks: whole(qty[l.itemId]!.free) } : {}) })),
      });
      setMade(res.order); setQty({});
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const end = async (l: Line): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/materials/vendor-rates/${l.id}/end`, {});
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "vendor-rates", vendorId] });
    } catch (e) { setError(materialsErrorText(e, t)); }
  };

  return (
    <div className="space-y-4" data-testid="vendor-rates">
      <OfficeHead title={R("title")} lead={R("lead")} />
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">{R("vendor")}
          <select className={fieldCls} data-testid="rates-vendor" value={vendorId} onChange={(e) => { setVendorId(e.target.value); setQty({}); setMade(null); }}>
            <option value="">{R("pickVendor")}</option>
            {(vendors.data?.vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name} ({v.code})</option>)}
          </select>
        </label>
        {vendorId !== "" && (
          <label className="flex flex-col gap-1 text-xs">{R("search")}
            <input className={fieldCls} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="rates-search" />
          </label>
        )}
      </div>

      {made !== null && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="rates-made">{R("made", { poNo: made.poNo, total: rupees(made.totalPaise) })}</p>}

      {vendorId !== "" && sheet.data !== undefined && sheet.data.lines.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="rates-empty">{R("empty")}</p>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs [&_td]:px-1.5 [&_td]:py-1 [&_th]:px-1.5 [&_th]:text-left" data-testid="rates-lines">
            <thead><tr className="text-muted-foreground">
              <th>{R("col.item")}</th><th>{R("col.pack")}</th><th className="text-right">{R("col.rate")}</th><th className="text-right">GST</th>
              <th className="text-right">{R("col.mrp")}</th><th className="text-right">{R("col.margin")}</th><th className="text-right">{R("col.lastPaid")}</th>
              <th>{R("col.valid")}</th><th>{R("col.packs")}</th><th>{R("col.free")}</th><th />
            </tr></thead>
            <tbody>{lines.map((l) => {
              // Margin on MRP, against the rate WITH GST: what the hospital pays, against what the patient pays.
              const withGst = l.ratePaise + Math.floor((l.ratePaise * l.gstRateBps + 5_000) / 10_000);
              const margin = l.mrpPaise === null || l.mrpPaise === 0 ? null : Math.round((100 * (l.mrpPaise - withGst)) / l.mrpPaise);
              const dearer = l.lastPaidPaise !== null && l.ratePaise > l.lastPaidPaise;
              return (
                <tr key={l.id} className="border-t align-top" data-testid={`rates-row-${l.itemCode}`}>
                  <td><b>{l.itemName}</b><div className="text-muted-foreground">{l.itemCode}{l.source === null ? "" : ` · ${l.source}`}</div></td>
                  <td className="whitespace-nowrap">{R("pack", { uom: l.uom, count: l.multiplier, base: l.baseUom })}</td>
                  <td className="text-right tabular-nums">{rupees(l.ratePaise)}</td>
                  <td className="text-right tabular-nums">{l.gstRateBps / 100}%</td>
                  <td className="text-right tabular-nums">{rupees(l.mrpPaise)}</td>
                  <td className="text-right tabular-nums">{margin === null ? "—" : `${String(margin)}%`}</td>
                  <td className={`text-right tabular-nums ${dearer ? "text-amber-700" : ""}`} title={dearer ? R("dearer") : undefined}>{rupees(l.lastPaidPaise)}</td>
                  <td className="whitespace-nowrap">{l.validTo === null ? R("open") : R("until", { date: l.validTo })}</td>
                  <td><input className={`${fieldCls} w-16`} inputMode="numeric" aria-label={R("packsOf", { item: l.itemName })} data-testid={`rates-packs-${l.itemCode}`}
                    value={qty[l.itemId]?.packs ?? ""} onChange={(e) => setQty({ ...qty, [l.itemId]: { packs: e.target.value.replace(/\D/g, ""), free: qty[l.itemId]?.free ?? "" } })} /></td>
                  <td><input className={`${fieldCls} w-14`} inputMode="numeric" aria-label={R("freeOf", { item: l.itemName })} data-testid={`rates-free-${l.itemCode}`}
                    value={qty[l.itemId]?.free ?? ""} onChange={(e) => setQty({ ...qty, [l.itemId]: { packs: qty[l.itemId]?.packs ?? "", free: e.target.value.replace(/\D/g, "") } })} /></td>
                  <td>{can("materials.vendors.manage") && <Button type="button" size="sm" variant="ghost" onClick={() => void end(l)} data-testid={`rates-end-${l.itemCode}`}>{R("end")}</Button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {vendorId !== "" && (sheet.data?.lines.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm tabular-nums" data-testid="rates-total">{R("total", { count: wanted.length, subtotal: rupees(subtotal), gst: rupees(gst), total: rupees(subtotal + gst) })}</span>
          <Button type="button" data-testid="rates-order" disabled={busy || wanted.length === 0 || !can("materials.po.raise")} onClick={() => void order()}>{busy ? R("working") : R("order")}</Button>
          <span className="text-xs text-muted-foreground">{R("orderNote")}</span>
        </div>
      )}
    </div>
  );
}
