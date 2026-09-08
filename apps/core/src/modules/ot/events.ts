import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import { consignmentDeployed, materialConsumed } from "../materials";

/**
 * PLAN 15 T2 / DD13 — the mini-OT's event surface. `entity.verb_past`, module carried separately
 * (the `opd`, `materials`, `membership` and `formulary` grammar, unchanged).
 *
 * ═══ `consignment.deployed` IS IMPORTED, NEVER REDEFINED (DD13, and it is the point) ═══
 *
 * Plan 14's `events.ts` says of that definition: *"Plan 15's mini-OT imports `consignmentDeployed`
 * and appends it inside its scan-on-use transaction; it never redefines the name and it never
 * re-declares the payload."* This file is where that sentence is either kept or broken. It is kept
 * by RE-EXPORT — the same object, not a copy — and `events.test.ts` asserts object identity, so a
 * future edit that "helpfully" inlines the schema fails a test rather than a hospital's stock count.
 *
 * `material.consumed` is imported for the same reason on the other side: T5's consumer matches on
 * `materialConsumed.name` rather than on a string literal that could drift by one character.
 *
 * ═══ FOUR NEW NAMES, THIRTEEN FROM §11.16-A / DD13, AND WHAT EACH ONE IS FOR ═══
 *
 * The four NEW (DD13): `daycare.absconded`, `implant.explanted`, `procedure.converted`,
 * `material.ceiling_diverged`. The rest were named by the spec's §11.16-A catalogue or by a DD.
 *
 * ═══ THREE NAMES DD13's PROSE LIST DOES NOT CARRY, ADDED HERE AND DISCLOSED (finding T2-a) ═══
 *
 * DD13 enumerates the emitted names as prose; three refusals and moves the plan mandates ELSEWHERE
 * have no name in that list, and a module cannot emit a fact it never declared:
 *
 *   · **`list.published`** — T4's Produces names it in as many words (*"`publishList` (`ot_lists`
 *     version + `list.published`)"*).
 *   · **`payer.class_changed`** — DD12's last sentence names it in as many words.
 *   · **`anaesthetist.substituted`** — DD4 names it in as many words (*"or hold `anaesthetist` and
 *     emit `anaesthetist.substituted`"*).
 *
 * They are added at the one task allowed to own this file, and disclosed rather than smuggled —
 * `errors.ts`'s discipline applied to the event catalogue. A later task inventing a name here would
 * be the drift this file exists to prevent.
 *
 * ═══ `escort.verified` FIRES TWICE PER ENCOUNTER, AND THAT IS THE DESIGN (DD10 / E-4) ═══
 *
 * Once at check-in and once at discharge. `at` distinguishes them. A day-care patient discharges to
 * an adult STRUCTURALLY, so "verified on arrival" is not evidence about who is taking her home six
 * hours later — the second verification is a separate act and therefore a separate event.
 *
 * ═══ NO PAYLOAD CARRIES A NAME, A PHONE OR A DIAGNOSIS ═══
 *
 * The `vendor.updated` bank-detail lesson (Plan 14 DD4/DD12), applied to a clinical stream: event
 * payloads are read by consumers, replayed into projections and dumped into logs. Ids and codes
 * travel; the escort's phone number and the patient's name do not. `displayName` (DD16) is the only
 * place a name is resolved, and it resolves for a SCREEN, never for a stream.
 */
const MODULE = "ot";
const id = z.string().min(1);
const paise = z.number().int();

/** R-3.12 — every cancellation carries who it is attributable to, from day one, or 15d's charge
 *  matrix has no data to be designed from. */
const attribution = z.enum(["patient", "hospital", "surgeon", "payer", "clinical"]);

// ═══════════════════════════════ THE ENCOUNTER'S OWN ARC ═══════════════════════════════

export const daycareBooked = defineEvent("daycare.booked", MODULE, z.object({
  encounterId: id, encounterNo: z.string().min(1), caseId: id, patientId: id,
  procedureClass: z.string().min(1), listDate: z.string().min(1),
  payerClass: z.string().min(1), quotePaise: paise, requiredDepositPaise: paise,
}));

export const daycareCheckedIn = defineEvent("daycare.checked_in", MODULE, z.object({
  encounterId: id, patientId: id, at: z.string().min(1),
}));

/** DD10 — `at` is what makes the two verifications one name and two facts. */
export const escortVerified = defineEvent("escort.verified", MODULE, z.object({
  encounterId: id, at: z.enum(["checkin", "discharge"]),
  relation: z.string().min(1), verifiedBy: id,
}));

