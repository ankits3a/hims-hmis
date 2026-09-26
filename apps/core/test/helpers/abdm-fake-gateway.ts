import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * ═══ ABDM S0 — AN IN-PROCESS FAKE OF THE ABDM GATEWAY, FOR TESTS ONLY ═══
 *
 * CI must never contact ABDM (config.ts, FD-12), and this box cannot reach `*.abdm.gov.in` anyway
 * (CloudFront 403, plan §2). So the connector is driven against this: a `fetch` implementation that
 * serves the three gateway routes S0 touches — `POST /gateway/v3/sessions`, `GET /gateway/v3/certs`,
 * `PATCH /gateway/v3/bridge/url` — plus a signer for the callback JWTs ABDM would send us.
 *
 * It is DELIBERATELY ADVERSARIAL in one place: a refused session ECHOES the client secret it was sent
 * in its error body. A real gateway should never do that; the fake does so the tests can prove the
 * client scrubs the secret out of every stored row and every thrown message even when the other side
 * is careless with it.
 *
 * The signing key is an RSA pair minted here with `node:crypto`; the JWKS it serves is that key's
 * public half in JWK form, so a callback verifier that accepts a token from `signCallbackJwt` has
 * really checked an RS256 signature against a key it fetched.
 */

export type FakeGatewayRequest = {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

type Responder = (req: FakeGatewayRequest) => Response | Promise<Response>;

export type SignOptions = {
  /** "gateway" (default) signs with the key the JWKS serves; "wrong" with a key nobody publishes. */
  key?: "gateway" | "wrong";
  /** Override the `kid` header; `null` omits it. Defaults to the current gateway kid. */
  kid?: string | null;
  /** Override the `alg` header (the signature is still RS256 — this is for alg-confusion tests). */
  alg?: string;
};

export type FakeAbdmGateway = {
  baseUrl: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Every request the fake received, in order, headers lower-cased. */
  requests: FakeGatewayRequest[];
  sessionsIssued(): number;
  certsServed(): number;
  /** Every token issued so far now answers 401 (the gateway restarted, or rotated its sessions). */
  revokeTokens(): void;
  /** A new signing key and kid; the JWKS serves ONLY the new key from now on. */
  rotateKey(): void;
  kid(): string;
  /** An RS256 callback JWT. Claims default to aud=account, exp=+5 min, iat=now. */
  signCallbackJwt(claims?: Record<string, unknown>, opts?: SignOptions): string;
  /** `alg: none` with an empty signature — the classic bypass. */
  unsignedJwt(claims?: Record<string, unknown>): string;
  /** HS256 keyed with `secret` — used with the gateway's PUBLIC key PEM for the alg-confusion attack. */
  hs256Jwt(secret: string | Buffer, claims?: Record<string, unknown>): string;
  publicKeyPem(): string;
  /** Replace the fake's answer for one route (method + path). */
  on(method: string, path: string, responder: Responder): void;
};

const b64url = (v: Buffer | string): string => Buffer.from(v).toString("base64url");

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mintKey(): { kid: string; privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid: `fake-${randomUUID()}`, privateKey, publicKey };
}

