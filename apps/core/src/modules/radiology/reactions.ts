import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  CONTRAST_REACTION_ONSETS, CONTRAST_REACTION_OUTCOMES, CONTRAST_REACTION_SEVERITIES,
  imagingContrastAdministrations, imagingContrastReactions, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { addAllergy } from "../patients";
import { RadiologyError } from "./errors";
import { imagingContrastReaction } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type {
  ContrastReactionOnset, ContrastReactionOutcome, ContrastReactionSeverity,
} from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a-iii T2 — **THE REACTION, THE ALLERGY WRITE, AND THE LOOP THAT HAS TO CLOSE.**
 *
 * 18a's `prior_contrast_reaction` gate reads the patients module's allergy list. 18a's own
 * out-of-scope note left this phase the other half — *"the reaction that WRITES that allergy is the
 * follow-on's"* — and the phase doc names the failure in one sentence: **a reaction that does not
 * reach the next gate is the defect.**
 *
 * ═══ THE ALLERGY IS NOT AN EVENT, A CONSUMER OR A LATER STEP (D2) ═══
 *
 * It is the same transaction, and `imaging_contrast_reactions.allergy_id` is `NOT NULL`, so a
 * reaction that wrote no allergy is a row the database cannot hold. Everything softer than that —
 * an emitted event a future consumer handles, a service branch that writes "as well" — survives a
 * refactor that drops it while every test about the reaction still passes.
 *
 * ═══ THE SUBSTANCE CARRIES A CLASS LABEL, AND THAT IS THE REAL FIX ═══
 *
 * `isContrastAllergen` matches `patient_allergies.substance` against a TERM LIST, because the column
 * is free text and there is no allergen coding system in this repository to join to. The list holds
 * `omnipaque`, `iohexol`, `gadolinium` and thirteen others — and it does not hold `visipaque`,
 * `xenetix`, `optiray` or whatever a purchasing decision brings in next year. **A reaction to a
 * brand the list has never heard of would write an allergy the next scan's gate cannot see**, which
 * is precisely the defect, arriving through the door built to prevent it.
 *
 * So the substance is written as `"<agent> (contrast media)"`, always, with no branch: it is
 * human-readable on the patient's allergy list, it names the actual product that went in, and it
 * matches `contrast` — a term the list has held since 18a — no matter what the brand is called. One
 * rule rather than a term list somebody has to remember to extend, which is the same argument
 * `gates.ts` makes for over-matching rather than under-matching on a safety flag.
 *
 * ═══ RECORD-ONLY BEYOND THAT (D1) ═══
 *
 * `imaging.contrast_reaction` is emitted for a consumer that does not exist. The hospital-wide
 * incident and ADR registers are the quality pack's (28a) and `incident.reported` is `ot`-LOCAL by
 * its own docstring. Writing into `ot`'s table would make the hospital's incident register a thing
 * `ot` owns by accident of shipping first.
 */

/** The suffix that makes every reaction visible to `isContrastAllergen`, whatever the brand. */
export const CONTRAST_ALLERGY_SUFFIX = " (contrast media)";

export type ContrastReactionRow = typeof imagingContrastReactions.$inferSelect;

export type RecordContrastReactionInput = {
  administrationId: string;
  severity: ContrastReactionSeverity;
  onset: ContrastReactionOnset;
  manifestation: string;
  treatmentGiven?: string | null;
  managingClinicianId?: string | null;
  outcome?: ContrastReactionOutcome | null;
  observedBy: string;
  observedAt: Date;
  now?: Date;
};

