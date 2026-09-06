import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 18a T2 / §4.2 — the radiology module's event surface. `entity.verb_past`, module carried
 * separately (the `opd`, `ot`, `materials`, `membership` and `formulary` grammar, unchanged).
 *
 * ═══ NO PAYLOAD CARRIES A NAME, A PHONE, A DIAGNOSIS OR A FINDING ═══
 *
 * The rule Plan 14 bought with `vendor.updated`'s bank details and Plan 15 restated for a clinical
 * stream, and this module is the one with the sharpest reason to keep it: event payloads are read
 * by consumers, replayed into projections and dumped into logs. **`imaging.report_published` carries
 * a `criticalCategory` and NOT an impression**; `imaging.critical_flagged` carries a category and a
 * recipient id, never the read-back text. Ids and codes travel. The finding does not.
 *
 * ═══ `pcpndt.form_f_recorded` IS DECLARED IN THE PCPNDT MODULE, NOT HERE ═══
 *
 * DD1: `pcpndt` is its own manifest so that 15b and 62 can install the statutory register without
 * installing radiology. Its event belongs with it, and this module imports the name rather than
 * declaring a second one — the `consignmentDeployed` discipline Plan 15's own events file describes.
 *
 * ═══ `order.placed` IS THE KERNEL'S AND IS CONSUMED, NEVER REDECLARED ═══
 *
 * `consumers.ts` matches on the kernel definition's `.name`, not on a string literal that could
 * drift by one character.
 */
const MODULE = "radiology";
const id = z.string().min(1);

/**
 * DD5 — the slot was taken. **18b builds its modality worklist (MWL) file from this**, and 22c-F
 * puts the appointment card in the patient's app, so the payload carries everything either needs
 * without a read-back: which machine, when, and what kind of study.
 */
export const imagingStudyScheduled = defineEvent("imaging.study_scheduled", MODULE, z.object({
  studyId: id, orderItemId: id, patientId: id,
  deviceResourceId: id, scheduledAt: z.string().min(1), studyTypeCode: z.string().min(1),
}));

/**
 * DD7 — every gate outcome, including the ones nobody wants to look at. `evidenceRef` is a POINTER
 * (a document id, a result id) and never the evidence itself: a pregnancy declaration and a
 * creatinine value are both clinical facts that must not ride an event bus.
 *
 * There is no `outcome: 'refused'`. A gate that cannot be satisfied stays `open` — the state, not
 * an event — which is what makes B7's *"the creatinine arrives two minutes later"* a re-evaluation
 * rather than a second workflow.
 */
export const imagingGateEvaluated = defineEvent("imaging.gate_evaluated", MODULE, z.object({
  studyId: id, kind: z.string().min(1),
  outcome: z.enum(["satisfied", "waived", "overridden"]),
  evidenceRef: z.string().nullable(), actorId: id,
}));

/**
 * DD8 — **THE FACT THREE PLANS ARE WAITING FOR, AND EACH READS A DIFFERENT FIELD.**
 *
 *   · the COUNTER reads `serviceId`, `contrastGiven` and `repeatOfStudyId` — D2's swap and D6's
 *     repeat are money facts, and the bill decision this module raises beside them is the queue;
 *   · **18b** reads `accessionNo` and `imageSource` for its reconciliation queue;
 *   · **18c** reads `deviceResourceId` and goes to the study for the dose numbers.
 *
 * It is emitted EXACTLY ONCE per study — T7 A6's status compare-and-set is what guarantees that,
 * and the mutant that drops it makes 18c count one patient's dose twice.
 */
export const imagingStudyAcquired = defineEvent("imaging.study_acquired", MODULE, z.object({
  studyId: id, accessionNo: z.string().min(1), orderItemId: id, serviceId: id,
  contrastGiven: z.boolean(), repeatOfStudyId: z.string().nullable(),
  imageSource: z.string().min(1), deviceResourceId: id,
  /** 18b T2 — the DICOM identity 18b-ii's reconciliation joins on; null when no DICOM study exists. */
  studyInstanceUid: z.string().nullable(),
}));

/**
 * DD15 — the report is visible in the app. `criticalCategory` rides so 22c-F can style the row and
 * 10's gateway can decide urgency **without reading the report**, which is the whole reason it is a
 * category rather than the impression text.
 */
export const imagingReportPublished = defineEvent("imaging.report_published", MODULE, z.object({
  studyId: id, reportId: id, version: z.number().int().positive(),
  patientId: id, encounterNo: z.string().min(1),
  criticalCategory: z.string().nullable(),
}));

/** DD15 — a `red` finding. 18a-iii's Critical Chaser is the consumer that will not let it rest. */
export const imagingCriticalFlagged = defineEvent("imaging.critical_flagged", MODULE, z.object({
  reportId: id, studyId: id, category: z.string().min(1),
  communicatedTo: z.string().nullable(),
}));

