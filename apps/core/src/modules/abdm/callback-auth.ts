import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { AbdmGatewayClient } from "./gateway-client";
import type { AbdmSettings } from "./settings";

/**
 * ═══ ABDM S0 — IS THIS CALLBACK REALLY FROM ABDM? ═══
 *
 * ABDM puts an RS256 JWT in every callback's `Authorization: Bearer …` and publishes its signing keys
 * as a JWKS at `GET {gateway}/gateway/v3/certs` (spec summary §1; the path is corroborated by the
 * open-source Care connector's `authentication.py`, not only by `nha-in/docs`). This verifies that
 * token with `node:crypto` alone — no JWT library, no new dependency — and it is deliberately
 * NARROW, because every branch of a JWT verifier that accepts something is an attack surface:
 *
 *   · `alg` must be EXACTLY `RS256`. `none` is the classic bypass; `HS256` keyed with the public
 *     key (which anybody can fetch) is the classic confusion attack. Both are refused on the header,
 *     before any key is fetched or any signature computed.
 *   · `exp` is REQUIRED (a callback token with no expiry is replayable for ever) and checked with a
 *     small skew; `nbf`, when present, likewise.
 *   · `aud` must contain the configured audience. `account` is what the Care connector checks —
 *     UNVERIFIED against NHA, hence configurable (`ABDM_JWT_AUDIENCE`).
 *   · The signature is checked against the gateway's key for the token's `kid`.
 *
 * THE KEY CACHE. Keys are cached 24 h by `kid` (the Care connector's TTL: "ABDM rotates its signing
 * key rarely"). An UNKNOWN kid, or a signature that fails against the cached key, triggers ONE
 * refetch — that is how a rotation is picked up without waiting a day — and forced refetches are
 * spaced at least a minute apart, so a stream of forged tokens with random kids cannot turn this
 * route into a way to hammer ABDM's gateway with our own credentials.
 *
 * `iss` is NOT checked: no source this project could open names it (spec UNVERIFIED #4). Confirm it
 * on the sandbox and pin it here.
 */
export type AbdmJwtClaims = Record<string, unknown> & { exp: number; aud?: string | string[] };

export type AbdmCallbackAuthReason =
  | "missing_bearer" | "malformed" | "alg_not_allowed" | "no_expiry" | "expired" | "not_yet_valid"
  | "audience" | "unknown_kid" | "bad_signature" | "jwks_unavailable";

export class AbdmCallbackAuthError extends Error {
  constructor(readonly reason: AbdmCallbackAuthReason, detail?: string) {
    super(`ABDM callback rejected: ${reason}${detail !== undefined ? ` (${detail})` : ""}`);
    this.name = "AbdmCallbackAuthError";
  }
}

export const JWKS_TTL_MS = 24 * 3600_000;
export const FORCED_REFETCH_MIN_INTERVAL_MS = 60_000;
export const CLOCK_SKEW_S = 60;
const CERTS_PATH = "/gateway/v3/certs";

type CachedKeys = { byKid: Map<string, KeyObject>; all: KeyObject[]; fetchedAtMs: number };

