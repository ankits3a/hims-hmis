import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { AbdmGatewayError } from "./gateway-client";
import type { AbdmCallOptions, AbdmCallResult, AbdmGatewayClient, AbdmHttpMethod } from "./gateway-client";

/**
 * ═══ ABDM S1 — THE ABHA (M1) CLIENT: VERIFY AN ABHA BY OTP, READ ITS PROFILE AND CARD, CREATE ONE ═══
 *
 * Over S0's ONE gateway session (`AbdmGatewayClient` — same token cache, same message log): the
 * ABHA service is a second base URL (`ABDM_ABHA_BASE_URL`, sandbox
 * `https://abhasbx.abdm.gov.in/abha/api`) called with the gateway's bearer token. Nothing here opens
 * a second session or writes a second log.
 *
 * SOURCES. Nothing official about M1 was readable from this box (every `*.abdm.gov.in` host answers
 * 403, plan §2), so the PRIMARY reference is the open-source production connector Care
 * (`10bedicu/care_abdm` @ 5e029dad, `abdm/service/v3/health_id.py` for the calls,
 * `abdm/service/helper.py::encrypt_message` for the encryption). The `nha-in/docs` ABHA swagger is a
 * cross-check ONLY — that org is untrusted (plan §1). Where the two disagree this follows Care and
 * says so at the call (`UNVERIFIED: Care says X, nha-in says Y`).
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ EVERY PATH BELOW IS UNVERIFIED UNTIL SANDBOX LOGIN. Relative to ABDM_ABHA_BASE_URL.              │
 * ├──────────────────────────────────────────┬─────────────┬────────────────────────────────────────┤
 * │ endpoint                                 │ source      │ disagreement                           │
 * ├──────────────────────────────────────────┼─────────────┼────────────────────────────────────────┤
 * │ GET  /v3/profile/public/certificate      │ Care helper │ padding: Care OAEP-SHA1; nha-in's own  │
 * │                                          │  + nha-in   │ header text says RSA/ECB/PKCS1Padding, │
 * │                                          │             │ its example answer says OAEP-SHA1-MGF1 │
 * │ POST /v3/profile/login/request/otp       │ Care        │ none on the body; nha-in says loginId  │
 * │                                          │             │ is the dashed NN-NNNN-NNNN-NNNN form   │
 * │ POST /v3/profile/login/verify            │ Care        │ none                                   │
 * │ POST /v3/profile/login/verify/user       │ Care        │ none (header T-TOKEN)                  │
 * │ GET  /v3/profile/account                 │ Care        │ nha-in: ABHA-ADDRESS logins read       │
 * │                                          │             │ /v3/phr/web/login/profile/abha-profile │
 * │ GET  /v3/profile/account/abha-card       │ Care        │ Care: success is 202; nha-in: 200 png  │
 * │ POST /v3/phr/web/login/abha/request/otp  │ Care        │ scope/loginHint are the CALLER's in    │
 * │                                          │             │ Care (its UI, not read); values nha-in │
 * │ POST /v3/phr/web/login/abha/verify       │ Care        │ same as above                          │
 * │ POST /v3/enrollment/request/otp          │ Care        │ none                                   │
 * │ POST /v3/enrollment/enrol/byAadhaar      │ Care        │ Care sends otp.timeStamp; nha-in omits │
 * │ POST /v3/enrollment/request/otp (mobile) │ Care        │ none (scope abha-enrol+mobile-verify)  │
 * │ POST /v3/enrollment/auth/byAbdm          │ Care        │ Care sends otp.timeStamp; nha-in omits │
 * │ GET  /v3/enrollment/enrol/suggestion     │ Care        │ header: Care TRANSACTION_ID, nha-in    │
 * │                                          │             │ Transaction_Id (HTTP: same header)     │
 * │ POST /v3/enrollment/enrol/abha-address   │ Care        │ none                                   │
 * │ login by MOBILE / by AADHAAR             │ Care (path, │ scope/loginHint/otpSystem are the      │
 * │  (same login/request/otp + verify, then  │  verify/    │ CALLER's in Care; the values are       │
 * │  verify/user to pick the account)        │  user)      │ nha-in's (only source that names them) │
 * └──────────────────────────────────────────┴─────────────┴────────────────────────────────────────┘
 *
 * HEADERS. `Authorization: Bearer <gateway token>`, `REQUEST-ID`, `TIMESTAMP` — and NOT `X-CM-ID`
 * (Care sends none to the ABHA service; nor does the nha-in spec). The patient's own ABHA session is
 * `X-Token: Bearer <token>` (profile, card) or `T-Token: Bearer <token>` (verify/user). nha-in's
 * preamble also says "you need … X-HIP-ID" for ABHA calls — UNVERIFIED: Care sends no X-HIP-ID
 * there, and this follows Care.
 *
 * WHAT NEVER LEAVES THIS FILE IN THE CLEAR. The Aadhaar number and every OTP are RSA-encrypted before
 * they are put in a body, their ciphertext fields are stored redacted (`redactBodyKeys`), and the
 * plaintexts are handed to the client as per-call `secrets` so an ABDM error that echoes one back is
 * scrubbed from the log AND from the body this client returns. The patient's X-token is a secret the
 * same way. None of those values is ever put in an exception message.
 */
