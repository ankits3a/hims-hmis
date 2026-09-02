import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { awaitingLabels, collectionQueue, drawSpecimen, istToday, labErrorText, printLabels } from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import { capFor, drawRank, SpecimenLabel } from "../components/specimen-label";
import { LabSeatFrame } from "./lab-seat";
import type { WireAwaitingRow, WireCollectionRow } from "../lib/lab-api";

/**
 * PLAN 17c T2 — **COLLECTION**: Vikas's chair (design board 2).
 *
 * ═══ TWO HALVES OF ONE QUEUE ═══
 *
 * 17a's queue listed TUBES, and a tube exists only after `printLabels`; a patient who had just
 * left reception was on nobody's list. `GET /lab/collection/awaiting` is the other half — order
 * groups with no label yet — and the seat shows both as one list: STAT first, then by how long
 * each has waited, the token on every row so the chair can call it out.
 *
 * ═══ THE SCAN FIELD IS EMPTY EVERY TIME (DD10 / E1 — carried from 17b) ═══
 *
 * `scannedUhid` is never pre-filled from the queue row: a field pre-filled with the UHID the
 * screen already knows turns the right-patient check into a formality. The server compares and
 * refuses `tube_mismatch` before any tube exists.
 *
 * ═══ ONE BARCODE PER TUBE, SCANNED AFTER IT IS FILLED ═══
 *
 * Labels print in ORDER OF DRAW (D5). Each tube has its own scan field; the `S` number typed or
 * scanned must be THAT tube's — a scan that names another tube is refused on the screen, before
 * the draw is recorded — and the draw is recorded per tube, wristband-scanned when the labels were
 * printed off a scanned wristband. "Drawn — to the lab" lights when every tube is scanned; it is a
 * summary, not a second write.
 */

type QueueEntry =
  | { kind: "awaiting"; key: string; row: WireAwaitingRow }
  | { kind: "labelled"; key: string; group: string; tubes: WireCollectionRow[] };

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };

export function mergeQueue(awaiting: readonly WireAwaitingRow[], tubes: readonly WireCollectionRow[]): QueueEntry[] {
  const byGroup = new Map<string, WireCollectionRow[]>();
  for (const t of tubes) {
    const g = byGroup.get(t.orderGroupId) ?? [];
    g.push(t);
    byGroup.set(t.orderGroupId, g);
  }
  const entries: QueueEntry[] = [
    ...awaiting.map((row) => ({ kind: "awaiting" as const, key: `a-${row.orderGroupId}`, row })),
    ...[...byGroup.entries()].map(([group, list]) => ({
      kind: "labelled" as const, key: `l-${group}`, group,
      tubes: [...list].sort((a, b) => drawRank(a.container) - drawRank(b.container) || a.specimenNo.localeCompare(b.specimenNo)),
    })),
  ];
  const priorityOf = (e: QueueEntry): number =>
    e.kind === "awaiting" ? (PRIORITY_RANK[e.row.priority] ?? 3)
      : Math.min(...e.tubes.map((t) => PRIORITY_RANK[t.priority] ?? 3));
  const waitOf = (e: QueueEntry): number =>
    e.kind === "awaiting" ? e.row.waitingMinutes : Math.max(...e.tubes.map((t) => t.waitingMinutes));
  return entries.sort((a, b) => priorityOf(a) - priorityOf(b) || waitOf(b) - waitOf(a));
}

