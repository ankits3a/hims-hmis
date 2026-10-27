import { ICU_REFUSALS } from "@hmis/contracts";
import type { IcuRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the sentence a nurse reads, and the fix (no dead ends). */
export class IcuError extends Error {
  readonly fix: string;
  constructor(readonly code: IcuRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(ICU_REFUSALS[code].sentence);
    this.name = "IcuError";
    this.fix = ICU_REFUSALS[code].fix;
  }
}

export function icuHttpStatus(code: IcuRefusalCode): number {
  switch (code) {
    case "icu_forbidden":
    case "intensivist_only":
    case "own_request":
    case "gateway_agent_only":
    case "gateway_agent_mismatch": return 403;
    case "unknown_patient":
    case "unknown_request":
    case "unknown_device":
    case "unknown_band":
    case "unknown_hall":
    case "unknown_gateway":
    case "unknown_bed":
    case "unknown_admission":
    case "unknown_hour":
    case "unknown_alarm":
    case "unknown_line":
    case "unknown_bundle": return 404;
    case "bad_input":
    case "hour_not_mark":
    case "reason_required":
    case "not_icu_device": return 400;
    default: return 409;
  }
}
