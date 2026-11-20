import { api } from "./api";
import type { StoresPar, WireParSuggestion, WirePlannerMonthly, WireTopUpProposal } from "@hmis/contracts";

/**
 * STORES S7 (#1117) — the client of `modules/stores/planner.controller.ts` (`/stores/planner/*`): the department's top-up
 * proposal and its acts, the materials head's par suggestions and the monthly line. Wire shapes in
 * `packages/contracts/src/stores.ts`; nothing the department reads is money (the budget is a word).
 */
const enc = encodeURIComponent;

export const myTopUps = (): Promise<WireTopUpProposal[]> => api("GET", "/stores/planner/topup");
export const sendTopUp = (draftId: string, lines?: { itemId: string; qty: number }[]): Promise<{ ticket: { id: string; indentNo: string }; actId: string }> =>
  api("POST", `/stores/planner/drafts/${enc(draftId)}/send`, lines === undefined ? {} : { lines });
export const notNowTopUp = (draftId: string, reason: string): Promise<{ actId: string }> =>
  api("POST", `/stores/planner/drafts/${enc(draftId)}/not-now`, { reason });
export const returnSlowStock = (draftId: string): Promise<{ transferIds: string[] }> => api("POST", `/stores/planner/drafts/${enc(draftId)}/return`, {});
export const parSuggestions = (): Promise<WireParSuggestion[]> => api("GET", "/stores/planner/par-suggestions");
export const acceptPar = (id: string, edit?: StoresPar): Promise<{ par: StoresPar }> =>
  api("POST", `/stores/planner/par-suggestions/${enc(id)}/accept`, edit === undefined ? {} : { edit });
export const keepPar = (id: string): Promise<{ actId: string }> => api("POST", `/stores/planner/par-suggestions/${enc(id)}/keep`, {});
export const plannerMonthly = (month?: string): Promise<WirePlannerMonthly> =>
  api("GET", `/stores/planner/monthly${month === undefined ? "" : `?month=${enc(month)}`}`);
