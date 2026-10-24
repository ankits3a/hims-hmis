import { useEffect, useSyncExternalStore } from "react";
import { useSessionOptional } from "../session";

/**
 * PHONE SETTINGS (owner 2026-10-11, spec SPEC-phone-settings-2026-10-11) — is the copilot ON for this
 * person? It follows the ACCOUNT: read from `GET /copilot/setting` once per sign-in and written by the
 * Settings switch (`PUT`). OFF until the server says otherwise — the owner's default, and the safe answer
 * offline. One shared value, so the band's icon and the switch never disagree.
 */
type State = { user: string | null; on: boolean; known: boolean };
let state: State = { user: null, on: false, known: false };
const listeners = new Set<() => void>();
const emit = (next: State): void => { state = next; for (const l of listeners) l(); };
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * `known` — the server has answered (or could not be reached, which reads as off) for this person. Until
 * then `on` is false only because nothing is known yet: a route that sends an "off" person to Settings
 * waits for `known`, so a cold start from the Ask widget is not bounced there while the read is in flight.
 */
export function useCopilotOn(): { on: boolean; known: boolean; set: (on: boolean) => Promise<void> } {
  const session = useSessionOptional();
  const user = session?.state.status === "signedIn" ? session.state.username : null;
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (user === state.user) return;
    emit({ user, on: false, known: false });
    if (user === null || session === null) return;
    session.call<{ phone: boolean }>("GET", "/copilot/setting")
      .then((r) => { if (state.user === user) emit({ user, on: r.phone === true, known: true }); },
        () => { if (state.user === user) emit({ user, on: false, known: true }); });
  }, [user, session]);
  const set = async (on: boolean): Promise<void> => {
    if (session === null || user === null) return;
    const before = state.on;
    emit({ user, on, known: true });
    try {
      const r = await session.call<{ phone: boolean }>("PUT", "/copilot/setting", { phone: on });
      emit({ user, on: r.phone === true, known: true });
    } catch (e) { emit({ user, on: before, known: true }); throw e; }
  };
  return { on: snap.user === user && snap.on, known: snap.user === user && snap.known, set };
}

/** Tests only: forget the value between renders. */
export function _resetCopilotSettingForTests(): void { emit({ user: null, on: false, known: false }); }
