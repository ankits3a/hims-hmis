import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { workflowTimers } from "../db/schema";
import type { SlaSpec } from "./definition";
import type { WorkflowTimerKind } from "../db/schema/workflow";
import type { Tx } from "../db/client";
import { asc, lte } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { parseDefinition } from "./definition";
import { usersHoldingRole } from "./roles";
import { escalationRecipients } from "../../modules/roster";
import { slaBreached, escalationTriggered, respondOverdue } from "./events";
import type { Db } from "../db/client";

// Timers are ROWS, never processes (roadmap trap: survive restarts; no setTimeout).
// Nothing here schedules execution — runDueTimers is invoked by tests directly and, since
// Plan 08.5, by the worker process's own scheduler (kernel/worker/jobs.ts), every
// WORKER_TIMERS_INTERVAL_MS.

/**
 * PHASE O T1 — the budget an instance is actually running against.
 *
 * `sla.minutes` is the DEFINITION's answer and `workflow_instances.budget_minutes` is this
 * instance's, set when something knew better (a desk-close rule, working minutes, an agreed
 * ETA). Read here rather than passed in by callers on purpose: a caller that forgot would
 * schedule the sla timer against one budget and the ladder against another, and the two would
 * disagree by exactly the amount nobody was looking at.
 */
async function budgetOf(tx: Tx, instanceId: string, sla: SlaSpec): Promise<number> {
  const rows = await tx
    .select({ budgetMinutes: workflowInstances.budgetMinutes })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  return rows[0]?.budgetMinutes ?? sla.minutes;
}

/**
 * Lays every timer a state entry owes: the resolve clock, the whole percent ladder, and the
 * respond clock.
 *
 * ═══ THE LADDER IS SCHEDULED ALL AT ONCE, AND THE CHAIN IS NOT ═══
 *
 * A shipped `escalation` chain schedules rung k+1 only when rung k fires, because each rung's
 * time is a delta from the last one and is unknowable before it. A `ladder` rung's time is a
 * percentage of a budget that is known at entry, so all of them go in now. That is what makes
 * `rescheduleBudget` possible (cancel and re-lay, one pass) and what makes C4's coalescing
 * possible (three rungs can be due together only if all three exist).
 *
 * ═══ C5 — A RESPOND CLOCK NEVER OUTLIVES THE BUDGET IT SITS INSIDE ═══
 *
 * "Answer within 30 minutes" on a 10-minute budget is not a 30-minute promise; it is a clock
 * that would fire after the thing it was about was already over. respond-by = min(respond, resolve).
 */
export async function scheduleSlaTimer(
  tx: Tx,
  input: { instanceId: string; state: string; sla: SlaSpec; enteredAt: Date },
): Promise<{ timerId: string; dueAt: Date }> {
  const timerId = newId();
  const budgetMinutes = await budgetOf(tx, input.instanceId, input.sla);
  const dueAt = new Date(input.enteredAt.getTime() + budgetMinutes * 60_000);
  await tx.insert(workflowTimers).values({
    id: timerId,
    instanceId: input.instanceId,
    state: input.state,
    kind: "sla",
    dueAt,
  });

  const ladder = input.sla.ladder ?? [];
  if (ladder.length > 0) {
    await tx.insert(workflowTimers).values(
      ladder.map((rung, index) => ({
        id: newId(),
        instanceId: input.instanceId,
        state: input.state,
        kind: "escalation" as const,
        rung: index,
        percent: rung.atPercent,
        // Anchored at STATE ENTRY, not at the breach: 70 % of six hours is 4 h 12 m.
        dueAt: new Date(input.enteredAt.getTime() + Math.round(budgetMinutes * rung.atPercent * 600)),
      })),
    );
  }

  if (input.sla.respondMinutes !== undefined) {
    const respondMinutes = Math.min(input.sla.respondMinutes, budgetMinutes); // C5
    await tx.insert(workflowTimers).values({
      id: newId(),
      instanceId: input.instanceId,
      state: input.state,
      kind: "respond",
      dueAt: new Date(input.enteredAt.getTime() + respondMinutes * 60_000),
    });
  }

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

/**
 * PHASE O T1 — cancels every open timer of ONE kind, leaving the others running.
 *
 * This is the shape the two clocks need and `cancelOpenTimers` cannot give: an acknowledgement
 * stops the RESPOND clock and must leave the budget's timers exactly where they were. Somebody
 * saying "I have got this" is not the work being done.
 */
export async function cancelTimersOfKind(
  tx: Tx,
  instanceId: string,
  kind: WorkflowTimerKind,
  now: Date = new Date(),
): Promise<number> {
  const rows = await tx
    .update(workflowTimers)
    .set({ cancelledAt: now })
    .where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        eq(workflowTimers.kind, kind),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    )
    .returning({ id: workflowTimers.id });
  return rows.length;
}

