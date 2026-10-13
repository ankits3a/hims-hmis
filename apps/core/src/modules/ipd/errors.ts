import { IPD_REFUSALS } from "@hmis/contracts";
import type { IpdRefusalCode } from "@hmis/contracts";

/**
 * The ipd module's error vocabulary. Same shape as the other modules' errors: a stable `code` a caller
 * maps, a sentence a person reads, and `detail` carrying the data the sentence names.
 */
export type IpdErrorCode =
  /** A bed-layout file failed validation or disagrees with the registry; nothing was written. */
  | "bed_layout_invalid"
  /** `apply` by an actor who does not hold the bed-layout permission; nothing was written. */
  | "bed_layout_forbidden"
  /** E1.1 — a bed act by an actor who does not hold its permission (the route guard's check, re-made inside). */
  | "ipd_forbidden";

export class IpdError extends Error {
  constructor(
    readonly code: IpdErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IpdError";
  }
}

/**
 * E1.1 — A REFUSED IPD ACT (spec §0A principle 5: no dead ends). `code` is a contract refusal code; `rule` and `fix`
 * are its words from `IPD_REFUSALS`; `bedRule` names the bed's own rule when one refused ("Female-only bed").
 * `detail` carries data (the next three rule-valid beds, the live reservation) — the words never carry numbers.
 */
export class IpdRefusal extends Error {
  readonly rule: string;
  readonly fix: string;
  constructor(
    readonly code: IpdRefusalCode,
    readonly bedRule?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    const words = IPD_REFUSALS[code];
    super(bedRule === undefined ? words.rule : `${bedRule}: ${words.rule}`);
    this.rule = words.rule;
    this.fix = words.fix;
    this.name = "IpdRefusal";
  }
}

/** HTTP status of a refusal: unknown things 404, the duty-manager gate 403, every other rule 409. */
export function ipdRefusalStatus(code: IpdRefusalCode): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "overflow_needs_duty_manager") return 403;
  return 409;
}
