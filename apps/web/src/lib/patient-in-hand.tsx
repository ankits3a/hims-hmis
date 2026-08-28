import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth";

/**
 * PLAN 07b T1 — THE PATIENT IN HAND.
 *
 * Four screens each mounted their own `PatientPicker` with its own `useState`, and the moment a
 * route unmounted, everything the clerk knew was discarded. The simplest walk-in therefore cost
 * three searches for the same person, because the app had no idea a person was being served at
 * all — its unit of work was a module screen, and the counter's unit of work is one human from
 * hello to goodbye.
 *
 * ═══ IDS ONLY. NEVER A NAME. ═══
 *
 * What is stored is `patientId` and `encounterId` and nothing else. A cached NAME is a
 * wrong-patient risk: after a merge the losing id still resolves — `getPatient` follows the chain —
 * but a name captured before the merge does not change, so a strip pinned to every screen would go
 * on displaying a person who no longer exists under that record. A merge is ruled a patient-safety
 * emergency; a stale label on every screen in the hospital is exactly how one becomes invisible.
 * Everything displayed is read live from the id.
 *
 * ═══ sessionStorage, NOT localStorage ═══
 *
 * It must survive an accidental refresh — which happens several times a shift on a counter machine
 * — and it must NOT survive the shift change. `localStorage` on a shared terminal would hand the
 * next clerk the previous clerk's patient. This is the same reasoning the command palette already
 * applies to its recent searches (Plan 11h DD8), inherited rather than re-derived.
 *
 * Every accessor is wrapped: a private window, cleared site data, or a browser set to block storage
 * throws on access rather than returning null, and a counter that cannot open because storage is
 * disabled is a worse failure than a patient that has to be picked again.
 */
export type InHand = { patientId: string; encounterId: string | null };

type InHandState = {
  inHand: InHand | null;
  /** Take a patient in hand. Clears any encounter — a new patient cannot inherit the last one's visit. */
  takePatient: (patientId: string) => void;
  /** Attach the visit just opened for the patient already in hand. */
  takeEncounter: (encounterId: string) => void;
  release: () => void;
};

const KEY = "hmis.inHand";
const PatientInHandContext = createContext<InHandState | null>(null);

function read(): InHand | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { patientId, encounterId } = parsed as Record<string, unknown>;
    if (typeof patientId !== "string" || patientId === "") return null;
    return { patientId, encounterId: typeof encounterId === "string" ? encounterId : null };
  } catch {
    return null; // storage unavailable or corrupt — the counter still opens
  }
}

function write(value: InHand | null): void {
  try {
    if (value === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage unavailable — the context still works for the life of the tab
  }
}

export function PatientInHandProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { actor, ready } = useAuth();
  const [inHand, setInHand] = useState<InHand | null>(read);

  const takePatient = useCallback((patientId: string) => {
    const next: InHand = { patientId, encounterId: null };
    setInHand(next);
    write(next);
  }, []);

  const takeEncounter = useCallback((encounterId: string) => {
    setInHand((prev) => {
      if (prev === null) return prev;
      const next: InHand = { ...prev, encounterId };
      write(next);
      return next;
    });
  }, []);

  const release = useCallback(() => {
    setInHand(null);
    write(null);
  }, []);

  /**
   * SIGNING OUT PUTS THE PATIENT DOWN. Without this the next person to sign in on a shared counter
   * machine inherits the last one's patient inside the same tab — the shift-change leak that
   * choosing `sessionStorage` was meant to prevent, arriving through the other door.
   *
   * ═══ `ready` IS LOAD-BEARING, AND ITS ABSENCE WAS A REAL BUG ═══
   *
   * The first version keyed on `actor === null` alone. But `actor` is null for the whole of every
   * page load, while `GET /auth/me` is still in flight — so the effect fired on EVERY refresh and
   * wiped the patient it exists to preserve. The feature's headline property, surviving an
   * accidental refresh, was broken by the guard meant to protect it, and the A2 assertion is what
   * caught it. Only a RESOLVED absence of an actor is a sign-out.
   */
  useEffect(() => {
    if (ready && actor === null) {
      setInHand(null);
      write(null);
    }
  }, [ready, actor]);

  const value = useMemo(
    () => ({ inHand, takePatient, takeEncounter, release }),
    [inHand, takePatient, takeEncounter, release],
  );
  return <PatientInHandContext.Provider value={value}>{children}</PatientInHandContext.Provider>;
}

export function usePatientInHand(): InHandState {
  const ctx = useContext(PatientInHandContext);
  if (ctx === null) throw new Error("usePatientInHand outside PatientInHandProvider");
  return ctx;
}

/**
 * The tolerant form, for shared components that must work OUTSIDE the authed shell.
 *
 * `PatientPicker` is mounted by screens whose own suites render them with no provider at all (and
 * by the login-adjacent flows). Throwing there would make a component that merely wants to REPORT a
 * pick into a component that requires the whole shell, so the picker degrades to "nobody is holding
 * a patient" instead — which is exactly true in those contexts.
 */
export function usePatientInHandOptional(): InHandState | null {
  return useContext(PatientInHandContext);
}
