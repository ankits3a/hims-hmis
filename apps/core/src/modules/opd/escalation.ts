import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { OpdError } from "./errors";
import { queueEscalated, queueEscalationCancelled, vitalsRecheckDemanded } from "./events";
import { classOf } from "./queue-engine";
import { ageYearsAt } from "./time";
import { bandFor, evaluateVitals } from "./vitals-rules";
import type { DangerFlag } from "./events";
import type { QueueEntryRow } from "./encounters";
import type { QueueClass, QueueEntryState } from "./queue-engine";
import type { VitalsInput } from "./vitals-rules";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ══════════════════ VD-1 T3 — THE DANGER PROTOCOL ══════════════════
 *
 * Bay 01, a class-3 walk-in, sixty-one years old, "sir bhaari, chakkar". The cuff reads 208/126.
 *
 * The owner's ruling of 2026-08-31, in three steps:
 *   1. ONE danger reading only DEMANDS the other arm, now. It does not move the queue. A single
 *      bad number is very often a cuff on a sleeve, an arm below the heart, or a man who has just
 *      climbed two flights in the sun — and reordering a doctor's whole board on it, every time,
 *      is how a board becomes something people stop believing.
 *   2. A DOUBLE-CONFIRMED danger reading lets the agent set queue class 0 BY ITSELF. This is the
 *      single case in the entire seat where the agent acts alone, and it is justified by the
 *      asymmetry: at 214/132 the cost of a missed escalation is a stroke, and the cost of a wrong
 *      one is one press of cancel.
 *   3. That press has TEN SECONDS. After the window closes, reversal is supervisory.
 *
 * ═══ APPLY-THEN-REVERT, NEVER DELAYED-APPLY ═══
 *
 * The obvious implementation holds the bump for ten seconds and applies it if nobody cancels.
 * It is wrong, and the handoff says why in as many words: *the doctor must see the flash
 * immediately*. Ten seconds of a stroke patient sitting in a queue nobody has been told about is
 * exactly the thing this bench exists to prevent. So the bump lands NOW, the board flashes NOW,
 * and cancel is a compensating action.
 *
 * ═══ WHAT CANCEL MOVES, AND WHAT IT CANNOT TOUCH ═══
 *
 * `opd_encounters.danger_flagged` and the `vitals.danger_flagged` event are the CLINICAL record.
 * They fire on every danger reading, they never auto-clear, and nothing here can unset them — the
 * doctor sees the flag and both takes whatever happens at the bay.
 *
 * What cancel reverts is `opd_queue_entries.danger`, the BOARD fact: whether the queue reorders
 * and the doctor is called now. The signed-off autonomy ladder is the authority — *"ASKS (never
 * alone): anything that downgrades urgency."* The agent bumps; only a person un-bumps, with their
 * name in `escalation_by` and the moment in the event.
 *
 * Shipped behaviour before this file raised `danger` on the FIRST flagged reading with no recheck
 * and no way back. That is not weakened: `recordVitals` still raises it, for every encounter whose
 * escalation is not `cancelled`. What is new is that a named human can decline the reorder.
 *
 * ═══ THE SERVER DECIDES WHETHER AN ESCALATION IS WARRANTED ═══
 *
 * Every entry point re-evaluates the reading against the patient's own band. The bay ASKS; it does
 * not assert. A route that bumped on the caller's say-so would be a route by which anybody could
 * move anybody to the head of any doctor's queue.
 */

/** `escalated_at + this` is the whole of the cancel window. A CLOCK COMPARISON, never a timer (D8). */
export const CANCEL_WINDOW_MS = 10_000;

export const ESCALATION_STATES = ["none", "recheck_demanded", "escalated", "cancelled"] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

export type EscalationView = {
  entryId: string;
  state: EscalationState;
  escalatedAt: Date | null;
  escalatedFromClass: QueueClass | null;
  escalationBy: string | null;
  /** Milliseconds left to cancel, 0 once the window has closed. The countdown is the screen's; this is the truth. */
  cancelMsRemaining: number;
};

/** The engine's pure view of a row — the same projection `queue.ts` makes, kept in step by `QueueEntryState`. */
function stateOf(row: QueueEntryRow): QueueEntryState {
  return {
    id: row.id, tokenNo: row.tokenNo, kind: row.kind === "appointment" ? "appointment" : "walk_in",
    appointmentAt: row.appointmentAt, eligibleAt: row.eligibleAt ?? row.createdAt, seq: row.seq,
    danger: row.danger, reEntry: row.reEntry, perk: row.perk, skips: row.skips,
  };
}

