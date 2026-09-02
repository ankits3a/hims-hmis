import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelEscalation, demandRecheck, escalateVisit, opdErrorMessage } from "../lib/opd-api";
import type { WireBandConfig, WireEscalationReading, WireEscalationView, WirePreStage } from "../lib/opd-api";
import { operative } from "./vitals-bay-capture";
import type { Take, TileKey, Tiles } from "./vitals-bay-capture";

/**
 * VD-2 T3 — THE DANGER PROTOCOL AND THE REST (stories 3 and 4).
 *
 * ═══ THE SERVER JUDGES; THE BAY ASKS (VD-1 D4, D8) ═══
 *
 * One danger reading → `POST …/escalation/recheck` with the numbers: the server says whether it is
 * warranted and moves NOTHING on the board. The other arm, also danger → `POST …/escalation/escalate`:
 * class 0, the doctor's board flashes, and ten seconds open in which `cancel` is a keystroke.
 * The countdown painted here is COSMETIC — it starts from the `cancelMsRemaining` the server
 * answered and the server refuses a late cancel with `escalation_window_closed` whatever this
 * screen still shows (D8). The tick updates ONE text node, never the tiles (ruling 1).
 *
 * ═══ REST IS A BENCH STATE, NOT A MEMORY (VD-1 D3) ═══
 *
 * An elevated-but-not-dangerous first reading offers five minutes on the rest chairs:
 * `bench-state resting` carries the recall time on the ENTRY, so every screen watching the doctor
 * sees it and nobody has to remember. The first take is held by the bay under the encounter so the
 * recall lands as a PAIR (`readings.bp.takes` with both), never averaged, never overwritten.
 * Rest is refused at danger numbers — the design's line — because a stroke does not improve by
 * sitting down.
 */
export const REST_MINUTES = 5;
const PENDING_KEY = (encounterId: string): string => `vitalsBay.pending.${encounterId}`;

export function holdFirstTake(encounterId: string, take: [number, number]): void {
  try { sessionStorage.setItem(PENDING_KEY(encounterId), JSON.stringify({ bp: take })); } catch { /* the pair then needs retyping — the recall still fires from the bench */ }
}
export function heldFirstTake(encounterId: string): [number, number] | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY(encounterId));
    if (raw === null) return null;
    const p = JSON.parse(raw) as { bp?: unknown };
    return Array.isArray(p.bp) && p.bp.length === 2 && typeof p.bp[0] === "number" && typeof p.bp[1] === "number" ? [p.bp[0], p.bp[1]] : null;
  } catch { return null; }
}
export function releaseFirstTake(encounterId: string): void {
  try { sessionStorage.removeItem(PENDING_KEY(encounterId)); } catch { /* nothing to release */ }
}

/**
 * "Elevated but not dangerous": inside the band, but within 20 / 10 mmHg of its ceiling, or 20 mmHg
 * above the last chart's systolic. DECIDED here (a threshold, not money): the standard corporate-OPD
 * rest-and-recheck trigger, and the server never sees it — it is the bay's offer, not a chart fact.
 */
export function isElevated(take: Take, band: WireBandConfig | null, last: WirePreStage["last"]): boolean {
  if (!Array.isArray(take) || band === null || band.notRoutine.includes("sbp")) return false;
  const [s, d] = take;
  const sMax = band.ranges.sbp?.max; const dMax = band.ranges.dbp?.max;
  if (sMax !== undefined && s > sMax) return false;
  if (dMax !== undefined && d > dMax) return false;
  if (sMax !== undefined && s >= sMax - 20) return true;
  if (dMax !== undefined && d >= dMax - 10) return true;
  if (last !== null && last.sbp !== null && s >= last.sbp + 20) return true;
  return false;
}

/** The numbers on the tiles right now, in the wire's vocabulary, for the protocol's routes. */
export function readingFrom(tiles: Tiles): WireEscalationReading {
  const r: WireEscalationReading = {};
  const bp = operative(tiles.bp);
  if (Array.isArray(bp)) { r.sbp = bp[0]; r.dbp = bp[1]; }
  for (const k of ["pulse", "rr", "spo2", "tempC", "muacCm"] as const) {
    const v = operative(tiles[k]);
    if (typeof v === "number") r[k] = v;
  }
  return r;
}

export type ProtocolState = {
  view: WireEscalationView | null;
  busy: boolean;
  error: string | null;
  /** Set when the server said the second arm was inside the band and withdrew the demand. */
  calmed: boolean;
  msLeft: number;
  /** The tile the demand was raised on: "the other arm" is a cuff instruction, a thermometer is "take it again". */
  demandedKey: TileKey | null;
};

