import { recordPhiAccess } from "../../kernel/phi/audit";
import { withTx } from "../../kernel/db/client";
import { acceptAbdmDemographics, findAbhaHolder, getPatient, holderUhidVisibleTo, recordAbhaVerifiedByAbdm } from "../patients";
import { ABHA_OTP_MAX_ATTEMPTS, ABHA_OTP_RESEND_AFTER_MS, ABHA_OTP_RESENDS_MAX } from "./abha-transactions";
import { abdmDemographicsPatch, compareWithPatient, dashedAbhaNumber, readAbdmProfile } from "./profile";
import type { Actor } from "@hmis/contracts";
import type { AbhaAccount, AbhaClient, AbhaLoginKind, AbhaOtpSystem, AbhaSession } from "./abha-client";
import type { AbhaTransaction, AbhaTransactions } from "./abha-transactions";
import type { AbdmProfile, DemographicChange, FieldComparison, HospitalDemographics } from "./profile";
import type { AbdmSettings } from "./settings";
import type { Db } from "../../kernel/db/client";
import type { PatientRow } from "../patients";

/**
 * ═══ ABDM S1 — THE COUNTER'S ABHA FLOWS ═══
 *
 * The routes (`abha.controller.ts`) are thin; this is where each step's rules are. NHA FT case IDs
 * (`/opt/hmis-context/reference/abdm/ft/ft-matrix.md` §2) are named where a rule answers one.
 *
 *   VERIFY / FIND (on whenever ABDM and its ABHA service are configured):
 *     start(ABHA number | ABHA address | MOBILE)  → an OTP → an OPAQUE handle            VRFY_101/102/201/202/301
 *     findByAadhaar(aadhaar, consent)              → the same, gated with the create flag  VRFY_401
 *     resend(handle)                                → at most 2 re-sends, 60 s apart        CRT_106, VRFY_305/405
 *     otp(handle, otp)                              → the session, or accounts to choose    VRFY_303/404
 *     choose(handle, abhaNumber)                    → the chosen account's session
 *   CREATE (refused `abha_create_disabled` until `ABDM_ABHA_CREATE_AADHAAR=true`):
 *     create(aadhaar, consent) → otp(handle, otp, mobile) → the ABHA                       CRT_101–107, 113
 *     mobile/otp → mobile/verify                    → a different mobile, checked by ABDM  CRT_109
 *     address-suggestions → address                 → the ABHA address                     CRT_112
 *   LINK (both):
 *     link(handle, patientId, accept) → one ABHA per patient; ABDM's name, birth and gender taken
 *     through the amendment path once the clerk has accepted the differences; then
 *     `recordAbhaVerifiedByAbdm`.                                                            TAGGING_…, VRFY_101
 *
 * THE AADHAAR NUMBER is validated, encrypted into ONE request and dropped: it is not in the handle
 * (a re-send asks for it again rather than keep it), not in the log, not in any error this file
 * throws. `aadhaar_invalid` says the shape was wrong and never repeats what was typed.
 *
 * EVERY STEP IS LOGGED: the gateway client writes an `abdm_messages` row per ABDM call, carrying the
 * clerk (`actor_id`) and — when the flow was opened from a patient's record — the patient. A step
 * that READS a named patient's ABHA profile or card writes `phi_access_log` under
 * `abdm.abha_profile`; a flow with no patient yet writes it at the link, when there is one.
 */
export type AbhaFlowErrorCode =
  | "abdm_not_configured"
  | "abha_create_disabled"
  | "abha_find_by_aadhaar_disabled"
  | "abdm_transaction_not_found"
  | "abdm_transaction_expired"
  | "abdm_transaction_wrong_step"
  | "abha_identifier_invalid"
  | "otp_invalid"
  | "otp_attempts_exhausted"
  | "otp_resend_too_soon"
  | "otp_resend_limit"
  | "aadhaar_invalid"
  | "mobile_invalid"
  | "aadhaar_consent_required"
  | "abha_account_not_offered"
  | "abha_address_invalid"
  | "abha_profile_mismatch"
  | "abha_profile_no_number"
  | "abha_already_linked"
  | "patient_not_found";

