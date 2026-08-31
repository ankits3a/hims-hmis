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
import { bandFor, evaluateVitals, inputToReadings, missingRequired, readingsToInput, validateVitalsRanges } from "./vitals-rules";
import type { DangerFlag } from "./events";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import type { ContextChip, Readings, VitalsInput } from "./vitals-rules";
import type { VitalKey } from "./config";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ VD-1 T1 — WHAT THE BAY SENDS BESIDE THE NUMBERS ═══
 *
 * Everything the shipped desk could not say. `readings` is the authority when present: the scalar
 * vitals are DERIVED from it (`readingsToInput`) rather than sent alongside it, so the blob and
 * the columns can never disagree. A caller that sends only the flat body — the shipped screen,
 * until VD-2 replaces it — gets a single typed take synthesised for it, and every row in the table
 * therefore carries the same shape.
 */
export type VitalsDetail = {
  readings?: Readings;
  contextChips?: ContextChip[];
  /** Keys not measured today, carried from the last reading. They are PRESENT for completeness (D7). */
  carriedForward?: VitalKey[];
  /** D11 — declared, never inferred. Trims the required set to BP + pulse + SpO₂. */
  emergency?: boolean;
};

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
  db: Db, actor: Actor, encounterId: string, input: VitalsInput, now: Date = new Date(), detail: VitalsDetail = {},
): Promise<{ vitals: VitalsRow; flags: DangerFlag[]; encounter: EncounterRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  // ONE input path (vitals-rules.ts's own header): readings win and the scalars are derived from
  // them; a flat body gets one typed take per vital synthesised. Nothing downstream branches.
  const readings = detail.readings ?? inputToReadings(input);
  const values: VitalsInput = detail.readings === undefined ? input : { ...input, ...readingsToInput(detail.readings) };
  validateVitalsRanges(values);
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!RECORDABLE.includes(enc.status)) throw new OpdError("encounter_state_conflict", `vitals need registered or waiting, not ${enc.status}`);
  const cfg = await loadOpdConfig(db);
  const [summary] = await getPatientSummaries(db, actor, [enc.patientId]);
  const ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null;
  const band = bandFor(ageYears, cfg.dangerRanges);
  const carriedForward = detail.carriedForward ?? [];
  const emergency = detail.emergency === true;
  const missing = missingRequired(values, ageYears, cfg.dangerRanges, { emergency, carriedForward });
  if (missing.length > 0) throw new OpdError("vitals_incomplete", `missing: ${missing.join(", ")}`, { missing });
  const flags = evaluateVitals(values, band, cfg.dangerRanges);

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
      heightCm: values.heightCm ?? null, weightKg: values.weightKg ?? null, sbp: values.sbp ?? null, dbp: values.dbp ?? null,
      pulse: values.pulse ?? null, rr: values.rr ?? null, spo2: values.spo2 ?? null, tempC: values.tempC ?? null,
      muacCm: values.muacCm ?? null, notes: values.notes ?? null,
      readings, contextChips: detail.contextChips ?? [], carriedForward, emergency,
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
