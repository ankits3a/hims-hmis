import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * ═══ MOBILE M6b — THE ONE PLACE THAT TALKS TO FIREBASE CLOUD MESSAGING (HTTP v1) ═══
 *
 * Owner, 2026-10-06: notifications for the staff app go through FCM, and what a notification says
 * carries NO patient text. This file knows how to turn a service-account key into a short-lived
 * access token and how to hand ONE message to ONE phone. What the message says is decided in
 * `phone-push.ts`, by a function that has no patient to read from.
 *
 * NO SDK. `firebase-admin` is 40 MB of dependencies for two HTTPS calls: a signed JWT exchanged at
 * Google's token endpoint, and a POST per message.
 *
 * WHAT IS NEVER LOGGED OR THROWN: the phone's registration token, the access token, the private
 * key. An error names the HTTP status and FCM's error code, nothing else.
 */

export type FcmServiceAccount = { projectId: string; clientEmail: string; privateKey: string };

/** What a phone is told. `data` is two closed-vocabulary words; the sentences are generic (`phone-push.ts`). */
export type PhoneMessage = { title: string; body: string; data: { category: string; link: string } };

/**
 * `sent` — FCM accepted the message for that phone. `gone` — FCM says the address is dead (the app
 * was removed, the token rotated, or it belongs to another Firebase project): the caller forgets
 * the token. Anything else THROWS, and the caller's retry decides.
 */
export type PhonePushSender = { send(token: string, message: PhoneMessage): Promise<"sent" | "gone"> };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_LIFE_SECONDS = 3600;
/** Ask for a new access token this long before the old one dies. */
const TOKEN_SLACK_MS = 5 * 60 * 1000;

/**
 * The service-account JSON the Firebase console hands out, read from the path in
 * `HMIS_FCM_SERVICE_ACCOUNT_FILE`. Returns the three fields the sender needs, or a REASON the
 * sender is off — a missing path, a missing file and a file that is not a service-account key are
 * three different sentences for whoever reads the boot log, and none of them stops a boot
 * (`describePhonePush`): a hospital with no Firebase project is every hospital until the owner
 * makes one.
 */
export function loadServiceAccount(path: string | null):
  | { ok: true; account: FcmServiceAccount }
  | { ok: false; reason: "not_set" | "file_missing" | "file_invalid" } {
  if (path === null || path.trim() === "") return { ok: false, reason: "not_set" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "file_missing" };
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const projectId = j.project_id, clientEmail = j.client_email, privateKey = j.private_key;
    if (j.type !== "service_account" || typeof projectId !== "string" || typeof clientEmail !== "string" || typeof privateKey !== "string") {
      return { ok: false, reason: "file_invalid" };
    }
    if (!/^[a-z0-9-]{4,40}$/.test(projectId) || !privateKey.includes("PRIVATE KEY")) return { ok: false, reason: "file_invalid" };
    return { ok: true, account: { projectId, clientEmail, privateKey } };
  } catch {
    return { ok: false, reason: "file_invalid" };
  }
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** The RS256 assertion Google's token endpoint exchanges for an access token. */
export function signedAssertion(account: FcmServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFE_SECONDS }));
  const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(account.privateKey);
  return `${head}.${claims}.${b64url(signature)}`;
}

/** FCM's own word for what went wrong, read out of its error body. Never the request. */
function fcmErrorCode(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { status?: string; details?: { errorCode?: string }[] } };
    const detail = j.error?.details?.find((d) => typeof d.errorCode === "string")?.errorCode;
    return detail ?? j.error?.status ?? "UNKNOWN";
  } catch {
    return "UNREADABLE";
  }
}

/** The address itself is the problem — forget it. Everything else is ours or Google's to retry. */
const GONE_CODES: readonly string[] = ["UNREGISTERED", "SENDER_ID_MISMATCH"];

export function fcmSender(account: FcmServiceAccount, fetchImpl: FetchLike = fetch as unknown as FetchLike, now: () => number = Date.now): PhonePushSender {
  let cached: { token: string; expiresAtMs: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached !== null && cached.expiresAtMs - TOKEN_SLACK_MS > now()) return cached.token;
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${signedAssertion(account, now())}`,
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`fcm: the token endpoint answered ${String(res.status)}`);
    const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (typeof j.access_token !== "string") throw new Error("fcm: the token endpoint answered without an access token");
    cached = { token: j.access_token, expiresAtMs: now() + (typeof j.expires_in === "number" ? j.expires_in : TOKEN_LIFE_SECONDS) * 1000 };
    return cached.token;
  }

  return {
    async send(token, message) {
      const bearer = await accessToken();
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: "HIGH", notification: { channel_id: message.data.category } },
          },
        }),
      });
      if (res.status === 200) return "sent";
      const code = fcmErrorCode(await res.text());
      if (res.status === 404 || GONE_CODES.includes(code)) return "gone";
      // A 401 means the cached access token died early: drop it so the retry mints another.
      if (res.status === 401) cached = null;
      throw new Error(`fcm: send refused with ${String(res.status)} ${code}`);
    },
  };
}