export class AbhaFlowError extends Error {
  constructor(readonly code: AbhaFlowErrorCode, message: string, readonly detail?: unknown) {
    super(`${code}: ${message}`);
    this.name = "AbhaFlowError";
  }
}

export type AbhaFlowView = {
  transactionId: string;
  purpose: "verify" | "create";
  stage: "otp_sent" | "choose_account" | "authenticated";
  kind: AbhaTransaction["kind"];
  otpMethod: "aadhaar_otp" | "mobile_otp";
  expiresAt: string;
  /** ABDM's own words about where the OTP went ("…******1234"). */
  message: string | null;
  /** While an OTP is awaited: when it may be re-sent, and how many re-sends are left. */
  resend: { availableAt: string; left: number } | null;
  /** A re-send of an Aadhaar OTP needs the Aadhaar number typed again — it is kept nowhere. */
  resendNeedsAadhaar: boolean;
  /** `choose_account`: the ABHAs ABDM found for this mobile / Aadhaar. */
  accounts: AbhaAccount[] | null;
  profile: AbdmProfile | null;
  /** When the flow names a patient: ABDM's profile against ours, field by field. */
  comparison: FieldComparison[] | null;
  /** When the flow names a patient: what linking will take from ABDM (name, birth, gender). */
  demographicsToApply: DemographicChange[] | null;
  /** Another patient already holds this ABHA — `uhid` only when this user may see it. */
  linkedElsewhere: { uhid: string | null } | null;
  isNew: boolean | null;
  mobileVerification: AbhaTransaction["mobileVerification"];
  addressSuggestions: string[] | null;
};

const ADDRESS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
const OTP = /^\d{6}$/;
const AADHAAR = /^\d{12}$/;
const MOBILE = /^[6-9]\d{9}$/;
export const ABHA_MOBILE_OTP_SENDS_MAX = 3;

function otpSystemOf(method: "aadhaar_otp" | "mobile_otp"): AbhaOtpSystem {
  return method === "aadhaar_otp" ? "aadhaar" : "abdm";
}
function methodOf(system: AbhaOtpSystem): "aadhaar_otp" | "mobile_otp" {
  return system === "aadhaar" ? "aadhaar_otp" : "mobile_otp";
}
const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");

/**
 * What the clerk typed → which login it is. An address typed without its suffix gets this
 * deployment's. Ten digits starting 6–9 is a MOBILE — "find my ABHA by mobile" (VRFY_ABHA_301).
 * Twelve digits is most likely an AADHAAR typed into the wrong box, and it must not travel to ABDM as
 * anything — the Aadhaar lookup is its own consented mode. Returns null when it is none of these.
 */
export function classifyAbhaIdentifier(raw: string, cmId: "sbx" | "abdm"): { kind: AbhaLoginKind; identifier: string } | null {
  const t = raw.trim();
  const number = dashedAbhaNumber(t);
  if (number !== null && /^[\d\s-]+$/.test(t)) return { kind: "abha_number", identifier: number };
  if (/^[\d\s-]+$/.test(t)) {
    const d = t.replace(/\D/g, "");
    return MOBILE.test(d) ? { kind: "mobile", identifier: d } : null;
  }
  const [handle, suffix, ...rest] = t.split("@");
  if (handle === undefined || rest.length > 0 || !ADDRESS.test(handle)) return null;
  if (suffix !== undefined && !/^[a-zA-Z]{2,20}$/.test(suffix)) return null;
  return { kind: "abha_address", identifier: `${handle}@${suffix ?? (cmId === "abdm" ? "abdm" : "sbx")}` };
}

/**
 * NHA FT CRT_ABHA_112's rule for a chosen ABHA address (the part before `@`): 8–18 characters,
 * letters and digits, at most one `.` and at most one `_`, neither at the ends nor side by side.
 */
