import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  CONTRAST_ROUTES, INTRAVASCULAR_CONTRAST_ROUTES, imagingContrastAdministrations, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { listAllergies } from "../patients";
import { RadiologyError } from "./errors";
import { imagingContrastAdministered } from "./events";
import { IMAGING_TERMINAL_GATE_STATES, isContrastAllergen, studyGates } from "./gates";
import { requireStudyType } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ContrastRoute } from "../../kernel/db/schema/radiology";
import type { StudyType } from "./definitions";

/**
 * PLAN 18a-iii T1 — **THE CONTRAST ADMINISTRATION RECORD, and the one place the contrast safety
 * question is asked.**
 *
 * 18a shipped `contrast_given`, `contrast_agent` and `contrast_volume_ml` as three columns the
 * console fills in at acquisition, guarded by a block inside `recordAcquired` that re-reads the
 * allergy list, refuses a non-contrast study type and demands a terminal consent gate. That block
 * was the only contrast safety check in the building and it lived inside one caller.
 *
 * This task adds a SECOND writer of contrast facts, and a second writer is exactly how a safety
 * check becomes two safety checks that disagree. So the block moved: `assertContrastPermissible`
 * below is that code, unchanged in behaviour, and `recordAcquired` now calls it. **There is one
 * definition of "may contrast go into this patient" and both doors ask it** — the asymmetry-scan
 * rule that a fix is made by making ONE definition and never by patching N sites.
 *
 * ═══ WHY THE ADMINISTRATION IS NOT SIMPLY A FIELD ON ACQUISITION ═══
 *
 * Because the injection and the scan are not the same event, and the case that proves it is the one
 * this whole chain exists for: contrast goes in at 09:40, the patient reacts, the scan is
 * ABANDONED. `recordAcquired` never runs. A design that carried the dose on the acquisition would
 * lose the record of the only injection that mattered — and T2's reaction row would hang off
 * nothing. `RECORDABLE_STATUSES` therefore includes a `cancelled` study that had reached the table.
 */

/** Every state in which contrast could actually have entered a patient. Nothing else may claim it. */
export const CONTRAST_RECORDABLE_STATUSES: readonly string[] = [
  "in_acquisition", "acquired", "reported", "published", "cancelled",
];

export type ContrastAdministrationRow = typeof imagingContrastAdministrations.$inferSelect;

export type RecordContrastInput = {
  studyId: string;
  agent: string;
  volumeMl: number;
  route: ContrastRoute;
  site?: string | null;
  vialBatchNo?: string | null;
  /** The vial's printed expiry, `YYYY-MM-DD`. Optional; an expiry that IS given is enforced. */
  vialExpiry?: string | null;
  givenBy: string;
  givenAt: Date;
  now?: Date;
};

/**
 * ═══ THE CONTRAST SAFETY QUESTION — MOVED HERE FROM `recordAcquired`, BEHAVIOUR UNCHANGED ═══
 *
 * The three refusals, in the order 18a T7/F67 put them and for the reasons its comments give:
 *
 *   1. **The allergy list is re-read at the injection (F67).** A gate's evidence is read once, at
 *      the instant it is satisfied, and its terminal state is permanent. Between a gate cleared at
 *      09:05 against an empty list and 100 ml of iohexol at 09:40, nothing asked again. This is the
 *      LAST READ before the syringe, and only the radiologist's OVERRIDE goes past a documented
 *      reaction.
 *   2. **A `contrast_option: 'none'` study type never receives contrast.**
 *   3. **The consent gate must be TERMINAL.** `optional` study types open no contrast gates at
 *      check-in (T5's decision — whether contrast is given is decided at the console), so this is
 *      the obligation T5 recorded and T7 owed.
 */
export async function assertContrastPermissible(
  tx: Tx,
  study: { id: string; patientId: string; studyTypeCode: string },
  studyType: StudyType,
): Promise<void> {
  const allergies = await listAllergies(tx as unknown as Db, study.patientId);
  const contrastAllergy = allergies.find(
    (a) => a.status === "active" && isContrastAllergen(a.substance),
  );
  if (contrastAllergy) {
    const gate = (await studyGates(tx, study.id)).find((g) => g.kind === "prior_contrast_reaction");
    if (gate?.state !== "overridden") {
      throw new RadiologyError(
        "contrast_mismatch",
        `${contrastAllergy.substance} is on this patient's allergy list and contrast is being `
        + "recorded — the list changed after the gate was cleared, and only the radiologist's "
        + "override goes past a documented reaction (P2/E38, F67)",
        { studyId: study.id, substance: contrastAllergy.substance },
      );
    }
  }

  if (studyType.contrast_option === "none") {
    throw new RadiologyError(
      "contrast_mismatch",
      `${study.studyTypeCode} is a non-contrast examination and contrast was recorded`,
      { studyTypeCode: study.studyTypeCode },
    );
  }
  const gates = await studyGates(tx, study.id);
  const consent = gates.find((g) => g.kind === "contrast_consent");
  if (!consent || !(IMAGING_TERMINAL_GATE_STATES as readonly string[]).includes(consent.state)) {
    throw new RadiologyError(
      "contrast_mismatch",
      "contrast was given on a study whose contrast consent gate is "
      + `${consent ? consent.state : "not open"} — open and clear it before administering (T5's seam)`,
      { studyId: study.id, gate: consent?.state ?? null },
    );
  }
}

