import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { materialsErrorText } from "../../lib/materials-api";
import { fetchRunForApproval } from "../../lib/payables-api";
import { rupees } from "../../lib/purchase-api";
import { Button } from "@/components/ui/button";
import { Sheet } from "./sheet";

/**
 * PARITY P3 — THE RUN AS THE OWNER SEES IT BEFORE AUTHORISING IT, opened from its card in
 * `/approvals`. Read-only: vendor groups (MSME tagged, cooling-off named), each bill with its due
 * date and days overdue, what is paid now, and the run total. Approve / Reject hand back to the
 * inbox's own decision dialog, so the decision stays on the kernel approvals path (note, reason,
 * requester ≠ approver) — this sheet only shows what is being decided.
 *
 * Reads `GET /materials/payment-runs/:id/for-approval`, guarded on `approvals.requests.decide`: the
 * owner holds no stock or payables grant and still opens it.
 */
export function RunApprovalSheet({ runId, onClose, onDecide }: {
  runId: string;
  onClose: () => void;
  /** Present only when this person may decide it now; absent, the sheet only reads. */
  onDecide?: (verdict: "approve" | "reject") => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["approvals", "payment-run", runId], queryFn: () => fetchRunForApproval(runId) });
  const r = q.data;
  const onKey = (e: React.KeyboardEvent): void => {
    if (onDecide === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "a" || e.key === "A") { e.preventDefault(); onDecide("approve"); }
    if (e.key === "r" || e.key === "R") { e.preventDefault(); onDecide("reject"); }
  };
  return (
    <Sheet title={r === undefined ? t("pharmacyOffice.sheet.loading") : t("pharmacyOffice.pay.ownerView.title", { runNo: r.runNo })} onClose={onClose} testId="run-approval-sheet" onKey={onKey}>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {r !== undefined && (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {t("pharmacyOffice.pay.ownerView.intro", { vendors: r.vendorCount, bills: r.billCount, name: r.names[r.createdBy] ?? "" })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="run-approval-grid">
              <thead><tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.invDate")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.run.ourNo")}</th>
                <th className="py-1 pr-2">{t("pharmacyOffice.pay.run.vendorNo")}</th><th className="py-1 pr-2">{t("pharmacyOffice.pay.payables.due")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.sheet.total")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.prevPaid")}</th>
                <th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.payNow")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.pay.run.remaining")}</th>
              </tr></thead>
              {r.vendors.map((v) => (
                <tbody key={v.vendorId} data-testid={`run-approval-vendor-${v.vendorCode}`}>
                  <tr className="border-t bg-muted/40">
                    <td colSpan={6} className="py-1 pr-2 font-medium">
                      {v.vendorName} {v.msme && <span className="ml-1 rounded bg-red-100 px-1 text-xs font-medium text-red-800">MSME</span>}
                      {v.coolingOffUntil !== null && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-900">{t("pharmacyOffice.pay.run.coolingOff", { date: v.coolingOffUntil.slice(0, 10) })}</span>}
                    </td>
                    <td className="py-1 pr-2 text-right font-medium tabular-nums">{rupees(v.payPaise)}</td><td />
                  </tr>
                  {v.lines.map((l) => (
                    <tr key={l.id} className="border-t" data-testid={`run-approval-line-${l.billNo}`}>
                      <td className="py-1 pr-2 text-xs">{l.billDate}</td>
                      <td className="py-1 pr-2 font-mono text-xs">{l.billNo}</td>
                      <td className="py-1 pr-2 text-xs">{l.vendorBillNo}</td>
                      <td className={`py-1 pr-2 text-xs ${l.overdueDays > 0 ? "font-medium text-red-700" : ""}`}>
                        {l.dueDate ?? "—"}{l.overdueDays > 0 ? ` · ${t("pharmacyOffice.pay.daysOverdue", { count: l.overdueDays })}` : ""}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.totalPaise)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.prevPaidPaise)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.payPaise)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{rupees(l.remainingPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <div className="flex justify-end" data-testid="run-approval-total"><span>{t("pharmacyOffice.pay.run.total")} <b className="tabular-nums">{rupees(r.totalPaise)}</b></span></div>
          {onDecide !== undefined && r.status === "pending_authorisation" && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onDecide("reject")}>{t("inbox.reject")} <kbd className="ml-1 rounded border px-1 text-xs">R</kbd></Button>
              <Button type="button" onClick={() => onDecide("approve")}>{t("inbox.approve")} <kbd className="ml-1 rounded border px-1 text-xs">A</kbd></Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
