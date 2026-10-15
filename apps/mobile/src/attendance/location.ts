import * as Location from "expo-location";

/**
 * ═══ ONE READING, IN THE FOREGROUND, WHEN THE PERSON TAPS "MARK ATTENDANCE" (decision 0061) ═══
 *
 * Asks "while using the app" permission the first time, reads the position ONCE, and hands it straight
 * to the request. Nothing here keeps it, logs it or watches the position: no background task, no
 * subscription. Any failure — refused, switched off, no fix in time — is "no reading", which the
 * server saves as "location not shared".
 */
export type Reading = { latitude: number; longitude: number; mocked: boolean };
export const READ_TIMEOUT_MS = 15_000;

/** Has this phone never been asked? (Android then shows our sentence first; the iPhone's own prompt carries it.) */
export async function neverAsked(): Promise<boolean> {
  try { return (await Location.getForegroundPermissionsAsync()).status === Location.PermissionStatus.UNDETERMINED; } catch { return false; }
}

export async function readOnce(timeoutMs: number = READ_TIMEOUT_MS): Promise<Reading | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if ((await Location.requestForegroundPermissionsAsync()).status !== Location.PermissionStatus.GRANTED) return null;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const pos = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), late]);
    if (pos === null) return null;
    // `mocked` is Android's "a mock-location app supplied this"; the iPhone never sets it.
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, mocked: pos.mocked === true };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
