import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchPharmacySettings, pharmacyErrorText, savePharmacySettings } from "../../lib/pharmacy-api";
import { OfficeHead } from "./office-page";

/**
 * ═══ OWNER RULING 2026-10-02 — THE DESK'S SETTINGS (Law → Desk mode) ═══
 *
 * ONE setting: quick desk mode. OFF by default. The page says exactly which three checks stand down
 * while it is on, and what stays — the person switching it reads that before the tap, not after.
 * Shown to holders of `pharmacy.licences.manage` (`pages.ts`), the grant the server checks on the
 * write; the server audits every change (`pharmacy_settings.changed`).
 */
export function DeskSettingsView(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pharmacy", "settings"], queryFn: fetchPharmacySettings });
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: savePharmacySettings,
    onSuccess: (s) => {
      qc.setQueryData(["pharmacy", "settings"], s);
      setNotice(s.quickDesk ? t("deskSettings.savedOn") : t("deskSettings.savedOff"));
    },
  });
  const on = q.data?.quickDesk ?? false;
  const error = q.error ?? save.error;

  return (
    <div className="space-y-4" data-testid="desk-settings">
      <OfficeHead title={t("deskSettings.title")} lead={t("deskSettings.lead")} />
      {error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {q.data !== undefined && (
        <div className="ofp-box">
          <div className="flex flex-wrap items-start gap-3 p-3 sm:flex-nowrap" data-testid="setting-quick-desk">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-sm font-medium" id="quick-desk-label">{t("deskSettings.quickDesk.label")}</div>
              <p className="text-sm text-muted-foreground">{on ? t("deskSettings.quickDesk.whenOn") : t("deskSettings.quickDesk.whenOff")}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>{t("deskSettings.quickDesk.skips.photo")}</li>
                <li>{t("deskSettings.quickDesk.skips.registration")}</li>
                <li>{t("deskSettings.quickDesk.skips.slip")}</li>
              </ul>
              <p className="text-sm text-muted-foreground">{t("deskSettings.quickDesk.stays")}</p>
              <p className="rounded border border-amber-400 bg-amber-50/60 px-2 py-1 text-sm" data-testid="setting-quick-desk-law">
                {t("deskSettings.quickDesk.law")}
              </p>
            </div>
            <button
              type="button" role="switch" aria-checked={on} aria-labelledby="quick-desk-label"
              data-testid="setting-quick-desk-switch"
              disabled={save.isPending}
              onClick={() => { setNotice(null); save.mutate({ quickDesk: !on }); }}
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