/**
 * PHASE O T1 — THE BUDGET CHANGED, SO EVERY CLOCK MEASURED AGAINST IT IS RE-LAID (C3).
 *
 * A desk closes, working minutes apply, an owner agrees a different deadline: the number the
 * percent ladder is a percentage OF has moved, and every rung's instant with it. Cancelling and
 * re-laying in one transaction is the only shape that cannot leave two ladders live at once —
 * which is precisely what the naive "schedule the new one" does, and what V3 asserts against.
 *
 * ═══ THE ANCHOR DOES NOT MOVE ═══
 *
 * Re-laid from `state_entered_at`, never from `now`. A budget raised at 90 % of the old one must
 * not hand the holder a fresh full budget — the obligation has been open the whole time, and a
 * rung whose new instant is already in the past is CORRECT: it fires on the next tick, which is
 * what "you are already past 70 %" should do.
 *
 * ═══ AN ACK IS NOT UNDONE BY A BUDGET CHANGE ═══
 *
 * The respond clock is re-laid only if one is still live. If somebody already answered — the ack
 * cancelled it — or it has already fired, a budget change does not resurrect it: that would put
 * a silence clock back on a person who is not silent.
 */
export async function rescheduleBudget(
  tx: Tx,
  instanceId: string,
  minutes: number,
  now: Date = new Date(),
): Promise<{ dueAt: Date; ladderRungs: number; respondRescheduled: boolean }> {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`rescheduleBudget: minutes must be a positive integer, got ${String(minutes)}`);
  }
  const instRows = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
  const instance = instRows[0];
  if (instance === undefined) throw new Error(`rescheduleBudget: unknown instance ${instanceId}`);
  // A finished obligation has no budget left to change, and re-laying timers on one would put
  // a live ladder on something nobody can act on — `transition` cancelled them for that reason.
  if (instance.status !== "active") {
    throw new Error(`rescheduleBudget: instance ${instanceId} is ${instance.status}, not active`);
  }

  const defRows = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, instance.definitionId));
  const def = parseDefinition(defRows[0]!.definition);
  const state = def.states.find((st) => st.name === instance.currentState);
  const sla = state?.sla;
  if (sla === undefined) throw new Error(`rescheduleBudget: state "${instance.currentState}" carries no SLA`);

  const liveRespond = await tx
    .select({ id: workflowTimers.id })
    .from(workflowTimers)
    .where(
      and(
        eq(workflowTimers.instanceId, instanceId),
        eq(workflowTimers.kind, "respond"),
        isNull(workflowTimers.firedAt),
        isNull(workflowTimers.cancelledAt),
      ),
    );
  const respondWasLive = liveRespond.length > 0;

  await cancelTimersOfKind(tx, instanceId, "sla", now);
  await cancelTimersOfKind(tx, instanceId, "escalation", now);
  if (respondWasLive) await cancelTimersOfKind(tx, instanceId, "respond", now);

  await tx.update(workflowInstances).set({ budgetMinutes: minutes }).where(eq(workflowInstances.id, instanceId));

  // Re-laid through the ONE function that lays them, which now reads the column above. Two
  // copies of "budget times percent" is the arithmetic this phase exists to stop duplicating.
  const { dueAt } = await scheduleSlaTimer(tx, {
    instanceId,
    state: instance.currentState,
    sla: respondWasLive ? sla : { ...sla, respondMinutes: undefined },
    enteredAt: instance.stateEnteredAt,
  });
  return { dueAt, ladderRungs: sla.ladder?.length ?? 0, respondRescheduled: respondWasLive };
}

/** §11.19-C fix 11: a ladder never dead-ends silently — duty manager catches empty rungs. */
export const DUTY_MANAGER_ROLE = "duty_manager";

/**
 * PHASE O T1 — THE ONE PLACE A RUNG BECOMES PEOPLE, for a chain rung and a ladder rung alike.
 *
 * Phase R's R6 (#279) moved the chain rung onto `escalationRecipients`; T1 must not add a third
 * `usersHoldingRole` site beside it, so both rung kinds route through here and R6's seam stays
 * a single call. With no `roster_escalation_targets` row — every hospital until somebody
 * configures one — `escalationRecipients` returns exactly `usersHoldingRole(toRole)`, byte for
 * byte, and the duty-manager fallback below is the rung that is never removed.
 *
 * Anchored on the timer's OWN due instant rather than the wall clock: a tick that ran late must
 * not ask who is on duty NOW about a silence that happened an hour ago.
 */
