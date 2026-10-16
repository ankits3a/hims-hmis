import { ApiError, api } from "./api";
import type { BedCleansView, HousekeepingBoardView } from "@hmis/contracts";

/* ═══ E1.4 HOUSEKEEPING (issue #721) — `apps/core/src/modules/housekeeping/housekeeping.controller.ts`. The paths
 * are the contract's `HOUSEKEEPING_ROUTES`, copied: the web bundle imports the contract package for TYPES only. ═══ */
const HOUSEKEEPING_ROUTES = {
  bedCleans: "/housekeeping/bed-cleans",
  board: "/housekeeping/board",
  verify: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/verify`,
  nudge: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/nudge`,
} as const;
/** The contract's `HOUSEKEEPING_KINDS.terminal`, copied for the same reason. */
export const TERMINAL_CLEAN_KIND = "bed_clean_terminal";

export type CleanAck = { id: string; state: string; version: number };

export const fetchBedCleans = () => api<BedCleansView>("GET", HOUSEKEEPING_ROUTES.bedCleans);
export const fetchHousekeepingBoard = () => api<HousekeepingBoardView>("GET", HOUSEKEEPING_ROUTES.board);
export const verifyCleanApi = (taskId: string, version?: number) =>
  api<CleanAck>("POST", HOUSEKEEPING_ROUTES.verify(taskId), version === undefined ? {} : { version });
export const nudgeCleanApi = (taskId: string) => api<CleanAck>("POST", HOUSEKEEPING_ROUTES.nudge(taskId), {});

/** The refusal a housekeeping or task door answered with: its code and the server's own fix, or null. */
export function cleanRefusal(e: unknown): { code: string; message: string; fix: string } | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body as { code?: unknown; message?: unknown; fix?: unknown } | null;
  if (typeof b?.code !== "string") return null;
  return { code: b.code, message: typeof b.message === "string" ? b.message : "", fix: typeof b.fix === "string" ? b.fix : "" };
}
