import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, NetworkError } from "../api";
import { refusalText, type VitalsApi, type WireEscalationView } from "./api";
import type { TileKey, WireEscalationReading } from "./rules";

/**
 * THE DANGER PROTOCOL — the server judges, the phone asks (the web bay's `useDangerProtocol`,
 * same routes, same order):
 *
 *   one danger reading  → `…/escalation/recheck`  — "the other arm, now"; nothing moves on the board
 *   the second reading  → `…/escalation/escalate` — danger again: class 0, the doctor's screen flashes,
 *                                                    and a short cancel window opens; calm: withdrawn
 *   inside the window   → `…/escalation/cancel`
 *
 * The countdown is COSMETIC: it starts from the `cancelMsRemaining` the server answered, and the
 * server refuses a late cancel whatever this screen still shows.
 */
export type Protocol = {
  view: WireEscalationView | null;
  busy: boolean;
  error: string | null;
  /** The server said the second reading was inside the band and withdrew the demand. */
  calmed: boolean;
  msLeft: number;
  /** The tile the demand was raised on: "the other arm" is a cuff instruction, a thermometer is "take it again". */
  demandedKey: TileKey | null;
  demand: (reading: WireEscalationReading, key: TileKey) => Promise<void>;
  confirm: (reading: WireEscalationReading) => Promise<void>;
  cancel: () => Promise<void>;
};

export function useDangerProtocol(api: VitalsApi, encounterId: string | null, networkText: string): Protocol {
  const [view, setView] = useState<WireEscalationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calmed, setCalmed] = useState(false);
  const [msLeft, setMsLeft] = useState(0);
  const [demandedKey, setDemandedKey] = useState<TileKey | null>(null);
  const live = useRef<string | null>(null);

  // A re-identified patient shows where the server has them; nothing carries over from the last one.
  useEffect(() => {
    live.current = encounterId;
    setView(null); setCalmed(false); setError(null); setDemandedKey(null);
    if (encounterId === null) return;
    api.escalation(encounterId)
      .then((r) => { if (live.current === encounterId) setView(r.escalation); })
      .catch(() => undefined); // the state then arrives with the first protocol call
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the patient
  }, [encounterId]);

  useEffect(() => {
    if (view === null || view.state !== "escalated" || view.cancelMsRemaining <= 0) { setMsLeft(0); return; }
    const openedAt = Date.now();
    const total = view.cancelMsRemaining;
    setMsLeft(total);
    const id = setInterval(() => {
      const left = Math.max(0, total - (Date.now() - openedAt));
      setMsLeft(left);
      if (left === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [view]);

  const run = useCallback(async (fn: (id: string) => Promise<WireEscalationView>): Promise<WireEscalationView | null> => {
    if (encounterId === null) return null;
    setBusy(true); setError(null);
    try {
      const next = await fn(encounterId);
      if (live.current === encounterId) setView(next);
      return next;
    } catch (e) {
      setError(e instanceof ApiError ? refusalText(e.body, e.code) : e instanceof NetworkError ? networkText : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [encounterId, networkText]);

  const demand = useCallback(async (reading: WireEscalationReading, key: TileKey) => {
    setDemandedKey(key);
    await run((id) => api.demandRecheck(id, reading));
  }, [run, api]);
  const confirm = useCallback(async (reading: WireEscalationReading) => {
    const next = await run((id) => api.escalate(id, reading));
    setCalmed(next !== null && next.state === "none");
  }, [run, api]);
  const cancel = useCallback(async () => { await run((id) => api.cancelEscalation(id)); }, [run, api]);

  return { view, busy, error, calmed, msLeft, demandedKey, demand, confirm, cancel };
}

/*
  THE FIRST READING, HELD ACROSS A REST. The web keeps it in the tab's sessionStorage; the phone
  keeps it for as long as the app is open. If the app is closed in those five minutes the pair
  needs retyping — the recall itself lives on the server's bench and still fires.
*/
const held = new Map<string, [number, number]>();
export const holdFirstTake = (encounterId: string, take: [number, number]): void => { held.set(encounterId, take); };
export const heldFirstTake = (encounterId: string): [number, number] | null => held.get(encounterId) ?? null;
export const releaseFirstTake = (encounterId: string): void => { held.delete(encounterId); };
