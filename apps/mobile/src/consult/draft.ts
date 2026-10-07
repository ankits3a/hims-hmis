import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { parseDraft } from "./rules";
import type { ConsultDraft } from "./rules";

/**
 * THE VISIT'S DRAFT, ON THE PHONE (decision 0048: "nothing typed is lost").
 *
 * What the doctor has written for a visit and not yet issued is clinical text about a patient, so
 * it is kept where the session token is kept: the Android Keystore-backed secure store, encrypted
 * at rest, readable only while the phone is unlocked, never in plain storage and never in a
 * backup. One value there is small, so a draft is written as numbered chunks.
 *
 * IT IS NEVER SENT BY ITSELF. Nothing here talks to the server; the draft leaves the phone only
 * when the doctor presses Issue (or the screen autosaves the note while online, which is the same
 * `consult/note` route the computer's autosave uses). It is removed when the visit is issued and
 * completed, when the doctor says "I wrote on paper", and for every visit at sign-out.
 */
const PREFIX = "hmis.consult.";
const INDEX = "hmis.consult.index";
const CHUNK = 1800;
const OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const memory = new Map<string, string>();
const web = Platform.OS === "web";

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");
async function getRaw(key: string): Promise<string | null> { return web ? memory.get(key) ?? null : SecureStore.getItemAsync(key); }
async function setRaw(key: string, value: string): Promise<void> { if (web) memory.set(key, value); else await SecureStore.setItemAsync(key, value, OPTS); }
async function delRaw(key: string): Promise<void> { if (web) memory.delete(key); else await SecureStore.deleteItemAsync(key); }

async function index(): Promise<string[]> {
  try {
    const v = JSON.parse((await getRaw(INDEX)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const draftStore = {
  async load(encounterId: string): Promise<ConsultDraft | null> {
    try {
      const k = PREFIX + safe(encounterId);
      const n = Number((await getRaw(`${k}.n`)) ?? "0");
      if (!Number.isInteger(n) || n <= 0 || n > 40) return null;
      let raw = "";
      for (let i = 0; i < n; i++) raw += (await getRaw(`${k}.${String(i)}`)) ?? "";
      return parseDraft(raw, encounterId);
    } catch {
      return null;
    }
  },
  async save(draft: ConsultDraft): Promise<void> {
    try {
      const k = PREFIX + safe(draft.encounterId);
      const raw = JSON.stringify(draft);
      const parts: string[] = [];
      for (let i = 0; i < raw.length; i += CHUNK) parts.push(raw.slice(i, i + CHUNK));
      const had = Number((await getRaw(`${k}.n`)) ?? "0");
      for (let i = 0; i < parts.length; i++) await setRaw(`${k}.${String(i)}`, parts[i]!);
      await setRaw(`${k}.n`, String(parts.length));
      for (let i = parts.length; i < had; i++) await delRaw(`${k}.${String(i)}`);
      const ids = await index();
      if (!ids.includes(draft.encounterId)) await setRaw(INDEX, JSON.stringify([...ids, draft.encounterId].slice(-30)));
    } catch {
      // A phone that cannot write its secure store still has the draft on screen; nothing is claimed saved.
    }
  },
  async clear(encounterId: string): Promise<void> {
    try {
      const k = PREFIX + safe(encounterId);
      const n = Number((await getRaw(`${k}.n`)) ?? "0");
      for (let i = 0; i < Math.min(Number.isInteger(n) ? n : 0, 40); i++) await delRaw(`${k}.${String(i)}`);
      await delRaw(`${k}.n`);
      await setRaw(INDEX, JSON.stringify((await index()).filter((x) => x !== encounterId)));
    } catch {
      // nothing to do
    }
  },
  /** Sign-out: no visit's draft outlives the session that wrote it. */
  async clearAll(): Promise<void> {
    for (const id of await index()) await draftStore.clear(id);
    await delRaw(INDEX).catch(() => undefined);
  },
};

const NOTICE = "hmis.consult.voice-notice";
/** The one-time voice notice ("do not say the patient's name") has been read on this phone. */
export const voiceNotice = {
  async seen(): Promise<boolean> { try { return (await getRaw(NOTICE)) === "1"; } catch { return false; } },
  async mark(): Promise<void> { try { await setRaw(NOTICE, "1"); } catch { /* shown again next time */ } },
};
