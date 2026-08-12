import { and, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { getActiveDefinition } from "./definitions";
import { WorkflowError } from "./instances";
import { scheduleSlaTimer, cancelOpenTimers } from "./timers";
import { instanceMigrated, instanceAborted } from "./events";
import type { Db } from "../db/client";

// D-11 in-flight remediation. Gating in this plan = the workflow.instances.remediate
// permission at the route + the mandatory reason in the event. Routing these two ops
// through the approvals engine is the declared Plan 04 SEAM.

export async function migrateInstance(
  db: Db,
  actor: Actor,
  input: { instanceId: string; stateMapping: Record<string, string>; reason: string },
): Promise<{ toDefinitionId: string; toVersion: number; state: string }> {
  if (!input.reason || input.reason.trim() === "") {
    throw new WorkflowError("reason_required", "migrateInstance requires a non-empty reason");
  }
  return withTx(db, async (tx) => {
    const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, input.instanceId));
    const instance = rows[0];
    if (!instance) throw new WorkflowError("unknown_instance");
    if (instance.status !== "active") throw new WorkflowError("instance_not_active");

    const target = await getActiveDefinition(tx, instance.defKey);
    if (!target) throw new WorkflowError("no_active_definition");
    if (target.id === instance.definitionId) throw new WorkflowError("already_on_active_version");

    const mapped = input.stateMapping[instance.currentState];
    if (mapped === undefined) {
      throw new WorkflowError("mapping_incomplete", `stateMapping does not cover current state "${instance.currentState}"`);
    }
    for (const [from, to] of Object.entries(input.stateMapping)) {
      if (!target.parsed.states.some((s) => s.name === to)) {
        throw new WorkflowError("mapping_unknown_state", `mapped state "${to}" (from "${from}") is not in the target version`);
      }
    }
    const targetState = target.parsed.states.find((s) => s.name === mapped)!;

    const fromRows = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, instance.definitionId));
    const fromRow = fromRows[0]!;
    const now = new Date();
    const completed = targetState.terminal === true;

    // Single-winner, like transition(): the mapping was validated against
    // instance.currentState, so the move is conditional on it.
    const updated = await tx
      .update(workflowInstances)
      .set({
        definitionId: target.id,
        currentState: mapped,
        stateEnteredAt: now,
        status: completed ? "completed" : "active",
        endedAt: completed ? now : null,
      })
      .where(
        and(
          eq(workflowInstances.id, instance.id),
          eq(workflowInstances.status, "active"),
          eq(workflowInstances.currentState, instance.currentState),
        ),
      )
      .returning({ id: workflowInstances.id });
    if (updated.length === 0) {
      throw new WorkflowError("stale_transition", `instance ${instance.id} was moved concurrently`);
    }
    await cancelOpenTimers(tx, instance.id);
    if (!completed && targetState.sla) {
      await scheduleSlaTimer(tx, { instanceId: instance.id, state: mapped, sla: targetState.sla, enteredAt: now });
    }
    await appendEvent(
      tx,
      instanceMigrated.make({
        actor,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
        payload: {
          instanceId: instance.id,
          defKey: instance.defKey,
          fromDefinitionId: instance.definitionId,
          toDefinitionId: target.id,
          fromVersion: fromRow.version,
          toVersion: target.version,
          fromState: instance.currentState,
          toState: mapped,
          reason: input.reason,
        },
      }),
    );
    return { toDefinitionId: target.id, toVersion: target.version, state: mapped };
  });
}

export async function abortInstance(
  db: Db,
  actor: Actor,
  input: { instanceId: string; reason: string },
): Promise<void> {
  if (!input.reason || input.reason.trim() === "") {
    throw new WorkflowError("reason_required", "abortInstance requires a non-empty reason");
  }
  await withTx(db, async (tx) => {
    const rows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, input.instanceId));
    const instance = rows[0];
    if (!instance) throw new WorkflowError("unknown_instance");
    if (instance.status !== "active") throw new WorkflowError("instance_not_active");

    const now = new Date();
    // Conditional on status so a concurrent completion/abort loses cleanly; RETURNING
    // gives the state as of the locked row, which the event must record.
    const updated = await tx
      .update(workflowInstances)
      .set({ status: "aborted", endedAt: now })
      .where(and(eq(workflowInstances.id, instance.id), eq(workflowInstances.status, "active")))
      .returning({ currentState: workflowInstances.currentState });
    if (updated.length === 0) throw new WorkflowError("instance_not_active");
    await cancelOpenTimers(tx, instance.id);
    await appendEvent(
      tx,
      instanceAborted.make({
        actor,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
        payload: {
          instanceId: instance.id,
          defKey: instance.defKey,
          state: updated[0]!.currentState,
          reason: input.reason,
        },
      }),
    );
  });
}
