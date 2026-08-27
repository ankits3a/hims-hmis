import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { createItem, fetchItems, materialsErrorText, patchItem } from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import type { WireItem } from "../lib/materials-api";

/**
 * PLAN 14 T9 / DD16 — **THE ITEM MASTER, hand-built (Lane 1).**
 *
 * The owner ruled the screens IN because without one nobody can register an item except by script,
 * and the mini-OT's first consignment challan is received on a gate that needs items to exist.
 * There is no Lane-2 generator in this house (deferred note 3 remains deferred), so this is typed.
 *
 * ═══ THE `class` FIELD IS THE ONE THAT DECIDES EVERYTHING DOWNSTREAM, SO IT LEADS ═══
 *
 * DD3: a `drug` MUST name a formulary medicine and a non-drug MUST NOT. The form makes that
 * visible rather than discovering it at the server — the medicine field appears only for `drug` —
 * **but the server is still the authority and its refusal is what the screen renders.** A client
 * that enforced the rule alone would be a second copy of it (§2.54), and the one that drifted
 * would be the one nobody was reading.
 *
 * ═══ WHAT `baseUom` MEANS, SAID ON THE SCREEN ═══
 *
 * Every quantity this hospital ever records for this item is counted in the base unit, and it can
 * never be changed afterwards (`items.ts` says why: it would silently reinterpret every ledger row
 * already written). So the field carries that sentence, and the additional packs are entered as
 * multipliers OF it — which is DD7's one-conversion rule made visible at the only moment a human
 * chooses the numbers.
 */
export function MaterialsItems(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [itemClass, setItemClass] = useState("consumable");
  const [baseUom, setBaseUom] = useState("");
  const [medicineId, setMedicineId] = useState("");
  const [shelfLifeDays, setShelfLifeDays] = useState("");
  const [packUom, setPackUom] = useState("");
  const [packMultiplier, setPackMultiplier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const items = useQuery({
    queryKey: ["materials", "items", search],
    queryFn: () => fetchItems({ search }),
  });

  const isDrug = itemClass === "drug";

  const submit = async (): Promise<void> => {
    setError(null);
    setDone(null);
    const multiplier = Number(packMultiplier);
    try {
      await createItem({
        code: code.trim(), name: name.trim(), class: itemClass,
        baseUom: baseUom.trim(),
        // DD3's classes: batch discipline follows the class, and the gate enforces it (DD8 rule 3).
        batchTracked: ["drug", "consumable_dated", "reagent", "implant"].includes(itemClass),
        // Sent ONLY for a drug. The server refuses the other direction too (A1) — this is the
        // form declining to construct the refusable state, not the form enforcing the rule.
        ...(isDrug && medicineId.trim() !== "" ? { formularyMedicineId: medicineId.trim() } : {}),
        ...(shelfLifeDays.trim() === "" ? {} : { shelfLifeDays: Number(shelfLifeDays) }),
        ...(packUom.trim() !== "" && Number.isInteger(multiplier) && multiplier > 1
          ? { uoms: [{ uom: packUom.trim(), toBaseMultiplier: multiplier }] }
          : {}),
      });
      setDone(t("materialsItems.created", { code: code.trim() }));
      setCode(""); setName(""); setBaseUom(""); setMedicineId("");
      setShelfLifeDays(""); setPackUom(""); setPackMultiplier("");
      await qc.invalidateQueries({ queryKey: ["materials", "items"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };

  const toggleActive = async (item: WireItem): Promise<void> => {
    setError(null);
    try {
      await patchItem(item.id, { active: !item.active });
      await qc.invalidateQueries({ queryKey: ["materials", "items"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };

  return (
    <div className="space-y-6 p-4">
      <h1 className="text-xl font-semibold">{t("materialsItems.title")}</h1>

      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      <section className="space-y-3 rounded border p-4">
        <h2 className="font-medium">{t("materialsItems.newItem")}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsItems.code")}
            <input className="rounded border px-2 py-1" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsItems.name")}
            <input className="rounded border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsItems.class")}
            <select className="rounded border px-2 py-1" value={itemClass} onChange={(e) => setItemClass(e.target.value)}>
              {["drug", "consumable", "consumable_dated", "reagent", "implant", "stationery", "linen", "gas", "asset", "service"]
                .map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-sm">
            {/* The hint sits OUTSIDE the <label>: inside, it becomes part of the field's
                accessible name, and a screen reader would announce the whole paragraph as the
                label. Found by the screen test, which could not address the field at all. */}
            <label className="flex flex-col gap-1">
              {t("materialsItems.baseUom")}
              <input className="rounded border px-2 py-1" value={baseUom} onChange={(e) => setBaseUom(e.target.value)} />
            </label>
            <span className="text-xs text-slate-500">{t("materialsItems.baseUomHint")}</span>
          </div>
          {/* DD3 — the medicine field exists ONLY for a drug. */}
          {isDrug && (
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex flex-col gap-1">
                {t("materialsItems.formularyMedicine")}
                <input
                  className="rounded border px-2 py-1" value={medicineId}
                  onChange={(e) => setMedicineId(e.target.value)}
                />
              </label>
              <span className="text-xs text-slate-500">{t("materialsItems.formularyMedicineHint")}</span>
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsItems.shelfLifeDays")}
            <input
              className="rounded border px-2 py-1" inputMode="numeric" value={shelfLifeDays}
              onChange={(e) => setShelfLifeDays(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("materialsItems.packUom")}
            <input className="rounded border px-2 py-1" value={packUom} onChange={(e) => setPackUom(e.target.value)} />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <label className="flex flex-col gap-1">
              {t("materialsItems.packMultiplier")}
              <input
                className="rounded border px-2 py-1" inputMode="numeric" value={packMultiplier}
                onChange={(e) => setPackMultiplier(e.target.value)}
              />
            </label>
            <span className="text-xs text-slate-500">{t("materialsItems.packMultiplierHint")}</span>
          </div>
        </div>
        <Button onClick={() => void submit()}>{t("materialsItems.create")}</Button>
      </section>

      <section className="space-y-3">
        <label className="flex flex-col gap-1 text-sm sm:max-w-sm">
          {t("materialsItems.search")}
          <input
            className="rounded border px-2 py-1" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {items.isLoading && <p>{t("common.loading")}</p>}
        {items.data !== undefined && items.data.length === 0 && <p>{t("materialsItems.empty")}</p>}
        {items.data !== undefined && items.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>{t("materialsItems.code")}</th>
                <th>{t("materialsItems.name")}</th>
                <th>{t("materialsItems.class")}</th>
                <th>{t("materialsItems.baseUom")}</th>
                <th>{t("materialsItems.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.data.map((it) => (
                <tr key={it.id} className="border-t">
                  <td>{it.code}</td>
                  <td>{it.name}</td>
                  <td>{it.class}</td>
                  <td>{it.baseUom}</td>
                  <td>{it.active ? t("materialsItems.active") : t("materialsItems.retired")}</td>
                  <td>
                    <Button variant="secondary" onClick={() => void toggleActive(it)}>
                      {it.active ? t("materialsItems.retire") : t("materialsItems.reactivate")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