function decodeSegment(seg: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    const v = JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AbdmCallbackVerifier {
  #keys: CachedKeys | null = null;
  #lastForcedRefetchMs: number | null = null;

  constructor(
    private readonly settings: AbdmSettings,
    private readonly deps: { client: Pick<AbdmGatewayClient, "call">; now?: () => Date },
  ) {}

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  async verify(authorization: string | undefined): Promise<AbdmJwtClaims> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (m === null) throw new AbdmCallbackAuthError("missing_bearer");
    const token = m[1]!;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[2] === undefined) throw new AbdmCallbackAuthError("malformed");
    const [h, p, s] = parts as [string, string, string];
    const header = decodeSegment(h);
    const claims = decodeSegment(p);
    if (header === null || claims === null) throw new AbdmCallbackAuthError("malformed");

    if (header.alg !== "RS256") throw new AbdmCallbackAuthError("alg_not_allowed", String(header.alg));
    if (s === "" || !/^[A-Za-z0-9_-]+$/.test(s)) throw new AbdmCallbackAuthError("malformed");

    // Cheap claim checks BEFORE any fetch: an expired or foreign token costs us nothing.
    const nowS = this.nowMs() / 1000;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new AbdmCallbackAuthError("no_expiry");
    if (nowS > claims.exp + CLOCK_SKEW_S) throw new AbdmCallbackAuthError("expired");
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== "number" || nowS + CLOCK_SKEW_S < claims.nbf) throw new AbdmCallbackAuthError("not_yet_valid");
    }
    const aud = claims.aud;
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : [];
    if (!audiences.includes(this.settings.jwtAudience)) throw new AbdmCallbackAuthError("audience");

    const kid = typeof header.kid === "string" ? header.kid : null;
    const signingInput = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(s, "base64url");
    const check = (keys: CachedKeys): "ok" | "unknown_kid" | "bad_signature" => {
      const candidates = kid !== null ? [keys.byKid.get(kid)].filter((k): k is KeyObject => k !== undefined) : keys.all;
      if (candidates.length === 0) return "unknown_kid";
      return candidates.some((key) => verifySignature("sha256", signingInput, key, signature)) ? "ok" : "bad_signature";
    };

    let keys = await this.keys(false);
    let outcome = check(keys);
    if (outcome !== "ok" && this.mayForceRefetch()) {
      keys = await this.keys(true);
      outcome = check(keys);
    }
    if (outcome !== "ok") throw new AbdmCallbackAuthError(outcome);
    return claims as AbdmJwtClaims;
  }

  private mayForceRefetch(): boolean {
    const now = this.nowMs();
    if (this.#lastForcedRefetchMs !== null && now - this.#lastForcedRefetchMs < FORCED_REFETCH_MIN_INTERVAL_MS) return false;
    this.#lastForcedRefetchMs = now;
    return true;
  }

  private async keys(force: boolean): Promise<CachedKeys> {
    const cached = this.#keys;
    if (!force && cached !== null && this.nowMs() - cached.fetchedAtMs < JWKS_TTL_MS) return cached;
    /*
      THE BEARER IS SENT. Sources conflict: the spec marks `/certs` bearer-protected and an integrator
      saw 401 without it [N; NA §1.5], while the Care connector sends only REQUEST-ID/TIMESTAMP/X-CM-ID.
      Sending the session token with the standard headers is what every other wrapper call does, and a
      gateway that does not need it ignores it.
      UNVERIFIED (nha-in only) — that `/certs` REQUIRES the bearer.
    */
    let res;
    try {
      res = await this.deps.client.call("GET", CERTS_PATH, undefined, { kind: "gateway.certs" });
    } catch (e) {
      if (cached !== null) return cached;
      throw new AbdmCallbackAuthError("jwks_unavailable", e instanceof Error ? e.message : String(e));
    }
    const parsed = this.parseJwks(res.status, res.body);
    if (parsed === null) {
      if (cached !== null) return cached;
      throw new AbdmCallbackAuthError("jwks_unavailable", `HTTP ${res.status}`);
    }
    this.#keys = parsed;
    return parsed;
  }

  private parseJwks(status: number, body: unknown): CachedKeys | null {
    if (status < 200 || status >= 300 || typeof body !== "object" || body === null) return null;
    const list = (body as { keys?: unknown }).keys;
    if (!Array.isArray(list)) return null;
    const byKid = new Map<string, KeyObject>();
    const all: KeyObject[] = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const jwk = entry as { kty?: unknown; n?: unknown; e?: unknown; kid?: unknown; alg?: unknown; use?: unknown };
      if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      let key: KeyObject;
      try {
        // Only the public components are handed over: x5c and friends are not needed to verify.
        key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      } catch {
        continue;
      }
      all.push(key);
      if (typeof jwk.kid === "string") byKid.set(jwk.kid, key);
    }
    return all.length === 0 ? null : { byKid, all, fetchedAtMs: this.nowMs() };
  }
}
