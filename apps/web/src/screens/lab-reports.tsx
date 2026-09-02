import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst, fmtPaise } from "../lib/format";
import {
  deliveryRegister, istToday, LAB_BENCH_TOPIC, labErrorText, printReport, releaseReport, reportsForPatient,
  requestReleaseApproval,
} from "../lib/lab-api";
import { useRealtime } from "../lib/realtime";
import { LabReportPrint } from "../components/lab-report-print";
import { PatientPicker } from "../components/patient-picker";
import { Button } from "@/components/ui/button";
import { LabSeatFrame } from "./lab-seat";
import type { PatientPickerHit } from "../components/patient-picker";
import type { WirePatientReportRow, WireReportNotice, WireReportView } from "../lib/lab-api";

/**
 * PLAN 17c T5 — **THE REPORT CENTRE**: the counter's fifth seat (design board 5).
 *
 * ═══ THE DOCTOR'S SCREEN IS NEVER HELD; ONLY THE PATIENT'S COPY CARRIES A HOLD (D9) ═══
 *
 * The register is the day's published reports and how each went out: the ready notice's fate
 * (values-free, T7 A7), every hand-over row with who took it, and the interlock's verdict. The
 * hand-over itself is 17b's `printReport` — the ONE place the interlock is consulted — and the
 * document is rendered only when the server sent it, which it does only when the verdict allows:
 * a HELD report reaches the browser as a verdict and an amount, never as a page.
 *
 * ═══ HELD IS A SENTENCE, RELEASE IS AN APPROVAL ═══
 *
 * "Held: ₹1,150 outstanding" — the print lights the moment billing settles it. If the patient
 * cannot pay today, the counter ASKS: a `lab_release_unpaid` approval about the order, decided by
 * the billing manager (DD6), and the granted id is what `releaseUnpaid` takes. The dues stand.
 *
 * Sensitive tests: in person only, to the patient — the channels the server published decide,
 * and no message ever went out (T7 A7).
 */

function noticeState(t: (k: string, o?: Record<string, unknown>) => string, n: WireReportNotice | null): string {
  if (n === null) return t("lab.reports.notice_none");
  if (n.status === "sent") return t("lab.reports.notice_sent", { channel: n.sentChannel ?? "" });
  return t(`lab.reports.notice_${n.status}`, { defaultValue: n.status });
}

/** The document, in the shape `LabReportPrint` reads (17b's view) — only when the server sent one. */
function asView(r: WirePatientReportRow): WireReportView | null {
  if (r.snapshot === null) return null;
  return {
    reportId: r.reportId, orderId: r.orderId, version: r.version, status: "published", partial: r.partial,
    channels: r.channels, printCount: r.printCount, priorVersionId: null, amendmentReasonCode: null,
    publishedAt: r.publishedAt, snapshot: r.snapshot, delivery: r.delivery,
  };
}

