import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "./api";
import { useI18n } from "./i18n";
import { devicePush, type PushNote, type PushPermission, type PushPhone } from "./push-phone";
import { seatsFor, type Seat } from "./seats";
import { useSession } from "./session";
import { Text } from "./text";
import { color, radius, space } from "./theme";

/**
 * ═══ M6b — NOTIFICATIONS ON THIS PHONE (owner 2026-10-06) ═══
 *
 * A notification says "open HMIS" and which kind of thing it is. It never carries a patient's name,
 * a UHID or a finding: these are personal phones and a lock screen is read by whoever holds it. The
 * sentence is chosen on the server from a fixed table (kernel/push/phone-push.ts).
 *
 * FIVE STATES, and the screens say which one in words:
 *   notInBuild  this APK was built without the hospital's Firebase project — nothing is asked;
 *   serverOff   the server has no Firebase key yet — nothing is asked;
 *   off         could be on; the person has not turned it on (or turned it off);
 *   denied      the person refused the phone's own prompt — only the phone's settings can undo that;
 *   on          this phone has given the server its address.
 *
 * NOTHING IS ASKED UNINVITED. The phone's permission prompt opens only after the person taps
 * "Turn on" under a sentence that says what a notification will and will not contain.
 */
export const PUSH_CATEGORIES = ["alert", "roster", "queue"] as const;
/** The server's `link` word → the phone screen it opens. An unknown word, or a screen this person may not open, is home. */
export const PUSH_LINK_SEAT: Record<string, Seat["key"] | null> = { home: null, onNow: "onNow", myDuties: "myDuties", consult: "consult" };

export type PushStatus = "unknown" | "notInBuild" | "serverOff" | "off" | "denied" | "on";
type ServerState = { configured: boolean; registered: boolean; muted: string[]; categories: string[] };

type Notifications = {
  status: PushStatus;
  /** The categories something raises today (the server's list), and which of them are off on this phone. */
  categories: string[];
  muted: string[];
  busy: boolean;
  /** An i18n key for what just went wrong, or null. */
  problem: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  setMuted: (category: string, muted: boolean) => Promise<void>;
  /** The home screen may offer to turn notifications on (never asked before, could be on). */
  offer: boolean;
  dismissOffer: () => void;
};

const Ctx = createContext<Notifications | null>(null);
const OFFER_KEY = "hmis.push.offer";
let offerMemory: string | null = null;

async function offerDismissed(): Promise<boolean> {
  if (Platform.OS === "web") return offerMemory !== null;
  try { return (await SecureStore.getItemAsync(OFFER_KEY)) !== null; } catch { return offerMemory !== null; }
}
async function rememberOfferDismissed(): Promise<void> {
  offerMemory = "1";
  if (Platform.OS === "web") return;
  try { await SecureStore.setItemAsync(OFFER_KEY, "1"); } catch { /* asked again next time the app starts */ }
}

export function statusOf(inBuild: boolean, server: ServerState | null, permission: PushPermission): PushStatus {
  if (!inBuild) return "notInBuild";
  if (server === null) return "unknown";
  if (!server.configured) return "serverOff";
  if (permission === "denied") return "denied";
  return server.registered && permission === "granted" ? "on" : "off";
}

const BANNER_MS = 8000;

