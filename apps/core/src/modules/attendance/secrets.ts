import { readFileSync, statSync } from "node:fs";

/**
 * THE THREE BIOATTEND SECRETS, EACH A FILE (the OpenAI key's shape, `kernel/inference/openai-speech.ts`):
 * read on use, re-read when the file changes — a secret that arrives or is rotated needs no restart —
 * and cached for thirty seconds so a request does not stat the disk. Absent, unreadable or
 * ill-shaped answers null, which is "not configured", never an error at boot.
 *
 * NOTHING HERE LOGS, AND NOTHING RETURNS A SECRET TO A ROUTE. Callers ask "is it there" with
 * `!== null` and hand the value straight to the HMAC or the header it is for.
 */
export type SecretKind = "api_key" | "webhook_secret" | "aadhaar_key";

const SHAPES: Record<SecretKind, RegExp> = {
  // `bio_` + 64 hex per the guide; the pattern admits a longer or re-prefixed key a later version may issue.
  api_key: /^[A-Za-z0-9_\-]{16,200}$/,
  // "its 64 characters as ASCII bytes" — used as text, never hex-decoded.
  webhook_secret: /^[\x21-\x7e]{16,200}$/,
  // 64 hex characters, hex-decoded to 32 bytes by `aadhaar.ts`.
  aadhaar_key: /^[0-9a-fA-F]{64}$/,
};

const CACHE_MS = 30_000;
const cache = new Map<string, { mtimeMs: number; value: string | null; checkedAt: number }>();

export function secretFromFile(path: string | null, kind: SecretKind, now: number = Date.now()): string | null {
  if (path === null) return null;
  const slot = `${kind}:${path}`;
  const had = cache.get(slot);
  if (had !== undefined && now - had.checkedAt < CACHE_MS) return had.value;
  let value: string | null = null;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
    if (had !== undefined && had.mtimeMs === mtimeMs) {
      cache.set(slot, { ...had, checkedAt: now });
      return had.value;
    }
    const raw = readFileSync(path, "utf8").trim();
    value = SHAPES[kind].test(raw) ? raw : null;
  } catch {
    value = null;
  }
  cache.set(slot, { mtimeMs, value, checkedAt: now });
  return value;
}

/** Tests only. */
export function forgetAttendanceSecrets(): void { cache.clear(); }

/** The part of `AppConfig` this module reads. Paths, never contents. */
export type AttendanceConfig = {
  baseUrl: string;
  syncEnabled: boolean;
  /** `ATTENDANCE_SELF_SHOWS_TIMES` — whether a person's OWN attendance carries times and punches. Default false. */
  selfShowsTimes: boolean;
  apiKeyFile: string | null;
  webhookSecretFile: string | null;
  aadhaarKeyFile: string | null;
};

export const apiKeyOf = (cfg: AttendanceConfig, now?: number): string | null => secretFromFile(cfg.apiKeyFile, "api_key", now);
export const webhookSecretOf = (cfg: AttendanceConfig, now?: number): string | null => secretFromFile(cfg.webhookSecretFile, "webhook_secret", now);
export const aadhaarKeyOf = (cfg: AttendanceConfig, now?: number): string | null => secretFromFile(cfg.aadhaarKeyFile, "aadhaar_key", now);

/** The one line each process says at boot. It names what is missing and never what is present. */
export function describeAttendance(cfg: AttendanceConfig): string {
  if (apiKeyOf(cfg) === null) return "attendance: not configured";
  if (!cfg.syncEnabled) return "attendance: configured, sync switched off (ATTENDANCE_SYNC_ENABLED)";
  return "attendance: configured, sync on";
}
