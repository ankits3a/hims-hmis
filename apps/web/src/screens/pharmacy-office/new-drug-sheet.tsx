import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { searchMedicines } from "../../lib/formulary-api";
import { PACK_TYPES, createNewDrug, fetchStockMedicine, paiseOf, stockErrorText } from "../../lib/stock-entry-api";
import { Button } from "@/components/ui/button";
import type { WireMedicineHit } from "../../lib/formulary-api";
import type { NewDrugInput, PackType, WireStockItem } from "../../lib/stock-entry-api";

/**
 * ═══ + NEW DRUG (stock entry, 2026-09-29) ═══
 *
 * A brand the hospital has never stocked, made ready to receive stock in ONE server call
 * (`POST /pharmacy/opening-stock/new-drug` → `createStockDrug`): the item and its pack, its MRP, its sale
 * registration, and its schedule when changed. The GENERIC is a formulary medicine: OPD, emergency and IPD
 * prescribe from the formulary, and the counter matches a prescription to this brand through that link.
 *
 * GST is 5% by default and Nil is allowed (the 36 life-saving drugs and contraceptives, Notification
 * 9/2025-CT(R)); 18% is for what is not a medicament (HSN 2106 supplements). There is no 12% slab for medicines
 * since 22 Sep 2025, so it is not offered. The base unit follows the pack: a strip counts tablets.
 */
const GST_CHOICES = [500, 0, 1800] as const;
const BASE_OF: Record<PackType, string> = {
  tablet_strip: "tablet", capsule_strip: "capsule", bottle: "bottle", vial: "vial", ampoule: "ampoule", tube: "tube",
  pouch: "pouch", sachet: "sachet", box: "unit", other: "unit",
};
const FORM_OF: Partial<Record<PackType, string>> = { tablet_strip: "tablet", capsule_strip: "capsule" };