export function isValidNewAbhaAddress(handle: string): boolean {
  if (!/^[A-Za-z0-9._]{8,18}$/.test(handle)) return false;
  if (/^[._]|[._]$|[._]{2}/.test(handle)) return false;
  return (handle.match(/\./g) ?? []).length <= 1 && (handle.match(/_/g) ?? []).length <= 1;
}

export function demographicsOfPatient(p: PatientRow): HospitalDemographics {
  return {
    name: p.name,
    dob: p.dob === null ? null : p.dob.toISOString().slice(0, 10),
    dobEstimated: p.dobEstimated,
    gender: p.administrativeGender,
    phone: p.phone,
  };
}

/** Whether ABDM already holds `given` as this ABHA's mobile (a masked answer is compared on what it shows). */
function sameMobile(abdm: string | null, given: string): boolean {
  if (abdm === null) return false;
  const shown = digits(abdm);
  if (/[*Xx]/.test(abdm)) return shown.length >= 4 && given.endsWith(shown);
  return shown.slice(-10) === given;
}

export class AbhaService {
  constructor(
    private readonly deps: {
      db: Db;
      settings: AbdmSettings | null;
      abha: AbhaClient | null;
      transactions: AbhaTransactions;
      now?: () => Date;
    },
  ) {}

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** ABDM on AND the ABHA service reachable — or the 503 every ABHA route answers. */
  private on(): { settings: AbdmSettings; abha: AbhaClient } {
    const { settings, abha } = this.deps;
    if (settings === null || abha === null || settings.abhaBaseUrl === null) {
      throw new AbhaFlowError("abdm_not_configured", "ABDM not configured");
    }
    return { settings, abha };
  }

  private txn(actor: Actor, id: string): AbhaTransaction {
    const found = this.deps.transactions.lookup(id, actor.id);
    if (found.ok) return found.txn;
    if (found.reason === "expired") {
      throw new AbhaFlowError("abdm_transaction_expired", "this ABDM verification has expired — start again");
    }
    throw new AbhaFlowError("abdm_transaction_not_found", "no such ABDM verification");
  }

  private async readPatient(actor: Actor, patientId: string): Promise<PatientRow> {
    const found = await getPatient(this.deps.db, actor, patientId);
    if (found === null) throw new AbhaFlowError("patient_not_found", `unknown patient ${patientId}`);
    return found.patient;
  }

  /** Another active patient holding this profile's ABHA, as this actor may see it. */
  private async holderOf(actor: Actor, profile: AbdmProfile, excludePatientId: string | null): Promise<{ uhid: string | null } | null> {
    const holder = await findAbhaHolder(this.deps.db, { abhaNumber: profile.abhaNumber, abhaAddress: profile.abhaAddress }, excludePatientId);
    return holder === null ? null : { uhid: await holderUhidVisibleTo(this.deps.db, actor, holder) };
  }

  private async view(actor: Actor, t: AbhaTransaction, message: string | null = null): Promise<AbhaFlowView> {
    let comparison: FieldComparison[] | null = null;
    let demographicsToApply: DemographicChange[] | null = null;
    if (t.profile !== null && t.patientId !== null) {
      const patient = await this.readPatient(actor, t.patientId);
      comparison = compareWithPatient(t.profile, demographicsOfPatient(patient));
      demographicsToApply = abdmDemographicsPatch(t.profile, patient).changes;
    }
    const awaitingOtp = t.session === null && t.choice === null;
    return {
      transactionId: t.id,
      purpose: t.purpose,
      stage: t.session !== null ? "authenticated" : t.choice !== null ? "choose_account" : "otp_sent",
      kind: t.kind,
      otpMethod: methodOf(t.otpSystem),
      expiresAt: new Date(t.expiresAtMs).toISOString(),
      message,
      resend: awaitingOtp
        ? { availableAt: new Date(t.otpSentAtMs + ABHA_OTP_RESEND_AFTER_MS).toISOString(), left: Math.max(0, ABHA_OTP_RESENDS_MAX - t.resends) }
        : null,
      resendNeedsAadhaar: t.kind === "aadhaar" || t.kind === "aadhaar_enrolment",
      accounts: t.choice?.accounts ?? null,
      profile: t.profile,
      comparison,
      demographicsToApply,
      linkedElsewhere: t.profile === null ? null : await this.holderOf(actor, t.profile, t.patientId),
      isNew: t.isNew,
      mobileVerification: t.mobileVerification,
      addressSuggestions: t.addressSuggestions,
    };
  }

