import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst, fmtPaise } from "../lib/format";
import {
  deliveryRegister, istToday, LAB_BENCH_TOPIC, labErrorText, printReport, releaseReport, reportsForPatient,
  requestReleaseApproval,
} from "../lib/lab-api";
import { useAuth } from "../lib/auth";
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
  const { can } = useAuth();
  const [picked, setPicked] = useState<PatientPickerHit | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * 17d T7 — which reports the counter is showing in Hindi. Per REPORT rather than per seat: the
   * clerk hands one patient a Hindi copy and the next an English one without touching a setting,
   * and the doctor's copy of the same report is unaffected either way (D8).
   */
  const [hindiFor, setHindiFor] = useState<Set<string>>(() => new Set());
  /** Pass 2 NEW-1 — the print dialog opens only AFTER the document has mounted (`window.print` in the same tick printed a blank page). */
  const [printPending, setPrintPending] = useState<string | null>(null);
  /** Pass 1 F14 — per REPORT, never shared across cards: a channel chosen for one report is not another's. */
  const [collectorBy, setCollectorBy] = useState<Record<string, string>>({});
  const [channelBy, setChannelBy] = useState<Record<string, "print" | "in_person" | "whatsapp">>({});
  const [approvalBy, setApprovalBy] = useState<Record<string, string>>({});
  const [requestedBy, setRequestedBy] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const collectorOf = (id: string): string => collectorBy[id] ?? "";
  const channelOf = (r: WirePatientReportRow): "print" | "in_person" | "whatsapp" =>
    channelBy[r.reportId] ?? ((r.channels[0] ?? "in_person") as "print" | "in_person" | "whatsapp");

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
    mutationFn: (r: WirePatientReportRow) => {
      const channel = channelOf(r);
      return printReport(
        r.reportId,
        channel === "whatsapp" ? { channel } : { channel, collectorIdentity: collectorOf(r.reportId).trim() },
        newIdempotencyKey(),
      );
    },
    onSuccess: (_res, r) => {
      setError(null);
      setCollectorBy((c) => ({ ...c, [r.reportId]: "" }));
      setOpenId(r.reportId);
      if (channelOf(r) === "print") setPrintPending(r.reportId);
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const ask = useMutation({
    mutationFn: (r: WirePatientReportRow) => requestReleaseApproval({
      orderId: r.orderId, patientId: picked!.id, amountPaise: r.delivery.outstandingPaise,
      note: `report ${r.orderNo} — patient cannot settle today`,
    }),
    onSuccess: (res, r) => { setError(null); setRequestedBy((m) => ({ ...m, [r.reportId]: res.approvalId })); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const release = useMutation({
    mutationFn: (r: WirePatientReportRow) => releaseReport(
      r.reportId,
      { approvalId: (approvalBy[r.reportId] ?? "").trim(), collectorIdentity: collectorOf(r.reportId).trim(),
        channel: channelOf(r) === "in_person" ? "in_person" : "print" },
      newIdempotencyKey(),
    ),
    onSuccess: (_res, r) => {
      setError(null);
      setCollectorBy((c) => ({ ...c, [r.reportId]: "" }));
      setApprovalBy((a) => ({ ...a, [r.reportId]: "" }));
      setRequestedBy((m) => { const next = { ...m }; delete next[r.reportId]; return next; });
      setOpenId(r.reportId);
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  useEffect(() => {
    if (printPending === null || openId !== printPending) return;
    if (document.querySelector(".print-doc") === null) return; // not mounted yet — the next commit re-runs this
    setPrintPending(null);
    if (typeof window.print === "function") window.print();
  }, [printPending, openId, mine.data]);

  /** Pass 1 F2(a) — `approvals.requests.create` is granted to no role by the seed; the button appears only for a holder. */
  const mayAsk = can("approvals.requests.create");
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
                        {/*
                          A REASON WHERE A REASON BELONGS — the register ROW, which is what a counter
                          reads. `orders.read.restricted` withholds test names ALL-OR-NOTHING and is
                          held by NO ROLE by deliberate design, so this column is blank for every user
                          in the system and rendered `Farida Khatoon · ·`, which reads as a defect.
                        */}
                        <span className="text-muted-foreground">
                          {" · "}
                          {r.orderables.length > 0 ? r.orderables.join(" · ") : t("lab.reports.testsWithheld")}
                          {r.partial && <> · {t("lab.reports.partial")}</>}
                        </span>
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
          <PatientPicker onPick={(hit) => { setPicked(hit); setOpenId(null); setError(null); }} />
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
                        {/*
                          A REASON WHERE A REASON BELONGS. `orders.read.restricted` withholds test
                          names ALL-OR-NOTHING (`reports.ts`, close review pass 1 F3) and is held by
                          NO ROLE by deliberate design — `seed-roles.ts` parks it as a Class-A grant
                          the runbook hands to the owner, because giving it to a bench role "would
                          decide, without anyone noticing, that a role may read every restricted
                          investigation in the building".

                          The control is right and the withholding is right. What nobody had joined
                          up is that the register's test column is therefore blank for EVERY user,
                          rendering `Kavita Sharma · ·` — which reads as a defect and trains the eye
                          to skip it. Found by opening the register in a browser.
                        */}
                        <span className="text-muted-foreground">
                          {r.orderables.length > 0 ? r.orderables.join(" · ") : t("lab.reports.testsWithheld")}
                          {" · "}{r.orderNo}
                        </span>
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
                          {requestedBy[r.reportId] !== undefined ? (
                            <p className="text-xs">{t("lab.reports.releaseRequested", { id: requestedBy[r.reportId] })}</p>
                          ) : mayAsk ? (
                            <Button type="button" variant="outline" size="sm" disabled={ask.isPending} onClick={() => ask.mutate(r)}>
                              {t("lab.reports.requestRelease")}
                            </Button>
                          ) : (
                            <p className="text-xs">{t("lab.reports.askElsewhere")}</p>
                          )}
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="text-sm">
                              {t("lab.reports.approvalId")}
                              <input className="mt-1 block rounded border border-input px-2 py-1 font-mono" value={approvalBy[r.reportId] ?? ""}
                                aria-label={`${t("lab.reports.approvalId")} ${r.orderNo}`}
                                onChange={(e) => setApprovalBy((a) => ({ ...a, [r.reportId]: e.target.value }))} />
                            </label>
                            <label className="text-sm">
                              {t("lab.reports.collector")}
                              <input className="mt-1 block rounded border border-input px-2 py-1" value={collectorOf(r.reportId)}
                                aria-label={`${t("lab.reports.collector")} ${r.orderNo}`}
                                onChange={(e) => setCollectorBy((c) => ({ ...c, [r.reportId]: e.target.value }))} />
                            </label>
                            <Button type="button"
                              disabled={(approvalBy[r.reportId] ?? "").trim() === "" || collectorOf(r.reportId).trim() === "" || release.isPending}
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
                              <select className="mt-1 block rounded border border-input px-2 py-1" value={channelOf(r)}
                                aria-label={`${t("lab.reports.channel")} ${r.orderNo}`}
                                onChange={(e) => setChannelBy((c) => ({ ...c, [r.reportId]: e.target.value as "print" | "in_person" | "whatsapp" }))}>
                                {r.channels.map((c) => <option key={c} value={c}>{t(`lab.reports.channel_${c}`)}</option>)}
                              </select>
                            </label>
                            <label className="text-sm">
                              {t("lab.reports.collector")}
                              <input className="mt-1 block rounded border border-input px-2 py-1" value={collectorOf(r.reportId)}
                                aria-label={`${t("lab.reports.collector")} ${r.orderNo}`}
                                onChange={(e) => setCollectorBy((c) => ({ ...c, [r.reportId]: e.target.value }))} />
                            </label>
                            {/* Pass 2 NEW-2 — a RELEASED report was handed over by the release itself; `printReport` without the approval would refuse. */}
                            {r.delivery.reason !== "released_by_approval" && (
                              <Button type="button"
                                disabled={hand.isPending || (channelOf(r) !== "whatsapp" && collectorOf(r.reportId).trim() === "")}
                                onClick={() => hand.mutate(r)}>
                                {t("lab.reports.print")}
                              </Button>
                            )}
                            <Button type="button" variant="outline" size="sm" onClick={() => setOpenId(isOpen ? null : r.reportId)}>
                              {isOpen ? "▲" : "▼"}
                            </Button>
                            {isOpen && view !== null && (
                              <Button type="button" variant="outline" size="sm" className="no-print" onClick={() => window.print()}>
                                {t("lab.reports.printPaper")}
                              </Button>
                            )}
                            {/*
                              17d T7 / D8 — THE PATIENT'S COPY, IN HINDI (design board EdgeCases #25).
                              A per-report toggle at the COUNTER, where the person asking is standing.
                              It changes the headings, the flag words and the notes; it never touches
                              a value, a unit or a reference interval — those are the same number in
                              every language, and a report whose numbers moved with a toggle would be
                              two documents under one signature.
                            */}
                            {isOpen && view !== null && (
                              <label className="no-print flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={hindiFor.has(r.reportId)}
                                  aria-label={t("lab.reports.hindiCopy")}
                                  onChange={(e) => setHindiFor((prev) => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(r.reportId); else next.delete(r.reportId);
                                    return next;
                                  })}
                                />
                                {t("lab.reports.hindiCopy")}
                              </label>
                            )}
                          </div>
                          {isOpen && view !== null && (
                            <LabReportPrint report={view} lang={hindiFor.has(r.reportId) ? "hi" : "en"} />
                          )}
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
