import type { Actor, TaskProof, TaskProofKind } from "@hmis/contracts";
import { TaskError } from "./errors";
import type { Tx } from "../../kernel/db/client";
import type { TaskRow } from "./engine";

/**
 * THE KIND REGISTRY. A kind is declared by the module that owns the work (housekeeping declares
 * `bed_clean`, bmw declares `waste_pickup` …) through `defineTaskKind`, at import time, exactly once.
 * The engine knows nothing about cleaning or waste: it knows windows, a skill, a ladder and a proof.
 */
export type TaskKindDecl = {
  kind: string;
  /** English label; the web translates `tasks.kind.<kind>` and falls back to this. */
  label: string;
  /** Who can do it — mapped to role codes by `SKILL_ROLES` / `defineSkill`. */
  skill: string;
  /** Assigned and not accepted within this many minutes → offered to the next worker. */
  acceptWithinMin: number;
  /** Default due time = raised + this many minutes. */
  doneWithinMin: number;
  /** The role whose holders are told when the task is late or its worker leaves. */
  escalateTo: string;
  proofNeeded: TaskProofKind;
  verifyRequired: boolean;
  /** The permission a verifier must hold — or a list, any one of which admits. Absent: `tasks.supervise`. */
  verifierPermission?: string | readonly string[];
  /**
   * Runs INSIDE `verifyTask`'s transaction, after the task is marked verified: the owning module's consequence
   * of a passed check (housekeeping makes the bed available). A throw rolls the verification back with it.
   */
  onVerified?: (tx: Tx, task: TaskRow, actor: Actor, now: Date) => Promise<void>;
  /**
   * E1.6 — the owning module's precondition for START, run INSIDE `startTask`'s transaction after the engine's own
   * checks and before the row moves. A throw (a `TaskKindRefusal`) refuses the start (transport: no escort for a
   * critical patient, oxygen cylinder not checked).
   */
  beforeStart?: (tx: Tx, task: TaskRow, actor: Actor, now: Date) => Promise<void>;
  /**
   * E1.6 — the owning module's precondition for DONE, run INSIDE `completeTask`'s transaction after the proof is
   * checked and before the row moves; it may write its own rows (transport records the wristband handover). A throw
   * refuses the completion and rolls those writes back.
   */
  beforeDone?: (tx: Tx, task: TaskRow, proof: TaskProof | undefined, actor: Actor, now: Date) => Promise<void>;
  /** Minutes past due at which each rung fires. Absent: `DEFAULT_LADDER_MIN`. */
  ladderMin?: readonly number[];
};

/** Rung 1 at the due time, rung 2 half an hour later. DECIDED: two rungs, both to the kind's `escalateTo`. */
export const DEFAULT_LADDER_MIN: readonly number[] = [0, 30];

const KINDS = new Map<string, TaskKindDecl>();

export function defineTaskKind(decl: TaskKindDecl): TaskKindDecl {
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(decl.kind)) throw new Error(`task kind "${decl.kind}" is not a lower_snake key`);
  if (KINDS.has(decl.kind)) throw new Error(`task kind "${decl.kind}" is declared twice`);
  if (decl.acceptWithinMin <= 0 || decl.doneWithinMin <= 0) throw new Error(`task kind "${decl.kind}" needs positive windows`);
  const ladder = decl.ladderMin ?? DEFAULT_LADDER_MIN;
  if (ladder.length === 0 || ladder.some((m, i) => m < 0 || (i > 0 && m <= ladder[i - 1]!))) {
    throw new Error(`task kind "${decl.kind}" has a ladder that is not strictly rising`);
  }
  if (Array.isArray(decl.verifierPermission) && decl.verifierPermission.length === 0) {
    throw new Error(`task kind "${decl.kind}" names an empty verifier list`);
  }
  const frozen = Object.freeze({ ...decl, ladderMin: Object.freeze([...ladder]) });
  KINDS.set(decl.kind, frozen);
  return frozen;
}

export function taskKind(kind: string): TaskKindDecl | undefined {
  return KINDS.get(kind);
}

export function requireTaskKind(kind: string): TaskKindDecl {
  const decl = KINDS.get(kind);
  if (decl === undefined) throw new TaskError("unknown_kind", { kind });
  return decl;
}

/** The permissions any one of which lets a person verify a task of this kind. */
export function verifierPermissionsOf(decl: TaskKindDecl | undefined): readonly string[] {
  const p = decl?.verifierPermission;
  if (p === undefined) return ["tasks.supervise"];
  return typeof p === "string" ? [p] : p;
}

export function taskKinds(): TaskKindDecl[] {
  return [...KINDS.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * SKILL → ROLE CODES. The roster has no skill concept (it rosters POSITIONS for doctors and nurses),
 * so a skill is the RBAC roles that may do the work. DECIDED (brief §7). An owning module adds its
 * own skill with `defineSkill` beside its kind.
 */
const SKILL_ROLES = new Map<string, readonly string[]>([["general", ["support_staff"]]]);

export function defineSkill(skill: string, roleKeys: readonly string[]): void {
  if (SKILL_ROLES.has(skill)) throw new Error(`task skill "${skill}" is declared twice`);
  SKILL_ROLES.set(skill, Object.freeze([...roleKeys]));
}

export function skillRoles(skill: string): readonly string[] {
  return SKILL_ROLES.get(skill) ?? [];
}

export function allSkills(): string[] {
  return [...SKILL_ROLES.keys()];
}

/** The role that supervises service work: told of late and orphaned tasks. Seeded by `scripts/seed-roles.ts`. */
export const SERVICES_SUPERVISOR_ROLE = "services_supervisor";
/** The role that takes and does generic tasks. */
export const SUPPORT_STAFF_ROLE = "support_staff";

/** The one generic kind this engine ships with. */
export const GENERAL_TASK = defineTaskKind({
  kind: "general",
  label: "General task",
  skill: "general",
  acceptWithinMin: 5,
  doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "none",
  verifyRequired: false,
});