export function NotificationsProvider({ children, phone: injected }: { children: ReactNode; phone?: PushPhone }) {
  const { state, call } = useSession();
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const phone = useMemo<PushPhone>(() => {
    if (injected !== undefined) return injected;
    const preview = Platform.OS === "web" ? (globalThis as { __HMIS_TEST_PUSH__?: PushPhone }).__HMIS_TEST_PUSH__ : undefined;
    return preview ?? devicePush();
  }, [injected]);
  const signedIn = state.status === "signedIn";
  const permissions = state.status === "signedIn" ? state.me.permissions : null;

  const [server, setServer] = useState<ServerState | null>(null);
  const [permission, setPermission] = useState<PushPermission>("undetermined");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [banner, setBanner] = useState<PushNote | null>(null);
  const openedOnce = useRef(false);

  const labels = useMemo(() => Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, t(`mobile.push.category.${c}`)])), [t]);

  /** Hand the server this phone's address (again). Quiet: a failure here is retried the next time the app opens. */
  const handOver = useCallback(async (token: string): Promise<ServerState | null> => {
    try {
      return await call<ServerState>("PUT", "/auth/phone/notifications", { token, language: lang });
    } catch {
      return null;
    }
  }, [call, lang]);

  // On sign-in: what does the server know about this phone, and — if the person already said yes on
  // this phone — refresh the address (Firebase rotates it) and the language.
  useEffect(() => {
    if (!signedIn) { setServer(null); return; }
    if (!phone.inBuild) return;
    let gone = false;
    void (async () => {
      setDismissed(await offerDismissed());
      const perm = await phone.permission();
      let seen: ServerState | null = null;
      try {
        seen = await call<ServerState>("GET", "/auth/phone/notifications");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        seen = null;
      }
      if (gone) return;
      setPermission(perm);
      if (seen !== null && seen.configured && seen.registered && perm === "granted") {
        await phone.channels(labels);
        const token = await phone.token();
        if (token !== null) seen = (await handOver(token)) ?? seen;
      }
      if (!gone) setServer(seen);
    })();
    return () => { gone = true; };
    // `labels` and `handOver` change with the language; the language effect below carries that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, phone, call]);

  const status = statusOf(phone.inBuild, server, permission);

  // The app's language changed while notifications are on: the next sentence is said in it.
  useEffect(() => {
    if (status !== "on") return;
    void call<ServerState>("PUT", "/auth/phone/notifications", { language: lang }).then(setServer, () => undefined);
    void phone.channels(labels);
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((link: string) => {
    const seat = PUSH_LINK_SEAT[link] ?? null;
    const allowed = seat !== null && permissions !== null && seatsFor(permissions).some((s) => s.key === seat);
    if (allowed) router.push({ pathname: "/seat/[key]", params: { key: seat } });
    else router.push("/");
  }, [permissions, router]);

  useEffect(() => {
    if (!signedIn || !phone.inBuild) return;
    const offToken = phone.onToken((token) => { void handOver(token).then((s) => { if (s !== null) setServer(s); }); });
    const offReceived = phone.onReceived((note) => setBanner(note));
    const offOpened = phone.onOpened(open);
    if (!openedOnce.current) {
      openedOnce.current = true;
      void phone.openedWith().then((link) => { if (link !== null && link !== "") open(link); });
    }
    return () => { offToken(); offReceived(); offOpened(); };
  }, [signedIn, phone, handOver, open]);

  useEffect(() => {
    if (banner === null) return;
    const timer = setTimeout(() => setBanner(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const enable = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      let perm = await phone.permission();
      if (perm !== "granted") perm = await phone.ask();
      setPermission(perm);
      if (perm !== "granted") { setProblem("mobile.push.problem.denied"); return; }
      await phone.channels(labels);
      const token = await phone.token();
      if (token === null) { setProblem("mobile.push.problem.noAddress"); return; }
      const next = await call<ServerState>("PUT", "/auth/phone/notifications", { token, language: lang });
      setServer(next);
    } catch {
      setProblem("mobile.push.problem.notSaved");
    } finally {
      setBusy(false);
      setDismissed(true);
      void rememberOfferDismissed();
    }
  }, [phone, labels, call, lang]);

  const disable = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      setServer(await call<ServerState>("DELETE", "/auth/phone/notifications"));
    } catch {
      setProblem("mobile.push.problem.notSaved");
    } finally {
      setBusy(false);
    }
  }, [call]);

  const setMuted = useCallback(async (category: string, muted: boolean) => {
    if (server === null) return;
    const next = muted ? [...new Set([...server.muted, category])] : server.muted.filter((m) => m !== category);
    setProblem(null);
    try {
      setServer(await call<ServerState>("PUT", "/auth/phone/notifications", { muted: next }));
    } catch {
      setProblem("mobile.push.problem.notSaved");
    }
  }, [server, call]);

  const dismissOffer = useCallback(() => { setDismissed(true); void rememberOfferDismissed(); }, []);

  const value = useMemo<Notifications>(() => ({
    status, categories: server?.categories ?? [], muted: server?.muted ?? [], busy, problem, enable, disable, setMuted,
    offer: signedIn && status === "off" && permission === "undetermined" && !dismissed, dismissOffer,
  }), [status, server, busy, problem, enable, disable, setMuted, signedIn, permission, dismissed, dismissOffer]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {banner !== null && signedIn && (
        <Pressable
          testID="push-banner" accessibilityRole="button"
          onPress={() => { const link = banner.link; setBanner(null); open(link); }}
          style={[s.banner, { top: insets.top + space.sm }]}
        >
          <View style={s.bannerMark} />
          <View style={{ flex: 1 }}>
            <Text style={s.bannerKind} testID="push-banner-kind">{t(`mobile.push.category.${(PUSH_CATEGORIES as readonly string[]).includes(banner.category) ? banner.category : "alert"}`)}</Text>
            <Text style={s.bannerBody} testID="push-banner-body">{banner.body === "" ? t("mobile.push.bannerFallback") : banner.body}</Text>
          </View>
          <Text style={s.bannerOpen}>{t("mobile.push.open")}</Text>
        </Pressable>
      )}
    </Ctx.Provider>
  );
}

const INERT: Notifications = {
  status: "notInBuild", categories: [], muted: [], busy: false, problem: null,
  enable: () => Promise.resolve(), disable: () => Promise.resolve(), setMuted: () => Promise.resolve(), offer: false, dismissOffer: () => undefined,
};

/** A screen mounted without the provider (older tests, a preview) sees "not in this build" and offers nothing. */
export function useNotifications(): Notifications {
  return useContext(Ctx) ?? INERT;
}

/** Tests only: forget that the offer was dismissed. */
export function _forgetOfferForTests(): void { offerMemory = null; }

const s = StyleSheet.create({
  banner: {
    position: "absolute", left: space.md, right: space.md, flexDirection: "row", alignItems: "center", gap: space.md,
    backgroundColor: color.card, borderWidth: 2, borderColor: color.green, borderRadius: radius.lg, padding: space.md,
    elevation: 6, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  bannerMark: { width: 10, height: 10, backgroundColor: color.green, transform: [{ rotate: "45deg" }] },
  bannerKind: { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: color.green },
  bannerBody: { fontSize: 15, lineHeight: 20, color: color.ink },
  bannerOpen: { fontSize: 14, fontWeight: "700", color: color.green },
});
