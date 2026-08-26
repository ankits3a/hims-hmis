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
 * The catalog, in source order. A later task that adds a `defineEvent` above adds it here too; the
 * membership precedent (`events.test.ts`) is what turns that convention into an assertion when a
 * task is allowed to own that file.
 */
export const FORMULARY_EVENTS = [
  saltAdded, saltUpdated,
  medicineAdded, medicineUpdated, medicineCorrected,
  interactionAdded, interactionUpdated,
  stagingApproved, stagingRejected,
] as const;
