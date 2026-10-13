import { api } from "./api";
import type {
  IpdConditionWord, IpdFamilyBillDetails, IpdFamilyCallbackList, IpdFamilyGate, IpdFamilyLinkIssued, IpdFamilyPanel, IpdFamilyView,
} from "@hmis/contracts";

/**
 * E3.3 (#731) — the family link's wire. Staff calls carry the staff session; the PUBLIC calls carry nothing but the token
 * in the body — the browser sends the http-only device and session cookies the API set (same origin, `/api/ipd/family`).
 * Paths copied from `IPD_FAMILY_ROUTES` (the web bundle imports the contract package for types only).
 */
const enc = encodeURIComponent;

export type FamilyRelation = "self" | "spouse" | "parent" | "child" | "sibling" | "relative" | "guardian" | "other";
export type FamilyOffReason = "psychiatric" | "hiv" | "mtp" | "pocso" | "patient_request" | "other";

// ═══ staff ═══
export function getFamilyPanel(admissionId: string): Promise<IpdFamilyPanel> {
  return api("GET", `/ipd/admissions/${enc(admissionId)}/family`);
}
export function issueFamilyLink(admissionId: string, consent: { consentedBy: string; relation: FamilyRelation; method: "verbal" | "paper" }): Promise<IpdFamilyLinkIssued> {
  return api("POST", `/ipd/admissions/${enc(admissionId)}/family-link`, { consent });
}
export function revokeFamilyLink(linkId: string): Promise<{ revoked: boolean }> {
  return api("POST", `/ipd/family-links/${enc(linkId)}/revoke`);
}
export function setCondition(admissionId: string, word: IpdConditionWord | null, familyOff?: FamilyOffReason | null): Promise<{ word: string | null; familyOff: string | null }> {
  return api("PUT", `/ipd/admissions/${enc(admissionId)}/condition`, familyOff === undefined ? { word } : { word, familyOff });
}
export function listFamilyCallbacks(status: "open" | "done" = "open"): Promise<IpdFamilyCallbackList> {
  return api("GET", `/ipd/family-callbacks?status=${status}`);
}
export function closeFamilyCallback(callbackId: string, note: string): Promise<{ closed: boolean }> {
  return api("POST", `/ipd/family-callbacks/${enc(callbackId)}/close`, { note });
}

// ═══ public (the attendant's phone) ═══
// Review #764: every call is a POST with the token in the BODY — the edge's access log keeps paths.
export function getFamilyGate(token: string): Promise<IpdFamilyGate> {
  return api("POST", "/ipd/family/gate", { token });
}
export function sendFamilyOtp(token: string): Promise<{ phoneMasked: string; expiresAt: string }> {
  return api("POST", "/ipd/family/otp", { token });
}
export function verifyFamilyOtp(token: string, code: string): Promise<{ verified: true; expiresAt: string }> {
  return api("POST", "/ipd/family/verify", { token, code });
}
export function getFamilyView(token: string): Promise<IpdFamilyView> {
  return api("POST", "/ipd/family/view", { token });
}
export function getFamilyBillDetails(token: string): Promise<IpdFamilyBillDetails> {
  return api("POST", "/ipd/family/bill-details", { token });
}
export function requestFamilyCallback(token: string, text: string): Promise<{ callbackId: string; status: "open" }> {
  return api("POST", "/ipd/family/callback", { token, text });
}
