import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchBench, fetchEscalation, fetchPreStage, getOpdConfig, listDepartments, setBenchState, todayIst } from "../lib/opd-api";
import type { WireBenchRow, WireDangerRanges, WireDoctorSummary, WirePreStage, WireVitalsSaveResult } from "../lib/opd-api";
import { CaptureCore, SavedBannerView, bandFor, flagOf, readLane, writeLane } from "./vitals-bay-capture";
import type { Lane, SavedBanner, Take, TileKey, Tiles } from "./vitals-bay-capture";
import {
  ProtocolPanel, REST_MINUTES, RestOffer, heldFirstTake, holdFirstTake, isElevated, readingFrom, releaseFirstTake, useDangerProtocol,
} from "./vitals-bay-protocol";
import { verifyQrScan } from "../lib/patients-api";
import { api } from "../lib/api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { useRealtime } from "../lib/realtime";

/**
 * VD-2 T1 — BAY ONE: identity and the bench. The signed-off design is
 * `docs/design/2026-08-31-vitals-desk/bay-one.html`; the contract is the seven demo stories of
 * `2026-08-31-EXECUTE-PROMPT-vitals-desk.md`, and this task is story 1.
 *
 * ═══ THREE DOORS, ONE INPUT, RESOLVED ON THE BENCH (phase doc D2) ═══
 *
 * A barcode scanner is a keyboard that types fast, so the scan lands in the same box a typed token
 * or UHID lands in. No route resolves a token number or a UHID to a visit (RC-4 F7(A): `visitsQuery`
 * carries neither) and none is needed: `GET /opd/bench` already returns `tokenNo` and the patient's
 * `uhid` for every row the bay can act on, so all three doors are a lookup in the list on screen.
 * A patient who is not on the bench is not the bay's to take — "check the slip, or send them to
 * the front desk" is the design's own line — and the scan door goes through `POST /patients/qr/verify`
 * first because a photographed or reissued card must fail there, not be trusted here.
 *
 * ═══ NOTHING BLEEDS BETWEEN PEOPLE (phase doc D8, RC-4 R21) ═══
 *
 * The patient in hand is the shared `usePatientInHand` session (the strip above reads it), and the
 * pre-stage read is keyed on the ENCOUNTER, so patient B's column can never render A's June
 * vitals. The desk generation remounts the identify box on clear, the one way to empty a child's
 * own input state without lifting it (RC-4 F16). The assertion book drives two patients through.
 *
 * ═══ INSIDE THE ALIAS LAYER (D9) ═══
 *
 * `data-seat="vitals-bay"` opts this root into the paper-and-pine tokens the registration seat
 * mapped onto the shadcn variables; nothing here uses a Radix portal, so nothing escapes the scope.
 */
export const BENCH_POLL_MS = 5_000;

export type Door =
  | { kind: "token"; tokenNo: number }
  | { kind: "uhid"; uhid: string }
  | { kind: "scan"; payload: string };

/** Digits are a token; a card payload starts `q1.` (`patients/qr.ts:15`); everything else is a UHID. */
export function classifyDoor(raw: string): Door | null {
  const s = raw.trim();
  if (s === "") return null;
  if (/^\d{1,6}$/.test(s)) return { kind: "token", tokenNo: Number(s) };
  if (s.startsWith("q1.")) return { kind: "scan", payload: s };
  return { kind: "uhid", uhid: s.toUpperCase() };
}

export function matchOnBench(
  rows: readonly WireBenchRow[],
  by: { kind: "token"; tokenNo: number } | { kind: "uhid"; uhid: string } | { kind: "patient"; patientId: string },
): WireBenchRow | null {
  for (const r of rows) {
    if (by.kind === "token" && r.tokenNo === by.tokenNo) return r;
    if (by.kind === "uhid" && r.patient !== null && r.patient.uhid.toUpperCase() === by.uhid) return r;
    if (by.kind === "patient" && r.patient !== null && r.patient.id === by.patientId) return r;
  }
  return null;
}

export function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function useBench(departmentId: string | undefined, serviceDate: string): { rows: WireBenchRow[]; failed: boolean } {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["vitals-bay", "bench", departmentId ?? "", serviceDate],
    queryFn: () => fetchBench({ departmentId, serviceDate }),
    refetchInterval: BENCH_POLL_MS,
  });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  // One subscription per doctor on the bench: `bench.state_set`, `queue.escalated`, the call and
  // the vitals save all route on `queue:<doctorId>:<date>`; the push is a hint, the poll is the truth.
  const topics = useMemo(() => [...new Set(rows.map((r) => r.doctorId))].sort().map((d) => `queue:${d}:${serviceDate}`), [rows, serviceDate]);
  useRealtime(topics, () => { void qc.invalidateQueries({ queryKey: ["vitals-bay", "bench"] }); });
  return { rows, failed: q.isError };
}

