import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "../lib/auth";
import type { WirePatientReportRow, WireRecentLabOrder } from "../lib/lab-api";
import { labOrdersForPatient, quickReportsForPatient, type QuickReport } from "../lib/lab-quick-api";
import { reportsForPatient } from "../lib/lab-api";
import { PapersSheet } from "./desk-one/papers";
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
type LabVisitData = {
  visitNo: string | null;
  orders: WireRecentLabOrder[];
  quickReports: QuickReport[];
  signedReports: WirePatientReportRow[];
  patientId: string;
};

export function LabVisitDialog({ visit, onClose, ...data }: LabVisitData & { visit: WireTimelineItem | null; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const who = visit === null ? "" : [visit.departmentName, visit.doctorName].filter((x) => x !== null && x !== "").join(" · ");
  return (
    <Dialog open={data.visitNo !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="pp max-w-2xl" data-testid="lab-visit-dialog" style={{ maxHeight: "90vh", overflowY: "auto" }}>
        <DialogTitle>{t("profile.lv.title", { n: data.visitNo ?? "" })}</DialogTitle>
        <DialogDescription>{[visit === null ? "" : dmy(visit.serviceDate), who].filter((x) => x !== "").join(" · ")}</DialogDescription>
        <LabVisitBody {...data} />
      </DialogContent>
    </Dialog>
  );
}

/** The visit's orders, tests and reports — the same body in the profile's dialog and the counter's sheet. */
export function LabVisitBody({ visitNo, orders, quickReports, signedReports, patientId }: LabVisitData): React.ReactElement {
  const { t } = useTranslation();
  const { can, username } = useAuth();
  const [shown, setShown] = useState<string | null>(null);
  const mine = orders.filter((o) => o.encounterNo === visitNo).sort((a, b) => (a.placedAt < b.placedAt ? -1 : 1));
  const quick = quickReports.filter((r) => r.encounterNo === visitNo);
  const signed = signedReports.filter((r) => r.encounterNo === visitNo);
  /** A quick report started before orders carried one (decision 0061) still belongs to the visit. */
  const looseQuick = quick.filter((r) => !mine.some((o) => o.orderId === r.orderId || o.quickId === r.id));
  const looseSigned = signed.filter((r) => !mine.some((o) => o.orderId === r.orderId));
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
    <div data-testid="lab-visit-body">
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
    </div>
  );
}

/**
 * OWNER 2026-10-11 — /counter's history opened a lab visit as an OPD visit card ("Change department",
 * "Patient not present — guardian with reports", OPD slips). A lab visit opens this instead: the
 * visit's tests and reports, read through whichever lab grant the seat holds, and its bills.
 */
export function LabVisitSheet({ patientId, visit }: { patientId: string; visit: WireTimelineItem }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const via = can("lab.results.read") ? "results" as const : "print" as const;
  const mayRead = can("lab.results.read") || can("lab.reports.print");
  const orders = useQuery({ queryKey: ["pf-lab-orders", patientId, via], queryFn: () => labOrdersForPatient(patientId, via), enabled: mayRead, retry: false });
  const quick = useQuery({ queryKey: ["lab-quick", "patient", patientId, via], queryFn: () => quickReportsForPatient(patientId, via), enabled: mayRead, retry: false });
  const signed = useQuery({ queryKey: ["pf-lab-reports", patientId], queryFn: () => reportsForPatient(patientId), enabled: can("lab.reports.print"), retry: false });
  const who = [visit.departmentName, visit.doctorName].filter((x) => x !== null && x !== "").join(" · ");
  return (
    <div className="pp" data-testid="lab-visit-sheet">
      <div style={{ padding: "16px 18px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span data-testid="lab-visit-title" style={{ fontSize: 15, fontWeight: 700 }}>{t("profile.lv.title", { n: visit.visitNo ?? "" })}</span>
          <span className="pill" style={{ height: 20 }}>{t("profile.lv.kind")}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>{[dmy(visit.serviceDate), who].filter((x) => x !== "").join(" · ")}</div>
        <div style={{ marginTop: 12 }}>
          {mayRead ? (
            <LabVisitBody visitNo={visit.visitNo ?? null} patientId={patientId} orders={orders.data?.items ?? []}
              quickReports={quick.data?.items ?? []} signedReports={signed.data?.reports ?? []} />
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="lab-visit-no-grant">{t("profile.lv.noGrant")}</p>
          )}
        </div>
      </div>
      <PapersSheet encounterId={visit.encounterId} when={visit.serviceDate} billsOnly />
    </div>
  );
}
