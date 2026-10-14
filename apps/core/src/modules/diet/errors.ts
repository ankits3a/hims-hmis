import { DIET_REFUSALS } from "@hmis/contracts";
import type { DietRefusalCode } from "@hmis/contracts";

/** A refused diet act: the contract code, its rule and its fix (spec IPD core §0A.5 — no dead ends). */
export class DietRefusal extends Error {
  readonly rule: string;
  readonly fix: string;
  constructor(readonly code: DietRefusalCode, readonly detail: Record<string, unknown> = {}) {
    super(DIET_REFUSALS[code].rule);
    this.name = "DietRefusal";
    this.rule = DIET_REFUSALS[code].rule;
    this.fix = DIET_REFUSALS[code].fix;
  }
}

export function dietHttpStatus(code: DietRefusalCode): number {
  if (code === "forbidden" || code === "nurse_npo_only") return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code === "bad_input" || code === "tube_feed_needs_volume" || code === "npo_end_before_start" || code === "cutoff_after_serve") return 400;
  return 409;
}
