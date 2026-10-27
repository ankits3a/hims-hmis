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
    case "not_a_clean":
    case "unknown_area":
    case "unknown_checklist":
    case "unknown_contractor":
    case "unknown_rota":
    case "unknown_inspection": return 404;
    case "bad_qr": return 401;
    case "too_many_requests": return 429;
    case "contractor_exists":
    case "rota_published":
    case "inspection_done":
    case "store_taken":
    case "work_missing": return 409;
    default: return 400;
  }
}
