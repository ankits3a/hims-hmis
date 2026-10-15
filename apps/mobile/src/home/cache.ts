import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { HomeModel, NeedCard, Tile } from "./model";
import type { NeedKind, Tone } from "./rules";

/**
 * THE LAST HOME, KEPT ACROSS A CLOSED APP (app home round 2, decision 0043). Round 1 kept it in
 * memory, so a phone opened in the basement showed nothing at all.
 *
 * COUNTS ONLY. What is written is the cards' kind, count and clock and the three tiles — no
 * patient's name, no colleague's name, no note, no amount on a request. A phone is lost more easily
 * than a counter PC, and a cache is the part of an app nobody remembers is there. It sits in the
 * same Keystore-backed store as the session, under this user's id, and is dropped at sign-out.
 * Nothing can be decided from it: a cold card has no button.
 */
const KEY = "hmis.home";
const MAX_CARDS = 8;
let memory: string | null = null;

export type ColdCard = { kind: NeedKind; count: number | null; titleKey: string; subKey: string | null; tone: Tone; sinceMs: number; dueMs: number | null };
export type ColdHome = { user: string; at: number; cards: ColdCard[]; total: number; tiles: Tile[] };

/** Titles that carry a NAME in their words are replaced by the kind's plain one. */
const NAMELESS: Partial<Record<NeedKind, string>> = { cover_request: "home.cold.cover", approval: "home.cold.approval", my_request: "home.cold.myRequest" };

/**
 * `ownerTiles` — the owner's and the Medical Superintendent's tiles, when the home is theirs: a key and
 * its number, nothing else (owner 2026-10-09). The Money tile is only ever in an owner's set, so a
 * phone that is not the owner's holds no rupee.
 */
export function coldOf(user: string, at: number, model: HomeModel, ownerTiles?: readonly { key: string; labelKey: string; value: string }[] | null): ColdHome {
  return {
    user, at, total: model.needsTotal,
    cards: model.allNeeds.slice(0, MAX_CARDS).map((n: NeedCard) => ({
      kind: n.kind, count: n.count, titleKey: NAMELESS[n.kind] ?? n.titleKey, subKey: NAMELESS[n.kind] !== undefined ? null : n.subKey,
      tone: n.tone, sinceMs: n.sinceMs, dueMs: n.dueMs,
    })),
    tiles: ownerTiles != null ? ownerTiles.map((t) => ({ key: t.key, labelKey: t.labelKey, value: t.value })) : model.tiles.map((t) => ({ ...t })),
  };
}

export const homeCache = {
  async save(cold: ColdHome): Promise<void> {
    const raw = JSON.stringify(cold);
    try {
      if (Platform.OS === "web") { memory = raw; return; }
      await SecureStore.setItemAsync(KEY, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } catch { /* a cache that cannot be written is a cache that is not there */ }
  },
  async load(user: string): Promise<ColdHome | null> {
    try {
      const raw = Platform.OS === "web" ? memory : await SecureStore.getItemAsync(KEY);
      if (raw === null) return null;
      const v = JSON.parse(raw) as Partial<ColdHome>;
      if (v.user !== user || typeof v.at !== "number" || !Array.isArray(v.cards) || !Array.isArray(v.tiles)) return null;
      return { user: v.user, at: v.at, cards: v.cards, total: typeof v.total === "number" ? v.total : v.cards.length, tiles: v.tiles };
    } catch { return null; }
  },
  async clear(): Promise<void> {
    memory = null;
    try { if (Platform.OS !== "web") await SecureStore.deleteItemAsync(KEY); } catch { /* nothing to clear */ }
  },
};

/** Requests of mine whose answer I have seen — ids only, the newest forty. */
const SEEN_KEY = "hmis.home.seen";
let seenMemory: string | null = null;
export const seenRequests = {
  async load(): Promise<string[]> {
    try {
      const raw = Platform.OS === "web" ? seenMemory : await SecureStore.getItemAsync(SEEN_KEY);
      const v = raw === null ? [] : (JSON.parse(raw) as unknown);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  },
  async add(id: string, have: readonly string[]): Promise<string[]> {
    const next = [...have.filter((x) => x !== id), id].slice(-40);
    const raw = JSON.stringify(next);
    try { if (Platform.OS === "web") seenMemory = raw; else await SecureStore.setItemAsync(SEEN_KEY, raw); } catch { /* remembered for this run only */ }
    return next;
  },
};
