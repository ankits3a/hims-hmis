import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { workflowTimers } from "../db/schema";
import type { SlaSpec } from "./definition";
import type { Tx } from "../db/client";
import { asc, lte } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { parseDefinition } from "./definition";
import { usersHoldingRole } from "./roles";
import { slaBreached, escalationTriggered } from "./events";
import type { Db } from "../db/client";

// Timers are ROWS, never processes (roadmap trap: survive restarts; no setTimeout).
// Nothing here schedules execution — runDueTimers is invoked by tests directly and, since
// Plan 08.5, by the worker process's own scheduler (kernel/worker/jobs.ts), every
// WORKER_TIMERS_INTERVAL_MS.

export async function scheduleSlaTimer(
  tx: Tx,
  input: { instanceId: string; state: string; sla: SlaSpec; enteredAt: Date },
): Promise<{ timerId: string; dueAt: Date }> {
  const timerId = newId();
  const dueAt = new Date(input.enteredAt.getTime() + input.sla.minutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "sla",
    dueAt,
  });
  return { timerId, dueAt };
}

export async function scheduleEscalationTimer(
  tx: Tx,
  input: { instanceId: string; state: string; rung: number; afterMinutes: number; from: Date },
): Promise<{ timerId: string; dueAt: Date }> {
  const timerId = newId();
  const dueAt = new Date(input.from.getTime() + input.afterMinutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "escalation",
    rung: input.rung,
    dueAt,
  });
  return { timerId, dueAt };
}

/** Cancels every open (unfired, uncancelled) timer of an instance. Returns the count. */
export async function cancelOpenTimers(tx: Tx, instanceId: string): Promise<number> {
  const rows = await tx
    .update(workflowTimers)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    )
    .returning({ id: workflowTimers.id });
  return rows.length;
}

/** §11.19-C fix 11: a ladder never dead-ends silently — duty manager catches empty rungs. */
export const DUTY_MANAGER_ROLE = "duty_manager";

const TIMER_ACTOR: Actor = { type: "system", id: "workflow-timer" };

/**
 * Fires every due, unfired, uncancelled timer. RUNS ON A CLOCK as of Plan 08.5: the worker
 * process's scheduler ticks it every WORKER_TIMERS_INTERVAL_MS (kernel/worker/jobs.ts),
 * alongside runDispatchCycle and sweepExpiredTempRoles — the 2026-08-12 owner ruling that left
 * this unscheduled is superseded (Plan 08.5 owns the worker; Plan 11 productionises it, spec §2
 * v4.3). Idempotent and multi-process-safe regardless: each timer is claimed with a conditional
 * UPDATE…RETURNING in its own transaction before anything is emitted; two concurrent callers —
 * including two overlapping scheduler ticks — cannot double-fire. One call fires one rung per
 * escalation chain; repeated calls drain a backlog, including the backlog that accumulates while
 * the worker is down (Global Constraint 1: the worker is never load-bearing for a human flow).
 */
export async function runDueTimers(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: workflowTimers.id })
    .from(workflowTimers)
    .where(and(lte(workflowTimers.dueAt, now), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)))
    .orderBy(asc(workflowTimers.dueAt));

  let fired = 0;
  for (const { id } of due) {
    const didFire = await withTx(db, async (tx) => {
      const claimed = await tx
        .update(workflowTimers)
        .set({ firedAt: now })
        .where(and(eq(workflowTimers.id, id), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)))
        .returning();
      const timer = claimed[0];
      if (!timer) return false; // cancelled or claimed by another process since the scan

      const instRows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, timer.instanceId));
      const instance = instRows[0]!;
      const defRows = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, instance.definitionId));
      const defRow = defRows[0]!;
      const def = parseDefinition(defRow.definition);
      const state = def.states.find((s) => s.name === timer.state)!;
      const sla = state.sla!; // timers only exist for SLA-carrying states
      const ladder = sla.escalation ?? [];
      const envelope = {
        actor: TIMER_ACTOR,
        correlationId: instance.id,
        patientId: instance.patientId ?? undefined,
        encounterId: instance.encounterId ?? undefined,
      };

      if (timer.kind === "sla") {
        await appendEvent(
          tx,
          slaBreached.make({
            ...envelope,
            payload: {
              instanceId: instance.id,
              defKey: instance.defKey,
              definitionVersion: defRow.version,
              state: timer.state,
              slaMinutes: sla.minutes,
              alerting: sla.alerting,
              dueAt: timer.dueAt.toISOString(),
            },
          }),
        );
        // §10.3: every breach is recorded; only active-alerting states escalate.
        if (sla.alerting === "active" && ladder.length > 0) {
          await scheduleEscalationTimer(tx, {
            instanceId: instance.id,
            state: timer.state,
            rung: 0,
            afterMinutes: ladder[0]!.afterMinutes,
            from: timer.dueAt, // anchor on dueAt, not wall clock: late ticks don't skew the ladder
          });
        }
      } else {
        const rung = timer.rung!;
        const rungSpec = ladder[rung]!;
        let resolvedUserIds = await usersHoldingRole(tx, rungSpec.toRole);
        let fallback = false;
        let fallbackExhausted = false;
        if (resolvedUserIds.length === 0) {
          fallback = true;
          resolvedUserIds = await usersHoldingRole(tx, DUTY_MANAGER_ROLE);
          fallbackExhausted = resolvedUserIds.length === 0; // owner SMS: Plan 10's half of fix 11
        }
        await appendEvent(
          tx,
          escalationTriggered.make({
            ...envelope,
            payload: {
              instanceId: instance.id,
              defKey: instance.defKey,
              state: timer.state,
              rung,
              role: rungSpec.toRole,
              resolvedUserIds,
              fallback,
              fallbackExhausted,
            },
          }),
        );
        const next = ladder[rung + 1];
        if (next) {
          await scheduleEscalationTimer(tx, {
            instanceId: instance.id,
            state: timer.state,
            rung: rung + 1,
            afterMinutes: next.afterMinutes,
            from: timer.dueAt,
          });
        }
      }
      return true;
    });
    if (didFire) fired += 1;
  }
  return fired;
}
