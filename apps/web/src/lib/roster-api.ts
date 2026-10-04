import { api, ApiError } from "./api";

/**
 * 20-U U5a — the wire contract of `roster-board.controller.ts` (`GET /roster/on-now`), transcribed
 * from `apps/core/src/modules/roster/board.ts` (the `radiology-hod-api.ts` rule: this file describes
 * what the route ships and decides nothing). Instants are ISO strings on the wire.
 */
export type RosterSource = "published" | "pattern" | "static";

/** `phone` — D6: only a person in the building now carries one (null when none is on file). */
export type WireBoardPerson = { userId: string; name: string; positionKey: string; positionLabel: string; cadre: string; phone: string | null };
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
/** The reader, for the Doctor Desk header — `month.ts` `rosterSelf`. Null fields: not posted to a unit now. */
export type WireRosterSelf = {
  name: string | null; grade: string | null; positionKey: string | null; unitName: string | null; departmentName: string | null;
};
export type WireOnNowBoard = {
  at: string; resolverEnabled: boolean; you: WireRosterSelf;
  departments: WireBoardDepartment[]; services: WireBoardService[]; holes: WireBoardHole[];
};

/** `at` omitted is the server's now. */
export const fetchOnNowBoard = (at?: string) =>
  api<WireOnNowBoard>("GET", `/roster/on-now${at === undefined ? "" : `?at=${encodeURIComponent(at)}`}`);

/** The roster's refusal `code` (`roster-http.ts` ships `{ statusCode, message, code }`), or null. */
export function rosterErrorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | undefined;
  return body !== undefined && typeof body.code === "string" ? body.code : null;
}

/**
 * A refusal as a sentence IN THE READER'S LANGUAGE, from its `code` (`roster.refusal.<code>`), never
 * the server's English. 403 without a code is the board's own "closed to you"; a code this screen
 * has no sentence for falls back to `roster.refusal.other`, naming the code so it can be reported.
 */
export function rosterErrorText(e: unknown, t: (key: string, o?: Record<string, unknown>) => string): string {
  const code = rosterErrorCode(e);
  if (code !== null) return t(`roster.refusal.${code}`, { defaultValue: t("roster.refusal.other", { code }) });
  if (e instanceof ApiError && e.status === 403) return t("rosterOnNow.forbidden");
  if (e instanceof ApiError) return t("roster.refusal.other", { code: String(e.status) });
  return t("roster.refusal.network");
}

/** 409 / 404 from a write: the month moved under the reader — refetch it and say so. */
export function isStaleWrite(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 409 || e.status === 404);
}

/* ═══ 20-U U5b — the unit's month: `roster-board.controller.ts`'s `/roster/units…`, `/roster/slots…`,
 * `/roster/periods…`, transcribed from `apps/core/src/modules/roster/month.ts`. ═══ */
export type WireRosterUnitsDepartment = {
  departmentId: string; code: string; name: string;
  units: { teamId: string; code: string; name: string; confirmed: boolean }[];
};
export type WireMonthAssignment = {
  assignmentId: string; userId: string | null; name: string | null; positionKey: string;
  startsAt: string; endsAt: string; istDate: string; night: boolean; mode: string | null; kind: string;
};
export type WireMonthFinding = {
  ruleKey: string; severity: "block" | "warn" | "info"; userId: string | null; name: string | null;
  assignmentId: string | null; istDate: string | null; params: Record<string, unknown>;
  blocking: boolean; accepted: null | { byName: string; at: string; reason: string };
};
export type WireUnitMonth = {
  unit: { teamId: string; code: string; name: string; confirmed: boolean; departmentId: string; departmentName: string };
  month: string; startsAt: string; endsAt: string; days: string[];
  period: null | {
    periodId: string; version: number; status: string; origin: string; title: string;
    contentHash: string; publishedAt: string | null;
  };
  positions: { key: string; label: string }[];
  people: { userId: string; name: string; positionKey: string; grade: string; postedFrom: string | null; postedTo: string | null }[];
  assignments: WireMonthAssignment[];
  findings: WireMonthFinding[];
  counts: { blocking: number; warnings: number; info: number };
  fairness: { userId: string; name: string; nights: number; sundays: number; holidays: number }[];
  unitDays: { istDate: string; activities: string[]; take: boolean; overlay: boolean }[];
  holidays: { istDate: string; kind: string; pattern: string }[];
  /** Approved absences, IST days inclusive; the kind, never the reason (D6). */
  leave: { userId: string; kind: string; from: string; to: string }[];
  you: WireRosterSelf;
  youMay: { draft: boolean; edit: boolean; acceptWarning: boolean; publish: boolean };
};

export const fetchRosterUnits = () => api<WireRosterUnitsDepartment[]>("GET", "/roster/units");
export const fetchUnitMonth = (teamId: string, month: string) =>
  api<WireUnitMonth>("GET", `/roster/units/${encodeURIComponent(teamId)}/months/${encodeURIComponent(month)}`);
export const draftUnitMonth = (teamId: string, month: string) =>
  api<WireUnitMonth>("POST", `/roster/units/${encodeURIComponent(teamId)}/months/${encodeURIComponent(month)}/draft`);
/** `userId: null` leaves the duty vacant — a declared hole. */
export const editRosterSlot = (assignmentId: string, userId: string | null) =>
  api<WireUnitMonth>("PUT", `/roster/slots/${encodeURIComponent(assignmentId)}`, { userId });
export const acceptRosterFinding = (
  periodId: string, f: { ruleKey: string; assignmentId: string | null; userId: string | null }, reason: string,
) => api<WireUnitMonth>("POST", `/roster/periods/${encodeURIComponent(periodId)}/findings/accept`, { ...f, reason });
/** V4: publish what was read — the hash the month came with. */
export const publishUnitMonth = (periodId: string, expectedContentHash: string) =>
  api<WireUnitMonth>("POST", `/roster/periods/${encodeURIComponent(periodId)}/publish`, { expectedContentHash });
