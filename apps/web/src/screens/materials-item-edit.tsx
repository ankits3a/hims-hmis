import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fetchItem, materialsErrorText, patchItem } from "../lib/materials-api";
import { setMedicineSchedule } from "../lib/formulary-api";
import { addPackSize, setGstSlab, stockErrorText } from "../lib/stock-entry-api";
import { Button } from "@/components/ui/button";

/**
 * GAP CLOSURE A2 (2026-09-28) — **THE ITEM MASTER'S EDIT PANEL.**
 *
 * The owner's Healthray audit found HSN, storage, manufacturer and the schedule settable only by script,
 * and no LASA or high-alert flag anywhere. This panel edits the item's own fields through
 * `PATCH /materials/items/:id` (`materials.items.manage`, the route guard).
 *
 * ═══ THE SCHEDULE IS THE CATALOGUE'S, NOT THE ITEM'S ═══
 *
 * H / H1 / X live on the formulary medicine, because the law classes the molecule and every brand of it.
 * The panel shows it for a drug and changes it through the formulary's own route, only for someone who
 * holds `formulary.manage`; anyone else sees it read-only. Two saves, two authorities, one screen.
 *
 * ═══ GST AND PACKS (stock entry, 2026-09-29) ═══
 *
 * The stock-entry grid opens this panel from a row to fix a drug's GST or add a pack size. The slab is saved
 * through `PUT /pharmacy/sale-items/:id/gst-slab` (`pharmacy.sale_items.manage`), which moves the sale item's
 * GST category in the same transaction — a slab changed on the item alone would leave the bill on the old rate.
 * A pack size is a new unit (`POST /materials/items/:id/uoms`); existing units are never renamed or resized,
 * because the ledger's quantities are counted in them.
 *
 * ═══ UNSET IS NOT SAFE ═══
 *
 * LASA and high-alert default to off, which means "nobody has said so". The counter shows the flags on the
 * dispense line (gold for LASA, red for high alert) so the pharmacist reads the strip twice.
 */
const STORAGE = ["ambient", "cold_2_8", "frozen", "narcotic", "flammable"] as const;
const SCHEDULES = ["", "OTC", "H", "H1", "X"] as const;
const SLABS = [0, 500, 1200, 1800] as const;

