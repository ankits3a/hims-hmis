import { createHmac } from "node:crypto";

/**
 * THE AADHAAR LINKING HASH — bioattend's formula, implemented to the letter of its guide
 * (2026-10-09, "Aadhaar linking") and pinned by the guide's own test vector:
 *
 *     hex( HMAC-SHA256( hexdecode(K), "crk-aadhaar-v1:" + d ) )
 *
 * `K` is the linking key — 64 hex characters, HEX-DECODED to 32 bytes (the webhook secret is the
 * opposite: used as text). `d` is the twelve digits after removing spaces and hyphens. A number that
 * is not twelve digits, starts with 0 or 1, or fails the Verhoeff check has NO hash: bioattend sends
 * null for it, so an invalid number on either side simply never matches.
 *
 * The number passes through these functions and is returned by none of them except `normalise`,
 * whose caller keeps only the last four digits.
 */
const PREFIX = "crk-aadhaar-v1:";

const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when the last digit of `digits` is its Verhoeff check digit. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const n = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]![P[i % 8]![n]!]!;
  }
  return c === 0;
}

export type AadhaarProblem = "not_twelve_digits" | "bad_first_digit" | "bad_check_digit";

/** Spaces and hyphens out; then twelve digits, first 2–9, Verhoeff. The digits, or which rule failed. */
export function normaliseAadhaar(raw: string): { ok: true; digits: string } | { ok: false; problem: AadhaarProblem } {
  const d = raw.replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(d)) return { ok: false, problem: "not_twelve_digits" };
  if (!/^[2-9]/.test(d)) return { ok: false, problem: "bad_first_digit" };
  if (!verhoeffValid(d)) return { ok: false, problem: "bad_check_digit" };
  return { ok: true, digits: d };
}

/** The linking key as bytes, or null when it is not 64 hex characters. */
export function aadhaarKeyBytes(keyHex: string): Buffer | null {
  return /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, "hex") : null;
}

/** The hash for a number, or null when the number is not a valid Aadhaar or the key is not a key. */
export function aadhaarHash(raw: string, keyHex: string): string | null {
  const n = normaliseAadhaar(raw);
  const key = aadhaarKeyBytes(keyHex);
  if (!n.ok || key === null) return null;
  return createHmac("sha256", key).update(PREFIX + n.digits).digest("hex");
}

/** `XXXX XXXX 0124` — what a screen shows once the number is set. */
export function maskedAadhaar(last4: string): string {
  return `XXXX XXXX ${last4}`;
}
