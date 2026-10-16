import { api, ApiError } from "./api";
import type {
  ActChoice, WireBriefs, WireMyRatings, WireNextCard, WireNow, WireOpdDesk, WireProfessor, WireTower, WireUnitBoard, WireUnitReports, WorkRating,
} from "../../../../packages/contracts/src/doctor-desk";

/**
 * DD-0 (#626) — the wire of `doctor-desk.controller.ts`. The shapes live in
 * `packages/contracts/src/doctor-desk.ts`, shared with the server; this file decides nothing.
 */
export type {
  AttentionTab, BriefStage, WireAgentRun, WireAttentionRow, WireBrief, WireBriefFact, WireBriefs, WireDayLine,
  WireNextCard, WireOpdDesk, WireOwedRow, WireScheduleRow, WireTeamMember, WireTower,
  ActChoice, DeskLevel, WireDeskScope, WireHandledRow, WireMyRatings, WireNow, WirePersonWeek, WireProfessor, WireRateItem,
  WireUnitBoard, WireUnitOwedRow, WireUnitSummary, WorkRating, WireUnitReport, WireUnitReports,
} from "../../../../packages/contracts/src/doctor-desk";

export const fetchTower = () => api<WireTower>("GET", "/doctor-desk/tower");
export const fetchLanding = () => api<{ tower: boolean }>("GET", "/doctor-desk/landing");
export const fetchOpdDesk = () => api<WireOpdDesk>("GET", "/doctor-desk/opd");
export const fetchNextCard = (encounterId: string) => api<WireNextCard>("GET", `/doctor-desk/opd/next/${encodeURIComponent(encounterId)}`);
export const fetchBriefs = () => api<WireBriefs>("GET", "/doctor-desk/briefs");
export const nudgeRow = (rowKey: string) => api<{ nudgeId: string }>("POST", "/doctor-desk/clocks/nudge", { rowKey });
/* DD-1 — the unit board, move, act, the two phones, ratings. */
export const fetchUnitBoard = () => api<WireUnitBoard>("GET", "/doctor-desk/unit");
export const moveOwedRow = (rowKey: string, toUserId: string) => api<{ moveId: string }>("POST", "/doctor-desk/clocks/move", { rowKey, toUserId });
export const recordAct = (rowKey: string, choice: ActChoice, note: string | null) =>
  api<{ actId: string; minutes: number }>("POST", "/doctor-desk/acts", { rowKey, choice, note });
export const fetchNow = () => api<WireNow>("GET", "/doctor-desk/now");
export const fetchProfessor = () => api<WireProfessor>("GET", "/doctor-desk/professor");
export const rateWork = (workId: string, rating: WorkRating, reason: string | null) =>
  api<{ ratingId: string }>("POST", "/doctor-desk/ratings", { workKind: "opd_visit", workId, rating, reason });
/** DD-report v0 — the 08:00 unit reports the asker may read. */
export const fetchUnitReports = () => api<WireUnitReports>("GET", "/doctor-desk/reports");
export const fetchMyRatings = () => api<WireMyRatings>("GET", "/doctor-desk/ratings/mine");
/**
 * DD-1.6 — decision 0006's two toggles are #861's, stored by opd (`GET /opd/consult/copilot-settings`).
 * The Desk only reads them for its status line; a server without the route answers null (no line).
 */
export type CopilotToggles = { proactive: boolean; draftProse: boolean };
export const fetchCopilotToggles = async (): Promise<CopilotToggles | null> => {
  try { return await api<CopilotToggles>("GET", "/opd/consult/copilot-settings"); } catch { return null; }
};
export const markBriefSeen = (briefId: string) => api<void>("POST", `/doctor-desk/briefs/${encodeURIComponent(briefId)}/seen`);

type T = (k: string, o?: Record<string, unknown>) => string;

/** A refusal in the reader's language, from its code (`doctorDesk.refusal.<code>`), never the server's English. */
export function deskErrorText(e: unknown, t: T): string {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | undefined;
    const code = body !== undefined && typeof body.code === "string" ? body.code : null;
    if (code !== null) return t(`doctorDesk.refusal.${code}`, { defaultValue: t("doctorDesk.refusal.other", { code }) });
    if (e.status === 403) return t("doctorDesk.refusal.closed");
  }
  return t("doctorDesk.refusal.network");
}
