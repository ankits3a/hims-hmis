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
    case "unknown_request": return 404;
    case "already_received":
    case "request_closed":
    case "at_par": return 409;
    case "approver_is_requester": return 403;
    default: return 400;
  }
}
