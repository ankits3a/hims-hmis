import { randomUUID } from "node:crypto";
import { completeOutbound, insertOutbound } from "./messages";
import { loggableHeaders, Scrubber, SESSION_REQUEST_MARKER, SESSION_RESPONSE_MARKER } from "./redact";
import type { AbdmSettings } from "./settings";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S0 — THE GATEWAY CLIENT: ONE SESSION, THE HEADERS EVERY CALL CARRIES, AND THE LOG ═══
 *
 * Sources (spec summary §1): the NHA wrapper (`SessionManager.java`, `Utils.getCustomHeaders`,
 * README §5) is AUTHORITATIVE for the session call, its body, and the four headers; the
 * `nha-in/docs` OpenAPI set agrees on every path but is untrusted, and where a detail below exists
 * ONLY there it is marked `UNVERIFIED (nha-in only)`.
 *
 *   · Session: `POST {gateway}/gateway/v3/sessions`, headers `REQUEST-ID`, `TIMESTAMP`, `X-CM-ID`,
 *     body `{clientId, clientSecret, grantType: "client_credentials"}` → `{accessToken, expiresIn, …}`.
 *   · Every call: `Authorization: Bearer <accessToken>`, a fresh `REQUEST-ID` UUID, `TIMESTAMP` in
 *     ISO-8601 with milliseconds and `Z`, `X-CM-ID`, and `X-HIP-ID` / `X-HIU-ID` per call.
 *
 * THE CACHE. One token per client, reused until 30 s before `expiresIn` runs out, dropped on any 401
 * and the call retried ONCE with a fresh session. Concurrent callers share one in-flight session
 * request rather than each minting their own. The token lives in a `#private` field, so no
 * `inspect()` or `JSON.stringify` of this object can print it.
 *
 * THE LOG. Every outbound request is written to `abdm_messages` BEFORE it is sent and completed
 * with ABDM's answer after; a request whose log row cannot be written is never sent. Nothing a
 * caller passes can put the secret there: the session bodies are stored as markers, the auth and
 * token headers are redacted, and a `Scrubber` removes the secret and the token from any text the
 * gateway sends back (see `redact.ts`).
 *
 * `fetch` and the clock are injected — tests drive this against `test/helpers/abdm-fake-gateway.ts`.
 */
export type AbdmFetch = (url: string, init: RequestInit) => Promise<Response>;
export type AbdmHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AbdmCallOptions = {
  /** The message-log kind, e.g. `gateway.bridge_url`. Defaults to `gateway:<METHOD> <path>`. */
  kind?: string;
  hipId?: string;
  hiuId?: string;
  /** `X-LINK-TOKEN`, `X-AUTH-TOKEN`, … — logged redacted. May not replace a header the client owns. */
  extraHeaders?: Record<string, string>;
  /** The patient this message is about, when it is about one (S1+). */
  patientId?: string | null;
};

export type AbdmCallResult = { status: number; requestId: string; body: unknown };

export class AbdmGatewayError extends Error {
  constructor(
    readonly code: "session_failed" | "network",
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AbdmGatewayError";
  }
}

/** UNVERIFIED (nha-in only) — "use expiresIn, refresh 30 s early" is integrator advice [NA §1.2]. */
export const TOKEN_REFRESH_EARLY_MS = 30_000;
/**
 * When a session answer carries no usable `expiresIn`: the wrapper's own schedule — "the accessToken
 * expires at 20 minutes post creating", refreshed every 15 (`SessionManager.java`). The spec's
 * example value is 1200 s, which that agrees with.
 */
export const TOKEN_FALLBACK_LIFETIME_S = 15 * 60;
const DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_PATH = "/gateway/v3/sessions";
const RESERVED_HEADERS = new Set(["authorization", "request-id", "timestamp", "x-cm-id", "content-type", "x-hip-id", "x-hiu-id"]);

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { nonJson: text.slice(0, 4000) };
  }
}

/** ABDM's error shapes vary (spec §1 "Error shapes"); pull a code/message out of the common ones. */
function errorSummary(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const b = body as { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown };
  const code = b.error?.code ?? b.code;
  const message = b.error?.message ?? b.message;
  const parts = [code, message].filter((v): v is string | number => typeof v === "string" || typeof v === "number");
  return parts.length === 0 ? "" : ` — ${parts.join(": ")}`;
}

export class AbdmGatewayClient {
  #token: { value: string; expiresAtMs: number } | null = null;
  #inflight: Promise<string> | null = null;
  readonly #scrub: Scrubber;

