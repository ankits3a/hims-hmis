import { HttpException } from "@nestjs/common";

/** The doctor-desk module's refusals (DD-0, #626). The web renders each from its code (`doctorDesk.refusal.<code>`). */
export type DoctorDeskErrorCode =
  /** The asker is not a member of the unit whose row they pressed. */
  | "not_unit_member"
  /** This sender already nudged this row (D7: once per row per sender). */
  | "already_nudged"
  /** The asker holds the row themselves. */
  | "own_row"
  /** No owed row by that key in the asker's unit now — it was done, or never theirs to see. */
  | "unknown_row"
  /** No brief by that id for this person. */
  | "unknown_brief"
  /** No such visit in the asker's OPD (another doctor's visit is not theirs to open here). */
  | "unknown_visit"
  /** DD-1.2 — only the unit's head (officiating included) or a senior resident moves a row. */
  | "not_allowed_to_move"
  /** DD-1.2 — the chosen person holds the row already. */
  | "same_holder"
  /** DD-1b — the chosen person may not see this restricted test (DD11), and a critical never leaves every list. */
  | "move_target_cannot_view"
  /** DD-1.3 — an act is already recorded on this row (once per row). */
  | "already_acted"
  /** DD-1.3 — this kind of row takes no act here (DD-1: lab criticals only). */
  | "not_actable"
  /** DD-1.3 / 1.7 — "Other" and "Needs rework" need a few words (3–200 characters). */
  | "note_required"
  /** DD-1.7 — the asker is not a senior of this resident's unit. */
  | "not_a_senior"
  /** DD-1.7 — nobody rates their own work. */
  | "self_rating"
  /** DD-1.7 — this rater already rated this work. */
  | "already_rated"
  /** DD-1.7 — no finished work by that id that the asker may rate. */
  | "unknown_work"
  /** #962 — the ward is not on this server (IPD switched off, decision 0085). */
  | "ward_closed"
  /** #962 — no admission by that id on the asker's unit or treating team (never says which). */
  | "unknown_admission";

const STATUS: Record<DoctorDeskErrorCode, number> = {
  not_unit_member: 403, already_nudged: 409, own_row: 400, unknown_row: 404, unknown_brief: 404, unknown_visit: 404,
  not_allowed_to_move: 403, same_holder: 400, move_target_cannot_view: 403, already_acted: 409, not_actable: 400, note_required: 400,
  not_a_senior: 403, self_rating: 400, already_rated: 409, unknown_work: 404, ward_closed: 404, unknown_admission: 404,
};

export class DoctorDeskError extends Error {
  constructor(readonly code: DoctorDeskErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DoctorDeskError";
  }
}

export function toHttp(e: unknown): never {
  if (e instanceof DoctorDeskError) {
    throw new HttpException({ statusCode: STATUS[e.code], message: e.message, code: e.code }, STATUS[e.code]);
  }
  throw e;
}
