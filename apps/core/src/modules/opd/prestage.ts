import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { opdEncounters, opdVitals } from "../../kernel/db/schema";
import { getPatient, getPatientSummaries } from "../patients";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { loadOpdConfig } from "./config";
import { OpdError } from "./errors";
import { ageYearsAt } from "./time";
import { bandFor, evaluateVitals } from "./vitals-rules";
import type { BandConfig, BandKey, DangerRangesConfig, VitalKey } from "./config";
import type { DangerFlag } from "./events";
import type { Db } from "../../kernel/db/client";

/**
 * ══════════ VD-1 T4 — WHAT THE BAY KNOWS BEFORE THE PATIENT SITS DOWN ══════════
 *
 * *"Slip scanned — T-118 Sunita Devi. File, last vitals June, band and cuff size staged before she
 * reached the stool."* That sentence is the seat's opening move, and until this file existed the
 * server could not answer it for the person who works the bay.
 *
 * ═══ THE PERMISSION IS THE POINT, NOT THE PAYLOAD (recon §3 R15) ═══
 *
 * `vitals_desk` holds `opd.visits.read`, `opd.vitals.record`, `opd.queue.read`, `patients.read`
 * and `patients.update`. The cross-visit reader `GET /opd/patients/:id/vitals` is gated on
 * **`opd.consult`** — a doctor's permission. So the seat's two headline behaviours, pre-staging
 * from the last reading and carrying a height forward, were **unreachable by the role that works
 * the bench**. That is not a screen problem and no screen can fix it.
 *
 * The answer is a NEW NARROW PERMISSION, `opd.vitals.history.read`, and deliberately not either
 * of the two easier things:
 *
 *   · **not `opd.consult` granted to the bay** — that is the whole consultation surface, including
 *     prescriptions and the cross-visit prescription history, to buy one number;
 *   · **not `patientVitalsHistory` re-gated** — that reader returns EVERY reading this person has
 *     ever had, across the merge chain, and the bay needs the last one. A permission whose name
 *     says "history" over a payload that is one row is a permission that will be widened by
 *     somebody who read the name.
 *
 * `seed-roles.ts`'s own precedent, quoted at the `vitals_desk` block: *"a narrow grant can be
 * widened later without anybody being locked out in the meantime, and the reverse is not true."*
 *
 * ═══ ITS PHI SURFACE IS ITS OWN NAME ═══
 *
 * `opd.vitals_prestage`, for the reason `opd.rx_history` is not `opd.prescriptions`: an audit log
 * that cannot tell a one-row pre-stage from a full cross-visit history answers *"what did they
 * actually see"* wrong, which is the only question it exists for.
 */

export type PreStage = {
  patientId: string;
  ageYears: number | null;
  band: BandKey;
  /**
   * VD-2 CLOSE / pass-1 CRITICAL — THE BAND'S LIMITS TRAVEL WITH THE PRE-STAGE. The bay mirrored
   * its gates from `GET /opd/config`, which is `opd.masters.read` — a permission `vitals_desk` does
   * not hold — so for the one role that works the bench every mirror and the whole other-arm
   * protocol were silently unreachable. The reader the bay already holds now carries exactly what
   * the tiles need: this band's ranges, its notice ranges, the three gate numbers and the MUAC zones.
   */
  ranges: BandConfig["ranges"];
  noticeRanges: BandConfig["noticeRanges"];
  gates: DangerRangesConfig["gates"];
  muacBands: DangerRangesConfig["muacBands"];
  /** True when the patient is confidential to this actor: the band is answered, the history is not (T0/F6's rule). */
  sealed: boolean;
  /** The band's demanded set, and the ones it records but never range-flags (D5). */
  required: VitalKey[];
  notRoutine: VitalKey[];
  last: {
    vitalsId: string;
    recordedAt: Date;
    serviceDate: string;
    heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
    pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null; muacCm: number | null;
  } | null;
  /**
   * Keys the bay may offer to carry forward rather than measure — and the server's T2 lock will
   * hold them to the carried NUMBER unless a preset reason is named.
   */
  carryCandidates: VitalKey[];
  /**
   * What the LAST reading flagged, evaluated against TODAY's band. Not a prediction: it is the
   * honest "this is what happened last time" that lets the bay put the cuff on first.
   */
  expectedFlags: DangerFlag[];
};

