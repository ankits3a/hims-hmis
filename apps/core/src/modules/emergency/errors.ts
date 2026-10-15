import { ER_REFUSALS } from "@hmis/contracts";
import type { ErRefusalCode } from "@hmis/contracts";

/** The emergency module's non-refusal errors: a stable `code`, a sentence, and `detail`. */
export type ErErrorCode =
  /** An act by an actor who does not hold its permission (the route guard's check, re-made inside the intent). */
  | "er_forbidden"
  /** The `er_episode` workflow definition is not active yet (a go-live governance step activates it). */
  | "er_workflow_inactive";

export class ErError extends Error {
  constructor(readonly code: ErErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "ErError";
  }
}

/**
 * A REFUSED ER ACT (spec §0: no dead ends). `code` is a contract refusal code; `rule` and `fix` are its words from
 * `ER_REFUSALS`; `detail` carries the data (the open episode, the ward the patient lies on) — the words never do.
 */
export class ErRefusal extends Error {
  readonly rule: string;
  readonly fix: string;
  constructor(readonly code: ErRefusalCode, readonly detail?: Record<string, unknown>) {
    const words = ER_REFUSALS[code];
    super(words.rule);
    this.rule = words.rule;
    this.fix = words.fix;
    this.name = "ErRefusal";
  }
}

/** HTTP status of a refusal: unknown things 404, every other rule 409. */
export function erRefusalStatus(code: ErRefusalCode): number {
  return code.endsWith("_not_found") ? 404 : 409;
}
