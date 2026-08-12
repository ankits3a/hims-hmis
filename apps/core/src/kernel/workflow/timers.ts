import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { workflowTimers } from "../db/schema";
import type { SlaSpec } from "./definition";
import type { Tx } from "../db/client";

// Timers are ROWS, never processes (roadmap trap: survive restarts; no setTimeout).
// Nothing here schedules execution — runDueTimers (Task 7) is invoked by tests now
// and by Plan 11's pg-boss cron later.

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