  constructor(
    private readonly settings: AbdmSettings,
    private readonly deps: { db: Db; fetch: AbdmFetch; now?: () => Date; timeoutMs?: number },
  ) {
    this.#scrub = new Scrubber(() => [settings.clientSecret, this.#token?.value]);
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** ISO-8601 UTC with milliseconds and `Z` — `2024-10-11T20:18:30.731Z` (wrapper `Utils.getCurrentTimeStamp`). */
  private timestamp(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private url(path: string): string {
    return `${this.settings.gatewayBaseUrl}${path}`;
  }

  private send(url: string, init: RequestInit): Promise<Response> {
    return this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  }

  /** Forget the cached token. The next call opens a new session. */
  dropToken(): void {
    this.#token = null;
  }

  async accessToken(): Promise<string> {
    const t = this.#token;
    if (t !== null && this.nowMs() < t.expiresAtMs - TOKEN_REFRESH_EARLY_MS) return t.value;
    if (this.#inflight === null) {
      this.#inflight = this.openSession().finally(() => { this.#inflight = null; });
    }
    return this.#inflight;
  }

  private async openSession(): Promise<string> {
    const requestId = randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "REQUEST-ID": requestId,
      TIMESTAMP: this.timestamp(),
      "X-CM-ID": this.settings.cmId,
    };
    const logId = await insertOutbound(this.deps.db, {
      kind: "gateway.session", path: SESSION_PATH, requestId, headers: loggableHeaders(headers),
      body: SESSION_REQUEST_MARKER,
    });
    let res: Response;
    try {
      res = await this.send(this.url(SESSION_PATH), {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: this.settings.clientId,
          clientSecret: this.settings.clientSecret,
          grantType: "client_credentials",
        }),
      });
    } catch (e) {
      const message = this.#scrub.text(e instanceof Error ? e.message : String(e));
      await completeOutbound(this.deps.db, logId, { error: message });
      throw new AbdmGatewayError("network", `ABDM session request failed: ${message}`, null);
    }
    const body = await readBody(res);
    const b = (typeof body === "object" && body !== null ? body : {}) as { accessToken?: unknown; expiresIn?: unknown; tokenType?: unknown };
    const token = typeof b.accessToken === "string" && b.accessToken !== "" ? b.accessToken : null;
    const expiresIn = typeof b.expiresIn === "number" && Number.isFinite(b.expiresIn) && b.expiresIn > 0 ? b.expiresIn : null;
    // The spec documents this answer under 202 and the wrapper reads it off any 2xx — so does this.
    const ok = res.status >= 200 && res.status < 300 && token !== null;
    await completeOutbound(this.deps.db, logId, {
      httpStatus: res.status,
      responseBody: ok
        ? { redacted: SESSION_RESPONSE_MARKER, expiresIn: b.expiresIn ?? null, tokenType: b.tokenType ?? null }
        : this.#scrub.json(body),
    });
    if (!ok) {
      throw new AbdmGatewayError(
        "session_failed",
        this.#scrub.text(`ABDM refused the session (HTTP ${res.status})${token === null && res.ok ? " — no accessToken in the answer" : errorSummary(body)}`),
        res.status,
      );
    }
    this.#token = { value: token, expiresAtMs: this.nowMs() + (expiresIn ?? TOKEN_FALLBACK_LIFETIME_S) * 1000 };
    return token;
  }

  /**
   * One gateway call. Returns ABDM's status and parsed body whatever the status — the caller decides
   * what a 4xx means — and throws only when there was no answer at all (`network`) or no session.
   *
   * A 401 drops the token and retries ONCE under the SAME `REQUEST-ID` (a request the auth layer
   * refused was never processed, and keeping the id keeps the `on-*` correlation stable); both
   * attempts are logged.
   */
  async call(method: AbdmHttpMethod, path: string, body?: unknown, opts: AbdmCallOptions = {}): Promise<AbdmCallResult> {
    if (!path.startsWith("/")) throw new Error(`ABDM gateway path must start with "/": ${path}`);
    for (const k of Object.keys(opts.extraHeaders ?? {})) {
      if (RESERVED_HEADERS.has(k.toLowerCase())) throw new Error(`"${k}" is a reserved ABDM header and is set by the client`);
    }
    const requestId = randomUUID();
    const token = await this.accessToken();
    const first = await this.attempt(method, path, body, opts, requestId, token);
    if (first.status !== 401) return first;
    if (this.#token?.value === token) this.dropToken();
    return this.attempt(method, path, body, opts, requestId, await this.accessToken());
  }

  private async attempt(
    method: AbdmHttpMethod, path: string, body: unknown, opts: AbdmCallOptions, requestId: string, token: string,
  ): Promise<AbdmCallResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "REQUEST-ID": requestId,
      TIMESTAMP: this.timestamp(),
      "X-CM-ID": this.settings.cmId,
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.hipId !== undefined) headers["X-HIP-ID"] = opts.hipId;
    if (opts.hiuId !== undefined) headers["X-HIU-ID"] = opts.hiuId;
    for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) headers[k] = v;

    const logId = await insertOutbound(this.deps.db, {
      kind: opts.kind ?? `gateway:${method} ${path}`,
      path, requestId, headers: loggableHeaders(headers),
      body: body === undefined ? null : this.#scrub.json(body),
      patientId: opts.patientId ?? null,
    });
    let res: Response;
    try {
      res = await this.send(this.url(path), {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      const message = this.#scrub.text(e instanceof Error ? e.message : String(e));
      await completeOutbound(this.deps.db, logId, { error: message });
      throw new AbdmGatewayError("network", `ABDM ${method} ${path} failed: ${message}`, null);
    }
    const parsed = await readBody(res);
    await completeOutbound(this.deps.db, logId, { httpStatus: res.status, responseBody: this.#scrub.json(parsed) });
    return { status: res.status, requestId, body: parsed };
  }
}
