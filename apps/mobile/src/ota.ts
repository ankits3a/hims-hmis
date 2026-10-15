import { useCallback, useRef } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Updates from "expo-updates";

/**
 * UPDATES WITHOUT AN APK (owner 2026-10-06: "I don't want to download a new apk and then install.
 * It should happen automatically.")
 *
 * A change to screens, words or rules is JavaScript. The app fetches it by itself, signed
 * (app.config.ts, `updates`), and nobody taps anything. Two moments:
 *  - every cold start, natively: the bundle is fetched behind the running app and used from the
 *    start after;
 *  - while the app stays open (a ward phone is rarely closed): asked again here, at most every
 *    fifteen minutes, whenever the person is on the home screen or comes back to it.
 *
 * WHEN it is applied is the clinical part. Applying restarts the JavaScript, and a restart under a
 * half-typed blood pressure loses it — so a fetched bundle waits until the person is on the home
 * screen, where nothing is half-typed, and is taken there. Never on a seat.
 *
 * A change to the NATIVE side still needs an APK (src/update.ts offers it). A check that cannot be
 * made — no signal, nothing published — says nothing and changes nothing.
 */
export type OtaPort = Pick<typeof Updates, "isEnabled" | "checkForUpdateAsync" | "fetchUpdateAsync" | "reloadAsync">;

export const ASK_EVERY_MS = 15 * 60_000;

export function createOta(port: OtaPort, now: () => number = Date.now) {
  let waiting = false;
  let askedAt: number | null = null;
  let busy: Promise<boolean> | null = null;

  /** Is a fetched bundle waiting to be run? Fetches one if the server has it. Never throws. */
  async function fetchQuietly(force = false): Promise<boolean> {
    if (port.isEnabled !== true) return false;
    if (waiting) return true;
    if (busy !== null) return busy;
    if (!force && askedAt !== null && now() - askedAt < ASK_EVERY_MS) return false;
    askedAt = now();
    busy = (async () => {
      try {
        if (!(await port.checkForUpdateAsync()).isAvailable) return false;
        waiting = (await port.fetchUpdateAsync()).isNew;
        return waiting;
      } catch {
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  /** Run the waiting bundle — only if `atRest()` still says so once the fetch is over. */
  async function settle(atRest: () => boolean, force = false): Promise<boolean> {
    if (!(await fetchQuietly(force)) || !atRest()) return false;
    try {
      await port.reloadAsync();
      return true;
    } catch {
      return false;
    }
  }

  return { fetchQuietly, settle };
}

export const ota = createOta(Updates);

/** What the foot of the home screen says about the bundle that is running: null when it is the APK's own. */
export function otaStamp(): string | null {
  const at = Updates.createdAt;
  if (Updates.isEnabled !== true || Updates.isEmbeddedLaunch !== false || !(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 16).replace("T", " ");
}

export function useOtaAtRest(atHome: boolean): void {
  const resting = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!atHome) return undefined;
      resting.current = true;
      const atRest = () => resting.current && AppState.currentState === "active";
      void ota.settle(atRest);
      const sub = AppState.addEventListener("change", (s) => { if (s === "active") void ota.settle(atRest); });
      return () => { resting.current = false; sub.remove(); };
    }, [atHome]),
  );
}
