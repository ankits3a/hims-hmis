import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { fmtPaise } from "../lib/format";
import type { CreditSettlement } from "../lib/reports-api";

/**
 * Owner 2026-10-03 — on a patient's profile: the pharmacy credit available in their name now, and every
 * credit note on their bills with what became of its money (`GET /pharmacy/patients/:id/credit`).
 */
export type WirePatientCredit = {
  availablePaise: number;
  totalNetPaise: number;
  notes: { id: string; creditNoteNo: string; date: string; invoiceNo: string; reason: string; netPaise: number; settlement: CreditSettlement; keptPaise: number; refundPaise: number }[];
};
export const CREDIT_READERS = ["billing.invoice.read", "pharmacy.dispense.read", "pharmacy.reports.read", "billing.dues.patient.read"] as const;
const SHOWN = 5;

export function PatientCredit({ patientId }: { patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: ["pf-credit", patientId],
    queryFn: () => api<WirePatientCredit>("GET", `/pharmacy/patients/${encodeURIComponent(patientId)}/credit`),
    retry: false,
  });
  const d = q.data;
  if (d === undefined) return null;
  const notes = all ? d.notes : d.notes.slice(0, SHOWN);
  return (
    <section data-testid="pf-credit" style={{ marginTop: 18 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600 }}>{t("profile.credit.title")}</h3>
      <div className="today">
        <div data-testid="pf-credit-available">
          <b style={{ color: d.availablePaise > 0 ? "var(--green)" : undefined }}>{t("profile.credit.available", { amount: fmtPaise(d.availablePaise) })}</b>
          <div className="s">{t("profile.credit.availableNote")}</div>
        </div>
        <div data-testid="pf-credit-notes-total">
          <b>{t("profile.credit.notes", { count: d.notes.length, amount: fmtPaise(d.totalNetPaise) })}</b>
        </div>
      </div>
      {notes.length === 0 ? null : (
        <table style={{ width: "100%", fontSize: 12, marginTop: 8, borderCollapse: "collapse" }} data-testid="pf-credit-list">
          <thead>
            <tr style={{ color: "var(--dim)", textAlign: "left" }}>
              <th>{t("profile.credit.date")}</th><th>{t("profile.credit.no")}</th><th>{t("profile.credit.bill")}</th>
              <th style={{ textAlign: "right" }}>{t("profile.credit.value")}</th><th>{t("profile.credit.money")}</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id} style={{ borderTop: "1px solid var(--line2)" }} title={n.reason}>
                <td>{n.date.split("-").reverse().join("-")}</td><td className="mo">{n.creditNoteNo}</td><td className="mo">{n.invoiceNo}</td>
                <td style={{ textAlign: "right" }} className="mo">{fmtPaise(n.netPaise)}</td>
                <td>{t(`pharmacyOffice.reports.credit.settlement.${n.settlement}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.notes.length > SHOWN ? (
        <button type="button" className="lnk" onClick={() => setAll((v) => !v)}>{all ? t("profile.credit.fewer") : t("profile.credit.all", { count: d.notes.length })}</button>
      ) : null}
    </section>
  );
}
