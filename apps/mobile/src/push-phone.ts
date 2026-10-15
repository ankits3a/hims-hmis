import { Platform } from "react-native";
import { PUSH_IN_BUILD } from "./config";

/**
 * ═══ M6b — WHAT THE PHONE ITSELF DOES FOR A NOTIFICATION ═══
 *
 * The thin edge onto `expo-notifications` (Firebase Cloud Messaging underneath). Everything a
 * screen needs is behind this one object so tests hand in a fake and the web export — which has no
 * notifications — gets "not in this build" instead of a crash.
 *
 * `inBuild` is decided when the APK is BUILT: Firebase's `google-services.json` was there or it was
 * not (`scripts/build-apk.sh`). A build without it carries the notification code and no Firebase
 * project, and `token()` would fail on it — so nothing is asked of the person at all.
 *
 * The module is required lazily and every call is guarded: a phone on which the native module
 * misbehaves must still open the vitals bay.
 */
export type PushPermission = "granted" | "denied" | "undetermined";
/** What a notification carries — two closed words (kernel/push/phone-push.ts). Never a patient. */
export type PushNote = { category: string; link: string; title: string; body: string };

export type PushPhone = {
  inBuild: boolean;
  permission(): Promise<PushPermission>;
  /** The system's own prompt (Android 13+). Asked only after the person tapped "Turn on". */
  ask(): Promise<PushPermission>;
  /** This phone's FCM address, or null when Firebase would not give one. */
  token(): Promise<string | null>;
  /** One Android channel per category, so the person can silence one kind in the phone's own settings too. */
  channels(labels: Record<string, string>): Promise<void>;
  onToken(cb: (token: string) => void): () => void;
  /** A notification arrived while the app is OPEN: shown as a banner inside the app, not in the tray. */
  onReceived(cb: (note: PushNote) => void): () => void;
  /** The person tapped a notification in the tray. */
  onOpened(cb: (link: string) => void): () => void;
  /** The tap that STARTED the app, if a tap did. */
  openedWith(): Promise<string | null>;
};

type Content = { title?: string | null; body?: string | null; data?: Record<string, unknown> | null };
type Notif = { request: { content: Content; trigger?: { remoteMessage?: { data?: Record<string, unknown> | null; notification?: { title?: string | null; body?: string | null } | null } | null } | null } };
type Sub = { remove(): void };
type Answer = { status: string; granted?: boolean; canAskAgain?: boolean };
type Module = {
  getPermissionsAsync(): Promise<Answer>;
  requestPermissionsAsync(): Promise<Answer>;
  getDevicePushTokenAsync(): Promise<{ data: unknown }>;
  setNotificationChannelAsync(id: string, c: { name: string; importance: number }): Promise<unknown>;
  setNotificationHandler(h: { handleNotification: () => Promise<Record<string, boolean>> }): void;
  addPushTokenListener(cb: (t: { data: unknown }) => void): Sub;
  addNotificationReceivedListener(cb: (n: Notif) => void): Sub;
  addNotificationResponseReceivedListener(cb: (r: { notification: Notif }) => void): Sub;
  getLastNotificationResponseAsync(): Promise<{ notification: Notif } | null>;
  AndroidImportance: { HIGH: number; DEFAULT: number };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A tray notification's two words live in `content.data` when the app was open and in the FCM message when it was not. */
export function noteOf(n: Notif): PushNote {
  const data = { ...(n.request.trigger?.remoteMessage?.data ?? {}), ...(n.request.content.data ?? {}) };
  const sent = n.request.trigger?.remoteMessage?.notification;
  return {
    category: str(data.category), link: str(data.link),
    title: str(n.request.content.title) || str(sent?.title), body: str(n.request.content.body) || str(sent?.body),
  };
}

const OFF: PushPhone = {
  inBuild: false,
  permission: () => Promise.resolve("undetermined"),
  ask: () => Promise.resolve("denied"),
  token: () => Promise.resolve(null),
  channels: () => Promise.resolve(),
  onToken: () => () => undefined,
  onReceived: () => () => undefined,
  onOpened: () => () => undefined,
  openedWith: () => Promise.resolve(null),
};

function load(): Module | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications") as Module;
  } catch {
    return null;
  }
}

/**
 * ANDROID 13+ SAYS "denied" BEFORE IT HAS EVER ASKED (the owner's phone, 2026-10-06: the app went
 * straight to "blocked in settings" and never showed the system prompt). A fresh install reports
 * `status: "denied", canAskAgain: true` — which means "not asked yet", not "refused". Only
 * `canAskAgain: false` is a refusal that the phone's settings alone can undo.
 */
export function permissionOf(a: Answer): PushPermission {
  if (a.granted === true || a.status === "granted") return "granted";
  if (a.status === "denied" && a.canAskAgain === false) return "denied";
  return "undetermined";
}

/** A call into Google that never answers must not leave a screen waiting for ever. */
export const TOKEN_TIMEOUT_MS = 15_000;
function within<T>(ms: number, run: Promise<T>, otherwise: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(otherwise), ms);
    run.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(otherwise); });
  });
}

export function devicePush(): PushPhone {
  // iPhone (owner 2026-10-08): dormant in this version WHATEVER the build flag says — the server sends through
  // Firebase only and the iPhone build carries no push entitlement (app.config.ts, `withoutApplePush`).
  if (Platform.OS !== "android" || !PUSH_IN_BUILD) return OFF;
  const N = load();
  if (N === null) return OFF;
  // While the app is open the tray stays quiet: the app shows its own banner (`onReceived`).
  try {
    N.setNotificationHandler({
      handleNotification: () => Promise.resolve({ shouldShowAlert: false, shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
    });
  } catch { /* the banner still shows; the tray may too */ }
  const safely = <T,>(run: () => Promise<T>, otherwise: T): Promise<T> => run().catch(() => otherwise);
  const listen = (add: () => Sub): (() => void) => {
    try {
      const sub = add();
      return () => { try { sub.remove(); } catch { /* already gone */ } };
    } catch {
      return () => undefined;
    }
  };
  return {
    inBuild: true,
    permission: () => safely(async () => permissionOf(await N.getPermissionsAsync()), "undetermined"),
    // After the system prompt an unanswered or refused request is a refusal for now; the screen
    // re-reads the permission whenever the app comes back to the front.
    ask: () => safely(async () => { const a = await N.requestPermissionsAsync(); return a.granted === true || a.status === "granted" ? "granted" : "denied"; }, "denied"),
    token: () => within(TOKEN_TIMEOUT_MS, (async () => { const t = (await N.getDevicePushTokenAsync()).data; return typeof t === "string" && t !== "" ? t : null; })(), null),
    channels: (labels) => safely(async () => {
      for (const [id, name] of Object.entries(labels)) await N.setNotificationChannelAsync(id, { name, importance: N.AndroidImportance.HIGH });
    }, undefined),
    onToken: (cb) => listen(() => N.addPushTokenListener((t) => { if (typeof t.data === "string" && t.data !== "") cb(t.data); })),
    onReceived: (cb) => listen(() => N.addNotificationReceivedListener((n) => cb(noteOf(n)))),
    onOpened: (cb) => listen(() => N.addNotificationResponseReceivedListener((r) => cb(noteOf(r.notification).link))),
    openedWith: () => safely(async () => { const r = await N.getLastNotificationResponseAsync(); return r === null ? null : noteOf(r.notification).link; }, null),
  };
}