async function resolveRung(
  tx: Tx,
  toRole: string,
  at: Date,
): Promise<{ resolvedUserIds: string[]; fallback: boolean; fallbackExhausted: boolean }> {
  const resolved = await escalationRecipients(tx, "workflow.timer_rung", { fallbackRoleKey: toRole }, at);
  let resolvedUserIds = resolved.userIds;
  let fallback = false;
  let fallbackExhausted = false;
  if (resolvedUserIds.length === 0) {
    fallback = true;
    resolvedUserIds = await usersHoldingRole(tx, DUTY_MANAGER_ROLE);
    fallbackExhausted = resolvedUserIds.length === 0; // owner SMS: Plan 10's half of fix 11
  }
  return { resolvedUserIds, fallback, fallbackExhausted };
}

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
      } else if (timer.kind === "respond") {
        /**
         * PHASE O T1 — NOBODY HAS SAID ANYTHING. Not "the work is late": the respond clock and
         * the budget are independent, and this branch fires whether or not the budget has any
         * time left on it. An ack cancels this timer (`cancelTimersOfKind(…, "respond")`) and
         * touches nothing else.
         */
        /**
         * `respondMinutes` is READ FROM THE PROMISE, not reconstructed from the instants.
         *
         * The obvious derivation — `dueAt - stateEnteredAt` — is right only while nobody has
         * moved either end, and both ends move: `rescheduleBudget` re-lays the timer against a
         * new budget, and a remediation migration re-stamps `state_entered_at`. The number this
         * event carries is "how long silence was allowed", which is a fact about the DEFINITION
         * and the budget, so it comes from there. (A timer outliving a definition that no longer
         * declares one is the single case with nothing better to read, and it falls back.)
         */
        const respondBudget = instance.budgetMinutes ?? sla.minutes;
        const respondMinutes = sla.respondMinutes === undefined
          ? Math.max(0, Math.round((timer.dueAt.getTime() - instance.stateEnteredAt.getTime()) / 60_000))
          : Math.min(sla.respondMinutes, respondBudget); // C5
        await appendEvent(
          tx,
          respondOverdue.make({
            ...envelope,
            payload: {
              instanceId: instance.id,
              defKey: instance.defKey,
              state: timer.state,
              respondMinutes,
              dueAt: timer.dueAt.toISOString(),
            },
          }),
        );
      } else if (timer.percent !== null) {
        /**
         * ═══ A PERCENT LADDER RUNG (phase O T1) ═══
         *
         * Every rung of this ladder was scheduled at state entry, so there is no next rung to
         * lay here — that is the whole difference from the chain below, and it is what makes
         * the coalescing directly underneath possible at all.
         *
         * C4 — THE WORKER WAS DOWN AND ALL THREE RUNGS CAME DUE AT ONCE. Three hours of
         * downtime must not become three messages to three people about one silence. The
         * HIGHEST due rung speaks; the lower ones are recorded as fired, pointed at the rung
         * that spoke, and emit nothing. `runDueTimers` scans oldest-first and a higher percent
         * is always a later instant, so the lower rungs are recorded BEFORE the top one emits
         * (R6's ordering rule), and each is still claimed by its own conditional UPDATE.
         */
        const higherDue = await tx
          .select({ id: workflowTimers.id, percent: workflowTimers.percent })
          .from(workflowTimers)
          .where(
            and(
              eq(workflowTimers.instanceId, timer.instanceId),
              eq(workflowTimers.state, timer.state),
              eq(workflowTimers.kind, "escalation"),
              gt(workflowTimers.percent, timer.percent),
              lte(workflowTimers.dueAt, now),
              isNull(workflowTimers.cancelledAt),
              ne(workflowTimers.id, timer.id),
            ),
          )
          .orderBy(asc(workflowTimers.percent));
        const supersedes = higherDue[higherDue.length - 1];
        if (supersedes !== undefined) {
          await tx
            .update(workflowTimers)
            .set({ supersededBy: supersedes.id })
            .where(eq(workflowTimers.id, timer.id));
          return true; // recorded as fired, deliberately silent
        }

        const rung = timer.rung!;
        const rungSpec = (sla.ladder ?? [])[rung]!;
        const { resolvedUserIds, fallback, fallbackExhausted } = await resolveRung(tx, rungSpec.toRole, timer.dueAt);
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
              percent: timer.percent,
              budgetMinutes: instance.budgetMinutes ?? sla.minutes,
            },
          }),
        );
      } else {
        const rung = timer.rung!;
        const rungSpec = ladder[rung]!;
        /**
         * PHASE R (R6) — the rung's destination goes through the roster, **anchored on
         * `timer.dueAt`** rather than the wall clock, for the same reason the ladder itself is
         * (a late tick must not skew who was on when the SLA broke). Phase O T1 moved the call
         * into `resolveRung` so the ladder branch above shares it and R6's seam stays ONE site.
         */
        const { resolvedUserIds, fallback, fallbackExhausted } = await resolveRung(tx, rungSpec.toRole, timer.dueAt);
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
