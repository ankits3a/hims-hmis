import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances, workflowTransitions } from "../db/schema";
import { getActiveDefinition } from "./definitions";
import { parseDefinition } from "./definition";
import { actorHoldsAnyRole } from "./roles";
import { scheduleSlaTimer, cancelOpenTimers } from "./timers";
import type { Tx } from "../db/client";

export type WorkflowSubject = { type: string; id: string; patientId?: string; encounterId?: string };

export class WorkflowError extends Error {
  constructor(
    readonly code:
      | "unknown_instance"
      | "instance_not_active"
      | "no_active_definition"
      | "unknown_transition"
      | "role_denied"
      | "already_on_active_version"
      | "mapping_incomplete"
      | "mapping_unknown_state"
      | "stale_transition",
    message?: string,
  ) {
    super(message ?? `workflow engine refused: ${code}`);
    this.name = "WorkflowError";
  }
}

/**
 * Starts an instance of the ACTIVE definition version on the CALLER's transaction —
 * domain modules start workflows atomically with their own state change, the same
 * pattern as appendEvent. The instance is pinned to the definition version (§10.2).
 */
export async function startInstance(
  tx: Tx,
  defKey: string,
  subject: WorkflowSubject,
): Promise<{ instanceId: string; state: string }> {
  const active = await getActiveDefinition(tx, defKey);
  if (!active) throw new WorkflowError("no_active_definition", `no active definition for "${defKey}"`);
  const instanceId = newId();
  const now = new Date();
  const initial = active.parsed.initialState;
  await tx.insert(workflowInstances).values({
    id: instanceId,
    definitionId: active.id,
    defKey,
    currentState: initial,
    subjectType: subject.type,
    subjectId: subject.id,
    patientId: subject.patientId,
    encounterId: subject.encounterId,
    stateEnteredAt: now,
  });
  // initialState is never terminal (defineWorkflow rule), so it always carries an SLA.
  const initialSpec = active.parsed.states.find((s) => s.name === initial)!;
  await scheduleSlaTimer(tx, { instanceId, state: initial, sla: initialSpec.sla!, enteredAt: now });
  return { instanceId, state: initial };
}

/**
 * Moves an instance along a declared transition of its PINNED definition version.
 * §10.2: humans and agents run the same definitions — user actors must hold one of the
 * transition's allowed roles (any scope; org-master scoping is the marked seam);
 * system actors are the application's own automated moves and bypass the role check;
 * agent actors are denied until Plan 12's agent grants (same seam as PermissionGuard).
 */
export async function transition(
  tx: Tx,
  instanceId: string,
  to: string,
  actor: Actor,
  opts: { note?: string } = {},
): Promise<{ state: string; completed: boolean }> {
  const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
  const instance = rows[0];
  if (!instance) throw new WorkflowError("unknown_instance");
  if (instance.status !== "active") throw new WorkflowError("instance_not_active");

  const defRows = await tx
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, instance.definitionId));
  const def = parseDefinition(defRows[0]!.definition); // pinned version — never the newest

  const declared = def.transitions.find((t) => t.from === instance.currentState && t.to === to);
  if (!declared) {
    throw new WorkflowError("unknown_transition", `no transition ${instance.currentState}→${to} in ${instance.defKey} (pinned version)`);
  }

  if (actor.type === "user") {
    if (!(await actorHoldsAnyRole(tx, actor.id, declared.roles))) {
      throw new WorkflowError("role_denied", `transition ${instance.currentState}→${to} allows roles: ${declared.roles.join(", ")}`);
    }
  } else if (actor.type === "agent") {
    throw new WorkflowError("role_denied", "agent transitions arrive with Plan 12's agent grants");
  }

  const now = new Date();
  const target = def.states.find((s) => s.name === to)!;
  const completed = target.terminal === true;

  // Single-winner state move: conditional on the exact state we validated against, so
  // two concurrent transitions cannot both apply (multi-process-safe, no optimistic-
  // locking column needed). The UPDATE comes before any other write so the loser fails
  // fast and rolls back nothing.
  const updated = await tx
    .update(workflowInstances)
    .set({
      currentState: to,
      stateEnteredAt: now,
      status: completed ? "completed" : "active",
      endedAt: completed ? now : null,
    })
    .where(
      and(
        eq(workflowInstances.id, instanceId),
        eq(workflowInstances.status, "active"),
        eq(workflowInstances.currentState, instance.currentState),
      ),
    )
    .returning({ id: workflowInstances.id });
  if (updated.length === 0) {
    throw new WorkflowError("stale_transition", `instance ${instanceId} was moved concurrently`);
  }

  await cancelOpenTimers(tx, instanceId);
  await tx.insert(workflowTransitions).values({
    id: newId(),
    instanceId,
    fromState: instance.currentState,
    toState: to,
    actorType: actor.type,
    actorId: actor.id,
    note: opts.note,
  });
  if (!completed && target.sla) {
    await scheduleSlaTimer(tx, { instanceId, state: to, sla: target.sla, enteredAt: now });
  }
  return { state: to, completed };
}
