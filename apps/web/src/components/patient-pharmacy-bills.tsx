import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtPaise } from "../lib/format";
import { CREDIT_READERS } from "./patient-credit";

/**
 * Owner 2026-10-03 — the patient's pharmacy bills, one line in the profile's left lane; a click lists each
 * ticket with its invoice, GST, the credit notes against it and the earlier credit spent on it
 * (`GET /pharmacy/patients/:id/pharmacy-bills`). Nothing of it in the middle column.
 */
type Bill = {
  invoiceId: string; invoiceNo: string; date: string; ticket: string | null; source: "dispense" | "walk_in";
  netPaise: number; gstPaise: number; creditUsedPaise: number; returnedPaise: number; finalPaise: number;
  creditNotes: { id: string; creditNoteNo: string; date: string; netPaise: number }[];
};
const dmy = (iso: string): string => iso.slice(0, 10).split("-").reverse().join("-");
const th = { textAlign: "left", fontWeight: 500, color: "var(--dim)", padding: "4px 6px" } as const;
const td = { padding: "5px 6px", borderTop: "1px solid var(--line2)", verticalAlign: "top" } as const;

export function PharmacyBillsTile({ patientId }: { patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const allowed = CREDIT_READERS.some((p) => can(p));
  const q = useQuery({
    queryKey: ["pf-pharmacy-bills", patientId],
    queryFn: () => api<{ bills: Bill[] }>("GET", `/pharmacy/patients/${encodeURIComponent(patientId)}/pharmacy-bills`),
    enabled: allowed, retry: false,
  });
  const bills = q.data?.bills;
  if (!allowed || bills === undefined) return null;
  const final = bills.reduce((s, b) => s + b.finalPaise, 0);
  return (
    <>
      <button type="button" className="fact" data-testid="pf-bills-tile" onClick={() => setOpen(true)}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "none", border: 0, padding: 0 }}>
        <span>{t("profile.bills.tile")}</span>
        <span><b className="mo">{t("profile.bills.count", { count: bills.length })}</b><span style={{ color: "var(--dim)", marginLeft: 6 }}>{t("profile.credit.details")} ›</span></span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="pp" style={{ maxWidth: 880, width: "calc(100vw - 32px)", maxHeight: "86vh", overflowY: "auto" }} data-testid="pf-bills-dialog">
          <DialogHeader><DialogTitle>{t("profile.bills.title")}</DialogTitle></DialogHeader>
          <p style={{ margin: 0, fontSize: 12.5 }}>{t("profile.bills.summary", { count: bills.length, amount: fmtPaise(final) })}</p>
          {bills.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("profile.bills.none")}</p> : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 8 }} data-testid="pf-bills-table">
              <thead><tr>
                <th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.bills.ticket")}</th><th style={th}>{t("profile.credit.bill")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("profile.bills.amount")}</th><th style={{ ...th, textAlign: "right" }}>{t("profile.bills.gst")}</th>
                <th style={th}>{t("profile.credit.no")}</th><th style={{ ...th, textAlign: "right" }}>{t("profile.bills.returned")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("profile.bills.final")}</th><th style={{ ...th, textAlign: "right" }}>{t("profile.bills.creditUsed")}</th>
              </tr></thead>
              <tbody>{bills.map((b) => (
                <tr key={b.invoiceId} data-testid={`pf-bill-${b.invoiceId}`}>
                  <td style={td}>{dmy(b.date)}</td>
                  <td style={td} className="mo">{b.ticket ?? t(`profile.bills.source.${b.source}`)}</td>
                  <td style={td} className="mo">{b.invoiceNo}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{fmtPaise(b.netPaise)}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{fmtPaise(b.gstPaise)}</td>
                  <td style={td} className="mo">{b.creditNotes.length === 0 ? "—" : b.creditNotes.map((n) => n.creditNoteNo).join(", ")}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{b.returnedPaise === 0 ? "—" : fmtPaise(b.returnedPaise)}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{fmtPaise(b.finalPaise)}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mo">{b.creditUsedPaise === 0 ? "—" : fmtPaise(b.creditUsedPaise)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
