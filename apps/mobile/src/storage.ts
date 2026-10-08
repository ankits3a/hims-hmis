import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * The session token lives in the Android Keystore-backed secure store, never in plain storage.
 * The web export (used only to look at screens in a browser) has no secure store, so there it
 * is held in memory and gone on reload.
 */
const KEY = "hmis.session";
/** `since` — when this phone signed in (ISO), for the Account screen; absent on a session stored by an older build. */
export type Stored = { token: string; username: string; since?: string };
let memory: string | null = null;

function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    return typeof v.token === "string"
      ? { token: v.token, username: typeof v.username === "string" ? v.username : "", ...(typeof v.since === "string" ? { since: v.since } : {}) }
      : null;
  } catch {
    return null;
  }
}

export const tokenStore = {
  async get(): Promise<Stored | null> {
    if (Platform.OS === "web") return parse(memory);
    return parse(await SecureStore.getItemAsync(KEY));
  },
  async set(value: Stored): Promise<void> {
    const raw = JSON.stringify(value);
    if (Platform.OS === "web") {
      memory = raw;
      return;
    }
    await SecureStore.setItemAsync(KEY, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  async clear(): Promise<void> {
    if (Platform.OS === "web") {
      memory = null;
      return;
    }
    await SecureStore.deleteItemAsync(KEY);
  },
};

/**
 * How many times a one-line hint has been shown ("swipe a row…"), so it can stop after a few.
 * Not a secret — it shares the secure store only because that is the app's one key-value store.
 */
const hintMemory = new Map<string, number>();
export const hintStore = {
  /** Counts this showing and returns the new total. A store that cannot be read counts from the phone's memory. */
  async seen(name: string): Promise<number> {
    const key = `hmis.hint.${name}`;
    let n = hintMemory.get(key) ?? 0;
    if (Platform.OS !== "web") {
      try { n = Math.max(n, Number(await SecureStore.getItemAsync(key)) || 0); } catch { /* memory count stands */ }
    }
    n += 1;
    hintMemory.set(key, n);
    if (Platform.OS !== "web") {
      try { await SecureStore.setItemAsync(key, String(n)); } catch { /* shown once more next time; never fatal */ }
    }
    return n;
  },
};
