import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { punchSchema } from "./client";

/**
 * THE WEBHOOK'S SIGNATURE, exactly as bioattend's guide states it ("Verifying the signature"):
 *
 *     "sha256=" + hex( HMAC-SHA256( secret AS TEXT, <X-Bioattend-Timestamp> + "." + <raw body> ) )
 *
 * The secret is used as its ASCII characters (NOT hex-decoded — the Aadhaar key is the opposite), the
 * comparison is constant-time, the timestamp must be digits within five minutes of our clock, and
 * the bytes checked are the RAW bytes received: re-serialised JSON would not match.
 */
export const WEBHOOK_MAX_AGE_SECONDS = 300;
export const WEBHOOK_MAX_PUNCHES = 100;

export function bioattendSignature(secret: string, timestamp: string, raw: Buffer): string {
  return `sha256=${createHmac("sha256", Buffer.from(secret, "ascii")).update(`${timestamp}.`).update(raw).digest("hex")}`;
}

export type WebhookVerdict = "ok" | "bad_signature" | "stale";

export function verifyBioattendWebhook(input: {
  secret: string; timestamp: string | undefined; signature: string | undefined; raw: Buffer; nowMs: number;
  /** The guide's test vector carries a fixed timestamp: "Skip the 5-minute age check while testing with it." Tests only. */
  skipAgeCheck?: boolean;
}): WebhookVerdict {
  const ts = input.timestamp ?? "";
  const got = Buffer.from(input.signature ?? "", "utf8");
  const want = Buffer.from(bioattendSignature(input.secret, ts, input.raw), "utf8");
  // Both checks always run, so a wrong signature and a stale one cost the same time.
  const signed = got.length === want.length && timingSafeEqual(got, want);
  const fresh = /^\d{1,12}$/.test(ts) && Math.abs(input.nowMs / 1000 - Number(ts)) <= WEBHOOK_MAX_AGE_SECONDS;
  if (!signed) return "bad_signature";
  if (!fresh && input.skipAgeCheck !== true) return "stale";
  return "ok";
}

/** Parsed only AFTER the signature holds. An `event` this version does not know is acknowledged and ignored. */
export const webhookBody = z.object({
  event: z.string(),
  punches: z.array(punchSchema).max(WEBHOOK_MAX_PUNCHES).optional(),
});
