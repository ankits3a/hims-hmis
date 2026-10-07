import { and, desc, eq } from "drizzle-orm";
import { GUARDIAN_NAME_MAX, GUARDIAN_RELATIONS, guardianMayStandIn } from "@hmis/contracts";
import type { Actor, GuardianRelation } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { vitalsGateVerdict } from "./consultation";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { visitPatientAbsent } from "./events";
import type { Db } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";

/**
 * ═════════════════════════════════════════════════════════════════════
 * THE GUARDIAN CAME WITH THE REPORTS — OWNER 2026-10-07
 * ═════════════════════════════════════════════════════════════════════
 *
 * *"When the patient's guardian comes with the report of the patient as a revisit patient, add an
 * option to skip the vitals taking process, as the patient didn't come — his guardian came to show
 * the report to the doctor."*
 *
 * WHAT THIS IS. One act: a REVISIT still waiting for the bay is marked "patient not present" with
 * who came (a relation from a fixed list, and an optional name), and the visit makes exactly the
 * move a vitals save makes — `registered → waiting`, the token `waiting_vitals → waiting` with
 * `eligible_at = now` — so the doctor's line holds it like any other charted patient. No vitals row
 * is written: there is nobody to weigh, and an empty chart is the truth the doctor is shown
 * ("Vitals not taken").
 *
 * WHO. The bay (`opd.vitals.record`) or the front desk (`opd.visits.open`) — the two seats a guardian
 * walks up to. No new permission: seed-roles pins the counts, and both seats already decide where a
 * visit goes next. Asserted HERE, not only at the route.
 *
 * WHY THE WORKFLOW MOVE IS A NAMED SYSTEM ACTOR'S. `opd_visit` gives `registered → waiting` to
 * `vitals_desk`, `nurse` and `doctor` — and the front desk is none of them. That definition is
 * Class A data activated in production, and widening it would let the counter skip the bay for
 * EVERY visit. So the authority is checked here, for this one kind of visit, and the transition is
 * made by `opd-patient-absent` — the arrangement `paper-consult.ts` uses for the same reason. The
 * person is not lost: `patient_absent_by` and the event carry them.
 *
 * WHAT IS DELIBERATELY UNCHANGED.
 *   · THE MONEY. The pay-before-vitals door (`vitalsGateVerdict`) is asked exactly as the bay asks it
 *     and refuses with the same code and detail; the front desk's bypass opens it as it always does.
 *     The fee for this kind of visit is the revisit fee — the owner has not ruled otherwise.
 *   · THE DOCTOR'S DOOR. `startConsultation` asks only that the visit be `waiting` and that the
 *     consult guards pass; it has never asked for a chart, so nothing there needed widening.
 */

/** The bay's grant — the same string the vitals POST is guarded on. */
export const PATIENT_ABSENT_BAY_PERMISSION = "opd.vitals.record";
/** The front desk's grant — the same string that opens a visit at the counter. */
export const PATIENT_ABSENT_DESK_PERMISSION = "opd.visits.open";

const PATIENT_ABSENT_ACTOR: Actor = { type: "system", id: "opd-patient-absent" };

export type PatientAbsent = { relation: GuardianRelation; name: string | null; by: string; at: Date };

/** The read-model projection: null on every visit the patient came to. */
export function patientAbsentOf(
  e: Pick<EncounterRow, "patientAbsentBy" | "patientAbsentAt" | "patientAbsentRelation" | "patientAbsentName">,
): PatientAbsent | null {
  if (e.patientAbsentAt === null || e.patientAbsentBy === null || e.patientAbsentRelation === null) return null;
  return {
    relation: e.patientAbsentRelation as GuardianRelation, name: e.patientAbsentName,
    by: e.patientAbsentBy, at: e.patientAbsentAt,
  };
}

export type PatientAbsentInput = { relation: string; name?: string | null };