export function createFakeAbdmGateway(opts: {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  expiresIn?: number;
  audience?: string;
  /** The clock claims are minted against, in ms. Defaults to Date.now. */
  now?: () => number;
}): FakeAbdmGateway {
  const baseUrl = opts.baseUrl ?? "https://fake-gateway.test/api/hiecm";
  const now = opts.now ?? ((): number => Date.now());
  const audience = opts.audience ?? "account";
  let current = mintKey();
  const wrong = mintKey();
  const liveTokens = new Set<string>();
  let sessions = 0;
  let certs = 0;
  const requests: FakeGatewayRequest[] = [];
  const overrides = new Map<string, Responder>();

  const bearerOk = (req: FakeGatewayRequest): boolean => {
    const h = req.headers["authorization"] ?? "";
    return h.startsWith("Bearer ") && liveTokens.has(h.slice("Bearer ".length));
  };
  const unauthorized = (): Response => json(401, { code: "900901", message: "Invalid Credentials" });

  const routes: Record<string, Responder> = {
    "POST /gateway/v3/sessions": (req) => {
      const body = (req.body ?? {}) as { clientId?: unknown; clientSecret?: unknown; grantType?: unknown };
      if (body.clientId !== opts.clientId || body.clientSecret !== opts.clientSecret || body.grantType !== "client_credentials") {
        // ADVERSARIAL ON PURPOSE — see the header: the refusal echoes what it was sent.
        return json(401, { error: { code: "ABDM-1017", message: `Invalid client credentials: ${String(body.clientSecret)}` } });
      }
      sessions += 1;
      const accessToken = `fake-access-${sessions}-${randomUUID()}`;
      liveTokens.add(accessToken);
      return json(202, {
        accessToken,
        expiresIn: opts.expiresIn ?? 1200,
        refreshExpiresIn: 1800,
        refreshToken: `fake-refresh-${sessions}`,
        tokenType: "bearer",
      });
    },
    "GET /gateway/v3/certs": (req) => {
      if (!bearerOk(req)) return unauthorized();
      certs += 1;
      const jwk = current.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return json(200, { keys: [{ ...jwk, kid: current.kid, use: "sig", alg: "RS256" }] });
    },
    "PATCH /gateway/v3/bridge/url": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const body = (req.body ?? {}) as { url?: unknown };
      if (typeof body.url !== "string" || body.url === "") {
        return json(400, { error: { code: "ABDM-1000", message: "url is required" } });
      }
      return new Response(null, { status: 202 });
    },
  };

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body: unknown = undefined;
    if (typeof init.body === "string" && init.body !== "") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const prefix = new URL(baseUrl).pathname.replace(/\/$/, "");
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith(prefix)) {
      return json(404, { error: "not the fake gateway" });
    }
    const path = url.pathname.slice(prefix.length);
    const req: FakeGatewayRequest = { method, url: input, path, headers, body };
    requests.push(req);
    const key = `${method} ${path}`;
    const responder = overrides.get(key) ?? routes[key];
    if (!responder) return json(404, { error: { code: "ABDM-404", message: `no route ${key}` } });
    return responder(req);
  };

  const jwt = (header: Record<string, unknown>, claims: Record<string, unknown>, signer: (input: string) => Buffer): string => {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(signer(input))}`;
  };
  const defaultClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const iat = Math.floor(now() / 1000);
    return { iss: `${baseUrl}/realms/fake`, sub: "gateway", aud: audience, iat, exp: iat + 300, ...over };
  };

  return {
    baseUrl,
    fetch: fetchImpl,
    requests,
    sessionsIssued: () => sessions,
    certsServed: () => certs,
    revokeTokens: () => { liveTokens.clear(); },
    rotateKey: () => { current = mintKey(); },
    kid: () => current.kid,
    signCallbackJwt: (claims = {}, o = {}) => {
      const kid = o.kid === undefined ? current.kid : o.kid;
      const header: Record<string, unknown> = { alg: o.alg ?? "RS256", typ: "JWT" };
      if (kid !== null) header.kid = kid;
      const key = o.key === "wrong" ? wrong.privateKey : current.privateKey;
      return jwt(header, defaultClaims(claims), (input) => sign("sha256", Buffer.from(input), key));
    },
    unsignedJwt: (claims = {}) => {
      const input = `${b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: current.kid }))}.${b64url(JSON.stringify(defaultClaims(claims)))}`;
      return `${input}.`;
    },
    hs256Jwt: (secret, claims = {}) =>
      jwt({ alg: "HS256", typ: "JWT", kid: current.kid }, defaultClaims(claims), (input) => createHmac("sha256", secret).update(input).digest()),
    publicKeyPem: () => current.publicKey.export({ format: "pem", type: "spki" }).toString(),
    on: (method, path, responder) => { overrides.set(`${method.toUpperCase()} ${path}`, responder); },
  };
}