/**
 * The substance a reaction to `agent` puts on the patient's allergy list. Pure; one definition.
 *
 * ═══ THIS STRING IS READ OUTSIDE RADIOLOGY, AND THE SHAPE IT MUST KEEP IS NOT OBVIOUS ═══
 *
 * `opd/rx-checks.ts`'s prescription allergy check reads `patient_allergies.substance` and matches it
 * against a prescribed drug's text with a BIDIRECTIONAL substring test:
 * `drug.includes(substance) || substance.includes(drug)`. Appending the class label breaks the FIRST
 * arm — a line reading "Omnipaque 350" no longer contains the whole substance — so the warning
 * survives entirely on the SECOND: **the substance must keep CONTAINING the bare agent name.**
 *
 * That two-way match is not an accident and is not ours to protect: it is the first sentence of that
 * function's docstring ("an allergy to 'sulfa' must catch 'Sulfamethoxazole', and one recorded as
 * 'Penicillin G' must catch a line that says only 'penicillin'") and it is pinned by
 * `rx-checks.test.ts`, whose reverse-arm case fails if anybody makes it one-directional.
 *
 * **The unpinned half was OURS**, which is the point of the test below. If a later change writes
 * `"contrast media: <agent>"`, or drops the agent, or abbreviates it, opd's second arm still runs and
 * simply finds nothing — the prescriber's warning disappears with no error and no red test anywhere.
 * When a dependency spans two modules that cannot import each other, both sides look fragile and
 * usually only one is: the side that owes the test is the one whose change breaks it SILENTLY.
 *
 * (One boundary worth knowing rather than inferring: opd's match is two-way only for substances at
 * or above `MIN_SUBSTRING_LENGTH` — a shorter one takes a token-equality branch that is deliberately
 * one-way. `"<agent> (contrast media)"` is never shorter than eighteen characters, so this design
 * always takes the two-way path. A future shortening of the label would leave that band.)
 */
export function contrastAllergySubstance(agent: string): string {
  return `${agent.trim()}${CONTRAST_ALLERGY_SUFFIX}`;
}