export function LabCollection(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const serviceDate = istToday();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scannedUhid, setScannedUhid] = useState("");
  /** Per order group: were this group's labels printed off a scanned wristband here? */
  const [scannedGroups, setScannedGroups] = useState<Record<string, boolean>>({});
  const [tubeScan, setTubeScan] = useState<Record<string, string>>({});
  const [drawn, setDrawn] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const awaiting = useQuery({
    queryKey: ["lab", "collection", "awaiting", serviceDate],
    queryFn: () => awaitingLabels(serviceDate),
    refetchInterval: 20_000,
  });
  const tubes = useQuery({
    queryKey: ["lab", "collection", serviceDate],
    queryFn: () => collectionQueue(serviceDate),
    refetchInterval: 20_000,
  });

  const queue = useMemo(() => mergeQueue(awaiting.data ?? [], tubes.data ?? []), [awaiting.data, tubes.data]);
  const selected = queue.find((e) => e.key === selectedKey) ?? null;

  const label = useMutation({
    mutationFn: (orderGroupId: string) => printLabels(orderGroupId, scannedUhid, newIdempotencyKey()),
    onSuccess: (_r, orderGroupId) => {
      setError(null);
      setScannedGroups((g) => ({ ...g, [orderGroupId]: true }));
      /** THE SCAN IS CLEARED AFTER EVERY PRINT — the next patient is scanned, not remembered. */
      setScannedUhid("");
      setSelectedKey(`l-${orderGroupId}`);
      void qc.invalidateQueries({ queryKey: ["lab", "collection"] });
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const draw = useMutation({
    mutationFn: (input: { specimenId: string; wristbandScanned: boolean }) =>
      drawSpecimen(input.specimenId, input.wristbandScanned, newIdempotencyKey()),
    onSuccess: (_r, input) => {
      setError(null);
      setDrawn((d) => ({ ...d, [input.specimenId]: true }));
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  function scanTube(tube: WireCollectionRow, value: string, wristband: boolean): void {
    setTubeScan((s) => ({ ...s, [tube.specimenId]: value }));
    const typed = value.trim().toUpperCase();
    if (typed === "") return;
    if (typed !== tube.specimenNo.toUpperCase()) {
      setError(t("lab.collection.wrongTube", { typed, tube: tube.specimenNo }));
      return;
    }
    setError(null);
    if (!drawn[tube.specimenId]) draw.mutate({ specimenId: tube.specimenId, wristbandScanned: wristband });
  }

  const waitingCount = queue.length;
  const longest = queue.reduce((m, e) => Math.max(m, e.kind === "awaiting" ? e.row.waitingMinutes : Math.max(...e.tubes.map((x) => x.waitingMinutes))), 0);

  return (
    <LabSeatFrame
      title={t("lab.collection.title")}
      place={t("lab.collection.place")}
      stats={[
        { label: t("lab.collection.waitingStat"), value: waitingCount, tone: waitingCount >= 6 ? "waiting" : "plain" },
        { label: t("lab.collection.longestStat"), value: `${String(longest)} ${t("lab.collection.min")}` },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* ── waiting · STAT first, then by arrival ── */}
        <section className="space-y-2" aria-label={t("lab.collection.queue")}>
          <h2 className="text-sm font-semibold">{t("lab.collection.queue")}</h2>
          {(awaiting.isError || tubes.isError) && <p role="alert" className="text-sm font-semibold">{t("lab.collection.unavailable")}</p>}
          <ul className="divide-y divide-border rounded border border-border text-sm">
            {queue.map((e) => {
              const token = e.kind === "awaiting" ? e.row.tokenNo : e.tubes[0]!.tokenNo;
              const name = e.kind === "awaiting" ? e.row.patientDisplay : e.tubes[0]!.patientDisplay;
              const priority = e.kind === "awaiting" ? e.row.priority : e.tubes[0]!.priority;
              const fasting = e.kind === "awaiting" ? e.row.requiresFasting : e.tubes.some((x) => x.requiresFasting);
              const wait = e.kind === "awaiting" ? e.row.waitingMinutes : Math.max(...e.tubes.map((x) => x.waitingMinutes));
              return (
                <li key={e.key}>
                  <button type="button"
                    className={`flex w-full items-center gap-3 px-2 py-1.5 text-left hover:bg-muted ${e.key === selectedKey ? "bg-muted" : ""}`}
                    onClick={() => { setSelectedKey(e.key); setError(null); }}>
                    <span className="w-14 shrink-0 font-mono font-semibold">{token === null ? "—" : `T-${String(token)}`}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {e.kind === "awaiting"
                          ? t("lab.collection.labelNeeded")
                          : t("lab.collection.tubeCount", { count: e.tubes.length })}
                        {fasting && <> · {t("lab.collection.fasting")}</>}
                      </span>
                    </span>
                    {priority !== "routine" && (
                      <span className="shrink-0 text-xs font-semibold uppercase" style={{ color: "var(--state-danger)" }}>{priority}</span>
                    )}
                    <span className="shrink-0 tabular-nums text-muted-foreground">{wait} {t("lab.collection.min")}</span>
                  </button>
                </li>
              );
            })}
            {queue.length === 0 && !awaiting.isPending && !tubes.isPending && (
              <li className="px-2 py-1.5 text-muted-foreground">{t("lab.collection.empty")}</li>
            )}
          </ul>
          <p className="text-xs text-muted-foreground">{t("lab.collection.wardNote")}</p>
        </section>

        {/* ── the patient in the chair ── */}
        <section className="space-y-3">
          {selected === null && <p className="text-sm text-muted-foreground">{t("lab.collection.pickOne")}</p>}

          {selected?.kind === "awaiting" && (
            <div className="space-y-3">
              <PatientCard
                display={selected.row.patientDisplay} uhid={selected.row.uhid} encounterNo={selected.row.encounterNo}
                tokenNo={selected.row.tokenNo} fasting={selected.row.requiresFasting} codes={selected.row.orderableCodes}
              />
              <form className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => { e.preventDefault(); if (scannedUhid !== "") label.mutate(selected.row.orderGroupId); }}>
                <label className="text-sm">
                  {t("lab.collection.scan")}
                  <input
                    className="mt-1 block rounded border border-input px-2 py-1"
                    placeholder={t("lab.collection.scanHint")}
                    value={scannedUhid}
                    onChange={(e) => setScannedUhid(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={scannedUhid === "" || label.isPending}>
                  {t("lab.collection.printLabels")}
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">{t("lab.collection.noBandNote")}</p>
            </div>
          )}

          {selected?.kind === "labelled" && (() => {
            const first = selected.tubes[0]!;
            const wristband = scannedGroups[selected.group] === true;
            const allDrawn = selected.tubes.every((x) => drawn[x.specimenId]);
            return (
              <div className="space-y-3">
                <PatientCard
                  display={first.patientDisplay} uhid={first.uhid} encounterNo={first.encounterNo}
                  tokenNo={first.tokenNo} fasting={selected.tubes.some((x) => x.requiresFasting)}
                  codes={[...new Set(selected.tubes.flatMap((x) => x.orderableCodes))]}
                />
                <p className="text-sm">
                  {wristband
                    ? <span style={{ color: "var(--state-settled)" }}>{t("lab.collection.wristbandOk")}</span>
                    : <span className="font-semibold">{t("lab.collection.recheckWarning")}</span>}
                </p>

                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">{t("lab.collection.drawOrder")}</h2>
                  <Button type="button" variant="outline" size="sm" className="no-print" onClick={() => window.print()}>
                    {t("lab.collection.printAgain")}
                  </Button>
                </div>
                <ol className="space-y-2" data-testid="tubes">
                  {selected.tubes.map((tube, i) => (
                    <li key={tube.specimenId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded border border-border p-2 text-sm"
                      data-testid={`tube-${tube.specimenNo}`}>
                      <span className="text-2xl font-semibold tabular-nums">{i + 1}</span>
                      <span>
                        <span className="font-semibold">{capFor(tube.container)}</span>
                        <span className="text-muted-foreground"> · {tube.specimenType} · {tube.orderableCodes.join(", ")}</span>
                        <br />
                        <span className="font-mono">{tube.specimenNo}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {drawn[tube.specimenId] ? (
                          <span className="font-semibold" style={{ color: "var(--state-settled)" }}>✓ {t("lab.collection.scanned")}</span>
                        ) : (
                          <input
                            className="w-40 rounded border border-input px-2 py-1 font-mono"
                            placeholder={t("lab.collection.scanTube")}
                            aria-label={`${t("lab.collection.scanTube")} ${tube.specimenNo}`}
                            value={tubeScan[tube.specimenId] ?? ""}
                            onChange={(e) => scanTube(tube, e.target.value, wristband)}
                          />
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-muted-foreground">{t("lab.collection.drawOrderNote")}</p>

                <Button type="button" disabled={!allDrawn} onClick={() => { setSelectedKey(null); void qc.invalidateQueries({ queryKey: ["lab", "collection"] }); }}>
                  {t("lab.collection.drawnToLab", { count: selected.tubes.length })}
                </Button>

                {/* The paper: one label per tube, in order of draw. Only this reaches the printer. */}
                <div className="specimen-labels flex flex-wrap gap-2 border-t border-border pt-2" data-testid="labels">
                  {selected.tubes.map((tube) => (
                    <SpecimenLabel
                      key={tube.specimenId}
                      specimenNo={tube.specimenNo}
                      patientDisplay={tube.patientDisplay}
                      uhid={tube.uhid}
                      container={tube.container}
                      specimenType={tube.specimenType}
                      codes={tube.orderableCodes}
                      serviceDate={serviceDate}
                      tokenNo={tube.tokenNo}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

          {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}
        </section>
      </div>
    </LabSeatFrame>
  );
}

function PatientCard(props: {
  display: string; uhid: string; encounterNo: string; tokenNo: number | null; fasting: boolean; codes: string[];
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="rounded border border-border bg-card p-3 text-sm" data-testid="patient-card">
      <div className="flex flex-wrap items-baseline gap-x-3">
        {props.tokenNo !== null && <span className="font-mono text-lg font-semibold">T-{props.tokenNo}</span>}
        <span className="text-lg font-semibold">{props.display}</span>
        <span className="text-muted-foreground">{props.uhid}</span>
        <span className="text-muted-foreground">{props.encounterNo}</span>
      </div>
      <p className="text-muted-foreground">
        {props.codes.length > 0 ? props.codes.join(" · ") : t("lab.collection.codesHidden")}
        {props.fasting && <> · <span className="font-semibold text-foreground">{t("lab.collection.fasting")}</span></>}
      </p>
    </div>
  );
}
