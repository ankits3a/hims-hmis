import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { fetchStewardship, formularyErrorMessage, searchMedicines, setStewardship } from "../lib/formulary-api";
import type { WireMedicineHit, WireStewardship } from "../lib/formulary-api";

const CLASSES = ["Access", "Watch", "Reserve"] as const;

/**
 * ═══ PHARMACY STAGE D5 — A PRODUCT'S WHO AWaRe CLASS AND ITS STEWARD RESTRICTION ═══
 *
 * `seed:pharmacy` classifies the catalogue from the cited WHO AWaRe 2023 list and starts every Reserve product and
 * every carbapenem restricted; this is where a pharmacist corrects a class or restricts more (a hospital's own AMSP
 * list). Find the product by the typeahead the consult uses, read its two fields, change them, save. A restricted
 * product does not leave the counter without the antimicrobial steward's approval.
 */
export function FormularyStewardship(): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [ask, setAsk] = useState("");
  const [picked, setPicked] = useState<WireMedicineHit | null>(null);
  const [form, setForm] = useState<{ awareCategory: WireStewardship["awareCategory"]; antimicrobialRestricted: boolean } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setAsk(q.trim()); }, 250);
    return () => { clearTimeout(timer); };
  }, [q]);
  const hits = useQuery({ queryKey: ["formulary", "stewardship-search", ask], queryFn: () => searchMedicines(ask, 10), enabled: ask.length >= 2 && picked === null });
  const current = useQuery({ queryKey: ["formulary", "stewardship", picked?.id], queryFn: () => fetchStewardship(picked!.id), enabled: picked !== null });
  useEffect(() => {
    if (current.data !== undefined) setForm({ awareCategory: current.data.awareCategory, antimicrobialRestricted: current.data.antimicrobialRestricted });
  }, [current.data]);

  const save = async (): Promise<void> => {
    if (picked === null || form === null) return;
    setError(null); setSaid(null);
    try {
      await setStewardship(picked.id, form);
      await current.refetch();
      setSaid(t("formularyAdmin.stewardship.saved", { name: picked.name }));
    } catch (e) {
      setError(formularyErrorMessage(e));
    }
  };

  return (
    <div data-testid="formulary-stewardship" className="space-y-2 rounded border p-3">
      <h2 className="font-medium">{t("formularyAdmin.stewardship.title")}</h2>
      <p className="text-xs text-neutral-600">{t("formularyAdmin.stewardship.intro")}</p>
      <input
        className="w-full rounded border px-2 py-1 text-sm"
        data-testid="stewardship-search"
        aria-label={t("formularyAdmin.stewardship.searchLabel")}
        placeholder={t("formularyAdmin.stewardship.searchPlaceholder")}
        value={picked === null ? q : picked.name}
        onChange={(e) => { setPicked(null); setForm(null); setSaid(null); setQ(e.target.value); }}
      />
      {picked === null && (hits.data ?? []).length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="stewardship-hits">
          {(hits.data ?? []).map((h) => (
            <li key={h.id}>
              <button type="button" className="text-left underline" data-testid={`stewardship-hit-${h.id}`} onClick={() => { setPicked(h); setSaid(null); }}>
                {h.name} <span className="text-xs text-neutral-600">{h.salts.join(" + ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked !== null && form !== null && (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            {t("formularyAdmin.stewardship.aware")}
            <select
              data-testid="stewardship-aware"
              className="rounded border px-1 py-0.5"
              value={form.awareCategory ?? ""}
              onChange={(e) => setForm({ ...form, awareCategory: e.target.value === "" ? null : e.target.value as (typeof CLASSES)[number] })}
            >
              <option value="">{t("formularyAdmin.stewardship.awareNone")}</option>
              {CLASSES.map((c) => <option key={c} value={c}>{t(`formularyAdmin.stewardship.${c}`)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="stewardship-restricted"
              checked={form.antimicrobialRestricted}
              onChange={(e) => setForm({ ...form, antimicrobialRestricted: e.target.checked })}
            />
            {t("formularyAdmin.stewardship.restricted")}
          </label>
          <Button type="button" size="sm" data-testid="stewardship-save" onClick={() => void save()}>{t("formularyAdmin.stewardship.save")}</Button>
        </div>
      )}
      {said !== null && <p data-testid="stewardship-saved" className="text-sm text-emerald-700">{said}</p>}
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
