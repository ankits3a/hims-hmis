import { api, ApiError } from "./api";

/**
 * #618 / #882 / decision 0053 — the CRK formulary wire contract, transcribed from `formulary.controller.ts`
 * (`crk-worklist`, `monographs/:sctid/draft`, `PUT monographs/:sctid/crk`, `monographs/:id/sign`,
 * `medicines/crk`). Model-drafted text is untrusted until signed: every string renders through React's text path.
 */

/** The fields in the order the screen shows them (`CRK_FIELDS` in core). */
export const CRK_FIELDS = [
  "uses", "howToTake", "commonSideEffects", "seriousSideEffects", "warnings", "pregnancyBreastfeeding",
  "children", "elderlyKidneyLiver", "interactions", "storage", "patientAdviceEn", "patientAdviceHi",
] as const;
export type CrkField = (typeof CRK_FIELDS)[number];
export const CRK_SOURCE_KINDS = ["openfda", "nhs", "ema", "medsafe", "livertox", "lactmed", "pubchem", "cdsco", "nfi"] as const;
export type CrkSourceKind = (typeof CRK_SOURCE_KINDS)[number];

export type CrkSource = { ref: string; kind: CrkSourceKind; title: string; url: string | null; asOf: string | null };
export type CrkStatement = { text: string; source: string };
export type CrkEntry = { sources: CrkSource[]; fields: Partial<Record<CrkField, CrkStatement[]>>; combinationNote: string | null };

export type CrkState = "draft" | "awaiting_second" | "due";
export type CrkWorklist = {
  counts: { none: number; draft: number; awaitingSecond: number; signed: number; dueForReview: number };
  drafting: { drafted: number; inputTokens: number; outputTokens: number };
  items: { monographId: string; genericSctid: string; name: string; state: CrkState; draftedModel: string | null; updatedAt: string }[];
  drafter: { configured: boolean };
};

/** The curation door's row, as far as the CRK screens read it. */
export type CrkDraftRow = {
  id: string; genericId: string; status: "draft" | "reviewed"; crk: CrkEntry | null;
  draftedModel: string | null; highAlert: boolean;
  firstSignedBy: string | null; firstSignedAt: string | null; firstSignerDesignation: string | null;
  reviewedBy: string | null; reviewedAt: string | null; reviewerDesignation: string | null;
  secondReviewedBy: string | null; secondReviewerDesignation: string | null;
  reviewDueOn: string | null; version: number;
};

/** What a doctor's screen reads beside a medicine: the SIGNED entry only, with its label. No cost, no draft. */
export type SignedCrk = {
  medicineId: string; genericSctid: string; name: string; crk: CrkEntry; highAlert: boolean;
  label: string; designation: string | null; secondSigner: string | null;
};

export type CrkGenericHit = { id: string; sctid: string; name: string; doseForm: string; monographStatus: "none" | "draft" | "reviewed" };

export const fetchCrkWorklist = (): Promise<CrkWorklist> => api<CrkWorklist>("GET", "/formulary/monographs/crk-worklist");

export async function fetchCrkDraft(sctid: string): Promise<CrkDraftRow | null> {
  try {
    return await api<CrkDraftRow>("GET", `/formulary/monographs/${encodeURIComponent(sctid)}/draft`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const searchCrkGenerics = async (q: string): Promise<CrkGenericHit[]> =>
  (await api<{ items: CrkGenericHit[] }>("GET", `/formulary/monographs/generics?q=${encodeURIComponent(q)}`)).items;

/** A person's save of the entry. The server makes it a draft again whatever it was. */
export const saveCrkEntry = (sctid: string, entry: CrkEntry): Promise<{ monographId: string }> =>
  api<{ monographId: string }>("PUT", `/formulary/monographs/${encodeURIComponent(sctid)}/crk`, entry);

export const signCrkEntry = (monographId: string, body: { designation: string; highAlert?: boolean }): Promise<{ status: "reviewed" | "awaiting_second"; version: number }> =>
  api<{ status: "reviewed" | "awaiting_second"; version: number }>("POST", `/formulary/monographs/${monographId}/sign`, body);

export async function fetchSignedCrk(medicineIds: readonly string[]): Promise<SignedCrk[]> {
  if (medicineIds.length === 0) return [];
  return (await api<{ items: SignedCrk[] }>("GET", `/formulary/medicines/crk?ids=${medicineIds.map(encodeURIComponent).join(",")}`)).items;
}
