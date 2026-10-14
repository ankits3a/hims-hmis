import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { billingErrorMessage, billingPatientLabel } from "../../lib/billing-api";
import { fmtIst, fmtPaise } from "../../lib/format";

/**
 * ═══ #647 — TELE-CALL BILLS THAT FAILED ═══
 *
 * When the doctor says "Spoke to patient", 'spoke' and the consultation invoice are written together or
 * not at all. A refused invoice used to leave only a `tele.bill_failed` event, which nobody saw. This
 * page lists every such visit still waiting (`GET /opd/tele/bill-failures`), with the billing side's
 * reason, and retries the invoice once the cause is fixed. A raised bill then waits for the doctor,
 * whose next "Spoke" goes through; the row leaves the list when it does.
 *
 * Billing office only — the routes are guarded on `billing.invoice.issue`; nothing here reaches a
 * doctor's screen (owner 2026-10-09).
 */
export type WireTeleBillFailure = {
  encounterId: string; visitNo: string; appointmentId: string | null;
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean } | null;
  doctorName: string | null; slotStart: string | null; quotePaise: number | null;
  firstFailedAt: string; lastFailedAt: string; lastCode: string; attempts: number;
  state: "open" | "billed";
};

const POLL_MS = 15_000;
const KEY = ["opd", "tele", "bill-failures"] as const;

export function TeleBills(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<{ items: WireTeleBillFailure[] }>("GET", "/opd/tele/bill-failures"), refetchInterval: POLL_MS });
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const retry = useMutation({
    mutationFn: (encounterId: string) => api<{ encounterId: string; state: "billed" }>("POST", `/opd/tele/bill-failures/${encodeURIComponent(encounterId)}/retry`),
    onMutate: () => { setRowError(null); },
    onError: (e, encounterId) => { setRowError({ id: encounterId, message: billingErrorMessage(e) }); },
    onSettled: async () => { await qc.invalidateQueries({ queryKey: KEY }); },
  });

  if (q.error !== null) return <p role="alert" className="text-sm text-red-600">{billingErrorMessage(q.error)}</p>;
  if (q.data === undefined) return <p className="text-sm text-neutral-500">{t("teleBills.loading")}</p>;
  const rows = q.data.items;
  return (
    <div className="space-y-3" data-testid="tele-bills">
      <p className="text-sm text-neutral-600">{t("teleBills.lead")}</p>
      {rows.length === 0 ? (
        <p data-testid="tele-bills-none" className="text-sm text-neutral-500">{t("teleBills.none")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.encounterId} data-testid={`tele-bill-${r.encounterId}`} className="drow"
              style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 14px", padding: "10px 0", borderTop: "1px solid var(--line2)" }}>
              <span style={{ minWidth: 160 }}>
                <span className="block font-semibold">{r.patient === null ? "—" : billingPatientLabel(r.patient)}</span>
                <span className="block mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{r.patient?.uhid ?? ""} · {r.visitNo}</span>
              </span>
              <span style={{ minWidth: 140 }}>
                <span className="block">{r.doctorName ?? "—"}</span>
                <span className="block mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{r.slotStart === null ? "" : `${t("teleBills.slot")} ${fmtIst(r.slotStart)}`}</span>
              </span>
              <span className="mo tabular-nums">{r.quotePaise === null ? "—" : fmtPaise(r.quotePaise)}</span>
              <span style={{ flex: "1 1 200px", minWidth: 0, fontSize: 12.5, color: "var(--dim)" }}>
                {t("teleBills.tries", { count: r.attempts })} · {t("teleBills.last")} {fmtIst(r.lastFailedAt)} · <span className="mo">{r.lastCode}</span>
              </span>
              {r.state === "billed" ? (
                <span data-testid={`tele-bill-state-${r.encounterId}`} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>{t("teleBills.billed")}</span>
              ) : (
                <button type="button" className="pri" disabled={retry.isPending} onClick={() => { retry.mutate(r.encounterId); }}>{t("teleBills.retry")}</button>
              )}
              {rowError?.id === r.encounterId && <p role="alert" className="text-sm text-red-600" style={{ flexBasis: "100%", margin: 0 }}>{rowError.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
