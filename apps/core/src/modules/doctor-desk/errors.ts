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
  | "unknown_visit";

const STATUS: Record<DoctorDeskErrorCode, number> = {
  not_unit_member: 403, already_nudged: 409, own_row: 400, unknown_row: 404, unknown_brief: 404, unknown_visit: 404,
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
