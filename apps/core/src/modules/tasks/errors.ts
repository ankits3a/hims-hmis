import { TASK_REFUSALS } from "@hmis/contracts";
import type { TaskRefusalCode } from "@hmis/contracts";

/** A refusal: the code, the sentence a worker reads, and the fix (spec IPD core §0A.5 — no dead ends). */
export class TaskError extends Error {
  readonly fix: string;
  constructor(readonly code: TaskRefusalCode, readonly details: Record<string, unknown> = {}) {
    super(TASK_REFUSALS[code].sentence);
    this.name = "TaskError";
    this.fix = TASK_REFUSALS[code].fix;
  }
}

export function taskHttpStatus(code: TaskRefusalCode): number {
  switch (code) {
    case "not_found": return 404;
    case "not_yours":
    case "verifier_is_doer":
    case "not_permitted": return 403;
    case "already_taken":
    case "wrong_state":
    case "not_open":
    case "stale": return 409;
    default: return 400;
  }
}

/**
 * E1.6 — a refusal raised by an owning module's kind hook (`beforeStart`, `beforeDone`): the module's own code,
 * sentence and fix, carried through the engine's doors with the same `{ code, message, fix }` wire shape.
 */
export class TaskKindRefusal extends Error {
  constructor(
    readonly code: string, message: string, readonly fix: string, readonly httpStatus: number = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TaskKindRefusal";
  }
}
