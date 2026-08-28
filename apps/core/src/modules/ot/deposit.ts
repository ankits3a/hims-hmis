import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { daycareEncounters, otDepositHolds } from "../../kernel/db/schema";
import { advanceOf, receiptUnallocatedPaise } from "../billing";
import { getApproval } from "../../kernel/approvals/worklist";
import { requestApproval } from "../../kernel/approvals/requests";
import { PAYER_CLASS_VALUES } from "../../kernel/db/schema/ot";
import { DEPOSIT_EXCEPTION_APPROVAL_TYPE } from "./approval-types";
import { OtError } from "./errors";
import type { DepositPolicyBody } from "./definitions";
import type { Tx } from "../../kernel/db/client";

export type PayerClass = (typeof PAYER_CLASS_VALUES)[number];

/**
 * PLAN 15 T3 / DD12 + §3A — **THE DEPOSIT: A PURE FUNCTION, A LEDGER OF HOLDS, AND ONE EXCEPTION.**
 *
 * ═══ `requiredDeposit` IS PURE, AND THE INVARIANT IS ITS CONTRACT (A1) ═══
 *
 *     0 <= required <= quotePaise + implantEstimatePaise
 *
 * Both halves matter and they fail in opposite directions. A NEGATIVE required is a deposit gate
 * that satisfies itself and, worse, an amount a screen would happily render as a refund due. A
 * required ABOVE the whole bill is a patient asked to pre-pay more than the operation costs. The
 * property is asserted over random inputs for every payer class rather than at three example
 * points, because the arithmetic differs per class and an example set proves only the examples.
 *
 * The zod schema is what makes the upper bound hold: `percentBps` and `coPayFloorBps` are capped at
 * 10,000 there, so no policy row can ask for 150% of a quote. A guard here as well would be a second
 * place to change one rule — the schema is the owner.
 *
 * ═══ THE CO-PAY FLOOR IS THE POINT OF `insured_tpa` (A1's discriminating input) ═══
 *
 * `quote − sanctioned` alone is the obvious implementation and it is WRONG in the commonest case: a
 * TPA sanctions the whole quote and the patient still owes the policy's co-pay and non-payables.
 * Sanctioned 60,000 against a 60,000 quote yields 12,000 at a 20% floor and ZERO without it, and the
 * hospital discovers the difference at discharge, from a patient who was told they owed nothing.
 * **A sanction BELOW the quote does not discriminate** — both implementations return the shortfall —
 * which is why the fixture uses a sanction equal to it.
 *
 * ═══ WHY THIS MODULE OWNS `ot_deposit_holds` AT ALL (F3) ═══
 *
 * Advances in billing are PER PATIENT: `receipts` has no encounter column and `advanceOf` sums the
 * patient. So an OPD overpayment from March would satisfy a surgery's deposit in August, and two
 * day-care encounters on one day could not be told apart. A hold EARMARKS part of that advance
 * against ONE encounter, and the sum of open holds is what the gate reads.
 *
 * ═══ THE HOLD CHECK RUNS UNDER A LOCK, AND THE LOCK IS ON THE PATIENT'S ENCOUNTERS ═══
 *
 * `advanceOf − Σ open holds` is a read-then-write, so two concurrent holds would both pass it and
 * earmark the same rupee twice. The serializer is `SELECT … FOR UPDATE` over the patient's
 * `daycare_encounters` rows, ordered by id — the `receipts.ts` set-then-rows shape. Every hold for
 * one patient takes the same lock set in the same order, so they serialise and cannot deadlock.
 * Plan 14's C1 warning does not bite here: the encounter row a hold names always exists (the hold
 * has an FK to it), so this is never a lock on a row that is not there.
 */
export type RequiredDepositInput = {
  payerClass: PayerClass;
  quotePaise: number;
  implantEstimatePaise: number;
  /** `insured_tpa` — the pre-auth amount the TPA has sanctioned. */
  sanctionedPaise?: number;
  /** `corporate_credit` — the partner's remaining credit. NO credit LIMIT is enforced anywhere in
   *  this tree (`partners` is commission/payout, not credit), so this is a typed number and the
   *  gate report says so. */
  creditAvailablePaise?: number;
  /** `membership_prepaid` — the best single benefit's value (Plan 09 counters). */
  entitlementPaise?: number;
};

/**
 * PURE + SYNCHRONOUS. No I/O, no clock, no randomness — same policy + input in, same paise out.
 */
