import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  acknowledgeCritical, benchArrivals, benchWorklist, enterResult, flagTone, LAB_BENCH_TOPIC, LAB_CRITICAL_TOPIC,
  labErrorText, labRefusal, openCriticals, receiveSpecimen, rejectSpecimen,
} from "../lib/lab-api";
import { useRealtime } from "../lib/realtime";
import { Button } from "@/components/ui/button";
import { capFor } from "../components/specimen-label";
import { LabSeatFrame } from "./lab-seat";
import type { WireBenchArrival, WireWorklistRow } from "../lib/lab-api";

/**
 * PLAN 17c T3 — **THE BENCH**: Abha Rani's seat (design board 3).
 *
 * ═══ THE SCAN RESOLVES IN TWO LISTS (D7) ═══
 *
 * An `S` number is matched first against the bench worklist (received tubes), then against the
 * arrivals reader (drawn, not yet received). Neither is "not drawn here today" — the seat never
 * guesses, and never asks the chair's specimen route, which carries no patient by design. Receive
 * starts the TAT clock; a tube drawn without a wristband scan cannot be received until somebody
 * is NAMED as having re-checked identity (02 A2 — the friction is placed where a second person is
 * present).
 *
 * ═══ ONE VALUE, ONE RECORD (D6) ═══
 *
 * Each analyte is its own `enterResult` — its own audit row, its own envelope check, its own
 * critical ladder. "Save & complete" posts the filled values in sequence, one idempotency key each;
 * it is not a batch route, and a refusal on the third value leaves the first two standing as the
 * records they are. The absurd-value override asks for a PERSON (02 H1), carried from 17b.
 *
 * ═══ LIVE, THROUGH THE DEPARTMENT TOPIC (D8) ═══
 *
 * `lab:bench` carries the six tube-and-result events 17b F43 could not route; a frame is a HINT to
 * re-read, and correctness rides the polling query beneath it (the OPD desk's D6 shape). The
 * critical space is watched too, so a potassium of 6.8 keyed on another bench reaches this one.
 */

type CallOutcome = "no_answer" | "engaged" | "message_left" | "spoke";

export type ScanHit =
  | { kind: "worklist"; rows: WireWorklistRow[] }
  | { kind: "arrival"; row: WireBenchArrival }
  | { kind: "none" };

/** D7 — the two lists, in that order, keyed on the tube number the scanner read. */
export function resolveScan(no: string, worklist: readonly WireWorklistRow[], arrivals: readonly WireBenchArrival[]): ScanHit {
  const typed = no.trim().toUpperCase();
  if (typed === "") return { kind: "none" };
  const rows = worklist.filter((r) => r.specimenNo?.toUpperCase() === typed);
  if (rows.length > 0) return { kind: "worklist", rows };
  const row = arrivals.find((a) => a.specimenNo.toUpperCase() === typed);
  if (row !== undefined) return { kind: "arrival", row };
  return { kind: "none" };
}

const REJECT_REASONS = ["haemolysed", "clotted", "insufficient", "wrong_container", "unlabelled",
  "mislabelled", "leaked", "contaminated", "delayed_transport", "temperature_excursion"] as const;

