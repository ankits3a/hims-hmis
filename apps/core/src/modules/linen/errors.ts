import { LINEN_REFUSALS } from "@hmis/contracts";
import type { LinenRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the sentence a handler reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export class LinenError extends Error {
  readonly fix: string;
  constructor(readonly code: LinenRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(LINEN_REFUSALS[code].sentence);
    this.name = "LinenError";
    this.fix = LINEN_REFUSALS[code].fix;
  }
}

export function linenHttpStatus(code: LinenRefusalCode): number {
  switch (code) {
    case "unknown_ward":
    case "unknown_item":
    case "unknown_batch":
    case "unknown_request":
    case "unknown_round":
    case "unknown_bag":
    case "unknown_bed":
    case "unknown_hold":
    case "unknown_machine":
    case "unknown_cycle":
    case "unknown_place": return 404;
    case "already_received":
    case "request_closed":
    case "at_par":
    case "key_reused":
    case "round_closed":
    case "bag_gone":
    case "tag_in_use":
    case "on_hold":
    case "hold_closed":
    case "code_taken":
    case "machine_down":
    case "machine_busy":
    case "cycle_finished":
    case "not_in_plant":
    case "not_at_qc":
    case "not_a_delivery":
    case "not_a_pickup":
    case "disinfection_missed": return 409;
    case "approver_is_requester":
    case "signer_is_runner":
    case "bad_pin":
    case "not_cssd":
    case "not_rso":
    case "released_by_clock": return 403;
    default: return 400;
  }
}
