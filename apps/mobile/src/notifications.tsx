import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { focusHome } from "./home/focus";
import type { NeedKind } from "./home/rules";
import { AppState, Platform, Pressable, StyleSheet, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "./api";
import { deviceClaim, type DeviceClaim } from "./device";
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
 * THE STATES, and the screens say which one in words. "Checking…" lasts at most twelve seconds:
 *   notInBuild  this APK was built without the hospital's Firebase project — nothing is asked;
 *   unreachable the server did not answer in time (no signal) — Check again;
 *   serverError the server answered, but not with this phone's state — Check again;
 *   notLinked   this session names no phone and could not be linked to this one — sign in again;
 *   serverOff   the server has no Firebase key yet — nothing is asked;
 *   off         could be on; the person has not turned it on (or turned it off);
 *   denied      the person refused the phone's own prompt — only the phone's settings can undo that;
 *   on          this phone has given the server its address.
 *
 * NOTHING IS ASKED UNINVITED. The phone's permission prompt opens only after the person taps
 * "Turn on" under a sentence that says what a notification will and will not contain.
 */
export const PUSH_CATEGORIES = ["alert", "roster", "queue", "reminder", "approvals", "personal"] as const;
/** The phone SAYS which categories it can draw (`?knows=`), so the server offers a switch only for those (app home round 2). */
const PUSH_ROUTE = `/auth/phone/notifications?knows=${PUSH_CATEGORIES.join(",")}`;
/** The server's `link` word → the phone screen it opens. An unknown word, or a screen this person may not open, is home. */
export const PUSH_LINK_SEAT: Record<string, Seat["key"] | null> = { home: null, onNow: "onNow", myDuties: "myDuties", consult: "consult" };
/** A link that lands on a CARD of the home screen rather than on a screen of its own. */
export const PUSH_LINK_CARD: Record<string, NeedKind> = { approvals: "approval" };
/** STAFF ATTENDANCE — a link that opens one of the attendance screens: the committee's requests list, or a person's own attendance. E1.2 — `reminders`: the person's own Reminders screen. */
export const PUSH_LINK_ROUTE: Record<string, "requests" | "mine" | "reminders"> = { attendanceRequests: "requests", attendance: "mine", reminders: "reminders" };

export type PushStatus = "unknown" | "notInBuild" | "unreachable" | "serverError" | "notLinked" | "serverOff" | "off" | "denied" | "on";
type ServerState = {
  configured: boolean; registered: boolean; muted: string[]; categories: string[];
  addressAt?: string | null; lastSentAt?: string | null; lastTestAt?: string | null;
};
/** Why the server's answer is missing. `checking` is the only one that is still in flight. */
type Reach = "checking" | "ok" | "unreachable" | "error" | "notLinked";

/**
 * WHAT THE OWNER READS OUT WHEN SOMETHING IS WRONG (2026-10-06: "the screen says Checking…" told
 * nobody which of six things had failed). Each line is one link of the chain, in order; the first
 * line that is not right is the fault.
 */
export type PushDiagnosis = {
  inBuild: boolean;
  server: Reach;
  linked: boolean | null;
  permission: PushPermission;
  /** Google gave this phone an address in this run of the app: yes / no / not asked yet. */
  address: "yes" | "no" | "notAsked";
  serverHasIt: boolean | null;
  serverCanSend: boolean | null;
  lastSentAt: string | null;
  lastTestAt: string | null;
  /** The last time a notification reached THIS app while it was open (kept on the phone). */
  lastReceivedAt: string | null;
};

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
  /** Ask everything again: the server, the phone's permission, and — if the person wants notifications — the address. */
  retry: () => Promise<void>;
  /** The person is about to open the phone's settings to allow notifications: on return, finish the job. */
  wantOn: () => void;
  diagnosis: PushDiagnosis;
  /** The home screen may offer to turn notifications on (never asked before, could be on). */
  offer: boolean;
  dismissOffer: () => void;
};

const Ctx = createContext<Notifications | null>(null);
const OFFER_KEY = "hmis.push.offer";
const WANTED_KEY = "hmis.push.wanted";
const RECEIVED_KEY = "hmis.push.received";
const kept = new Map<string, string>();

