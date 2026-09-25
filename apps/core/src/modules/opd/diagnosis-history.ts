import { and, desc, eq, isNotNull } from "drizzle-orm";
import { anyOfText } from "../../kernel/db/any-of";
import { opdEncounterDiagnoses, opdEncounters } from "../../kernel/db/schema";
import { listMergedLoserIds } from "../patients";
import type { Eye } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CODED DIAGNOSES A PATIENT CARRIES — AND WHY THIS IS NOT A PROBLEM LIST ═══
 *
 * P24 needs to know what this patient's disease forbids. This system has no problem list:
 * `opd_encounter_diagnoses` is keyed `(encounter_id, seq)` and has no patient column, no status, no
 * onset and no resolved-at. Building one is an MRD phase with its own rules about who may retire a
 * diagnosis, and inventing half of it here would be worse than not having it.
 *
 * So this read says exactly what the database knows and no more: **every coded diagnosis ever
 * recorded for this patient, with the date of the visit that recorded it.** The caller decides what
 * age means — P24 gates on a code under a year old and softens anything older to a notice, and the
 * alert names the date so the prescriber judges the evidence rather than the system pretending to.
 *
 * ═══ MERGED PATIENTS ═══
 *
 * A patient registered twice and merged keeps their history under the losing id. Asthma recorded
 * before the merge is still asthma, so the losing ids are read too — `aerb/dose.ts` walks the same
 * path for the same reason. Missing a chronic diagnosis because the front desk merged a duplicate
 * is precisely the failure this feature exists to prevent.
 *
 * ═══ UNCODED DIAGNOSES ARE NOT RETURNED, AND THAT IS A KNOWN LIMIT ═══
 *
 * `icd10_code` is null when the doctor TYPED a diagnosis instead of picking one from the catalogue
 * (the column's own comment says so). Those rows are invisible here: a check that matched English
 * prose against disease names would fire on "no asthma" and on "family history of asthma", and a
 * false alert costs more than a missing one. The consult screen's typeahead is what makes a
 * diagnosis carry a code, and that is where the coverage problem belongs.
 */
export type CodedDiagnosis = {
  /** Upper-cased and dotted, as the catalogue stores it: `J45.909`. */
  code: string;
  /** The doctor's own words for it, which the alert quotes rather than the catalogue's. */
  text: string;
  /** The service date of the visit that recorded it: `2026-09-17`. */
  codedOn: string;
  encounterId: string;
  /** Which eye, on an eye code only (board "Ophthal"); null everywhere else. */
  laterality: Eye | null;
};

export async function listCodedDiagnoses(db: Db, patientId: string): Promise<CodedDiagnosis[]> {
  if (patientId === "") return [];
  const ids = [patientId, ...await listMergedLoserIds(db, patientId)];
  const rows = await db.select({
    code: opdEncounterDiagnoses.icd10Code,
    text: opdEncounterDiagnoses.text,
    laterality: opdEncounterDiagnoses.laterality,
    codedOn: opdEncounters.serviceDate,
    encounterId: opdEncounters.id,
  })
    .from(opdEncounterDiagnoses)
    .innerJoin(opdEncounters, eq(opdEncounters.id, opdEncounterDiagnoses.encounterId))
    .where(and(
      anyOfText(opdEncounters.patientId, ids),
      isNotNull(opdEncounterDiagnoses.icd10Code),
    ))
    .orderBy(desc(opdEncounters.serviceDate));

  return rows.flatMap((r) => r.code === null || r.code.trim() === ""
    ? []
    : [{ code: r.code.trim().toUpperCase(), text: r.text, codedOn: r.codedOn, encounterId: r.encounterId, laterality: r.laterality as Eye | null }]);
}
