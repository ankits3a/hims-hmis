import { constants, createHash, createHmac, generateKeyPairSync, privateDecrypt, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { FideliusKeyPair, fideliusDecrypt, fideliusEncrypt } from "../../src/modules/abdm/fidelius";
import { HIU_PUSH_TOKEN_PARAM } from "../../src/modules/abdm/hiu-client";

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
 *
 * ═══ ABDM S1 — AND THE ABHA (M1) SERVICE, AT A SECOND BASE URL ═══
 *
 * `fake.abha` serves the M1 routes the ABHA client calls (the certificate, the login OTP pair and
 * verify/user, the ABHA-address login pair, the profile, the card, the Aadhaar enrolment pair) at
 * `abhaBaseUrl`, behind the SAME gateway bearer token. Its RSA key is its own, and it DECRYPTS every
 * `loginId` and `otpValue` with RSA-OAEP-SHA1 — Care's padding — so a client that encrypted with the
 * wrong padding, or not at all, is refused exactly as ABDM would refuse it (`ABDM-1006`).
 *
 * ADVERSARIAL AGAIN, on purpose: a wrong OTP is refused with an error that ECHOES the OTP, and a
 * failed enrolment with one that echoes the AADHAAR NUMBER. The tests then read every stored row
 * back as text to prove neither survives. And `shareProfileCallback` builds the signed callback ABDM
 * would post for a scan-and-share, while `POST /patient-share/v3/on-share` records our reply.
 *
 * ═══ ABDM S2 — AND THE M2 HIP PATHS, AND AN HIU THAT RECEIVES THE PUSH ═══
 *
 * `fake.hip` records every M2 call the hospital makes (generate-token, add-care-contexts — which
 * REFUSES an `X-LINK-TOKEN` the fake did not issue, ABDM-1038 — context notify, on-discover /
 * on-init / on-confirm, consent on-notify, HI on-request, HI notify) and answers 202.
 * `fake.hiu` is the requester: it owns a Fidelius key pair (the SHIPPED implementation, whose
 * byte-exactness `fidelius.test.ts` proves against the published vector), hands out key material for
 * a health-information request, and DECRYPTS every pushed entry with its own private key and the
 * hospital's public key + nonce from the push — so a test asserts the PLAINTEXT bundle the hospital
 * actually sent, and a push encrypted wrongly fails loudly here. `signedCallback` wraps any body in
 * the gateway-signed headers ABDM would send it with.
 *
 * ═══ ABDM S3 — AND THE M3 HIU PATHS, AND A REMOTE HIP THAT ENCRYPTS TO US AND PUSHES ═══
 *
 * `fake.hiuGateway` records every M3 call the hospital makes as an HIU (consent init, status, the
 * hiu/on-notify ack, fetch, the health-information request, and the HIU's transfer notify) and answers
 * 202 — each REFUSING a call without `X-HIU-ID` (400), as the gateway would. `fake.remoteHip` is ANOTHER
 * facility: it owns a Fidelius key pair (the published README SENDER key, so the push decrypts along
 * the vector's own path), and `push()` builds the page that facility would POST to our `dataPushUrl`
 * — encrypting each bundle to the public key and nonce WE sent in the health-information request, with
 * the MD5 of the plaintext as its checksum — or, told to, a page with a wrong checksum or a key that is
 * not ours, so a test can prove the HIU refuses it.
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
  /** S1 — the ABHA service. */
  abha: FakeAbha;
  /** S1 — every `on-share` body we were sent, in order. */
  onShares: unknown[];
  /** S1 — a signed scan-and-share callback, ready to POST to `/abdm/callbacks/api/v3/hip/patient/share`. */
  shareProfileCallback(o?: {
    requestId?: string; hipId?: string; context?: string; intent?: string; patient?: Record<string, unknown>;
  }): { headers: Record<string, string>; body: Record<string, unknown> };
  /** S2 — the HIP (M2) side of the gateway. */
  hip: FakeHip;
  /** S2 — the HIU the hospital pushes to. */
  hiu: FakeHiu;
  /** S3 — the HIU (M3) side of the gateway. */
  hiuGateway: FakeHiuGateway;
  /** S3 — another facility, pushing its records to OUR data-push URL. */
  remoteHip: FakeRemoteHip;
  /** S2 — any callback body, with the headers ABDM would sign it with. */
  signedCallback(body: Record<string, unknown>, o?: { requestId?: string; hipId?: string; hiuId?: string }): { headers: Record<string, string>; body: Record<string, unknown> };
};

export type FakeHipCall = { requestId: string; headers: Record<string, string>; body: Record<string, unknown> };
export type FakeHip = {
  /** Every call the hospital made to one M2 path, in order. */
  calls(path: string): FakeHipCall[];
  /** Mint the link token ABDM's `on-generate-token` would carry — a JWT whose claims name the ABHA number. */
  issueLinkToken(abhaAddress: string, abhaNumber?: string): string;
  /** Every link token issued, by ABHA address. */
  linkTokens: Map<string, string>;
};
export type FakeHiu = {
  id: string;
  baseUrl: string;
  dataPushUrl(consentId: string): string;
  keyPair: FideliusKeyPair;
  /** The `keyMaterial` of a health-information request, with this HIU's public key and nonce. */
  keyMaterial(): Record<string, unknown>;
  /** Every push page as it arrived (the ciphertext included). */
  pushes: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  /** Every entry DECRYPTED, in order, with its checksum re-computed over the plaintext. */
  received: { careContextReference: string; checksum: string; checksumOk: boolean; plaintext: string; bundle: Record<string, unknown> }[];
  /** The status the push receiver answers. */
  pushStatus: number;
};

export type FakeHiuGateway = {
  /** Every call the hospital made to one M3 path, in order. */
  calls(path: string): FakeHipCall[];
  /** The status the fake answers on one M3 path (default 202). */
  statusFor: Map<string, number>;
};
export type FakeRemoteHip = {
  id: string;
  name: string;
  /** The published fidelius-cli README SENDER key pair. */
  keyPair: FideliusKeyPair;
  /**
   * One push page, encrypted to the key material of `hiRequest` (the body WE sent ABDM). `tamper`:
   * `checksum` sends a wrong MD5; `stranger` encrypts to a key that is not ours; `placeholder` sends the
   * NHA wrapper's literal checksum "string". `path` is the address under the API root, its query
   * string included; `token` is that query's `pt` value.
   */
  push(hiRequest: Record<string, unknown>, o: {
    transactionId: string; entries: { careContextReference: string; bundle: unknown }[];
    pageNumber?: number; pageCount?: number; tamper?: "checksum" | "stranger" | "placeholder";
  }): { path: string; token: string; body: Record<string, unknown> };
};

export type FakeAbhaAccount = {
  /** Dashed, `NN-NNNN-NNNN-NNNN`. */
  ABHANumber: string;
  preferredAbhaAddress: string;
  name: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  gender: "M" | "F" | "O";
  yearOfBirth: string;
  monthOfBirth?: string;
  dayOfBirth?: string;
  mobile: string;
  address?: string;
  districtName?: string;
  stateName?: string;
  pincode?: string;
  /** Fake-side only: the full mobile a "find by mobile" matches (the profile shows `mobile`, often masked). */
  mobileNumber?: string;
  /** Fake-side only: the Aadhaar a "find by Aadhaar" matches. Never ours. */
  aadhaar?: string;
};

export type FakeAbha = {
  baseUrl: string;
  /** The RSA key the ABHA certificate route publishes — tests decrypt with it. */
  privateKey: KeyObject;
  publicKeySpkiBase64(): string;
  certsServed(): number;
  addAccount(a: FakeAbhaAccount): void;
  /** The OTP every "sent" OTP has. Change it to test a wrong one. */
  otp: string;
  /** When true, an ABHA-number login answers with a short token + accounts and NO refreshToken, so the client must call verify/user. */
  loginNeedsUserSelect: boolean;
  /** Every plaintext the fake decrypted, in order — `loginId` and `otpValue` alike. */
  decrypted: string[];
  /** Every Aadhaar number an enrolment was started with (fake-side only — never ours). */
  enrolledAadhaar: string[];
  /** The bytes the card route returns. */
  cardBytes: Buffer;
  /** Every X-token issued — so a test can assert none was stored. */
  xTokensIssued(): string[];
  /** Every T-token issued (the short token that picks an account). */
  tTokensIssued(): string[];
  /** The mobile UIDAI holds for the Aadhaar an enrolment uses; a DIFFERENT communication mobile must be verified (CRT_ABHA_109). */
  aadhaarMobile: string;
  /** ABHA addresses already taken, besides the accounts' own. */
  takenAddresses: Set<string>;
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

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-abha-card")]);
const FAKE_PHOTO = Buffer.from("a face, as ABDM would send it").toString("base64").repeat(8);

export function createFakeAbdmGateway(opts: {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** S1 — the ABHA service base. Defaults to `https://fake-abha.test/abha/api`. */
  abhaBaseUrl?: string;
  /** S1 — the HIP id a share callback names by default. */
  hipId?: string;
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
  const onShares: unknown[] = [];

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
    // S1 — our reply to a scan-and-share.
    "POST /patient-share/v3/on-share": (req) => {
      if (!bearerOk(req)) return unauthorized();
      if (req.headers["x-cm-id"] === undefined) return json(400, { error: { code: "ABDM-1000", message: "X-CM-ID is required" } });
      onShares.push(req.body);
      return new Response(null, { status: 202 });
    },
  };

  // ═══ S1 — THE ABHA SERVICE ═══
  const abhaBaseUrl = opts.abhaBaseUrl ?? "https://fake-abha.test/abha/api";
  const abhaKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const accounts = new Map<string, FakeAbhaAccount>();
  const byAddress = new Map<string, string>();
  const liveXTokens = new Map<string, string>(); // token → ABHA number
  const liveTTokens = new Map<string, string>(); // short token → txnId
  const xTokensIssued: string[] = [];
  const txns = new Map<string, {
    kind: "login" | "phr" | "enrol" | "enrol-mobile"; abhaNumber: string | null; aadhaar: string | null; scope: string[];
    /** A mobile / Aadhaar "find": every account it matched. */
    found?: string[]; hint?: string; mobile?: string;
  }>();
  const tTokensIssued: string[] = [];
  let abhaCerts = 0;
  let enrolSeq = 0;
  const abha: FakeAbha = {
    baseUrl: abhaBaseUrl,
    privateKey: abhaKey.privateKey,
    publicKeySpkiBase64: () => abhaKey.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    certsServed: () => abhaCerts,
    addAccount: (a) => { accounts.set(a.ABHANumber, a); byAddress.set(a.preferredAbhaAddress, a.ABHANumber); },
    otp: "314159",
    loginNeedsUserSelect: false,
    decrypted: [],
    enrolledAadhaar: [],
    cardBytes: PNG_BYTES,
    xTokensIssued: () => [...xTokensIssued],
    tTokensIssued: () => [...tTokensIssued],
    aadhaarMobile: "9812345678",
    takenAddresses: new Set<string>(),
  };
  /** RSA-OAEP-SHA1, as ABDM's certificate says. Anything else does not decrypt. */
  const decrypt = (v: unknown): string | null => {
    if (typeof v !== "string" || v === "") return null;
    try {
      const out = privateDecrypt({ key: abhaKey.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(v, "base64")).toString("utf8");
      abha.decrypted.push(out);
      return out;
    } catch {
      return null;
    }
  };
  const invalidLoginId = (): Response => json(400, { error: { code: "ABDM-1006", message: "Invalid loginId" } });
  const issueXToken = (abhaNumber: string): string => {
    const t = `fake-x-${randomUUID()}`;
    liveXTokens.set(t, abhaNumber);
    xTokensIssued.push(t);
    return t;
  };
  const xTokenAccount = (req: FakeGatewayRequest): FakeAbhaAccount | null => {
    const h = req.headers["x-token"] ?? "";
    const n = h.startsWith("Bearer ") ? liveXTokens.get(h.slice(7)) : undefined;
    return n === undefined ? null : accounts.get(n) ?? null;
  };
  const profileOf = (a: FakeAbhaAccount): Record<string, unknown> => ({
    ...a, profilePhoto: FAKE_PHOTO, status: "ACTIVE", kycVerified: true, verificationStatus: "VERIFIED", authMethods: ["AADHAAR_OTP", "MOBILE_OTP"],
  });
  const scopeOf = (b: Record<string, unknown>): string[] => (Array.isArray(b.scope) ? b.scope.map(String) : []);
  const otpOf = (b: Record<string, unknown>): { txnId: string; otp: string | null } => {
    const auth = (b.authData ?? {}) as { otp?: { txnId?: unknown; otpValue?: unknown } };
    return { txnId: String(auth.otp?.txnId ?? ""), otp: decrypt(auth.otp?.otpValue) };
  };

  const abhaRoutes: Record<string, Responder> = {
    "GET /v3/profile/public/certificate": (req) => {
      if (!bearerOk(req)) return unauthorized();
      abhaCerts += 1;
      return json(200, { publicKey: abha.publicKeySpkiBase64(), encryptionAlgorithm: "RSA/ECB/OAEPWithSHA-1AndMGF1Padding" });
    },
    "POST /v3/profile/login/request/otp": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const scope = scopeOf(b);
      const system = b.otpSystem === "aadhaar" ? "aadhaar-verify" : "mobile-verify";
      const hint = String(b.loginHint ?? "");
      const wantSystem = hint === "mobile" ? "abdm" : hint === "aadhaar" ? "aadhaar" : String(b.otpSystem);
      if (!["abha-number", "mobile", "aadhaar"].includes(hint) || scope[0] !== "abha-login" || scope[1] !== system || b.otpSystem !== wantSystem) {
        return json(400, { error: { code: "ABDM-1000", message: "scope, loginHint and otpSystem do not agree" } });
      }
      const id = decrypt(b.loginId);
      if (id === null) return invalidLoginId();
      const txnId = randomUUID();
      if (hint === "mobile") {
        if (!/^[6-9]\d{9}$/.test(id)) return invalidLoginId();
        const found = [...accounts.values()].filter((a) => a.mobileNumber === id).map((a) => a.ABHANumber);
        // VRFY_ABHA_302's wording, as the workbook expects the screen to show it.
        if (found.length === 0) return json(400, { error: { code: "ABDM-1114", message: "ABHA Number not found. We did not find any ABHA number linked to this mobile number. Please use ABHA linked mobile number" } });
        txns.set(txnId, { kind: "login", abhaNumber: null, aadhaar: null, scope, found, hint });
        return json(200, { txnId, message: `OTP sent to ABHA linked mobile number ending with ******${id.slice(-4)}` });
      }
      if (hint === "aadhaar") {
        if (!/^\d{12}$/.test(id)) return invalidLoginId();
        const found = [...accounts.values()].filter((a) => a.aadhaar === id).map((a) => a.ABHANumber);
        // ADVERSARIAL ON PURPOSE — the refusal echoes the Aadhaar number it was asked about.
        if (found.length === 0) return json(400, { error: { code: "ABDM-1114", message: `NO ABHA user registered with this Aadhaar Number ${id}` } });
        txns.set(txnId, { kind: "login", abhaNumber: found.length === 1 ? found[0]! : null, aadhaar: id, scope, found, hint });
        return json(200, { txnId, message: "OTP is sent to Aadhaar registered mobile ending ******4321" });
      }
      if (!accounts.has(id)) return json(400, { error: { code: "ABDM-1114", message: "ABHA number not found" } });
      txns.set(txnId, { kind: "login", abhaNumber: id, aadhaar: null, scope, hint });
      return json(200, { txnId, message: "OTP is sent to Aadhaar registered mobile ending ******1234" });
    },
    "POST /v3/profile/login/verify": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { txnId, otp } = otpOf(b);
      const t = txns.get(txnId);
      if (t === undefined || t.kind !== "login") return json(400, [{ code: "ABDM-9999: ", message: "Invalid Transaction Id" }]);
      if (otp === null) return json(400, { error: { code: "ABDM-1006", message: "Invalid otpValue" } });
      // ADVERSARIAL ON PURPOSE — the refusal echoes the OTP it was sent.
      if (otp !== abha.otp) return json(400, { authResult: "failed", message: `Entered OTP ${otp} is incorrect. Kindly re-enter valid OTP.` });
      const listed = (t.found ?? [t.abhaNumber!]).map((n) => accounts.get(n)!)
        .map((a) => ({ ABHANumber: a.ABHANumber, preferredAbhaAddress: a.preferredAbhaAddress, name: a.name, status: "ACTIVE", profilePhoto: FAKE_PHOTO }));
      // A mobile find ALWAYS answers with the list and a short T-token (the account is then chosen);
      // an Aadhaar find does when it matched more than one; a number does when told to.
      if (t.hint === "mobile" || (t.hint === "aadhaar" && listed.length > 1) || abha.loginNeedsUserSelect) {
        const tToken = `fake-t-${randomUUID()}`;
        liveTTokens.set(tToken, txnId);
        tTokensIssued.push(tToken);
        return json(200, { txnId, authResult: "success", message: "OTP verified", token: tToken, expiresIn: 300, accounts: listed });
      }
      const a = accounts.get(t.abhaNumber!)!;
      const account = listed[0]!;
      return json(200, {
        txnId, authResult: "success", message: "OTP verified successfully",
        token: issueXToken(a.ABHANumber), expiresIn: 1800, refreshToken: `fake-r-${randomUUID()}`, refreshExpiresIn: 1296000,
        accounts: [account],
      });
    },
    "POST /v3/profile/login/verify/user": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const h = req.headers["t-token"] ?? "";
      const txnId = h.startsWith("Bearer ") ? liveTTokens.get(h.slice(7)) : undefined;
      const b = (req.body ?? {}) as { ABHANumber?: unknown; txnId?: unknown };
      if (txnId === undefined || txnId !== b.txnId) return json(400, { message: "Invalid T-token" });
      const n = String(b.ABHANumber ?? "");
      if (!accounts.has(n)) return json(400, { message: "ABHA number not found" });
      const t = txns.get(txnId);
      if (t?.found !== undefined && !t.found.includes(n)) return json(400, { message: "ABHA number is not linked to this login" });
      return json(200, { token: issueXToken(n), expiresIn: 1800, refreshToken: `fake-r-${randomUUID()}`, refreshExpiresIn: 1296000 });
    },
    "POST /v3/phr/web/login/abha/request/otp": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const scope = scopeOf(b);
      if (b.loginHint !== "abha-address" || scope[0] !== "abha-address-login") {
        return json(400, { error: { code: "ABDM-1000", message: "scope and loginHint do not agree" } });
      }
      const address = decrypt(b.loginId);
      if (address === null) return invalidLoginId();
      const n = byAddress.get(address);
      if (n === undefined) return json(400, { error: { code: "ABDM-1114", message: "ABHA address not found" } });
      const txnId = randomUUID();
      txns.set(txnId, { kind: "phr", abhaNumber: n, aadhaar: null, scope });
      return json(200, { txnId, message: "OTP sent to mobile ending ******5678" });
    },
    "POST /v3/phr/web/login/abha/verify": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const { txnId, otp } = otpOf((req.body ?? {}) as Record<string, unknown>);
      const t = txns.get(txnId);
      if (t === undefined || t.kind !== "phr") return json(400, { message: "Invalid Transaction Id" });
      if (otp !== abha.otp) return json(400, { message: `Entered OTP ${otp ?? "?"} is incorrect.` });
      const a = accounts.get(t.abhaNumber!)!;
      return json(200, {
        users: [{ abhaAddress: a.preferredAbhaAddress, fullName: a.name, abhaNumber: a.ABHANumber, status: "ACTIVE" }],
        tokens: { token: issueXToken(a.ABHANumber), expiresIn: 1800, refreshToken: `fake-r-${randomUUID()}`, refreshExpiresIn: 1296000 },
      });
    },
    "GET /v3/profile/account": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const a = xTokenAccount(req);
      if (a === null) return json(401, { message: "Invalid X-token" });
      return json(200, profileOf(a));
    },
    "GET /v3/profile/account/abha-card": (req) => {
      if (!bearerOk(req)) return unauthorized();
      if (xTokenAccount(req) === null) return json(401, { message: "X-token expired" });
      return new Response(new Uint8Array(abha.cardBytes), { status: 200, headers: { "content-type": "image/png" } });
    },
    "POST /v3/enrollment/request/otp": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      // CRT_ABHA_109 — after creation: an OTP to the communication mobile.
      if (b.loginHint === "mobile") {
        const scope = scopeOf(b);
        const prior = txns.get(String(b.txnId ?? ""));
        if (scope[0] !== "abha-enrol" || scope[1] !== "mobile-verify" || b.otpSystem !== "abdm" || prior === undefined || prior.abhaNumber === null) {
          return json(400, { error: { code: "ABDM-1000", message: "scope, loginHint, otpSystem or txnId do not agree" } });
        }
        const mobile = decrypt(b.loginId);
        if (mobile === null || !/^[6-9]\d{9}$/.test(mobile)) return invalidLoginId();
        const txnId = randomUUID();
        txns.set(txnId, { kind: "enrol-mobile", abhaNumber: prior.abhaNumber, aadhaar: null, scope, mobile });
        return json(200, { txnId, message: `OTP sent to mobile number ending with ******${mobile.slice(-4)}` });
      }
      if (b.loginHint !== "aadhaar" || b.otpSystem !== "aadhaar" || scopeOf(b)[0] !== "abha-enrol") {
        return json(400, { error: { code: "ABDM-1000", message: "scope, loginHint and otpSystem do not agree" } });
      }
      const aadhaar = decrypt(b.loginId);
      if (aadhaar === null || !/^\d{12}$/.test(aadhaar)) return invalidLoginId();
      abha.enrolledAadhaar.push(aadhaar);
      const txnId = randomUUID();
      txns.set(txnId, { kind: "enrol", abhaNumber: null, aadhaar, scope: ["abha-enrol"] });
      return json(200, { txnId, message: "OTP sent to Aadhaar registered mobile number ending with ******4321" });
    },
    "POST /v3/enrollment/enrol/byAadhaar": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { txnId, otp } = otpOf(b);
      const t = txns.get(txnId);
      if (t === undefined || t.kind !== "enrol") return json(400, { message: "Invalid Transaction Id" });
      const mobile = String(((b.authData ?? {}) as { otp?: { mobile?: unknown } }).otp?.mobile ?? "");
      // ADVERSARIAL ON PURPOSE — the refusal echoes the OTP AND the Aadhaar number.
      if (otp !== abha.otp) return json(400, { error: { code: "ABDM-1204", message: `OTP ${otp ?? "?"} does not match the one sent for Aadhaar ${t.aadhaar ?? ""}` } });
      enrolSeq += 1;
      const n = `91-${String(1000 + enrolSeq).slice(-4)}-5678-${String(9000 + enrolSeq).slice(-4)}`;
      // The ABHA carries the Aadhaar-linked mobile; a different communication mobile is linked only
      // once ABDM has checked it (CRT_ABHA_109), so the profile shows UIDAI's, masked.
      const shownMobile = mobile === abha.aadhaarMobile ? mobile : `******${abha.aadhaarMobile.slice(-4)}`;
      const a: FakeAbhaAccount = {
        ABHANumber: n, preferredAbhaAddress: `new.person${enrolSeq}@sbx`, name: "Kamla Devi",
        gender: "F", yearOfBirth: "1979", monthOfBirth: "7", dayOfBirth: "2", mobile: shownMobile,
        address: "Ward 4, Near Temple", districtName: "Jaipur", stateName: "RAJASTHAN", pincode: "302001",
      };
      abha.addAccount(a);
      t.abhaNumber = n;
      return json(200, {
        message: "Account created successfully", txnId,
        tokens: { token: issueXToken(n), expiresIn: 1800, refreshToken: `fake-r-${randomUUID()}`, refreshExpiresIn: 1296000 },
        ABHAProfile: {
          firstName: "Kamla", middleName: "", lastName: "Devi", dob: "02-07-1979", gender: "F", photo: FAKE_PHOTO, mobile: shownMobile,
          phrAddress: [a.preferredAbhaAddress], address: a.address, districtName: a.districtName, stateName: a.stateName,
          pinCode: a.pincode, abhaType: "STANDARD", ABHANumber: n, abhaStatus: "ACTIVE",
        },
        isNew: true,
      });
    },
    "POST /v3/enrollment/auth/byAbdm": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { txnId, otp } = otpOf(b);
      const t = txns.get(txnId);
      if (t === undefined || t.kind !== "enrol-mobile" || scopeOf(b)[1] !== "mobile-verify") return json(400, { message: "Invalid Transaction Id" });
      if (otp !== abha.otp) return json(400, { authResult: "failed", message: `Entered OTP ${otp ?? "?"} is incorrect.` });
      const a = accounts.get(t.abhaNumber!)!;
      a.mobile = t.mobile!;
      a.mobileNumber = t.mobile!;
      return json(200, { txnId, authResult: "success", message: "Mobile number is now successfully linked to your Account", accounts: [{ ABHANumber: a.ABHANumber }] });
    },
    "GET /v3/enrollment/enrol/suggestion": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const txnId = req.headers["transaction_id"] ?? "";
      const t = txns.get(txnId);
      if (t === undefined || t.abhaNumber === null) return json(400, { message: "Invalid Transaction Id" });
      return json(200, { txnId, abhaAddressList: ["kamla.devi1979", "kamladevi_79", "devi.kamla1979"] });
    },
    "POST /v3/enrollment/enrol/abha-address": (req) => {
      if (!bearerOk(req)) return unauthorized();
      const b = (req.body ?? {}) as { txnId?: unknown; abhaAddress?: unknown; preferred?: unknown };
      const t = txns.get(String(b.txnId ?? ""));
      if (t === undefined || t.abhaNumber === null) return json(400, { message: "Invalid Transaction Id" });
      const wanted = `${String(b.abhaAddress ?? "")}@sbx`;
      if (byAddress.has(wanted) || abha.takenAddresses.has(wanted)) return json(400, { message: "ABHA Address is already exist" });
      const a = accounts.get(t.abhaNumber)!;
      byAddress.delete(a.preferredAbhaAddress);
      a.preferredAbhaAddress = wanted;
      byAddress.set(wanted, a.ABHANumber);
      return json(200, { txnId: t === undefined ? "" : String(b.txnId), healthIdNumber: a.ABHANumber, preferredAbhaAddress: wanted });
    },
  };

  // ═══ S2 — THE HIP (M2) PATHS ═══
  const hipCalls = new Map<string, FakeHipCall[]>();
  const linkTokens = new Map<string, string>();
  const record = (req: FakeGatewayRequest): void => {
    const list = hipCalls.get(req.path) ?? [];
    list.push({ requestId: req.headers["request-id"] ?? "", headers: req.headers, body: (req.body ?? {}) as Record<string, unknown> });
    hipCalls.set(req.path, list);
  };
  const accepted = (req: FakeGatewayRequest): Response => {
    if (!bearerOk(req)) return unauthorized();
    if (req.headers["x-hip-id"] === undefined) return json(400, { error: { code: "ABDM-1000", message: "X-HIP-ID is required" } });
    record(req);
    return new Response(null, { status: 202 });
  };
  for (const path of [
    "/v3/token/generate-token", "/hip/v3/link/context/notify",
    "/user-initiated-linking/v3/patient/care-context/on-discover", "/user-initiated-linking/v3/link/care-context/on-init",
    "/user-initiated-linking/v3/link/care-context/on-confirm", "/consent/v3/request/hip/on-notify",
    "/data-flow/v3/health-information/hip/on-request", "/data-flow/v3/health-information/notify",
  ]) routes[`POST ${path}`] = accepted;
  routes["POST /hip/v3/link/carecontext"] = (req) => {
    if (!bearerOk(req)) return unauthorized();
    const token = req.headers["x-link-token"] ?? "";
    const address = String(((req.body ?? {}) as { abhaAddress?: unknown }).abhaAddress ?? "");
    if (linkTokens.get(address) !== token) return json(400, { error: { code: "ABDM-1038", message: "Link token mismatch" } });
    return accepted(req);
  };
  // ═══ S3 — THE HIU (M3) PATHS ═══
  const hiuCalls = new Map<string, FakeHipCall[]>();
  const hiuStatus = new Map<string, number>();
  const acceptedHiu = (req: FakeGatewayRequest): Response => {
    if (!bearerOk(req)) return unauthorized();
    if (req.headers["x-hiu-id"] === undefined) return json(400, { error: { code: "ABDM-1000", message: "X-HIU-ID is required" } });
    const list = hiuCalls.get(req.path) ?? [];
    list.push({ requestId: req.headers["request-id"] ?? "", headers: req.headers, body: (req.body ?? {}) as Record<string, unknown> });
    hiuCalls.set(req.path, list);
    const status = hiuStatus.get(req.path) ?? 202;
    return status === 202 ? new Response(null, { status }) : json(status, { error: { code: "ABDM-1063", message: "refused by the fake" } });
  };
  for (const path of [
    "/consent/v3/request/init", "/consent/v3/request/status", "/consent/v3/request/hiu/on-notify",
    "/consent/v3/fetch", "/data-flow/v3/health-information/request",
  ]) routes[`POST ${path}`] = acceptedHiu;
  // The transfer notify is one path for both roles: the HIP names itself in X-HIP-ID, the HIU in X-HIU-ID.
  routes["POST /data-flow/v3/health-information/notify"] = (req) => (req.headers["x-hiu-id"] !== undefined ? acceptedHiu(req) : accepted(req));
  const hiuGateway: FakeHiuGateway = { calls: (path) => [...(hiuCalls.get(path) ?? [])], statusFor: hiuStatus };

  const remoteHip: FakeRemoteHip = {
    id: "IN0810000123",
    name: "Fortis Escorts Jaipur",
    keyPair: FideliusKeyPair.fromPrivateKey("AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4=", "lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y="),
    push: (hiRequest, p) => {
      const hr = (hiRequest.hiRequest ?? hiRequest) as { dataPushUrl: string; keyMaterial: { dhPublicKey: { keyValue: string }; nonce: string } };
      const requester = p.tamper === "stranger"
        ? { publicKey: FideliusKeyPair.generate().publicKeyX509(), nonce: hr.keyMaterial.nonce }
        : { publicKey: hr.keyMaterial.dhPublicKey.keyValue, nonce: hr.keyMaterial.nonce };
      const entries = p.entries.map((e) => {
        const plain = JSON.stringify(e.bundle);
        const md5 = createHash("md5").update(plain, "utf8").digest("hex");
        return {
          content: fideliusEncrypt(remoteHip.keyPair, requester, plain),
          media: "application/fhir+json",
          checksum: p.tamper === "checksum" ? createHash("md5").update(`${plain} `, "utf8").digest("hex") : p.tamper === "placeholder" ? "string" : md5,
          careContextReference: e.careContextReference,
        };
      });
      // The HIP POSTs to the address exactly as given — the token rides its `pt` query parameter.
      const url = new URL(hr.dataPushUrl);
      const token = url.searchParams.get(HIU_PUSH_TOKEN_PARAM) ?? "";
      return {
        path: `${url.pathname.replace(/^\/api/, "")}${url.search}`, token,
        body: {
          pageNumber: p.pageNumber ?? 0, pageCount: p.pageCount ?? 1, transactionId: p.transactionId, entries,
          keyMaterial: {
            cryptoAlg: "ECDH", curve: "Curve25519",
            dhPublicKey: { expiry: new Date(now() + 3600_000).toISOString(), parameters: "Curve25519/32byte random key", keyValue: remoteHip.keyPair.publicKeyX509() },
            nonce: remoteHip.keyPair.nonce,
          },
        },
      };
    },
  };

  const hip: FakeHip = {
    calls: (path) => [...(hipCalls.get(path) ?? [])],
    issueLinkToken: (abhaAddress, abhaNumber = "91-2345-6789-0123") => {
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = b64url(JSON.stringify({ abhaNumber, abhaAddress, exp: Math.floor(now() / 1000) + 180 * 86400, jti: randomUUID() }));
      const token = `${header}.${claims}.${b64url(`sig-${randomUUID()}`)}`;
      linkTokens.set(abhaAddress, token);
      return token;
    },
    linkTokens,
  };

  // ═══ S2 — THE HIU THE HOSPITAL PUSHES TO ═══
  const hiuBase = "https://fake-hiu.test/hiu";
  const hiu: FakeHiu = {
    id: "FAKE-HIU-001",
    baseUrl: hiuBase,
    dataPushUrl: (consentId) => `${hiuBase}/data/push/${consentId}`,
    keyPair: FideliusKeyPair.generate(),
    keyMaterial: () => ({
      cryptoAlg: "ECDH", curve: "Curve25519",
      dhPublicKey: { expiry: new Date(now() + 3600_000).toISOString(), parameters: "Curve25519/32byte random key", keyValue: hiu.keyPair.publicKeyX509() },
      nonce: hiu.keyPair.nonce,
    }),
    pushes: [],
    received: [],
    pushStatus: 202,
  };
  const receivePush = (req: FakeGatewayRequest): Response => {
    const body = (req.body ?? {}) as { entries?: { content: string; checksum: string; careContextReference: string }[]; keyMaterial?: { dhPublicKey?: { keyValue?: string }; nonce?: string } };
    hiu.pushes.push({ url: req.url, headers: req.headers, body: body as Record<string, unknown> });
    const sender = { publicKey: String(body.keyMaterial?.dhPublicKey?.keyValue ?? ""), nonce: String(body.keyMaterial?.nonce ?? "") };
    for (const e of body.entries ?? []) {
      const plaintext = fideliusDecrypt(hiu.keyPair, sender, e.content); // throws — loudly — on a wrong encryption
      hiu.received.push({
        careContextReference: e.careContextReference, checksum: e.checksum,
        checksumOk: createHash("md5").update(plaintext, "utf8").digest("hex") === e.checksum,
        plaintext, bundle: JSON.parse(plaintext) as Record<string, unknown>,
      });
    }
    return new Response(null, { status: hiu.pushStatus });
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
    const under = (base: string): string | null => {
      const b = new URL(base);
      const prefix = b.pathname.replace(/\/$/, "");
      return url.origin === b.origin && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    };
    const hiuPath = under(hiuBase);
    if (hiuPath !== null) {
      if (method !== "POST" || !hiuPath.startsWith("/data/push/")) return json(404, { error: "not the fake HIU" });
      return receivePush({ method, url: input, path: hiuPath, headers, body });
    }
    const abhaPath = under(abhaBaseUrl);
    const gatewayPath = abhaPath === null ? under(baseUrl) : null;
    if (abhaPath === null && gatewayPath === null) return json(404, { error: "not the fake gateway" });
    const path = (abhaPath ?? gatewayPath)!;
    const req: FakeGatewayRequest = { method, url: input, path, headers, body };
    requests.push(req);
    const key = `${method} ${path}`;
    const responder = abhaPath !== null
      ? overrides.get(`ABHA ${key}`) ?? abhaRoutes[key]
      : overrides.get(key) ?? routes[key];
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
    /* S1 — an ABHA route is overridden with the method prefixed `ABHA `, e.g. `on("ABHA GET", "/v3/profile/account", …)`. */
    on: (method, path, responder) => { overrides.set(`${method.toUpperCase()} ${path}`, responder); },
    abha,
    onShares,
    hip,
    hiu,
    hiuGateway,
    remoteHip,
    signedCallback: (body, o = {}) => ({
      headers: {
        Authorization: `Bearer ${jwt({ alg: "RS256", typ: "JWT", kid: current.kid }, defaultClaims(), (input) => sign("sha256", Buffer.from(input), current.privateKey))}`,
        "REQUEST-ID": o.requestId ?? randomUUID(),
        TIMESTAMP: new Date(now()).toISOString(),
        "X-HIP-ID": o.hipId ?? opts.hipId ?? "IN0000000001",
        ...(o.hiuId === undefined ? {} : { "X-HIU-ID": o.hiuId }),
      },
      body,
    }),
    shareProfileCallback: (o = {}) => {
      const requestId = o.requestId ?? randomUUID();
      const hipId = o.hipId ?? opts.hipId ?? "IN0000000001";
      const body = {
        intent: o.intent ?? "PROFILE_SHARE",
        metaData: { hipId, context: o.context ?? "1", hprId: "", latitude: "26.9124", longitude: "75.7873" },
        profile: {
          patient: o.patient ?? {
            // The field shape an integrator observed: string birth fields, `pincode`, a null number allowed.
            abhaNumber: "91-2345-6789-0123", abhaAddress: "sunita.sharma@sbx", name: "Sunita Sharma", gender: "F",
            dayOfBirth: "14", monthOfBirth: "3", yearOfBirth: "1986",
            address: { line: "12 Gandhi Nagar", district: "Jaipur", state: "RAJASTHAN", pincode: "302015" },
            phoneNumber: "9876543210",
          },
        },
      };
      return {
        headers: {
          Authorization: `Bearer ${jwt({ alg: "RS256", typ: "JWT", kid: current.kid }, defaultClaims(), (input) => sign("sha256", Buffer.from(input), current.privateKey))}`,
          "REQUEST-ID": requestId,
          TIMESTAMP: new Date(now()).toISOString(),
          "X-HIP-ID": hipId,
        },
        body,
      };
    },
  };
}
