import { PASS_REFUSALS } from "@hmis/contracts";
import type { PassRefusalCode } from "@hmis/contracts";

/** A refused pass act: the contract code, its rule and its fix (spec §0A principle 5: no dead ends). */
export class PassRefusal extends Error {
  readonly rule: string;
  readonly fix: string;
  constructor(readonly code: PassRefusalCode, readonly detail?: Record<string, unknown>) {
    const words = PASS_REFUSALS[code];
    super(words.rule);
    this.rule = words.rule;
    this.fix = words.fix;
    this.name = "PassRefusal";
  }
}

/** An act by someone without its permission (the route guard's check, re-made inside). */
export class PassForbidden extends Error {
  constructor(readonly permission: string) {
    super(`this act needs the permission ${permission}`);
    this.name = "PassForbidden";
  }
}

export function passRefusalStatus(code: PassRefusalCode): number {
  return code.endsWith("_not_found") ? 404 : 409;
}
