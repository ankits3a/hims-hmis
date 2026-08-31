import { activeDefinition } from "./definitions";
import { RadiologyError } from "./errors";
import type { StudyType, StudyTypesBody } from "./definitions";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18a T4 / DD13 — **THE STUDY-TYPE BOOK: the twenty seeds, and the ONE reader of them.**
 *
 * ═══ THIS FILE CLOSES FINDING F13 ═══
 *
 * T3 needed `pcpndt_applicable` at placement and this file did not exist, so `place.ts` grew its own
 * `activeStudyTypes` / `studyTypeByService`. F13 recorded the debt in as many words: *"T4 must make
 * `study-types.ts` the single owner and have this delegate, or the hospital will have two readers of
 * one book."* **It does, and `place.ts` now re-exports these rather than keeping a copy.** A second
 * reader of a statutory flag is exactly the shape of defect the whole PCPNDT design is trying to
 * avoid.
 *
 * ═══ THE SEEDS CARRY A SERVICE **CODE**, NOT A SERVICE ID ═══
 *
 * `services.id` is a ULID minted when the row is created, so it cannot be written into a constant.
 * The seeds name a tariff CODE; `scripts/seed-radiology.ts` finds-or-creates each service and
 * substitutes the id it gets back. That is also why the seed script is a runbook step rather than a
 * migration: the tariff is the owner's data (spike S6 measured production carrying SIX services and
 * no imaging service at all), and a phase that invented prices would be inventing money.
 *
 * ═══ WHY EVERY SEED'S `gates` ARRAY IS EMPTY, AND THE FIELD IS STILL RIGHT TO HAVE ═══
 *
 * DD7 evaluates the gate SET at check-in from the patient's sex and age and the type's own FLAGS —
 * `ionising`, `contrast_option`, `modality === 'mri'`, `pcpndt_applicable`, `chaperone_required`,
 * `laterality_applicable`. Every gate these twenty types need is derivable from those, so listing
 * them again here would be a second source of truth for the same fact, and the two would disagree
 * the first time somebody edited one.
 *
 * `gates` exists for the kind that is NOT derivable: an `mlc_check` on a specific assault-protocol
 * X-ray, 18c's mammography QA gate. The field is the seam for those; today it is honestly empty.
 */

/** A seed row: a study type with its tariff CODE in place of the id the seeder resolves. */
export type StudyTypeSeed = Omit<StudyType, "service_id"> & { service_code: string };

const xray = { modality: "xray", ionising: true, contrast_option: "none", pcpndt_applicable: false } as const;
const usg = { modality: "usg", ionising: false, contrast_option: "none" } as const;
const ct = { modality: "ct", ionising: true, pcpndt_applicable: false } as const;
const mri = { modality: "mri", ionising: false, pcpndt_applicable: false } as const;

/** The three flags most types share. `gates` is a fresh array per row — see the header. */
const plain = () => ({ chaperone_required: false, laterality_applicable: false, gates: [] });

/**
 * **TWENTY STUDY TYPES**, across the five modalities the seed script provisions. The set is chosen
 * to exercise every flag the evaluator branches on rather than to be a catalogue: an ionising type
 * with no contrast, one with required contrast, a lateralised type, three PCPNDT-applicable types,
 * an MRI with and without gadolinium, and a mammography.
 */
