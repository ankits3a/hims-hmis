import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { billingErrorMessage, fetchFeeSwitches, saveFeeSwitch } from "../../lib/billing-api";
import { fmtPaise } from "../../lib/format";
import type { FeeKind } from "../../lib/billing-api";

/**
 * ═══ THE FEE SWITCHES (owner, 2026-10-01) ═══
 *
 * *"The OPD consultation fee is currently zero, tests are free right now. Add a system (a toggle
 * option) to enable/disable any fees."* One row per fee, one switch each, saved on the tap. The row
 * says in a sentence what the desk will do while it stands as it is, because "off" on a money
 * switch is ambiguous until somebody says whether off means free or closed. Here it means FREE.
 *
 * Everybody who opens the back office may read the switches; the server lets only
 * `billing.config.write` change one, and audits each change (`fee_switch.changed`).
 */
const istWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function FeeSwitches(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["billing", "fee-switches"], queryFn: fetchFeeSwitches });
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: saveFeeSwitch,
    onSuccess: async (view, sent) => {
      qc.setQueryData(["billing", "fee-switches"], view);
      setNotice(t(`feeSwitches.saved.${sent.kind}.${sent.off ? "off" : "on"}`));
      // Every open quote and queue priced under the old state is now wrong.
      await qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "billing" || query.queryKey[1] !== "fee-switches" });
    },
  });
  const mayChange = can("billing.config.write");
  const error = q.error ?? save.error;
  const price = (paise: number | null | undefined): string => (paise === null || paise === undefined ? t("feeSwitches.opdConsult.unpriced") : fmtPaise(paise));

  return (
    <div className="space-y-4" data-testid="fee-switches">
      <p className="text-sm text-muted-foreground">{t("feeSwitches.lead")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(error)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {!mayChange && <p className="text-sm text-muted-foreground" data-testid="fee-switches-readonly">{t("feeSwitches.readOnly")}</p>}
      {q.data?.switches.map((sw) => {
        const kind: FeeKind = sw.kind;
        const charged = !sw.off;
        const state = t(charged ? "feeSwitches.charged" : "feeSwitches.free");
        return (
          <div key={kind} className="rounded-lg border bg-white" data-testid={`fee-${kind}`}>
            <div className="flex flex-wrap items-start gap-3 p-3 sm:flex-nowrap">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium" id={`fee-${kind}-label`}>{t(`feeSwitches.${kind}.label`)}</div>
                <p className="text-sm">
                  {t(`feeSwitches.${kind}.${charged ? "whenOn" : "whenOff"}`, { new: price(q.data.consultPaise.new), renewal: price(q.data.consultPaise.renewal) })}
                </p>
                <p className="text-sm text-muted-foreground">{t(`feeSwitches.${kind}.note`)}</p>
                <p className="text-xs text-muted-foreground" data-testid={`fee-${kind}-since`}>
                  {sw.changedAt === null ? t("feeSwitches.never") : t("feeSwitches.since", { state, when: istWhen(sw.changedAt) })}
                </p>
              </div>
              <button
                type="button" role="switch" aria-checked={charged} aria-labelledby={`fee-${kind}-label`}
                data-testid={`fee-${kind}-switch`}
                disabled={!mayChange || save.isPending}
                onClick={() => { setNotice(null); save.mutate({ kind, off: charged }); }}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium disabled:opacity-60 ${charged ? "border-emerald-800 bg-emerald-800 text-white" : "bg-background"}`}
              >
                <span aria-hidden className={`inline-block h-4 w-4 rounded-full ${charged ? "bg-white" : "bg-neutral-400"}`} />
                {state}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
