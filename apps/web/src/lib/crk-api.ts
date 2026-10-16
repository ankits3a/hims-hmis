import { api, ApiError } from "./api";

/**
 * #618 / #882 / decision 0053 — the CRK formulary wire contract, transcribed from `formulary.controller.ts`
 * (`crk/worklist`, `crk/:sctid/review`, `PUT crk/:sctid`, `crk/entries/:id/sign`,
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

/** `pending`: a new version waits while the last signed one stays live for doctors. */
export type CrkState = "draft" | "pending" | "awaiting_second" | "due" | "overdue";
export type CrkWorklist = {
  counts: { none: number; draft: number; pending: number; awaitingSecond: number; signed: number; dueForReview: number; overdue: number };
  drafting: { drafted: number; inputTokens: number; outputTokens: number };
  items: { entryId: string; genericSctid: string; name: string; state: CrkState; draftedModel: string | null; updatedAt: string }[];
  drafter: { configured: boolean };
};

/**
 * The reviewer's view of one entry (its own row, apart from the pharmacy monograph): the LIVE signed version
 * (`signedCrk`) and a PENDING one (`draftCrk`); the live one stays shown to doctors until the pending one is signed.
 */
export type CrkDraftRow = {
  id: string; genericId: string; signedCrk: CrkEntry | null; draftCrk: CrkEntry | null;
  draftedModel: string | null; highAlert: boolean;
  firstSignedBy: string | null; firstSignedAt: string | null; firstSignerDesignation: string | null;
  reviewedBy: string | null; reviewedAt: string | null; reviewerDesignation: string | null;
  secondReviewedBy: string | null; secondReviewerDesignation: string | null;
  reviewDueOn: string | null; version: number;
};

/** What a doctor's screen reads beside a medicine: the SIGNED entry only, with its label. No cost, no draft. */
export type SignedCrk = {
  medicineId: string; genericSctid: string; name: string; crk: CrkEntry; highAlert: boolean; version: number;
  label: string; signedOn: string; designation: string | null; secondSigner: string | null; reviewDueOn: string | null;
  /** #884 — past its due date: still shown, labelled "Review overdue". */
  overdue: boolean;
};

export type CrkGenericHit = { id: string; sctid: string; name: string; doseForm: string; monographStatus: "none" | "draft" | "reviewed" };

export const fetchCrkWorklist = (): Promise<CrkWorklist> => api<CrkWorklist>("GET", "/formulary/crk/worklist");

export async function fetchCrkDraft(sctid: string): Promise<CrkDraftRow | null> {
  try {
    return await api<CrkDraftRow>("GET", `/formulary/crk/${encodeURIComponent(sctid)}/review`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const searchCrkGenerics = async (q: string): Promise<CrkGenericHit[]> =>
  (await api<{ items: CrkGenericHit[] }>("GET", `/formulary/monographs/generics?q=${encodeURIComponent(q)}`)).items;

/** #884 — a reviewed entry may be renewed (re-signed unchanged) from this many days before its due date. */
export const CRK_RENEWAL_WINDOW_DAYS = 30;

/** A person's save of the entry: a PENDING version. The live signed version stays live until this is signed. */
export const saveCrkEntry = (sctid: string, entry: CrkEntry): Promise<{ entryId: string }> =>
  api<{ entryId: string }>("PUT", `/formulary/crk/${encodeURIComponent(sctid)}`, entry);

export type SignResult = { status: "reviewed" | "awaiting_second"; version: number; renewal: boolean };
export const signCrkEntry = (entryId: string, body: { designation: string; highAlert?: boolean }): Promise<SignResult> =>
  api<SignResult>("POST", `/formulary/crk/entries/${entryId}/sign`, body);

export async function fetchSignedCrk(medicineIds: readonly string[]): Promise<SignedCrk[]> {
  if (medicineIds.length === 0) return [];
  return (await api<{ items: SignedCrk[] }>("GET", `/formulary/medicines/crk?ids=${medicineIds.map(encodeURIComponent).join(",")}`)).items;
}