export const ABHA_PATHS = {
  certificate: "/v3/profile/public/certificate", // UNVERIFIED until sandbox login
  loginRequestOtp: "/v3/profile/login/request/otp", // UNVERIFIED until sandbox login
  loginVerify: "/v3/profile/login/verify", // UNVERIFIED until sandbox login
  loginVerifyUser: "/v3/profile/login/verify/user", // UNVERIFIED until sandbox login
  profile: "/v3/profile/account", // UNVERIFIED until sandbox login
  card: "/v3/profile/account/abha-card", // UNVERIFIED until sandbox login
  phrLoginRequestOtp: "/v3/phr/web/login/abha/request/otp", // UNVERIFIED until sandbox login
  phrLoginVerify: "/v3/phr/web/login/abha/verify", // UNVERIFIED until sandbox login
  enrolRequestOtp: "/v3/enrollment/request/otp", // UNVERIFIED until sandbox login
  enrolByAadhaar: "/v3/enrollment/enrol/byAadhaar", // UNVERIFIED until sandbox login
  enrolAuthByAbdm: "/v3/enrollment/auth/byAbdm", // UNVERIFIED until sandbox login
  enrolSuggestion: "/v3/enrollment/enrol/suggestion", // UNVERIFIED until sandbox login
  enrolAbhaAddress: "/v3/enrollment/enrol/abha-address", // UNVERIFIED until sandbox login
} as const;

/**
 * The padding Care uses (`PKCS1_OAEP.new(key, hashAlgo=SHA1)` → OAEP, SHA-1, MGF1-SHA-1, empty
 * label) — which is also what ABDM's certificate answer names, `RSA/ECB/OAEPWithSHA-1AndMGF1Padding`.
 * UNVERIFIED: Care says OAEP-SHA1, nha-in's preamble says RSA/ECB/PKCS1Padding (its own example
 * certificate answer contradicts it).
 */
export const ABHA_ENCRYPTION = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" } as const;
export const ABHA_ENCRYPTION_NAME = "RSA/ECB/OAEPWithSHA-1AndMGF1Padding";
/** Care re-fetches the key on every encryption; ABDM rotates it rarely. Six hours, and refetched on demand. */
export const ABHA_CERT_TTL_MS = 6 * 3600_000;

/**
 * What the login is BY. `mobile` and `aadhaar` are "find my ABHA" (NHA FT VRFY_ABHA_301–305 and
 * 401–405): ABDM answers with the account(s) linked to that mobile or Aadhaar, and one is chosen.
 */
export type AbhaLoginKind = "abha_number" | "abha_address" | "mobile" | "aadhaar";
/** `aadhaar` — UIDAI sends the OTP to the Aadhaar-linked mobile · `abdm` — ABDM sends it to the ABHA's mobile. */
export type AbhaOtpSystem = "aadhaar" | "abdm";

