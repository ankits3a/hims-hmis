import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { applyGstPlan, fetchGstPlan, pharmacyErrorText } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";

/**
 * ═══ PHARMACY P16 — THE GST SLAB OF EVERY DRUG, AGAINST THE NOTIFICATION ═══
 *
 * The server judges each active drug item (5% for medicaments; nil for the 36 drugs listed in
 * Notification 9/2025-CT(Rate)) and says which slabs are blank, which differ and which sale
 * categories no longer follow their slab. The pharmacist applies it: blanks and stale categories
 * always, differing slabs only when they tick the box. The rates are the CA's to confirm; this is
 * the list to show them.
 */
const pct = (bps: number | null, nil: string): string => (bps === null ? "—" : bps === 0 ? nil : `${String(bps / 100)}%`);

export function GstSlabPanel(): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [overwrite, setOverwrite] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = useQuery({ queryKey: ["pharmacy", "gst-plan"], queryFn: fetchGstPlan });
  if (plan.data === undefined) return null;
  const rows = plan.data.filter((p) => p.verdict !== "ok" || p.categoryStale);
  const apply = async (): Promise<void> => {
    setError(null); setNote(null);
    try {
      const r = await applyGstPlan(overwrite);
      setNote(t("pharmacyItems.gstApplied", { slabs: r.slabsSet, categories: r.categoriesSynced }));
      await qc.invalidateQueries({ queryKey: ["pharmacy"] });
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    }
  };
  return (
    <section className="space-y-2" data-testid="gst-slab-panel">
      <h2 className="text-lg font-medium">{t("pharmacyItems.gstTitle")}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyItems.gstIntro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {note !== null && <p role="status" className="text-sm text-green-700">{note}</p>}
      {rows.length === 0 ? <p className="text-sm">{t("pharmacyItems.gstAllOk", { n: plan.data.length })}</p> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="pr-3">{t("pharmacyItems.item")}</th>
                  <th className="pr-3">{t("pharmacyItems.gstNow")}</th>
                  <th className="pr-3">{t("pharmacyItems.gstSuggested")}</th>
                  <th className="pr-3">{t("pharmacyItems.gstVerdict")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId} data-testid={`gst-${r.code}`}>
                    <td className="pr-3">{r.name} <span className="text-xs text-muted-foreground">{r.code}</span></td>
                    <td className="pr-3">{pct(r.current, t("pharmacyItems.nil"))}</td>
                    <td className="pr-3" title={r.basis ?? ""}>{pct(r.suggested, t("pharmacyItems.nil"))}</td>
                    <td className="pr-3">
                      {t(`pharmacyItems.gst_${r.verdict}`)}
                      {r.categoryStale && <span className="ml-1 text-amber-800">· {t("pharmacyItems.gstStale")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            {t("pharmacyItems.gstOverwrite")}
          </label>
          <Button type="button" onClick={() => void apply()}>{t("pharmacyItems.gstApply")}</Button>
        </>
      )}
    </section>
  );
}