export const imagingCriticalAcknowledged = defineEvent("imaging.critical_acknowledged", MODULE, z.object({
  reportId: id, studyId: id, category: z.string().min(1), acknowledgedBy: id,
}));

/** DD12b — the counter's queue gained a row. `detail` is a shape, never a price. */
export const imagingBillDecisionRaised = defineEvent("imaging.bill_decision_raised", MODULE, z.object({
  studyId: id, kind: z.string().min(1), detail: z.record(z.string(), z.unknown()).nullable(),
}));

/**
 * 18b T3 / D6 — somebody opened the images. `viewerId` and `via` travel; the URL does not (it
 * carries the accession number). 18a §6.2 reserved this name as 18b's; the row is
 * `imaging_image_views`, written before the event.
 */
export const imagingImageViewed = defineEvent("imaging.image_viewed", MODULE, z.object({
  studyId: id, viewerId: id, via: z.string().min(1),
}));

/**
 * 18a-iii T1 — a contrast agent went into a patient. The AGENT and the ROUTE are a product name and
 * a closed token; neither is a finding, and this file's rule lets both travel. The volume travels
 * as the string the `numeric` column holds, so a consumer never has to guess a scale.
 *
 * Nothing subscribes to it yet, and that is the same posture 18c's D9 took: the hospital-wide ADR
 * and incident registers are the quality pack's (28a) and it is unbuilt. This is the seam it will
 * subscribe to, not a substitute for it.
 */
export const imagingContrastAdministered = defineEvent("imaging.contrast_administered", MODULE, z.object({
  studyId: id, administrationId: id, agent: z.string().min(1), route: z.string().min(1),
  volumeMl: z.string().min(1),
}));

/**
 * 18a-iii T2 / D1 — a patient reacted to a contrast agent. **Nothing consumes this**, and that is
 * the posture 18c's D9 took for the same reason: the hospital-wide incident and ADR registers are
 * the quality pack's (28a) and it is unbuilt. `incident.reported` exists and is `ot`-LOCAL by its
 * own docstring; radiology emitting into it would make the hospital's incident register a thing
 * `ot` owns by accident of shipping first.
 *
 * `allergyId` travels because the allergy write is the point (D2) and a consumer must be able to
 * follow it. The MANIFESTATION does not travel: it is the clinical narrative, and this module's
 * rule is that ids and codes go into payloads and findings do not.
 */
export const imagingContrastReaction = defineEvent("imaging.contrast_reaction", MODULE, z.object({
  studyId: id, administrationId: id, reactionId: id, allergyId: id,
  severity: z.enum(["mild", "moderate", "severe"]), onset: z.enum(["immediate", "delayed"]),
}));

/**
 * 18a-iii T4 / D5 — a film from another centre entered the register. 18b's D8 deferred `outside` to
 * this phase; the event is how the rest of the hospital learns a study it can see is not one we
 * performed. The centre's NAME travels because it is provenance rather than a finding — a reader
 * needs to know whose machine irradiated this patient, and it is on the film's own label.
 */
export const imagingOutsideStudyRegistered = defineEvent("imaging.outside_study_registered", MODULE, z.object({
  studyId: id, outsideStudyId: id, centreName: z.string().min(1), studyDate: z.string().min(1),
  modality: z.string().min(1), arrival: z.string().min(1),
}));

/**
 * ═══ 18a-iii T5 / D7 — THE TWO CHASERS' VOICES ═══
 *
 * Each is emitted once per row, by a worker sweep, when a promise the department made to itself has
 * gone past its window. **Neither changes anything**: the alerts consumer turns them into a row in
 * front of a human, and the human decides.
 *
 * The payloads carry ids, a tier and a NUMBER OF MINUTES OR HOURS. They carry no finding, no
 * impression and no name — this module's rule, and here it is doubly load-bearing: the alerts
 * consumer builds its title and body exclusively from structural payload fields **because an alert
 * is fanned straight to a browser**, and its own header says so in as many words.
 */
export const imagingCriticalOverdue = defineEvent("imaging.critical_overdue", MODULE, z.object({
  criticalId: id, reportId: id, studyId: id,
  category: z.enum(["red", "orange", "yellow"]), overdueMin: z.number().int().positive(),
}));

export const imagingReportUnread = defineEvent("imaging.report_unread", MODULE, z.object({
  reportId: id, studyId: id, unreadHours: z.number().int().nonnegative(),
}));

/** Every event this module declares, for the catalogue parity test. */
export const RADIOLOGY_EVENTS = [
  imagingStudyScheduled,
  imagingGateEvaluated,
  imagingStudyAcquired,
  imagingReportPublished,
  imagingCriticalFlagged,
  imagingCriticalAcknowledged,
  imagingBillDecisionRaised,
  imagingImageViewed,
  imagingContrastAdministered,
  imagingContrastReaction,
  imagingOutsideStudyRegistered,
  imagingCriticalOverdue,
  imagingReportUnread,
] as const;
