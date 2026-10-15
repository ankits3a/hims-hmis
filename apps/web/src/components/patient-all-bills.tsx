import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtPaise } from "../lib/format";

/**
 * Owner 2026-10-03 — "All bills" in the profile's left lane: every bill in the patient's name in one dialog,
 * filtered by department (Pharmacy, OPD, Emergency, IPD, Lab, Imaging, OT, other), and any bill opened to its
 * whole billing information — lines with tax, totals, payments, credit notes, where it stands.
 * `GET /billing/patients/:id/bills` and `GET /billing/invoices/:id/full`, both under `billing.invoice.read`.
 */
type Dept = "pharmacy" | "opd" | "emergency" | "ipd" | "lab" | "imaging" | "ot" | "other";
const DEPTS: readonly Dept[] = ["pharmacy", "opd", "emergency", "ipd", "lab", "imaging", "ot", "other"];
type Settlement = { state: "unpaid" | "partial" | "settled"; outstandingPaise: number };
type Bill = {
  invoiceId: string; invoiceNo: string; date: string; departments: Dept[]; encounterNo: string | null; lines: number; summary: string;
  netPaise: number; gstPaise: number; creditedPaise: number; paidPaise: number; settlement: Settlement;
};
type Full = {
  invoiceId: string; invoiceNo: string; issuedAt: string; issuedByName: string; departments: Dept[]; encounterNo: string | null; intendedPayer: string; buyerGstin: string | null;
  lines: { lineNo: number; serviceName: string; sacCode: string; qty: number; unitPaise: number; grossPaise: number; discountPaise: number; taxablePaise: number; rateBps: number; cgstPaise: number; sgstPaise: number; netPaise: number }[];
  totals: { grossPaise: number; discountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; netPaise: number };
  payments: { receiptNo: string; at: string; amountPaise: number; kind: string; modes: string[] }[];
  creditNotes: { creditNoteNo: string; at: string; kind: string; reason: string; netPaise: number }[];
  settlement: Settlement; creditedPaise: number; paidPaise: number;
};

const dmy = (iso: string): string => iso.slice(0, 10).split("-").reverse().join("-");
const th = { textAlign: "left", fontWeight: 500, color: "var(--dim)", padding: "4px 6px" } as const;
const thR = { ...th, textAlign: "right" } as const;
const td = { padding: "5px 6px", borderTop: "1px solid var(--line2)", verticalAlign: "top" } as const;
const tdR = { ...td, textAlign: "right" } as const;
const chip = (on: boolean): React.CSSProperties => ({
  height: 26, padding: "0 10px", borderRadius: 13, fontSize: 12, cursor: "pointer",
  border: `1px solid ${on ? "var(--green-line)" : "var(--line)"}`, background: on ? "var(--green-soft)" : "transparent", color: on ? "var(--green)" : "var(--dim)", fontWeight: on ? 600 : 400,
});