/**
 * ═══ THE STUDY'S THREE COLUMNS, RECOMPUTED FROM EVERY ROW — PURE ═══
 *
 * Pure so the rule can be tested without a database and so there is no second arithmetic anywhere.
 *
 * **The volume is the INTRAVASCULAR volume.** `drafter.ts` prints the study's volume in the
 * sentence *"with 90 ml Omnipaque intravenously"*; adding a litre of dilute oral barium to that
 * figure would make a signed report say something false. Non-intravascular routes contribute their
 * AGENT — the reader must know barium was given — and no volume, which
 * `imaging_studies_contrast_ck` permits and the drafter already has a sentence for.
 *
 * Arithmetic in whole hundredths of a millilitre, never in floats: `numeric(8,2)` comes back as a
 * string, and `0.1 + 0.2` is how a summed dose acquires a fourteenth decimal place.
 *
 * **The `Math.round` is defence no test in this suite can distinguish, and that is recorded rather
 * than dressed up.** A mutant dropping it (`hundredths += Number(v) * 100`) SURVIVED all twenty
 * tests, and the reason is `toFixed(2)` on the next line: a `numeric(8,2)` value converts with an
 * error around 1e-13, and masking it needs 0.005 of accumulated drift — roughly ten billion rows on
 * one study. So the rounding buys nothing observable TODAY. It stays because the thing that makes
 * it unobservable is a formatting call one refactor away from changing, and a surviving mutant is a
 * question about the test rather than a verdict on the line.
 */
export function summariseContrast(
  rows: readonly { agent: string; volumeMl: string; route: string }[],
): { contrastGiven: boolean; contrastAgent: string | null; contrastVolumeMl: string | null } {
  if (rows.length === 0) return { contrastGiven: false, contrastAgent: null, contrastVolumeMl: null };

  const agents: string[] = [];
  for (const r of rows) {
    const agent = r.agent.trim();
    if (agent !== "" && !agents.includes(agent)) agents.push(agent);
  }

  let hundredths = 0;
  let anyIntravascular = false;
  for (const r of rows) {
    if (!(INTRAVASCULAR_CONTRAST_ROUTES as readonly string[]).includes(r.route)) continue;
    anyIntravascular = true;
    hundredths += Math.round(Number(r.volumeMl) * 100);
  }

  return {
    contrastGiven: true,
    contrastAgent: agents.length === 0 ? null : agents.join(" + "),
    contrastVolumeMl: anyIntravascular ? (hundredths / 100).toFixed(2) : null,
  };
}

/** Every administration on a study, oldest first. The register, and T2's reaction reads it. */
export async function contrastAdministrationsFor(
  exec: Db | Tx, studyId: string,
): Promise<ContrastAdministrationRow[]> {
  return (exec as Db)
    .select()
    .from(imagingContrastAdministrations)
    .where(eq(imagingContrastAdministrations.studyId, studyId))
    .orderBy(asc(imagingContrastAdministrations.givenAt), asc(imagingContrastAdministrations.id));
}

/**
 * ═══ RECORD ONE INJECTION, AND KEEP THE STUDY'S SUMMARY TRUE IN THE SAME TRANSACTION ═══
 *
 * The `FOR UPDATE` on the study is not decoration. Two consoles recording two administrations on
 * one study concurrently each recompute the summary from the rows THEY can see, and an uncommitted
 * sibling insert is invisible — so the later writer would overwrite the earlier's volume with a sum
 * that never included it, and no constraint anywhere would notice. Locking the study row serialises
 * the read-recompute-write, which is the same reason `postMovement` locks before it sums.
 */
