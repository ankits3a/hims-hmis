import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  amendReport, flagTone, getReport, LAB_BENCH_TOPIC, LAB_CRITICAL_TOPIC, labErrorText, nightReleases,
  openCriticals, printReport, publishableOrders, publishReport, requestRerun, reviewNightRelease,
  verifyResult, verifyWorklist,
} from "../lib/lab-api";
import { useRealtime } from "../lib/realtime";
import { LabReportPrint } from "../components/lab-report-print";
import { Button } from "@/components/ui/button";
import { LabSeatFrame } from "./lab-seat";
import type { WireCriticalCall, WireReportView, WireWorklistRow } from "../lib/lab-api";

/**
 * PLAN 17c T4 — **VERIFY & REPORT**: Dr Iyer's seat (design board 4).
 *
 * ═══ THE QUEUE: CRITICALS AND STAT FIRST, THEN THE OLDEST ═══
 *
 * A row with a critical flag or an open call outranks everything; STAT outranks routine; within a
 * rank the oldest clock goes first. The order is computed on the screen from what the two readers
 * return (`verifyWorklist`, `openCriticals`) — no new server sort, and the assertion is on the
 * pure function so a reordering cannot pass silently.
 *
 * ═══ THE PREVIOUS VALUE IS THE LAST SIGNED ONE (D11) ═══
 *
 * `previous` comes from the worklist reader: the newest VERIFIED result of the same analyte on the
 * canonical patient, across the merge chain, never an unsigned row. The delta shown beside it is
 * arithmetic on two numbers the server chose; the flag is the server's.
 *
 * ═══ SIGN N IS N SIGNATURES (D6's rule, one seat over) ═══
 *
 * Each `verifyResult` is its own record and its own separation-of-duties check. "Sign N results"
 * runs them in order and stops at the first refusal with the server's words — a pathologist who
 * keyed one of the numbers is refused on that one, and the others stand signed.
 *
 * Carried from 17b unchanged: the publish queue (full / partial / the rest as an amendment), the
 * report rendered ONLY when the interlock says it may be handed over, the collector's name.
 */

type QueueRow = WireWorklistRow & { hasCritical: boolean; openCall: boolean; ageMinutes: number };

export function orderQueue(rows: readonly WireWorklistRow[], calls: readonly WireCriticalCall[], now = Date.now()): QueueRow[] {
  const callOrders = new Set(calls.map((c) => c.orderNo));
  const rank: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
  return rows
    .map((r) => ({
      ...r,
      hasCritical: r.analytes.some((a) => flagTone(a.flag) === "critical"),
      openCall: callOrders.has(r.orderNo),
      ageMinutes: r.tatStartedAt === null ? 0 : Math.max(0, Math.floor((now - new Date(r.tatStartedAt).getTime()) / 60_000)),
    }))
    .sort((a, b) =>
      Number(b.hasCritical || b.openCall) - Number(a.hasCritical || a.openCall)
      || (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3)
      || b.ageMinutes - a.ageMinutes);
}

