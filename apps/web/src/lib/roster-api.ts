import { api, ApiError } from "./api";
import type { WireRenderedDocument } from "./print-api";

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
export type BoardHoleKind = "no_take_cycle" | "take_gap" | "vacant_slot" | "absent_on_duty" | "skeleton_short";
export type WireBoardHole = {
  kind: BoardHoleKind; departmentId: string; departmentName: string; from: string; to: string;
  positionKey: string | null; positionLabel: string | null; userId: string | null; name: string | null;
  /** 20-U I5 — `skeleton_short` only: the strike day's uncovered duties, as one line. Null otherwise. */
  count: number | null;
};
/** The reader, for the Doctor Desk header — `month.ts` `rosterSelf`. Null fields: not posted to a unit now. */
export type WireRosterSelf = {
  name: string | null; grade: string | null; positionKey: string | null; unitName: string | null; departmentName: string | null;
};
export type WireOnNowBoard = {
  at: string; resolverEnabled: boolean; you: WireRosterSelf;
  departments: WireBoardDepartment[]; services: WireBoardService[]; holes: WireBoardHole[];
  /** 20-U U6 (I22) — open "this is wrong" flags. Optional: a board read before U6 carries none. */
  flags?: WireRosterFlag[];
  /** 20-U infra — the RECORD of the last scheduled print (20:00 / 08:00 IST). Optional: older servers send none. */
  lastPrint?: WireBoardPrint | null;
};

/**
 * 20-U infra (owner 2026-10-04) — `board-print.ts` `lastBoardPrint`. `outcome` is what the server
 * did (`no_printer`: no relay is granted the board's printer, nothing was queued); `copies.printed`
 * is paper a relay REPORTED, never the number queued.
 */
export type WireBoardPrint = {
  printId: string; slotAt: string; renderedAt: string; outcome: "queued" | "no_printer"; destinations: string[];
  copies: { queued: number; printed: number; waiting: number; failed: number };
  lastPrintedAt: string | null; nextAt: string;
};
/** One recorded board sheet as drawn at its instant — the house `{ html, title, page }` shape. */
export const fetchBoardPrintDocument = (printId: string) =>
  api<WireRenderedDocument>("GET", `/roster/board-prints/${encodeURIComponent(printId)}/document`);

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
  /* 20-U U6 — `youMay.cover`: the month is published and the reader may ask a cover for anybody's duty (`propose`). */
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
  youMay: { draft: boolean; edit: boolean; acceptWarning: boolean; publish: boolean; cover?: boolean };
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

/* ═══ 20-U U5c / U6 — my duties, covers and swaps, "this is wrong": `roster-board.controller.ts`'s
 * `/roster/my-duties`, `/roster/duties/:id/cover-options`, `/roster/covers…`, `/roster/flags…`,
 * transcribed from `apps/core/src/modules/roster/{swaps,my-duties}.ts`. ═══ */
export type WireDutyRef = {
  assignmentId: string; userId: string | null; positionKey: string; positionLabel: string;
  startsAt: string; endsAt: string; istDate: string; night: boolean; mode: string | null; kind: string;
  departmentId: string; teamId: string | null; teamName: string | null;
};
export type WireMyDuty = WireDutyRef & { activities: string[]; upcoming: boolean };
/** `unavailable` is approved leave, said as nothing more (D6); otherwise a validator rule key. */
export type WireCoverReason = { ruleKey: string; severity: "block" | "warn" | "unavailable"; params: Record<string, unknown> };
export type WireCoverStatus = "asked" | "accepted" | "declined" | "approved" | "refused" | "withdrawn";
export type WireCoverRequest = {
  requestId: string; kind: "cover" | "swap"; status: WireCoverStatus; crossUnit: boolean;
  owner: { userId: string; name: string }; counterpart: { userId: string; name: string }; requestedBy: { userId: string; name: string };
  duty: WireDutyRef; give: WireDutyRef | null;
  note: string | null; requestedAt: string; answeredAt: string | null;
  decidedBy: { userId: string; name: string } | null; decidedAt: string | null; refusedRule: string | null;
  check: WireCoverReason | null;
  youMay: { answer: boolean; approve: boolean; withdraw: boolean };
};
export type WireMyDuties = {
  at: string; days: string[]; you: WireRosterSelf; duties: WireMyDuty[];
  onTake: null | { teamId: string; name: string; endsAt: string };
  /** D6: the reader's unit SR on duty NOW, with a number when one is on file. */
  mySr: null | { userId: string; name: string; phone: string | null };
  requests: WireCoverRequest[];
};
export type WireCoverCandidate = {
  userId: string; name: string; grade: string; teamId: string; teamName: string; crossUnit: boolean;
  nextDay: { istDate: string; duty: null | { night: boolean; positionKey: string } };
  swaps: WireDutyRef[];
};
export type WireCoverRefusal = {
  userId: string; name: string; grade: string; teamId: string; teamName: string;
  reason: WireCoverReason; near: null | { istDate: string; night: boolean };
};
export type WireCoverOptions = {
  duty: WireDutyRef; ownerName: string; canTake: WireCoverCandidate[]; cannot: WireCoverRefusal[]; openRequestId: string | null;
};
export type WireRosterFlag = {
  flagId: string; departmentId: string | null; user: null | { userId: string; name: string };
  at: string; note: string; raisedBy: { userId: string; name: string }; raisedAt: string; youMayResolve: boolean;
};