export function cancelMsRemaining(escalatedAt: Date | null, state: EscalationState, now: Date): number {
  if (state !== "escalated" || escalatedAt === null) return 0;
  return Math.max(0, escalatedAt.getTime() + CANCEL_WINDOW_MS - now.getTime());
}

/**
 * The encounter's live queue entry, its session, and the actor's own patient read.
 *
 * The encounter row is locked FOR UPDATE — a row outside the entry's own write path, which is the
 * `callNext` and `joinQueue` idiom rather than a new one. It serialises escalate against cancel
 * against join, so two nurses hammering CANCEL produce one revert and one loser.
 */
async function liveEntry(tx: Tx, encounterId: string): Promise<{
  entry: QueueEntryRow; doctorId: string; serviceDate: string; sessionId: string; roomId: string | null;
  patientId: string; workflowInstanceId: string;
}> {
  const encRows = await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update");
  const encounter = encRows[0];
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const entries = await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, ["waiting_vitals", "waiting", "called"])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0];
  // The bill-first visit again: no token yet, so there is no board position to escalate ON.
  if (!entry) throw new OpdError("unknown_queue_entry", "this visit has no live queue entry to escalate", { encounterId });
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  const session = sessions[0]!;
  return {
    entry, doctorId: session.doctorId, serviceDate: session.serviceDate,
    sessionId: session.id, roomId: session.roomId, patientId: encounter.patientId,
    // The three events below correlate on the VISIT's workflow instance, exactly as
    // `vitals.recorded` and `vitals.danger_flagged` already do. The first draft passed `null`
    // here — which does not typecheck, and would have been the wrong answer even if it had: an
    // escalation and the vitals reading that caused it belong to one visit, and the correlation
    // id is how anything downstream joins them. There was a real value available all along.
    workflowInstanceId: encounter.workflowInstanceId,
  };
}

/** The band-authoritative verdict on a reading. Empty ⇒ the bay may not escalate on it. */
async function dangerOf(db: Db | Tx, actor: Actor, patientId: string, reading: VitalsInput, now: Date): Promise<DangerFlag[]> {
  const cfg = await loadOpdConfig(db);
  const [summary] = await getPatientSummaries(db, actor, [patientId]);
  const ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null;
  return evaluateVitals(reading, bandFor(ageYears, cfg.dangerRanges), cfg.dangerRanges);
}

/**
 * Step 1 — one danger reading. The other arm, NOW.
 *
 * Rest-and-recheck is deliberately NOT offered here, and that is the owner's DECIDED line: five
 * minutes on the rest chairs is for elevated MAYBES. At danger numbers the recheck happens while
 * the patient is still on the stool.
 */
export async function demandRecheck(
  db: Db, actor: Actor, encounterId: string, reading: VitalsInput, now: Date = new Date(),
): Promise<EscalationView> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  return withTx(db, async (tx) => {
    const live = await liveEntry(tx, encounterId);
    const flags = await dangerOf(tx, actor, live.patientId, reading, now);
    if (flags.length === 0) throw new OpdError("escalation_not_warranted", "this reading is inside the patient's band", { reading });
    if (live.entry.escalation === "escalated") {
      throw new OpdError("escalation_state_conflict", "already escalated", { escalation: live.entry.escalation });
    }
    await tx.update(opdQueueEntries).set({ escalation: "recheck_demanded" }).where(eq(opdQueueEntries.id, live.entry.id));
    await appendEvent(tx, vitalsRecheckDemanded.make({
      actor, patientId: live.patientId, encounterId, correlationId: live.workflowInstanceId,
      payload: {
        encounterId, patientId: live.patientId, doctorId: live.doctorId, serviceDate: live.serviceDate,
        sessionId: live.sessionId, roomId: live.roomId, tokenNo: live.entry.tokenNo,
        flags, demand: "other_arm_now",
      },
    }));
    return {
      entryId: live.entry.id, state: "recheck_demanded", escalatedAt: null,
      escalatedFromClass: null, escalationBy: null, cancelMsRemaining: 0,
    };
  });
}

/**
 * Step 2 — the double confirm. The agent moves the class itself, and the ten seconds start.
 *
 * `recheck_demanded` is REQUIRED, and it is what "double-confirmed" means mechanically: the first
 * danger reading created that state, and only a second one can consume it.
 */
