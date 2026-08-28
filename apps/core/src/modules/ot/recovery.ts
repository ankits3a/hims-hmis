import { asc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  daycareEncounters, otCases, otIncidents, pacuScores, patients, resources,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { transition } from "../../kernel/workflow/instances";
import { assignResource, releaseResource } from "../../kernel/resources/registry";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { hasPermission } from "../../kernel/auth/permissions";
import { displayName, getPatient, guardiansWithAuthority } from "../patients";
import { activeDefinition, criteriaFor } from "./definitions";
import { OtError } from "./errors";
import {
  daycareAbsconded, daycareConvertedToAdmission, daycareDischargeReady, daycareDischarged,
  escortVerified, incidentReported,
} from "./events";
import { caseState } from "./booking";
import { DAYCARE_RECOVERY_BAY_CLASS } from "./kinds";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T6 / DD10 — **RECOVERY: a bay that cannot be double-assigned, a score that cannot be
 * typed, and a discharge that cannot happen without an adult.**
 *
 * ═══ THE BAY GOES THROUGH THE REGISTRY, AND F23 IS WHY THE ERROR NAMES THE OCCUPANT ═══
 *
 * `admitToBay` is `assignResource` with `occupantType: "daycare_encounter"`. An occupied bay refuses
 * `already_occupied` from the kernel — under the lock this phase had to add to it (finding T5-a) —
 * and the message carries the CURRENT occupant's type and ref. That is F23: an ED overflow patient
 * parked in a recovery bay is representable (N10 — the registry admits any occupant type) and the
 * recovery nurse has to be able to see it rather than be told "occupied" by something invisible.
 *
 * ═══ `discharge_ready` IS COMPUTED FROM `occurred_at`, NOT FROM `recorded_at` (B7 / F25) ═══
 *
 * Two scores at or above the threshold, at least `minGapMinutes` apart BY THE TYPED CLOCK. A nurse
 * charting both scores at the end of a busy hour must not satisfy a thirty-minute rule with two rows
 * written four seconds apart — and a downtime backfill of two real scores must not fail it. The
 * scale, the threshold, the count and the gap are all the ACTIVE `pacu_thresholds` definition's,
 * keyed by the case's anaesthesia technique (F24b): a spinal is scored on a longer set than a GA.
 *
 * ═══ THE ESCORT IS VERIFIED TWICE, AND THE SECOND TIME IS NOT THE FIRST ═══
 *
 * E-4 of §11.16-A: a day-care patient discharges TO AN ADULT, structurally. A verification at
 * check-in is evidence about who brought her; six hours later the question is who is taking her
 * home, and it is a different question with a different answer often enough that treating them as
 * one is the defect. `dischargeDaycare` requires a `discharge`-time verification and refuses
 * `escort_required` without one — and there is no override lane for it anywhere (gates.ts).
 */

export type PacuScoreRow = typeof pacuScores.$inferSelect;

/** DD10 — the bay error names the occupant (F23). */
export async function admitToBay(
  db: Db, actor: Actor, input: { encounterId: string; bayResourceId: string },
): Promise<void> {
  await withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);

    const bay = (await tx.select().from(resources).where(eq(resources.id, input.bayResourceId)))[0];
    if (!bay) throw new OtError("bay_occupied", `unknown bay ${input.bayResourceId}`);
    if (bay.kind !== "bed" || (bay.attributes as { class?: string } | null)?.class !== DAYCARE_RECOVERY_BAY_CLASS) {
      throw new OtError(
        "bay_occupied",
        `resource ${input.bayResourceId} is not a day-care recovery bay (kind ${bay.kind})`,
      );
    }
    try {
      // The KERNEL's `bed` vocabulary, and the kernel's lock. `already_occupied` maps to 409.
      await assignResource(tx, actor, KERNEL_RESOURCE_KINDS, input.bayResourceId, {
        occupantType: "daycare_encounter", occupantRef: input.encounterId,
      });
    } catch (error) {
      if (String(error).includes("already occupied")) {
        /**
         * ═══ F23 — NAME THE OCCUPANT, AND RE-READ IT HERE ═══
         *
         * "Occupied" alone sends a recovery nurse to look at two identical bays; N10's ED-overflow
         * occupant is representable and has to be visible.
         *
         * **The row is re-read INSIDE the catch, and the concurrency test is what forced that.**
         * The first version used the `bay` row read at the top of this function, and under an
         * overlapping admission that read happens BEFORE the winner commits — so the message came
         * out as *"bay RB-1 is occupied by null null"*, which is precisely the uninformative
         * refusal F23 exists to remove, arriving only in the case where a nurse most needs the
         * name. By the time this catch runs the winner has committed and the lock is released, so
         * this read returns the truth.
         */
        const current = (await tx.select().from(resources).where(eq(resources.id, input.bayResourceId)))[0]!;
        throw new OtError(
          "bay_occupied",
          `bay ${current.code} is occupied by ${String(current.occupantType)} ${String(current.occupantRef)}`,
          { bayCode: current.code, occupantType: current.occupantType, occupantRef: current.occupantRef },
        );
      }
      throw error;
    }
    await tx.update(daycareEncounters)
      .set({ bayResourceId: input.bayResourceId, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(daycareEncounters.id, input.encounterId));
  });
}

