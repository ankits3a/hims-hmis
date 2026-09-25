import { api, apiDownload } from "./api";

/**
 * ═══ ABDM S1 — THE COUNTER'S ABHA CALLS ═══
 *
 * Mirrors `apps/core/src/modules/abdm/abha.controller.ts`. The browser holds an OPAQUE
 * `transactionId` for a verification and nothing else: ABDM's own transaction id and the patient's
 * ABHA session stay on the server, and no type below has a field that could carry them.
 */
export type WireAbdmProfile = {
  abhaNumber: string | null;
  abhaAddress: string | null;
  name: string | null;
  gender: "male" | "female" | "other" | "unknown" | null;
  yearOfBirth: number | null;
  monthOfBirth: number | null;
  dayOfBirth: number | null;
  dob: string | null;
  mobile: string | null;
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
};

export type WireFieldComparison = {
  field: "name" | "dob" | "gender" | "mobile";
  abdm: string | null;
  hospital: string | null;
  result: "same" | "differs" | "unknown";
};

export type WireDemographicChange = { field: "name" | "dob" | "gender"; from: string | null; to: string };
export type WireAbhaAccount = { abhaNumber: string | null; abhaAddress: string | null; name: string | null };

export type WireAbhaFlow = {
  transactionId: string;
  purpose: "verify" | "create";
  stage: "otp_sent" | "choose_account" | "authenticated";
  kind: "abha_number" | "abha_address" | "mobile" | "aadhaar" | "aadhaar_enrolment";
  otpMethod: "aadhaar_otp" | "mobile_otp";
  expiresAt: string;
  message: string | null;
  /** While an OTP is awaited: when it may be re-sent, and how many re-sends are left (FT: 2, 60 s apart). */
  resend: { availableAt: string; left: number } | null;
  resendNeedsAadhaar: boolean;
  accounts: WireAbhaAccount[] | null;
  profile: WireAbdmProfile | null;
  comparison: WireFieldComparison[] | null;
  /** What linking will take from ABDM — name, birth, gender (DECIDED: ABDM-verified details are authoritative). */
  demographicsToApply: WireDemographicChange[] | null;
  /** This ABHA is already on another record; the UHID only when this user may see it. */
  linkedElsewhere: { uhid: string | null } | null;
  isNew: boolean | null;
  mobileVerification: "not_needed" | "required" | "otp_sent" | "verified" | null;
  addressSuggestions: string[] | null;
};

export type WireShare = {
  id: string;
  tokenNumber: number;
  tokenDate: string;
  counterId: string | null;
  status: "pending" | "linked" | "dismissed";
  createdAt: string;
  expiresAt: string;
  ackStatus: "sent" | "failed" | null;
  profile: WireAbdmProfile;
  patientId: string | null;
  linkedElsewhere?: { uhid: string | null } | null;
};

export function startAbhaVerification(body: { identifier: string; method: "aadhaar_otp" | "mobile_otp"; patientId?: string | null }): Promise<WireAbhaFlow> {
  return api("POST", "/abdm/abha/verify", body);
}

/** 403 `abha_create_disabled` until the owner rules — the screen does not draw the button then. */
export function startAbhaCreate(body: { aadhaar: string; patientConsented: boolean; patientId?: string | null }): Promise<WireAbhaFlow> {
  return api("POST", "/abdm/abha/create", body);
}

/** "Find ABHA" by Aadhaar — 403 `abha_find_by_aadhaar_disabled` while Aadhaar creation is off. */
export function startAbhaFindByAadhaar(body: { aadhaar: string; patientConsented: boolean; patientId?: string | null }): Promise<WireAbhaFlow> {
  return api("POST", "/abdm/abha/find-by-aadhaar", body);
}

const tx = (id: string): string => `/abdm/abha/transactions/${encodeURIComponent(id)}`;

/** Re-send: 429 `otp_resend_too_soon` / `otp_resend_limit`. An Aadhaar OTP needs the number again. */
export function resendAbhaOtp(transactionId: string, body: { aadhaar?: string } = {}): Promise<WireAbhaFlow> {
  return api("POST", `${tx(transactionId)}/resend`, body);
}

export function chooseAbhaAccount(transactionId: string, abhaNumber: string): Promise<WireAbhaFlow> {
  return api("POST", `${tx(transactionId)}/account`, { abhaNumber });
}

export function sendCreationMobileOtp(transactionId: string): Promise<WireAbhaFlow> {
  return api("POST", `${tx(transactionId)}/mobile/otp`);
}