async function keep(key: string, value: string): Promise<void> {
  kept.set(key, value);
  if (Platform.OS === "web") return;
  try { await SecureStore.setItemAsync(key, value); } catch { /* lasts until the app is closed */ }
}
async function recall(key: string): Promise<string | null> {
  if (Platform.OS === "web") return kept.get(key) ?? null;
  try { return (await SecureStore.getItemAsync(key)) ?? kept.get(key) ?? null; } catch { return kept.get(key) ?? null; }
}

export function statusOf(inBuild: boolean, reach: Reach, server: ServerState | null, permission: PushPermission): PushStatus {
  if (!inBuild) return "notInBuild";
  if (reach === "checking") return "unknown";
  if (reach === "unreachable") return "unreachable";
  if (reach === "notLinked") return "notLinked";
  if (reach === "error" || server === null) return "serverError";
  if (!server.configured) return "serverOff";
  if (permission === "denied") return "denied";
  return server.registered && permission === "granted" ? "on" : "off";
}

const BANNER_MS = 8000;
/** "Checking…" may last this long and no longer: then the screen says what it could not reach. */
export const SERVER_TIMEOUT_MS = 12_000;

class Timeout extends Error {}
function inTime<T>(run: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout()), SERVER_TIMEOUT_MS);
    run.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error("failed")); });
  });
}

function onForeground(cb: () => void): () => void {
  const sub = AppState.addEventListener("change", (s) => { if (s === "active") cb(); });
  return () => sub.remove();
}