/** The ACTIVE PACU scale for a case's anaesthesia technique (F24b). */
async function scaleFor(exec: Db | Tx, anaesthesiaType: string | null): Promise<{
  scale: string; threshold: number; minScores: number; minGapMinutes: number;
  items: { key: string; max: number }[];
}> {
  const body = await activeDefinition(exec, "pacu_thresholds");
  const found = body.scales.find((s) => s.anaesthesiaType === (anaesthesiaType ?? "general"));
  if (!found) {
    throw new OtError(
      "not_discharge_ready",
      `the ACTIVE pacu_thresholds definition has no scale for "${String(anaesthesiaType)}" — a patient scored on no scale can never be discharged`,
    );
  }
  return found;
}

/**
 * B7/F25 — one score. `occurredAt` is TYPED (defaulting to now), because it is the clock the
 * thirty-minute rule is computed from.
 */
export async function recordScore(
  db: Db, actor: Actor,
  input: { encounterId: string; caseId: string; values: Record<string, number>; occurredAt?: Date },
): Promise<{ scoreId: string; total: number; scale: string }> {
  return withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);
    if (encounter.bayResourceId === null) {
      throw new OtError("not_discharge_ready", "this encounter is not in a recovery bay — a score belongs to a bay (H11)");
    }
    const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

    const scale = await scaleFor(tx, kase.anaesthesiaType);
    // Every item of the scale, and nothing that is not on it. A partial score summed as a total is
    // a total that looks like a low score rather than an incomplete one.
    const missing = scale.items.filter((i) => input.values[i.key] === undefined).map((i) => i.key);
    if (missing.length > 0) {
      throw new OtError("not_discharge_ready", `the ${scale.scale} scale needs every item; missing: ${missing.join(", ")}`);
    }
    let total = 0;
    for (const item of scale.items) {
      const value = input.values[item.key]!;
      if (!Number.isSafeInteger(value) || value < 0 || value > item.max) {
        throw new OtError("not_discharge_ready", `${item.key} must be an integer between 0 and ${String(item.max)}`);
      }
      total += value;
    }

    const scoreId = newId();
    await tx.insert(pacuScores).values({
      id: scoreId, encounterId: input.encounterId, caseId: input.caseId, scale: scale.scale,
      values: input.values, total, scoredBy: actor.id, bayResourceId: encounter.bayResourceId,
      occurredAt: input.occurredAt ?? new Date(),
    });
    return { scoreId, total, scale: scale.scale };
  });
}

export type ReadinessVerdict = {
  ready: boolean;
  threshold: number;
  qualifying: number;
  minScores: number;
  gapMinutes: number | null;
  minGapMinutes: number;
};

/**
 * ═══ A20 — TWO THRESHOLD SCORES, `minGapMinutes` APART, BY `occurred_at` ═══
 *
 * The mutant accepts ANY ONE score at or above the threshold. Its discriminating input is two
 * qualifying scores ten minutes apart: the shipped code says not ready, the mutant says ready and a
 * post-anaesthesia patient goes home ten minutes after her first good observation.
 *
 * The gap is measured between the LAST TWO qualifying scores rather than between the first and the
 * last: a patient who scored well at 10:00, badly at 10:20 and well at 10:35 has not been stable
 * for thirty-five minutes, she has been stable for fifteen.
 */
export function readinessOf(
  scores: { total: number; occurredAt: Date }[],
  scale: { threshold: number; minScores: number; minGapMinutes: number },
): ReadinessVerdict {
  const qualifying = scores
    .filter((s) => s.total >= scale.threshold)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const base = {
    threshold: scale.threshold, qualifying: qualifying.length,
    minScores: scale.minScores, minGapMinutes: scale.minGapMinutes,
  };
  if (qualifying.length < scale.minScores) return { ...base, ready: false, gapMinutes: null };

  const last = qualifying[qualifying.length - 1]!;
  const previous = qualifying[qualifying.length - scale.minScores]!;
  const gapMinutes = (last.occurredAt.getTime() - previous.occurredAt.getTime()) / 60_000;
  return { ...base, ready: gapMinutes >= scale.minGapMinutes, gapMinutes };
}

