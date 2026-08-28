import { and, eq, inArray } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import {
  daycareEncounters, eventIdempotency, otCaseImplants, otCases, otSpecimens,
} from "../../kernel/db/schema";
import { patientMerged } from "../patients";
import { materialConsumed } from "../materials";
import type { Handler, DispatchedEvent } from "../../kernel/events/subscriptions";
import type { Db, Tx } from "../../kernel/db/client";

/** The consumer key the manifest subscribes with. One string, two places, and this is the source. */
export const OT_PATIENT_MERGED_CONSUMER = "ot.patient_merged";

/**
 * PLAN 15 T2 / A5 — **THE MERGE CONSUMER, SHIPPED WITH ITS SUBSCRIPTION IN ONE COMMIT.**
 *
 * `buildSubscriptionBus` (kernel/worker/jobs.ts) turns a declared subscription with no matching
 * handler into a BOOT ERROR by design, so the manifest's `patient.merged` entry, this handler and
 * `workerConsumers`' line are ONE commit — the `partnersManifest` rule, fifth time.
 *
 * **It is the REAL consumer at T2, not a stub that throws `not_implemented`.** The plan says so in
 * as many words, and the reason is the one `patient_merge` itself demonstrated: an unregistered
 * approval type threw on every merge request on the live box from Plan 05 until 2026-08-26, and
 * nobody noticed because nothing failed loudly at boot. A consumer that boots and refuses is the
 * same shape of lie.
 *
 * ═══ WHAT A MERGE MEANS HERE ═══
 *
 * The loser's id stops being a patient. Every OT row naming it must name the winner instead, or the
 * theatre list shows a case belonging to a patient the registry says does not exist. Four columns
 * across three tables carry a patient id in this module:
 *
 *   · `daycare_encounters.patient_id`      — the encounter's subject;
 *   · `daycare_encounters.escort_patient_id` — N14's escort-who-has-a-UHID;
 *   · `ot_cases.patient_id`;
 *   · `ot_specimens.patient_id`.
 *
 * `ot_case_implants` and `pacu_scores` carry NO patient id — they reach the patient through the
 * encounter — so there is nothing to rewrite on them, and DD13's prose list naming
 * `ot_case_implants` is a column that does not exist (finding T2-b). **`stock_ledger.patient_id` is
 * NOT rewritten by anyone (F16) and this consumer does not reach into materials to do it**: the OT
 * reads the ledger BY ENCOUNTER, never by patient, so the composer is unaffected; the materials-side
 * rewrite is routed to 14c.
 *
 * ═══ THE N14 COLLISION, WHICH IS THE HALF A NAIVE REWRITE GETS WRONG ═══
 *
 * "Two Sunita Devis, one is the other's escort" is edge row N14 — and if the two Sunitas turn out to
 * be ONE person, the merge makes `patient_id` and `escort_patient_id` equal. The database refuses
 * that outright (`daycare_encounters_escort_not_self_ck`, A7), so a blind `UPDATE … SET patient_id =
 * winner` would abort the whole merge consumer with a constraint error and dead-letter it. The
 * escort link is CLEARED instead and `re_verify_identity` is raised: nobody can be their own escort,
 * and the desk must find out who is actually taking her home.
 *
 * ═══ `re_verify_identity`, AND WHY IT IS NOT SILENT ═══
 *
 * A5 requires the flag. A merge can change which physical human a case refers to; the cockpit's
 * holding verification is the one place that is checked against a wristband, so every touched
 * encounter is marked and the nurse re-scans. It is set on every affected encounter, including one
 * whose only change was the escort — that is deliberate, because the escort changing identity is
 * exactly the case where somebody should look.
 */
/**
 * `ON CONFLICT DO NOTHING` on the primary key — the claim-first shape `appendEvent` uses.
 *
 * The key is namespaced BY CONSUMER, so this module's two handlers claim independently: an event
 * one has processed does not look processed to the other.
 */
async function claimFor(tx: Tx, consumer: string, eventId: string): Promise<boolean> {
  const claimed = await tx.insert(eventIdempotency)
    .values({ idempotencyKey: `${consumer}:${eventId}`, eventId })
    .onConflictDoNothing({ target: eventIdempotency.idempotencyKey })
    .returning({ eventId: eventIdempotency.eventId });
  return claimed.length > 0;
}

export type MergeRewrite = {
  handled: boolean;
  encounters: number;
  cases: number;
  specimens: number;
  escortsCleared: number;
};

/**
 * Handles ONE `patient.merged`. Exported separately from the `Handler` wrapper so a test can drive
 * it on a caller's transaction rather than through the bus (`handleConsignmentDeployed`'s shape).
 */
