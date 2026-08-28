import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visibleEncounterFor } from "./read-gate";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { vitalsDangerFlagged, vitalsRecorded } from "./events";
import { ageYearsAt } from "./time";
import { bandFor, evaluateVitals, missingRequired, validateVitalsRanges } from "./vitals-rules";
import type { DangerFlag } from "./events";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import type { VitalsInput } from "./vitals-rules";
import type { Db, Tx } from "../../kernel/db/client";

export type VitalsRow = typeof opdVitals.$inferSelect;

/** recordVitals runs on either of these; anything else is encounter_state_conflict. */
const RECORDABLE: readonly string[] = ["registered", "waiting"];
/** Queue-entry statuses a danger flag is stamped onto — the encounter's live-at-vitals-time set. */
const DANGER_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called"] as const;

/** The encounter's latest queue entry (seq, never id) and its session's room — the doctor-day event fields. */
async function latestEntryWhere(tx: Tx, encounterId: string): Promise<{ entry: QueueEntryRow; roomId: string | null }> {
  const entries = await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0]!;
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  return { entry, roomId: sessions[0]!.roomId };
}

/**
 * §11.8: one vitals reading. Recording on a `registered` encounter moves it to `waiting` FIRST (the queue
 * entry waiting_vitals → waiting) — a role_denied refusal on that move writes nothing, ever (the move precedes
 * the insert). A danger flag never auto-clears (D4): a later normal reading leaves danger_flagged/danger true —
 * the doctor sees the history.
 */
export async function recordVitals(
  db: Db, actor: Actor, encounterId: string, input: VitalsInput, now: Date = new Date(),
): Promise<{ vitals: VitalsRow; flags: DangerFlag[]; encounter: EncounterRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  validateVitalsRanges(input);
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!RECORDABLE.includes(enc.status)) throw new OpdError("encounter_state_conflict", `vitals need registered or waiting, not ${enc.status}`);
  const cfg = await loadOpdConfig(db);
  const [summary] = await getPatientSummaries(db, actor, [enc.patientId]);
  const ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null;
  const band = bandFor(ageYears, cfg.dangerRanges);
  const missing = missingRequired(input, ageYears, cfg.dangerRanges);
  if (missing.length > 0) throw new OpdError("vitals_incomplete", `missing: ${missing.join(", ")}`, { missing });
  const flags = evaluateVitals(input, band);

  return withTx(db, async (tx) => {
    let encounter: EncounterRow = enc;
    if (enc.status === "registered") {
      encounter = await moveEncounter(tx, actor, enc, "waiting", {}, now); // role_denied fails HERE, before any write
      await tx.update(opdQueueEntries)
        .set({ status: "waiting", eligibleAt: now })
        .where(and(eq(opdQueueEntries.encounterId, encounterId), eq(opdQueueEntries.status, "waiting_vitals")));
    }

    const [vitals] = await tx.insert(opdVitals).values({
      id: newId(), encounterId, patientId: encounter.patientId,
      heightCm: input.heightCm ?? null, weightKg: input.weightKg ?? null, sbp: input.sbp ?? null, dbp: input.dbp ?? null,
      pulse: input.pulse ?? null, rr: input.rr ?? null, spo2: input.spo2 ?? null, tempC: input.tempC ?? null, notes: input.notes ?? null,
      ageYearsAtRecord: ageYears, band: band.key, dangerFlags: flags, recordedBy: actor.id, recordedAt: now,
    }).returning();

    const { entry, roomId } = await latestEntryWhere(tx, encounterId);
    const where = { doctorId: encounter.doctorId!, serviceDate: encounter.serviceDate, sessionId: entry.sessionId, roomId, tokenNo: entry.tokenNo };
    const env = { actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId };

    if (flags.length > 0) {
      // Not a status write — the mirror rule stands (only moveEncounter writes opd_encounters.status).
      await tx.update(opdEncounters).set({ dangerFlagged: true }).where(eq(opdEncounters.id, encounterId));
      await tx.update(opdQueueEntries)
        .set({ danger: true })
        .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...DANGER_ENTRY_STATUSES])));
      await appendEvent(tx, vitalsDangerFlagged.make({ ...env, payload: { encounterId, patientId: encounter.patientId, vitalsId: vitals!.id, ...where, flags } }));
      encounter = { ...encounter, dangerFlagged: true };
    }
    await appendEvent(tx, vitalsRecorded.make({ ...env, payload: {
      encounterId, patientId: encounter.patientId, vitalsId: vitals!.id, ...where, band: band.key, dangerCount: flags.length,
    } }));

    return { vitals: vitals!, flags, encounter };
  });
}

export async function listVitals(db: Db, actor: Actor, encounterId: string): Promise<VitalsRow[]> {
  // PLAN 07a T1 — an encounter id is not a capability. Same empty answer as an unknown encounter.
  const seen = await visibleEncounterFor(db, actor, encounterId);
  if (!seen) return [];
  await recordPhiAccess(db, {
    actor, patientId: seen.encounter.patientId, surface: "opd.vitals", encounterId,
    sealed: seen.sealed, reason: seen.breakGlass?.reason ?? null,
  });
  return db.select().from(opdVitals).where(eq(opdVitals.encounterId, encounterId)).orderBy(asc(opdVitals.recordedAt));
}