export const daycareDischargeReady = defineEvent("daycare.discharge_ready", MODULE, z.object({
  encounterId: id, caseId: id, scale: z.string().min(1), total: z.number().int(),
  scoreCount: z.number().int(), lateCutoffPassed: z.boolean(),
}));

export const daycareDischarged = defineEvent("daycare.discharged", MODULE, z.object({
  encounterId: id, patientId: id, bayResourceId: id, at: z.string().min(1),
}));

/**
 * R-3.6 — **`at` IS THE BILLING BOUNDARY**, not a timestamp for the record. The composer bills
 * nothing on this encounter after it, and the incumbent IPD bills the admission from it. `destination`
 * is a field rather than a constant so that the day the owner names a different destination, the
 * event changes and nothing else does (§4A-3).
 */
export const daycareConvertedToAdmission = defineEvent("daycare.converted_to_admission", MODULE, z.object({
  encounterId: id, at: z.string().min(1), destination: z.string().min(1),
  handoffDocumentId: id.nullable(),
}));

/** NEW (DD13) — N9. The bill is issued as-is and a recall call is raised; it is not a discharge. */
export const daycareAbsconded = defineEvent("daycare.absconded", MODULE, z.object({
  encounterId: id, patientId: id, noticedAt: z.string().min(1),
  escortVerifiedAtDischarge: z.boolean(),
}));

export const caseCancelled = defineEvent("case.cancelled", MODULE, z.object({
  caseId: id, encounterId: id, reason: z.string().min(1), attribution,
  atState: z.string().min(1),
}));

/** DD12's last row — the deposit recomputes, and the audit shows BOTH classes. */
export const payerClassChanged = defineEvent("payer.class_changed", MODULE, z.object({
  encounterId: id, from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1),
  requiredDepositPaise: paise,
}));

// ═══════════════════════════════ THE LIST AND THE THEATRE ═══════════════════════════════

export const listPublished = defineEvent("list.published", MODULE, z.object({
  listId: id, listDate: z.string().min(1), theatreResourceId: id,
  version: z.number().int().positive(), caseCount: z.number().int(),
}));

/**
 * The order changed after the sheet was printed. **The architecture spec's OT catalogue named
 * `ot_list.resequenced` and this module declared nothing**, so a re-sequence moved every case on the
 * list and left no trace: the printed sheet in a nurse's hand could disagree with the screen, and
 * the log did not say the order had ever changed. NPO, the wards and the porters re-time off this.
 *
 * `caseIdsInOrder` is the WHOLE list, because that is what `resequence` refuses to accept a subset
 * of — a consumer re-timing a ward round needs the new order, not a diff it has to reconstruct.
 *
 * **There is no `version` here on purpose.** `resequence`'s docstring makes the call: the order
 * within a published list is operational, and versioning every swap would make the printed sheet's
 * version number meaningless. The event is the trace; the version is the sheet's identity.
 */
export const listResequenced = defineEvent("list.resequenced", MODULE, z.object({
  listDate: z.string().min(1), theatreResourceId: id,
  caseIdsInOrder: z.array(id).min(1),
  reason: z.string().min(1).nullable(),
}));

/** F1 — a scheduler job at slot+15 and slot+30. The no-show cancel at +60 is a `case.cancelled`. */
export const surgeonLateFlagged = defineEvent("surgeon.late_flagged", MODULE, z.object({
  caseId: id, surgeonId: id, minutesLate: z.number().int().positive(),
}));

/** DD4 — the assigned anaesthetist did not sign in and another role-holder did. Not a refusal: a
 *  RECORD, because refusing would stop a list that a substitute is standing ready to run. */
export const anaesthetistSubstituted = defineEvent("anaesthetist.substituted", MODULE, z.object({
  caseId: id, plannedAnaesthetistId: id, actualAnaesthetistId: id,
}));

/** A8 — the time-out was halted. The case STAYS `signed_in`; this is a near-miss, not an abort. */
export const timeoutHalted = defineEvent("timeout.halted", MODULE, z.object({
  caseId: id, reason: z.string().min(1), participantCount: z.number().int(),
}));

/**
 * DD7 — the hard stop. `expected`/`counted` travel so the digest can say WHAT is missing without
 * reading the table, and `round` so a closing mismatch is distinguishable from a final one.
 */
export const countMismatch = defineEvent("count.mismatch", MODULE, z.object({
  caseId: id, round: z.string().min(1), itemType: z.string().min(1),
  expected: z.number().int(), counted: z.number().int(),
}));

