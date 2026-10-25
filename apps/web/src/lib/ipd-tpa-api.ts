import { api } from "./api";
import type { IpdClaimDeduction, IpdPackageImportResult, IpdSchemePackage, IpdTpaBoard, IpdTpaPanel, IpdTpaDocumentKind, IpdTpaStage } from "@hmis/contracts";

/**
 * #604 (decision 0075) — the TPA desk's wire (`IPD_TPA_ROUTES`, copied: the web bundle imports the contract for TYPES only).
 * `ipd.payer.manage` for the desk, `ipd.payer.terms` for a settlement and the package import — no doctor role holds either.
 * Each act sends a fresh idempotency key: a retry of the same click is the same act on the server.
 */
const key = (): string => crypto.randomUUID();
const enc = encodeURIComponent;

export function getTpaBoard(): Promise<IpdTpaBoard> {
  return api("GET", "/ipd/tpa/board");
}
export function getTpaPanel(admissionId: string): Promise<IpdTpaPanel> {
  return api("GET", `/ipd/admissions/${enc(admissionId)}/tpa`);
}
export async function searchPackages(scheme: "pmjay" | "state_scheme", q: string): Promise<IpdSchemePackage[]> {
  const { items } = await api<{ items: IpdSchemePackage[] }>("GET", `/ipd/tpa/packages?scheme=${enc(scheme)}&q=${enc(q)}`);
  return items;
}
export function importPackages(scheme: "pmjay" | "state_scheme", csv: string, apply: boolean): Promise<IpdPackageImportResult> {
  return api("POST", "/ipd/tpa/packages/import", { scheme, csv, apply });
}
export function recordQuery(b: { admissionId: string; stage: IpdTpaStage; claimId?: string; raisedAt: string; queryText: string }): Promise<{ queryId: string }> {
  return api("POST", "/ipd/tpa/queries", { idempotencyKey: key(), ...b });
}
export function answerQuery(queryId: string, responseText: string): Promise<{ queryId: string }> {
  return api("POST", `/ipd/tpa/queries/${enc(queryId)}/answer`, { idempotencyKey: key(), responseText });
}
export function attachDocument(b: { admissionId: string; stage: IpdTpaStage; kind: IpdTpaDocumentKind; patientDocumentId: string; claimId?: string }): Promise<{ attachmentId: string }> {
  return api("POST", "/ipd/tpa/documents", { idempotencyKey: key(), ...b });
}
export function selectPackage(admissionId: string, packageId: string): Promise<{ selectionId: string; packageAmountPaise: number }> {
  return api("POST", `/ipd/admissions/${enc(admissionId)}/packages`, { idempotencyKey: key(), packageId });
}
export function removePackage(admissionId: string, selectionId: string, reason: string): Promise<{ packageAmountPaise: number }> {
  return api("POST", `/ipd/admissions/${enc(admissionId)}/packages/${enc(selectionId)}/remove`, { idempotencyKey: key(), reason });
}
export function submitClaim(claimId: string, b: { submittedAt: string; claimRef?: string; claimedPaise?: number }): Promise<{ claimedPaise: number }> {
  return api("POST", `/ipd/tpa/claims/${enc(claimId)}/submit`, { idempotencyKey: key(), ...b });
}
export function settleClaim(claimId: string, b: {
  netPaidPaise: number; tdsPaise: number; deductions: IpdClaimDeduction[]; utrRef: string; settledOn: string;
}): Promise<{ outcome: string }> {
  return api("POST", `/ipd/tpa/claims/${enc(claimId)}/settle`, { idempotencyKey: key(), ...b });
}
export function rejectClaim(claimId: string, b: { rejectedAt: string; reason: string }): Promise<{ claimId: string }> {
  return api("POST", `/ipd/tpa/claims/${enc(claimId)}/reject`, { idempotencyKey: key(), ...b });
}
