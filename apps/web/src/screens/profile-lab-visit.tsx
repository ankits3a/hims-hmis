import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "../lib/auth";
import type { WirePatientReportRow, WireRecentLabOrder } from "../lib/lab-api";
import type { QuickReport } from "../lib/lab-quick-api";
import type { WireTimelineItem } from "../lib/opd-api";
import { dmy } from "./patient-profile-model";
import { STAGE_PILL } from "./lab-desk-flow";
import { ReportPreview } from "./lab-qchain";
import { printQuickReport } from "./lab-quick-reports";

/**
 * OWNER 2026-10-11 — "let the user click on the visit card to access the reports and tests related
 * to that visit." A lab visit's row on the profile opens this: each order of the visit with its tests
 * (code and name) and stage, and the visit's reports — a quick report opens in place and prints; a
 * signed report opens in Lab reports for a seat that may print there. The rows it shows are the ones
 * the profile already read; it asks nothing new of the server.
 */
export function LabVisitDialog({ visitNo, visit, orders, quickReports, signedReports, patientId, onClose }: {
  visitNo: string | null;
  visit: WireTimelineItem | null;
  orders: WireRecentLabOrder[];
  quickReports: QuickReport[];
  signedReports: WirePatientReportRow[];
  patientId: string;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can, username } = useAuth();
  const [shown, setShown] = useState<string | null>(null);
  const mine = orders.filter((o) => o.encounterNo === visitNo).sort((a, b) => (a.placedAt < b.placedAt ? -1 : 1));
  const quick = quickReports.filter((r) => r.encounterNo === visitNo);
  const signed = signedReports.filter((r) => r.encounterNo === visitNo);
  /** A quick report started before orders carried one (decision 0061) still belongs to the visit. */
  const looseQuick = quick.filter((r) => !mine.some((o) => o.orderId === r.orderId || o.quickId === r.id));
  const looseSigned = signed.filter((r) => !mine.some((o) => o.orderId === r.orderId));
  const who = visit === null ? "" : [visit.departmentName, visit.doctorName].filter((x) => x !== null && x !== "").join(" · ");
  const mayOpenSigned = can("lab.reports.print");

  const quickBlock = (r: QuickReport): React.ReactNode => (
    <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("profile.lv.quick")}</span>
        <button type="button" className="sec" style={{ height: 26, fontSize: 11.5 }} aria-expanded={shown === r.id}
          data-testid={`lv-view-${r.id}`} onClick={() => setShown((s) => (s === r.id ? null : r.id))}>
          {shown === r.id ? t("profile.lv.hide") : t("profile.lv.view")}
        </button>
        <button type="button" className="sec" style={{ height: 26, fontSize: 11.5 }} onClick={() => printQuickReport(r, username)}>
          🖨 {t("lab.counter.printReport")}
        </button>
      </div>
      {shown === r.id && <ReportPreview report={r} />}
    </div>
  );

  return (
    <Dialog open={visitNo !== null} onOpenChange={(o) => { if (!o) { setShown(null); onClose(); } }}>
      <DialogContent className="pp max-w-2xl" data-testid="lab-visit-dialog" style={{ maxHeight: "90vh", overflowY: "auto" }}>
        <DialogTitle>{t("profile.lv.title", { n: visitNo ?? "" })}</DialogTitle>
        <DialogDescription>{[visit === null ? "" : dmy(visit.serviceDate), who].filter((x) => x !== "").join(" · ")}</DialogDescription>
        {mine.length === 0 && looseQuick.length === 0 && looseSigned.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("profile.lv.none")}</p>
        )}
        <ul style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mine.map((o) => {
            const q = quick.filter((r) => r.orderId === o.orderId || o.quickId === r.id);
            const s = signed.filter((r) => r.orderId === o.orderId);
            return (
              <li key={o.orderId} className="box" style={{ padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }} data-testid={`lv-order-${o.orderNo}`}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span className="mo" style={{ fontSize: 11.5, color: "var(--faint)" }}>{o.orderNo}</span>
                  <span className={STAGE_PILL[o.stage] ?? "pill"} style={{ height: 19, marginLeft: "auto" }}>{t(`lab.counter.stage.${o.stage}`)}</span>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {o.tests.map((x, i) => (
                    <span key={`${x.code}-${String(i)}`} className="kb" title={x.nameEn}>{x.code}</span>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--dim)" }}>{o.tests.map((x) => x.nameEn).join(", ")}</div>
                {q.map(quickBlock)}
                {s.map((r) => (
                  <div key={r.reportId} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "var(--dim)" }}>
                      {t("profile.tl.labSigned")}{r.version > 1 ? ` · ${t("profile.tl.version", { n: r.version })}` : ""}
                    </span>
                    {mayOpenSigned && (
                      <a className="sec" style={{ height: 26, fontSize: 11.5, display: "inline-flex", alignItems: "center", padding: "0 10px" }}
                        href={`/lab/reports?patientId=${encodeURIComponent(patientId)}`}>{t("profile.lv.openSigned")}</a>
                    )}
                  </div>
                ))}
              </li>
            );
          })}
          {looseSigned.map((r) => (
            <li key={r.reportId} className="box" style={{ padding: "9px 11px", fontSize: 12.5 }}>
              {r.orderables.join(", ")} · {t("profile.tl.labSigned")}
              {mayOpenSigned && <> · <a className="lnk" href={`/lab/reports?patientId=${encodeURIComponent(patientId)}`}>{t("profile.lv.openSigned")}</a></>}
            </li>
          ))}
          {looseQuick.map((r) => (
            <li key={r.id} className="box" style={{ padding: "9px 11px" }}>{quickBlock(r)}</li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