  private async auditProfileRead(actor: Actor, t: AbhaTransaction): Promise<void> {
    if (t.patientId !== null) await recordPhiAccess(this.deps.db, { actor, patientId: t.patientId, surface: "abdm.abha_profile" });
  }

  /** The patient's session is in hand: read ABDM's profile and keep it with the handle. */
  private async adopt(actor: Actor, t: AbhaTransaction, session: AbhaSession): Promise<void> {
    const { abha } = this.on();
    t.session = session;
    t.choice = null;
    t.profile = readAbdmProfile(await abha.profile(session.xToken, { actorId: actor.id, patientId: t.patientId }));
    await this.auditProfileRead(actor, t);
  }

  private aadhaarOf(raw: string | undefined): string {
    const aadhaar = (raw ?? "").replace(/[\s-]/g, "");
    if (!AADHAAR.test(aadhaar)) throw new AbhaFlowError("aadhaar_invalid", "Aadhaar Number is not valid — it is twelve digits");
    return aadhaar;
  }

  // ═══ VERIFY / FIND ═══

  async startVerification(actor: Actor, input: { identifier: string; method: "aadhaar_otp" | "mobile_otp"; patientId?: string | null }): Promise<AbhaFlowView> {
    const { settings, abha } = this.on();
    const typed = input.identifier.trim();
    const which = classifyAbhaIdentifier(typed, settings.cmId);
    if (which === null) {
      if (/^[\d\s-]+$/.test(typed) && typed.replace(/\D/g, "").length === 10) {
        throw new AbhaFlowError("mobile_invalid", "Please enter a valid mobile number");
      }
      throw new AbhaFlowError("abha_identifier_invalid", "enter a fourteen-digit ABHA number, an ABHA address (name@abdm) or the ABHA's mobile number");
    }
    const patientId = input.patientId ?? null;
    if (patientId !== null) await this.readPatient(actor, patientId);
    // A mobile "find" is answered by an OTP to that mobile, whichever method was picked.
    const otpSystem = which.kind === "mobile" ? "abdm" : otpSystemOf(input.method);
    const sent = await abha.requestLoginOtp({ kind: which.kind, identifier: which.identifier, otpSystem, actorId: actor.id, patientId });
    const t = this.deps.transactions.open({
      actorId: actor.id, purpose: "verify", kind: which.kind, otpSystem, identifier: which.identifier, patientId, txnId: sent.txnId,
    });
    return this.view(actor, t, sent.message);
  }

  /** VRFY_ABHA_401–405 — "find ABHA" by Aadhaar. Gated with Aadhaar creation: OFF until the owner rules. */
  async startFindByAadhaar(actor: Actor, input: { aadhaar: string; patientConsented: boolean; patientId?: string | null }): Promise<AbhaFlowView> {
    const { settings, abha } = this.on();
    if (!settings.abhaCreateByAadhaar) {
      throw new AbhaFlowError("abha_find_by_aadhaar_disabled", "finding an ABHA by Aadhaar is switched off at this hospital");
    }
    if (input.patientConsented !== true) {
      throw new AbhaFlowError("aadhaar_consent_required", "the patient must agree to Aadhaar authentication first");
    }
    const aadhaar = this.aadhaarOf(input.aadhaar);
    const patientId = input.patientId ?? null;
    if (patientId !== null) await this.readPatient(actor, patientId);
    const sent = await abha.requestLoginOtp({ kind: "aadhaar", identifier: aadhaar, otpSystem: "aadhaar", actorId: actor.id, patientId });
    const t = this.deps.transactions.open({
      actorId: actor.id, purpose: "verify", kind: "aadhaar", otpSystem: "aadhaar", identifier: null, patientId, txnId: sent.txnId,
    });
    return this.view(actor, t, sent.message);
  }