export async function recordContrastAdministration(
  tx: Tx,
  actor: Actor,
  input: RecordContrastInput,
): Promise<{ administrationId: string }> {
  const now = input.now ?? new Date();

  const locked = await tx
    .select()
    .from(imagingStudies)
    .where(eq(imagingStudies.id, input.studyId))
    .for("update");
  const study = locked[0];
  if (!study) throw new RadiologyError("unknown_study", `no study ${input.studyId}`, { studyId: input.studyId });

  if (!CONTRAST_RECORDABLE_STATUSES.includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} is ${study.status} — nothing has been given to this patient yet, so there `
      + "is no administration to record",
      { studyId: study.id, status: study.status },
    );
  }
  /**
   * A cancelled study that never reached the table spent no contrast. `acquisition_started_at` is
   * the column `cancelStudy` itself reads to decide whether film and time were spent, and it is
   * non-NULL for exactly the band where a patient was on the machine.
   */
  if (study.status === "cancelled" && study.acquisitionStartedAt === null) {
    throw new RadiologyError(
      "bad_transition",
      `study ${study.id} was cancelled before the patient reached the machine — no contrast was given`,
      { studyId: study.id },
    );
  }

  if (!(CONTRAST_ROUTES as readonly string[]).includes(input.route)) {
    throw new RadiologyError(
      "evidence_invalid", `"${input.route}" is not a contrast route`, { route: input.route },
    );
  }
  if (!(input.volumeMl > 0)) {
    throw new RadiologyError(
      "evidence_invalid",
      "a contrast volume is greater than zero — an administration of nothing is not an administration",
      { volumeMl: input.volumeMl },
    );
  }
  /**
   * A dose recorded in the FUTURE is a typo, and it is the shape `agedDays` refuses for every piece
   * of gate evidence in this module for the same reason: a future instant passes every "is this too
   * old" comparison there is, and T5's chasers age their rows off exactly this column.
   */
  if (input.givenAt.getTime() > now.getTime()) {
    throw new RadiologyError(
      "invalid_date",
      `the administration is timed ${input.givenAt.toISOString()}, which has not happened yet`,
      { givenAt: input.givenAt.toISOString() },
    );
  }

  const vialExpiry = input.vialExpiry ?? null;
  if (vialExpiry !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vialExpiry)) {
      throw new RadiologyError(
        "invalid_date", `"${vialExpiry}" is not a YYYY-MM-DD vial expiry`, { vialExpiry },
      );
    }
    /**
     * ═══ THE EXPIRED VIAL, REFUSED IN THE SERVICE AND AGAIN AT THE DATABASE ═══
     *
     * Nobody writes *"do not inject expired contrast"* into a phase doc, which is precisely why it
     * is enforced twice: this refusal names the field for the floor, and
     * `imaging_contrast_administrations_vial_expiry_ck` makes it true of rows written by any future
     * path that forgets. The comparison is the IST calendar day of the injection against the
     * printed expiry, because a vial's expiry is a date on a label and not an instant.
     */
    const givenDay = istDayString(input.givenAt);
    if (vialExpiry < givenDay) {
      throw new RadiologyError(
        "vial_expired",
        `the vial expired on ${vialExpiry} and was given on ${givenDay} — an expired contrast vial `
        + "does not go into a patient",
        { vialExpiry, givenAt: givenDay },
      );
    }
  }

  const agent = input.agent.trim();
  if (agent === "") {
    throw new RadiologyError("evidence_invalid", "an administration names the agent that was given");
  }
  const givenBy = input.givenBy.trim();
  if (givenBy === "") {
    throw new RadiologyError(
      "evidence_invalid",
      "an administration names the person who gave it — a dose with no injector is a record of nobody",
    );
  }

  const studyType = await requireStudyType(tx, study.studyTypeCode);
  await assertContrastPermissible(tx, study, studyType);

  const administrationId = newId();
  await tx.insert(imagingContrastAdministrations).values({
    id: administrationId,
    studyId: study.id,
    agent,
    volumeMl: input.volumeMl.toFixed(2),
    route: input.route,
    site: input.site?.trim() || null,
    vialBatchNo: input.vialBatchNo?.trim() || null,
    vialExpiry,
    givenBy,
    givenAt: input.givenAt,
    recordedBy: actor.id,
    recordedAt: now,
  });

  const summary = summariseContrast(await contrastAdministrationsFor(tx, study.id));
  await tx.update(imagingStudies).set(summary).where(eq(imagingStudies.id, study.id));

  /**
   * The payload carries the AGENT and the ROUTE and no patient identifier beyond the study — the
   * module's event rule (`events.ts`): ids and codes travel, the clinical narrative does not. The
   * agent is a product name, not a finding.
   */
  await appendEvent(
    tx,
    imagingContrastAdministered.make({
      actor,
      patientId: study.patientId,
      payload: {
        studyId: study.id, administrationId, agent, route: input.route,
        volumeMl: input.volumeMl.toFixed(2),
      },
    }),
  );

  return { administrationId };
}
