import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { approvals, pharmacyDispenseLines, pharmacyDispenses, stockReservations } from "../../kernel/db/schema";
import { CREDIT_APPROVAL_SUBJECT } from "../billing";
import { renewReservations } from "../materials";
import { PICK_RESERVATION_MINUTES } from "./config";
import { DISCOUNT_APPROVAL_SUBJECT, discountDraftOf } from "./discount";
import { PharmacyError } from "./errors";
import { cancelDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";

/**
 * PLAN 16c CLOSE REVIEW / F11 — THE PICK RESERVATION FINALLY EXPIRES.
 *
 * D2 and `PICK_RESERVATION_MINUTES = 30` promised that a pick "holds a batch before the ledger may
 * release it to somebody else". `pick.ts` wrote `expires_at` on every reservation and **nothing in
 * `apps/core/src` ever read it** — no sweeper, no job — so an abandoned pick held `qty_reserved`
 * for ever. `fefoPick` and `balances` both subtract reserved stock, so the counter reports short
 * stock on a full shelf, and the only cure was a pharmacist noticing and cancelling by hand. The
 * close review recorded this as 16d's to inherit; 16d is gated on an IPD plan that does not exist,
 * and this is a live defect in shipped code, so it is closed here instead.
 *
 * ═══ WHAT AN EXPIRED PICK MEANS, DECIDED ═══
 *
 * The stock goes back on the shelf and the dispense is CANCELLED with the reason recorded — the
 * standard counter answer, and the one D2 already describes ("the ledger may release it to somebody
 * else"). The patient re-presents, the prescription is still active, and a fresh dispense is queued
 * by the same scan that queued the first. Nothing is invented here: `cancelDispense` is the phase's
 * own tested transition (`picked → cancelled` is in the definition), and it already releases every
 * reservation, cancels every order item and closes the instance in one transaction.
 *
 * ═══ WHERE IT STOPS: `billed` IS NEVER SWEPT ═══
 *
 * Money moving is the line this sweep does not cross. A `billed` dispense has been paid for and its
 * medicine belongs to the patient; releasing that stock would sell a paid-for drug to somebody
 * else. Paid-not-collected is a REFUND path and it is 16d's (D8, §6). So the filter is
 * `status = 'picked'` and nothing wider — the one state where stock is held and no money has moved.
 *
 * **That filter's revert stayed GREEN (§5A.4), and it is kept anyway.** Deleting
 * `eq(status, 'picked')` breaks no test because `cancelDispense` refuses a `billed` dispense on its
 * own (`["queued","claimed","verified","picked"].includes(d.status)`), so the protection is
 * enforced twice and the suite asserts the OUTCOME — billed untouched, its stock still held. The
 * amendment's question is whether a road exists, and here it provably does not: a reservation is
 * written only by `pickDispense`, which moves the dispense to `picked` in the same transaction, and
 * no path returns a dispense to `verified` or earlier while a line still holds one — so the join
 * itself cannot yield a non-`picked` row today.
 *
 *   grep -rn "reservationId" apps/core/src/modules/pharmacy --include=*.ts | grep -v test
 *     → pick.ts (sets it, with status → 'picked'), verify.ts (releases on decline/cancel),
 *       handover.ts (consumes it). Nothing else writes it.
 *
 * It stays because "no fixture reaches it" is not "nothing can": the day a phase adds a re-pick, a
 * partial re-reservation or a billed→verified correction, this clause is what keeps a paid-for
 * drug on the shelf it was sold from. The enumeration above is its road map, not its epitaph.
 *
 * ═══ A TICKET WAITING ON A DECISION IS NOT ABANDONED (2026-11-13) ═══
 *
 * A picked ticket can wait on somebody else's answer: a discount above the pharmacist's 10%
 * (`discount.ts`, the in-charge or the owner) or credit (only the owner, 0013). Both approvals are
 * filed against the dispense as the bill's draft. Cancelling it at 30 minutes put the picked medicine
 * back on the shelf and minted a new P-number when the answer came. So while an approval bound to
 * the ticket — subject = this dispense, same patient — is still `pending`, the sweep does not cancel
 * it and renews its held reservations to `now + PICK_RESERVATION_MINUTES`. Once it is decided
 * (granted or rejected), nothing renews it and the ordinary 30 minutes run from the last renewal.
 * A request nobody decides holds the stock until somebody does, or the pharmacist cancels.
 */
export const PHARMACY_PICK_SWEEP_ACTOR: Actor = { type: "system", id: "pharmacy-pick-expiry-sweep" };

export const PICK_EXPIRED_REASON = "the pick reservation expired — the stock went back on the shelf";

export async function sweepExpiredPicks(
  db: Db,
  decls: readonly OrderKindDecl[],
  now: Date,
): Promise<{ cancelled: string[] }> {
  const rows = await db
    .select({ dispenseId: pharmacyDispenses.id, patientId: pharmacyDispenses.patientId })
    .from(pharmacyDispenses)
    .innerJoin(pharmacyDispenseLines, eq(pharmacyDispenseLines.dispenseId, pharmacyDispenses.id))
    .innerJoin(stockReservations, eq(stockReservations.id, pharmacyDispenseLines.reservationId))
    .where(and(
      eq(pharmacyDispenses.status, "picked"),
      eq(stockReservations.status, "held"),
      isNotNull(stockReservations.expiresAt),
      lt(stockReservations.expiresAt, now),
    ));

  const tickets = [...new Map(rows.map((r) => [r.dispenseId, r.patientId] as const))];
  const waiting = await awaitingDecision(db, tickets);
  await holdWhileWaiting(db, [...waiting], now);

  const cancelled: string[] = [];
  for (const [id] of tickets) {
    if (waiting.has(id)) continue;
    try {
      await cancelDispense(db, PHARMACY_PICK_SWEEP_ACTOR, decls, id, PICK_EXPIRED_REASON, now);
      cancelled.push(id);
    } catch (e) {
      /**
       * The counter got there first — billed, handed over or cancelled between the read and the
       * write. That is the conditional UPDATE inside `cancelDispense` doing its job, not an error:
       * a sweep never races a pharmacist and wins. Anything else is a real fault and propagates.
       *
       * ═══ AND UNTIL PASS 2 THAT SENTENCE WAS FALSE ═══
       *
       * `cancelDispense` ran its per-line loop BEFORE the conditional UPDATE, so a pharmacist
       * cancelling the same abandoned dispense made `advanceOrderItem` lose ITS CAS first and
       * raise `OrderError("stale_state")` — not a `PharmacyError`, so this filter rethrew it, the
       * tick died, and every later expired pick in the same batch was skipped for a minute. The
       * filter is right and was always right; the code it described was not. Fixed where it was
       * wrong (`verify.ts`, the CAS now leads the transaction) rather than by widening this catch
       * to name every error a race can throw — a list that grows with every module the cancel
       * touches, which is the trap the "one definition" rule exists to refuse.
       */
      if (!(e instanceof PharmacyError && e.code === "dispense_not_in_state")) throw e;
    }
  }
  return { cancelled };
}

/**
 * The tickets among `tickets` (dispense id → patient) with an approval still PENDING that binds to
 * them: a sale discount (subject `pharmacy_sale_discount`, draft = the dispense) or owner credit
 * (subject `billing_credit`, id = the dispense), filed for the same patient. Read straight off the
 * approvals table, as `antimicrobial.ts` reads its steward approvals: the kernel has no read by subject.
 */
async function awaitingDecision(db: Db, tickets: readonly (readonly [string, string])[]): Promise<Set<string>> {
  if (tickets.length === 0) return new Set();
  const patientOf = new Map(tickets);
  const pending = await db
    .select({ subjectType: approvals.subjectType, subjectId: approvals.subjectId, patientId: approvals.patientId })
    .from(approvals)
    .where(and(
      eq(approvals.status, "pending"),
      inArray(approvals.subjectType, [DISCOUNT_APPROVAL_SUBJECT, CREDIT_APPROVAL_SUBJECT]),
      inArray(approvals.patientId, [...new Set(patientOf.values())]),
    ));
  const out = new Set<string>();
  for (const a of pending) {
    const draftId = a.subjectType === DISCOUNT_APPROVAL_SUBJECT ? discountDraftOf(a.subjectId) : a.subjectId;
    if (patientOf.has(draftId) && patientOf.get(draftId) === a.patientId) out.add(draftId);
  }
  return out;
}

/** Renews every held reservation of these tickets for another `PICK_RESERVATION_MINUTES` from `now`. */
async function holdWhileWaiting(db: Db, dispenseIds: readonly string[], now: Date): Promise<void> {
  if (dispenseIds.length === 0) return;
  const lines = await db
    .select({ reservationId: pharmacyDispenseLines.reservationId })
    .from(pharmacyDispenseLines)
    .where(and(inArray(pharmacyDispenseLines.dispenseId, [...dispenseIds]), isNotNull(pharmacyDispenseLines.reservationId)));
  await renewReservations(db, lines.map((l) => l.reservationId!), new Date(now.getTime() + PICK_RESERVATION_MINUTES * 60_000));
}