export function usePreStage(encounterId: string | null): { preStage: WirePreStage | null; failed: boolean; pending: boolean } {
  const q = useQuery({
    queryKey: ["vitals-bay", "prestage", encounterId ?? ""],
    queryFn: () => fetchPreStage(encounterId ?? ""),
    enabled: encounterId !== null,
  });
  return { preStage: encounterId === null ? null : (q.data ?? null), failed: q.isError, pending: encounterId !== null && q.isPending };
}

export function useQueueSummary(serviceDate: string): WireDoctorSummary[] {
  const q = useQuery({
    queryKey: ["vitals-bay", "summary", serviceDate],
    queryFn: () => api<{ items: WireDoctorSummary[] }>("GET", `/opd/queues/summary?serviceDate=${serviceDate}`),
    refetchInterval: BENCH_POLL_MS,
  });
  return q.data?.items ?? [];
}

function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function patientLabel(row: WireBenchRow, t: (k: string) => string): string {
  if (row.patient === null) return t("vitalsBay.bench.unknownPatient");
  if (row.patient.restricted) return row.patient.alias ?? t("vitalsBay.bench.restricted");
  return row.patient.name ?? row.patient.uhid;
}

/** The valve: bench depth against how many the doctors can still call. */
export function ValvePill({ benchCount, summaries }: { benchCount: number; summaries: WireDoctorSummary[] }): React.ReactElement {
  const { t } = useTranslation();
  const callable = summaries.reduce((n, s) => n + s.waitingVitalsCount, 0);
  return (
    <span data-testid="valve-pill" className="rounded-full border border-border px-3 py-1 text-sm">
      {t("vitalsBay.valve.bench", { count: benchCount })} · {t("vitalsBay.valve.callable", { count: callable })}
    </span>
  );
}