/**
 * Evaluates readiness and, when it is met, performs the `in_recovery → discharge_ready` transition
 * as the SYSTEM. R-3.23's late cutoff is evaluated here too, and it OFFERS a conversion — it never
 * performs one (A23).
 */
export async function evaluateDischargeReady(
  db: Db, input: { encounterId: string; caseId: string }, now: Date = new Date(),
): Promise<ReadinessVerdict & { state: string; lateCutoffPassed: boolean }> {
  return withTx(db, async (tx) => {
    const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);
    const scale = await scaleFor(tx, kase.anaesthesiaType);
    const scores = await tx.select({ total: pacuScores.total, occurredAt: pacuScores.occurredAt })
      .from(pacuScores).where(eq(pacuScores.encounterId, input.encounterId)).orderBy(asc(pacuScores.occurredAt));
    const verdict = readinessOf(scores, scale);

    const criteria = await activeDefinition(tx, "criteria");
    const entry = criteriaFor(criteria, kase.procedureClass);
    const lateCutoffPassed = entry !== undefined && istTimePassed(now, entry.lateCutoff);

    const state = await caseState(tx, input.caseId);
    if (!verdict.ready || state !== "in_recovery") {
      return { ...verdict, state, lateCutoffPassed };
    }
    const moved = await transition(tx, kase.workflowInstanceId, "discharge_ready", { type: "system", id: "ot.recovery" });
    await appendEvent(tx, daycareDischargeReady.make({
      actor: { type: "system", id: "ot.recovery" }, patientId: kase.patientId, encounterId: input.encounterId,
      payload: {
        encounterId: input.encounterId, caseId: input.caseId, scale: scale.scale,
        total: scores[scores.length - 1]?.total ?? 0, scoreCount: verdict.qualifying, lateCutoffPassed,
      },
    }));
    return { ...verdict, state: moved.state, lateCutoffPassed };
  });
}

/**
 * R-3.23 — is `now` past the unit's IST cut-off? Compared in IST because the cut-off is a wall-clock
 * time a hospital reads off a clock on a wall, and 20:00 IST is 14:30Z: a UTC comparison would send
 * patients home at the wrong hour by five and a half.
 */
export function istTimePassed(now: Date, cutoffHhMm: string): boolean {
  const IST_OFFSET_MINUTES = 330;
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const [h, m] = cutoffHhMm.split(":").map((n) => Number.parseInt(n, 10)) as [number, number];
  const minutesNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutesNow >= h * 60 + m;
}

export type EscortVerification = {
  name: string; relation: string; phone: string; idType: string; idLast4: string;
  ageYears: number; escortPatientId?: string; notifyOk?: boolean;
};

/**
 * A21 — the escort, verified at a NAMED moment. Three refusals, and each is a real case:
 * a minor escort (N2), the patient herself (A7/N14), and — the one a check-in verification cannot
 * catch — an escort whose phone is the PATIENT's, which is how a patient with nobody to collect her
 * gets past a desk in a hurry.
 */
export async function verifyEscort(
  db: Db, actor: Actor,
  input: { encounterId: string; at: "checkin" | "discharge"; escort: EscortVerification },
): Promise<void> {
  await withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);

    if (input.escort.ageYears < 18) {
      throw new OtError("escort_required", `the escort is ${String(input.escort.ageYears)} and must be an adult (N2)`);
    }
    if (input.escort.escortPatientId === encounter.patientId) {
      throw new OtError("escort_required", "a patient cannot escort themselves (A7/N14)");
    }
    const patient = await getPatient(db, actor, encounter.patientId);
    if (patient !== null && patient.patient.phone !== null && patient.patient.phone === input.escort.phone) {
      throw new OtError(
        "escort_required",
        "the escort's phone is the patient's own — that is not a second person (A7)",
        { phone: input.escort.phone },
      );
    }
    /**
     * F24f — a MINOR's escort must be a guardian holding `consents` authority. Anybody may bring a
     * child to hospital; only somebody with authority may take one home.
     */
    if (patient !== null && patient.patient.dob !== null) {
      const ageMs = Date.now() - patient.patient.dob.getTime();
      const isMinor = ageMs < 18 * 365.25 * 86_400_000;
      if (isMinor) {
        const guardians = await guardiansWithAuthority(tx, encounter.patientId);
        const named = guardians.find((g) => g.guardianId === input.escort.escortPatientId
          || g.name === input.escort.name);
        if (!named || !named.authority.consents) {
          throw new OtError(
            "escort_required",
            "a minor is discharged to a guardian holding CONSENT authority, and this escort is not one (F24f)",
            { escort: input.escort.name },
          );
        }
      }
    }

    await tx.update(daycareEncounters).set({
      escort: { ...input.escort, verifiedAt: new Date().toISOString(), verifiedBy: actor.id, at: input.at },
      escortPatientId: input.escort.escortPatientId ?? null,
      updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(daycareEncounters.id, input.encounterId));

    await appendEvent(tx, escortVerified.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId,
      payload: {
        encounterId: input.encounterId, at: input.at,
        relation: input.escort.relation, verifiedBy: actor.id,
      },
    }));
  });
}