/**
 * ═══ ONLY HEIGHT CARRIES, AND ONLY FOR AN ADULT — DECIDED ═══
 *
 * Height is the one vital that genuinely does not change between visits for a grown adult, which
 * is why flow3 T5 ruled it carried-and-locked and why the design greys it. Everything else is
 * measured every time: a weight carried forward is the entire point of the weighing scale, and a
 * child's height changing IS the clinical finding.
 *
 * Eighteen is the boundary rather than the band's, because `weightRequiredUnderYears` is already
 * 18 in the shipped config and a second, different adulthood in the same module is a thing to get
 * wrong. Unknown DOB carries nothing: the adult band is a fallback for RANGES, and using it to
 * license a carried number would let an unknown age silently inherit a stranger's height.
 */
function carryCandidatesFor(ageYears: number | null, last: { heightCm: number | null } | null): VitalKey[] {
  if (last === null || last.heightCm === null) return [];
  if (ageYears === null || ageYears < 18) return [];
  return ["heightCm"];
}

/**
 * The bay's opening read. A confidential patient answers exactly as an unknown one does — the
 * 07a rule, inherited from `getPatient` rather than re-implemented, because a distinct refusal
 * confirms the record exists to somebody who may not be allowed to know that.
 */
export async function preStage(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<PreStage> {
  const encounters = await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId));
  const encounter = encounters[0];
  if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);

  /*
   * VD-2 CLOSE / pass-1 MAJOR — A CONFIDENTIAL PATIENT IS STAGED WITHOUT HISTORY, NOT REFUSED.
   * The bay charts a sealed patient (the record path reads the patient through the aliased
   * summary — T0/F6), so refusing the pre-stage left the bay capturing a sealed four-year-old on
   * the ADULT tile set: no MUAC tile, the adult weight gate, and `vitals_incomplete: muacCm` for a
   * tile that never rendered. One rule now: whoever may write the chart is told the BAND; the
   * cross-visit HISTORY (the last chart, the carry, the expected flags) stays behind the
   * confidential gate and answers as nothing.
   */
  const visible = await getPatient(db, actor, encounter.patientId);
  const [summary] = await getPatientSummaries(db, actor, [encounter.patientId]);
  if (visible === null && summary === undefined) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const patientId = visible?.patient.id ?? summary!.id;
  const sealed = visible === null;
  const dob = visible?.patient.dob ?? summary?.dob ?? null;

  await recordPhiAccess(db, {
    actor, patientId, surface: "opd.vitals_prestage", encounterId,
    sealed: visible?.patient.isConfidential ?? true, reason: visible?.breakGlass?.reason ?? null,
  });

  const cfg = await loadOpdConfig(db);
  const ageYears = dob === null ? null : ageYearsAt(dob, now);
  const band = bandFor(ageYears, cfg.dangerRanges);

  // The last ACTIVE chart for the CANONICAL patient. Superseded rows are an amendment's
  // predecessor and are not what anything is carried from (D2). Sealed: no history at all.
  const rows = sealed ? [] : await db
    .select({ v: opdVitals, serviceDate: opdEncounters.serviceDate })
    .from(opdVitals)
    .innerJoin(opdEncounters, eq(opdVitals.encounterId, opdEncounters.id))
    .where(and(eq(opdVitals.patientId, patientId), eq(opdVitals.status, "active")))
    .orderBy(desc(opdVitals.recordedAt)).limit(1);

  const row = rows[0];
  const last = row === undefined ? null : {
    vitalsId: row.v.id, recordedAt: row.v.recordedAt, serviceDate: row.serviceDate,
    heightCm: row.v.heightCm, weightKg: row.v.weightKg, sbp: row.v.sbp, dbp: row.v.dbp,
    pulse: row.v.pulse, rr: row.v.rr, spo2: row.v.spo2, tempC: row.v.tempC, muacCm: row.v.muacCm,
  };

  return {
    patientId,
    ageYears, band: band.key,
    ranges: band.ranges, noticeRanges: band.noticeRanges,
    gates: cfg.dangerRanges.gates, muacBands: cfg.dangerRanges.muacBands,
    sealed,
    required: [...band.required],
    notRoutine: [...band.notRoutine],
    last,
    carryCandidates: carryCandidatesFor(ageYears, last),
    // Evaluated against TODAY's band, not the band the reading was taken under: a four-year-old
    // who is now six is judged by the limits that apply to the person in front of the nurse.
    expectedFlags: last === null ? [] : evaluateVitals(last, band, cfg.dangerRanges),
  };
}