export async function recordContrastReaction(
  tx: Tx,
  actor: Actor,
  input: RecordContrastReactionInput,
): Promise<{ reactionId: string; allergyId: string }> {
  const now = input.now ?? new Date();

  const admins = await tx
    .select()
    .from(imagingContrastAdministrations)
    .where(eq(imagingContrastAdministrations.id, input.administrationId));
  const administration = admins[0];
  if (!administration) {
    throw new RadiologyError(
      "unknown_administration",
      `no contrast administration ${input.administrationId} — a reaction is a reaction TO a dose`,
      { administrationId: input.administrationId },
    );
  }

  /**
   * The study and the patient come off the administration row, never off the caller. A reaction
   * filed against one patient's dose and another patient's id is not a shape this call can be
   * asked to produce, because there is nothing to ask it with.
   */
  const studies = await tx.select().from(imagingStudies)
    .where(eq(imagingStudies.id, administration.studyId));
  const study = studies[0];
  if (!study) {
    throw new RadiologyError("unknown_study", `no study ${administration.studyId}`);
  }

  if (!(CONTRAST_REACTION_SEVERITIES as readonly string[]).includes(input.severity)) {
    throw new RadiologyError("evidence_invalid", `"${input.severity}" is not a reaction severity`);
  }
  if (!(CONTRAST_REACTION_ONSETS as readonly string[]).includes(input.onset)) {
    throw new RadiologyError("evidence_invalid", `"${input.onset}" is not a reaction onset`);
  }
  const outcome = input.outcome ?? null;
  if (outcome !== null && !(CONTRAST_REACTION_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new RadiologyError("evidence_invalid", `"${outcome}" is not a reaction outcome`);
  }

  const manifestation = input.manifestation.trim();
  if (manifestation === "") {
    throw new RadiologyError(
      "evidence_invalid", "a reaction record says what happened — that is the whole record",
    );
  }
  const observedBy = input.observedBy.trim();
  if (observedBy === "") {
    throw new RadiologyError("evidence_invalid", "a reaction names the person who saw it");
  }

  const treatmentGiven = input.treatmentGiven?.trim() || null;
  const managingClinicianId = input.managingClinicianId?.trim() || null;
  /**
   * D3 — severity decides what the record REQUIRES and never who may write it. The CHECK enforces
   * this at the database; this refusal names the fields so a console can point at them, which is the
   * F56 lesson (a constraint violation reaching the floor as a bare 500).
   */
  if (input.severity === "severe" && (treatmentGiven === null || managingClinicianId === null)) {
    throw new RadiologyError(
      "evidence_invalid",
      "a SEVERE contrast reaction carries the treatment given and the clinician who managed it — "
      + "a cardiac arrest with neither is not a record of anything (D3)",
      { severity: input.severity, treatmentGiven, managingClinicianId },
    );
  }

  if (input.observedAt.getTime() > now.getTime()) {
    throw new RadiologyError(
      "invalid_date",
      `the reaction is timed ${input.observedAt.toISOString()}, which has not happened yet`,
    );
  }
  /**
   * A reaction cannot precede the dose it is a reaction to. The mistyped year that makes evidence
   * "fresh" in `gates.ts` is the same typo here, and it would put a reaction on the record before
   * the injection that caused it — which a reader reconstructing the sequence would have no way to
   * resolve.
   */
  if (input.observedAt.getTime() < administration.givenAt.getTime()) {
    throw new RadiologyError(
      "invalid_date",
      `the reaction is timed ${input.observedAt.toISOString()}, before the dose it reacts to was `
      + `given at ${administration.givenAt.toISOString()}`,
      { observedAt: input.observedAt.toISOString(), givenAt: administration.givenAt.toISOString() },
    );
  }

  /**
   * ═══ THE ALLERGY FIRST, BECAUSE THE REACTION ROW CANNOT EXIST WITHOUT ITS ID ═══
   *
   * Written through `patients`' own seam, so it carries `allergy.recorded` and the
   * patient-is-canonical check. A second INSERT site into `patient_allergies` would carry neither,
   * and the allergy list is exactly the table that must have one writer.
   */
  const { allergyId } = await addAllergy(tx, actor, study.patientId, {
    substance: contrastAllergySubstance(administration.agent),
    reaction: manifestation,
    severity: input.severity,
    source: "radiology",
  });

  const reactionId = newId();
  await tx.insert(imagingContrastReactions).values({
    id: reactionId,
    administrationId: administration.id,
    studyId: study.id,
    patientId: study.patientId,
    allergyId,
    severity: input.severity,
    onset: input.onset,
    manifestation,
    treatmentGiven,
    managingClinicianId,
    outcome,
    observedBy,
    observedAt: input.observedAt,
    recordedBy: actor.id,
    recordedAt: now,
  });

  /**
   * The payload carries ids, a severity and an onset. **It does not carry the manifestation** —
   * `events.ts`'s rule for this module is that ids and codes travel and the clinical narrative does
   * not, and `imaging.report_published` carries a criticality and no impression for the same reason.
   */
  await appendEvent(
    tx,
    imagingContrastReaction.make({
      actor,
      patientId: study.patientId,
      payload: {
        studyId: study.id, administrationId: administration.id, reactionId, allergyId,
        severity: input.severity, onset: input.onset,
      },
    }),
  );

  return { reactionId, allergyId };
}

/** Every reaction on a study, oldest first. */
export async function contrastReactionsFor(
  exec: Db | Tx, studyId: string,
): Promise<ContrastReactionRow[]> {
  return (exec as Db)
    .select()
    .from(imagingContrastReactions)
    .where(eq(imagingContrastReactions.studyId, studyId))
    .orderBy(asc(imagingContrastReactions.observedAt), asc(imagingContrastReactions.id));
}

/** Every reaction this PATIENT has ever had, newest first — what a radiologist asks before contrast. */
export async function contrastReactionHistory(
  exec: Db | Tx, patientId: string,
): Promise<ContrastReactionRow[]> {
  return (exec as Db)
    .select()
    .from(imagingContrastReactions)
    .where(eq(imagingContrastReactions.patientId, patientId))
    .orderBy(asc(imagingContrastReactions.observedAt));
}
