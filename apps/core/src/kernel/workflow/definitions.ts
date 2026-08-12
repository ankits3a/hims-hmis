import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { defineWorkflow, parseDefinition } from "./definition";
import type { ChangeClass, WorkflowDefinition } from "./definition";
import { workflowDefinitionUpdated } from "./events";
import type { Db, Tx } from "../db/client";
import { workflowDefinitionApprovals } from "../db/schema";
import { assertNotSodPair } from "../auth/sod";
import { actorHoldsAnyRole } from "./roles";

export type DefinitionRow = typeof workflowDefinitions.$inferSelect;

export async function createDraft(
  db: Db,
  actor: Actor,
  defJson: unknown,
): Promise<{ definitionId: string; defKey: string; version: number }> {
  const def = defineWorkflow(defJson); // throws WorkflowValidationError before any write
  const definitionId = newId();
  const version = await withTx(db, async (tx) => {
    const latest = await tx
      .select({ version: workflowDefinitions.version })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.defKey, def.key))
      .orderBy(desc(workflowDefinitions.version))
      .limit(1);
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx.insert(workflowDefinitions).values({
      id: definitionId,
      defKey: def.key,
      version: nextVersion,
      title: def.title,
      changeClass: def.changeClass,
      definition: def,
      draftedBy: actor.id,
    });
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId,
          defKey: def.key,
          version: nextVersion,
          changeClass: def.changeClass as ChangeClass,
          action: "drafted",
        },
      }),
    );
    return nextVersion;
  });
  return { definitionId, defKey: def.key, version };
}

export async function getActiveDefinition(
  tx: Tx,
  defKey: string,
): Promise<(DefinitionRow & { parsed: WorkflowDefinition }) | null> {
  const rows = await tx
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.defKey, defKey), eq(workflowDefinitions.status, "active")));
  const row = rows[0];
  if (!row) return null;
  return { ...row, parsed: parseDefinition(row.definition) };
}

export async function listDefinitions(db: Db, defKey: string): Promise<DefinitionRow[]> {
  return db
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.defKey, defKey))
    .orderBy(desc(workflowDefinitions.version));
}

export type ChangeClassPolicy = { requiredRoles: string[]; emergencyRoles: string[] | null };

/**
 * D-15 change classes. Role keys are governance conventions — the roles themselves are
 * deployment data (created via createRole/assignRole); tests create them explicitly.
 * Class A: clinical-safety/money/statutory config — owner + MS two-key; the E-5 emergency
 * path (owner unreachable, D-10) is duty manager + MS, loudly flagged.
 * Class B: operational thresholds within pre-approved bands — department head + duty manager.
 * Class C: routine master-data — automated with sampled audit (zero approvals).
 */
export const CHANGE_CLASS_POLICY: Record<ChangeClass, ChangeClassPolicy> = {
  A: {
    requiredRoles: ["owner", "medical_superintendent"],
    emergencyRoles: ["duty_manager", "medical_superintendent"],
  },
  B: { requiredRoles: ["department_head", "duty_manager"], emergencyRoles: null },
  C: { requiredRoles: [], emergencyRoles: null },
};

export class GovernanceError extends Error {
  constructor(
    readonly code:
      | "actor_not_user"
      | "unknown_definition"
      | "not_draft"
      | "role_not_in_policy"
      | "approver_lacks_role"
      | "duplicate_approval"
      | "approvals_missing",
    message?: string,
  ) {
    super(message ?? `workflow governance refused: ${code}`);
    this.name = "GovernanceError";
  }
}

async function loadDraft(db: Db, definitionId: string): Promise<DefinitionRow> {
  const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definitionId));
  const row = rows[0];
  if (!row) throw new GovernanceError("unknown_definition");
  if (row.status !== "draft") throw new GovernanceError("not_draft");
  return row;
}

/**
 * PLAN 04 SEAM (stated, not built): when the approvals engine ships, definition activation
 * routes through it (§10.4). These inline approval records are the interim mechanism and
 * remain the storage that engine will drive.
 */