export const STUDY_TYPE_SEEDS: readonly StudyTypeSeed[] = [
  /* ── X-ray: ionising, no contrast ─────────────────────────────────────────── */
  { ...xray, ...plain(), code: "XR-CHEST", name: "X-ray chest PA", body_part: "chest", service_code: "RAD-XR-CHEST", duration_min: 10 },
  { ...xray, ...plain(), code: "XR-KUB", name: "X-ray KUB", body_part: "abdomen", service_code: "RAD-XR-KUB", duration_min: 10 },
  { ...xray, ...plain(), code: "XR-SPINE-LS", name: "X-ray lumbosacral spine", body_part: "spine", service_code: "RAD-XR-SPINE-LS", duration_min: 15 },
  { ...xray, ...plain(), code: "XR-SKULL", name: "X-ray skull", body_part: "head", service_code: "RAD-XR-SKULL", duration_min: 10 },
  /**
   * LATERALISED — T8 refuses a signed report whose side disagrees with the order item's. ONE
   * lateralised X-ray is enough to exercise that branch; the first draft of this list carried a
   * second (a shoulder) and came to twenty-ONE, which `definitions.test.ts` caught against DD13's
   * stated twenty. The seed list is the thing that was wrong, not the assertion.
   */
  { ...xray, ...plain(), code: "XR-KNEE", name: "X-ray knee", body_part: "knee", service_code: "RAD-XR-KNEE", duration_min: 10, laterality_applicable: true },

  /* ── Ultrasound: not ionising; three of these are the Act's ────────────────── */
  { ...usg, ...plain(), code: "USG-ABDO", name: "USG whole abdomen", body_part: "abdomen", service_code: "RAD-USG-ABDO", duration_min: 20, pcpndt_applicable: false },
  { ...usg, ...plain(), code: "USG-KUB", name: "USG KUB", body_part: "abdomen", service_code: "RAD-USG-KUB", duration_min: 15, pcpndt_applicable: false },
  { ...usg, ...plain(), code: "USG-THYROID", name: "USG thyroid", body_part: "neck", service_code: "RAD-USG-THYROID", duration_min: 15, pcpndt_applicable: false },
  { ...usg, ...plain(), code: "USG-DOPPLER-LL", name: "USG venous doppler, lower limb", body_part: "lower limb", service_code: "RAD-USG-DOPPLER-LL", duration_min: 30, pcpndt_applicable: false, laterality_applicable: true },
  /**
   * ═══ THE THREE THE PCPNDT ACT COVERS ═══
   *
   * `pcpndt_applicable: true` is what T3's rule reads. Combined with a female patient aged 10–55 it
   * makes the order item `restricted` and the study `form_f_required`, and `recordAcquired` (T7)
   * refuses without a Form F. All three carry `chaperone_required` as well: a pelvic or obstetric
   * ultrasound performed without a chaperone is an exposure nobody should be arranging.
   */
  { ...usg, ...plain(), code: "USG-PELVIS", name: "USG pelvis", body_part: "pelvis", service_code: "RAD-USG-PELVIS", duration_min: 20, pcpndt_applicable: true, chaperone_required: true },
  { ...usg, ...plain(), code: "USG-OBS-EARLY", name: "USG obstetric, first trimester", body_part: "obstetric", service_code: "RAD-USG-OBS-EARLY", duration_min: 20, pcpndt_applicable: true, chaperone_required: true },
  { ...usg, ...plain(), code: "USG-OBS-ANOMALY", name: "USG obstetric anomaly scan", body_part: "obstetric", service_code: "RAD-USG-OBS-ANOMALY", duration_min: 30, pcpndt_applicable: true, chaperone_required: true },

  /* ── CT: ionising; one with required contrast ──────────────────────────────── */
  { ...ct, ...plain(), code: "CT-HEAD-PLAIN", name: "CT head, plain", body_part: "head", service_code: "RAD-CT-HEAD", duration_min: 15, contrast_option: "none" },
  { ...ct, ...plain(), code: "CT-CHEST-PLAIN", name: "CT chest, plain", body_part: "chest", service_code: "RAD-CT-CHEST", duration_min: 20, contrast_option: "none" },
  { ...ct, ...plain(), code: "CT-KUB", name: "CT KUB", body_part: "abdomen", service_code: "RAD-CT-KUB", duration_min: 15, contrast_option: "none" },
  /** `required` contrast opens contrast_consent + renal_function + prior_contrast_reaction (T5 A1). */
  { ...ct, ...plain(), code: "CT-ABDO-CONTRAST", name: "CT abdomen, with contrast", body_part: "abdomen", service_code: "RAD-CT-ABDO-CONTRAST", duration_min: 30, contrast_option: "required" },

  /* ── MRI: not ionising, and every one opens the safety gate by modality ────── */
  { ...mri, ...plain(), code: "MRI-BRAIN-PLAIN", name: "MRI brain, plain", body_part: "head", service_code: "RAD-MRI-BRAIN", duration_min: 40, contrast_option: "none" },
  { ...mri, ...plain(), code: "MRI-LS-SPINE", name: "MRI lumbosacral spine", body_part: "spine", service_code: "RAD-MRI-LS-SPINE", duration_min: 40, contrast_option: "none" },
  { ...mri, ...plain(), code: "MRI-BRAIN-GAD", name: "MRI brain, with gadolinium", body_part: "head", service_code: "RAD-MRI-BRAIN-GAD", duration_min: 50, contrast_option: "required" },

  /* ── Mammography ───────────────────────────────────────────────────────────── */
  { ...usg, ...plain(), code: "MMG-BILATERAL", name: "Mammography, bilateral", body_part: "breast", service_code: "RAD-MMG-BILATERAL", duration_min: 20, modality: "mammography", ionising: true, pcpndt_applicable: false, chaperone_required: true },
];

/** A pure lookup over a body already in hand — no I/O, so callers holding a body do not re-read. */
export function studyTypeFor(body: StudyTypesBody, code: string): StudyType | undefined {
  return body.types.find((t) => t.code === code);
}

/**
 * ═══ THE ONE READER OF THE ACTIVE BOOK (F13) ═══
 *
 * Throws `definition_not_active` when nothing is published, and every caller lets that through:
 * a hospital with no study-type book cannot place or schedule an imaging order at all.
 */
export async function activeStudyTypes(exec: Db | Tx): Promise<StudyType[]> {
  const body = await activeDefinition(exec, "study_types");
  return body.types;
}

/**
 * `serviceId` → the ONE study type that names it.
 *
 * `studyTypesBodySchema` refuses a duplicate `service_id` at DRAFT and again at PUBLISH, so an
 * ambiguous body cannot become active through the API. This still refuses one at READ time, because
 * defence-in-depth is what the publish-time re-validation is for as well: a body that reached the
 * table around the API — a data fix, a restored dump — must not decide a statutory question by
 * array order.
 */
export async function studyTypeByService(exec: Db | Tx): Promise<Map<string, StudyType>> {
  const types = await activeStudyTypes(exec);
  const byService = new Map<string, StudyType>();
  for (const type of types) {
    const seen = byService.get(type.service_id);
    if (seen) {
      throw new RadiologyError(
        "definition_invalid",
        `two study types name service ${type.service_id} (${seen.code} and ${type.code}) — PCPNDT `
        + "applicability would depend on which one a reader found first",
        { serviceId: type.service_id },
      );
    }
    byService.set(type.service_id, type);
  }
  return byService;
}

/** `code` → the study type, refusing an unknown one rather than returning undefined. */
export async function requireStudyType(exec: Db | Tx, code: string): Promise<StudyType> {
  const types = await activeStudyTypes(exec);
  const type = types.find((t) => t.code === code);
  if (!type) {
    throw new RadiologyError(
      "unknown_study_type",
      `no study type "${code}" in the active book`,
      { code },
    );
  }
  return type;
}
