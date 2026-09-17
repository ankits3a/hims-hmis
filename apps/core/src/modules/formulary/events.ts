import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The formulary's event surface — `entity.verb_past`, module carried separately (the `opd` and
 * `membership` grammar, unchanged).
 *
 * ═══ WHY `medicine.corrected` IS A SEPARATE NAME FROM `medicine.updated` ═══
 *
 * Spec §1.1 names one deferral by its enabling event: *"a composition correction emits
 * `formulary.medicine.corrected`. Retro-scanning still-active prescriptions issued under the old
 * composition is a named deferral — the event stream makes it buildable later without data loss."*
 *
 * A single `updated` name would collapse *"the brand's schedule flag was typed wrong"* into *"this
 * medicine does not contain what we thought it contained"*, and only the second one means every
 * prescription written against it may carry a check result that is now wrong. The retro-scan is
 * not built in this phase; the ONLY thing that makes it buildable later is that the two are
 * distinguishable in the stream from the first day. `updateMedicine` decides between them by
 * comparing the composition, never by a caller-supplied flag — a caller who could choose would
 * eventually choose wrong, and always in the quiet direction.
 */
const MODULE = "formulary";
const id = z.string().min(1);

export const saltAdded = defineEvent("salt.added", MODULE, z.object({
  saltId: id, name: z.string().min(1), drugClass: z.string().nullable(), aliases: z.array(z.string()),
}));

/**
 * FORMULARY P22 — allergy classes added to a moiety by a named resolution. `added` is what this act
 * added; `allergyClasses` is the moiety's list afterwards; `source` names the resolution and the rule.
 */
export const saltAllergyClassesAdopted = defineEvent("salt.allergy_classes_adopted", MODULE, z.object({
  saltId: id, added: z.array(z.string().min(1)).min(1), allergyClasses: z.array(z.string().min(1)).min(1), source: z.string().min(1),
}));

export const saltUpdated = defineEvent("salt.updated", MODULE, z.object({
  saltId: id, changed: z.array(z.string()).min(1),
}));

export const medicineAdded = defineEvent("medicine.added", MODULE, z.object({
  medicineId: id, brandName: z.string().min(1), routeClass: z.enum(["systemic", "topical"]),
  saltIds: z.array(id).min(1), stagingId: id.nullable(),
  /** DD8 — true when the admitting pharmacist acknowledged an interacting pair inside the FDC. */
  intraFdcAcknowledged: z.boolean(),
}));

export const medicineUpdated = defineEvent("medicine.updated", MODULE, z.object({
  medicineId: id, changed: z.array(z.string()).min(1),
}));

/**
 * THE COMPOSITION CHANGED. Emitted instead of `medicine.updated`, never beside it — the retro-scan
 * this phase defers reads exactly this name, and a scan that had to filter `updated` rows by
 * inspecting their payload would be reading a fact the event was supposed to carry.
 */
export const medicineCorrected = defineEvent("medicine.corrected", MODULE, z.object({
  medicineId: id, brandName: z.string().min(1),
  fromSaltIds: z.array(id), toSaltIds: z.array(id),
}));

export const interactionAdded = defineEvent("interaction.added", MODULE, z.object({
  interactionId: id, saltAId: id, saltBId: id,
  severity: z.enum(["severe", "moderate"]), source: z.string().min(1),
  routeScope: z.literal("systemic_only").nullable(),
}));

export const interactionUpdated = defineEvent("interaction.updated", MODULE, z.object({
  interactionId: id, changed: z.array(z.string()).min(1),
}));

/** T7's admission path. Defined here because the union of names is closed by this task (errors.ts). */
export const stagingApproved = defineEvent("staging.approved", MODULE, z.object({
  stagingId: id, medicineId: id, name: z.string().min(1), sourceUrl: z.string().min(1),
}));

export const stagingRejected = defineEvent("staging.rejected", MODULE, z.object({
  stagingId: id, name: z.string().min(1), reason: z.string().min(1),
}));

/**
 * ═══ THE MAPPING LOOP (phase 2): A PHARMACIST SAYS WHAT A RELEASE SUBSTANCE IS ═══
 *
 * Both events carry what the projection DID, so a composition that moved under a product is never
 * a silent side effect of a decision somebody else made. They also carry what the decision
 * REPLACED (`fromStatus`, `fromSaltId`), because a correction is only auditable if the wrong answer
 * is still on record.
 *
 * `agreedWithProposal` is the P&T committee's instrument for the drafter (ruling R1): the share of
 * attestations that took the draft as offered, by basis. Null means no draft was on screen, which
 * is a different fact from "disagreed".
 *
 * ONE event per decision, not one per moved product. Attesting amoxicillin trihydrate moves
 * thousands of composition rows, and the importer's precedent (no per-row events for a catalogue
 * write) applies. The retro-scan that `medicine.corrected` exists for is still a named deferral. It
 * can find these products again from `sctid`, because every moved row keeps `derived_from`.
 */
const projection = z.object({
  rowsMoved: z.number().int().nonnegative(),
  medicinesMoved: z.number().int().nonnegative(),
  /** Medicines left where they were because two of their components would name one moiety (E2). */
  medicinesBlocked: z.number().int().nonnegative(),
});
const substanceStatus = z.enum(["pending", "mapped", "unmappable"]);

export const substanceMapped = defineEvent("substance.mapped", MODULE, z.object({
  substanceId: id, sctid: z.string().min(1), saltId: id,
  fromStatus: substanceStatus, fromSaltId: id.nullable(),
  /** True when the moiety was created in the same act ("create X and map"). */
  createdMoiety: z.boolean(),
  /** True when the pharmacist chose the substance's OWN release entry: "it is its own moiety". */
  ownEntry: z.boolean(),
  proposalId: id.nullable(), agreedWithProposal: z.boolean().nullable(),
  /** Present exactly when a decided substance was changed. */
  correctionReason: z.string().min(1).nullable(),
  /**
   * Formulary phase 3: the resolution this decision was adopted under, when it was adopted in bulk
   * rather than decided by the actor on the worklist. Defaults to null so earlier payloads parse.
   */
  adoptedUnder: z.string().min(1).nullable().default(null),
  projection,
}));

export const substanceRuledUnmappable = defineEvent("substance.ruled_unmappable", MODULE, z.object({
  substanceId: id, sctid: z.string().min(1),
  fromStatus: substanceStatus, fromSaltId: id.nullable(),
  reason: z.string().min(1),
  adoptedUnder: z.string().min(1).nullable().default(null),
  projection,
}));

/**
 * The catalog, in source order. A later task that adds a `defineEvent` above adds it here too; the
 * membership precedent (`events.test.ts`) is what turns that convention into an assertion when a
 * task is allowed to own that file.
 */
export const FORMULARY_EVENTS = [
  saltAdded, saltUpdated, saltAllergyClassesAdopted,
  medicineAdded, medicineUpdated, medicineCorrected,
  interactionAdded, interactionUpdated,
  stagingApproved, stagingRejected,
  substanceMapped, substanceRuledUnmappable,
] as const;