export function NotificationsProvider({ children, phone: injected, foreground = onForeground, claim = deviceClaim }: {
  children: ReactNode; phone?: PushPhone;
  /** Tests: stand in for "the app came back to the front". */
  foreground?: (cb: () => void) => () => void;
  claim?: () => Promise<DeviceClaim | null>;
}) {
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
  const [reach, setReach] = useState<Reach>("checking");
  const [permission, setPermission] = useState<PushPermission>("undetermined");
  const [address, setAddress] = useState<"yes" | "no" | "notAsked">("notAsked");
  const [received, setReceived] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [banner, setBanner] = useState<PushNote | null>(null);
  const openedOnce = useRef(false);
  const wanted = useRef(false);
  const running = useRef(false);

  const labels = useMemo(() => Object.fromEntries(PUSH_CATEGORIES.map((c) => [c, t(`mobile.push.category.${c}`)])), [t]);

  /**
   * What the server knows about this phone. A session opened by a build that did not yet name its
   * phone answers `not_a_phone`: the app then LINKS the phone to the session it already holds
   * (`POST /auth/phone/link`) and asks again — the person is not signed out for our omission.
   */
  const ask = useCallback(async (): Promise<{ reach: Reach; server: ServerState | null; problem?: string }> => {
    const read = () => inTime(call<ServerState>("GET", PUSH_ROUTE));
    try {
      return { reach: "ok", server: await read() };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "not_a_phone") {
        const device = await claim();
        if (device === null) return { reach: "notLinked", server: null };
        try {
          await inTime(call("POST", "/auth/phone/link", { device }));
          return { reach: "ok", server: await read() };
        } catch (e2) {
          if (e2 instanceof ApiError && e2.code === "phone_limit_reached") return { reach: "notLinked", server: null, problem: "mobile.push.problem.phoneLimit" };
          if (e2 instanceof ApiError) return { reach: "notLinked", server: null };
          return { reach: "unreachable", server: null };
        }
      }
      if (e instanceof ApiError) return { reach: "error", server: null };
      return { reach: "unreachable", server: null };
    }
  }, [call, claim]);

  /** Google's address for this phone, handed to the server. Says exactly which half failed. */
  const register = useCallback(async (): Promise<ServerState | "noAddress" | "notSaved"> => {
    await phone.channels(labels);
    const token = await phone.token();
    if (token === null) { setAddress("no"); return "noAddress"; }
    setAddress("yes");
    try {
      return await inTime(call<ServerState>("PUT", PUSH_ROUTE, { token, language: lang }));
    } catch {
      return "notSaved";
    }
  }, [phone, labels, call, lang]);

  /**
   * THE WHOLE CHAIN, ASKED AGAIN: on sign-in, whenever the app comes back to the front (the person
   * may just have allowed notifications in the phone's settings), and on "Check again".
   * If notifications are already on for this phone, or the person asked for them (`wanted`), and the
   * phone now allows them, the address is fetched and handed over without another tap.
   */
  const refresh = useCallback(async (loud: boolean): Promise<void> => {
    if (!phone.inBuild || running.current) return;
    running.current = true;
    if (loud) { setBusy(true); setProblem(null); }
    try {
      const perm = await phone.permission();
      setPermission(perm);
      const answer = await ask();
      let seen = answer.server;
      if (answer.problem !== undefined) setProblem(answer.problem);
      if (seen !== null && seen.configured && perm === "granted" && (seen.registered || wanted.current)) {
        const done = await register();
        if (typeof done === "string") { if (loud || wanted.current) setProblem(`mobile.push.problem.${done}`); } else { seen = done; wanted.current = false; void keep(WANTED_KEY, "0"); setProblem(null); }
      }
      setServer(seen);
      setReach(answer.reach);
    } finally {
      running.current = false;
      if (loud) setBusy(false);
    }
  }, [phone, ask, register]);

  useEffect(() => {
    if (!signedIn) { setServer(null); setReach("checking"); return; }
    if (!phone.inBuild) return;
    let gone = false;
    void (async () => {
      const [offer, want, last] = await Promise.all([recall(OFFER_KEY), recall(WANTED_KEY), recall(RECEIVED_KEY)]);
      if (gone) return;
      setDismissed(offer !== null);
      wanted.current = want === "1";
      setReceived(last);
      await refresh(false);
    })();
    const off = foreground(() => { void refresh(false); });
    return () => { gone = true; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, phone]);

  const status = statusOf(phone.inBuild, reach, server, permission);

  // The app's language changed while notifications are on: the next sentence is said in it.
  useEffect(() => {
    if (status !== "on") return;
    void call<ServerState>("PUT", PUSH_ROUTE, { language: lang }).then(setServer, () => undefined);
    void phone.channels(labels);
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((link: string) => {
    const card = PUSH_LINK_CARD[link];
    if (card !== undefined) { focusHome(card); router.push("/"); return; }
    /* STAFF ATTENDANCE — the committee's requests list (for those who may open it), and a person's own attendance. */
    const att = PUSH_LINK_ROUTE[link];
    if (att === "requests") { if (permissions?.hospital.includes("attendance.all.read") === true) router.push({ pathname: "/attendance-staff", params: { tab: "requests" } }); else router.push("/"); return; }
    if (att === "mine") { router.push({ pathname: "/attendance", params: { request: "latest" } }); return; }
    if (att === "reminders") { router.push("/reminders"); return; }
    const seat = PUSH_LINK_SEAT[link] ?? null;
    const allowed = seat !== null && permissions !== null && seatsFor(permissions).some((s) => s.key === seat);
    if (allowed) router.push({ pathname: "/seat/[key]", params: { key: seat } });
    else router.push("/");
  }, [permissions, router]);

  useEffect(() => {
    if (!signedIn || !phone.inBuild) return;
    const offToken = phone.onToken((token) => {
      void call<ServerState>("PUT", PUSH_ROUTE, { token, language: lang }).then((s) => { setAddress("yes"); setServer(s); }, () => undefined);
    });
    const offReceived = phone.onReceived((note) => {
      const at = new Date().toISOString();
      setReceived(at); void keep(RECEIVED_KEY, at);
      setBanner(note);
    });
    const offOpened = phone.onOpened(open);
    if (!openedOnce.current) {
      openedOnce.current = true;
      void phone.openedWith().then((link) => { if (link !== null && link !== "") open(link); });
    }
    return () => { offToken(); offReceived(); offOpened(); };
  }, [signedIn, phone, call, lang, open]);

  useEffect(() => {
    if (banner === null) return;
    const timer = setTimeout(() => setBanner(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const wantOn = useCallback(() => { wanted.current = true; void keep(WANTED_KEY, "1"); }, []);

  /**
   * "Turn on". ORDER MATTERS ON ANDROID 13+: the notification channels are made FIRST — the system's
   * permission prompt does not appear for an app that has no channel — then the permission is
   * asked, then Google's address is fetched and handed to the server.
   */
  const enable = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    wantOn();
    try {
      await phone.channels(labels);
      let perm = await phone.permission();
      if (perm !== "granted") {
        const answered = await phone.ask();
        // Read it back: "denied" here may be a dismissed prompt (ask again later) or a real refusal.
        perm = answered === "granted" ? "granted" : await phone.permission();
      }
      setPermission(perm);
      if (perm !== "granted") { setProblem(perm === "denied" ? "mobile.push.problem.denied" : "mobile.push.problem.notAllowed"); return; }
      const answer = await ask();
      setReach(answer.reach);
      if (answer.server === null) { setServer(null); if (answer.problem !== undefined) setProblem(answer.problem); return; }
      if (!answer.server.configured) { setServer(answer.server); return; }
      const done = await register();
      if (typeof done === "string") { setServer(answer.server); setProblem(`mobile.push.problem.${done}`); return; }
      setServer(done);
      wanted.current = false; void keep(WANTED_KEY, "0");
    } finally {
      setBusy(false);
      setDismissed(true);
      void keep(OFFER_KEY, "1");
    }
  }, [phone, labels, ask, register, wantOn]);

  const disable = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    wanted.current = false; void keep(WANTED_KEY, "0");
    try {
      setServer(await inTime(call<ServerState>("DELETE", PUSH_ROUTE)));
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
      setServer(await inTime(call<ServerState>("PUT", PUSH_ROUTE, { muted: next })));
    } catch {
      setProblem("mobile.push.problem.notSaved");
    }
  }, [server, call]);

  const retry = useCallback(() => refresh(true), [refresh]);
  const dismissOffer = useCallback(() => { setDismissed(true); void keep(OFFER_KEY, "1"); }, []);

  const diagnosis = useMemo<PushDiagnosis>(() => ({
    inBuild: phone.inBuild, server: reach,
    linked: reach === "ok" ? true : reach === "notLinked" ? false : null,
    permission, address,
    serverHasIt: server === null ? null : server.registered,
    serverCanSend: server === null ? null : server.configured,
    lastSentAt: server?.lastSentAt ?? null, lastTestAt: server?.lastTestAt ?? null, lastReceivedAt: received,
  }), [phone, reach, permission, address, server, received]);

  const value = useMemo<Notifications>(() => ({
    status, categories: server?.categories ?? [], muted: server?.muted ?? [], busy, problem, enable, disable, setMuted, retry, wantOn, diagnosis,
    offer: signedIn && status === "off" && permission === "undetermined" && !dismissed, dismissOffer,
  }), [status, server, busy, problem, enable, disable, setMuted, retry, wantOn, diagnosis, signedIn, permission, dismissed, dismissOffer]);

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

const NO_DIAGNOSIS: PushDiagnosis = {
  inBuild: false, server: "checking", linked: null, permission: "undetermined", address: "notAsked",
  serverHasIt: null, serverCanSend: null, lastSentAt: null, lastTestAt: null, lastReceivedAt: null,
};
const INERT: Notifications = {
  status: "notInBuild", categories: [], muted: [], busy: false, problem: null,
  enable: () => Promise.resolve(), disable: () => Promise.resolve(), setMuted: () => Promise.resolve(),
  retry: () => Promise.resolve(), wantOn: () => undefined, diagnosis: NO_DIAGNOSIS, offer: false, dismissOffer: () => undefined,
};

/** A screen mounted without the provider (older tests, a preview) sees "not in this build" and offers nothing. */
export function useNotifications(): Notifications {
  return useContext(Ctx) ?? INERT;
}

/** Tests only: forget what was kept between runs (the offer, the wish, the last notification). */
export function _forgetOfferForTests(): void { kept.clear(); }

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