export function NewDrugSheet({ initialName, onDone }: { initialName: string; onDone: (item: WireStockItem) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [brand, setBrand] = useState(initialName);
  const [strength, setStrength] = useState("");
  const [ask, setAsk] = useState("");
  const [generic, setGeneric] = useState<WireMedicineHit | null>(null);
  const [form, setForm] = useState("");
  const [packType, setPackType] = useState<PackType>("tablet_strip");
  const [packSize, setPackSize] = useState("10");
  const [hsn, setHsn] = useState("3004");
  const [gst, setGst] = useState<number>(500);
  const [schedule, setSchedule] = useState<"" | "H" | "H1" | "X" | "OTC">("");
  const [mrp, setMrp] = useState("");
  const [storage, setStorage] = useState<"ambient" | "cold_2_8">("ambient");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [typed, setTyped] = useState("");
  useEffect(() => { const id = setTimeout(() => setTyped(ask.trim()), 250); return () => clearTimeout(id); }, [ask]);
  const hits = useQuery({ queryKey: ["formulary", "stock-entry-generic", typed], queryFn: () => searchMedicines(typed, 10), enabled: generic === null && typed.length >= 2 });
  const med = useQuery({ queryKey: ["pharmacy", "stock-entry", "medicine", generic?.id], queryFn: () => fetchStockMedicine(generic!.id), enabled: generic !== null });
  // The picked medicine's form, strength and schedule are the sheet's defaults; a person may change them.
  useEffect(() => {
    const m = med.data;
    if (m === undefined) return;
    setForm((f) => (f === "" ? m.form : f));
    setStrength((s) => (s === "" ? m.strength ?? "" : s));
    setSchedule((m.schedule ?? "") as typeof schedule);
  }, [med.data]);

  const size = Number(packSize);
  const mrpPaise = paiseOf(mrp);
  const problems: string[] = [];
  if (brand.trim() === "") problems.push(t("stockEntry.nd.needBrand"));
  if (generic === null) problems.push(t("stockEntry.nd.needGeneric"));
  if (!Number.isInteger(size) || size < 1 || size > 1000) problems.push(t("stockEntry.nd.needPack"));
  if (!/^\d{4,8}$/.test(hsn.trim())) problems.push(t("stockEntry.nd.needHsn"));
  if (mrpPaise === null || mrpPaise <= 0) problems.push(t("stockEntry.nd.needMrp"));

  const save = async (): Promise<void> => {
    if (problems.length > 0 || generic === null || mrpPaise === null) return;
    setBusy(true); setError(null);
    const input: NewDrugInput = {
      brandName: brand.trim(), strength: strength.trim(), medicineId: generic.id, form: form.trim() || (FORM_OF[packType] ?? ""),
      packType, packSize: size, hsnCode: hsn.trim(), gstRateBps: gst, schedule: schedule === "" ? null : schedule,
      mrpPerPackPaise: mrpPaise, storage,
    };
    try {
      const made = await createNewDrug(input);
      const base = BASE_OF[packType];
      onDone({
        itemId: made.itemId, code: made.code, name: made.name, baseUom: base,
        packs: size > 1 ? [{ uom: base, multiplier: 1 }, { uom: made.uom, multiplier: size }] : [{ uom: base, multiplier: 1 }],
        gstRateBps: made.gstRateBps, hsnCode: input.hsnCode, onSale: true, active: true,
        strength: input.strength === "" ? null : input.strength, form: input.form === "" ? null : input.form, schedule: input.schedule ?? med.data?.schedule ?? null,
        rack: null, mrpPaise, mrpUom: made.uom,
      });
    } catch (e) {
      setError(stockErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const field = "flex flex-col gap-1 text-sm";
  const box = "rounded-md border px-2 py-1.5";
  return (
    <form className="space-y-4" data-testid="new-drug-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-sm text-muted-foreground">{t("stockEntry.nd.lead")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>{t("stockEntry.nd.brand")}
          <input className={box} value={brand} onChange={(e) => setBrand(e.target.value)} data-testid="nd-brand" autoFocus />
        </label>
        <label className={field}>{t("stockEntry.nd.strength")}
          <input className={box} value={strength} placeholder="650 mg" onChange={(e) => setStrength(e.target.value)} data-testid="nd-strength" />
        </label>
      </div>

      <div className={field}>
        <span>{t("stockEntry.nd.generic")}</span>
        {generic === null ? (
          <>
            <input className={box} value={ask} placeholder={t("stockEntry.nd.genericPlaceholder")} onChange={(e) => setAsk(e.target.value)} data-testid="nd-generic" aria-label={t("stockEntry.nd.generic")} />
            {typed.length >= 2 && (
              <ul className="max-h-56 overflow-y-auto rounded-md border" data-testid="nd-generic-hits">
                {(hits.data ?? []).map((h) => (
                  <li key={h.id}>
                    <button type="button" className="w-full px-2 py-1.5 text-left hover:bg-muted" onClick={() => setGeneric(h)}>
                      <span className="font-medium">{h.name}</span>
                      <span className="block text-xs text-muted-foreground">{[h.strength, h.form, h.salts.join(" + ")].filter((x) => x !== null && x !== "").join(" · ")}</span>
                    </button>
                  </li>
                ))}
                {hits.data !== undefined && hits.data.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("stockEntry.nd.noGeneric")}</li>}
              </ul>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5" data-testid="nd-generic-picked">
            <span className="min-w-0 flex-1 font-medium">{generic.name}</span>
            <button type="button" className="text-xs underline" onClick={() => { setGeneric(null); setSchedule(""); }}>{t("stockEntry.nd.change")}</button>
          </div>
        )}
        <span className="text-xs text-muted-foreground">{t("stockEntry.nd.genericWhy")}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={field}>{t("stockEntry.nd.form")}
          <input className={box} value={form} placeholder={FORM_OF[packType] ?? ""} onChange={(e) => setForm(e.target.value)} data-testid="nd-form" />
        </label>
        <label className={field}>{t("stockEntry.col.packType")}
          <select className={box} value={packType} onChange={(e) => { const p = e.target.value as PackType; setPackType(p); if (!p.endsWith("strip") && packSize === "10") setPackSize("1"); }} data-testid="nd-pack-type">
            {PACK_TYPES.map((p) => <option key={p} value={p}>{t(`stockEntry.pack.${p}`)}</option>)}
          </select>
        </label>
        <label className={field}>{t("stockEntry.nd.packSize", { base: BASE_OF[packType] })}
          <input className={box} inputMode="numeric" value={packSize} onChange={(e) => setPackSize(e.target.value)} data-testid="nd-pack-size" />
        </label>
        <label className={field}>{t("stockEntry.nd.hsn")}
          <input className={box} inputMode="numeric" value={hsn} onChange={(e) => setHsn(e.target.value)} data-testid="nd-hsn" />
        </label>
        <label className={field}>{t("stockEntry.col.gst")}
          <select className={box} value={gst} onChange={(e) => setGst(Number(e.target.value))} data-testid="nd-gst">
            {GST_CHOICES.map((g) => <option key={g} value={g}>{t(`stockEntry.nd.gst_${String(g)}`)}</option>)}
          </select>
        </label>
        <label className={field}>{t("stockEntry.nd.schedule")}
          <select className={box} value={schedule} onChange={(e) => setSchedule(e.target.value as typeof schedule)} data-testid="nd-schedule">
            <option value="">{t("materialsItems.edit.scheduleUnset")}</option>
            {(["OTC", "H", "H1", "X"] as const).map((s) => <option key={s} value={s}>{t(`stockEntry.nd.sched_${s}`)}</option>)}
          </select>
        </label>
        <label className={field}>{t("stockEntry.nd.mrp")}
          <input className={box} inputMode="decimal" value={mrp} placeholder="0.00" onChange={(e) => setMrp(e.target.value)} data-testid="nd-mrp" />
        </label>
        <label className={field}>{t("materialsItems.edit.storage")}
          <select className={box} value={storage} onChange={(e) => setStorage(e.target.value as "ambient" | "cold_2_8")} data-testid="nd-storage">
            <option value="ambient">{t("materialsItems.edit.storage_ambient")}</option>
            <option value="cold_2_8">{t("materialsItems.edit.storage_cold_2_8")}</option>
          </select>
        </label>
      </div>
      {med.data !== undefined && schedule !== "" && schedule !== med.data.schedule && (
        <p className="text-xs text-amber-800" data-testid="nd-schedule-change">{t("stockEntry.nd.scheduleChanges", { from: med.data.schedule ?? t("materialsItems.edit.scheduleUnset") })}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("stockEntry.nd.gstHint")}</p>

      {problems.length > 0 && <p className="text-sm text-muted-foreground" data-testid="nd-problems">{t("stockEntry.nd.stillNeeded", { list: problems.join(" · ") })}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <Button type="submit" disabled={problems.length > 0 || busy} data-testid="nd-save">{t("stockEntry.nd.save")}</Button>
    </form>
  );
}