  /**
   * Re-send the OTP — CRT_ABHA_106 / VRFY_ABHA_305 / 405: at most twice, and only 60 s after the
   * last one. An Aadhaar OTP is re-requested with the Aadhaar number typed again: nothing kept it.
   */
  async resendOtp(actor: Actor, id: string, input: { aadhaar?: string } = {}): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.txn(actor, id);
    if (t.session !== null || t.choice !== null) throw new AbhaFlowError("abdm_transaction_wrong_step", "the OTP for this verification was already accepted");
    if (t.resends >= ABHA_OTP_RESENDS_MAX) throw new AbhaFlowError("otp_resend_limit", "the OTP has been re-sent twice already — start again if it has not arrived");
    const wait = t.otpSentAtMs + ABHA_OTP_RESEND_AFTER_MS - this.nowMs();
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      throw new AbhaFlowError("otp_resend_too_soon", `the OTP can be re-sent in ${retryAfterSeconds} s`, { retryAfterSeconds });
    }
    let sent: { txnId: string; message: string | null };
    if (t.kind === "aadhaar_enrolment") {
      sent = await abha.requestEnrolmentOtp({ aadhaar: this.aadhaarOf(input.aadhaar), actorId: actor.id });
    } else if (t.kind === "aadhaar") {
      sent = await abha.requestLoginOtp({ kind: "aadhaar", identifier: this.aadhaarOf(input.aadhaar), otpSystem: "aadhaar", actorId: actor.id, patientId: t.patientId });
    } else {
      sent = await abha.requestLoginOtp({ kind: t.kind, identifier: t.identifier!, otpSystem: t.otpSystem, actorId: actor.id, patientId: t.patientId });
    }
    t.txnId = sent.txnId;
    t.otpSentAtMs = this.nowMs();
    t.resends += 1;
    return this.view(actor, t, sent.message);
  }

  async submitOtp(actor: Actor, id: string, input: { otp: string; mobile?: string | null }): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.txn(actor, id);
    if (t.session !== null || t.choice !== null) throw new AbhaFlowError("abdm_transaction_wrong_step", "the OTP for this verification was already accepted");
    const otp = input.otp.trim();
    if (!OTP.test(otp)) throw new AbhaFlowError("otp_invalid", "the OTP is six digits");
    if (t.otpAttempts >= ABHA_OTP_MAX_ATTEMPTS) {
      this.deps.transactions.close(t.id);
      throw new AbhaFlowError("otp_attempts_exhausted", "too many wrong OTPs — start again to get a new one");
    }
    t.otpAttempts += 1;

    if (t.purpose === "create") {
      const mobile = (input.mobile ?? "").trim();
      if (!MOBILE.test(mobile)) throw new AbhaFlowError("mobile_invalid", "Please enter a valid mobile number — ten digits starting 6–9");
      const made = await abha.enrolByAadhaar({ txnId: t.txnId, otp, mobile, actorId: actor.id });
      t.session = made.session;
      t.profile = readAbdmProfile(made.profile);
      t.isNew = made.isNew;
      if (made.txnId !== null) t.txnId = made.txnId;
      t.mobile = mobile;
      // CRT_ABHA_108/109 — the same mobile as Aadhaar's goes straight on; a different one is checked by OTP.
      t.mobileVerification = sameMobile(t.profile.mobile, mobile) ? "not_needed" : "required";
      await this.auditProfileRead(actor, t);
      return this.view(actor, t);
    }

    const result = await abha.verifyLoginOtp({ kind: t.kind as AbhaLoginKind, otpSystem: t.otpSystem, txnId: t.txnId, otp, actorId: actor.id, patientId: t.patientId });
    if (result.kind === "session") {
      await this.adopt(actor, t, result.session);
      return this.view(actor, t);
    }
    if (t.kind === "abha_number") {
      // A number that answered with accounts: take the account that IS this number (or the only one).
      const wanted = digits(t.identifier);
      const account = result.accounts.find((a) => digits(a.abhaNumber) === wanted) ?? (result.accounts.length === 1 ? result.accounts[0] : undefined);
      if (account === undefined || account.abhaNumber === null) {
        throw new AbhaFlowError("abha_account_not_offered", "ABDM did not return this ABHA number for the OTP");
      }
      const session = await abha.verifyUser({ tToken: result.tToken, txnId: result.txnId, abhaNumber: account.abhaNumber, actorId: actor.id, patientId: t.patientId });
      await this.adopt(actor, t, session);
      return this.view(actor, t);
    }
    // VRFY_ABHA_303 / 404 — the ABHAs linked to that mobile or Aadhaar, for the clerk to choose from.
    t.choice = { tToken: result.tToken, txnId: result.txnId, accounts: result.accounts };
    return this.view(actor, t);
  }

  /** The clerk picked one of the ABHAs a mobile / Aadhaar find returned. */
  async chooseAccount(actor: Actor, id: string, input: { abhaNumber: string }): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.txn(actor, id);
    if (t.choice === null) throw new AbhaFlowError("abdm_transaction_wrong_step", "there is no list of ABHAs to choose from");
    const account = t.choice.accounts.find((a) => a.abhaNumber !== null && digits(a.abhaNumber) === digits(input.abhaNumber));
    if (account === undefined || account.abhaNumber === null) throw new AbhaFlowError("abha_account_not_offered", "that ABHA was not in ABDM's answer");
    const session = await abha.verifyUser({ tToken: t.choice.tToken, txnId: t.choice.txnId, abhaNumber: account.abhaNumber, actorId: actor.id, patientId: t.patientId });
    await this.adopt(actor, t, session);
    return this.view(actor, t);
  }

  async current(actor: Actor, id: string): Promise<AbhaFlowView> {
    this.on();
    const t = this.txn(actor, id);
    if (t.profile !== null) await this.auditProfileRead(actor, t);
    return this.view(actor, t);
  }

  /** The ABHA card's bytes — to the browser, never to disk (CRT_ABHA_114). */
  async card(actor: Actor, id: string): Promise<{ bytes: Buffer; contentType: string; abhaNumber: string | null }> {
    const { abha } = this.on();
    const t = this.txn(actor, id);
    if (t.session === null) throw new AbhaFlowError("abdm_transaction_wrong_step", "the OTP has not been accepted yet");
    const card = await abha.card(t.session.xToken, { actorId: actor.id, patientId: t.patientId });
    await this.auditProfileRead(actor, t);
    return { ...card, abhaNumber: t.profile?.abhaNumber ?? null };
  }

  /** ABDM's profile against a patient's demographics, and what a link would take. Reads, never writes. */
  async compare(actor: Actor, id: string, patientId: string): Promise<{ comparison: FieldComparison[]; demographicsToApply: DemographicChange[] }> {
    this.on();
    const t = this.txn(actor, id);
    if (t.profile === null) throw new AbhaFlowError("abdm_transaction_wrong_step", "the OTP has not been accepted yet");
    const patient = await this.readPatient(actor, patientId);
    await recordPhiAccess(this.deps.db, { actor, patientId: patient.id, surface: "abdm.abha_profile" });
    return { comparison: compareWithPatient(t.profile, demographicsOfPatient(patient)), demographicsToApply: abdmDemographicsPatch(t.profile, patient).changes };
  }

  /**
   * THE LINK — the only step that writes to a patient:
   *
   *   1. ONE ABHA, ONE PATIENT: another active record holding this number or address is a 409
   *      `abha_already_linked`, naming its UHID only to a user who may see it.
   *   2. THE DIFFERENCES ARE SHOWN FIRST: a link that would change the record's name, birth or
   *      gender is refused (`abha_profile_mismatch`, with the comparison and the changes) until the
   *      clerk accepts ABDM's values (`acceptAbdmDemographics: true`). Mobile and address never change.
   *   3. ABDM's name/birth/gender go in through the AMENDMENT path (`acceptAbdmDemographics` in
   *      patients: a version, the audit, evidence `abdm_verified`), then `recordAbhaVerifiedByAbdm`
   *      stamps the number, the address and `verified` — one transaction.
   *
   * The handle is spent on success: one verification links one patient.
   */
  async link(actor: Actor, id: string, input: { patientId: string; acceptAbdmDemographics?: boolean }): Promise<{
    patientId: string; changed: string[]; comparison: FieldComparison[]; demographicsApplied: DemographicChange[];
  }> {
    this.on();
    const t = this.txn(actor, id);
    if (t.profile === null || t.session === null) throw new AbhaFlowError("abdm_transaction_wrong_step", "the OTP has not been accepted yet");
    const patient = await this.readPatient(actor, input.patientId);
    const profile = t.profile;
    if (profile.abhaNumber === null) {
      throw new AbhaFlowError("abha_profile_no_number", "ABDM's answer carried no ABHA number, so there is nothing to verify");
    }
    const elsewhere = await this.holderOf(actor, profile, patient.id);
    if (elsewhere !== null) {
      throw new AbhaFlowError(
        "abha_already_linked",
        elsewhere.uhid === null ? "this ABHA is already linked to another patient record" : `this ABHA is already linked with UHID ${elsewhere.uhid}`,
        elsewhere,
      );
    }
    const comparison = compareWithPatient(profile, demographicsOfPatient(patient));
    const { patch, changes } = abdmDemographicsPatch(profile, patient);
    if (changes.length > 0 && input.acceptAbdmDemographics !== true) {
      throw new AbhaFlowError(
        "abha_profile_mismatch",
        "ABDM's name, birth or gender differ from this record — check with the patient, then accept ABDM's details to verify",
        { comparison, demographicsToApply: changes },
      );
    }
    const abhaNumber = profile.abhaNumber;
    const via = t.purpose === "create"
      ? "M1 ABHA created by Aadhaar OTP"
      : `M1 ${t.kind === "abha_address" ? "ABHA address" : t.kind === "mobile" ? "ABHA found by mobile," : t.kind === "aadhaar" ? "ABHA found by Aadhaar," : "ABHA number"} verified by ${t.otpSystem === "aadhaar" ? "Aadhaar" : "mobile"} OTP`;
    const changed = await withTx(this.deps.db, async (tx) => {
      const demo = changes.length === 0 ? [] : (await acceptAbdmDemographics(tx, actor, patient.id, patch, via)).changed;
      const abhaStamp = await recordAbhaVerifiedByAbdm(tx, patient.id, { abhaNumber, abhaAddress: profile.abhaAddress, via, requestedBy: actor });
      return [...demo, ...abhaStamp.changed];
    });
    await recordPhiAccess(this.deps.db, { actor, patientId: patient.id, surface: "abdm.abha_profile" });
    this.deps.transactions.close(t.id);
    return { patientId: patient.id, changed, comparison, demographicsApplied: changes };
  }

  // ═══ CREATE (off until the owner rules) ═══

  isCreateEnabled(): boolean {
    return this.deps.settings?.abhaCreateByAadhaar === true;
  }

  async startCreate(actor: Actor, input: { aadhaar: string; patientConsented: boolean; patientId?: string | null }): Promise<AbhaFlowView> {
    const { settings, abha } = this.on();
    if (!settings.abhaCreateByAadhaar) {
      throw new AbhaFlowError("abha_create_disabled", "creating an ABHA by Aadhaar OTP is switched off at this hospital");
    }
    if (input.patientConsented !== true) {
      throw new AbhaFlowError("aadhaar_consent_required", "the patient must agree to Aadhaar authentication before an ABHA is created");
    }
    const aadhaar = this.aadhaarOf(input.aadhaar);
    const patientId = input.patientId ?? null;
    if (patientId !== null) await this.readPatient(actor, patientId);
    const sent = await abha.requestEnrolmentOtp({ aadhaar, actorId: actor.id });
    const t = this.deps.transactions.open({
      actorId: actor.id, purpose: "create", kind: "aadhaar_enrolment", otpSystem: "aadhaar", identifier: null, patientId, txnId: sent.txnId,
    });
    return this.view(actor, t, sent.message);
  }

  private createdTxn(actor: Actor, id: string): AbhaTransaction {
    const t = this.txn(actor, id);
    if (t.purpose !== "create" || t.session === null) throw new AbhaFlowError("abdm_transaction_wrong_step", "this step follows the creation of an ABHA");
    return t;
  }

  /** CRT_ABHA_109 — the communication mobile is not Aadhaar's: an OTP to it. 60 s apart, three at most. */
  async sendMobileOtp(actor: Actor, id: string): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.createdTxn(actor, id);
    if (t.mobileVerification !== "required" && t.mobileVerification !== "otp_sent") {
      throw new AbhaFlowError("abdm_transaction_wrong_step", "this mobile does not need checking");
    }
    if (t.mobileOtpSends >= ABHA_MOBILE_OTP_SENDS_MAX) throw new AbhaFlowError("otp_resend_limit", "the mobile OTP has been sent three times already");
    if (t.mobileOtpSentAtMs !== null) {
      const wait = t.mobileOtpSentAtMs + ABHA_OTP_RESEND_AFTER_MS - this.nowMs();
      if (wait > 0) {
        const retryAfterSeconds = Math.ceil(wait / 1000);
        throw new AbhaFlowError("otp_resend_too_soon", `the OTP can be re-sent in ${retryAfterSeconds} s`, { retryAfterSeconds });
      }
    }
    const sent = await abha.requestEnrolmentMobileOtp({ txnId: t.txnId, mobile: t.mobile!, actorId: actor.id });
    t.txnId = sent.txnId;
    t.mobileVerification = "otp_sent";
    t.mobileOtpSentAtMs = this.nowMs();
    t.mobileOtpSends += 1;
    return this.view(actor, t, sent.message);
  }

  async verifyMobileOtp(actor: Actor, id: string, input: { otp: string }): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.createdTxn(actor, id);
    if (t.mobileVerification !== "otp_sent") throw new AbhaFlowError("abdm_transaction_wrong_step", "send the OTP to the mobile first");
    const otp = input.otp.trim();
    if (!OTP.test(otp)) throw new AbhaFlowError("otp_invalid", "the OTP is six digits");
    const done = await abha.verifyEnrolmentMobileOtp({ txnId: t.txnId, otp, actorId: actor.id });
    t.txnId = done.txnId;
    t.mobileVerification = "verified";
    if (t.profile !== null) t.profile = { ...t.profile, mobile: t.mobile };
    return this.view(actor, t);
  }

  /** CRT_ABHA_112 — ABDM's suggestions for the new ABHA's address. */
  async suggestAddresses(actor: Actor, id: string): Promise<AbhaFlowView> {
    const { abha } = this.on();
    const t = this.createdTxn(actor, id);
    t.addressSuggestions = await abha.addressSuggestions({ txnId: t.txnId, actorId: actor.id });
    return this.view(actor, t);
  }

  /** CRT_ABHA_112 — create the chosen (or typed) ABHA address, validated by the workbook's rule first. */
  async createAddress(actor: Actor, id: string, input: { abhaAddress: string }): Promise<AbhaFlowView> {
    const { settings, abha } = this.on();
    const t = this.createdTxn(actor, id);
    const [handle = "", suffix, ...rest] = input.abhaAddress.trim().split("@");
    if (rest.length > 0 || !isValidNewAbhaAddress(handle) || (suffix !== undefined && !/^[a-zA-Z]{2,20}$/.test(suffix))) {
      throw new AbhaFlowError("abha_address_invalid", "an ABHA address is 8–18 letters or digits, with at most one '.' and one '_', not at either end");
    }
    const made = await abha.createAbhaAddress({ txnId: t.txnId, abhaAddress: handle, actorId: actor.id });
    const address = made.abhaAddress ?? `${handle}@${suffix ?? (settings.cmId === "abdm" ? "abdm" : "sbx")}`;
    if (t.profile !== null) t.profile = { ...t.profile, abhaAddress: address, abhaNumber: t.profile.abhaNumber ?? dashedAbhaNumber(made.abhaNumber) };
    return this.view(actor, t);
  }
}
