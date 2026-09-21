import { api } from "./api";

/**
 * ═══ PHASE O T4 — THE BROWSER HALF OF WEB PUSH ═══
 *
 * Three facts this module exists to keep straight, because each of them looks like the others
 * and means something different:
 *
 *   SUPPORTED    the browser has the APIs at all. iOS Safari has them only once the app is
 *                installed to the home screen, so "unsupported" is a normal state on a phone
 *                somebody is holding right now, not a broken browser.
 *   PERMISSION   `default` (never asked), `granted`, or `denied`. `denied` is STICKY: the
 *                browser will not re-prompt, and the only cure is the site settings panel. A
 *                page that re-asks on every visit teaches people to deny permanently.
 *   SUBSCRIBED   permission granted AND a subscription registered with our server. Permission
 *                without a subscription reaches nobody, which is the state a page must be able
 *                to tell apart from the other two.
 */
export type PushSupport = "unsupported" | "default" | "granted" | "denied";

export function pushSupport(): PushSupport {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  if (typeof window === "undefined" || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission as "default" | "granted" | "denied";
}

/** The VAPID public key, base64url as the server stores it, converted to the bytes the API wants. */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  // The buffer, not the view: `applicationServerKey` is typed `BufferSource`, and handing it a
  // `Uint8Array` whose backing buffer could be a `SharedArrayBuffer` does not satisfy it.
  return out.buffer;
}

function keyOf(sub: PushSubscription, name: "p256dh" | "auth"): string {
  const key = sub.getKey(name);
  if (key === null) throw new Error(`push subscription is missing its ${name} key`);
  return btoa(String.fromCharCode(...new Uint8Array(key)));
}

export type ReachSettingsWire = {
  language: "en" | "hi";
  ladder: ("web_push" | "whatsapp" | "sms")[];
  quietExempt: boolean;
  sharedPhone: boolean;
  consentAt: string | null;
  isOwnProfile: boolean;
  pushSubscriptions: { id: string; endpoint: string; userAgent: string | null; createdAt: string }[];
  vapidPublicKey: string | null;
};

export function readReachSettings(): Promise<ReachSettingsWire> {
  return api("GET", "/me/reach");
}

export function saveReachSettings(
  input: { language?: "en" | "hi"; ladder?: ("web_push" | "whatsapp" | "sms")[] },
  idempotencyKey: string,
): Promise<ReachSettingsWire> {
  return api("POST", "/me/reach", input, idempotencyKey);
}

/**
 * Registers the worker, asks for permission if it has never been asked, subscribes, and tells
 * the server. Returns the endpoint so a caller can show WHICH browser this is.
 *
 * THE PROMPT IS ASKED ONCE AND ONLY FROM A CLICK. Browsers refuse a permission prompt that did
 * not come from a gesture, and one that is refused is refused for ever — so this is called from
 * a button and never on mount.
 */
export async function subscribeToPush(vapidPublicKey: string, idempotencyKey: string): Promise<string> {
  if (pushSupport() === "unsupported") throw new Error("push_unsupported");

  const registration = await navigator.serviceWorker.register("/sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("push_denied");

  const existing = await registration.pushManager.getSubscription();
  const sub = existing ?? await registration.pushManager.subscribe({
    // Chrome requires it, and it is the honest setting anyway: every push this hospital sends
    // is something a human is being asked to do, so a silent one would be a lie.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  await api("POST", "/me/reach/push", {
    endpoint: sub.endpoint,
    p256dh: keyOf(sub, "p256dh"),
    auth: keyOf(sub, "auth"),
    userAgent: navigator.userAgent.slice(0, 500),
  }, idempotencyKey);
  return sub.endpoint;
}

/**
 * Turns push off in THIS browser: the server row is revoked first, then the browser
 * subscription is dropped. That order matters — dropping the browser's first and then failing
 * to reach the server would leave a row the pump keeps pushing to an endpoint that is gone,
 * which is a 410 on every send for ever.
 */
export async function unsubscribeFromPush(idempotencyKey: string): Promise<boolean> {
  if (pushSupport() === "unsupported") return false;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await registration?.pushManager.getSubscription();
  if (sub == null) return false;

  await api("POST", "/me/reach/push/revoke", { endpoint: sub.endpoint }, idempotencyKey);
  return sub.unsubscribe();
}
