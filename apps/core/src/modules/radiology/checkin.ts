import { eq } from "drizzle-orm";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { transition } from "../../kernel/workflow/instances";
import { ageInYearsOn } from "./applicability";
import { RadiologyError } from "./errors";
import { openStudyGate, pregnancyPolicy } from "./gates";
import { requireStudyType } from "./study-types";
import type { PregnancyPolicyBody, StudyType } from "./definitions";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { ImagingGateKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a T5 / DD7 — **CHECK-IN, AND THE GATE SET IS DERIVED FROM FACTS RATHER THAN LISTED.**
 *
 * ═══ WHY THE SET IS COMPUTED AND NOT READ OFF THE STUDY TYPE ═══
 *
 * `studyTypeSchema` carries a `gates` array and every one of the twenty seeds leaves it EMPTY — on
 * purpose, and `study-types.ts`'s header gives the reason in as many words: every gate those twenty
 * types need is derivable from the flags the body already carries (`ionising`, `contrast_option`,
 * `modality`, `pcpndt_applicable`, `chaperone_required`, `laterality_applicable`), so listing them
 * again would be a second source of truth that disagrees with the first the day somebody edits one.
 *
 * `gates` is the seam for the kind that is NOT derivable — an `mlc_check` on an assault-protocol
 * X-ray, 18c's mammography QA gate — and this file UNIONS it in rather than choosing between them.
 *
 * ═══ THE DERIVATION, ROW BY ROW, AND WHAT EACH ROW COSTS IF IT IS WRONG (A1) ═══
 *
 * | opens | when | the mutant's harm |
 * |---|---|---|
 * | `identity_two_factor` | ALWAYS | the wrong Ram Kumar is scanned, and nothing in the record says which one |
 * | `pregnancy_screen` | `ionising` ∧ female ∧ in the policy's age band (or age UNKNOWN) | A1's own mutant: drop the sex check and every male gets a pregnancy declaration, and the gate becomes noise the floor routes around |
 * | `contrast_consent`, `renal_function`, `prior_contrast_reaction` | `contrast_option === 'required'` | contrast given to a patient nobody asked, with a creatinine nobody read |
 * | `mri_safety` | `modality === 'mri'` | a pacemaker enters a 1.5 T bore |
 * | `form_f` | the STUDY's `form_f_required`, frozen at placement | an unregistered obstetric scan |
 * | `chaperone_present` | `chaperone_required` | a pelvic ultrasound performed alone |
 * | `laterality_confirm` | `laterality_applicable` | the left knee is imaged and the right one hurts |
 * | the type's own `gates[]` | always, as a union | the non-derivable kind never opens |
 *
 * ═══ TWO THINGS THIS DELIBERATELY DOES NOT DO ═══
 *
 * **`contrast_option: 'optional'` opens NONE of the three contrast gates**, and that is a decision
 * rather than an omission (§9.2). Whether contrast is given is decided at the CONSOLE, and a
 * consent gate opened at check-in for a scan that turns out to need no contrast is a gate the floor
 * learns to click past — which is A1's own stated failure mode. `gates.ts` exports `openStudyGate`
 * so T7 can open the three at the moment the decision is actually taken, and T7's `recordAcquired`
 * is where `contrast_given: true` without them is refused.
 *
 * **It re-reads `pcpndt_applicable` from nothing.** The PCPNDT decision was taken at PLACEMENT by
 * `pcpndtApplicability` and frozen onto `imaging_studies.form_f_required` (T3). Recomputing it here
 * would be a second reader of a statutory rule — the exact defect F13 was opened and closed over —
 * and it would answer differently for a patient whose date of birth was corrected in between.
 */

/** The gate set a check-in opens, in a stable order so a console and a test read the same list. */
export type DerivedGateSet = {
  kinds: ImagingGateKind[];
  /** Why the pregnancy screen did or did not open — the technologist WILL ask. */
  pregnancyReason: "opened" | "not_ionising" | "sex_not_female" | "age_outside_band";
};

/**
 * The pure half, so every branch can be walked without a database — `applicability.ts`'s argument
 * for the same split, and for the same reason: a rule that decides whether a safety control exists
 * should be testable at every boundary rather than at whatever age the e2e fixture happens to be.
 */
export function deriveGateSet(
  studyType: StudyType,
  patient: { sex: string; dob: Date | null },
  study: { formFRequired: boolean },
  policy: PregnancyPolicyBody,
  asOf: Date,
): DerivedGateSet {
  const kinds = new Set<ImagingGateKind>(["identity_two_factor"]);

  let pregnancyReason: DerivedGateSet["pregnancyReason"] = "not_ionising";
  if (studyType.ionising) {
    if (patient.sex !== "female") {
      pregnancyReason = "sex_not_female";
    } else {
      /**
       * An ABSENT date of birth opens the screen, exactly as it makes a covered study PCPNDT
       * applicable (`applicability.ts`'s header): the costs are not symmetrical. Over-applying
       * costs a declaration from a woman who turns out to be 71; under-applying is an X-ray on an
       * early pregnancy nobody asked about.
       */
      const age = patient.dob === null ? null : ageInYearsOn(patient.dob, asOf);
      const inBand = age === null
        || (age >= policy.min_age_years && age <= policy.max_age_years);
      if (inBand) {
        kinds.add("pregnancy_screen");
        pregnancyReason = "opened";
      } else {
        pregnancyReason = "age_outside_band";
      }
    }
  }

  if (studyType.contrast_option === "required") {
    kinds.add("contrast_consent");
    kinds.add("renal_function");
    kinds.add("prior_contrast_reaction");
  }
  if (studyType.modality === "mri") kinds.add("mri_safety");
  if (study.formFRequired) kinds.add("form_f");
  if (studyType.chaperone_required) kinds.add("chaperone_present");
  if (studyType.laterality_applicable) kinds.add("laterality_confirm");

  /** The seam for the non-derivable kind. A union, never a replacement. */
  for (const kind of studyType.gates) kinds.add(kind);

  return { kinds: [...kinds].sort(), pregnancyReason };
}

export type CheckInResult = {
  studyId: string;
  status: string;
  gates: ImagingGateKind[];
  pregnancyReason: DerivedGateSet["pregnancyReason"];
  policySource: "published" | "default";
};

/**
 * The patient is at the door. `scheduled → checked_in`, the gate set opens, and the study is NOT
 * ready — `evaluateReadiness` is the only thing that makes it so (workflow-def.ts: that transition
 * is the `system`'s alone).
 *
 * **`checked_in` and `ready` are two states rather than one**, which is B7: a patient can be
 * physically present with an open gate — the creatinine has not come back — and a worklist has to
 * distinguish "not here yet" from "here and waiting on the lab". Every study opens at least
 * `identity_two_factor`, so no check-in has ever produced a ready study and none should.
 *
 * Idempotent in the direction that matters: `openStudyGate` returns the existing gate rather than
 * colliding, so a re-run after a partial failure re-opens nothing. The STATE transition is not
 * idempotent and should not be — a second check-in of a checked-in study is `bad_transition`, which
 * is the honest answer.
 */
export async function checkIn(
  tx: Tx,
  actor: Actor,
  input: { studyId: string; now?: Date },
): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  const studyRows = await (tx as unknown as Db).select().from(imagingStudies)
    .where(eq(imagingStudies.id, input.studyId));
  const study = studyRows[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });

  if (study.status !== "scheduled") {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} is ${study.status} and cannot be checked in`,
      { studyId: input.studyId, status: study.status },
    );
  }
  /**
   * A study with no slot is a study nobody is expecting. The walk-in path (T4's `autoSlotWalkIn`)
   * gives the counter a slot in one call, so this refuses rather than inventing one — a check-in
   * that silently booked a machine would be scheduling, and scheduling is a permission this route
   * does not carry.
   */
  if (study.deviceResourceId === null || study.scheduledAt === null) {
    throw new RadiologyError(
      "bad_transition",
      `study ${input.studyId} has no slot — book it or walk it in before checking the patient in`,
      { studyId: input.studyId },
    );
  }

  const studyType = await requireStudyType(tx, study.studyTypeCode);
  const patientRows = await (tx as unknown as Db)
    .select({ sex: patients.sex, dob: patients.dob })
    .from(patients).where(eq(patients.id, study.patientId));
  const patient = patientRows[0];
  if (!patient) {
    throw new RadiologyError("unknown_study", `study ${study.id} names no live patient`, { studyId: study.id });
  }
  const { policy, source } = await pregnancyPolicy(tx);

  const derived = deriveGateSet(studyType, patient, { formFRequired: study.formFRequired }, policy, now);

  await transition(tx, study.workflowInstanceId, "checked_in", actor);
  await tx.update(imagingStudies)
    .set({ status: "checked_in", checkedInAt: now })
    .where(eq(imagingStudies.id, study.id));

  for (const kind of derived.kinds) await openStudyGate(tx, study, kind);

  return {
    studyId: study.id,
    status: "checked_in",
    gates: derived.kinds,
    pregnancyReason: derived.pregnancyReason,
    policySource: source,
  };
}