export function requiredDeposit(policy: DepositPolicyBody, input: RequiredDepositInput): number {
  const rule = policy.rules[input.payerClass];
  const quote = input.quotePaise;
  const implant = input.implantEstimatePaise;
  const wholeBill = quote + implant;

  switch (rule.kind) {
    case "zero":
      // `govt_scheme` (D10: no balance billing, structurally), `fp_scheme` (R-3.19: the claim goes
      // to the district) and `charity` (D13). A costlier implant than the package is an absorption
      // cost centre with an approval, NEVER the patient — which is why this is 0 and not "the
      // shortfall".
      return 0;

    case "percent_of_quote": {
      // `self_pay` at 100% is the owner's ruling; `staff_dependant` at 50% is the same shape with a
      // different number. ONE class, ONE percent: §3A's "0 for staff, 50% for dependants" is two
      // numbers for one `payer_class`, and the eight classes are a CHECK constraint — a separate
      // `staff` class would be a schema change, so the policy carries the dependant number and a
      // staff member's own procedure is priced by whatever class the desk selects.
      const base = rule.includeImplantEstimate ? wholeBill : quote;
      // Integer paise, floored: a deposit is never rounded UP against the patient.
      return Math.floor((base * rule.percentBps) / 10000);
    }

    case "quote_minus_sanctioned": {
      // THE CO-PAY FLOOR IS NOT OPTIONAL — see the header. `sanctioned` absent means the pre-auth
      // has not come back, which is the same position as sanctioned = 0: the whole bill is due.
      const sanctioned = input.sanctionedPaise ?? 0;
      const shortfall = Math.max(0, wholeBill - sanctioned);
      const floor = Math.floor((quote * rule.coPayFloorBps) / 10000);
      return Math.max(shortfall, floor);
    }

    case "excess_over_credit":
      return Math.max(0, wholeBill - (input.creditAvailablePaise ?? 0));

    case "quote_minus_entitlement":
      return Math.max(0, wholeBill - (input.entitlementPaise ?? 0));
  }
}

export type DepositHoldRow = typeof otDepositHolds.$inferSelect;

/** Every OPEN hold on one encounter, and their sum. */
export async function openHolds(exec: Tx, encounterId: string): Promise<DepositHoldRow[]> {
  return exec.select().from(otDepositHolds)
    .where(and(eq(otDepositHolds.encounterId, encounterId), isNull(otDepositHolds.releasedAt)));
}

export async function heldPaise(exec: Tx, encounterId: string): Promise<number> {
  const rows = await openHolds(exec, encounterId);
  return rows.reduce((sum, r) => sum + r.amountPaise, 0);
}

/**
 * Locks every day-care encounter of one patient, in id order, and returns their ids. The
 * serializer for `holdDeposit` — see the header.
 */
async function lockPatientEncounters(tx: Tx, patientId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select id from daycare_encounters where patient_id = ${patientId} order by id for update
  `)).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/** Σ open holds across EVERY encounter of one patient — the figure `advanceOf` must cover. */
async function patientHeldPaise(tx: Tx, encounterIds: string[]): Promise<number> {
  if (encounterIds.length === 0) return 0;
  const rows = await tx.select({ amountPaise: otDepositHolds.amountPaise })
    .from(otDepositHolds)
    .where(and(inArray(otDepositHolds.encounterId, encounterIds), isNull(otDepositHolds.releasedAt)));
  return rows.reduce((sum, r) => sum + r.amountPaise, 0);
}

/**
 * A5c — earmarks part of the patient's UNALLOCATED advance against ONE encounter.
 *
 * The refusal is `advanceOf − Σ open holds ACROSS THE PATIENT`, not per encounter, and that is the
 * whole of the finding: two encounters cannot hold the same rupee twice. The mutant checks
 * `advanceOf` alone and lets both through — an advance of 30,000 backing two 20,000 deposits, and
 * two operations that both believe they are paid for.
 */
/** Open holds carved from ONE receipt, across every encounter — they all spend the same money. */
async function receiptHeldPaise(tx: Tx, receiptId: string): Promise<number> {
  const rows = await tx.select({ amountPaise: otDepositHolds.amountPaise })
    .from(otDepositHolds)
    .where(and(eq(otDepositHolds.receiptId, receiptId), isNull(otDepositHolds.releasedAt)));
  return rows.reduce((sum, r) => sum + r.amountPaise, 0);
}

export async function holdDeposit(
  tx: Tx,
  actor: Actor,
  input: { encounterId: string; receiptId: string; amountPaise: number; paidBy?: { name: string; relation: string; phone: string } },
): Promise<{ holdId: string; heldPaise: number }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new OtError("deposit_shortfall", `hold amount must be a positive integer of paise, got ${String(input.amountPaise)}`);
  }
  const encRows = await tx.select({ patientId: daycareEncounters.patientId })
    .from(daycareEncounters).where(eq(daycareEncounters.id, input.encounterId));
  const encounter = encRows[0];
  if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${input.encounterId}`);

  /**
   * ═══ CLOSE REVIEW M2 — THE RECEIPT IS LOADED, AND IT MUST BE ABLE TO FUND THIS HOLD ═══
   *
   * DD12 says a hold "earmarks part of a RECEIPT's unallocated balance", and nothing checked the
   * receipt at all: not that it exists (`ot_deposit_holds.receipt_id` carries no FK), not that it
   * belongs to this patient, not that it has that much left. The only bound was the patient's whole
   * advance — so a patient who paid ₹10,000 by card (R1) and ₹20,000 cash (R2) could have ₹30,000
   * held against R1, which the gate happily satisfied. The bill then could not be issued at all:
   * `settleDischargeBill` asks `allocateOnTx` for ₹30,000 of R1, billing refuses `over_allocation`,
   * and the whole invoice transaction rolls back with no path forward but editing holds by hand.
   *
   * Refusing here puts the error in front of the person who can fix it, at the moment they made it.
   */
  const receipt = await receiptUnallocatedPaise(tx, input.receiptId);
  if (receipt === null) {
    throw new OtError("deposit_shortfall", `unknown receipt ${input.receiptId}`, { receiptId: input.receiptId });
  }
  if (receipt.patientId !== encounter.patientId) {
    throw new OtError(
      "deposit_shortfall",
      `receipt ${input.receiptId} belongs to a different patient — a deposit cannot be earmarked from somebody else's money`,
      { receiptId: input.receiptId },
    );
  }
  const heldOnReceipt = await receiptHeldPaise(tx, input.receiptId);
  const spareOnReceipt = receipt.unallocatedPaise - heldOnReceipt;
  if (input.amountPaise > spareOnReceipt) {
    throw new OtError(
      "deposit_shortfall",
      `cannot hold ${String(input.amountPaise)}p against receipt ${input.receiptId}: ${String(spareOnReceipt)}p is unallocated and unheld on it`,
      { receiptId: input.receiptId, spareOnReceiptPaise: spareOnReceipt, requestedPaise: input.amountPaise },
    );
  }

  const encounterIds = await lockPatientEncounters(tx, encounter.patientId);
  const advance = await advanceOf(tx, encounter.patientId);
  const alreadyHeld = await patientHeldPaise(tx, encounterIds);
  const spare = advance - alreadyHeld;
  if (input.amountPaise > spare) {
    throw new OtError(
      "deposit_shortfall",
      `cannot hold ${String(input.amountPaise)}p: the patient's advance is ${String(advance)}p and ${String(alreadyHeld)}p is already held on their day-care encounters`,
      { advancePaise: advance, alreadyHeldPaise: alreadyHeld, requestedPaise: input.amountPaise },
    );
  }

  const holdId = newId();
  await tx.insert(otDepositHolds).values({
    id: holdId, encounterId: input.encounterId, receiptId: input.receiptId,
    amountPaise: input.amountPaise, paidBy: input.paidBy ?? null, heldBy: actor.id,
  });
  return { holdId, heldPaise: await heldPaise(tx, input.encounterId) };
}

