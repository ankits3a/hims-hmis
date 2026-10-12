import { BMW_REFUSALS } from "@hmis/contracts";
import type { BmwRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the sentence a handler reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export class BmwError extends Error {
  readonly fix: string;
  constructor(readonly code: BmwRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(BMW_REFUSALS[code].sentence);
    this.name = "BmwError";
    this.fix = BMW_REFUSALS[code].fix;
  }
}

export function bmwHttpStatus(code: BmwRefusalCode): number {
  switch (code) {
    case "unknown_bag":
    case "unknown_manifest":
    case "unknown_dispute": return 404;
    case "already_weighed":
    case "wrong_state":
    case "already_handed_over":
    case "not_stored":
    case "already_recorded":
    case "dispute_closed": return 409;
    default: return 400;
  }
}
