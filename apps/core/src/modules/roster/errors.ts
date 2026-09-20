/**
 * PLAN 20 T1 — what the roster refuses, and why each refusal exists.
 *
 * Every message is written to be READ BY THE PERSON WHO MADE THE ROSTER (owner ruling RU-6,
 * 2026-09-20: "smooth and frictionless and lower learning curve") — it names the person, the window
 * and the thing to do about it. The code is for the client; the sentence is for the human.
 */
export const ROSTER_ERROR_CODES = [
  "not_permitted",
  "unknown_period",
  "unknown_assignment",
  "unknown_user",
  "unknown_role",
  "unknown_location",
  "invalid_window",
  "outside_period",
  "period_not_draft",
  "empty_period",
  "presence_overlap",
  "version_conflict",
] as const;

export type RosterErrorCode = (typeof ROSTER_ERROR_CODES)[number];

export class RosterError extends Error {
  constructor(
    readonly code: RosterErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `roster refused: ${code}`);
    this.name = "RosterError";
  }
}

const STATUS: Record<RosterErrorCode, number> = {
  not_permitted: 403,

  unknown_period: 404,
  unknown_assignment: 404,
  unknown_user: 404,
  unknown_role: 404,
  unknown_location: 404,

  invalid_window: 422,
  outside_period: 422,
  empty_period: 422,

  period_not_draft: 409,
  presence_overlap: 409,
  version_conflict: 409,
};

export function rosterHttpStatus(code: RosterErrorCode): number {
  return STATUS[code];
}