/** The escort verification recorded AT a given moment, or undefined. */
function escortVerifiedAt(encounter: typeof daycareEncounters.$inferSelect, at: "checkin" | "discharge"): boolean {
  const escort = encounter.escort as { at?: string } | null;
  return escort?.at === at;
}

/**
 * A21 — discharge. Refused without a DISCHARGE-time escort verification, even when a check-in one
 * exists. Releases the bay into CLEANING (the kernel's `bed` vocabulary — §11.2's cascade).
 */
export async function dischargeDaycare(
  db: Db, actor: Actor, input: { encounterId: string; caseId: string; isbarAcknowledgedBy: string },
): Promise<{ state: string }> {
  return withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);
    const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

    const state = await caseState(tx, input.caseId);
    if (state !== "discharge_ready") {
      throw new OtError("not_discharge_ready", `a case in "${state}" cannot be discharged`, { state });
    }
    if (!escortVerifiedAt(encounter, "discharge")) {
      throw new OtError(
        "escort_required",
        "no DISCHARGE-time escort verification: a check-in verification is evidence about who brought her, not about who is taking her home (E-4)",
      );
    }
    // F7 — the ISBAR handover is acknowledged by a named person, or it did not happen.
    if (input.isbarAcknowledgedBy.trim() === "") {
      throw new OtError("not_discharge_ready", "the ISBAR handover must be acknowledged by a named person (F7)");
    }

    const at = new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "discharged", actor);
    if (encounter.bayResourceId !== null) {
      // `onRelease: "cleaning"` — §11.2's discharge cascade in one field.
      await releaseResource(tx, actor, KERNEL_RESOURCE_KINDS, encounter.bayResourceId, { at, reason: "discharge" });
    }
    await tx.update(daycareEncounters).set({
      status: "discharged", outcome: "discharged", dischargedAt: at, bayResourceId: null,
      updatedBy: actor.id, updatedAt: at,
    }).where(eq(daycareEncounters.id, input.encounterId));

    await appendEvent(tx, daycareDischarged.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId,
      payload: {
        encounterId: input.encounterId, patientId: encounter.patientId,
        bayResourceId: encounter.bayResourceId ?? "", at: at.toISOString(),
      },
    }));
    return { state: moved.state };
  });
}

/**
 * A22 / R-3.6 — **CONVERSION, AND `at` IS THE BILLING BOUNDARY.**
 *
 * Our invoice covers everything up to this instant; the incumbent IPD bills the admission from it.
 * The composer enforces it (F9) by filtering ledger rows on `occurred_at <= converted_at`, so this
 * timestamp is not a record of a decision — it is the line the money is cut along.
 */
export async function convertToAdmission(
  db: Db, actor: Actor,
  input: { encounterId: string; caseId: string; destination?: string; reason: string },
): Promise<{ state: string; convertedAt: Date; handoffDocumentId: string }> {
  return withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);
    const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

    const state = await caseState(tx, input.caseId);
    if (!["in_recovery", "discharge_ready"].includes(state)) {
      throw new OtError("not_discharge_ready", `a case in "${state}" cannot be converted`, { state });
    }
    const at = new Date();
    const handoffDocumentId = newId();
    const moved = await transition(tx, kase.workflowInstanceId, "converted", actor, { note: input.reason });
    if (encounter.bayResourceId !== null) {
      await releaseResource(tx, actor, KERNEL_RESOURCE_KINDS, encounter.bayResourceId, { at, reason: "converted to admission" });
    }
    await tx.update(daycareEncounters).set({
      status: "converted", outcome: "converted", convertedAt: at, bayResourceId: null,
      handoffDocumentId, updatedBy: actor.id, updatedAt: at,
    }).where(eq(daycareEncounters.id, input.encounterId));

    await appendEvent(tx, daycareConvertedToAdmission.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId, occurredAt: at,
      payload: {
        encounterId: input.encounterId, at: at.toISOString(),
        // §4A-3: if the owner names a different destination, this FIELD changes and nothing else.
        destination: input.destination ?? "incumbent_ipd",
        handoffDocumentId,
      },
    }));
    return { state: moved.state, convertedAt: at, handoffDocumentId };
  });
}

