import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { approvalTypes } from "../db/schema";
import { getActiveDefinition } from "../workflow/definitions";
import { withTx } from "../db/client";
import { APPROVAL_DEF_PREFIX } from "./flow";
import type { Db, Tx } from "../db/client";

export const URGENCY_CLASSES = ["routine", "urgent", "emergency"] as const; // E-15 (owner decision 2026-08-13)
export type UrgencyClass = (typeof URGENCY_CLASSES)[number];

export type ApprovalErrorCode =
  | "unknown_type"
  | "duplicate_type"
  | "definition_not_active"
  | "definition_mismatch"
  | "user_actor_required"
  | "act_first_not_allowed"
  | "note_required"
  | "invalid_amount"
  | "amount_needs_target"
  | "invalid_cumulative_query"
  | "unknown_approval"
  | "not_pending";

/** Defined once here; T4/T5/T6 reuse it and the controller maps it once (Plan 03's WorkflowError convention). */
export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApprovalError";
  }
}

export type ApprovalTypeRow = typeof approvalTypes.$inferSelect;

export type ApprovalTypeSpec = {
  typeKey: string;
  title: string;
  approverRole: string;
  urgencyClass?: UrgencyClass;
  actFirstAllowed?: boolean;
};

/**
 * The E-18 registry: every request type names a reviewer role + closure SLA, structurally.
 * Registration is step 2 of a two-step flow — the approval_<typeKey> definition must already
 * be ACTIVE (drafted + activated through Plan 03's own governance APIs; Class C by default).
 * The registry validates the active definition carries the engine's load-bearing shape and
 * refuses otherwise; it never wraps or re-implements Plan 03 governance. No event is minted:
 * the definition lifecycle already emitted workflow.definition.updated.
 */
export async function registerApprovalType(
  db: Db,
  actor: Actor,
  spec: ApprovalTypeSpec,
): Promise<{ typeKey: string; defKey: string }> {
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may register approval types (agents are the Plan 12 seam)");
  }
  const defKey = `${APPROVAL_DEF_PREFIX}${spec.typeKey}`;
  return withTx(db, async (tx) => {
    const active = await getActiveDefinition(tx, defKey);
    if (!active) {
      throw new ApprovalError("definition_not_active", `no active workflow definition ${defKey} — draft and activate it first (T1 builder + Plan 03 APIs)`);
    }
    const def = active.parsed;
    const problems: string[] = [];
    if (def.initialState !== "pending") problems.push(`initialState must be "pending", got "${def.initialState}"`);
    const pending = def.states.find((s) => s.name === "pending");
    if (!pending?.sla) problems.push('state "pending" must carry an SLA (E-18 closure SLA)');
    for (const to of ["granted", "rejected"] as const) {
      const state = def.states.find((s) => s.name === to);
      if (!state?.terminal) problems.push(`state "${to}" must exist and be terminal`);
      const t = def.transitions.find((x) => x.from === "pending" && x.to === to);
      if (!t) problems.push(`missing transition pending→${to}`);
      else if (!t.roles.includes(spec.approverRole)) {
        problems.push(`approverRole "${spec.approverRole}" is not allowed on pending→${to}`);
      }
    }
    if (problems.length > 0) throw new ApprovalError("definition_mismatch", problems.join("; "));
    const inserted = await tx
      .insert(approvalTypes)
      .values({
        typeKey: spec.typeKey,
        title: spec.title,
        defKey,
        approverRole: spec.approverRole,
        urgencyClass: spec.urgencyClass ?? "routine",
        actFirstAllowed: spec.actFirstAllowed ?? false,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning({ typeKey: approvalTypes.typeKey });
    if (inserted.length === 0) {
      throw new ApprovalError("duplicate_type", `approval type ${spec.typeKey} already exists`);
    }
    return { typeKey: spec.typeKey, defKey };
  });
}

export async function getApprovalType(tx: Tx, typeKey: string): Promise<ApprovalTypeRow | null> {
  const rows = await tx.select().from(approvalTypes).where(eq(approvalTypes.typeKey, typeKey));
  return rows[0] ?? null;
}
