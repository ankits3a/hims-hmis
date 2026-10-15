import { api, ApiError } from "./api";
import type { WireBriefs, WireTower } from "../../../../packages/contracts/src/doctor-desk";

/**
 * DD-0 (#626) — the wire of `doctor-desk.controller.ts`. The shapes live in
 * `packages/contracts/src/doctor-desk.ts`, shared with the server; this file decides nothing.
 */
export type {
  AttentionTab, BriefStage, WireAgentRun, WireAttentionRow, WireBrief, WireBriefFact, WireBriefs, WireDayLine,
  WireOwedRow, WireScheduleRow, WireTeamMember, WireTower,
} from "../../../../packages/contracts/src/doctor-desk";

export const fetchTower = () => api<WireTower>("GET", "/doctor-desk/tower");
export const fetchLanding = () => api<{ tower: boolean }>("GET", "/doctor-desk/landing");
export const fetchBriefs = () => api<WireBriefs>("GET", "/doctor-desk/briefs");
export const nudgeRow = (rowKey: string) => api<{ nudgeId: string }>("POST", "/doctor-desk/clocks/nudge", { rowKey });
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
