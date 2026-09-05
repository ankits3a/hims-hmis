import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchBench, fetchEscalation, fetchPreStage, setBenchState, todayIst } from "../lib/opd-api";
import type { WireBenchRow, WireDoctorSummary, WirePreStage, WireVitalsSaveResult } from "../lib/opd-api";
import { CaptureCore, SavedBannerView, bandFor, flagOf, humanDate, istClock, rangesFrom, readLane, writeLane } from "./vitals-bay-capture";
import type { Lane, SavedBanner, Take, TileKey, Tiles } from "./vitals-bay-capture";
import {
  ProtocolPanel, REST_MINUTES, RestOffer, heldFirstTake, holdFirstTake, isElevated, readingFrom, releaseFirstTake, useDangerProtocol,
} from "./vitals-bay-protocol";
import { AmendPanel, AmendTrail } from "./vitals-bay-amend";
import type { Amended } from "./vitals-bay-amend";
import { verifyQrScan } from "../lib/patients-api";
import { api } from "../lib/api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { useAuth } from "../lib/auth";
import { useRealtime } from "../lib/realtime";
import { PaperScreen } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";

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
/** The tiles the other-arm protocol judges; MUAC zones and the measurements are not readings of a moment. */
const RANGED: readonly TileKey[] = ["bp", "pulse", "spo2", "tempC", "rr"];

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

