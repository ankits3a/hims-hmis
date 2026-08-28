import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otCases, otSpecimens } from "../../kernel/db/schema";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { OtError } from "./errors";
import { caseState } from "./booking";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / R-3.21 — **SPECIMENS: the manual chain, until Plan 17's accession.**
 *
 * A gynae D&C or hysteroscopy produces a specimen almost every case, so this cannot be deferred to
 * the lab module: the pot exists whether or not the software does, and a pot with a handwritten
 * label is how specimens get swapped.
 *
 * ═══ F17 — THE LABEL NUMBER IS THE `S` SERIES, AND THE OT DOES NOT INVENT ONE ═══
 *
 * `EPISODE_SERIES.lab_specimen` = `"S"` and has since Plan 05. The OT's own letter is `D` and it is
 * the ENCOUNTER's. A private OT specimen series would mean one tube carrying two numbers the day
 * Plan 17's accession lands, and the histopath report coming back against the one nobody printed.
 *
 * ═══ A10 — THE LABEL IS PRINTED FROM THE OPEN CASE, AND ONLY FROM IT ═══
 *
 * `createSpecimen` refuses unless the case is in theatre. That is the whole control: a label printed
 * from a case that is not open is a label printed at a desk, away from the patient, for a pot that
 * is somewhere else. The states allowed are the ones where a specimen can physically be cut.
 */

export type SpecimenRow = typeof otSpecimens.$inferSelect;

/** The states in which a specimen can physically be taken. */
export const SPECIMEN_STATES = ["timed_out", "incision", "closing"] as const;

export async function createSpecimen(
  tx: Tx, actor: Actor,
  input: { caseId: string; site: string; container: string; serviceDate: string },
): Promise<{ specimenId: string; specimenNo: string }> {
  const kase = (await tx.select().from(otCases).where(eq(otCases.id, input.caseId)))[0];
  if (!kase) throw new OtError("unknown_case", `unknown case ${input.caseId}`);

  const state = await caseState(tx, input.caseId);
  if (!(SPECIMEN_STATES as readonly string[]).includes(state)) {
    throw new OtError(
      "bad_transition",
      `a case in "${state}" cannot produce a specimen label — a label is printed from the OPEN case, at the patient (A10)`,
      { state, allowed: SPECIMEN_STATES },
    );
  }

  const specimenId = newId();
  // The LAB's series, not ours (F17). One tube, one number, when Plan 17's accession lands.
  const specimenNo = await nextEpisodeNo(tx, "lab_specimen", input.serviceDate);
  await tx.insert(otSpecimens).values({
    id: specimenId, caseId: input.caseId, encounterId: kase.encounterId, patientId: kase.patientId,
    specimenNo, site: input.site, container: input.container, createdBy: actor.id,
  });
  return { specimenId, specimenNo };
}

/** The manual chain's second half: where the pot went, and who sent it. Both or neither (the CHECK). */
export async function dispatchSpecimen(
  tx: Tx, actor: Actor, input: { specimenId: string; destination: string },
): Promise<void> {
  const row = (await tx.select().from(otSpecimens).where(eq(otSpecimens.id, input.specimenId)))[0];
  if (!row) throw new OtError("unknown_case", `unknown specimen ${input.specimenId}`);
  if (row.dispatchedAt !== null) {
    throw new OtError("bad_transition", `specimen ${row.specimenNo} was already dispatched to ${String(row.dispatchDestination)}`);
  }
  await tx.update(otSpecimens).set({
    dispatchDestination: input.destination, dispatchedAt: new Date(), dispatchedBy: actor.id,
  }).where(eq(otSpecimens.id, input.specimenId));
}

export async function specimensFor(exec: Db | Tx, caseId: string): Promise<SpecimenRow[]> {
  return exec.select().from(otSpecimens).where(eq(otSpecimens.caseId, caseId));
}