export function verifyCreationMobileOtp(transactionId: string, otp: string): Promise<WireAbhaFlow> {
  return api("POST", `${tx(transactionId)}/mobile/verify`, { otp });
}

export function abhaAddressSuggestions(transactionId: string): Promise<WireAbhaFlow> {
  return api("GET", `${tx(transactionId)}/address-suggestions`);
}

export function createAbhaAddress(transactionId: string, abhaAddress: string): Promise<WireAbhaFlow> {
  return api("POST", `${tx(transactionId)}/address`, { abhaAddress });
}

/** The card as a file (PNG or PDF), streamed and saved by the browser; the server keeps nothing. */
export function downloadAbhaCard(transactionId: string): Promise<void> {
  return apiDownload(`${tx(transactionId)}/card/download`, "ABHA-card.png");
}

export function submitAbhaOtp(transactionId: string, body: { otp: string; mobile?: string | null }): Promise<WireAbhaFlow> {
  return api("POST", `/abdm/abha/transactions/${encodeURIComponent(transactionId)}/otp`, body);
}

export function abhaCard(transactionId: string): Promise<{ mimeType: string; imageBase64: string }> {
  return api("GET", `/abdm/abha/transactions/${encodeURIComponent(transactionId)}/card`);
}

export function compareAbha(transactionId: string, patientId: string): Promise<{ comparison: WireFieldComparison[]; demographicsToApply: WireDemographicChange[] }> {
  return api("POST", `/abdm/abha/transactions/${encodeURIComponent(transactionId)}/compare`, { patientId });
}

export function linkAbha(transactionId: string, body: { patientId: string; acceptAbdmDemographics?: boolean }): Promise<{ patientId: string; changed: string[]; comparison: WireFieldComparison[]; demographicsApplied: WireDemographicChange[] }> {
  return api("POST", `/abdm/abha/transactions/${encodeURIComponent(transactionId)}/link`, body);
}

export function scanShareQr(counter: string): Promise<{ url: string; hipId: string; counterId: string }> {
  return api("GET", `/abdm/scan-share/qr?counter=${encodeURIComponent(counter)}`);
}

export function pendingShares(): Promise<{ shares: WireShare[] }> {
  return api("GET", "/abdm/scan-share/shares");
}

export function linkShare(shareId: string, body: { patientId: string; acceptAbdmDemographics?: boolean }): Promise<{ share: WireShare; changed: string[]; comparison: WireFieldComparison[]; demographicsApplied: WireDemographicChange[] }> {
  return api("POST", `/abdm/scan-share/shares/${encodeURIComponent(shareId)}/link`, body);
}

export function dismissShare(shareId: string): Promise<WireShare> {
  return api("POST", `/abdm/scan-share/shares/${encodeURIComponent(shareId)}/dismiss`);
}

/** The server's refusal code, when the error is one of ours (`{statusCode, code, message}`). */
export function abdmErrorCode(e: unknown): string | null {
  const body = (e as { body?: unknown } | null)?.body;
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

export function abdmErrorText(e: unknown): string {
  const body = (e as { body?: unknown } | null)?.body;
  const message = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined;
  if (typeof message === "string" && message !== "") return message.replace(/^[a-z_]+: /, "");
  return e instanceof Error ? e.message : String(e);
}

/** The comparison a mismatch refusal carries, so the screen can show it rather than a dead end. */
export function mismatchComparison(e: unknown): WireFieldComparison[] | null {
  if (abdmErrorCode(e) !== "abha_profile_mismatch") return null;
  const detail = ((e as { body?: { detail?: { comparison?: unknown } } }).body?.detail?.comparison);
  return Array.isArray(detail) ? (detail as WireFieldComparison[]) : null;
}

/** …and what the link would take from ABDM, from the same refusal. */
export function mismatchChanges(e: unknown): WireDemographicChange[] | null {
  if (abdmErrorCode(e) !== "abha_profile_mismatch") return null;
  const detail = ((e as { body?: { detail?: { demographicsToApply?: unknown } } }).body?.detail?.demographicsToApply);
  return Array.isArray(detail) ? (detail as WireDemographicChange[]) : null;
}

/** `abha_already_linked`: the UHID that holds this ABHA, when the server let this user see it. */
export function alreadyLinkedUhid(e: unknown): { uhid: string | null } | null {
  if (abdmErrorCode(e) !== "abha_already_linked") return null;
  const uhid = ((e as { body?: { detail?: { uhid?: unknown } } }).body?.detail?.uhid);
  return { uhid: typeof uhid === "string" ? uhid : null };
}
