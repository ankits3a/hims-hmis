import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { createItem, fetchItems, materialsErrorText, patchItem } from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import { ItemEditPanel } from "./materials-item-edit";
import { NewButton, OfficeHead, fieldCls, labelCls, useNewKey } from "./pharmacy-office/office-page";
import { Sheet } from "./pharmacy-office/sheet";
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
  /* GAP CLOSURE A2 — the item whose master fields are open for editing. */
  const [editId, setEditId] = useState<string | null>(null);
  /* GAP-CLOSURE B5 — registering an item is a sheet over the list (N), never a form above it. */
  const [newOpen, setNewOpen] = useState(false);

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
      setNewOpen(false);
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

  /* GAP-CLOSURE B5 — one list: what is in use first, then what was retired, then what was merged away. */
  const rank = (it: WireItem): number => ((it.mergedIntoItemId ?? null) !== null ? 2 : it.active ? 0 : 1);
  const rows = [...(items.data ?? [])].sort((a, b) => rank(a) - rank(b));
  const openNew = (): void => { setError(null); setDone(null); setNewOpen(true); };
  useNewKey(openNew);
  const editing = editId === null ? undefined : rows.find((x) => x.id === editId);

  return (
    <div className="space-y-4" data-testid="materials-items">
      <OfficeHead title={t("materialsItems.title")} lead={t("materialsItems.lead")}>
        <NewButton label={t("materialsItems.newItem")} onClick={openNew} testId="item-new" />
      </OfficeHead>

      {!newOpen && error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {done !== null && <p role="status" className="text-sm text-green-700">{done}</p>}

      <input
        aria-label={t("materialsItems.search")} placeholder={t("materialsItems.searchHint")}
        className={`${fieldCls} ofp-search`} value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="ofp-box">
        {items.isLoading && <p className="ofp-empty">{t("common.loading")}</p>}
        {items.data !== undefined && items.data.length === 0 && <p className="ofp-empty">{t("materialsItems.empty")}</p>}
        {rows.length > 0 && (
          <div className="ofp-scroll">
            <table className="ofp-table min-w-[44rem]">
              <thead>
                <tr>
                  <th>{t("materialsItems.code")}</th>
                  <th>{t("materialsItems.name")}</th>
                  <th>{t("materialsItems.class")}</th>
                  <th>{t("materialsItems.baseUom")}</th>
                  <th>{t("materialsItems.status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => {
                  const merged = (it.mergedIntoItemId ?? null) !== null;
                  return (
                    <tr key={it.id} className={merged || !it.active ? "ofp-dim" : ""}>
                      <td className="ofp-code">{it.code}</td>
                      <td>
                        {it.name}
                        {it.highAlert === true && <span className="pill rd ml-2">{t("materialsItems.edit.highAlertTag")}</span>}
                        {it.lasa === true && <span className="pill gd ml-2">{t("materialsItems.edit.lasaTag")}</span>}
                      </td>
                      <td>{it.class}</td>
                      <td>{it.baseUom}</td>
                      <td data-testid={`item-status-${it.code}`}>
                        {merged
                          ? <span className="pill">{t("materialsItems.mergedInto", { code: items.data?.find((x) => x.id === it.mergedIntoItemId)?.code ?? "—" })}</span>
                          : it.active ? <span className="pill on">{t("materialsItems.active")}</span> : <span className="pill">{t("materialsItems.retired")}</span>}
                      </td>
                      <td>
                        {/* PHARMACY P6 — a merged item is history: it is never switched back on (the server refuses it too). */}
                        {!merged && (
                          <div className="ofp-rowacts">
                            <Button variant="outline" size="sm" aria-label={t("materialsItems.edit.open", { code: it.code })} onClick={() => setEditId(it.id)}>
                              {t("materialsItems.edit.button")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => void toggleActive(it)}>
                              {it.active ? t("materialsItems.retire") : t("materialsItems.reactivate")}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* GAP CLOSURE A2 — the item's master fields, in a sheet over the list. */}
      {editId !== null && (
        <Sheet title={editing === undefined ? t("materialsItems.edit.button") : `${editing.code} · ${editing.name}`} testId="item-edit-sheet" onClose={() => setEditId(null)}>
          <ItemEditPanel key={editId} itemId={editId} onClose={() => setEditId(null)} />
        </Sheet>
      )}

      {newOpen && (
        <Sheet title={t("materialsItems.newItem")} testId="item-new-sheet" onClose={() => setNewOpen(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelCls}>
                {t("materialsItems.code")}
                <input className={fieldCls} value={code} onChange={(e) => setCode(e.target.value)} />
              </label>
              <label className={labelCls}>
                {t("materialsItems.name")}
                <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className={labelCls}>
                {t("materialsItems.class")}
                <select className={fieldCls} value={itemClass} onChange={(e) => setItemClass(e.target.value)}>
                  {["drug", "consumable", "consumable_dated", "reagent", "implant", "stationery", "linen", "gas", "asset", "service"]
                    .map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <div className={labelCls}>
                {/* The hint sits OUTSIDE the <label>: inside, it becomes part of the field's
                    accessible name, and a screen reader would announce the whole paragraph as the
                    label. Found by the screen test, which could not address the field at all. */}
                <label className="flex flex-col gap-1">
                  {t("materialsItems.baseUom")}
                  <input className={fieldCls} value={baseUom} onChange={(e) => setBaseUom(e.target.value)} />
                </label>
                <span className="text-xs text-muted-foreground">{t("materialsItems.baseUomHint")}</span>
              </div>
              {/* DD3 — the medicine field exists ONLY for a drug. */}
              {isDrug && (
                <div className={labelCls}>
                  <label className="flex flex-col gap-1">
                    {t("materialsItems.formularyMedicine")}
                    <input className={fieldCls} value={medicineId} onChange={(e) => setMedicineId(e.target.value)} />
                  </label>
                  <span className="text-xs text-muted-foreground">{t("materialsItems.formularyMedicineHint")}</span>
                </div>
              )}
              <label className={labelCls}>
                {t("materialsItems.shelfLifeDays")}
                <input className={fieldCls} inputMode="numeric" value={shelfLifeDays} onChange={(e) => setShelfLifeDays(e.target.value)} />
              </label>
              <label className={labelCls}>
                {t("materialsItems.packUom")}
                <input className={fieldCls} value={packUom} onChange={(e) => setPackUom(e.target.value)} />
              </label>
              <div className={labelCls}>
                <label className="flex flex-col gap-1">
                  {t("materialsItems.packMultiplier")}
                  <input className={fieldCls} inputMode="numeric" value={packMultiplier} onChange={(e) => setPackMultiplier(e.target.value)} />
                </label>
                <span className="text-xs text-muted-foreground">{t("materialsItems.packMultiplierHint")}</span>
              </div>
            </div>
            <Button type="submit">{t("materialsItems.create")}</Button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
