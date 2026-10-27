import { CANTEEN_REFUSALS } from "@hmis/contracts";
import type { CanteenRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the sentence a handler reads, and the fix (no dead ends). */
export class CanteenRefusal extends Error {
  readonly fix: string;
  constructor(readonly code: CanteenRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(CANTEEN_REFUSALS[code].sentence);
    this.name = "CanteenRefusal";
    this.fix = CANTEEN_REFUSALS[code].fix;
  }
}

export function canteenHttpStatus(code: CanteenRefusalCode): number {
  switch (code) {
    case "not_found": return 404;
    case "not_permitted":
    case "not_your_session":
    case "approver_is_cashier": return 403;
    case "duplicate_code":
    case "till_busy":
    case "session_closed":
    case "order_not_waiting":
    case "variance_not_pending":
    case "rent_already_issued": return 409;
    case "bed_qr_throttled": return 429;
    default: return 400;
  }
}
