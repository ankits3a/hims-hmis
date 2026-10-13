import { TRANSPORT_REFUSALS } from "@hmis/contracts";
import { TaskKindRefusal } from "../tasks";
import type { TransportRefusalCode } from "@hmis/contracts";

export function transportHttpStatus(code: TransportRefusalCode): number {
  switch (code) {
    case "not_transport": return 404;
    case "escort_required":
    case "oxygen_not_checked":
    case "already_started":
    case "wrong_patient":
    case "band_void": return 409;
    default: return 400;
  }
}

/**
 * A refusal: the code, the rule a person reads, and the fix (spec IPD core §0A.5 — no dead ends). A `TaskKindRefusal`,
 * so a refusal raised inside the engine's start or done (the kind hooks) answers through the `/tasks` doors too.
 */
export class TransportRefusal extends TaskKindRefusal {
  constructor(readonly code: TransportRefusalCode, details: Record<string, unknown> = {}) {
    super(code, TRANSPORT_REFUSALS[code].sentence, TRANSPORT_REFUSALS[code].fix, transportHttpStatus(code), details);
    this.name = "TransportRefusal";
  }
}
