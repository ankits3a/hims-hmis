import { HOUSEKEEPING_REFUSALS } from "@hmis/contracts";
import type { HousekeepingRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the rule a person reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export class HousekeepingRefusal extends Error {
  readonly fix: string;
  constructor(readonly code: HousekeepingRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(HOUSEKEEPING_REFUSALS[code].sentence);
    this.name = "HousekeepingRefusal";
    this.fix = HOUSEKEEPING_REFUSALS[code].fix;
  }
}

export function housekeepingHttpStatus(code: HousekeepingRefusalCode): number {
  switch (code) {
    case "terminal_needs_supervisor": return 403;
    case "not_a_clean": return 404;
    default: return 400;
  }
}
