import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { moveEncounter } from "./encounters";
import { visitVitalsMoved } from "./events";
import { correctionIdsIn } from "./report";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";

/**
 * ═══ #773 — A DESK CORRECTION DOES NOT LOSE THE VITALS (owner 2026-10-13) ═══
 *
 * "Wrong department? Move patient" and "change the doctor" close one visit and open another for the
 * same person on the same day. When the closed visit's vitals were already taken, the new visit went
 * back to the bay and the doctor saw no readings for today.
 *
 * WHERE IT RUNS. When the replacement visit gets its token (`joinSessionInTx` callers: the immediate
 * open and `joinQueueInTx`, the deferred bill-first join). That is the one server point every road to
 * a replacement passes — the department move's own transaction, and a client's abandon-then-open for
 * a doctor change — and no client can skip it.
 *
 * WHICH VISIT. One the report calls a correction (`isCorrection`, through `correctionIdsIn` — one rule):
 * same patient, same day, abandoned, never consulted, with ACTIVE chart rows. The most recently
 * abandoned wins. If the replacement already has a chart of its own, nothing moves.
 *
 * WHAT IT LEAVES — what a fresh save on the new visit leaves: the visit `waiting` (moved by a named
 * system actor, as `patient-absent.ts` does: the desk holds no `registered → waiting` role), its token
 * `waiting` with `eligible_at = now`, no bench state, and the danger mark when a moved row carries a
 * danger flag. The rows keep their recorder and time; `visit.vitals_moved` names the move and the
 * person whose act caused it. There is no column for a "moved from" marker, and none is added.
 */
const VITALS_CARRY_ACTOR: Actor = { type: "system", id: "opd-vitals-carry" };

export async function carryCorrectedVitals(tx: Tx, actor: Actor, toEncounterId: string, now: Date): Promise<EncounterRow | null> {
  const to = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, toEncounterId)))[0];
  if (to === undefined || to.status !== "registered" || to.type !== "opd" || to.consultMode === "tele") return null;
  const own = await tx.select({ id: opdVitals.id }).from(opdVitals)
    .where(and(eq(opdVitals.encounterId, to.id), eq(opdVitals.status, "active"))).limit(1);
  if (own.length > 0) return null;

  // The common case — nobody of this patient's was abandoned today — costs one indexed read.
  const abandonedToday = await tx.select({ id: opdEncounters.id }).from(opdEncounters).where(and(
    eq(opdEncounters.patientId, to.patientId), eq(opdEncounters.serviceDate, to.serviceDate), eq(opdEncounters.status, "abandoned"),
  )).limit(1);
  if (abandonedToday.length === 0) return null;
  const corrections = await correctionIdsIn(tx, to.serviceDate, to.serviceDate);
  if (corrections.size === 0) return null;
  const candidates = await tx.select().from(opdEncounters).where(and(
    inArray(opdEncounters.id, [...corrections]), eq(opdEncounters.patientId, to.patientId), ne(opdEncounters.id, to.id),
  ));
  const from = candidates
    .filter((e) => e.consultStartedAt === null && e.abandonedAt !== null && e.abandonedAt.getTime() <= to.openedAt.getTime())
    .sort((a, b) => b.abandonedAt!.getTime() - a.abandonedAt!.getTime());
  for (const old of from) {
    const rows = await tx.select().from(opdVitals).where(and(eq(opdVitals.encounterId, old.id), eq(opdVitals.status, "active")));
    if (rows.length === 0) continue;

    await tx.update(opdVitals).set({ encounterId: to.id }).where(inArray(opdVitals.id, rows.map((r) => r.id)));
    let encounter = await moveEncounter(tx, VITALS_CARRY_ACTOR, to, "waiting", {}, now);
    await tx.update(opdQueueEntries)
      .set({ status: "waiting", eligibleAt: now, benchState: null, recallAt: null })
      .where(and(eq(opdQueueEntries.encounterId, to.id), eq(opdQueueEntries.status, "waiting_vitals")));
    const danger = rows.some((r) => ((r.dangerFlags ?? []) as { severity?: string }[]).some((f) => f.severity !== "notice"));
    if (danger) {
      encounter = (await tx.update(opdEncounters).set({ dangerFlagged: true }).where(eq(opdEncounters.id, to.id)).returning())[0]!;
      await tx.update(opdQueueEntries).set({ danger: true })
        .where(and(eq(opdQueueEntries.encounterId, to.id), inArray(opdQueueEntries.status, ["waiting", "called"])));
    }
    const entry = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, to.id))
      .orderBy(desc(opdQueueEntries.seq)).limit(1))[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    await appendEvent(tx, visitVitalsMoved.make({
      actor, patientId: to.patientId, encounterId: to.id, correlationId: to.workflowInstanceId,
      payload: {
        patientId: to.patientId, doctorId: to.doctorId!, serviceDate: to.serviceDate, sessionId: entry.sessionId,
        roomId: session.roomId, tokenNo: entry.tokenNo,
        fromEncounterId: old.id, toEncounterId: to.id, vitalsIds: rows.map((r) => r.id),
      },
    }));
    return encounter;
  }
  return null;
}
