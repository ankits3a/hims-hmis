import { api } from "./api";
import type { IpdDischargeDraft, IpdHandoverDraft, IpdSinceYesterday } from "@hmis/contracts";

/**
 * E5.3 (#740), E5.4 (#741) — the IPD copilot's wire (`IPD_COPILOT_ROUTES` in `packages/contracts/src/ipd/copilot.ts`; the
 * paths are copied because the web bundle imports the contract package for TYPES only). `getSince` is the plain,
 * deterministic read the page draws first; `polishSince` asks for a reworded copy and may answer the same plain lines.
 * The two draft calls build a DRAFT and keep it; nothing is handed over or signed by them.
 */
const enc = encodeURIComponent;

export const getSince = (admissionId: string): Promise<IpdSinceYesterday> => api("GET", `/ipd/rounds/${enc(admissionId)}/since`);
export const polishSince = (admissionId: string): Promise<IpdSinceYesterday> => api("POST", `/ipd/rounds/${enc(admissionId)}/since/polish`);
export const buildSbarDraft = (admissionId: string): Promise<IpdHandoverDraft> => api("POST", `/ipd/nursing/admissions/${enc(admissionId)}/handover-draft`);
export const buildDischargeDraft = (admissionId: string): Promise<IpdDischargeDraft> => api("POST", `/ipd/discharge/${enc(admissionId)}/summary/draft`);
