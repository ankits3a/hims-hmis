import { api, newIdempotencyKey } from "./api";
import type {
  IpdAdmissionView, IpdAdvice, IpdBandPayload, IpdBedClass, IpdBedProposal, IpdClassQuote, IpdPayerKind,
} from "@hmis/contracts";

/**
 * E1.2 (#719) — the Admit sheet's wire (spec §4.9 B). Shapes are the contract's (`packages/contracts/src/ipd/
 * admissions.ts`, `intents-admit.ts`); paths are copied from `IPD_ADMIT_ROUTES` because the web bundle imports the
 * contract package for TYPES only. Every act carries a fresh idempotency key in its body.
 */
const R = {
  list: "/ipd/admissions",
  advice: "/ipd/admissions/advice",
  consultants: "/ipd/admissions/consultants",
  request: "/ipd/admissions/request",
  plan: "/ipd/admissions/plan",
  admit: "/ipd/admissions/admit",
  cancel: "/ipd/admissions/cancel",
  emergency: "/ipd/admissions/emergency",
  backfill: "/ipd/admissions/backfill",
  consent: "/ipd/admissions/consent",
  deposit: "/ipd/admissions/deposit",
  printBand: "/ipd/admissions/band/print",
  reprintBand: "/ipd/admissions/band/reprint",
} as const;

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = newIdempotencyKey();
  return api("POST", path, { idempotencyKey: key, ...body }, key);
}

export type Consultant = { userId: string; name: string; department: string | null };
export type ConsentInput = {
  signedBy: "patient" | "guardian" | "representative";
  method: "paper";
  witnessName: string;
  signerName?: string;
  relation?: string;
  representativeReason?: string;
  language: "hi" | "en";
};
export type DepositChoice = { receiptId: string } | { exempt: "emergency_not_stabilised" | "scheme" | "cashless_no_non_payables" };

export const listAdmissions = (): Promise<IpdAdmissionView[]> => api<{ items: IpdAdmissionView[] }>("GET", R.list).then((r) => r.items);
export const getAdmission = (id: string): Promise<IpdAdmissionView> => api("GET", `${R.list}/${id}`);
export const getQuotes = (id: string): Promise<IpdClassQuote[]> => api<{ items: IpdClassQuote[] }>("GET", `${R.list}/${id}/quotes`).then((r) => r.items);
export const getBedProposals = (id: string): Promise<IpdBedProposal[]> => api<{ items: IpdBedProposal[] }>("GET", `${R.list}/${id}/beds`).then((r) => r.items);
export const listAdvice = (): Promise<IpdAdvice[]> => api<{ items: IpdAdvice[] }>("GET", R.advice).then((r) => r.items);
export const listConsultants = (): Promise<Consultant[]> => api<{ items: Consultant[] }>("GET", R.consultants).then((r) => r.items);

export const requestAdmission = (b: {
  patientId: string; source: "opd_advice" | "direct"; sourceRef?: string; consultantId: string; requestedClass: IpdBedClass;
  isolation: "none" | "contact" | "droplet" | "airborne"; provisionalDiagnosis: string; mlc: boolean; department?: string;
}): Promise<{ admissionId: string }> => post(R.request, b);

export const planAdmission = (b: {
  admissionId: string; payerKind: IpdPayerKind; requestedClass: IpdBedClass;
  plan: { kind: "medical" } | { kind: "surgical"; procedureEstimatePaise: number };
}): Promise<{ depositRequiredPaise: number; estimatePaise: number; depositBasis: string }> => post(R.plan, b);

export const askApproval = (admissionId: string, kind: "icu" | "non_covered" | "deposit_waiver", note: string): Promise<{ approvalId: string }> =>
  post(`${R.list}/${admissionId}/approvals`, { kind, note }).then((r) => r as { approvalId: string });

export const takeDeposit = (b: {
  admissionId: string; amountPaise: number; tender: "cash" | "upi" | "card"; tenderRef?: string;
  payer: { name: string; relation: "self" | "relative" | "employer" | "other" };
}): Promise<{ receiptId: string; receiptNo: string; amountPaise: number; depositTotalPaise: number }> => post(R.deposit, b);

export const admitPatient = (b: {
  admissionId: string; bedId: string; consent: ConsentInput; deposit: DepositChoice; intensivistApprovalId?: string;
}): Promise<{ admissionId: string; bedId: string; admittedAt: string }> => post(R.admit, b);

export type BandResult = { bandId: string; bandSerial: string; printedAt: string; band: IpdBandPayload };
export const printBand = (admissionId: string, size: "adult" | "paediatric" | "neonatal", site: "wrist" | "ankle"): Promise<BandResult> =>
  post(R.printBand, { admissionId, size, site });
export const reprintBand = (
  admissionId: string, size: "adult" | "paediatric" | "neonatal", site: "wrist" | "ankle",
  reason: "damaged" | "unreadable" | "allergy_added" | "details_changed" | "uhid_merged",
): Promise<BandResult> => post(R.reprintBand, { admissionId, size, site, reason });

export const emergencyAdmit = (b: {
  patientId: string; bedId: string; consultantId: string; isolation: "none" | "contact" | "droplet" | "airborne"; mlc: boolean;
  provisionalDiagnosis?: string;
}): Promise<{ admissionId: string; admissionNo: string; incomplete: string[] }> => post(R.emergency, b);

export const backfillDowntime = (b: Record<string, unknown>): Promise<{ admissionId: string; admissionNo: string }> => post(R.backfill, b);
export const recordConsent = (admissionId: string, consent: ConsentInput): Promise<unknown> => post(R.consent, { admissionId, consent });
export const cancelAdmission = (admissionId: string, reason: "patient_declined" | "duplicate" | "other"): Promise<unknown> =>
  post(R.cancel, { admissionId, reason });
