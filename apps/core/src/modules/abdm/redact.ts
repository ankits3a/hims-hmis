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

export class Scrubber {
  private readonly secrets: () => readonly string[];

  constructor(secrets: () => readonly (string | null | undefined)[]) {
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
    return out;
  }

  json(v: unknown): unknown {
    if (v === undefined || v === null) return v ?? null;
    return JSON.parse(this.text(JSON.stringify(v))) as unknown;
  }
}
