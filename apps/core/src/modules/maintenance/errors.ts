import { MAINTENANCE_REFUSALS } from "@hmis/contracts";
import type { MaintenanceRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the rule a person reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export class MaintenanceRefusal extends Error {
  readonly fix: string;
  constructor(readonly code: MaintenanceRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(MAINTENANCE_REFUSALS[code].sentence);
    this.name = "MaintenanceRefusal";
    this.fix = MAINTENANCE_REFUSALS[code].fix;
  }
}

export function maintenanceHttpStatus(code: MaintenanceRefusalCode): number {
  switch (code) {
    case "forbidden": return 403;
    case "unknown_place":
    case "ticket_not_found": return 404;
    case "bad_input": return 400;
    default: return 409;
  }
}
