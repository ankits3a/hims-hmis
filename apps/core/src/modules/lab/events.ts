import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * PLAN 17 T2 / DD18 — the lab's event surface. `entity.verb_past`, module carried separately (the
 * `opd`, `materials`, `membership`, `formulary` and `ot` grammar, unchanged).
 *
 * ═══ THE LAB CONSUMES NOTHING **ABOUT A PATIENT**, AND THAT IS THE DECISION ═══
 *
 * NARROWED AT 17-E T7b. Until this task the sentence here read *"this module consumes nothing"*, and
 * the manifest's `subscriptions: []` was its evidence. The manifest now carries two subscriptions, so
 * the general claim is retired and the specific one it was always arguing is stated instead —
 * a header that keeps asserting an emptiness the file beside it has filled is how a comment becomes
 * a lie (#160: written diagnoses record a MOMENT, not a state).
 *
 * The one subscription a reader will look for is `patient.merged`, which the OT and materials both
 * take. The lab does not need it: **every table in T1 keys by `order_item_id`, `specimen_id` or
 * `result_id` and none of them stores a `patient_id` that a merge would have to move** — except
 * `lab_specimens.patient_id`, which follows the envelope's own re-link (phase 0 E8) because the
 * merge path moves `orders.patient_id` and the tube belongs to the order group. A consumer here
 * would be a second answer to a question the envelope already answers, which is the shape §2.54
 * exists to stop.
 *
 * **`interface.down` / `interface.restored` are the exception because they are the opposite case**:
 * the kernel's heartbeat sweep is the ONLY answer to "is this bridge alive", the lab is the only
 * module that knows an `interfaces` row is an analyser's, and no other component projects that fact
 * onto the machine's status — so consuming them adds the missing answer instead of a second one
 * (17-E T7b, `interface-status.ts`).
 *
 * `lab.notifiable_flagged` is emitted and consumed by NOBODY in this phase — 28a subscribes to it
 * when the notifiable-disease register exists. An event with no consumer is not a defect; a
 * SUBSCRIPTION with no handler is, and `buildSubscriptionBus` makes that a boot error.
 *
 * ═══ ONE NAME DD18's LIST DOES NOT CARRY, ADDED HERE AND DISCLOSED (finding F1) ═══
 *
 * DD15 says the desk emits `attribution.unverified_flagged` for an unattributed walk-in.
 * **No such event exists**: `modules/partners/events.ts` declares seven and that is not one of
 * them, and a module may not emit a fact it never declared. It is declared HERE, in the lab's own
 * namespace, as `lab.attribution_unverified_flagged` — putting a `partners.*` name in this
 * manifest would be a reach into another module's surface, which `modules/billing/index.ts`'s own
 * header forbids in as many words. Disclosed rather than smuggled, at the one task that owns this
 * file.
 */
const MODULE = "lab";
const id = z.string().min(1);
const iso = z.string().min(1);

/* ───────────────────────────── The desk (T4) ───────────────────────────── */

/**
 * THE CONVERSION: what the doctor advised became an order and an invoice, in one transaction.
 *
 * It carries the invoice ids because that is the ONE fact no other event on this list has — 24a
 * ignores it, and a reconciliation that wants "which invoice paid for this tube" would otherwise
 * have to join three tables to a timestamp.
 */
export const labOrderDesked = defineEvent("lab.order_desked", MODULE, z.object({
  orderId: id, orderNo: id, orderGroupId: id, patientId: id, encounterNo: id,
  itemIds: z.array(id).min(1), invoiceId: id.nullable(), invoiceNo: z.string().nullable(),
  chargeReason: z.string().min(1),
}));

/** DD15 / 02 I3 — a walk-in whose referrer nobody could confirm. The sentinel took the order. */
export const labAttributionUnverifiedFlagged = defineEvent("lab.attribution_unverified_flagged", MODULE, z.object({
  orderId: id, patientId: id, referrerName: z.string().nullable(), reason: z.string().min(1),
}));

/* ──────────────────────── Collection and accession (T5) ──────────────────────── */

export const labLabelPrinted = defineEvent("lab.label_printed", MODULE, z.object({
  specimenId: id, specimenNo: id, patientId: id, orderGroupId: id,
  itemIds: z.array(id).min(1), labelSource: z.enum(["printer", "downtime_kit"]),
}));

/**
 * DD10 / 02 A1 — THE SCAN SAID SOMEBODY ELSE. No tube was labelled; the event is the record that
 * the check fired, and it is what a quality review counts. Two Ram Kumars is the case every lab
 * has had, and a near-miss nobody logged is a near-miss nobody learns from.
 */
export const labTubeMismatchFlagged = defineEvent("lab.tube_mismatch_flagged", MODULE, z.object({
  orderGroupId: id, expectedUhid: id, scannedUhid: id, at: iso,
}));

/**
 * PLAN 17c T3 / D8 — `orderGroupId` on the six events 17b F43 found unroutable: without it
 * `labTopicsFor` returned `[]` and a bench could not see a tube arrive. The group is the clinical
 * act (phase 0 DD2) and every emitter has it in hand.
 */
export const labSpecimenCollected = defineEvent("lab.specimen_collected", MODULE, z.object({
  specimenId: id, specimenNo: id, patientId: id, orderGroupId: id, collectedBy: id, at: iso,
  wristbandScanned: z.boolean(), collectionSite: z.string().min(1),
}));

/** **THE TAT CLOCK STARTS HERE** (T5 A7) — not at placement and not at collection. */
export const labSpecimenReceived = defineEvent("lab.specimen_received", MODULE, z.object({
  specimenId: id, specimenNo: id, orderGroupId: id, itemIds: z.array(id), receivedBy: id, at: iso,
}));

export const labSpecimenRejected = defineEvent("lab.specimen_rejected", MODULE, z.object({
  specimenId: id, specimenNo: id, orderGroupId: id, reason: z.string().min(1), attributableTo: z.string().min(1),
  rejectedBy: id, at: iso,
}));

/**
 * 17d T2 — **THE RE-LABEL**, design board EdgeCases #12. A tube identified by a typed number rather
 * than by its barcode is a tube whose label could not be read, and it leaves the bench wearing a new
 * one. NABL asks how many of those there were and whose hands were on them, so it is its own fact
 * with both names on it — not a boolean buried in the accession's payload, which is not a number
 * anybody can count.
 *
 * No specimen NUMBER on the payload: this rides the same departmental topic as its neighbours and
 * the ids are enough to find the row (17c F4's rule, kept).
 */
export const labSpecimenRelabelled = defineEvent("lab.specimen_relabelled", MODULE, z.object({
  specimenId: id, orderGroupId: id, relabelledBy: id, witnessedBy: id,
  reason: z.string().min(1), at: iso,
}));

export const labRecollectionRequested = defineEvent("lab.recollection_requested", MODULE, z.object({
  priorSpecimenId: id, specimenId: id, specimenNo: id, orderGroupId: id, itemIds: z.array(id).min(1), reason: z.string().min(1),
}));

/* ─────────────────────────────── Results (T6) ─────────────────────────────── */

/**
 * 17c close review pass 1, F4 — NO FLAG on this payload. It rides `lab:bench` under the
 * `lab.worklist.read` space, which reception and the phlebotomist hold; `HH` beside an analyte id
 * is a result. The flag lives on the row; a reader with `lab.results.read` asks the row.
 */
export const labResultEntered = defineEvent("lab.result_entered", MODULE, z.object({
  resultId: id, orderItemId: id, orderGroupId: id, analyteId: id, enteredBy: id,
  entryMode: z.string().min(1), absurdOverridden: z.boolean(),
}));

/**
 * 17d T1 / D3 — **THE SWAP, SUSPECTED**, appended on its OWN transaction before the entry is
 * refused (`printLabels`'s F20 shape). A near-miss nobody logged is a near-miss nobody learns from,
 * and NABL asks for the count; an audit row written on the transaction that is about to roll back
 * is an audit row that never existed.
 *
 * **Structural ids only, and 17c F4 is why.** This rides `lab:bench`, a topic held by reception and
 * the phlebotomist as well as the bench. `breach` says WHICH rule fired and nothing more — the
 * patient's sex, the patient's age and the value that triggered it are all readable from the rows
 * by somebody holding `lab.results.read`, and none of them belongs on a departmental feed.
 *
 * `siblingSpecimenIds` is the point of the event rather than a detail of it: the tube in the hand is
 * only half of a swap, and the other half is on the same order group with a collection time in the
 * same minute.
 */
export const labTubeSwapSuspected = defineEvent("lab.tube_swap_suspected", MODULE, z.object({
  orderItemId: id, orderGroupId: id, analyteId: id, specimenId: id,
  siblingSpecimenIds: z.array(id),
  breach: z.enum(["sex", "age"]),
  /**
   * `raisedBy` and never `flaggedBy`: `realtime.test.ts` censuses this topic's payload keys for
   * anything matching `/value|flag|…/`, and a field whose name borrows the word a RESULT FLAG owns
   * would have had to weaken that census to ship. The census is right and the name was wrong.
   */
  raisedBy: id,
  overridden: z.boolean(),
}));

export const labResultVerified = defineEvent("lab.result_verified", MODULE, z.object({
  resultId: id, orderItemId: id, orderGroupId: id, analyteId: id, verifiedBy: id,
}));

/**
 * 17-E T7 / D17 — WHICH OF AN ANALYSER'S TWO RUNS THE REPORT WILL CARRY, AND WHY.
 *
 * `supersededResultIds` names the rows the choice leaves behind rather than a single "other": a
 * third transmission is a set of three, and an event that could only describe a pair would go
 * silent on the case a busy bench actually produces. The reason travels in the event as well as on
 * the row — an auditor reading the stream should not have to join back to learn WHY.
 */
export const labResultChosen = defineEvent("lab.result_chosen", MODULE, z.object({
  resultId: id, orderItemId: id, analyteId: id, chosenBy: id, reason: z.string().min(1),
  supersededResultIds: z.array(id), previousChoiceId: id.nullable(),
}));

/**
 * DD12 — the 15-minute clock. Emitted at ENTRY, before any verification: the clinical need is the
 * CALL, and the signature follows by 09:00 (R-014's default, adopted).
 */
/**
 * DD11 / §7 — THE MORNING AFTER. Night mode borrowed the second pair of hands; this is that pair
 * arriving, and it is the compensating control that makes the relaxation a relaxation rather than an
 * absent control.
 *
 * **Both people are named, because a review is a relationship between two of them** — "who signed
 * this off" is only half the question NABL asks, and `releasedBy` is the half a boolean on the row
 * could never have answered once it was cleared. The note is nullable: a concurrence IS the record,
 * and demanding an essay on every one is how a queue gets worked by typing a full stop.
 */
export const labNightReleaseReviewed = defineEvent("lab.night_release_reviewed", MODULE, z.object({
  resultId: id, orderItemId: id, analyteId: id,
  reviewedBy: id, releasedBy: id, note: z.string().nullable(), reviewedAt: z.string(),
}));

export const labResultCriticalFlagged = defineEvent("lab.result_critical_flagged", MODULE, z.object({
  resultId: id, callId: id, orderItemId: id, analyteId: id, patientId: id,
  value: z.string().min(1), band: z.enum(["low", "high"]),
}));

/** Closed by a READ-BACK, never by an attempt (02 §3.6). `attempts` is how many it took. */
export const labCriticalAcknowledged = defineEvent("lab.critical_acknowledged", MODULE, z.object({
  callId: id, resultId: id, closedBy: id, attempts: z.number().int().nonnegative(), at: iso,
}));

export const labResultDeltaFlagged = defineEvent("lab.result_delta_flagged", MODULE, z.object({
  resultId: id, priorResultId: id, analyteId: id, patientId: id,
  priorValue: z.string().min(1), value: z.string().min(1),
}));

/** DD8 — placed SYNCHRONOUSLY inside the verifying transaction, as `system` under `protocol_ref`. */
export const labReflexAdded = defineEvent("lab.reflex_added", MODULE, z.object({
  ruleId: id, ruleVersion: z.number().int().positive(), triggerResultId: id,
  parentItemId: id, orderId: id, orderNo: id, addedServiceId: id,
}));

/**
 * DD11 — the SoD refusal, EVENTED. A refusal nobody can count is a control nobody can audit, and
 * NABL asks how often the single-operator path was used.
 */
export const labSodViolationBlocked = defineEvent("lab.sod_violation_blocked", MODULE, z.object({
  resultId: id, orderItemId: id, actorId: id, enteredById: id,
}));

/* ─────────────────────────────── Reports (T7) ─────────────────────────────── */

export const labReportPublished = defineEvent("lab.report_published", MODULE, z.object({
  reportId: id, orderId: id, patientId: id, version: z.number().int().positive(),
  partial: z.boolean(), channels: z.array(z.string()), signedBy: id,
}));

/** DD6 — the interlock refused a delivery. `unpaidLineIds` is what the counter shows the patient. */
export const labReportPrintBlocked = defineEvent("lab.report_print_blocked", MODULE, z.object({
  reportId: id, orderId: id, reason: z.string().min(1), unpaidLineIds: z.array(id),
}));

/** DD6 — `billing_manager` released it. **The dues row is untouched: it was already the receivable.** */
export const labReportReleasedUnpaid = defineEvent("lab.report_released_unpaid", MODULE, z.object({
  reportId: id, orderId: id, approvalId: id, releasedBy: id, outstandingPaise: z.number().int(),
}));

export const labReportPrinted = defineEvent("lab.report_printed", MODULE, z.object({
  reportId: id, orderId: id, deliveryId: id, channel: z.string().min(1),
  collectorIdentity: z.string().nullable(), printedBy: id,
}));

/** R-018 — a reason CATEGORY, never free text: the re-notification says "AMENDED", not why. */
export const labReportAmended = defineEvent("lab.report_amended", MODULE, z.object({
  reportId: id, priorVersionId: id, orderId: id, version: z.number().int().positive(),
  reasonCode: z.string().min(1), amendedBy: id,
}));

/* ──────────────────────── Sweeps and registers (T5, T9) ──────────────────────── */

export const labSlaBreached = defineEvent("lab.sla_breached", MODULE, z.object({
  orderItemId: id, orderId: id, stage: z.string().min(1), dueAt: iso, breachedAt: iso,
  priority: z.string().min(1),
}));

/** 28a subscribes when the register exists. The FLAG is this phase's; the register is not. */
export const labNotifiableFlagged = defineEvent("lab.notifiable_flagged", MODULE, z.object({
  resultId: id, orderItemId: id, patientId: id, serviceId: id, analyteId: id,
}));

/**
 * THE CATALOGUE OF THIS MODULE'S EVENTS, in one place, so `events.test.ts` can assert the grammar
 * and the module tag over ALL of them rather than over the ones a reader remembered to list.
 */
export const LAB_EVENTS = [
  labOrderDesked, labAttributionUnverifiedFlagged,
  labLabelPrinted, labTubeMismatchFlagged, labSpecimenCollected, labSpecimenReceived,
  labSpecimenRejected, labSpecimenRelabelled, labRecollectionRequested,
  labResultEntered, labResultVerified, labResultChosen, labNightReleaseReviewed,
  labTubeSwapSuspected, labResultCriticalFlagged, labCriticalAcknowledged,
  labResultDeltaFlagged, labReflexAdded, labSodViolationBlocked,
  labReportPublished, labReportPrintBlocked, labReportReleasedUnpaid, labReportPrinted,
  labReportAmended,
  labSlaBreached, labNotifiableFlagged,
] as const;