export const fetchMyDuties = (at?: string) =>
  api<WireMyDuties>("GET", `/roster/my-duties${at === undefined ? "" : `?at=${encodeURIComponent(at)}`}`);
export const fetchCoverOptions = (assignmentId: string) =>
  api<WireCoverOptions>("GET", `/roster/duties/${encodeURIComponent(assignmentId)}/cover-options`);
export const fetchCoverRequests = (teamId?: string) =>
  api<WireCoverRequest[]>("GET", `/roster/covers${teamId === undefined ? "" : `?teamId=${encodeURIComponent(teamId)}`}`);
/** A cover; with `counterpartAssignmentId`, a swap (the duty they give back). */
export const askCover = (b: { assignmentId: string; counterpartId: string; counterpartAssignmentId?: string; note?: string }) =>
  api<{ requestId: string }>("POST", "/roster/covers", b);
export const answerCover = (requestId: string, accept: boolean) =>
  api<{ ok: true }>("POST", `/roster/covers/${encodeURIComponent(requestId)}/answer`, { accept });
export const decideCover = (requestId: string, approve: boolean) =>
  api<{ status: "approved" | "refused"; ruleKey: string | null }>("POST", `/roster/covers/${encodeURIComponent(requestId)}/decide`, { approve });
export const withdrawCover = (requestId: string) =>
  api<{ ok: true }>("POST", `/roster/covers/${encodeURIComponent(requestId)}/withdraw`);
export const raiseRosterFlag = (b: { departmentId: string | null; userId: string | null; at: string; note: string }) =>
  api<{ flagId: string }>("POST", "/roster/flags", b);
export const resolveRosterFlag = (flagId: string) =>
  api<{ ok: true }>("POST", `/roster/flags/${encodeURIComponent(flagId)}/resolve`);

/* ═══ 20-U I1 / I5 — holidays and skeleton cover: `GET /roster/declarations`, `POST /roster/holidays`,
 * `POST /roster/modes`, `POST /roster/modes/:id/withdraw` — transcribed from `declarations.ts`. ═══ */
export type HolidayKind = "gazetted" | "restricted" | "declared" | "local";
export type HolidayPattern = "as_sunday" | "opd_short" | "opd_off_ot_proceeds";
export type WireDeclaredHoliday = { istDate: string; kind: string; pattern: string; declaredByName: string | null; declaredAt: string };
export type WireDeclaredMode = {
  declarationId: string; departmentId: string | null; departmentName: string | null; mode: string;
  istDate: string; reason: string; declaredByName: string | null; declaredAt: string;
  withdrawnAt: string | null; withdrawnByName: string | null; withdrawReason: string | null;
};
export type WireDeclarationsView = {
  from: string; to: string;
  holidays: WireDeclaredHoliday[]; modes: WireDeclaredMode[];
  departments: { departmentId: string; code: string; name: string }[];
  youMay: { holiday: boolean; hospitalSkeleton: boolean; departmentSkeleton: boolean };
};
export const fetchDeclarations = () => api<WireDeclarationsView>("GET", "/roster/declarations");
export const declareHoliday = (istDate: string, kind: HolidayKind, pattern: HolidayPattern) =>
  api<WireDeclarationsView>("POST", "/roster/holidays", { istDate, kind, pattern });
/** `departmentId: null` — the whole hospital. */
export const declareSkeleton = (departmentId: string | null, istDate: string, reason: string) =>
  api<WireDeclarationsView>("POST", "/roster/modes", { departmentId, istDate, reason });
export const withdrawSkeleton = (declarationId: string, reason: string) =>
  api<WireDeclarationsView>("POST", `/roster/modes/${encodeURIComponent(declarationId)}/withdraw`, { reason });

/* ═══ 20-U I23 — the board as it stood: `GET /roster/as-it-stood?at=` — `as-it-stood.ts`. ═══ */
export type WireChangedSlot = { userId: string | null; name: string | null; positionKey: string; positionLabel: string; startsAt: string; endsAt: string };
export type WireAsItStoodChange = {
  kind: string; periodId: string; departmentId: string | null; departmentName: string | null;
  at: string; afterTheFact: boolean; byName: string | null; version: number | null;
  removed: WireChangedSlot[]; added: WireChangedSlot[];
};
export type WireAsItStoodBoard = WireOnNowBoard & { knownAt: string; changes: WireAsItStoodChange[] };
export const fetchAsItStood = (at: string) =>
  api<WireAsItStoodBoard>("GET", `/roster/as-it-stood?at=${encodeURIComponent(at)}`);

/* ═══ 20-U U7 — which unit (and which of its doctors) hold each OPD clinic on a day ═══ */

export type WireOpdUnitDoctor = { userId: string; name: string; role: "head" | "faculty" | "senior_resident" };
export type WireOpdUnit = {
  teamId: string; code: string; name: string; short: string; startsAt: string; endsAt: string; doctors: WireOpdUnitDoctor[];
};
/** One OPD clinic (`opdDepartmentId` — the id Desk One's department cards carry) and its unit(s) that day. */
export type WireOpdDepartmentUnits = { opdDepartmentId: string; departmentId: string; units: WireOpdUnit[] };

export const fetchOpdUnits = (date: string) =>
  api<WireOpdDepartmentUnits[]>("GET", `/roster/opd-units?date=${encodeURIComponent(date)}`);
