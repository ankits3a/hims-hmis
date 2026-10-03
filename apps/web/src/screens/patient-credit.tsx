import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "../lib/api";
import { fmtPaise } from "../lib/format";
import type { CreditSettlement } from "../lib/reports-api";

/**
 * Owner 2026-10-03 — the patient's credit, as ONE line in the profile's left lane: the credit available
 * with the hospital across every department (advances and credit-note money kept rather than refunded).
 * A click opens the full account in a dialog: what of it is pharmacy credit, every credit note against
 * which bill and department with what became of its money, and every refund voucher. Nothing of it is
 * spread over the middle column (`GET /pharmacy/patients/:id/credit`).
 */
export type WirePatientCredit = {
  totalAvailablePaise: number;
  availablePaise: number;
  totalNetPaise: number;
  notes: {
    id: string; creditNoteNo: string; date: string; invoiceNo: string; reason: string; netPaise: number; issuedByName: string;
    settlement: CreditSettlement; keptPaise: number; refundPaise: number; categories: string[];
  }[];
  refunds: { id: string; voucherNo: string; kind: string; creditNoteNo: string | null; amountPaise: number; method: string; status: string; issuedAt: string; paidAt: string | null; reason: string }[];
};
export const CREDIT_READERS = ["billing.invoice.read", "pharmacy.dispense.read", "pharmacy.reports.read", "billing.dues.patient.read"] as const;

const dmy = (iso: string): string => iso.slice(0, 10).split("-").reverse().join("-");
const th = { textAlign: "left", fontWeight: 500, color: "var(--dim)", padding: "4px 6px" } as const;
const td = { padding: "5px 6px", borderTop: "1px solid var(--line2)", verticalAlign: "top" } as const;

export function CreditTile({ patientId }: { patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["pf-credit", patientId],
    queryFn: () => api<WirePatientCredit>("GET", `/pharmacy/patients/${encodeURIComponent(patientId)}/credit`),
    retry: false,
  });
  const d = q.data;
  if (d === undefined) return null;
  return (
    <>
      <button type="button" className="fact" data-testid="pf-credit-tile" onClick={() => setOpen(true)}
        style={{ width: "100%", marginTop: 10, textAlign: "left", cursor: "pointer", background: "none", border: 0, padding: 0 }}>
        <span>{t("profile.credit.tile")}</span>
        <span>
          <b className="mo" style={{ color: d.totalAvailablePaise > 0 ? "var(--green)" : undefined }}>{fmtPaise(d.totalAvailablePaise)}</b>
          <span style={{ color: "var(--dim)", marginLeft: 6 }}>{t("profile.credit.details")} ›</span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="pp" style={{ maxWidth: 820, width: "calc(100vw - 32px)", maxHeight: "86vh", overflowY: "auto" }} data-testid="pf-credit-dialog">
          <DialogHeader><DialogTitle>{t("profile.credit.title")}</DialogTitle></DialogHeader>
          <div className="today" data-testid="pf-credit-summary">
            <div><b className="mo">{fmtPaise(d.totalAvailablePaise)}</b><div className="s">{t("profile.credit.total")}</div></div>
            <div><b className="mo">{fmtPaise(d.availablePaise)}</b><div className="s">{t("profile.credit.pharmacy")}</div></div>
            <div><b className="mo">{fmtPaise(Math.max(0, d.totalAvailablePaise - d.availablePaise))}</b><div className="s">{t("profile.credit.other")}</div></div>
          </div>

          <h4 style={{ margin: "14px 0 4px", fontSize: 13.5, fontWeight: 600 }}>{t("profile.credit.notes", { count: d.notes.length, amount: fmtPaise(d.totalNetPaise) })}</h4>
          {d.notes.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)", margin: 0 }}>{t("profile.credit.noNotes")}</p> : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }} data-testid="pf-credit-notes">
              <thead><tr>
                <th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.credit.no")}</th><th style={th}>{t("profile.credit.bill")}</th>
                <th style={th}>{t("profile.credit.dept")}</th><th style={th}>{t("profile.credit.reason")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("profile.credit.value")}</th><th style={th}>{t("profile.credit.money")}</th>
              </tr></thead>
              <tbody>{d.notes.map((n) => (
                <tr key={n.id} data-testid={`pf-credit-note-${n.id}`}>
                  <td style={td}>{dmy(n.date)}</td><td style={td} className="mo">{n.creditNoteNo}</td><td style={td} className="mo">{n.invoiceNo}</td>
                  <td style={td}>{n.categories.map((c) => t(`profile.credit.cat.${c}`, c)).join(", ")}</td>
                  <td style={td}>{n.reason.replace(/^pharmacy return: /, "")}<div style={{ fontSize: 11, color: "var(--dim)" }}>{n.issuedByName}</div></td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{fmtPaise(n.netPaise)}</td>
                  <td style={td}>{t(`pharmacyOffice.reports.credit.settlement.${n.settlement}`)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <h4 style={{ margin: "14px 0 4px", fontSize: 13.5, fontWeight: 600 }}>{t("profile.credit.refunds", { count: d.refunds.length })}</h4>
          {d.refunds.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)", margin: 0 }}>{t("profile.credit.noRefunds")}</p> : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }} data-testid="pf-credit-refunds">
              <thead><tr>
                <th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.credit.voucher")}</th><th style={th}>{t("profile.credit.against")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("profile.credit.amount")}</th><th style={th}>{t("profile.credit.method")}</th><th style={th}>{t("profile.credit.status")}</th>
              </tr></thead>
              <tbody>{d.refunds.map((r) => (
                <tr key={r.id} data-testid={`pf-credit-refund-${r.id}`}>
                  <td style={td}>{dmy(r.issuedAt)}</td><td style={td} className="mo">{r.voucherNo}</td>
                  <td style={td}>{r.creditNoteNo ?? t(`profile.credit.kind.${r.kind}`, r.kind)}<div style={{ fontSize: 11, color: "var(--dim)" }}>{r.reason}</div></td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{fmtPaise(r.amountPaise)}</td>
                  <td style={td}>{t(`profile.credit.methodName.${r.method}`, r.method)}</td>
                  <td style={td}>{r.status === "paid" && r.paidAt !== null ? t("profile.credit.paidOn", { date: dmy(r.paidAt) }) : t(`profile.credit.voucherStatus.${r.status}`, r.status)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
