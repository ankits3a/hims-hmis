import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fetchItem, materialsErrorText, patchItem } from "../lib/materials-api";
import { setMedicineSchedule } from "../lib/formulary-api";
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
 * ═══ UNSET IS NOT SAFE ═══
 *
 * LASA and high-alert default to off, which means "nobody has said so". The counter shows the flags on the
 * dispense line (gold for LASA, red for high alert) so the pharmacist reads the strip twice.
 */
const STORAGE = ["ambient", "cold_2_8", "frozen", "narcotic", "flammable"] as const;
const SCHEDULES = ["", "OTC", "H", "H1", "X"] as const;

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
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const d = item.data;
    if (d === undefined) return;
    setHsn(d.hsnCode ?? ""); setStorage(d.storageClass); setShelfLife(d.shelfLifeDays === null ? "" : String(d.shelfLifeDays));
    setManufacturer(d.manufacturer ?? ""); setLeadTime(d.leadTimeDays == null ? "" : String(d.leadTimeDays));
    setLasa(d.lasa === true); setHighAlert(d.highAlert === true); setSchedule(d.scheduleFlag ?? "");
  }, [item.data]);

  const d = item.data;
  const canSchedule = can("formulary.manage") && d?.formularyMedicineId != null;

  const save = async (): Promise<void> => {
    if (d === undefined) return;
    setError(null); setDone(null);
    const whole = (v: string): number | null => (v.trim() === "" ? null : Number(v));
    try {
      await patchItem(d.id, {
        hsnCode: hsn.trim() === "" ? null : hsn.trim(), storageClass: storage, shelfLifeDays: whole(shelfLife),
        manufacturer: manufacturer.trim() === "" ? null : manufacturer.trim(), leadTimeDays: whole(leadTime), lasa, highAlert,
      });
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