export type AbhaErrorCode =
  /** ABDM answered and said no (a wrong OTP, an unknown ABHA, an expired transaction). Its message, scrubbed, is the clerk's. */
  | "abdm_refused"
  /** No answer, or a 5xx — try again later. */
  | "abdm_unavailable"
  /** A 2xx whose body lacked what the next step needs. Ours to fix, not the clerk's. */
  | "abdm_bad_answer";

export class AbhaError extends Error {
  constructor(readonly code: AbhaErrorCode, message: string, readonly status: number | null) {
    super(message);
    this.name = "AbhaError";
  }
}

/** ABDM's error shapes, read the way Care's `handle_error` reads them. Never throws. */
export function abdmErrorMessage(body: unknown): string {
  if (Array.isArray(body)) return body.length === 0 ? "" : abdmErrorMessage(body[0]);
  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return "";
  const b = body as Record<string, unknown>;
  if ("error" in b && b.error !== null && b.error !== undefined) return abdmErrorMessage(b.error);
  if (typeof b.message === "string") return b.message;
  const rest = Object.entries(b).filter(([k]) => k !== "code" && k !== "timestamp" && k !== "nonJson");
  if (rest.length > 0) return rest.map(([, v]) => String(v)).join(" ");
  if (typeof b.nonJson === "string") return b.nonJson.slice(0, 200);
  return "";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The Aadhaar number in the two spellings a clerk or a careless echo would use. */
function aadhaarSpellings(aadhaar: string): string[] {
  const d = aadhaar.replace(/\D/g, "");
  return [d, `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}`, `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`];
}

function loginScope(kind: AbhaLoginKind, otpSystem: AbhaOtpSystem): string[] {
  const how = otpSystem === "aadhaar" ? "aadhaar-verify" : "mobile-verify";
  // ABHA-number scopes: Care passes them from its caller; the values are the ones both nha-in and the
  // Care UI flow name. ABHA-address, mobile and Aadhaar scopes: UNVERIFIED (nha-in only) — Care's
  // service takes them from its UI, which was not in the reference set.
  return kind === "abha_address" ? ["abha-address-login", how] : ["abha-login", how];
}

const LOGIN_HINT: Record<AbhaLoginKind, string> = {
  abha_number: "abha-number", abha_address: "abha-address", mobile: "mobile", aadhaar: "aadhaar",
};

export type AbhaSession = { xToken: string; expiresInS: number | null };
/** One ABHA an OTP login found — shown to the clerk to choose from. The T-token is not in it. */
export type AbhaAccount = { abhaNumber: string | null; abhaAddress: string | null; name: string | null };
/**
 * The OTP login's answer: the patient's session, or — when ABDM answered with a short T-token and a
 * list of accounts (a mobile or Aadhaar "find", or an ABHA number with several) — the choice.
 */
export type AbhaLoginResult =
  | { kind: "session"; session: AbhaSession }
  | { kind: "choose"; tToken: string; txnId: string; accounts: AbhaAccount[] };

export class AbhaClient {
  #cert: { key: KeyObject; fetchedAtMs: number } | null = null;
  #certInflight: Promise<KeyObject> | null = null;

  constructor(
    private readonly gateway: Pick<AbdmGatewayClient, "call">,
    private readonly deps: { now?: () => Date } = {},
  ) {}

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** One ABHA-service call; a transport failure becomes `abdm_unavailable` with no secret in it. */
  private async call(method: AbdmHttpMethod, path: string, body: unknown, opts: AbdmCallOptions): Promise<AbdmCallResult> {
    try {
      return await this.gateway.call(method, path, body, { ...opts, service: "abha", redactBodyKeys: true });
    } catch (e) {
      if (e instanceof AbdmGatewayError) {
        throw new AbhaError("abdm_unavailable", e.code === "session_failed" ? "ABDM refused this hospital's session — the connector's credentials need checking" : "ABDM could not be reached — try again in a minute", e.status);
      }
      throw e;
    }
  }

  /** A non-2xx answer as the error the clerk sees: ABDM's own words (already scrubbed by the client). */
  private refused(res: AbdmCallResult, what: string): AbhaError {
    const said = abdmErrorMessage(res.body).trim();
    if (res.status >= 500) return new AbhaError("abdm_unavailable", `ABDM could not ${what} just now (HTTP ${res.status}) — try again in a minute`, res.status);
    return new AbhaError("abdm_refused", said === "" ? `ABDM refused to ${what} (HTTP ${res.status})` : said.slice(0, 300), res.status);
  }

  private static ok(res: AbdmCallResult): boolean {
    return res.status >= 200 && res.status < 300;
  }

  /** Forget the cached certificate; the next encryption fetches it again. */
  dropCertificate(): void {
    this.#cert = null;
  }

  /**
   * ABDM's RSA public key, from `GET /v3/profile/public/certificate` → `{publicKey: <base64 DER>}`.
   * The DER is SubjectPublicKeyInfo in every example (nha-in, a 4096-bit key); PKCS#1 is accepted
   * too, as PyCryptodome's `importKey` (Care) accepts both.
   */
  async publicKey(opts: { actorId?: string | null } = {}): Promise<KeyObject> {
    const c = this.#cert;
    if (c !== null && this.nowMs() - c.fetchedAtMs < ABHA_CERT_TTL_MS) return c.key;
    if (this.#certInflight === null) {
      this.#certInflight = this.fetchCertificate(opts.actorId ?? null).finally(() => { this.#certInflight = null; });
    }
    return this.#certInflight;
  }

  private async fetchCertificate(actorId: string | null): Promise<KeyObject> {
    const res = await this.call("GET", ABHA_PATHS.certificate, undefined, { kind: "abha.certificate", actorId });
    if (!AbhaClient.ok(res)) throw new AbhaError("abdm_unavailable", `ABDM did not hand over its encryption certificate (HTTP ${res.status})`, res.status);
    const b64 = str(obj(res.body).publicKey);
    if (b64 === null) throw new AbhaError("abdm_bad_answer", "ABDM's certificate answer carried no publicKey", res.status);
    const der = Buffer.from(b64.replace(/-----[^-]+-----|\s+/g, ""), "base64");
    let key: KeyObject;
    try {
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      try {
        key = createPublicKey({ key: der, format: "der", type: "pkcs1" });
      } catch {
        throw new AbhaError("abdm_bad_answer", "ABDM's publicKey is not an RSA public key", res.status);
      }
    }
    if (key.asymmetricKeyType !== "rsa") throw new AbhaError("abdm_bad_answer", "ABDM's publicKey is not an RSA public key", res.status);
    this.#cert = { key, fetchedAtMs: this.nowMs() };
    return key;
  }

  /** RSA-OAEP(SHA-1) under ABDM's key, base64 — Care's `encrypt_message`, in node:crypto. */
  async encrypt(plain: string, opts: { actorId?: string | null } = {}): Promise<string> {
    const key = await this.publicKey(opts);
    return publicEncrypt({ key, ...ABHA_ENCRYPTION }, Buffer.from(plain, "utf8")).toString("base64");
  }

  // ═══ VERIFY AN EXISTING ABHA (login) ═══

  /**
   * Step 1 — ask ABDM to send an OTP. `identifier` is the ABHA number in its dashed form
   * (`NN-NNNN-NNNN-NNNN`, UNVERIFIED: nha-in only — Care passes whatever its UI typed) or the ABHA
   * address. Returns ABDM's `txnId` — which the SERVICE keeps server-side — and ABDM's message
   * ("OTP sent to …******1234"), which is the clerk's.
   */
  async requestLoginOtp(input: {
    kind: AbhaLoginKind; identifier: string; otpSystem: AbhaOtpSystem; actorId: string | null; patientId?: string | null;
  }): Promise<{ txnId: string; message: string | null }> {
    const loginId = input.kind === "aadhaar" ? input.identifier.replace(/\D/g, "") : input.identifier;
    const body = {
      scope: loginScope(input.kind, input.otpSystem),
      loginHint: LOGIN_HINT[input.kind],
      loginId: await this.encrypt(loginId, { actorId: input.actorId }),
      otpSystem: input.otpSystem,
    };
    const path = input.kind === "abha_address" ? ABHA_PATHS.phrLoginRequestOtp : ABHA_PATHS.loginRequestOtp;
    const res = await this.call("POST", path, body, {
      kind: input.kind === "abha_address" ? "abha.phr_login.request_otp" : `abha.login.request_otp${input.kind === "abha_number" ? "" : `.${input.kind}`}`,
      actorId: input.actorId, patientId: input.patientId ?? null,
      secrets: input.kind === "aadhaar" ? aadhaarSpellings(loginId) : undefined,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "send the OTP");
    const txnId = str(obj(res.body).txnId);
    if (txnId === null) throw new AbhaError("abdm_bad_answer", "ABDM said the OTP was sent but returned no transaction", res.status);
    return { txnId, message: str(obj(res.body).message) };
  }

  /**
   * Step 2 — the OTP. Returns the patient's ABHA session (the X-token), which the service keeps in
   * memory and never writes down.
   *
   * THE TWO ANSWER SHAPES. ABHA-number (Aadhaar OTP, and — per nha-in — mobile OTP) and ABHA-address
   * logins answer with the final token (`token` + `refreshToken`, or `tokens.token` for the PHR
   * login). A login whose answer is a short-lived `token` plus `accounts[]` and NO `refreshToken`
   * must first pick the account: `POST /v3/profile/login/verify/user` with `T-TOKEN`, as Care does.
   * "An answer carrying refreshToken is final" is the rule an integrator observed [nha-in NA §2.2].
   */
  async verifyLoginOtp(input: {
    kind: AbhaLoginKind; otpSystem: AbhaOtpSystem; txnId: string; otp: string;
    actorId: string | null; patientId?: string | null;
  }): Promise<AbhaLoginResult> {
    const body = {
      scope: loginScope(input.kind, input.otpSystem),
      authData: { authMethods: ["otp"], otp: { txnId: input.txnId, otpValue: await this.encrypt(input.otp, { actorId: input.actorId }) } },
    };
    const path = input.kind === "abha_address" ? ABHA_PATHS.phrLoginVerify : ABHA_PATHS.loginVerify;
    const res = await this.call("POST", path, body, {
      kind: input.kind === "abha_address" ? "abha.phr_login.verify" : `abha.login.verify${input.kind === "abha_number" ? "" : `.${input.kind}`}`,
      secrets: [input.otp], actorId: input.actorId, patientId: input.patientId ?? null,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "accept the OTP");
    const b = obj(res.body);
    const tokens = obj(b.tokens);
    const finalToken = str(tokens.token) ?? (str(b.refreshToken) !== null ? str(b.token) : null);
    const expiresInS = typeof (tokens.expiresIn ?? b.expiresIn) === "number" ? ((tokens.expiresIn ?? b.expiresIn) as number) : null;
    if (finalToken !== null) return { kind: "session", session: { xToken: finalToken, expiresInS } };

    const tToken = str(b.token);
    if (tToken === null) throw new AbhaError("abdm_bad_answer", "ABDM accepted the OTP but returned no session", res.status);
    const accounts = (Array.isArray(b.accounts) ? b.accounts.map(obj) : []).map((a): AbhaAccount => ({
      abhaNumber: str(a.ABHANumber), abhaAddress: str(a.preferredAbhaAddress), name: str(a.name),
    }));
    if (accounts.length === 0) throw new AbhaError("abdm_refused", "ABDM found no ABHA account for this OTP", res.status);
    return { kind: "choose", tToken, txnId: str(b.txnId) ?? input.txnId, accounts };
  }

  /** After a "choose" answer: pick the account (`verify/user`, header `T-TOKEN`, as Care does). */
  async verifyUser(input: { tToken: string; txnId: string; abhaNumber: string; actorId: string | null; patientId: string | null }): Promise<AbhaSession> {
    const res = await this.call("POST", ABHA_PATHS.loginVerifyUser, { ABHANumber: input.abhaNumber, txnId: input.txnId }, {
      kind: "abha.login.verify_user", extraHeaders: { "T-TOKEN": `Bearer ${input.tToken}` },
      secrets: [input.tToken], actorId: input.actorId, patientId: input.patientId,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "select the ABHA account");
    const b = obj(res.body);
    const token = str(b.token);
    if (token === null) throw new AbhaError("abdm_bad_answer", "ABDM selected the account but returned no session", res.status);
    return { xToken: token, expiresInS: typeof b.expiresIn === "number" ? b.expiresIn : null };
  }

  /** The profile ABDM holds for this ABHA — the raw answer; `profile.ts` reads it. */
  async profile(xToken: string, opts: { actorId: string | null; patientId?: string | null }): Promise<Record<string, unknown>> {
    const res = await this.call("GET", ABHA_PATHS.profile, undefined, {
      kind: "abha.profile", extraHeaders: { "X-TOKEN": `Bearer ${xToken}` }, secrets: [xToken],
      actorId: opts.actorId, patientId: opts.patientId ?? null,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "return the ABHA profile");
    return obj(res.body);
  }

  /**
   * The ABHA card — bytes and their type (PNG in nha-in's spec; PDF is possible from the download
   * variant). Returned to the caller, NEVER persisted: the log keeps only its type and length.
   * UNVERIFIED: Care treats only 202 as success, nha-in documents 200 image/png — any 2xx is taken.
   */
  async card(xToken: string, opts: { actorId: string | null; patientId?: string | null }): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.call("GET", ABHA_PATHS.card, undefined, {
      kind: "abha.card", extraHeaders: { "X-TOKEN": `Bearer ${xToken}` }, secrets: [xToken], binary: true,
      actorId: opts.actorId, patientId: opts.patientId ?? null,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "return the ABHA card");
    const bytes = res.body as Buffer;
    return { bytes, contentType: res.contentType?.split(";")[0]?.trim() || "image/png" };
  }

  // ═══ CREATE AN ABHA BY AADHAAR OTP (built; the SERVICE refuses it while the owner has not ruled) ═══

  /** Step 1 — UIDAI sends an OTP to the Aadhaar-linked mobile. The Aadhaar number goes out encrypted and is kept nowhere. */
  async requestEnrolmentOtp(input: { aadhaar: string; actorId: string | null }): Promise<{ txnId: string; message: string | null }> {
    const aadhaar = input.aadhaar.replace(/\D/g, "");
    const body = {
      txnId: "",
      scope: ["abha-enrol"],
      loginHint: "aadhaar",
      loginId: await this.encrypt(aadhaar, { actorId: input.actorId }),
      otpSystem: "aadhaar",
    };
    const res = await this.call("POST", ABHA_PATHS.enrolRequestOtp, body, {
      kind: "abha.enrol.request_otp", secrets: aadhaarSpellings(aadhaar), actorId: input.actorId,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "send the Aadhaar OTP");
    const txnId = str(obj(res.body).txnId);
    if (txnId === null) throw new AbhaError("abdm_bad_answer", "ABDM said the Aadhaar OTP was sent but returned no transaction", res.status);
    return { txnId, message: str(obj(res.body).message) };
  }

  /**
   * Step 2 — the OTP and the mobile the ABHA should carry. ABDM creates the ABHA (or returns the one
   * this Aadhaar already has — `isNew: false`, "This account already exist").
   * UNVERIFIED: Care sends `otp.timeStamp`, nha-in's body has no such field.
   */
  async enrolByAadhaar(input: { txnId: string; otp: string; mobile: string; actorId: string | null }): Promise<{
    session: AbhaSession; profile: Record<string, unknown>; isNew: boolean;
    /** The transaction the NEXT enrolment steps (mobile, address) continue. */
    txnId: string | null;
  }> {
    const body = {
      authData: {
        authMethods: ["otp"],
        otp: {
          timeStamp: new Date(this.nowMs()).toISOString(),
          txnId: input.txnId,
          otpValue: await this.encrypt(input.otp, { actorId: input.actorId }),
          mobile: input.mobile,
        },
      },
      consent: { code: "abha-enrollment", version: "1.4" },
    };
    const res = await this.call("POST", ABHA_PATHS.enrolByAadhaar, body, {
      kind: "abha.enrol.by_aadhaar", secrets: [input.otp], actorId: input.actorId,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "create the ABHA");
    const b = obj(res.body);
    const tokens = obj(b.tokens);
    const token = str(tokens.token);
    if (token === null) throw new AbhaError("abdm_bad_answer", "ABDM created the ABHA but returned no session", res.status);
    return {
      session: { xToken: token, expiresInS: typeof tokens.expiresIn === "number" ? tokens.expiresIn : null },
      profile: obj(b.ABHAProfile),
      isNew: b.isNew !== false,
      txnId: str(b.txnId),
    };
  }

  // ═══ AFTER THE ABHA EXISTS — a different mobile (FT CRT_ABHA_109) and the ABHA address (CRT_ABHA_112) ═══

  /**
   * The communication mobile the clerk gave is NOT the Aadhaar-linked one, so ABDM must check it:
   * an OTP to that mobile (Care `enrollment__request__otp` with type mobile → `otpSystem: abdm`).
   */
  async requestEnrolmentMobileOtp(input: { txnId: string; mobile: string; actorId: string | null }): Promise<{ txnId: string; message: string | null }> {
    const body = {
      txnId: input.txnId,
      scope: ["abha-enrol", "mobile-verify"],
      loginHint: "mobile",
      loginId: await this.encrypt(input.mobile, { actorId: input.actorId }),
      otpSystem: "abdm",
    };
    const res = await this.call("POST", ABHA_PATHS.enrolRequestOtp, body, { kind: "abha.enrol.request_otp.mobile", actorId: input.actorId });
    if (!AbhaClient.ok(res)) throw this.refused(res, "send the OTP to that mobile");
    return { txnId: str(obj(res.body).txnId) ?? input.txnId, message: str(obj(res.body).message) };
  }

  /** The OTP that mobile received (Care `enrollment__auth__byAbdm`). */
  async verifyEnrolmentMobileOtp(input: { txnId: string; otp: string; actorId: string | null }): Promise<{ txnId: string }> {
    const body = {
      scope: ["abha-enrol", "mobile-verify"],
      authData: {
        authMethods: ["otp"],
        otp: { timeStamp: new Date(this.nowMs()).toISOString(), txnId: input.txnId, otpValue: await this.encrypt(input.otp, { actorId: input.actorId }) },
      },
    };
    const res = await this.call("POST", ABHA_PATHS.enrolAuthByAbdm, body, { kind: "abha.enrol.auth_by_abdm", secrets: [input.otp], actorId: input.actorId });
    if (!AbhaClient.ok(res)) throw this.refused(res, "accept the mobile OTP");
    const b = obj(res.body);
    if (str(b.authResult) !== null && str(b.authResult)?.toLowerCase() !== "success") {
      throw new AbhaError("abdm_refused", str(b.message) ?? "ABDM did not accept the mobile OTP", res.status);
    }
    return { txnId: str(b.txnId) ?? input.txnId };
  }

  /** ABDM's suggested ABHA addresses for the new ABHA (Care `enrollment__enrol__suggestion`). */
  async addressSuggestions(input: { txnId: string; actorId: string | null }): Promise<string[]> {
    const res = await this.call("GET", ABHA_PATHS.enrolSuggestion, undefined, {
      kind: "abha.enrol.suggestion", extraHeaders: { TRANSACTION_ID: input.txnId }, actorId: input.actorId,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "suggest ABHA addresses");
    const list = obj(res.body).abhaAddressList;
    return Array.isArray(list) ? list.map(str).filter((x): x is string => x !== null) : [];
  }

  /** Create the chosen ABHA address as the preferred one (Care `enrollment__enrol__abha_address`). */
  async createAbhaAddress(input: { txnId: string; abhaAddress: string; actorId: string | null }): Promise<{ abhaAddress: string | null; abhaNumber: string | null }> {
    const res = await this.call("POST", ABHA_PATHS.enrolAbhaAddress, { txnId: input.txnId, abhaAddress: input.abhaAddress, preferred: 1 }, {
      kind: "abha.enrol.abha_address", actorId: input.actorId,
    });
    if (!AbhaClient.ok(res)) throw this.refused(res, "create that ABHA address");
    const b = obj(res.body);
    return { abhaAddress: str(b.preferredAbhaAddress), abhaNumber: str(b.healthIdNumber) };
  }
}