/**
 * N9 — the patient walked out. A terminal with the bill issued as-is and a recall task; the cause
 * recorded is whether an escort had been verified at discharge, because "she left with nobody" and
 * "she left with the man who brought her" are different incidents.
 */
export async function markAbsconded(
  db: Db, actor: Actor, input: { encounterId: string; caseId: string; noticedAt?: Date },
): Promise<{ state: string }> {
  return withTx(db, async (tx) => {
    const encounter = (await tx.select().from(daycareEncounters)
      .where(eq(daycareEncounters.id, input.encounterId)))[0];
    if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);
    const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
    if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

    const at = input.noticedAt ?? new Date();
    const moved = await transition(tx, kase.workflowInstanceId, "absconded", actor);
    if (encounter.bayResourceId !== null) {
      await releaseResource(tx, actor, KERNEL_RESOURCE_KINDS, encounter.bayResourceId, { at, reason: "absconded" });
    }
    await tx.update(daycareEncounters).set({
      status: "absconded", outcome: "absconded", bayResourceId: null, updatedBy: actor.id, updatedAt: at,
    }).where(eq(daycareEncounters.id, input.encounterId));

    const incidentId = newId();
    await tx.insert(otIncidents).values({
      id: incidentId, encounterId: input.encounterId, caseId: input.caseId, kind: "wrong_bay_score",
      detail: { kind: "absconded", escortVerifiedAtDischarge: escortVerifiedAt(encounter, "discharge") },
      reportedBy: actor.id,
    });
    await appendEvent(tx, daycareAbsconded.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId, occurredAt: at,
      payload: {
        encounterId: input.encounterId, patientId: encounter.patientId, noticedAt: at.toISOString(),
        escortVerifiedAtDischarge: escortVerifiedAt(encounter, "discharge"),
      },
    }));
    await appendEvent(tx, incidentReported.make({
      actor, patientId: encounter.patientId, encounterId: input.encounterId,
      payload: { incidentId, encounterId: input.encounterId, caseId: input.caseId, kind: "absconded" },
    }));
    return { state: moved.state };
  });
}

/** The two bays and who is in them — the `/ot/recovery` board's whole data. */
export async function recoveryBoard(exec: Db | Tx, actor: Actor): Promise<{
  bayResourceId: string; code: string; status: string;
  occupantType: string | null; occupantRef: string | null;
  /**
   * F20/DD16 — who is in the bay, by the name this actor may see. `occupantRef` is an ENCOUNTER id
   * and always has been; a recovery board that showed only ids would send a nurse to the notes to
   * find out who is in bay 2, so the name is here — and it is `displayName`'s answer, never
   * `patients.name`. A recovery board is the most public surface in the building: it faces the
   * corridor.
   */
  patientDisplay: string | null;
}[]> {
  const rows = await exec.select().from(resources).where(eq(resources.kind, "bed")).orderBy(asc(resources.code));
  const bays = rows
    .filter((r) => (r.attributes as { class?: string } | null)?.class === DAYCARE_RECOVERY_BAY_CLASS);

  // Asked once for the actor, not once per bay — see `listForDay`'s note.
  const canSee = actor.type === "user"
    ? await hasPermission(exec as Db, actor.id, "patients.confidential.read", "hospital")
    : false;

  const occupantIds = bays.map((b) => b.occupantRef).filter((r): r is string => r !== null);
  const occupants = occupantIds.length === 0 ? [] : await exec.select({
    encounterId: daycareEncounters.id,
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
  })
    .from(daycareEncounters)
    .innerJoin(patients, eq(patients.id, daycareEncounters.patientId))
    .where(inArray(daycareEncounters.id, occupantIds));
  const byEncounter = new Map(occupants.map((o) => [o.encounterId, o]));

  return bays.map((r) => {
    const occupant = r.occupantRef === null ? undefined : byEncounter.get(r.occupantRef);
    return {
      bayResourceId: r.id, code: r.code, status: r.status,
      occupantType: r.occupantType, occupantRef: r.occupantRef,
      patientDisplay: occupant === undefined ? null : displayName(occupant, canSee),
    };
  });
}

/** Every score on an encounter, newest last. */
export async function scoresFor(exec: Db | Tx, encounterId: string): Promise<PacuScoreRow[]> {
  return exec.select().from(pacuScores).where(eq(pacuScores.encounterId, encounterId))
    .orderBy(asc(pacuScores.occurredAt));
}