export function AllBillsTile({ patientId }: { patientId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const allowed = can("billing.invoice.read");
  const q = useQuery({
    queryKey: ["pf-all-bills", patientId],
    queryFn: () => api<{ bills: Bill[] }>("GET", `/billing/patients/${encodeURIComponent(patientId)}/bills`),
    enabled: allowed, retry: false,
  });
  const bills = q.data?.bills;
  if (!allowed || bills === undefined) return null;
  return (
    <>
      <button type="button" className="fact" data-testid="pf-all-bills-tile" onClick={() => setOpen(true)}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "none", border: 0, padding: 0 }}>
        <span>{t("profile.allBills.tile")}</span>
        <span><b className="mo">{t("profile.allBills.count", { count: bills.length })}</b><span style={{ color: "var(--dim)", marginLeft: 6 }}>{t("profile.credit.details")} ›</span></span>
      </button>
      {open ? <AllBillsDialog bills={bills} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AllBillsDialog({ bills, onClose }: { bills: Bill[]; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [dept, setDept] = useState<Dept | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const present = DEPTS.filter((d) => bills.some((b) => b.departments.includes(d)));
  const shown = dept === "all" ? bills : bills.filter((b) => b.departments.includes(dept));
  const sum = (f: (b: Bill) => number): number => shown.reduce((s, b) => s + f(b), 0);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="pp" style={{ maxWidth: 960, width: "calc(100vw - 32px)", maxHeight: "88vh", overflowY: "auto" }} data-testid="pf-all-bills-dialog">
        <DialogHeader><DialogTitle>{t("profile.allBills.title")}</DialogTitle></DialogHeader>
        {openId !== null ? <BillFull invoiceId={openId} onBack={() => setOpenId(null)} /> : (
          <>
            <div role="group" aria-label={t("profile.allBills.filter")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }} data-testid="pf-all-bills-filter">
              <button type="button" style={chip(dept === "all")} aria-pressed={dept === "all"} data-testid="bills-filter-all" onClick={() => setDept("all")}>
                {t("profile.allBills.all")} · {bills.length}
              </button>
              {present.map((d) => (
                <button key={d} type="button" style={chip(dept === d)} aria-pressed={dept === d} data-testid={`bills-filter-${d}`} onClick={() => setDept(d)}>
                  {t(`profile.allBills.dept.${d}`)} · {bills.filter((b) => b.departments.includes(d)).length}
                </button>
              ))}
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 12.5 }} data-testid="pf-all-bills-sum">
              {t("profile.allBills.sum", { count: shown.length, billed: fmtPaise(sum((b) => b.netPaise)), gst: fmtPaise(sum((b) => b.gstPaise)), due: fmtPaise(sum((b) => b.settlement.outstandingPaise)) })}
            </p>
            {shown.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("profile.allBills.none")}</p> : (
              <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 6 }} data-testid="pf-all-bills-table">
                <thead><tr>
                  <th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.credit.bill")}</th><th style={th}>{t("profile.credit.dept")}</th>
                  <th style={th}>{t("profile.allBills.items")}</th><th style={thR}>{t("profile.bills.amount")}</th><th style={thR}>{t("profile.bills.gst")}</th>
                  <th style={thR}>{t("profile.allBills.paid")}</th><th style={thR}>{t("profile.allBills.credited")}</th><th style={th}>{t("profile.credit.status")}</th>
                </tr></thead>
                <tbody>{shown.map((b) => (
                  <tr key={b.invoiceId} data-testid={`pf-all-bill-${b.invoiceId}`} onClick={() => setOpenId(b.invoiceId)} style={{ cursor: "pointer" }} title={t("profile.allBills.open")}>
                    <td style={td}>{dmy(b.date)}</td>
                    <td style={td} className="mo"><span style={{ color: "var(--green)", textDecoration: "underline" }}>{b.invoiceNo}</span></td>
                    <td style={td}>{b.departments.map((d) => t(`profile.allBills.dept.${d}`)).join(", ")}</td>
                    <td style={td}>{b.summary}</td>
                    <td style={tdR} className="mo">{fmtPaise(b.netPaise)}</td>
                    <td style={tdR} className="mo">{fmtPaise(b.gstPaise)}</td>
                    <td style={tdR} className="mo">{fmtPaise(b.paidPaise)}</td>
                    <td style={tdR} className="mo">{b.creditedPaise === 0 ? "—" : fmtPaise(b.creditedPaise)}</td>
                    <td style={td}>{statusText(t, b.settlement)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function statusText(t: (k: string, o?: Record<string, unknown>) => string, s: Settlement): string {
  return s.state === "settled" ? t("profile.allBills.state.settled") : t(`profile.allBills.state.${s.state}`, { due: fmtPaise(s.outstandingPaise) });
}

function BillFull({ invoiceId, onBack }: { invoiceId: string; onBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pf-bill-full", invoiceId], queryFn: () => api<Full>("GET", `/billing/invoices/${encodeURIComponent(invoiceId)}/full`), retry: false });
  const f = q.data;
  return (
    <div data-testid="pf-bill-full">
      <button type="button" className="sec" onClick={onBack} data-testid="pf-bill-back">← {t("profile.allBills.back")}</button>
      {f === undefined ? <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("profile.allBills.reading")}</p> : (
        <>
          <div className="today" style={{ marginTop: 10 }} data-testid="pf-bill-head">
            <div><b className="mo">{f.invoiceNo}</b><div className="s">{dmy(f.issuedAt)} · {f.issuedByName}</div></div>
            <div><b>{f.departments.map((d) => t(`profile.allBills.dept.${d}`)).join(", ")}</b><div className="s">{f.encounterNo === null ? t("profile.allBills.noVisit") : t("profile.allBills.visit", { no: f.encounterNo })}</div></div>
            <div><b className="mo">{fmtPaise(f.totals.netPaise)}</b><div className="s">{statusText(t, f.settlement)}</div></div>
          </div>
          <h4 style={{ margin: "14px 0 4px", fontSize: 13.5, fontWeight: 600 }}>{t("profile.allBills.linesTitle")}</h4>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }} data-testid="pf-bill-lines">
            <thead><tr>
              <th style={th}>#</th><th style={th}>{t("profile.allBills.item")}</th><th style={th}>HSN/SAC</th><th style={thR}>{t("profile.allBills.qty")}</th>
              <th style={thR}>{t("profile.allBills.rate")}</th><th style={thR}>{t("profile.allBills.discount")}</th><th style={thR}>{t("profile.allBills.taxable")}</th>
              <th style={thR}>GST %</th><th style={thR}>CGST</th><th style={thR}>SGST</th><th style={thR}>{t("profile.allBills.total")}</th>
            </tr></thead>
            <tbody>{f.lines.map((l) => (
              <tr key={l.lineNo}>
                <td style={td}>{l.lineNo}</td><td style={td}>{l.serviceName}</td><td style={td} className="mo">{l.sacCode}</td>
                <td style={tdR}>{l.qty}</td><td style={tdR} className="mo">{fmtPaise(l.unitPaise)}</td><td style={tdR} className="mo">{l.discountPaise === 0 ? "—" : fmtPaise(l.discountPaise)}</td>
                <td style={tdR} className="mo">{fmtPaise(l.taxablePaise)}</td><td style={tdR}>{l.rateBps / 100}%</td>
                <td style={tdR} className="mo">{fmtPaise(l.cgstPaise)}</td><td style={tdR} className="mo">{fmtPaise(l.sgstPaise)}</td><td style={tdR} className="mo">{fmtPaise(l.netPaise)}</td>
              </tr>
            ))}</tbody>
          </table>
          <table style={{ marginLeft: "auto", marginTop: 8, fontSize: 12.5 }} data-testid="pf-bill-totals">
            <tbody>
              {([["gross", f.totals.grossPaise], ["discount", -f.totals.discountPaise], ["taxable", f.totals.taxablePaise], ["cgst", f.totals.cgstPaise], ["sgst", f.totals.sgstPaise], ["rounding", f.totals.roundingPaise]] as const).map(([k, v]) => (
                <tr key={k}><td style={{ padding: "2px 10px", color: "var(--dim)" }}>{t(`profile.allBills.tot.${k}`)}</td><td style={{ textAlign: "right" }} className="mo">{fmtPaise(v)}</td></tr>
              ))}
              <tr><td style={{ padding: "4px 10px", fontWeight: 600 }}>{t("profile.allBills.tot.net")}</td><td style={{ textAlign: "right", fontWeight: 600 }} className="mo">{fmtPaise(f.totals.netPaise)}</td></tr>
            </tbody>
          </table>
          <h4 style={{ margin: "14px 0 4px", fontSize: 13.5, fontWeight: 600 }}>{t("profile.allBills.paymentsTitle")}</h4>
          {f.payments.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)", margin: 0 }}>{t("profile.allBills.noPayments")}</p> : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }} data-testid="pf-bill-payments">
              <thead><tr><th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.allBills.receipt")}</th><th style={th}>{t("profile.credit.method")}</th><th style={th}>{t("profile.allBills.what")}</th><th style={thR}>{t("profile.credit.amount")}</th></tr></thead>
              <tbody>{f.payments.map((p, i) => (
                <tr key={`${p.receiptNo}-${String(i)}`}>
                  <td style={td}>{dmy(p.at)}</td><td style={td} className="mo">{p.receiptNo}</td>
                  <td style={td}>{p.modes.map((m) => t(`pharmacyOffice.reports.tender.${m}`, m)).join(" + ") || "—"}</td>
                  <td style={td}>{t(`profile.allBills.payKind.${p.kind}`, p.kind)}</td>
                  <td style={tdR} className="mo">{fmtPaise(p.amountPaise)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <h4 style={{ margin: "14px 0 4px", fontSize: 13.5, fontWeight: 600 }}>{t("profile.allBills.notesTitle")}</h4>
          {f.creditNotes.length === 0 ? <p style={{ fontSize: 12.5, color: "var(--dim)", margin: 0 }}>{t("profile.allBills.noNotes")}</p> : (
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }} data-testid="pf-bill-notes">
              <thead><tr><th style={th}>{t("profile.credit.date")}</th><th style={th}>{t("profile.credit.no")}</th><th style={th}>{t("profile.credit.reason")}</th><th style={thR}>{t("profile.credit.value")}</th></tr></thead>
              <tbody>{f.creditNotes.map((n) => (
                <tr key={n.creditNoteNo}><td style={td}>{dmy(n.at)}</td><td style={td} className="mo">{n.creditNoteNo}</td><td style={td}>{n.reason.replace(/^pharmacy return: /, "")}</td><td style={tdR} className="mo">{fmtPaise(n.netPaise)}</td></tr>
              ))}</tbody>
            </table>
          )}
          <p style={{ margin: "10px 0 0", fontSize: 12.5 }} data-testid="pf-bill-standing">
            {t("profile.allBills.standing", { net: fmtPaise(f.totals.netPaise), paid: fmtPaise(f.paidPaise), credited: fmtPaise(f.creditedPaise), due: fmtPaise(f.settlement.outstandingPaise) })}
          </p>
        </>
      )}
    </div>
  );
}