export function BenchRail({ rows, inHandEncounterId, onTake }: {
  rows: WireBenchRow[]; inHandEncounterId: string | null; onTake: (row: WireBenchRow) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const sorted = useMemo(() => [...rows].sort((a, b) => a.seq - b.seq), [rows]);
  return (
    <aside aria-label={t("vitalsBay.bench.title")} data-testid="bench" className="flex flex-col gap-1 text-sm">
      <h2 className="text-sm font-semibold">{t("vitalsBay.bench.title")}</h2>
      {sorted.length === 0 && <p className="text-muted-foreground" data-testid="bench-empty">{t("vitalsBay.bench.empty")}</p>}
      {sorted.map((row) => {
        const state = row.escalation === "escalated" ? "escalated"
          : row.escalation === "recheck_demanded" ? "recheck"
          : row.benchState === "resting" ? (row.recallDue ? "due" : "resting")
          : row.benchState === "away" ? "away"
          : row.vitalsDone ? "done" : "waiting";
        return (
          <button
            key={row.entryId} type="button" data-testid={`bench-row-${row.tokenNo}`} data-state={state}
            aria-pressed={row.encounterId === inHandEncounterId}
            onClick={() => onTake(row)}
            className={`flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-left ${row.encounterId === inHandEncounterId ? "bg-accent" : "bg-card"}`}
          >
            <span><span className="font-mono">#{row.tokenNo}</span> {patientLabel(row, t)} · {row.doctorName}</span>
            <span className={state === "due" || state === "escalated" ? "font-semibold" : "text-muted-foreground"}>
              {state === "resting" && row.recallAt !== null ? t("vitalsBay.bench.recallAt", { time: istClock(row.recallAt) }) : t(`vitalsBay.bench.state.${state}`)}
            </span>
          </button>
        );
      })}
    </aside>
  );
}

const LAST_KEYS = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm"] as const;

export function SessionColumn({ row, preStage, failed, pending, children }: {
  row: WireBenchRow | null; preStage: WirePreStage | null; failed: boolean; pending: boolean; children?: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  if (row === null) {
    return <section data-testid="session-empty" className="text-sm text-muted-foreground">{t("vitalsBay.session.empty")}</section>;
  }
  return (
    <section data-testid="session" data-encounter={row.encounterId} className="flex flex-col gap-2 text-sm">
      <h2 className="text-base font-semibold">
        <span className="font-mono">#{row.tokenNo}</span> {patientLabel(row, t)}
      </h2>
      <p className="text-muted-foreground">{row.doctorName}{row.patient !== null ? ` · ${row.patient.uhid}` : ""}</p>
      {pending && <p>{t("app.loading")}</p>}
      {failed && <p data-testid="prestage-failed" className="text-muted-foreground">{t("vitalsBay.session.noHistory")}</p>}
      {preStage !== null && (
        <div data-testid="prestage" className="flex flex-col gap-1">
          <p><span className="text-muted-foreground">{t("vitalsBay.session.band")}</span> {t(`vitalsBay.band.${preStage.band}`)}{preStage.ageYears !== null ? ` · ${t("vitalsBay.session.age", { years: preStage.ageYears })}` : ""}</p>
          <p><span className="text-muted-foreground">{t("vitalsBay.session.required")}</span> {preStage.required.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</p>
          {preStage.notRoutine.length > 0 && (
            <p><span className="text-muted-foreground">{t("vitalsBay.session.notRoutine")}</span> {preStage.notRoutine.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</p>
          )}
          {preStage.last === null ? (
            <p data-testid="prestage-none">{t("vitalsBay.session.firstVisit")}</p>
          ) : (
            <p data-testid="prestage-last">
              <span className="text-muted-foreground">{t("vitalsBay.session.last", { date: preStage.last.serviceDate })}</span>{" "}
              {LAST_KEYS.filter((k) => preStage.last![k] !== null).map((k) => `${t(`vitalsBay.vital.${k}`)} ${String(preStage.last![k])}`).join(" · ")}
            </p>
          )}
          {preStage.carryCandidates.length > 0 && (
            <p data-testid="prestage-carry">{t("vitalsBay.session.carry", { vitals: preStage.carryCandidates.map((k) => t(`vitalsBay.vital.${k}`)).join(", ") })}</p>
          )}
          {preStage.expectedFlags.length > 0 && (
            <p data-testid="prestage-flags">{t("vitalsBay.session.expectedFlags", { count: preStage.expectedFlags.length })}</p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** VD-2 D4 — the serial lane is a fact about THIS bay's device rack: per-device state, shipped OFF, no migration. */
export function LaneToggle({ lane, onChange }: { lane: Lane; onChange: (next: Lane) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <button
      type="button" role="switch" aria-checked={lane === "serial"} data-testid="lane-toggle" data-lane={lane}
      className="rounded-full border border-border px-3 py-1 text-sm"
      onClick={() => onChange(lane === "serial" ? "typing" : "serial")}
    >
      {t(lane === "serial" ? "vitalsBay.lane.serial" : "vitalsBay.lane.typing")}
    </button>
  );
}

export function IdentifyBox({ onSubmit, error, busy }: { onSubmit: (raw: string) => void; error: string | null; busy: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => { e.preventDefault(); onSubmit(raw); }}
    >
      <label className="text-sm font-medium" htmlFor="identify">{t("vitalsBay.identify.label")}</label>
      <input
        id="identify" data-testid="identify" autoFocus autoComplete="off" disabled={busy}
        className="rounded border border-input bg-card px-2 py-1 font-mono"
        placeholder={t("vitalsBay.identify.placeholder")} value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("vitalsBay.identify.hint")}</p>
      {error !== null && <p role="alert" data-testid="identify-error">{error}</p>}
    </form>
  );
}

export function VitalsBay(): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, takePatient, takeEncounter, release } = usePatientInHand();
  const today = todayIst();
  const [departmentId, setDepartmentId] = useState<string | undefined>(undefined);
  const departments = useQuery({ queryKey: ["vitals-bay", "departments"], queryFn: listDepartments });
  const { rows, failed: benchFailed } = useBench(departmentId, today);
  const summaries = useQueueSummary(today);
  const [taken, setTaken] = useState<WireBenchRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deskGen, setDeskGen] = useState(0);
  const [lane, setLane] = useState<Lane>(readLane);
  const [banner, setBanner] = useState<SavedBanner | null>(null);
  const [keys, setKeys] = useState({ typed: 0, device: 0 });
  const config = useQuery({ queryKey: ["opd", "config"], queryFn: getOpdConfig });
  const ranges = (config.data?.dangerRanges as WireDangerRanges | undefined) ?? null;
  const qc = useQueryClient();
  const busyRef = useRef(false);
  busyRef.current = busy;

  // The row in hand is answered, not remembered: it is shown only while the shared session agrees.
  const encounterId = inHand?.encounterId ?? null;
  const rowInHand = taken !== null && taken.encounterId === encounterId
    ? (rows.find((r) => r.encounterId === taken.encounterId) ?? taken)
    : null;
  const { preStage, failed: preFailed, pending } = usePreStage(rowInHand?.encounterId ?? null);

  // VD-2 T3 — the protocol's state is the SERVER's; a re-identified patient shows where it stands.
  const escalationQ = useQuery({
    queryKey: ["vitals-bay", "escalation", rowInHand?.encounterId ?? ""],
    queryFn: () => fetchEscalation(rowInHand?.encounterId ?? ""),
    enabled: rowInHand !== null,
  });
  const protocol = useDangerProtocol(rowInHand?.encounterId ?? null, escalationQ.data?.escalation ?? null);
  const [restOffer, setRestOffer] = useState<[number, number] | null>(null);
  const [restBusy, setRestBusy] = useState(false);
  const band = bandFor(ranges, preStage?.band ?? null);
  const held = useMemo(() => (rowInHand === null ? null : heldFirstTake(rowInHand.encounterId)), [rowInHand]);
  const initialTakes = useMemo<Partial<Record<TileKey, Take[]>> | undefined>(() => (held === null ? undefined : { bp: [held] }), [held]);

  const take = useCallback((row: WireBenchRow) => {
    if (row.patient === null) { setError(t("vitalsBay.identify.unknownPatient")); return; }
    setError(null);
    setTaken(row);
    takePatient(row.patient.id);
    takeEncounter(row.encounterId);
  }, [t, takePatient, takeEncounter]);

  const clearDesk = useCallback(() => {
    setTaken(null);
    setError(null);
    release();
    setDeskGen((g) => g + 1);
  }, [release]);

  const onKeys = useCallback((typed: number, device: number) => setKeys({ typed, device }), []);

  /**
   * VD-2 T3 — EVERY COMMITTED TAKE IS OFFERED TO THE PROTOCOL. A danger take with no protocol
   * running demands the other arm; a danger take while the other arm was demanded confirms; an
   * elevated-not-dangerous first BP with no history of the protocol offers the rest chairs. Rest is
   * refused at danger numbers by construction: the offer only appears when nothing is dangerous.
   */
  const onCommitted = useCallback((key: TileKey, take: Take, tiles: Tiles) => {
    const tint = flagOf(key, take, band, ranges);
    const state = protocol.view?.state ?? "none";
    if (tint === "danger" || tint === "sam") {
      setRestOffer(null);
      const reading = readingFrom(tiles);
      if (state === "none" || state === "cancelled") void protocol.demand(reading).catch(() => undefined);
      else if (state === "recheck_demanded") void protocol.confirm(reading);
      return;
    }
    if (key === "bp" && state === "none" && tiles.bp.takes.length === 1 && Array.isArray(take) && isElevated(take, band, preStage?.last ?? null)) {
      setRestOffer(take);
    }
  }, [band, ranges, protocol, preStage]);

  const recallClock = (minutes: number): string => istClock(new Date(Date.now() + minutes * 60_000).toISOString());

  const goRest = useCallback(async () => {
    if (rowInHand === null || restOffer === null) return;
    setRestBusy(true);
    try {
      const updated = await setBenchState(rowInHand.encounterId, { state: "resting", restMinutes: REST_MINUTES, note: `first reading ${restOffer[0]}/${restOffer[1]}` });
      holdFirstTake(rowInHand.encounterId, restOffer);
      const who = rowInHand.patient === null ? "" : rowInHand.patient.restricted ? (rowInHand.patient.alias ?? "") : (rowInHand.patient.name ?? rowInHand.patient.uhid);
      setBanner({ who, doctorName: rowInHand.doctorName, flags: [], amended: false, rest: updated.recallAt === null ? recallClock(REST_MINUTES) : istClock(updated.recallAt) });
      setRestOffer(null);
      void qc.invalidateQueries({ queryKey: ["vitals-bay", "bench"] });
      clearDesk();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestBusy(false);
    }
  }, [rowInHand, restOffer, qc, clearDesk]);

  /**
   * THE BOLD ✓ (owner ruling 6): names who was saved and which doctor's board they landed on, then
   * the desk is cleared — the next person starts from nothing. The bench re-reads so the row wears
   * the same tick; the push is a hint and the refetch is the truth.
   */
  const onSaved = useCallback((result: WireVitalsSaveResult, row: WireBenchRow) => {
    const who = row.patient === null ? t("vitalsBay.bench.unknownPatient")
      : row.patient.restricted ? (row.patient.alias ?? t("vitalsBay.bench.restricted")) : (row.patient.name ?? row.patient.uhid);
    setBanner({ who, doctorName: row.doctorName, flags: result.flags, amended: false });
    releaseFirstTake(row.encounterId);
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "bench"] });
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "summary"] });
    clearDesk();
  }, [qc, clearDesk, t]);

  const identify = useCallback(async (raw: string) => {
    const door = classifyDoor(raw);
    if (door === null) return;
    setError(null);
    if (door.kind === "scan") {
      setBusy(true);
      try {
        const verdict = await verifyQrScan(door.payload);
        if (!verdict.ok) { setError(t(`vitalsBay.identify.scanFailed.${verdict.reason}`)); return; }
        const row = matchOnBench(rows, { kind: "patient", patientId: verdict.patient.id });
        if (row === null) { setError(t("vitalsBay.identify.notOnBench", { who: verdict.patient.uhid })); return; }
        take(row);
      } catch {
        setError(t("vitalsBay.identify.scanUnavailable"));
      } finally {
        setBusy(false);
      }
      return;
    }
    const row = matchOnBench(rows, door);
    if (row === null) { setError(t("vitalsBay.identify.notOnBench", { who: raw.trim() })); return; }
    take(row);
  }, [rows, t, take]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || busyRef.current) return;
      if (isTypingTarget(e.target) && (e.target as HTMLInputElement).value !== "") return; // Escape in a filled box clears the box, the browser's job
      e.preventDefault();
      clearDesk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearDesk]);

  return (
    <div data-seat="vitals-bay" data-testid="vitals-bay" className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">{t("vitalsBay.title")}</h1>
        <div className="flex items-center gap-3">
          <select
            aria-label={t("vitalsBay.department")} data-testid="department" className="rounded border border-input bg-card px-2 py-1 text-sm"
            value={departmentId ?? ""} onChange={(e) => setDepartmentId(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">{t("vitalsBay.allDepartments")}</option>
            {(departments.data?.items ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <ValvePill benchCount={rows.length} summaries={summaries} />
          <LaneToggle lane={lane} onChange={(next) => { writeLane(next); setLane(next); }} />
          <button type="button" data-testid="clear-desk" onClick={clearDesk} className="rounded border border-border px-2 py-1 text-sm">
            {t("vitalsBay.clearDesk")} <kbd className="text-xs text-muted-foreground">Esc</kbd>
          </button>
        </div>
      </header>
      {benchFailed && <p role="alert" data-testid="bench-failed" className="border-b border-border px-6 py-2 text-sm">{t("vitalsBay.bench.failed")}</p>}
      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        <div className="w-full shrink-0 rounded-lg border border-border bg-card p-4 lg:w-80">
          <BenchRail rows={rows} inHandEncounterId={rowInHand?.encounterId ?? null} onTake={take} />
        </div>
        <main className="flex flex-1 flex-col gap-4">
          <IdentifyBox key={deskGen} onSubmit={(raw) => { void identify(raw); }} error={error} busy={busy} />
          {banner !== null && <SavedBannerView banner={banner} onDismiss={() => setBanner(null)} />}
          <div className="rounded-lg border border-border bg-card p-4">
            <SessionColumn row={rowInHand} preStage={preStage} failed={preFailed} pending={pending}>
              {rowInHand !== null && !pending && (
                <CaptureCore
                  key={`${deskGen}:${rowInHand.encounterId}`} resetKey={`${deskGen}:${rowInHand.encounterId}`}
                  row={rowInHand} preStage={preStage} ranges={ranges} lane={lane}
                  onSaved={(result) => onSaved(result, rowInHand)} onKeys={onKeys}
                  onCommitted={onCommitted} initialTakes={initialTakes}
                  protocol={
                    <>
                      {held !== null && <p data-testid="held-first-take" className="text-xs text-muted-foreground">{t("vitalsBay.rest.heldFirst", { value: `${held[0]}/${held[1]}` })}</p>}
                      <ProtocolPanel p={protocol} doctorName={rowInHand.doctorName} />
                      {restOffer !== null && (protocol.view?.state ?? "none") === "none" && (
                        <RestOffer recallAt={recallClock(REST_MINUTES)} onRest={() => { void goRest(); }} busy={restBusy} />
                      )}
                    </>
                  }
                />
              )}
            </SessionColumn>
          </div>
        </main>
      </div>
      <footer className="border-t border-border px-6 py-2 text-xs text-muted-foreground" data-testid="bay-footer">
        {t("vitalsBay.capture.keys", { typed: keys.typed, device: keys.device })} · {t(lane === "serial" ? "vitalsBay.lane.serialHint" : "vitalsBay.lane.typingHint")}
      </footer>
    </div>
  );
}
