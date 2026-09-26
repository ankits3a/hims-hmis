/**
 * ABDM S0 — keeping credentials out of the message log and out of every thrown message.
 *
 * Two mechanisms, and both are needed:
 *
 *   · STRUCTURAL — the things we know are credentials are never handed to a writer: the session
 *     request/response bodies are stored as markers, and `loggableHeaders` redacts `Authorization`
 *     and every `*token*` header before a row is built.
 *   · BELT AND BRACES — `Scrubber` replaces any occurrence of a known secret (the client secret, the
 *     current access token) in text we did NOT build: a gateway error body, a transport error
 *     message. A careless gateway that echoes the secret back must not get it into our table.
 */
export const REDACTED = "[redacted]";

export const SESSION_REQUEST_MARKER = { redacted: "session request — carries the client secret; never stored" } as const;
export const SESSION_RESPONSE_MARKER = "session response — carries the access token; never stored";

const TOKEN_HEADER = /token/i;

export function loggableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") out[k] = v.startsWith("Bearer ") ? `Bearer ${REDACTED}` : REDACTED;
    else if (TOKEN_HEADER.test(k)) out[k] = REDACTED;
    else out[k] = v;
  }
  return out;
}

/**
 * ABDM S1 — ANYTHING SHAPED LIKE AN AADHAAR NUMBER: twelve digits, optionally grouped 4-4-4 by a
 * space or a dash, not part of a longer run of digits, letters or dashes (so a dashed ABHA number
 * `91-2345-6789-0123`, a UUID's groups and a 13-digit epoch are left alone).
 *
 * Why a SHAPE and not only the number: at the enrolment's second step the client no longer knows the
 * Aadhaar number (it is kept nowhere, by design), so an ABDM error that echoes it back cannot be
 * scrubbed by value. Over-redacting a twelve-digit number that was not an Aadhaar is the safe side.
 */
export const AADHAAR_SHAPE = /(?<![\w-])\d{4}([ -]?)\d{4}\1\d{4}(?![\w-])/g;

export function scrubAadhaarShapes(s: string): string {
  return s.replace(AADHAAR_SHAPE, REDACTED);
}

export class Scrubber {
  private readonly secrets: () => readonly string[];

  constructor(secrets: () => readonly (string | null | undefined)[], private readonly aadhaarShapes = false) {
    this.secrets = () => secrets().filter((s): s is string => typeof s === "string" && s.length >= 4);
  }

  text(s: string): string {
    let out = s;
    for (const secret of this.secrets()) {
      out = out.split(secret).join(REDACTED);
      // The JSON-escaped spelling too, so a secret with a quote or backslash in it cannot survive a
      // round trip through JSON.stringify in a stored body.
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join(REDACTED);
    }
    return this.aadhaarShapes ? scrubAadhaarShapes(out) : out;
  }

  /**
   * ABDM S1 — STRUCTURAL, not a text replace over `JSON.stringify(v)`. S0's secrets were never pure
   * digits; S1's are (a 6-digit OTP, a 12-digit Aadhaar number), and a digit-string replaced inside a
   * JSON NUMBER literal (`"expiresIn":1234567`) leaves text that no longer parses. So every string
   * (key or value) is scrubbed as text, and a number whose digits contain a secret becomes the
   * redaction marker — over-redacting an unrelated number is the safe direction.
   */
  json(v: unknown): unknown {
    if (v === undefined || v === null) return v ?? null;
    return this.walk(JSON.parse(JSON.stringify(v)) as unknown);
  }

  /**
   * A scrubber that also removes `extra` — the per-call plaintexts (an Aadhaar number, an OTP) — and,
   * with `aadhaarShapes`, anything shaped like an Aadhaar number (every ABHA-service call).
   */
  with(extra: readonly (string | null | undefined)[], aadhaarShapes = this.aadhaarShapes): Scrubber {
    const base = this.secrets;
    return new Scrubber(() => [...base(), ...extra], aadhaarShapes);
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.text(v);
    if (typeof v === "number") {
      const digits = String(v);
      return this.text(digits) === digits ? v : REDACTED;
    }
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[this.text(k)] = this.walk(x);
      return out;
    }
    return v;
  }
}

/**
 * ═══ ABDM S1 — FIELDS THAT ARE NEVER STORED, WHATEVER THEIR VALUE ═══
 *
 * The M1 bodies carry things the log must not keep, and they are known BY NAME:
 *
 *   · `loginId`, `otpValue`, `aadhaar`, `aadhaarNumber`, `password` — RSA ciphertext of an Aadhaar
 *     number, an OTP or a mobile (M1 encrypts them all). Ciphertext is not plaintext, but it is the
 *     Aadhaar number to whoever holds ABDM's key, and the law's line is "not stored" — so it is not.
 *   · `token`, `refreshToken`, `accessToken`, `xToken`, `tToken` — the PATIENT's ABHA session: a
 *     bearer credential to their national health account. Kept in memory for minutes
 *     (`abha-transactions.ts`), never in a row.
 *
 * `redactKeys` replaces each such value with the marker, at any depth, before a row is built; the
 * `Scrubber` then removes the per-call PLAINTEXTS from whatever is left (an ABDM error that echoes
 * the Aadhaar number back is the case it exists for). Two mechanisms, as in S0: structural first,
 * belt and braces second.
 *
 * `OMIT_KEYS` are not secrets but photographs: ABDM returns the patient's face as base64 in a
 * profile. It is PHI that is shown once and never needed from the log, so the log keeps its size.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "loginId", "otpValue", "aadhaar", "aadhaarNumber", "password",
  "token", "refreshToken", "accessToken", "xToken", "tToken",
]);
export const OMIT_KEYS: ReadonlySet<string> = new Set(["profilePhoto", "photo", "kycPhoto"]);

export function redactKeys(v: unknown, secretKeys: ReadonlySet<string> = SECRET_KEYS, omitKeys: ReadonlySet<string> = OMIT_KEYS): unknown {
  if (Array.isArray(v)) return v.map((x) => redactKeys(x, secretKeys, omitKeys));
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (secretKeys.has(k) && x !== null && x !== undefined && x !== "") out[k] = REDACTED;
    else if (omitKeys.has(k) && typeof x === "string" && x !== "") out[k] = `[omitted: ${x.length} chars]`;
    else out[k] = redactKeys(x, secretKeys, omitKeys);
  }
  return out;
}

/**
 * ═══ ABDM S2 — WHAT AN INBOUND CALLBACK CARRIES THAT THE LOG MUST NOT KEEP ═══
 *
 * S0 stores every callback body as ABDM sent it. From S2 two callbacks carry credentials:
 *   · `link/care-context/confirm` — `confirmation.token` is the OTP the patient typed;
 *   · `hip/token/on-generate-token` — `linkToken` is the X-LINK-TOKEN for that ABHA address, a
 *     six-month bearer credential (stored only sealed, `abdm_link_tokens`).
 * The route stores `redactKeys(body, INBOUND_SECRET_KEYS)` and hands the handler the body as sent.
 */
export const INBOUND_SECRET_KEYS: ReadonlySet<string> = new Set([...SECRET_KEYS, "linkToken"]);
