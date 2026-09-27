import { randomUUID } from "node:crypto";
import type { AbhaAccount, AbhaLoginKind, AbhaOtpSystem, AbhaSession } from "./abha-client";
import type { AbdmProfile } from "./profile";

/**
 * ═══ ABDM S1 — THE COUNTER'S HANDLE ON AN ABHA FLOW, AND WHERE ABDM'S TOKENS LIVE MEANWHILE ═══
 *
 * An ABHA verification is three round trips (send OTP → verify OTP → read profile) and at every step
 * ABDM hands back something that must NOT reach the browser: its `txnId`, and after the OTP the
 * patient's X-token — a bearer credential to their national health account for thirty minutes.
 *
 * So the browser gets an OPAQUE id (a random UUID that means nothing to ABDM) and this store keeps
 * the rest, server-side, keyed by it:
 *
 *   · IN MEMORY ONLY. Nothing here is ever written to a table or the message log — a token that is
 *     never on disk cannot leak from a backup. The api is one process (docker-compose.prod.yml has
 *     one `api`), so one Map is the whole truth; a restart forgets every open flow and the clerk
 *     starts again, which costs one OTP.
 *   · SHORT-LIVED. Fifteen minutes from the first OTP, absolute — Care's own window ("available only
 *     till 15 minutes after linking abha number") and inside the X-token's 1800 s. Past it the handle
 *     is refused as expired and forgotten.
 *   · BOUND TO ONE USER. A handle opened by one clerk is "not found" to every other: the id is not a
 *     capability that can be passed across the room.
 *   · BOUNDED. At most `MAX_OPEN` flows; expired ones are swept on every touch, and past the cap the
 *     oldest is dropped rather than the process growing without limit.
 *   · NO AADHAAR NUMBER, EVER. A create flow holds ABDM's txnId, never the number it was started
 *     with — the number is encrypted into one request and dropped.
 */
export const ABHA_TXN_TTL_MS = 15 * 60_000;
export const ABHA_OTP_MAX_ATTEMPTS = 5;
/** NHA FT CRT_ABHA_106 / VRFY_ABHA_305 / 405: "Resend OTP is active at most 2 times, after 60 s". */
export const ABHA_OTP_RESEND_AFTER_MS = 60_000;
export const ABHA_OTP_RESENDS_MAX = 2;
const MAX_OPEN = 2000;

export type AbhaTransaction = {
  id: string;
  actorId: string;
  purpose: "verify" | "create";
  /** The login kind, or `aadhaar_enrolment` for a create. */
  kind: AbhaLoginKind | "aadhaar_enrolment";
  otpSystem: AbhaOtpSystem;
  /** The ABHA number (dashed) or address the clerk typed; null for a create. */
  identifier: string | null;
  /** The patient this flow is for, when it was started from their record. */
  patientId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  /** ABDM's transaction id. Server-side only. */
  txnId: string;
  /** The patient's ABHA session, after the OTP. Server-side only. */
  session: AbhaSession | null;
  profile: AbdmProfile | null;
  /** A create only: whether ABDM minted a new ABHA or returned the one this Aadhaar already had. */
  isNew: boolean | null;
  otpAttempts: number;
  /** When the current OTP was sent, and how many times it has been RE-sent (the FT rate limit). */
  otpSentAtMs: number;
  resends: number;
  /**
   * A find-by-mobile/Aadhaar (or a many-ABHA number) answered with accounts to choose from. The
   * T-token that picks one is server-side like every other ABDM token; the list is what is shown.
   */
  choice: { tToken: string; txnId: string; accounts: AbhaAccount[] } | null;
  /** A create only: the mobile the ABHA should carry, and whether ABDM still has to check it (CRT_ABHA_109). */
  mobile: string | null;
  mobileVerification: "not_needed" | "required" | "otp_sent" | "verified" | null;
  mobileOtpSentAtMs: number | null;
  mobileOtpSends: number;
  /** A create only: ABDM's suggested ABHA addresses (CRT_ABHA_112). */
  addressSuggestions: string[] | null;
};

type OpenFields = "id" | "createdAtMs" | "expiresAtMs" | "session" | "profile" | "isNew" | "otpAttempts"
  | "otpSentAtMs" | "resends" | "choice" | "mobile" | "mobileVerification" | "mobileOtpSentAtMs" | "mobileOtpSends" | "addressSuggestions";

export type AbhaTransactionLookup =
  | { ok: true; txn: AbhaTransaction }
  | { ok: false; reason: "not_found" | "expired" };

export class AbhaTransactions {
  readonly #byId = new Map<string, AbhaTransaction>();

  constructor(private readonly now: () => Date, private readonly ttlMs: number = ABHA_TXN_TTL_MS) {}

  private nowMs(): number {
    return this.now().getTime();
  }

  private sweep(): void {
    const t = this.nowMs();
    for (const [id, txn] of this.#byId) if (txn.expiresAtMs <= t) this.#byId.delete(id);
    while (this.#byId.size >= MAX_OPEN) {
      const oldest = this.#byId.keys().next().value;
      if (oldest === undefined) break;
      this.#byId.delete(oldest);
    }
  }

  open(input: Omit<AbhaTransaction, OpenFields>): AbhaTransaction {
    this.sweep();
    const createdAtMs = this.nowMs();
    const txn: AbhaTransaction = {
      ...input, id: randomUUID(), createdAtMs, expiresAtMs: createdAtMs + this.ttlMs,
      session: null, profile: null, isNew: null, otpAttempts: 0, otpSentAtMs: createdAtMs, resends: 0, choice: null,
      mobile: null, mobileVerification: null, mobileOtpSentAtMs: null, mobileOtpSends: 0, addressSuggestions: null,
    };
    this.#byId.set(txn.id, txn);
    return txn;
  }

  /** The caller's own, unexpired flow — or why not. Another user's handle is `not_found`, never `expired`. */
  lookup(id: string, actorId: string): AbhaTransactionLookup {
    const txn = this.#byId.get(id);
    if (txn === undefined || txn.actorId !== actorId) return { ok: false, reason: "not_found" };
    if (txn.expiresAtMs <= this.nowMs()) {
      this.#byId.delete(id);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, txn };
  }

  close(id: string): void {
    this.#byId.delete(id);
  }

  size(): number {
    return this.#byId.size;
  }
}
