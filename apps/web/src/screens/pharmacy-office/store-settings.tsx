import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchMaterialsSettings, materialsErrorText, saveMaterialsSettings } from "../../lib/materials-api";
import { OfficeHead } from "./office-page";

/**
 * ═══ OWNER RULING 2026-09-30 — THE STORES' SETTINGS (Stock → Stores settings) ═══
 *
 * The owner, the pharmacy's first live morning: *"the system should recommend to enforce two different
 * people later via settings screen but currently admin login can do both."* So the page carries ONE
 * setting today — a different person checks a goods receipt than the one who captured it — OFF by
 * default, with the recommendation printed beside the switch rather than enforced.
 *
 * The page is shown to holders of `materials.stores.manage` (`pages.ts`), the grant the server checks
 * on the write; the server audits every change (`store_settings.changed`). The switch saves at once:
 * one setting, one tap, and the status line says what is now true.
 */
export function StoreSettingsView(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["materials", "settings"], queryFn: fetchMaterialsSettings });
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: saveMaterialsSettings,
    onSuccess: async (s) => {
      qc.setQueryData(["materials", "settings"], s);
      setNotice(s.grnQcNeedsSecondPerson ? t("storeSettings.savedOn") : t("storeSettings.savedOff"));
      await qc.invalidateQueries({ queryKey: ["materials", "grns"] });
    },
  });
  const on = q.data?.grnQcNeedsSecondPerson ?? false;
  const error = q.error ?? save.error;

  return (
    <div className="space-y-4" data-testid="store-settings">
      <OfficeHead title={t("storeSettings.title")} lead={t("storeSettings.lead")} />
      {error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {q.data !== undefined && (
        <div className="ofp-box">
          <div className="flex flex-wrap items-start gap-3 p-3 sm:flex-nowrap" data-testid="setting-grn-two-person">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-sm font-medium" id="grn-two-person-label">{t("storeSettings.grnTwoPerson.label")}</div>
              <p className="text-sm text-muted-foreground">
                {on ? t("storeSettings.grnTwoPerson.whenOn") : t("storeSettings.grnTwoPerson.whenOff")}
              </p>
              <p className="rounded border border-amber-400 bg-amber-50/60 px-2 py-1 text-sm" data-testid="setting-grn-two-person-recommend">
                {t("storeSettings.grnTwoPerson.recommend")}
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={on} aria-labelledby="grn-two-person-label"
              data-testid="setting-grn-two-person-switch"
              disabled={save.isPending}
              onClick={() => { setNotice(null); save.mutate({ grnQcNeedsSecondPerson: !on }); }}
              className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium ${on ? "border-emerald-800 bg-emerald-800 text-white" : "bg-background"}`}
            >
              <span aria-hidden className={`inline-block h-4 w-4 rounded-full ${on ? "bg-white" : "bg-neutral-400"}`} />
              {on ? t("storeSettings.on") : t("storeSettings.off")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
