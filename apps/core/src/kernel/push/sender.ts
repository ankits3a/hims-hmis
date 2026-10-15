import { statSync } from "node:fs";
import { fcmSender, loadServiceAccount } from "./fcm";
import type { FetchLike, PhonePushSender } from "./fcm";

/**
 * ═══ MOBILE M6b — DORMANT UNTIL THE KEY IS THERE, AND AWAKE WITHOUT A RESTART ═══
 *
 * Phone notifications need a Firebase service-account key that only the owner can make
 * (`apps/mobile/BUILDING.md`, "Notifications"). Until that file exists every hospital runs with
 * the sender OFF — which is a boot WARN and never a refusal (`describePhonePush`): a missing
 * optional key is a CONFIGURATION state, not a code defect, and refusing to boot over it would
 * take the hospital down for want of a buzz.
 *
 * `current()` looks at the file again at most once a minute. So the day the key is put in the
 * mounted folder, the api and the worker start sending within a minute — no deploy, no restart,
 * nobody touching a running container.
 */
const RECHECK_MS = 60_000;

export type PhonePushOff = "not_set" | "file_missing" | "file_invalid";
export type PhonePushSource = {
  /** The sender, or null while notifications are off. Cheap: re-reads the key only when the file changed. */
  current(): PhonePushSender | null;
  /** Why it is off, or null when it is on. */
  off(): PhonePushOff | null;
};

export function phonePushSource(path: string | null, fetchImpl?: FetchLike, now: () => number = Date.now): PhonePushSource {
  let checkedAt = -Infinity;
  let stamp: string | null = null;
  let sender: PhonePushSender | null = null;
  let reason: PhonePushOff | null = "not_set";

  function refresh(): void {
    if (now() - checkedAt < RECHECK_MS) return;
    checkedAt = now();
    if (path === null || path.trim() === "") { sender = null; reason = "not_set"; return; }
    let seen: string;
    try {
      const st = statSync(path);
      seen = `${String(st.mtimeMs)}:${String(st.size)}`;
    } catch {
      sender = null; reason = "file_missing"; stamp = null; return;
    }
    if (seen === stamp) return;
    stamp = seen;
    const loaded = loadServiceAccount(path);
    if (loaded.ok) { sender = fcmSender(loaded.account, fetchImpl); reason = null; } else { sender = null; reason = loaded.reason; }
  }

  return {
    current() { refresh(); return sender; },
    off() { refresh(); return reason; },
  };
}

const shared = new Map<string, PhonePushSource>();
/**
 * ONE source per path in a process: the api's two controllers (the phone's own routes, the
 * administrator's test) ask the same object, so they cannot disagree about whether the key is there.
 */
export function sharedPhonePushSource(path: string | null): PhonePushSource {
  const key = path ?? "";
  let source = shared.get(key);
  if (source === undefined) {
    source = phonePushSource(path);
    shared.set(key, source);
  }
  return source;
}

/** A fixed source for tests and for a caller that already holds a sender. */
export function fixedPhonePushSource(sender: PhonePushSender | null): PhonePushSource {
  return { current: () => sender, off: () => (sender === null ? "not_set" : null) };
}

/** The one line the worker prints at boot. Says what is off, why, and that nothing else is affected. */
export function describePhonePush(source: PhonePushSource, path: string | null): { level: "log" | "warn"; line: string } {
  const off = source.off();
  if (off === null) return { level: "log", line: "phone notifications: ON (Firebase key loaded)" };
  const why = off === "not_set"
    ? "HMIS_FCM_SERVICE_ACCOUNT_FILE is not set"
    : off === "file_missing"
      ? `no Firebase key at ${path ?? ""}`
      : `the file at ${path ?? ""} is not a Firebase service-account key`;
  return { level: "warn", line: `phone notifications: FCM not configured — ${why}. The app's bell still works; notifications start by themselves within a minute of the key appearing.` };
}
