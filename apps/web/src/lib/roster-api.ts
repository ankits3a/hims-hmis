import { api, ApiError } from "./api";

/**
 * 20-U U5a — the wire contract of `roster-board.controller.ts` (`GET /roster/on-now`), transcribed
 * from `apps/core/src/modules/roster/board.ts` (the `radiology-hod-api.ts` rule: this file describes
 * what the route ships and decides nothing). Instants are ISO strings on the wire.
 */
export type RosterSource = "published" | "pattern" | "static";

export type WireBoardPerson = { userId: string; name: string; positionKey: string; positionLabel: string; cadre: string };
export type WireBoardRung = { userId: string | null; name: string | null; positionKey: string; positionLabel: string; callTier: number | null };
export type WireBoardUnit = { teamId: string; code: string; name: string; startsAt: string; endsAt: string };
export type WireBoardDepartment = {
  departmentId: string; code: string; name: string; units: number; source: RosterSource; skeleton: boolean;
  unitOnTake: WireBoardUnit | null; backupUnit: WireBoardUnit | null;
  inTheBuilding: WireBoardPerson[]; facultyOnCall: WireBoardRung[];
};
export type WireBoardService = {
  positionKey: string; positionLabel: string; cadre: string; source: RosterSource;
  people: { userId: string; name: string; departmentId: string | null }[];
};
export type BoardHoleKind = "no_take_cycle" | "take_gap" | "vacant_slot" | "absent_on_duty";
export type WireBoardHole = {
  kind: BoardHoleKind; departmentId: string; departmentName: string; from: string; to: string;
  positionKey: string | null; positionLabel: string | null; userId: string | null; name: string | null;
};
export type WireOnNowBoard = {
  at: string; resolverEnabled: boolean;
  departments: WireBoardDepartment[]; services: WireBoardService[]; holes: WireBoardHole[];
};

/** `at` omitted is the server's now. */
export const fetchOnNowBoard = (at?: string) =>
  api<WireOnNowBoard>("GET", `/roster/on-now${at === undefined ? "" : `?at=${encodeURIComponent(at)}`}`);

/** A refusal as a sentence: 403 is the locale's own; anything else is the server's message. */
export function rosterErrorText(e: unknown, t: (key: string) => string): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return t("rosterOnNow.forbidden");
    const body = e.body as { message?: unknown } | undefined;
    return body !== undefined && typeof body.message === "string" ? body.message : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