export function useDangerProtocol(encounterId: string | null, initial: WireEscalationView | null): ProtocolState & {
  demand: (reading: WireEscalationReading, key: TileKey) => Promise<void>;
  confirm: (reading: WireEscalationReading) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [view, setView] = useState<WireEscalationView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calmed, setCalmed] = useState(false);
  const [msLeft, setMsLeft] = useState(0);
  const [demandedKey, setDemandedKey] = useState<TileKey | null>(null);
  const openedAt = useRef<number | null>(null);
  // The view follows the server's answer AND the patient: a new encounter whose answer is the same
  // value (null, null) must still drop the last patient's protocol state.
  useEffect(() => { setView(initial); }, [initial, encounterId]);
  // pass 2 / F10 — the demanded tile and the calmed line survive a refetch; they reset with the patient.
  useEffect(() => { setCalmed(false); setError(null); setDemandedKey(null); }, [encounterId]);

  // The cosmetic countdown: one number, ticked every 250 ms, from the instant the server answered.
  useEffect(() => {
    if (view === null || view.state !== "escalated" || view.cancelMsRemaining <= 0) { setMsLeft(0); openedAt.current = null; return; }
    openedAt.current = Date.now();
    const total = view.cancelMsRemaining;
    setMsLeft(total);
    const id = setInterval(() => {
      const left = Math.max(0, total - (Date.now() - (openedAt.current ?? Date.now())));
      setMsLeft(left);
      if (left === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [view]);

  const call = useCallback(async (fn: () => Promise<WireEscalationView>): Promise<void> => {
    if (encounterId === null) return;
    setBusy(true); setError(null);
    try { setView(await fn()); } catch (e) { setError(opdErrorMessage(e)); throw e; } finally { setBusy(false); }
  }, [encounterId]);

  const demand = useCallback(async (reading: WireEscalationReading, key: TileKey) => {
    if (encounterId === null) return;
    setDemandedKey(key);
    await call(() => demandRecheck(encounterId, reading));
  }, [call, encounterId]);
  /**
   * CLOSE pass 1 — the SERVER judges the other arm, whatever the tile's tint: a calm second arm
   * WITHDRAWS the demand (the server answers `state: "none"`, and says so), a danger one on the
   * same vital escalates, a danger on a different vital is refused as a new first reading.
   */
  const confirm = useCallback(async (reading: WireEscalationReading) => {
    if (encounterId === null) return;
    try {
      let next: WireEscalationView | null = null;
      await call(async () => { next = await escalateVisit(encounterId, reading); return next; });
      setCalmed(next !== null && (next as WireEscalationView).state === "none");
    } catch {
      // the refusal is on screen (p.error): a replay, or a different vital
    }
  }, [call, encounterId]);
  const cancel = useCallback(async () => {
    if (encounterId === null) return;
    try { await call(() => cancelEscalation(encounterId)); } catch { /* the error is on screen: the window closed, or nothing to cancel */ }
  }, [call, encounterId]);

  return { view, busy, error, calmed, msLeft, demandedKey, demand, confirm, cancel };
}

export function ProtocolPanel({ p, doctorName, rerun }: {
  p: ProtocolState & { cancel: () => Promise<void> }; doctorName: string;
  /** CLOSE pass 1 — after a named human's cancel, a new danger take does not re-run the protocol by itself. */
  rerun?: { onRerun: () => void } | null;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const state = p.view?.state ?? "none";
  if (state === "none" && p.error === null && !p.calmed && (rerun === null || rerun === undefined)) return null;
  const secs = Math.ceil(p.msLeft / 1000);
  return (
    <div role="status" data-testid="protocol" data-state={state} className={`flex flex-col gap-1 rounded border p-3 text-sm ${state === "escalated" || state === "recheck_demanded" ? "border-destructive" : "border-border"}`}>
      {state === "recheck_demanded" && (
        <p className="font-semibold" data-testid="protocol-demand">{t(p.demandedKey === "bp" || p.demandedKey === null ? "vitalsBay.protocol.otherArm" : "vitalsBay.protocol.again")}</p>
      )}
      {state === "none" && p.calmed && (
        <p data-testid="protocol-calmed">{t("vitalsBay.protocol.calmed")}</p>
      )}
      {rerun !== null && rerun !== undefined && (
        <p data-testid="protocol-rerun">
          {t("vitalsBay.protocol.rerunAsk")} <button type="button" data-testid="protocol-rerun-go" className="underline" onClick={rerun.onRerun}>{t("vitalsBay.protocol.rerunGo")}</button>
        </p>
      )}
      {state === "escalated" && (
        <>
          <p className="font-semibold" data-testid="protocol-escalated">
            {t("vitalsBay.protocol.escalated", { from: p.view?.escalatedFromClass ?? "", doctor: doctorName })}
          </p>
          {p.msLeft > 0 ? (
            <button type="button" data-testid="protocol-cancel" disabled={p.busy} className="self-start rounded border border-destructive px-2 py-1"
              onClick={() => { void p.cancel(); }}>
              {t("vitalsBay.protocol.cancel")} <span data-testid="protocol-countdown">{secs}s</span>
            </button>
          ) : (
            <p data-testid="protocol-committed">{t("vitalsBay.protocol.committed")}</p>
          )}
        </>
      )}
      {state === "cancelled" && <p data-testid="protocol-cancelled">{t("vitalsBay.protocol.cancelled", { from: p.view?.escalatedFromClass ?? "" })}</p>}
      {p.error !== null && <p role="alert" data-testid="protocol-error">{p.error}</p>}
    </div>
  );
}

export function RestOffer({ recallAt, onRest, busy }: { recallAt: string; onRest: () => void; busy: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div role="status" data-testid="rest-offer" className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-sm">
      <span>{t("vitalsBay.rest.offer", { minutes: REST_MINUTES, time: recallAt })}</span>
      <button type="button" data-testid="rest-go" disabled={busy} className="rounded border px-2 py-1" onClick={onRest}>{t("vitalsBay.rest.go")}</button>
    </div>
  );
}