export async function approveDefinition(
  db: Db,
  actor: Actor,
  input: { definitionId: string; roleKey: string; note: string; emergency?: boolean },
): Promise<void> {
  if (actor.type !== "user") throw new GovernanceError("actor_not_user");
  const row = await loadDraft(db, input.definitionId);
  const policy = CHANGE_CLASS_POLICY[row.changeClass as ChangeClass];
  const allowedRoles = input.emergency === true ? policy.emergencyRoles : policy.requiredRoles;
  if (allowedRoles === null || !allowedRoles.includes(input.roleKey)) {
    throw new GovernanceError("role_not_in_policy");
  }
  await withTx(db, async (tx) => {
    if (!(await actorHoldsAnyRole(tx, actor.id, [input.roleKey]))) {
      throw new GovernanceError("approver_lacks_role");
    }
    const existing = await tx
      .select({ id: workflowDefinitionApprovals.id })
      .from(workflowDefinitionApprovals)
      .where(
        and(
          eq(workflowDefinitionApprovals.definitionId, input.definitionId),
          eq(workflowDefinitionApprovals.approverId, actor.id),
        ),
      );
    if (existing.length > 0) throw new GovernanceError("duplicate_approval");
    await tx.insert(workflowDefinitionApprovals).values({
      id: newId(),
      definitionId: input.definitionId,
      approverId: actor.id,
      roleKey: input.roleKey,
      emergency: input.emergency === true,
      note: input.note,
    });
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: row.id,
          defKey: row.defKey,
          version: row.version,
          changeClass: row.changeClass as ChangeClass,
          action: "approved",
          emergency: input.emergency === true ? true : undefined,
        },
      }),
    );
  });
}

export async function activateDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
): Promise<{ retiredVersion: number | null }> {
  if (actor.type !== "user") throw new GovernanceError("actor_not_user");
  const row = await loadDraft(db, definitionId);
  const policy = CHANGE_CLASS_POLICY[row.changeClass as ChangeClass];

  const approvals = await db
    .select()
    .from(workflowDefinitionApprovals)
    .where(eq(workflowDefinitionApprovals.definitionId, definitionId));
  const normalRoles = new Set(approvals.filter((a) => !a.emergency).map((a) => a.roleKey));
  const emergencyRoles = new Set(approvals.filter((a) => a.emergency).map((a) => a.roleKey));
  const normalSatisfied = policy.requiredRoles.every((r) => normalRoles.has(r));
  const emergencySatisfied =
    policy.emergencyRoles !== null && policy.emergencyRoles.every((r) => emergencyRoles.has(r));
  if (!normalSatisfied && !emergencySatisfied) {
    const missing = policy.requiredRoles.filter((r) => !normalRoles.has(r));
    throw new GovernanceError("approvals_missing", `missing approvals: ${missing.join(", ")}`);
  }
  const viaEmergency = !normalSatisfied && emergencySatisfied;

  // Drafter ≠ activator (S10 §11 pair, seeded in Plan 02) — EXCEPT on the emergency
  // two-key path, which supersedes this pair by declared precedence (E-5). The drafter
  // actor is reconstructed as a user: agent drafters are the Plan 12 seam.
  if (!viaEmergency) {
    await assertNotSodPair(db, "workflow_drafter_activator", { type: "user", id: row.draftedBy }, actor);
  }

  return withTx(db, async (tx) => {
    const retired = await tx
      .update(workflowDefinitions)
      .set({ status: "retired", retiredAt: new Date() })
      .where(and(eq(workflowDefinitions.defKey, row.defKey), eq(workflowDefinitions.status, "active")))
      .returning({ version: workflowDefinitions.version });
    const retiredVersion = retired[0]?.version ?? null;
    await tx
      .update(workflowDefinitions)
      .set({ status: "active", activatedBy: actor.id, activatedAt: new Date() })
      .where(eq(workflowDefinitions.id, definitionId));
    await appendEvent(
      tx,
      workflowDefinitionUpdated.make({
        actor,
        payload: {
          definitionId: row.id,
          defKey: row.defKey,
          version: row.version,
          changeClass: row.changeClass as ChangeClass,
          action: "activated",
          emergency: viaEmergency ? true : undefined,
          retiredVersion: retiredVersion ?? undefined,
        },
      }),
    );
    return { retiredVersion };
  });
}