export async function escalate(
  db: Db, actor: Actor, encounterId: string, reading: VitalsInput, now: Date = new Date(),
): Promise<EscalationView> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  return withTx(db, async (tx) => {
    const live = await liveEntry(tx, encounterId);
    const current = live.entry.escalation as EscalationState;
    if (current !== "recheck_demanded") {
      throw new OpdError(
        "escalation_state_conflict",
        current === "none"
          ? "one danger reading demands the other arm; only a second one escalates"
          : `cannot escalate from ${current}`,
        { escalation: current },
      );
    }
    const flags = await dangerOf(tx, actor, live.patientId, reading, now);
    if (flags.length === 0) throw new OpdError("escalation_not_warranted", "the recheck is inside the patient's band", { reading });

    const fromClass = classOf(stateOf(live.entry), now);
    await tx.update(opdQueueEntries)
      .set({ escalation: "escalated", escalatedAt: now, escalatedFromClass: fromClass, danger: true, escalationBy: null })
      .where(eq(opdQueueEntries.id, live.entry.id));
    // The clinical half, unchanged from shipped behaviour and untouchable by cancel.
    await tx.update(opdEncounters).set({ dangerFlagged: true }).where(eq(opdEncounters.id, encounterId));
    await appendEvent(tx, queueEscalated.make({
      actor, patientId: live.patientId, encounterId, correlationId: live.workflowInstanceId,
      payload: {
        encounterId, patientId: live.patientId, doctorId: live.doctorId, serviceDate: live.serviceDate,
        sessionId: live.sessionId, roomId: live.roomId, tokenNo: live.entry.tokenNo,
        entryId: live.entry.id, fromClass, toClass: 0, flags, escalatedAt: now.toISOString(), by: "agent",
      },
    }));
    return {
      entryId: live.entry.id, state: "escalated", escalatedAt: now, escalatedFromClass: fromClass,
      escalationBy: null, cancelMsRemaining: CANCEL_WINDOW_MS,
    };
  });
}

/**
 * Step 3 — the ten seconds.
 *
 * Past the window this refuses, with the countdown possibly still painted on the screen: the
 * server's clock is the one that decides, and a UI that disagrees is a UI, not an authority.
 */
export async function cancelEscalation(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<EscalationView> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  return withTx(db, async (tx) => {
    const live = await liveEntry(tx, encounterId);
    const current = live.entry.escalation as EscalationState;
    if (current !== "escalated") throw new OpdError("escalation_state_conflict", `nothing to cancel: ${current}`, { escalation: current });
    const at = live.entry.escalatedAt;
    const withinMs = at === null ? CANCEL_WINDOW_MS : now.getTime() - at.getTime();
    if (at === null || withinMs >= CANCEL_WINDOW_MS) {
      throw new OpdError(
        "escalation_window_closed",
        "the ten seconds are up — reversing a class-0 escalation is a supervisor action now",
        { withinMs },
      );
    }
    const restoredClass = (live.entry.escalatedFromClass ?? 3) as QueueClass;
    await tx.update(opdQueueEntries)
      .set({ escalation: "cancelled", danger: false, escalationBy: actor.id })
      .where(eq(opdQueueEntries.id, live.entry.id));
    await appendEvent(tx, queueEscalationCancelled.make({
      actor, patientId: live.patientId, encounterId, correlationId: live.workflowInstanceId,
      payload: {
        encounterId, patientId: live.patientId, doctorId: live.doctorId, serviceDate: live.serviceDate,
        sessionId: live.sessionId, roomId: live.roomId, tokenNo: live.entry.tokenNo,
        entryId: live.entry.id, restoredClass, withinMs,
      },
    }));
    return {
      entryId: live.entry.id, state: "cancelled", escalatedAt: at,
      escalatedFromClass: restoredClass, escalationBy: actor.id, cancelMsRemaining: 0,
    };
  });
}

/** What the bay reads to paint the countdown, and what any other surface reads to know where it stands. */
export async function escalationFor(db: Db, encounterId: string, now: Date = new Date()): Promise<EscalationView | null> {
  const entries = await db
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0];
  if (!entry) return null;
  const state = entry.escalation as EscalationState;
  return {
    entryId: entry.id, state, escalatedAt: entry.escalatedAt,
    escalatedFromClass: (entry.escalatedFromClass ?? null) as QueueClass | null,
    escalationBy: entry.escalationBy, cancelMsRemaining: cancelMsRemaining(entry.escalatedAt, state, now),
  };
}