export function LabReports(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const serviceDate = istToday();
  const [picked, setPicked] = useState<PatientPickerHit | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [collector, setCollector] = useState("");
  const [channel, setChannel] = useState<"print" | "in_person" | "whatsapp">("print");
  const [approvalId, setApprovalId] = useState("");
  const [requested, setRequested] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const register = useQuery({
    queryKey: ["lab", "reports", "register", serviceDate],
    queryFn: () => deliveryRegister(serviceDate),
    refetchInterval: 30_000,
  });
  const mine = useQuery({
    queryKey: ["lab", "reports", "patient", picked?.id ?? ""],
    queryFn: () => reportsForPatient(picked!.id),
    enabled: picked !== null,
  });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["lab", "reports"] }); };
  const { connected } = useRealtime([LAB_BENCH_TOPIC], () => refresh());

  const hand = useMutation({
    mutationFn: (v: { reportId: string }) => printReport(
      v.reportId,
      channel === "whatsapp" ? { channel } : { channel, collectorIdentity: collector.trim() },
      newIdempotencyKey(),
    ),
    onSuccess: () => { setError(null); setCollector(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const ask = useMutation({
    mutationFn: (r: WirePatientReportRow) => requestReleaseApproval({
      orderId: r.orderId, patientId: picked!.id, amountPaise: r.delivery.outstandingPaise,
      note: `report ${r.orderNo} — patient cannot settle today`,
    }),
    onSuccess: (res) => { setError(null); setRequested(res.approvalId); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const release = useMutation({
    mutationFn: (r: WirePatientReportRow) => releaseReport(
      r.reportId, { approvalId: approvalId.trim(), collectorIdentity: collector.trim(), channel: channel === "in_person" ? "in_person" : "print" },
      newIdempotencyKey(),
    ),
    onSuccess: () => { setError(null); setCollector(""); setApprovalId(""); setRequested(null); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const rows = register.data ?? [];
  const heldCount = rows.filter((r) => !r.delivery.allowed).length;
  const collected = rows.filter((r) => r.deliveries.some((d) => d.channel === "print" || d.channel === "in_person")).length;

  return (
    <LabSeatFrame
      title={t("lab.reports.title")}
      place={t("lab.reports.place")}
      stats={[
        { label: t("lab.reports.publishedStat"), value: rows.length, tone: "live" },
        { label: t("lab.reports.heldStat"), value: heldCount, tone: heldCount > 0 ? "waiting" : "plain" },
        { label: t("lab.reports.collectedStat"), value: collected },
        { label: connected ? t("lab.reports.live") : t("lab.reports.offline"), value: "●", tone: connected ? "live" : "plain" },
      ]}
    >
      {error !== null && <p role="alert" className="mb-3 text-sm font-semibold">{error}</p>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ── published · how each one went out ── */}
        <section className="space-y-2" aria-label={t("lab.reports.register")}>
          <h2 className="text-sm font-semibold">{t("lab.reports.register")}</h2>
          {register.isError && <p role="alert" className="text-sm font-semibold">{t("lab.reports.registerUnavailable")}</p>}
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-sm" data-testid="register">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1">{t("lab.reports.colPatient")}</th>
                  <th className="px-2">{t("lab.reports.colDoctor")}</th>
                  <th className="px-2">{t("lab.reports.colCopy")}</th>
                  <th className="px-2 text-right">{t("lab.reports.colSigned")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const lastHand = r.deliveries.filter((d) => d.channel !== "whatsapp").at(-1) ?? null;
                  return (
                    <tr key={r.reportId} className="border-t border-border" data-testid={`register-${r.orderNo}`}>
                      <td className="px-2 py-1">
                        <span className="font-medium">{r.patientDisplay}</span>
                        <span className="text-muted-foreground"> · {r.orderables.join(" · ")}{r.partial && <> · {t("lab.reports.partial")}</>}</span>
                        {r.sensitive && <span className="ml-1 text-xs font-semibold">{t("lab.reports.inPersonOnly")}</span>}
                      </td>
                      <td className="px-2 text-muted-foreground">{t("lab.reports.doctorScreen")}</td>
                      <td className="px-2">
                        {!r.delivery.allowed ? (
                          <span className="font-semibold" style={{ color: "var(--state-waiting)" }}>
                            {t("lab.reports.heldShort", { amount: fmtPaise(r.delivery.outstandingPaise) })}
                            <span className="ml-1 font-normal text-muted-foreground">· {t("lab.reports.printWaits")}</span>
                          </span>
                        ) : lastHand !== null ? (
                          <span>{t("lab.reports.handed", { channel: t(`lab.reports.channel_${lastHand.channel}`), who: lastHand.collectorIdentity ?? "—" })}</span>
                        ) : (
                          <span className="text-muted-foreground">{noticeState(t, r.notice)}</span>
                        )}
                      </td>
                      <td className="px-2 text-right tabular-nums">{fmtIst(r.publishedAt)}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && !register.isPending && (
                  <tr><td colSpan={4} className="px-2 py-2 text-muted-foreground">{t("lab.reports.registerEmpty")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t("lab.reports.registerNote")}</p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("lab.reports.channels")}</summary>
            <p className="mt-1">{t("lab.reports.channelsNote")}</p>
          </details>
        </section>

        {/* ── hand over at the counter · one field ── */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t("lab.reports.find")}</h2>
          <PatientPicker onPick={(hit) => { setPicked(hit); setOpenId(null); setError(null); setRequested(null); }} />
          {picked === null && <p className="text-sm text-muted-foreground">{t("lab.reports.pick")}</p>}
          {mine.isError && <p role="alert" className="text-sm font-semibold">{t("lab.reports.registerUnavailable")}</p>}
          {mine.data !== undefined && (() => {
            const data = mine.data;
            const todays = data.reports.filter((r) => r.serviceDate === serviceDate);
            const earlier = data.reports.length - todays.length;
            return (
              <div className="space-y-3">
                <div className="rounded border border-border bg-card p-3 text-sm" data-testid="patient-card">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-lg font-semibold">{data.patient.display}</span>
                    <span className="text-muted-foreground">{data.patient.uhid}</span>
                    {data.patient.restricted && <span className="font-semibold">{t("lab.reports.restricted")}</span>}
                  </div>
                  <p className="text-muted-foreground">
                    {t("lab.reports.ready", { count: todays.length })}
                    {data.pending.length > 0 && <> · {t("lab.reports.pending", { count: data.pending.reduce((n, p) => n + (p.itemCount - p.completedCount), 0) })}</>}
                    {earlier > 0 && <> · {earlier} {t("lab.reports.earlier")}</>}
                  </p>
                </div>
                {data.reports.length === 0 && <p className="text-sm text-muted-foreground">{t("lab.reports.noReports")}</p>}
                {data.reports.map((r) => {
                  const view = asView(r);
                  const isOpen = openId === r.reportId;
                  const inPersonOnly = r.channels.length === 1 && r.channels[0] === "in_person";
                  return (
                    <article key={r.reportId} className="space-y-2 rounded border border-border p-3 text-sm" data-testid={`report-${r.orderNo}`}>
                      <header className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-semibold">{t("lab.reports.report")} · v{r.version}{r.partial && <> · {t("lab.reports.partial")}</>}</span>
                        <span className="text-muted-foreground">{r.orderables.join(" · ")} · {r.orderNo}</span>
                        {r.publishedAt !== null && <span className="text-muted-foreground">· {t("lab.reports.signedBy", { when: fmtIst(r.publishedAt) })}</span>}
                      </header>
                      <p className="text-xs text-muted-foreground">
                        {t("lab.reports.noticeLine", { state: noticeState(t, r.notice) })}
                        {r.deliveries.length > 0 && <> · {t("lab.reports.handedOver", { count: r.printCount })}</>}
                      </p>
                      {inPersonOnly && <p className="text-xs font-semibold">{t("lab.reports.sensitiveNote")}</p>}

                      {!r.delivery.allowed ? (
                        <div className="space-y-2">
                          <p role="alert" className="font-semibold" style={{ color: "var(--state-waiting)" }}>
                            {t("lab.reports.heldLine", { amount: (r.delivery.outstandingPaise / 100).toFixed(2), count: r.delivery.unpaidInvoiceIds.length })}
                          </p>
                          <p className="text-xs text-muted-foreground">{t("lab.reports.releaseHint")}</p>
                          {requested === null ? (
                            <Button type="button" variant="outline" size="sm" disabled={ask.isPending} onClick={() => ask.mutate(r)}>
                              {t("lab.reports.requestRelease")}
                            </Button>
                          ) : (
                            <p className="text-xs">{t("lab.reports.releaseRequested", { id: requested })}</p>
                          )}
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="text-sm">
                              {t("lab.reports.approvalId")}
                              <input className="mt-1 block rounded border border-input px-2 py-1 font-mono" value={approvalId}
                                onChange={(e) => setApprovalId(e.target.value)} />
                            </label>
                            <label className="text-sm">
                              {t("lab.reports.collector")}
                              <input className="mt-1 block rounded border border-input px-2 py-1" value={collector}
                                aria-label={`${t("lab.reports.collector")} ${r.orderNo}`}
                                onChange={(e) => setCollector(e.target.value)} />
                            </label>
                            <Button type="button" disabled={approvalId.trim() === "" || collector.trim() === "" || release.isPending}
                              onClick={() => release.mutate(r)}>
                              {t("lab.reports.release")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="text-sm">
                              {t("lab.reports.channel")}
                              <select className="mt-1 block rounded border border-input px-2 py-1" value={channel}
                                onChange={(e) => setChannel(e.target.value as typeof channel)}>
                                {r.channels.map((c) => <option key={c} value={c}>{t(`lab.reports.channel_${c}`)}</option>)}
                              </select>
                            </label>
                            <label className="text-sm">
                              {t("lab.reports.collector")}
                              <input className="mt-1 block rounded border border-input px-2 py-1" value={collector}
                                aria-label={`${t("lab.reports.collector")} ${r.orderNo}`}
                                onChange={(e) => setCollector(e.target.value)} />
                            </label>
                            <Button type="button"
                              disabled={hand.isPending || (channel !== "whatsapp" && collector.trim() === "")}
                              onClick={() => hand.mutate({ reportId: r.reportId })}>
                              {t("lab.reports.print")}
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setOpenId(isOpen ? null : r.reportId)}>
                              {isOpen ? "▲" : "▼"}
                            </Button>
                          </div>
                          {isOpen && view !== null && <LabReportPrint report={view} />}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            );
          })()}
        </section>
      </div>
    </LabSeatFrame>
  );
}