/** DD5 — incident-class, digest line. Both actor ids travel: an override with one name is not one. */
export const gateOverridden = defineEvent("gate.overridden", MODULE, z.object({
  caseId: id, gateId: id, kind: z.string().min(1),
  surgeonId: id, anaesthetistId: id, reason: z.string().min(1),
}));

/** DD7 — the OT-local incident record, until the quality module (28a) subscribes to it. */
export const incidentReported = defineEvent("incident.reported", MODULE, z.object({
  incidentId: id, encounterId: id, caseId: id.nullable(), kind: z.string().min(1),
}));

/**
 * R-3.22 — minimal but present. A day-care unit can still have a death, and an event cannot be
 * "deferred" if it happens. The six-task cascade (police, mortuary, disclosure) is 28a's.
 */
export const deathOnTableRecorded = defineEvent("death.on_table_recorded", MODULE, z.object({
  caseId: id, encounterId: id, patientId: id, at: z.string().min(1),
  theatreResourceId: id, mlcApplicable: z.boolean(),
}));

/** DD8 — `backfillCase` flags every phase it wrote from paper. `occurredAt` < `recordedAt`, always. */
export const lateEntryFlagged = defineEvent("late_entry.flagged", MODULE, z.object({
  caseId: id, phase: z.string().min(1), occurredAt: z.string().min(1),
  recordedAt: z.string().min(1), reason: z.string().min(1),
}));

// ═══════════════════════════════ IMPLANTS AND THE PROCEDURE ═══════════════════════════════

/**
 * NEW (DD13) — F5's honest half. **An explant reverses NOTHING in materials**: Plan 14 has no
 * consignment return writer, `consignment_lots.qty_returned` is written by nobody, and the ledger's
 * `return` reason has no author. So the vendor liability stands until 14c's reconciliation nets it
 * against THIS event, and the composer's only job is to keep the row off the patient's bill (D8).
 * The event is therefore the whole of the trail, which is why it carries the lot.
 */
export const implantExplanted = defineEvent("implant.explanted", MODULE, z.object({
  caseId: id, encounterId: id, implantId: id, lotId: id.nullable(),
  serial: z.string().min(1).nullable(), reason: z.string().min(1),
}));

/** NEW (DD13) — N11/G2. The consent's conversion item is what makes it lawful; `consentCovered`
 *  records whether it was there, because a conversion without it is the finding, not the block. */
export const procedureConverted = defineEvent("procedure.converted", MODULE, z.object({
  caseId: id, fromProcedureCode: z.string().min(1), toProcedureCode: z.string().min(1),
  reason: z.string().min(1), consentCovered: z.boolean(),
}));

/**
 * NEW (DD11 / R-3.2's F5 ruling) — **the gazette moved under a deployment.**
 *
 * `consumptionsFor` RE-DERIVES the ceiling at query time; `material.consumed` FROZE it at
 * consumption time. For every ordinary case the two agree. They disagree when a CORRECTION row is
 * filed later with the same `effective_from` and a higher `seq`, which `effectiveRegulation` orders
 * ahead of the original. The invoice is the tax document and must match the gazette as corrected on
 * the day of issue, so **the composer uses the DERIVED value and emits this** — the frozen number
 * is provenance, and this event is where the difference is auditable.
 */
export const materialCeilingDiverged = defineEvent("material.ceiling_diverged", MODULE, z.object({
  encounterId: id, ledgerEntryId: id, itemId: id,
  frozenCeilingPaisePerBase: paise.nullable(),
  derivedCeilingPaisePerBase: paise.nullable(),
  invoicedUnitPaise: paise,
}));

/**
 * The catalog, in source order. A later task that adds a `defineEvent` above adds it here too;
 * `events.test.ts` asserts the two agree, so a name declared and left out of the catalog — which is
 * how a module ends up with an event nothing can subscribe to — fails a suite.
 */
export const OT_EVENTS = [
  daycareBooked, daycareCheckedIn, escortVerified, daycareDischargeReady, daycareDischarged,
  daycareConvertedToAdmission, daycareAbsconded, caseCancelled, payerClassChanged,
  listPublished, listResequenced, surgeonLateFlagged, anaesthetistSubstituted,
  timeoutHalted, countMismatch, gateOverridden, incidentReported, deathOnTableRecorded,
  lateEntryFlagged,
  implantExplanted, procedureConverted, materialCeilingDiverged,
] as const;

/**
 * IMPORTED, NOT DEFINED. Re-exported so the rest of this module has ONE import path for every event
 * it touches, while the OBJECT stays materials'. `events.test.ts` asserts identity.
 */
export { consignmentDeployed, materialConsumed };