export function useBench(doctorId: string | undefined, serviceDate: string): { rows: WireBenchRow[]; failed: boolean } {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["vitals-bay", "bench", doctorId ?? "", serviceDate],
    queryFn: () => fetchBench({ doctorId, serviceDate }),
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
    <span data-testid="valve-pill" className="pill gd" title={t("vitalsBay.valve.why")}>
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
    <aside
      aria-label={t("vitalsBay.bench.title")}
      data-testid="bench"
      style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}
    >
      <span className="tag">{t("vitalsBay.bench.title")}</span>
      {sorted.length === 0 && (
        <p data-testid="bench-empty" style={{ margin: "7px 0 0", color: "var(--faint)", fontSize: 11.5 }}>
          {t("vitalsBay.bench.empty")}
        </p>
      )}
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
            /*
              THE ROW'S STATE IS CARRIED IN A BORDER AND A WORD, never in colour alone: `due` and
              `escalated` are the two a nurse must not miss across a room, and a bench read at a
              glance from two metres is the whole reason this rail exists ("timers die in drawers").
            */
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              padding: "8px 10px", borderRadius: 6, textAlign: "left", width: "100%",
              border: `1px solid ${state === "escalated" ? "var(--red)" : state === "due" ? "var(--gold)" : "var(--line)"}`,
              background: row.encounterId === inHandEncounterId ? "var(--wash)" : "var(--card)",
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span className="mo" style={{ fontWeight: 600 }}>#{row.tokenNo}</span> {patientLabel(row, t)}
              <span style={{ color: "var(--faint)" }}> · {row.doctorName}</span>
            </span>
            <span
              className="mo"
              style={{
                flexShrink: 0, fontSize: 10.5,
                fontWeight: state === "due" || state === "escalated" ? 700 : 400,
                color: state === "escalated" ? "var(--red)" : state === "due" ? "var(--gold)" : "var(--dim)",
              }}
            >
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
    return (
      <section data-testid="session-empty" style={{ fontSize: 12.5, color: "var(--dim)" }}>
        <span className="tag">{t("vitalsBay.session.title")}</span>
        <p style={{ margin: "9px 0 0", color: "var(--faint)" }}>{t("vitalsBay.session.empty")}</p>
        {/*
          THE DIGNITY LINE, from the signed-off artboard and kept verbatim in intent: the bay screen
          faces the NURSE. A patient display shows a token and a direction and never a weight — the
          artboard's own tile carries "🔇 never said aloud" on weight for the same reason. It sits in
          the empty state because that is when somebody new to the bay reads the screen.
        */}
        <p style={{ margin: "13px 0 0", fontSize: 11, color: "var(--faint)", lineHeight: "15px" }}>
          {t("vitalsBay.session.dignity")}
        </p>
      </section>
    );
  }
  return (
    <section data-testid="session" data-encounter={row.encounterId} style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 12.5 }}>
      <span className="tag">{t("vitalsBay.session.title")}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="mo" style={{ fontSize: 21, fontWeight: 700, lineHeight: "24px" }}>#{row.tokenNo}</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{patientLabel(row, t)}</span>
        <span style={{ color: "var(--dim)", fontSize: 11.5 }}>
          {row.doctorName}{row.patient !== null && !row.patient.restricted ? ` · ${row.patient.uhid}` : ""}
        </span>
      </div>
      {pending && <p style={{ margin: 0, color: "var(--faint)" }}>{t("app.loading")}</p>}
      {failed && <p data-testid="prestage-failed" style={{ margin: 0, color: "var(--dim)" }}>{t("vitalsBay.session.noHistory")}</p>}
      {preStage !== null && (
        <div data-testid="prestage" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {/*
            THE BAND IS A PILL AND NOT A SENTENCE, because it decides what the screen will REFUSE to
            save without — "CHILD 1–5 · small cuff · MUAC due" is an instruction about the next sixty
            seconds, and the required list under it is the same fact spelled out.
          */}
          <span className="pill on" data-testid="band-pill">
            {t(`vitalsBay.band.${preStage.band}`)}{preStage.ageYears !== null ? ` · ${t("vitalsBay.session.age", { years: preStage.ageYears })}` : ""}
          </span>
          <p style={{ margin: 0 }}><span style={{ color: "var(--dim)" }}>{t("vitalsBay.session.required")}</span> {preStage.required.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</p>
          {preStage.notRoutine.length > 0 && (
            <p style={{ margin: 0 }}><span style={{ color: "var(--dim)" }}>{t("vitalsBay.session.notRoutine")}</span> {preStage.notRoutine.map((k) => t(`vitalsBay.vital.${k}`)).join(", ")}</p>
          )}
          {preStage.last === null ? (
            <p data-testid="prestage-none">{t("vitalsBay.session.firstVisit")}</p>
          ) : (
            <p data-testid="prestage-last">
              <span className="text-muted-foreground">{t("vitalsBay.session.last", { date: humanDate(preStage.last.serviceDate) })}</span>{" "}
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
      className={lane === "serial" ? "pill on" : "pill"}
      onClick={() => onChange(lane === "serial" ? "typing" : "serial")}
    >
      {t(lane === "serial" ? "vitalsBay.lane.serial" : "vitalsBay.lane.typing")}
    </button>
  );
}

export function IdentifyBox({ onSubmit, error, busy, compact = false }: {
  onSubmit: (raw: string) => void; error: string | null; busy: boolean;
  /**
   * SOMEBODY IS ALREADY ON THE STOOL. The door stays open — a nurse must be able to correct a
   * mis-scan, or answer "wrong patient" without hunting for a control — but it stops SHOUTING.
   *
   * At full size beside a filled session column the screen said, in its largest type, "Who is in
   * front of you?" three inches from a card naming exactly who was in front of you. That is the
   * screen arguing with itself, and it is the class of defect this lane keeps finding by looking
   * rather than by testing: every assertion about this box passed in both states.
   */
  compact?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const [raw, setRaw] = useState("");
  return (
    <form
      style={{ display: "flex", flexDirection: compact ? "row" : "column", alignItems: compact ? "center" : "stretch", gap: compact ? 10 : 7, flexWrap: "wrap" }}
      onSubmit={(e) => { e.preventDefault(); onSubmit(raw); }}
    >
      <label style={compact ? { fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dim)", whiteSpace: "nowrap" } : { fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }} htmlFor="identify">
        {t(compact ? "vitalsBay.identify.next" : "vitalsBay.identify.label")}
      </label>
      {/*
        ONE LANE, THREE DOORS — the owner's ruling. A scanned token, a typed token number and a UHID
        all start the SAME session, so they share one box rather than three: a nurse holding a
        feverish child should not have to decide which control to use before they can start.
      */}
      <input
        id="identify" data-testid="identify" autoFocus={!compact} autoComplete="off" disabled={busy}
        className="in mo"
        style={compact ? { flexGrow: 1, minWidth: 200, height: 32, fontSize: 13 } : { height: 46, fontSize: 15 }}
        placeholder={t("vitalsBay.identify.placeholder")} value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      {!compact && <p style={{ margin: 0, fontSize: 11.5, color: "var(--faint)" }}>{t("vitalsBay.identify.hint")}</p>}
      {error !== null && (
        <p role="alert" data-testid="identify-error" className="pill rd" style={{ height: "auto", padding: "8px 11px" }}>
          {error}
        </p>
      )}
    </form>
  );
}

export function VitalsBay(): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, takePatient, takeEncounter, release } = usePatientInHand();
  const today = todayIst();
  // CLOSE pass 1 — the filter is by DOCTOR, from the bench itself: `GET /opd/departments` is
  // `opd.masters.read`, which the desk does not hold, and the doctors on the bench are the doctors.
  const [doctorId, setDoctorId] = useState<string | undefined>(undefined);
  const { rows: allRows } = useBench(undefined, today);
  const { rows, failed: benchFailed } = useBench(doctorId, today);
  const doctors = useMemo(() => [...new Map(allRows.map((r) => [r.doctorId, r.doctorName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [allRows]);
  const summaries = useQueueSummary(today);
  const [taken, setTaken] = useState<WireBenchRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deskGen, setDeskGen] = useState(0);
  const [lane, setLane] = useState<Lane>(readLane);
  const [banner, setBanner] = useState<SavedBanner | null>(null);
  const [trail, setTrail] = useState<Amended | null>(null);
  const { actor } = useAuth();
  const [keys, setKeys] = useState({ typed: 0, device: 0 });
  const [log, setLog] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const note = useCallback((text: string, kind: AgentLine["kind"] = "did"): void => {
    setLog((prev) => logged(prev, text, kind));
  }, []);
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const inHandRef = useRef(inHand);
  inHandRef.current = inHand;
  const busyRef = useRef(false);
  busyRef.current = busy;

  // The row in hand is answered, not remembered: it is shown only while the shared session agrees.
  const encounterId = inHand?.encounterId ?? null;
  const rowInHand = taken !== null && taken.encounterId === encounterId
    ? (rows.find((r) => r.encounterId === taken.encounterId) ?? taken)
    : null;
  const { preStage, failed: preFailed, pending } = usePreStage(rowInHand?.encounterId ?? null);
  const ranges = useMemo(() => rangesFrom(preStage), [preStage]);

  // VD-2 T3 — the protocol's state is the SERVER's; a re-identified patient shows where it stands.
  const escalationQ = useQuery({
    queryKey: ["vitals-bay", "escalation", rowInHand?.encounterId ?? ""],
    queryFn: () => fetchEscalation(rowInHand?.encounterId ?? ""),
    enabled: rowInHand !== null,
  });
  const protocol = useDangerProtocol(rowInHand?.encounterId ?? null, escalationQ.data?.escalation ?? null);
  const [restOffer, setRestOffer] = useState<[number, number] | null>(null);
  const [restBusy, setRestBusy] = useState(false);
  const [rerun, setRerun] = useState<{ reading: ReturnType<typeof readingFrom>; key: TileKey } | null>(null);
  const band = bandFor(ranges, preStage?.band ?? null);
  const held = useMemo(() => (rowInHand === null ? null : heldFirstTake(rowInHand.encounterId)), [rowInHand]);
  const initialTakes = useMemo<Partial<Record<TileKey, Take[]>> | undefined>(() => (held === null ? undefined : { bp: [held] }), [held]);

  const take = useCallback((row: WireBenchRow) => {
    if (row.patient === null) { setError(t("vitalsBay.identify.unknownPatient")); return; }
    if (saving) { setError(t("vitalsBay.identify.saving")); return; }
    setError(null);
    setRestOffer(null); setRerun(null);
    setTaken(row);
    takePatient(row.patient.id);
    takeEncounter(row.encounterId);
  }, [t, takePatient, takeEncounter, saving]);

  /**
   * CLOSE pass 1 CRITICAL — EVERYTHING THE LAST PATIENT LEFT IS CLEARED HERE. `restOffer` survived
   * this function: patient A's elevated first BP was offered as patient B's rest and then held under
   * B's encounter. The offer, the re-run prompt and the row go together; the tiles go with the
   * remount the generation forces.
   */
  const clearDesk = useCallback(() => {
    setTaken(null);
    setError(null);
    setRestOffer(null);
    setRerun(null);
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
    const reading = readingFrom(tiles);
    // While the other arm is demanded, the DEMANDED tile's next take is the other arm (calm
    // withdraws, danger escalates) and a danger on another vital is a new first reading the server
    // re-demands. A calm take on an undemanded tile is just a take (pass 2 / F1: routing every
    // ranged take here answered "that is the first reading again" under a thermometer).
    if (state === "recheck_demanded" && RANGED.includes(key) && (key === protocol.demandedKey || tint === "danger")) {
      setRestOffer(null);
      if (!protocol.busy) void protocol.confirm(reading);
      return;
    }
    if (state === "recheck_demanded") return;
    // A SAM MUAC is its own emergency lane (the design's words): charted, flagged hard, and the SAVE
    // moves the board through the server's danger path. "The other arm, now" is a cuff instruction.
    if (tint === "danger") {
      setRestOffer(null);
      // After a named human's cancel the protocol is not re-run by the agent: the nurse is asked.
      if (state === "cancelled") { setRerun({ reading, key }); return; }
      if (state === "none" && !protocol.busy) void protocol.demand(reading, key).catch(() => undefined);
      return;
    }
    if (key === "bp" && state === "none" && !protocol.calmed && tiles.bp.takes.length === 1 && Array.isArray(take) && isElevated(take, band, preStage?.last ?? null)) {
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
  /**
   * VD-2 T4 — the amended save: the diff is the trail (old value, actor, clock), the board is
   * refreshed by `vitals.amended` on the doctor's topic, and the desk clears like any save.
   */
  const onAmended = useCallback((a: Amended, row: WireBenchRow) => {
    const who = row.patient === null ? t("vitalsBay.bench.unknownPatient")
      : row.patient.restricted ? (row.patient.alias ?? t("vitalsBay.bench.restricted")) : (row.patient.name ?? row.patient.uhid);
    setBanner({ who, doctorName: row.doctorName, flags: a.result.flags, amended: true });
    setTrail(a);
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "bench"] });
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "chart"] });
    note(t("vitalsBay.log.amended", { token: row.tokenNo }), "warn");
    clearDesk();
  }, [qc, clearDesk, t, note]);

  const onSaved = useCallback((result: WireVitalsSaveResult, row: WireBenchRow) => {
    const who = row.patient === null ? t("vitalsBay.bench.unknownPatient")
      : row.patient.restricted ? (row.patient.alias ?? t("vitalsBay.bench.restricted")) : (row.patient.name ?? row.patient.uhid);
    setBanner({ who, doctorName: row.doctorName, flags: result.flags, amended: false });
    setTrail(null);
    releaseFirstTake(row.encounterId);
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "bench"] });
    void qc.invalidateQueries({ queryKey: ["vitals-bay", "summary"] });
    note(t("vitalsBay.log.saved", { token: row.tokenNo, doctor: row.doctorName }), "ok");
    // CLOSE pass 1 — a save that lands after the desk moved on clears NOTHING of the next patient
    // (pass 2 / F8: read through a ref, the click-time closure could never disagree with its row).
    if (inHandRef.current?.encounterId === row.encounterId) clearDesk();
  }, [qc, clearDesk, t, note]);

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
      if (e.key !== "Escape" || busyRef.current || saving) return;
      if (isTypingTarget(e.target) && (e.target as HTMLInputElement).value !== "") return; // Escape in a filled box clears the box, the browser's job
      e.preventDefault();
      clearDesk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearDesk, saving]);

  /*
    ═══ THE BAY'S CO-PILOT — the screen has never had one, and it is the one the artboard argues for ═══

    "every unlock, override and auto-bump lands here, timestamped". The log is the valuable half: a
    danger escalation, a rest offer and an amendment are all things that happened to a PATIENT while
    a nurse was looking at a different tile, and a bay with no record of them is a bay where the
    question "why is he class 0?" has to be answered from memory.

    No model behind it, like every other dock in this application: it answers from the bench, the
    band and the pre-stage that are already on screen, and each answer names where it came from.
  */
  const ask = useCallback((question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    if (q.includes("bump") || q.includes("class") || q.includes("danger") || q.includes("escal")) {
      const view = protocol.view;
      setAnswer(view === null || view.state === "none"
        ? t("vitalsBay.agent.noEscalation")
        : t("vitalsBay.agent.escalation", { state: view.state }));
    } else if (q.includes("muac") || q.includes("band") || q.includes("required") || q.includes("owe")) {
      setAnswer(preStage === null
        ? t("vitalsBay.agent.noPatient")
        : t("vitalsBay.agent.required", {
          band: t(`vitalsBay.band.${preStage.band}`),
          vitals: preStage.required.map((k) => t(`vitalsBay.vital.${k}`)).join(", "),
        }));
    } else if (q.includes("bench") || q.includes("wait") || q.includes("next")) {
      setAnswer(t("vitalsBay.agent.bench", { count: rows.length }));
    } else {
      setAnswer(t("vitalsBay.agent.scope"));
    }
  }, [protocol.view, preStage, rows.length, t]);

  /*
    ONE VIEWPORT, AND THE DOCK IS INSIDE IT. `height` rather than `minHeight` because a bay monitor
    is a known size and this screen has a foot: the agent dock. Left to grow, the page ran 159px
    past the fold on a 1440×980 screen and the dock went under it — the "footer agent bar" ruling
    undone by nothing more than content. Each COLUMN scrolls internally; the frame does not.
  */
  return (
    <PaperScreen testId="vitals-bay" style={{ height: "var(--pp-h)", overflow: "hidden" }}>
      <div style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/*
          ═══ THE HEADER CARRIES THE THREE FIGURES A BAY IS JUDGED ON ═══

          The keys pill was exiled to a footer, where nobody looked. It is the ZERO-TYPING PROOF —
          the number that says whether the serial lane is earning its ₹54,850 — and the valve pill is
          the doctors' wait time. Both belong where the eye lands, beside the controls that change
          them, not under the fold.
        */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 11, padding: "11px 22px", background: "var(--card)", borderBottom: "1px solid var(--line)" }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
          <span className="mo" style={{ fontSize: 12.5, letterSpacing: ".08em", fontWeight: 600 }}>{t("vitalsBay.title")}</span>
          <select
            aria-label={t("vitalsBay.doctor")} data-testid="doctor" className="in"
            style={{ height: 30, width: "auto", fontSize: 12 }}
            value={doctorId ?? ""} onChange={(e) => setDoctorId(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">{t("vitalsBay.allDoctors")}</option>
            {doctors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <span className="mo" data-testid="keys-pill" title={t("vitalsBay.keys.why")} style={{ fontSize: 11, color: "var(--dim)" }}>
            {t("vitalsBay.capture.keys", { typed: keys.typed, device: keys.device })}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <ValvePill benchCount={rows.length} summaries={summaries} />
            <LaneToggle lane={lane} onChange={(next) => { writeLane(next); setLane(next); }} />
            <button type="button" data-testid="clear-desk" onClick={clearDesk} className="sec" style={{ height: 30, gap: 7 }}>
              {t("vitalsBay.clearDesk")} <span className="kb">Esc</span>
            </button>
          </span>
        </div>
        {benchFailed && (
          <p role="alert" data-testid="bench-failed" className="pill rd" style={{ height: "auto", margin: "11px 22px 0", padding: "9px 12px" }}>
            {t("vitalsBay.bench.failed")}
          </p>
        )}

        {/*
          ═══ SESSION | STAGE | BENCH — the artboard's triptych, and the order is the argument ═══

          The bench was on the LEFT and the patient in the middle, which reads as "the queue is the
          subject". It is not: the person on the stool is. Session left (who), stage centre (what you
          are doing), bench right (who is next) — and the bench stays visible because "timers die in
          drawers": a resting patient recalled at 09:57 is invisible the moment the rail is a tab.
        */}
        {/*
          NO WRAP, AND THAT IS THE FIX A SCREENSHOT FORCED. With `flexWrap: wrap` and a GROWING
          middle column, the stage expanded to fill the row and pushed the bench onto the next line —
          so the rail whose whole justification is "timers die in drawers" ended up below the fold,
          which is a drawer with extra steps.

          The middle takes `minWidth: 0` so it SHRINKS instead of pushing, and the row scrolls
          horizontally below Desk One's 1220px floor rather than reflowing: a bay monitor is a known
          size, and three columns that become one stacked column are a different screen.
        */}
        <div style={{ flexGrow: 1, minHeight: 0, display: "flex", gap: 16, padding: "18px 22px", alignItems: "stretch", flexWrap: "nowrap", minWidth: 0, overflowX: "auto" }}>
          <aside className="box" style={{ width: 294, flexShrink: 0, padding: 14, overflowY: "auto" }}>
            <SessionColumn row={rowInHand} preStage={preStage} failed={preFailed} pending={pending} />
          </aside>

          <main style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            <div className="box" style={{ padding: "15px 16px" }}>
              <IdentifyBox key={deskGen} onSubmit={(raw) => { void identify(raw); }} error={error} busy={busy} compact={rowInHand !== null} />
            </div>
            {banner !== null && <SavedBannerView banner={banner} onDismiss={() => { setBanner(null); setTrail(null); }} />}
            {banner !== null && trail !== null && <AmendTrail amended={trail} by={actor?.id ?? ""} />}
            <div className="box" style={{ padding: "15px 16px" }}>
              {/*
                THE STAGE HOSTS THE WORK, NOT THE IDENTITY. An earlier pass wrapped this in a second
                `SessionColumn`, which drew the token and the name again a few centimetres from the
                left rail that already had them — the artboard splits who / what-you-are-doing /
                who-is-next precisely so one fact lives in one column.
              */}
              <div data-testid="stage">
              {rowInHand !== null && rowInHand.vitalsDone && (
                <AmendPanel key={`${deskGen}:${rowInHand.encounterId}`} row={rowInHand} onAmended={(a) => onAmended(a, rowInHand)} />
              )}
              {rowInHand !== null && !rowInHand.vitalsDone && !pending && (
                <CaptureCore
                  key={`${deskGen}:${rowInHand.encounterId}`} resetKey={`${deskGen}:${rowInHand.encounterId}`}
                  row={rowInHand} preStage={preStage} ranges={ranges} lane={lane}
                  onSaved={(result) => onSaved(result, rowInHand)} onKeys={onKeys} onBusy={setSaving}
                  onCommitted={onCommitted} initialTakes={initialTakes}
                  protocol={
                    <>
                      {preStage?.sealed === true && <p data-testid="sealed-line" style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("vitalsBay.session.sealed")}</p>}
                      {held !== null && <p data-testid="held-first-take" style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("vitalsBay.rest.heldFirst", { value: `${held[0]}/${held[1]}` })}</p>}
                      <ProtocolPanel
                        p={protocol} doctorName={rowInHand.doctorName}
                        rerun={rerun === null ? null : { onRerun: () => { const r = rerun; setRerun(null); void protocol.demand(r.reading, r.key).catch(() => undefined); } }}
                      />
                      {restOffer !== null && (protocol.view?.state ?? "none") === "none" && (
                        <RestOffer recallAt={recallClock(REST_MINUTES)} onRest={() => { void goRest(); }} busy={restBusy} />
                      )}
                    </>
                  }
                />
              )}
              </div>
            </div>
            {/*
              THE LANE HINT STAYS, and it moved OUT of the footer with the keys pill. It says which
              of the two ways to work this bay is currently in — `[Space] fires the next device` or
              `[1–8] jump to a field` — which is a fact about the next keystroke, not a status line.
            */}
            <p data-testid="bay-footer" style={{ margin: 0, fontSize: 11, color: "var(--faint)" }}>
              {t(lane === "serial" ? "vitalsBay.lane.serialHint" : "vitalsBay.lane.typingHint")}
            </p>
          </main>

          <aside className="box" style={{ width: 238, flexShrink: 0, padding: 14, overflowY: "auto" }}>
            <BenchRail rows={rows} inHandEncounterId={rowInHand?.encounterId ?? null} onTake={take} />
            <p style={{ margin: "11px 0 0", paddingTop: 9, borderTop: "1px solid var(--line2)", fontSize: 10.5, color: "var(--faint)", lineHeight: "14px" }}>
              {t("vitalsBay.bench.valveNote")}
            </p>
          </aside>
        </div>
      </div>

      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("vitalsBay.agent.placeholder")}
        idle={t("vitalsBay.agent.idle")}
      />
    </PaperScreen>
  );
}