export function ItemEditPanel({ itemId, onClose }: { itemId: string; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const item = useQuery({ queryKey: ["materials", "item", itemId], queryFn: () => fetchItem(itemId) });
  const [hsn, setHsn] = useState("");
  const [storage, setStorage] = useState("ambient");
  const [shelfLife, setShelfLife] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [lasa, setLasa] = useState(false);
  const [highAlert, setHighAlert] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [gst, setGst] = useState("");
  const [packUom, setPackUom] = useState("");
  const [packSize, setPackSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const d = item.data;
    if (d === undefined) return;
    setHsn(d.hsnCode ?? ""); setStorage(d.storageClass); setShelfLife(d.shelfLifeDays === null ? "" : String(d.shelfLifeDays));
    setManufacturer(d.manufacturer ?? ""); setLeadTime(d.leadTimeDays == null ? "" : String(d.leadTimeDays));
    setLasa(d.lasa === true); setHighAlert(d.highAlert === true); setSchedule(d.scheduleFlag ?? "");
    setGst(d.gstRateBps === null ? "" : String(d.gstRateBps));
  }, [item.data]);

  const d = item.data;
  const canSchedule = can("formulary.manage") && d?.formularyMedicineId != null;
  const canGst = can("pharmacy.sale_items.manage") && d?.class === "drug";

  const addPack = async (): Promise<void> => {
    if (d === undefined) return;
    setError(null); setDone(null);
    const n = Number(packSize);
    if (packUom.trim() === "" || !Number.isInteger(n) || n < 2) { setError(t("materialsItems.edit.packInvalid")); return; }
    try {
      await addPackSize(d.id, packUom.trim(), n);
      setPackUom(""); setPackSize("");
      setDone(t("materialsItems.edit.packAdded", { uom: packUom.trim(), n }));
      await qc.invalidateQueries({ queryKey: ["materials"] });
    } catch (e) {
      setError(stockErrorText(e, t));
    }
  };

  const save = async (): Promise<void> => {
    if (d === undefined) return;
    setError(null); setDone(null);
    const whole = (v: string): number | null => (v.trim() === "" ? null : Number(v));
    try {
      await patchItem(d.id, {
        hsnCode: hsn.trim() === "" ? null : hsn.trim(), storageClass: storage, shelfLifeDays: whole(shelfLife),
        manufacturer: manufacturer.trim() === "" ? null : manufacturer.trim(), leadTimeDays: whole(leadTime), lasa, highAlert,
      });
      if (canGst && gst !== "" && Number(gst) !== d.gstRateBps) await setGstSlab(d.id, Number(gst));
      if (canSchedule && schedule !== (d.scheduleFlag ?? "")) {
        await setMedicineSchedule(d.formularyMedicineId!, schedule === "" ? null : schedule as "H" | "H1" | "X" | "OTC");
      }
      setDone(t("materialsItems.edit.saved", { code: d.code }));
      await qc.invalidateQueries({ queryKey: ["materials"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };

  return (
    <section className="space-y-3 rounded border p-4" aria-labelledby="item-edit-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="item-edit-title" className="font-medium">
          {d === undefined ? t("common.loading") : t("materialsItems.edit.title", { code: d.code, name: d.name })}
        </h2>
        <Button variant="secondary" onClick={onClose}>{t("materialsItems.edit.close")}</Button>
      </div>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}
      {d !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              {t("materialsItems.edit.hsn")}
              <input className="rounded border px-2 py-1" inputMode="numeric" value={hsn} onChange={(e) => setHsn(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("materialsItems.edit.storage")}
              <select className="rounded border px-2 py-1" value={storage} onChange={(e) => setStorage(e.target.value)}>
                {STORAGE.map((s) => <option key={s} value={s}>{t(`materialsItems.edit.storage_${s}`)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("materialsItems.shelfLifeDays")}
              <input className="rounded border px-2 py-1" inputMode="numeric" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("materialsItems.edit.manufacturer")}
              <input className="rounded border px-2 py-1" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("materialsItems.edit.leadTime")}
              <input className="rounded border px-2 py-1" inputMode="numeric" value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
            </label>
            {d.formularyMedicineId !== null && (
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsItems.edit.schedule", { medicine: d.medicineName ?? "" })}
                <select
                  className="rounded border px-2 py-1" value={schedule} disabled={!canSchedule}
                  onChange={(e) => setSchedule(e.target.value)}
                >
                  {SCHEDULES.map((s) => <option key={s} value={s}>{s === "" ? t("materialsItems.edit.scheduleUnset") : s}</option>)}
                </select>
              </label>
            )}
          </div>
          {d.class === "drug" && (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-sm">
                {t("materialsItems.edit.gst")}
                <select className="rounded border px-2 py-1" value={gst} disabled={!canGst} onChange={(e) => setGst(e.target.value)} data-testid="item-edit-gst">
                  {d.gstRateBps === null && <option value="">{t("materialsItems.edit.scheduleUnset")}</option>}
                  {SLABS.map((g) => <option key={g} value={String(g)}>{g === 0 ? t("materialsItems.edit.gstNil") : `${String(g / 100)}%`}</option>)}
                </select>
              </label>
              <div className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span>{t("materialsItems.edit.packs")}</span>
                <span className="text-xs text-slate-600" data-testid="item-edit-packs">
                  {d.uoms.map((u) => (u.toBaseMultiplier === 1 ? u.uom : `${u.uom} × ${String(u.toBaseMultiplier)} ${d.baseUom}`)).join(" · ")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <input className="w-28 rounded border px-2 py-1" placeholder="strip15" aria-label={t("materialsItems.edit.packUom")} value={packUom} onChange={(e) => setPackUom(e.target.value)} />
                  <input className="w-20 rounded border px-2 py-1" inputMode="numeric" placeholder="15" aria-label={t("materialsItems.edit.packSize", { base: d.baseUom })} value={packSize} onChange={(e) => setPackSize(e.target.value)} />
                  <Button type="button" variant="secondary" onClick={() => void addPack()}>{t("materialsItems.edit.addPack")}</Button>
                </div>
              </div>
            </div>
          )}
          {d.class === "drug" && !canGst && <p className="text-xs text-slate-500">{t("materialsItems.edit.gstReadOnly")}</p>}
          {d.formularyMedicineId !== null && !canSchedule && (
            <p className="text-xs text-slate-500">{t("materialsItems.edit.scheduleReadOnly")}</p>
          )}
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={lasa} onChange={(e) => setLasa(e.target.checked)} />
              {t("materialsItems.edit.lasa")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={highAlert} onChange={(e) => setHighAlert(e.target.checked)} />
              {t("materialsItems.edit.highAlert")}
            </label>
          </div>
          <p className="text-xs text-slate-500">{t("materialsItems.edit.flagsHint")}</p>
          <Button onClick={() => void save()}>{t("materialsItems.edit.save")}</Button>
        </>
      )}
    </section>
  );
}