export function LabBench(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [scan, setScan] = useState("");
  const [focusNo, setFocusNo] = useState<string | null>(null);
  const [recheckBy, setRecheckBy] = useState("");
  const [rejectReason, setRejectReason] = useState<(typeof REJECT_REASONS)[number]>("haemolysed");
  const [attributableTo, setAttributableTo] = useState("collection");
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideBy, setOverrideBy] = useState("");
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [readbacks, setReadbacks] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, CallOutcome>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 17d T1 — the suspected swap, held per CELL. A banner that outlived the cell it came from would
   * follow the technologist onto the next patient's tube, which is the opposite of what it is for.
   */
  const [swap, setSwap] = useState<{ cell: string; message: string; suspectSpecimenNos: string[] } | null>(null);
  const [vouchBy, setVouchBy] = useState("");

  const work = useQuery({ queryKey: ["lab", "bench"], queryFn: benchWorklist, refetchInterval: 30_000 });
  const arrivals = useQuery({ queryKey: ["lab", "bench", "arrivals"], queryFn: benchArrivals, refetchInterval: 30_000 });
  const criticals = useQuery({ queryKey: ["lab", "criticals"], queryFn: openCriticals, refetchInterval: 30_000 });

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["lab"] }); };
  const { connected } = useRealtime([LAB_BENCH_TOPIC, LAB_CRITICAL_TOPIC], () => refresh());

  const hit = useMemo(
    () => (focusNo === null ? { kind: "none" as const } : resolveScan(focusNo, work.data ?? [], arrivals.data ?? [])),
    [focusNo, work.data, arrivals.data],
  );

  const accession = useMutation({
    mutationFn: (specimenNo: string) => receiveSpecimen(
      { specimenNo, ...(recheckBy === "" ? {} : { identityRecheckBy: recheckBy }) },
      newIdempotencyKey(),
    ),
    onSuccess: () => { setError(null); setRecheckBy(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const refuse = useMutation({
    mutationFn: (specimenNo: string) => rejectSpecimen({ specimenNo, reason: rejectReason, attributableTo }, newIdempotencyKey()),
    onSuccess: () => { setError(null); setFocusNo(null); setScan(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const key = (itemId: string, analyteId: string): string => `${itemId}:${analyteId}`;
  const post = useMutation({
    mutationFn: (v: { orderItemId: string; analyteId: string; value: string; by?: string; vouch?: string }) =>
      enterResult({
        orderItemId: v.orderItemId, analyteId: v.analyteId, value: v.value, entryMode: "manual",
        ...(v.by === undefined ? {} : { absurdOverride: { by: v.by } }),
        ...(v.vouch === undefined ? {} : { impossibleOverride: { by: v.vouch } }),
      }, newIdempotencyKey()),
    onSuccess: (r, v) => {
      setError(null);
      setOverrideFor(null);
      setOverrideBy("");
      setSwap(null);
      setVouchBy("");
      setValues((prev) => { const next = { ...prev }; delete next[key(v.orderItemId, v.analyteId)]; return next; });
      setNotice(r.criticalCallId !== null ? t("lab.bench.criticalOpened") : null);
      refresh();
    },
    /**
     * 17d T1 — an impossible value is not just another red line of text. It is the only refusal on
     * this screen that says ANOTHER TUBE, in somebody else's hand, may be the wrong way round, so
     * it gets the barcode numbers and a field of its own rather than the shared error strip.
     */
    onError: (e: unknown, v) => {
      const refusal = labRefusal(e);
      if (refusal.code === "analyte_not_applicable") {
        setSwap({ cell: key(v.orderItemId, v.analyteId), message: refusal.message, suspectSpecimenNos: refusal.suspectSpecimenNos });
        setError(null);
        return;
      }
      setSwap(null);
      setError(refusal.message);
    },
  });

  /** D6 — N values, N calls, in order; the first refusal stops the run and is shown verbatim. */
  const saveAll = useMutation({
    mutationFn: async (row: WireWorklistRow) => {
      let opened = false;
      for (const a of row.analytes) {
        const v = values[key(row.orderItemId, a.analyteId)];
        if (a.value !== null || v === undefined || v.trim() === "") continue;
        const r = await enterResult({ orderItemId: row.orderItemId, analyteId: a.analyteId, value: v, entryMode: "manual" }, newIdempotencyKey());
        setValues((prev) => { const next = { ...prev }; delete next[key(row.orderItemId, a.analyteId)]; return next; });
        if (r.criticalCallId !== null) opened = true;
      }
      return opened;
    },
    onSuccess: (opened) => { setError(null); setNotice(opened ? t("lab.bench.criticalOpened") : null); refresh(); },
    onError: (e: unknown) => { setError(labErrorText(e)); refresh(); },
  });

  const ack = useMutation({
    mutationFn: (v: { callId: string; outcome: CallOutcome }) => acknowledgeCritical(v.callId, {
      ...((contacts[v.callId] ?? "") === ""
        ? {}
        : { attempt: { contact: contacts[v.callId]!, outcome: (readbacks[v.callId] ?? "") === "" ? v.outcome : "spoke" } }),
      ...((readbacks[v.callId] ?? "") === "" ? {} : { readback: readbacks[v.callId]! }),
    }),
    onSuccess: (_r, v) => {
      setError(null);
      setContacts((c) => ({ ...c, [v.callId]: "" }));
      setReadbacks((r) => ({ ...r, [v.callId]: "" }));
      setOutcomes((o) => ({ ...o, [v.callId]: "no_answer" }));
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const worklist = work.data ?? [];
  const arrived = arrivals.data ?? [];
  const openCalls = criticals.data ?? [];
  const shownWork = hit.kind === "worklist" ? hit.rows : worklist;

  function filledOf(row: WireWorklistRow): { done: number; total: number; ready: boolean } {
    const total = row.analytes.length;
    const done = row.analytes.filter((a) => a.value !== null).length;
    const pending = row.analytes.filter((a) => a.value === null);
    const ready = pending.length > 0 && pending.every((a) => (values[key(row.orderItemId, a.analyteId)] ?? "").trim() !== "");
    return { done, total, ready };
  }

  return (
    <LabSeatFrame
      title={t("lab.bench.title")}
      place={t("lab.bench.place")}
      stats={[
        { label: t("lab.bench.criticalStat"), value: openCalls.length, tone: openCalls.length > 0 ? "danger" : "plain" },
        { label: t("lab.bench.arrivedStat"), value: arrived.length, tone: arrived.length > 0 ? "waiting" : "plain" },
        { label: t("lab.bench.onBenchStat"), value: worklist.length },
        { label: connected ? t("lab.bench.live") : t("lab.bench.offline"), value: "●", tone: connected ? "live" : "plain" },
      ]}
    >
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); setFocusNo(scan.trim() === "" ? null : scan.trim()); setError(null); }}
      >
        <label className="text-sm">
          {t("lab.bench.scan")}
          <input
            className="mt-1 block w-64 rounded border border-input bg-card px-3 py-2 font-mono"
            placeholder={t("lab.bench.scanHint")}
            aria-label={t("lab.bench.scan")}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
          />
        </label>
        <Button type="submit">{t("lab.bench.scan")}</Button>
        {focusNo !== null && (
          <Button type="button" variant="outline" onClick={() => { setFocusNo(null); setScan(""); }}>{t("lab.bench.worklist")}</Button>
        )}
        <span className="text-xs text-muted-foreground">{t("lab.bench.receiveHint")}</span>
      </form>

      {focusNo !== null && hit.kind === "none" && (
        <p role="alert" className="mb-3 text-sm font-semibold">{t("lab.bench.scanUnknown", { no: focusNo.toUpperCase() })}</p>
      )}
      {error !== null && <p role="alert" className="mb-3 text-sm font-semibold">{error}</p>}
      {notice !== null && <p role="status" className="mb-3 text-sm font-semibold">{notice}</p>}

      {criticals.isError && (
        <p role="alert" className="mb-3 rounded border-2 p-2 text-sm font-bold" style={{ borderColor: "var(--state-danger)" }}>
          {t("lab.bench.criticalsUnavailable")}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        {/* ── arrived · not yet received ── */}
        <section className="space-y-2" aria-label={t("lab.bench.arrivals")}>
          <h2 className="text-sm font-semibold">{t("lab.bench.arrivals")}</h2>
          {arrivals.isError && <p role="alert" className="text-sm font-semibold">{t("lab.bench.arrivalsUnavailable")}</p>}
          <ul className="divide-y divide-border rounded border border-border text-sm">
            {(hit.kind === "arrival" ? [hit.row] : arrived).map((a) => (
              <li key={a.specimenId} className={`space-y-1 px-2 py-1.5 ${hit.kind === "arrival" && hit.row.specimenId === a.specimenId ? "bg-muted" : ""}`}
                data-testid={`arrival-${a.specimenNo}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{a.patientDisplay}</span>
                    {a.priority !== "routine" && <span className="ml-1 text-xs font-semibold uppercase" style={{ color: "var(--state-danger)" }}>{a.priority}</span>}
                    <br />
                    <span className="font-mono">{a.specimenNo}</span>
                    <span className="text-muted-foreground"> · {capFor(a.container)} · {a.orderableCodes.join(", ")}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{a.waitingMinutes} {t("lab.bench.min")}</span>
                </div>
                {!a.wristbandScanned && (
                  <p className="text-xs font-semibold">{t("lab.bench.noBand")} — {t("lab.bench.recheckHint")}</p>
                )}
                {(hit.kind === "arrival" && hit.row.specimenId === a.specimenId) && (
                  <div className="space-y-2 pt-1">
                    {!a.wristbandScanned && (
                      <label className="block text-sm">
                        {t("lab.bench.recheckBy")}
                        <input className="mt-1 block w-full rounded border border-input px-2 py-1" value={recheckBy}
                          onChange={(e) => setRecheckBy(e.target.value)} />
                      </label>
                    )}
                    <Button type="button" disabled={accession.isPending || (!a.wristbandScanned && recheckBy.trim() === "")}
                      onClick={() => accession.mutate(a.specimenNo)}>
                      {t("lab.bench.receive")}
                    </Button>
                    <details className="text-sm">
                      <summary className="cursor-pointer">{t("lab.bench.rejectTitle")}</summary>
                      <div className="mt-1 flex flex-wrap items-end gap-2">
                        <label>{t("lab.bench.rejectReason")}
                          <select className="ml-2 rounded border border-input px-2 py-1" value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value as typeof rejectReason)}>
                            {REJECT_REASONS.map((r) => <option key={r} value={r}>{t(`lab.bench.reason_${r}`)}</option>)}
                          </select>
                        </label>
                        <label>{t("lab.bench.attributableTo")}
                          <select className="ml-2 rounded border border-input px-2 py-1" value={attributableTo}
                            onChange={(e) => setAttributableTo(e.target.value)}>
                            {["collection", "transport", "lab", "patient"].map((x) => <option key={x} value={x}>{t(`lab.bench.blame_${x}`)}</option>)}
                          </select>
                        </label>
                        <Button type="button" variant="outline" disabled={refuse.isPending} onClick={() => refuse.mutate(a.specimenNo)}>
                          {t("lab.bench.reject")}
                        </Button>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{t("lab.bench.rejectHint")}</p>
                    </details>
                  </div>
                )}
              </li>
            ))}
            {arrived.length === 0 && !arrivals.isPending && hit.kind !== "arrival" && (
              <li className="px-2 py-1.5 text-muted-foreground">{t("lab.bench.arrivalsEmpty")}</li>
            )}
          </ul>
        </section>

        {/* ── on the bench · results as they arrive ── */}
        <section className="space-y-3" aria-label={t("lab.bench.onBench")}>
          <h2 className="text-sm font-semibold">{t("lab.bench.onBench")}</h2>
          {work.isError
            ? <p role="alert" className="text-sm font-semibold">{t("lab.bench.worklistUnavailable")}</p>
            : shownWork.length === 0 && !work.isPending && <p className="text-sm text-muted-foreground">{t("lab.bench.empty")}</p>}
          {shownWork.map((row) => {
            const filled = filledOf(row);
            const elapsed = row.tatStartedAt === null ? null : Math.max(0, Math.floor((Date.now() - new Date(row.tatStartedAt).getTime()) / 60_000));
            return (
              <article key={row.orderItemId} className="space-y-2 rounded border border-border bg-card p-3" data-testid={`item-${row.orderItemId}`}>
                <header className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="text-base font-semibold">{row.patientDisplay}</span>
                  <span className="font-mono text-muted-foreground">{row.specimenNo ?? "—"}</span>
                  <span className="font-semibold">{row.orderableCode}</span>
                  <span className="text-muted-foreground">{row.orderableName}</span>
                  {row.priority !== "routine" && <span className="text-xs font-semibold uppercase" style={{ color: "var(--state-danger)" }}>{row.priority}</span>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {elapsed !== null && <>{t("lab.bench.tat")} {elapsed} {t("lab.bench.min")} · </>}
                    {t("lab.bench.filled", { done: filled.done, total: filled.total })}
                  </span>
                </header>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1">{t("lab.bench.gridAnalyte")}</th>
                      <th>{t("lab.bench.gridResult")}</th>
                      <th>{t("lab.bench.gridUnit")}</th>
                      <th>{t("lab.bench.gridRef")}</th>
                      <th>{t("lab.bench.gridFlag")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {row.analytes.map((a) => {
                      const cell = key(row.orderItemId, a.analyteId);
                      const tone = flagTone(a.flag);
                      const ref = a.refText ?? (a.refLow !== null || a.refHigh !== null ? `${a.refLow ?? ""} – ${a.refHigh ?? ""}` : "");
                      return (
                        <tr key={a.analyteId} className="border-t border-border">
                          <td className="py-1 pr-2">{a.nameEn} <span className="text-xs text-muted-foreground">{a.code}</span></td>
                          <td className="pr-2">
                            {a.value === null ? (
                              <input
                                className="w-28 rounded border border-input px-2 py-0.5 tabular-nums"
                                aria-label={`${row.orderableCode} ${a.code}`}
                                value={values[cell] ?? ""}
                                onChange={(e) => setValues((v) => ({ ...v, [cell]: e.target.value }))}
                              />
                            ) : (
                              <span className={`tabular-nums ${tone === "critical" ? "font-bold" : tone === "abnormal" ? "font-semibold" : ""}`}
                                style={tone === "critical" ? { color: "var(--state-danger)" } : undefined}>
                                {a.value}
                              </span>
                            )}
                          </td>
                          <td className="pr-2 text-xs text-muted-foreground">{a.unit ?? ""}</td>
                          <td className="pr-2 text-xs text-muted-foreground">{ref}</td>
                          <td className="pr-2 font-semibold">{a.flag ?? ""}</td>
                          <td className="whitespace-nowrap">
                            {a.value === null && (
                              <>
                                <Button type="button" size="sm" variant="outline"
                                  onClick={() => post.mutate({
                                    orderItemId: row.orderItemId, analyteId: a.analyteId,
                                    value: values[cell] ?? "",
                                    ...(overrideFor === cell && overrideBy !== "" ? { by: overrideBy } : {}),
                                  })}
                                >{t("lab.bench.save")}</Button>
                                <button type="button" className="ml-2 text-xs underline"
                                  onClick={() => setOverrideFor(overrideFor === cell ? null : cell)}>
                                  {t("lab.bench.override")}
                                </button>
                                {overrideFor === cell && (
                                  <input
                                    className="ml-2 rounded border border-input px-2 py-0.5"
                                    placeholder={t("lab.bench.overrideByHint")}
                                    aria-label={t("lab.bench.overrideBy")}
                                    value={overrideBy}
                                    onChange={(e) => setOverrideBy(e.target.value)}
                                  />
                                )}
                                {/*
                                  17d T1 — THE SUSPECTED SWAP. Not a line in the shared error strip:
                                  it names the OTHER barcode so the technologist can pick that tube
                                  up, and it asks for a second person by login before the value is
                                  allowed through. The server refuses again if the second person is
                                  the enterer — this field is the prompt, never the control.
                                */}
                                {swap !== null && swap.cell === cell && (
                                  <div role="alert" className="mt-2 rounded border-2 p-2 text-xs"
                                    style={{ borderColor: "var(--state-danger)" }}>
                                    <p className="font-bold">{t("lab.bench.swapSuspected")}</p>
                                    <p className="mt-1">{swap.message}</p>
                                    {swap.suspectSpecimenNos.length > 0 && (
                                      <p className="mt-1 font-semibold tabular-nums">
                                        {t("lab.bench.swapCheckTubes", { nos: swap.suspectSpecimenNos.join(", ") })}
                                      </p>
                                    )}
                                    <label className="mt-2 flex items-center gap-2">
                                      <span>{t("lab.bench.vouchBy")}</span>
                                      <input
                                        className="rounded border border-input px-2 py-0.5"
                                        placeholder={t("lab.bench.overrideByHint")}
                                        aria-label={t("lab.bench.vouchBy")}
                                        value={vouchBy}
                                        onChange={(e) => setVouchBy(e.target.value)}
                                      />
                                      <Button type="button" size="sm" variant="outline"
                                        disabled={vouchBy.trim() === ""}
                                        onClick={() => post.mutate({
                                          orderItemId: row.orderItemId, analyteId: a.analyteId,
                                          value: values[cell] ?? "", vouch: vouchBy.trim(),
                                        })}
                                      >{t("lab.bench.vouchSave")}</Button>
                                    </label>
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="flex items-center gap-3">
                  <Button type="button" disabled={!filled.ready || saveAll.isPending} onClick={() => saveAll.mutate(row)}>
                    {t("lab.bench.saveAll")}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t("lab.bench.saveAllHint")}</span>
                </div>
              </article>
            );
          })}
        </section>

        {/* ── critical values — telephone now ── */}
        <section className="space-y-2" aria-label={t("lab.bench.criticalsOpen")}>
          <h2 className="text-sm font-bold" style={openCalls.length > 0 ? { color: "var(--state-danger)" } : undefined}>
            {t("lab.bench.criticalsOpen")}
          </h2>
          {!criticals.isError && openCalls.length === 0 && <p className="text-sm text-muted-foreground">—</p>}
          {!criticals.isError && openCalls.map((c) => (
            <div key={c.id} className="space-y-1 rounded border-2 p-2 text-sm" style={{ borderColor: "var(--state-danger)" }}>
              <p className="font-semibold">
                {c.patientDisplay} · {c.analyteCode} {c.value} {c.unit ?? ""} {c.flag ?? ""}
              </p>
              {c.supersededBy != null && (
                <p className="font-bold">
                  {t("lab.bench.retracted", { value: c.supersededBy.value, flag: c.supersededBy.flag ?? "" })}
                </p>
              )}
              <p className="text-xs">
                {c.orderNo} · {t("lab.bench.callOpenedAt")} {c.openedAt} · {t("lab.bench.attempts")}: {c.attempts.length}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <input className="rounded border border-input px-2 py-1" placeholder={t("lab.bench.contact")}
                  aria-label={`${t("lab.bench.contact")} ${c.patientDisplay}`}
                  value={contacts[c.id] ?? ""}
                  onChange={(e) => setContacts((x) => ({ ...x, [c.id]: e.target.value }))} />
                <select className="rounded border border-input px-2 py-1" aria-label={t("lab.bench.outcome")}
                  value={outcomes[c.id] ?? "no_answer"}
                  onChange={(e) => setOutcomes((x) => ({ ...x, [c.id]: e.target.value as CallOutcome }))}>
                  {(["no_answer", "engaged", "message_left", "spoke"] as const).map((o) => (
                    <option key={o} value={o}>{t(`lab.bench.outcome_${o}`)}</option>
                  ))}
                </select>
                <input className="rounded border border-input px-2 py-1" placeholder={t("lab.bench.readback")}
                  aria-label={`${t("lab.bench.readback")} ${c.patientDisplay}`}
                  value={readbacks[c.id] ?? ""}
                  onChange={(e) => setReadbacks((x) => ({ ...x, [c.id]: e.target.value }))} />
                <Button type="button" disabled={ack.isPending}
                  onClick={() => ack.mutate({ callId: c.id, outcome: outcomes[c.id] ?? "no_answer" })}>
                  {t("lab.bench.record")}
                </Button>
              </div>
              <p className="text-xs">{t("lab.bench.readbackRule")}</p>
            </div>
          ))}
        </section>
      </div>
    </LabSeatFrame>
  );
}