/**
 * Releases every open hold on an encounter. §3A: a CANCELLATION releases and refunds; a
 * POSTPONEMENT keeps the deposit as a liability on the encounter (D5) and therefore does NOT call
 * this. The reason is required by the CHECK, so a release with no reason cannot be written.
 */
export async function releaseHolds(
  tx: Tx,
  encounterId: string,
  reason: string,
): Promise<{ released: number; amountPaise: number }> {
  const rows = await tx.update(otDepositHolds)
    .set({ releasedAt: new Date(), releasedReason: reason })
    .where(and(eq(otDepositHolds.encounterId, encounterId), isNull(otDepositHolds.releasedAt)))
    .returning({ amountPaise: otDepositHolds.amountPaise });
  return { released: rows.length, amountPaise: rows.reduce((sum, r) => sum + r.amountPaise, 0) };
}

/**
 * N12 — the ONLY path by which `paid < required` reaches a satisfied `deposit` gate. Files an
 * `ot_deposit_exception` (approver `owner`) carrying the shortfall it authorises.
 */
export async function requestDepositException(
  tx: Tx,
  actor: Actor,
  input: { encounterId: string; patientId: string; allowedShortfallPaise: number; reason: string },
): Promise<{ approvalId: string }> {
  if (!Number.isSafeInteger(input.allowedShortfallPaise) || input.allowedShortfallPaise <= 0) {
    throw new OtError("deposit_shortfall", "an exception must authorise a positive shortfall");
  }
  if (input.reason.trim() === "") {
    throw new OtError("deposit_shortfall", "a deposit exception must carry a reason");
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: DEPOSIT_EXCEPTION_APPROVAL_TYPE,
    subject: { type: "daycare_encounter", id: input.encounterId },
    patientId: input.patientId,
    amountPaise: input.allowedShortfallPaise,
    requestNote: `${input.reason} (shortfall ${String(input.allowedShortfallPaise)}p)`,
  });
  return { approvalId };
}

/**
 * The shortfall a GRANTED exception authorises for one encounter, or 0.
 *
 * The subject is compared as well as the status: an exception granted for a DIFFERENT encounter of
 * the same patient must not satisfy this one's gate, which is F3's own lesson one level up.
 */
export async function grantedShortfallPaise(tx: Tx, encounterId: string, approvalId: string | null): Promise<number> {
  if (approvalId === null) return 0;
  const approval = await getApproval(tx, approvalId);
  if (!approval || approval.status !== "granted") return 0;
  if (approval.typeKey !== DEPOSIT_EXCEPTION_APPROVAL_TYPE) return 0;
  if (approval.subjectType !== "daycare_encounter" || approval.subjectId !== encounterId) return 0;
  return approval.amountPaise ?? 0;
}