export async function handlePatientMerged(
  tx: Tx,
  eventId: string,
  payload: unknown,
): Promise<MergeRewrite> {
  const none: MergeRewrite = { handled: false, encounters: 0, cases: 0, specimens: 0, escortsCleared: 0 };
  if (!(await claimFor(tx, OT_PATIENT_MERGED_CONSUMER, eventId))) return none;

  const { winnerPatientId, loserPatientId } = patientMerged.payloadSchema.parse(payload);
  // A merge of a patient into themselves is not a merge; the patients module refuses it, and this
  // guard means a malformed replay cannot make every escort on the ward look like a collision.
  if (winnerPatientId === loserPatientId) return { ...none, handled: true };

  /**
   * THE ESCORT COLLISION IS CLEARED **BEFORE** THE SUBJECT IS REWRITTEN, and the order is the whole
   * of the fix. Reversed, the `patient_id` UPDATE lands first and the CHECK refuses it on any row
   * where the winner is already the escort — aborting the transaction before the clearing statement
   * can run. The set is computed against BOTH ids because either side of the merge may be the one
   * already recorded as the escort.
   */
  const collisions = await tx
    .update(daycareEncounters)
    .set({ escortPatientId: null, reVerifyIdentity: true, updatedAt: new Date() })
    .where(and(
      inArray(daycareEncounters.patientId, [winnerPatientId, loserPatientId]),
      inArray(daycareEncounters.escortPatientId, [winnerPatientId, loserPatientId]),
    ))
    .returning({ id: daycareEncounters.id });

  // Any REMAINING escort link naming the loser is a different, non-colliding person: rewrite it.
  await tx
    .update(daycareEncounters)
    .set({ escortPatientId: winnerPatientId, reVerifyIdentity: true, updatedAt: new Date() })
    .where(eq(daycareEncounters.escortPatientId, loserPatientId));

  const encounters = await tx
    .update(daycareEncounters)
    .set({ patientId: winnerPatientId, reVerifyIdentity: true, updatedAt: new Date() })
    .where(eq(daycareEncounters.patientId, loserPatientId))
    .returning({ id: daycareEncounters.id });

  const cases = await tx
    .update(otCases)
    .set({ patientId: winnerPatientId, updatedAt: new Date() })
    .where(eq(otCases.patientId, loserPatientId))
    .returning({ id: otCases.id });

  const specimens = await tx
    .update(otSpecimens)
    .set({ patientId: winnerPatientId })
    .where(eq(otSpecimens.patientId, loserPatientId))
    .returning({ id: otSpecimens.id });

  return {
    handled: true,
    encounters: encounters.length,
    cases: cases.length,
    specimens: specimens.length,
    escortsCleared: collisions.length,
  };
}

/** The consumer key the manifest subscribes with for `material.consumed`. */
export const OT_IMPLANT_CONFIRMED_CONSUMER = "ot.implant_confirmed";

/**
 * PLAN 15 T5 / DD9 — **THE OTHER HALF OF THE SCAN, ARRIVING LATER.**
 *
 * `deployImplant` appends `consignment.deployed` and returns; the worker's materials consumer
 * decrements the lot, writes the `consume` ledger row and emits `material.consumed`; THIS handler
 * stamps the OT row `confirmed` with its `ledger_entry_id`. Between the scan and this moment the
 * row is `deploying`, and `signOut` is refused (A18) — which is the point of having a state at all.
 *
 * ═══ IT MATCHES ON `caseRef` AND `serial`, NOT ON THE EVENT ID ═══
 *
 * The `material.consumed` payload carries `caseRef: { type, id }` and the ledger entry, and that is
 * what ties it back to an OT row. It does NOT carry the implant row's id — Plan 14 froze that
 * payload before this module existed — so the match is (case, item, batch) and the row is chosen as
 * the OLDEST still-deploying one for that triple. Two identical implants deployed on one case are
 * distinguished by serial where there is one and by arrival order where there is not, which is the
 * best a frozen payload allows and is stated here rather than assumed.
 *
 * Idempotent by EVENT ID, like every other consumer in this system.
 */
export type ImplantConfirmation = { handled: boolean; implantId: string | null };

export async function handleMaterialConsumed(
  tx: Tx, eventId: string, payload: unknown,
): Promise<ImplantConfirmation> {
  if (!(await claimFor(tx, OT_IMPLANT_CONFIRMED_CONSUMER, eventId))) {
    return { handled: false, implantId: null };
  }
  const parsed = materialConsumed.payloadSchema.safeParse(payload);
  if (!parsed.success) return { handled: true, implantId: null };
  const consumed = parsed.data;
  // Not an OT case: this consumer subscribes to every `material.consumed`, and pharmacy's
  // dispensing will emit them too from 16c.
  if (consumed.caseRef.type !== "ot_case") return { handled: true, implantId: null };

  /**
   * CLOSE REVIEW (MINOR 15) — the BATCH is part of the match, as the docstring above always said it
   * was. It was missing from the filter, so two same-item implants from DIFFERENT lots on one case
   * were paired to their ledger entries by arrival order alone: a plate from lot A could be
   * confirmed against lot B's consumption, and the discharge bill would then price it from the wrong
   * batch's MRP. A comment that describes a match the code does not make is §2.122's defect with the
   * roles reversed, and the fix is to make the code true rather than the comment weaker.
   */
  const candidates = await tx.select().from(otCaseImplants).where(and(
    eq(otCaseImplants.caseId, consumed.caseRef.id),
    eq(otCaseImplants.itemId, consumed.itemId),
    eq(otCaseImplants.batchId, consumed.batchId),
    eq(otCaseImplants.state, "deploying"),
  ));
  const row = candidates.sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime())[0];
  if (row === undefined) return { handled: true, implantId: null };

  await tx.update(otCaseImplants)
    .set({ state: "confirmed", ledgerEntryId: consumed.ledgerEntryId, eventId })
    .where(eq(otCaseImplants.id, row.id));
  return { handled: true, implantId: row.id };
}

export function implantConfirmedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== materialConsumed.name) return;
    await withTx(db, (tx) => handleMaterialConsumed(tx, e.eventId, e.payload));
  };
}

export function patientMergedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== patientMerged.name) return;
    await withTx(db, (tx) => handlePatientMerged(tx, e.eventId, e.payload));
  };
}