/** "Δ −55" — the arithmetic on two numbers the server chose; null when either is not a number. */
export function deltaText(value: string | null, previous: string | null): string | null {
  if (value === null || previous === null) return null;
  const a = Number(value);
  const b = Number(previous);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = a - b;
  const rounded = Math.round(d * 100) / 100;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${String(Math.abs(rounded))}`;
}

function daysAgo(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

export function LabVerify(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [open, setOpen] = useState<WireReportView | null>(null);
  const [collector, setCollector] = useState("");
  const [channel, setChannel] = useState<"print" | "in_person" | "whatsapp">("print");
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({ queryKey: ["lab", "verify"], queryFn: verifyWorklist, refetchInterval: 30_000 });
  const calls = useQuery({ queryKey: ["lab", "criticals"], queryFn: openCriticals, refetchInterval: 30_000 });
  const publishable = useQuery({ queryKey: ["lab", "publishable"], queryFn: publishableOrders, refetchInterval: 30_000 });
  /**
   * DD11 §7 — THE MORNING QUEUE. Night mode relaxes separation of duties and this is the
   * compensating review. It shipped with no screen at all: the runbook's own words were *"somebody
   * must work it, and this build ships no screen filter for it — read `lab_results` where
   * `pathologist_review_pending` is true."*
   */
  const nights = useQuery({ queryKey: ["lab", "night-releases"], queryFn: nightReleases, refetchInterval: 30_000 });
  const review = useMutation({
    mutationFn: (resultId: string) => reviewNightRelease(resultId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lab", "night-releases"] }); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["lab"] }); };
  const { connected } = useRealtime([LAB_BENCH_TOPIC, LAB_CRITICAL_TOPIC], () => refresh());

  const ordered = useMemo(() => orderQueue(queue.data ?? [], calls.data ?? []), [queue.data, calls.data]);
  /** One patient's rows, grouped by ORDER: the seat signs a visit's results together (board 4). */
  const groups = useMemo(() => {
    const byOrder = new Map<string, QueueRow[]>();
    for (const r of ordered) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    return [...byOrder.entries()].map(([orderId, rows]) => ({ orderId, rows }));
  }, [ordered]);
  const selected = groups.find((g) => g.orderId === selectedOrder) ?? null;

  const sign = useMutation({
    mutationFn: (resultId: string) => verifyResult(resultId, newIdempotencyKey()),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const signAll = useMutation({
    mutationFn: async (rows: QueueRow[]) => {
      let signed = 0;
      for (const row of rows) {
        for (const a of row.analytes) {
          if (a.resultId === null || a.verificationStatus !== "unverified") continue;
          await verifyResult(a.resultId, newIdempotencyKey());
          signed += 1;
        }
      }
      return signed;
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: unknown) => { setError(labErrorText(e)); refresh(); },
  });
  const rerun = useMutation({
    mutationFn: (resultId: string) => requestRerun(resultId, t("lab.verify.rerunReason"), newIdempotencyKey()),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const openReport = async (reportId: string): Promise<void> => {
    const view = await getReport(reportId);
    setOpen(view);
    setChannel((view.channels[0] ?? "in_person") as typeof channel);
    setCollector("");
  };
  const publish = useMutation({
    mutationFn: (v: { orderId: string; partial: boolean; amendsReportId: string | null }) =>
      v.amendsReportId === null
        ? publishReport(v.orderId, newIdempotencyKey(), v.partial)
        : amendReport(v.amendsReportId, "added_analyte", newIdempotencyKey()),
    onSuccess: async (r) => { setError(null); await openReport(r.reportId); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const hand = useMutation({
    mutationFn: (v: { reportId: string; channel: "print" | "in_person" | "whatsapp" }) => printReport(
      v.reportId,
      v.channel === "whatsapp" ? { channel: v.channel } : { channel: v.channel, collectorIdentity: collector },
      newIdempotencyKey(),
    ),
    onSuccess: async () => { setError(null); if (open !== null) await openReport(open.reportId); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const criticalCount = ordered.filter((r) => r.hasCritical || r.openCall).length;
  const oldest = ordered.reduce((m, r) => Math.max(m, r.ageMinutes), 0);

  return (
    <LabSeatFrame
      title={t("lab.verify.title")}
      place={t("lab.verify.place")}
      stats={[
        { label: t("lab.verify.criticalStat"), value: criticalCount, tone: criticalCount > 0 ? "danger" : "plain" },
        { label: t("lab.verify.awaitingStat"), value: groups.length },
        { label: t("lab.verify.oldestStat"), value: `${String(oldest)} ${t("lab.verify.min")}` },
        { label: connected ? t("lab.verify.live") : t("lab.verify.offline"), value: "●", tone: connected ? "live" : "plain" },
      ]}
    >
      {error !== null && <p role="alert" className="mb-3 text-sm font-semibold">{error}</p>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* ── awaiting signature · criticals and STAT first ── */}
        <section className="space-y-2" aria-label={t("lab.verify.queue")}>
          <h2 className="text-sm font-semibold">{t("lab.verify.queue")}</h2>
          {queue.isError
            ? <p role="alert" className="text-sm font-semibold">{t("lab.verify.unavailable")}</p>
            : groups.length === 0 && !queue.isPending && <p className="text-sm text-muted-foreground">{t("lab.verify.empty")}</p>}
          <ul className="divide-y divide-border rounded border border-border text-sm" data-testid="verify-queue">
            {groups.map((g) => {
              const first = g.rows[0]!;
              const urgent = g.rows.some((r) => r.hasCritical || r.openCall);
              return (
                <li key={g.orderId}>
                  <button type="button"
                    className={`flex w-full items-center gap-3 px-2 py-1.5 text-left hover:bg-muted ${g.orderId === selectedOrder ? "bg-muted" : ""}`}
                    onClick={() => { setSelectedOrder(g.orderId); setError(null); }}>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{first.patientDisplay}</span>
                      <span className="text-muted-foreground"> · {g.rows.map((r) => r.orderableCode).join(" · ")}</span>
                      {urgent && <span className="ml-1 font-semibold" style={{ color: "var(--state-danger)" }}>
                        {g.rows.some((r) => r.openCall) ? t("lab.verify.criticalCall") : "!!"}
                      </span>}
                    </span>
                    {first.priority !== "routine" && (
                      <span className="shrink-0 text-xs font-semibold uppercase" style={{ color: "var(--state-danger)" }}>{first.priority}</span>
                    )}
                    <span className="shrink-0 tabular-nums text-muted-foreground">{Math.max(...g.rows.map((r) => r.ageMinutes))} {t("lab.verify.min")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t("lab.verify.autoVerifyNote")}</p>

          {/*
            ═══ DD11 — RELEASED OVERNIGHT, AWAITING THE SECOND PAIR OF HANDS ═══

            Shown only when there is something to work, because a heading over an empty list on every
            day shift is how a reviewer learns to skip the section on the morning it is not empty.

            Each row carries WHO released it alone. That is the fact the review is about, and a queue
            that hid it behind a click would be worked by clicking.
          */}
          {(nights.data ?? []).length > 0 && (
            <section className="space-y-2 pt-2" aria-label={t("lab.verify.nightQueue")}>
              <h2 className="text-sm font-semibold">{t("lab.verify.nightQueue")}</h2>
              <p className="text-xs text-muted-foreground">{t("lab.verify.nightQueueHint")}</p>
              <ul className="divide-y divide-border rounded border border-border">
                {(nights.data ?? []).map((r) => (
                  <li key={r.resultId} data-testid={`night-${r.resultId}`} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <span className="font-semibold">{r.patientDisplay}</span>
                    <span className="text-muted-foreground">{r.analyteCode} {r.value}{r.unit !== null && ` ${r.unit}`}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t("lab.verify.releasedBy", { who: r.releasedBy })}
                    </span>
                    <Button type="button" variant="outline" size="sm" disabled={review.isPending}
                      onClick={() => { review.mutate(r.resultId); }}>
                      {t("lab.verify.reviewed")}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <h2 className="pt-2 text-sm font-semibold">{t("lab.verify.publishQueue")}</h2>
          {publishable.isError
            ? <p role="alert" className="text-sm font-semibold">{t("lab.verify.unavailable")}</p>
            : (publishable.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">{t("lab.verify.publishEmpty")}</p>}
          {(publishable.data ?? []).map((o) => (
            <article key={o.orderId} className="flex flex-wrap items-baseline gap-2 rounded border border-border p-2 text-sm">
              <span className="font-mono">{o.orderNo}</span>
              <span>{o.patientDisplay}</span>
              <span className="text-xs text-muted-foreground">{o.orderables.join(", ")} · {o.completedCount}/{o.itemCount}</span>
              {o.amendsReportId != null ? (
                <Button type="button" size="sm" disabled={publish.isPending}
                  onClick={() => publish.mutate({ orderId: o.orderId, partial: !o.complete, amendsReportId: o.amendsReportId })}>
                  {t("lab.verify.publishRest")}
                </Button>
              ) : o.complete ? (
                <Button type="button" size="sm" disabled={publish.isPending}
                  onClick={() => publish.mutate({ orderId: o.orderId, partial: false, amendsReportId: null })}>
                  {t("lab.verify.publish")}
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={publish.isPending}
                  onClick={() => publish.mutate({ orderId: o.orderId, partial: true, amendsReportId: null })}>
                  {t("lab.verify.publishPartial")}
                </Button>
              )}
            </article>
          ))}
        </section>

        {/* ── the patient's results, against range, previous and the clock ── */}
        <section className="space-y-3">
          {selected === null && open === null && <p className="text-sm text-muted-foreground">{t("lab.verify.pickOne")}</p>}
          {selected !== null && (() => {
            const first = selected.rows[0]!;
            const unsigned = selected.rows.flatMap((r) => r.analytes.filter((a) => a.resultId !== null && a.verificationStatus === "unverified"));
            return (
              <div className="space-y-3" data-testid="verify-detail">
                <div className="rounded border border-border bg-card p-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-lg font-semibold">{first.patientDisplay}</span>
                    <span className="font-mono text-muted-foreground">{first.orderNo}</span>
                    <span className="text-muted-foreground">{first.encounterNo}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {selected.rows.map((r) => {
                      const over = r.ageMinutes > r.tatTargetMinutes;
                      return (
                        <span key={r.orderItemId} className="mr-3">
                          {r.orderableCode}: {t("lab.verify.tatOf", { elapsed: r.ageMinutes, target: r.tatTargetMinutes })}{" "}
                          <span style={{ color: over ? "var(--state-danger)" : "var(--state-settled)" }}>
                            {over ? t("lab.verify.breached") : t("lab.verify.insideTarget")}
                          </span>
                        </span>
                      );
                    })}
                  </p>
                  {selected.rows.some((r) => r.openCall) && (
                    <p className="font-semibold" style={{ color: "var(--state-danger)" }}>{t("lab.verify.criticalCall")}</p>
                  )}
                </div>

                {selected.rows.map((row) => (
                  <table key={row.orderItemId} className="w-full text-sm" data-testid={`panel-${row.orderableCode}`}>
                    <caption className="py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {row.orderableName} · {row.specimenNo ?? "—"}
                    </caption>
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-1">{t("lab.verify.colAnalyte")}</th>
                        <th>{t("lab.verify.colResult")}</th>
                        <th>{t("lab.verify.colFlag")}</th>
                        <th>{t("lab.verify.colRef")}</th>
                        <th>{t("lab.verify.colPrev")}</th>
                        <th>{t("lab.verify.colNote")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {row.analytes.filter((a) => a.resultId !== null).map((a) => {
                        const tone = flagTone(a.flag);
                        const delta = deltaText(a.value, a.previous?.value ?? null);
                        return (
                          <tr key={a.analyteId} className="border-t border-border" data-testid={`row-${a.code}`}>
                            <td className="py-1 pr-2">{a.nameEn}</td>
                            <td className={`pr-2 tabular-nums ${tone === "critical" ? "font-bold" : tone === "abnormal" ? "font-semibold" : ""}`}
                              style={tone === "critical" ? { color: "var(--state-danger)" } : undefined}>
                              {a.value} <span className="text-xs text-muted-foreground">{a.unit ?? ""}</span>
                            </td>
                            <td className="pr-2 font-semibold">{a.flag ?? ""}</td>
                            <td className="pr-2 text-xs text-muted-foreground">
                              {a.refLow !== null && a.refHigh !== null ? `${a.refLow} – ${a.refHigh}` : (a.refText ?? "")}
                            </td>
                            <td className="pr-2 tabular-nums">{a.previous === null ? t("lab.verify.noPrev") : a.previous.value}</td>
                            <td className="pr-2 text-xs text-muted-foreground">
                              {delta !== null && a.previous !== null && (
                                <span>{t("lab.verify.delta", { delta, when: `${String(daysAgo(a.previous.at))} d` })}</span>
                              )}
                              {a.verificationStatus === "verified" && <span className="ml-1">{t("lab.verify.signed")}</span>}
                            </td>
                            <td className="whitespace-nowrap">
                              {a.verificationStatus === "unverified" && (
                                <>
                                  <Button type="button" size="sm" variant="outline" onClick={() => sign.mutate(a.resultId!)}>
                                    {t("lab.verify.sign")}
                                  </Button>
                                  <button type="button" className="ml-2 text-xs underline" onClick={() => rerun.mutate(a.resultId!)}>
                                    {t("lab.verify.rerun")}
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ))}

                <div className="flex items-center gap-3">
                  <Button type="button" disabled={unsigned.length === 0 || signAll.isPending} onClick={() => signAll.mutate(selected.rows)}>
                    {t("lab.verify.signAll", { count: unsigned.length })}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t("lab.verify.signAllHint")}</span>
                </div>
              </div>
            );
          })()}

          {open !== null && (
            <section className="space-y-2 border-t border-border pt-3">
              <h2 className="text-sm font-semibold">
                {t("lab.verify.report")} {open.snapshot.orderNo} · v{open.version}
              </h2>
              {!open.delivery.allowed && (
                <p role="alert" className="text-sm font-semibold">
                  {t("lab.verify.held", {
                    amount: (open.delivery.outstandingPaise / 100).toFixed(2),
                    count: open.delivery.unpaidInvoiceIds.length,
                  })}
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  {t("lab.verify.channel")}
                  <select className="mt-1 block rounded border border-input px-2 py-1" value={channel}
                    onChange={(e) => setChannel(e.target.value as typeof channel)}>
                    {open.channels.map((c) => <option key={c} value={c}>{t(`lab.verify.channel_${c}`)}</option>)}
                  </select>
                </label>
                <label className="text-sm">
                  {t("lab.verify.collector")}
                  <input className="mt-1 block rounded border border-input px-2 py-1" value={collector}
                    onChange={(e) => setCollector(e.target.value)} />
                </label>
                <Button
                  type="button"
                  disabled={!open.delivery.allowed || hand.isPending || (channel !== "whatsapp" && collector.trim() === "")}
                  onClick={() => hand.mutate({ reportId: open.reportId, channel })}
                >{t("lab.verify.print")}</Button>
              </div>
              {/* The document is rendered ONLY when it may be handed over (17b close review, web MAJOR). */}
              {open.delivery.allowed
                ? <LabReportPrint report={open} />
                : <p className="text-sm">{t("lab.verify.heldNoPreview")}</p>}
            </section>
          )}
        </section>
      </div>
    </LabSeatFrame>
  );
}