function cleanInput(input: PatientAbsentInput): { relation: GuardianRelation; name: string | null } {
  if (!(GUARDIAN_RELATIONS as readonly string[]).includes(input.relation)) {
    throw new OpdError("invalid_patient_absent", `relation must be one of: ${GUARDIAN_RELATIONS.join(", ")}`);
  }
  const name = (input.name ?? "").trim();
  if (name.length > GUARDIAN_NAME_MAX) {
    throw new OpdError("invalid_patient_absent", `the guardian's name is at most ${GUARDIAN_NAME_MAX} characters`);
  }
  return { relation: input.relation as GuardianRelation, name: name === "" ? null : name };
}

const NOT_QUEUED = "this visit has not joined a queue yet — a bill-first visit joins its doctor's day after billing releases its token";

/**
 * Marks a returning visit (revisit or renewal) "patient not present — guardian with reports" and sends it to the doctor's line.
 * IDEMPOTENT: a visit already marked answers with its existing mark and nothing is rewritten.
 */
export async function markPatientAbsent(
  db: Db, actor: Actor, encounterId: string, input: PatientAbsentInput, now: Date = new Date(),
): Promise<{ encounter: EncounterRow; patientAbsent: PatientAbsent; alreadyMarked: boolean }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "marking a patient absent is a user action");
  const clean = cleanInput(input);
  const allowed = await hasPermission(db, actor.id, PATIENT_ABSENT_BAY_PERMISSION, "hospital")
    || await hasPermission(db, actor.id, PATIENT_ABSENT_DESK_PERMISSION, "hospital");
  if (!allowed) {
    throw new OpdError("patient_absent_not_permitted", "only the vitals bay or the front desk may send a guardian's visit to the doctor");
  }

  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const existing = patientAbsentOf(enc);
  if (existing !== null) return { encounter: enc, patientAbsent: existing, alreadyMarked: true };
  if (!guardianMayStandIn(enc.visitType)) {
    throw new OpdError("patient_absent_returning_only", `visit ${enc.visitNo} is a ${enc.visitType} visit — only a returning patient (revisit or renewal) may skip vitals for a guardian`);
  }
  if (enc.status !== "registered") {
    throw new OpdError("encounter_state_conflict", `only a visit still waiting for vitals can skip them, not ${enc.status}`);
  }
  /* FD-32 — the bay's own money door, asked the bay's way: same code, same detail, nothing written. */
  const gate = await vitalsGateVerdict(db, enc);
  if (!gate.ok) {
    throw new OpdError(
      "consult_gate_refused",
      gate.code === "fee_unsettled"
        ? "this visit has not been billed yet — take the fee at the counter first"
        : `the vitals desk is gated: ${gate.code}`,
      { guard: "billing_fee_gate", door: "vitals", code: gate.code, detail: gate.detail },
    );
  }
  const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  if (entries.length === 0) throw new OpdError("unknown_queue_entry", NOT_QUEUED, { encounterId });

  return withTx(db, async (tx) => {
    const current = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0]!;
    /* A second desk got there first, between the read above and this lock: its mark stands. */
    const raced = patientAbsentOf(current);
    if (raced !== null) return { encounter: current, patientAbsent: raced, alreadyMarked: true };

    await moveEncounter(tx, PATIENT_ABSENT_ACTOR, current, "waiting", {}, now);
    await tx.update(opdQueueEntries)
      .set({ status: "waiting", eligibleAt: now, benchState: null, recallAt: null })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), eq(opdQueueEntries.status, "waiting_vitals")));
    const rows = await tx.update(opdEncounters)
      .set({
        patientAbsentBy: actor.id, patientAbsentAt: now, patientAbsentRelation: clean.relation, patientAbsentName: clean.name,
        updatedBy: actor.id, updatedAt: now,
      })
      .where(eq(opdEncounters.id, encounterId))
      .returning();
    const encounter = rows[0]!;

    const entry = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
      .orderBy(desc(opdQueueEntries.seq)).limit(1))[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    await appendEvent(tx, visitPatientAbsent.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId,
        doctorId: encounter.doctorId!, serviceDate: encounter.serviceDate, sessionId: entry.sessionId,
        roomId: session.roomId, tokenNo: entry.tokenNo,
        relation: clean.relation, named: clean.name !== null,
      },
    }));
    return { encounter, patientAbsent: patientAbsentOf(encounter)!, alreadyMarked: false };
  });
}
