import { and, asc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { commissionAccruals, invoices, membershipInstances } from "../../kernel/db/schema";
import { divHalfUp, percentAmount } from "../tariff";
import { rateSnapshotOf } from "./agreements";
import { payoutClassBlocked } from "./events";
import type { AccrualTerms, CounterpartyFacts, ResolvedAgreement } from "./agreements";
import type { InvoiceAccrualView } from "../billing";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD12 — THE ACCRUAL BASE, DEFINED ONCE, AND THE LOCKED WRITER THAT APPENDS ITS DELTA.
 *
 * ═══ THE ARITHMETIC IS THE PLAN'S, AND IT WAS MEASURED BEFORE IT WAS WRITTEN ═══
 *
 *     liveBase(L)  = max(L.taxableBasePaise − L.creditedBasePaise, 0)      per line
 *     eligibleBase = Σ liveBase(L)  for L.category ∈ terms.eligibleCategories
 *     settleable   = max(netPayablePaise − creditedPaise, 0)
 *     collected    = max(allocatedPaise − refundedPaise, 0)
 *     targetBase   = settleable === 0 ? 0 : divHalfUp(eligibleBase × collected, settleable)
 *     target       = percentAmount(targetBase, payableRateBps)
 *     delta        = target − Σ(rows already appended for this subject)
 *
 * The FIRST version of this formula scaled the eligible pre-GST base by
 * `amountPaise / invoices.net_payable_paise`, and §3 Q4 REFUTED it by execution: on a settled
 * invoice carrying a credit note it produced **63 543 where 45 000 is correct**, because
 * `invoices` and `invoice_lines` are immutable under migration 0012 — a credit note moves neither,
 * so numerator and denominator both stayed pre-credit while the money had moved. Every number
 * above therefore comes from `invoiceAccrualView` (DD19), which reports the LIVE sums. The refuted
 * version is Assertion Book row F3b and `golden/fixtures/p03-credit-note-counter-example.json` is
 * the spike's own counter-example, kept as the fixture that kills it.
 *
 * `divHalfUp` and `percentAmount` are Plan 06's, imported from the frozen tariff index. **This
 * phase writes no rounding of its own** — there is exactly one half-up division in the money path
 * of this repository and it is not going to become two.
 *
 * ═══ WHY THERE IS NO REVERSAL PATH IN THIS FILE ═══
 *
 * A refund, an `allocation.reversed`, a credit note and an entered-in-error mark all move
 * `collected` or `settleable`, so all four produce a NEGATIVE delta through the one line above.
 * There is no proportional-reversal formula left to get wrong, and "total reversal never exceeds
 * total accrual" stops being a check and becomes structural: `target ≥ 0` and `Σ deltas = target`.
 * That is DD12's property 3, and it is why the consumer does not branch on which event arrived.
 *
 * ═══ THE SERIALIZER, AND WHY THE SUBJECT ROW EXISTS AT ALL ═══
 *
 * Delta-to-target is a read-modify-write: read `Σ`, append the difference. Two dispatch cycles
 * handling two DIFFERENT events for ONE invoice at the same time is a real, observed shape (the
 * alerts consumer's docstring records it), and without a serializer both read the same sum and
 * both append the same delta. So `commission_accrual_subjects` — unique on
 * `(agreement_id, invoice_id, direction)` — is UPSERTED and then locked `FOR UPDATE`, with the sum
 * and the append inside the lock. DD10's shape reused, measured to block in this harness (§3 Q6),
 * and Assertion Book F11 is the mutant with that lock deleted.
 *
 * `commission_accruals_basis_event_ux` on `(subject_id, basis_event_id)` is the SECOND guard, and
 * the first is the in-lock existence check below (F6). Both are needed and neither is redundant:
 * at-least-once delivery is the dispatcher's stated contract, and a redelivery that arrives after
 * the invoice's money has moved again would compute a NON-zero delta and append a second row for
 * one event — which is a double accrual, not a harmless retry.
 */

/** Every number DD12's formula produces, kept together so an accrual row can explain itself. */
export type AccrualBasis = {
  eligibleBasePaise: number;
  settleablePaise: number;
  collectedPaise: number;
  targetBasePaise: number;
  targetPaise: number;
};

const floorAtZero = (n: number): number => (n > 0 ? n : 0);

/**
 * DD12, pure. No I/O, no clock, no database — which is what lets `golden/` hand-compute it.
 *
 * An invoice carrying an `entered_in_error` mark has `target = 0` and therefore reverses whatever
 * was accrued, through the same delta as everything else.
 */
export function accrualBasis(view: InvoiceAccrualView, terms: Pick<AccrualTerms, "payableRateBps" | "eligibleCategories">): AccrualBasis {
  const eligible = new Set(terms.eligibleCategories);
  let eligibleBasePaise = 0;
  for (const line of view.lines) {
    if (!eligible.has(line.category)) continue;
    eligibleBasePaise += floorAtZero(line.taxableBasePaise - line.creditedBasePaise);
  }
  const settleablePaise = floorAtZero(view.netPayablePaise - view.creditedPaise);
  const collectedPaise = floorAtZero(view.allocatedPaise - view.refundedPaise);

  if (view.enteredInError) {
    return { eligibleBasePaise, settleablePaise, collectedPaise, targetBasePaise: 0, targetPaise: 0 };
  }
  const targetBasePaise =
    settleablePaise === 0 ? 0 : divHalfUp(eligibleBasePaise * collectedPaise, settleablePaise);
  return {
    eligibleBasePaise,
    settleablePaise,
    collectedPaise,
    targetBasePaise,
    targetPaise: percentAmount(targetBasePaise, terms.payableRateBps),
  };
}

/**
 * WHICH PARTNER AN INVOICE'S COMMISSION BELONGS TO.
 *
 * The payable lane's attribution is the INSTRUMENT: the invoice's patient held a partner-sold card
 * that was live when the hospital billed, so that partner earns on this bill. Everything the
 * predicate reads is either immutable or pinned to an instant, because a replay must reach the
 * same answer the live run did:
 *
 *  - `verified = true` — C-17, and O-1's load-bearing half. A grace-honored instance
 *    (`origin = 'grace'`) is HONOURED at the counter and **accrues nothing** until a real book row
 *    arrives and matches it, because there is no partner sale reference to attribute to.
 *  - `counterparty_id is not null` — a counter-sold or grace card names no partner.
 *  - the instance's validity window contains the invoice's `issued_at`. The window is immutable;
 *    `membership_instances.status` deliberately is NOT read, because it moves after the fact and
 *    a status flipped next month must not change what last month's commission was.
 *  - arrival order (`seq`) breaks a tie, so DD11's merge duplicate — two rows for one holder —
 *    resolves deterministically rather than by whichever row the planner returned first.
 */
export type AccrualAttribution = {
  invoiceId: string;
  issuedAt: Date;
  patientId: string;
  instrumentId: string;
  counterpartyId: string;
};

export async function attributeInvoice(exec: Db | Tx, invoiceId: string): Promise<AccrualAttribution | null> {
  const invoiceRows = await exec
    .select({ id: invoices.id, patientId: invoices.patientId, issuedAt: invoices.issuedAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const invoice = invoiceRows[0];
  if (!invoice) return null;

  const instruments = await exec
    .select({ id: membershipInstances.id, counterpartyId: membershipInstances.counterpartyId })
    .from(membershipInstances)
    .where(
      and(
        eq(membershipInstances.patientId, invoice.patientId),
        eq(membershipInstances.verified, true),
        sql`${membershipInstances.counterpartyId} is not null`,
        sql`${membershipInstances.validFrom} <= ${invoice.issuedAt}`,
        sql`${membershipInstances.validTo} >= ${invoice.issuedAt}`,
      ),
    )
    .orderBy(asc(membershipInstances.seq))
    .limit(1);

  const instrument = instruments[0];
  if (!instrument || instrument.counterpartyId === null) return null;
  return {
    invoiceId: invoice.id,
    issuedAt: invoice.issuedAt,
    patientId: invoice.patientId,
    instrumentId: instrument.id,
    counterpartyId: instrument.counterpartyId,
  };
}

/** Everything `appendAccrualDelta` needs that it will not go and read for itself. */
export type AppendAccrualInput = {
  actor: Actor;
  attribution: AccrualAttribution;
  counterparty: CounterpartyFacts;
  agreement: ResolvedAgreement;
  view: InvoiceAccrualView;
  basisEventId: string;
  basisEventName: string;
  occurredAt: Date;
};

export type AppendAccrualResult =
  | { outcome: "appended"; accrualId: string; deltaPaise: number; state: "accrued" | "escrowed"; basis: AccrualBasis; priorPaise: number }
  | { outcome: "already_recorded"; accrualId: string; basis: AccrualBasis }
  | { outcome: "no_delta"; basis: AccrualBasis; priorPaise: number }
  | { outcome: "payout_blocked"; payeeClass: string; basis: AccrualBasis; priorPaise: number };

const DIRECTION_PAYABLE = "payable";

/**
 * The one writer. Everything from the subject upsert to the append happens inside ONE transaction
 * holding ONE row lock, and nothing in it reads a clock: `occurredAt` is the EVENT's own instant,
 * handed down by the dispatcher (Plan 10 D5), so a replay writes the same row a live delivery did.
 *
 * O-7 — **A SUSPENDED PARTNER'S ACCRUAL IS WRITTEN, NOT SKIPPED.** The row is `state = 'escrowed'`
 * and no payable total includes it (`payableTotalPaise` below). The reason is the replay property:
 * a skipped accrual is indistinguishable from an event that never arrived, and an escrowed row is
 * a decision with a date on it. An escrowed row still counts in `Σ` for the delta — it has to, or
 * a suspension followed by a release would accrue the same money twice.
 */
export async function appendAccrualDelta(db: Db, input: AppendAccrualInput): Promise<AppendAccrualResult> {
  const { attribution, counterparty, agreement, view } = input;
  const basis = accrualBasis(view, agreement.terms);

  return withTx(db, async (tx) => {
    // (1) The subject row, upserted then LOCKED. `on conflict do nothing` cannot return the id of
    //     a row it did not touch, so the lock is taken by a separate `for update` select — which
    //     is also the statement that WAITS for a concurrent cycle holding the same subject.
    await tx.execute(sql`
      insert into commission_accrual_subjects (id, agreement_id, invoice_id, direction, counterparty_id)
      values (${newId()}, ${agreement.agreementId}, ${attribution.invoiceId}, ${DIRECTION_PAYABLE},
              ${counterparty.counterpartyId})
      on conflict (agreement_id, invoice_id, direction) do nothing
    `);
    const subjectRows = (await tx.execute(sql`
      select id from commission_accrual_subjects
      where agreement_id = ${agreement.agreementId}
        and invoice_id = ${attribution.invoiceId}
        and direction = ${DIRECTION_PAYABLE}
      for update
    `)).rows as { id: string }[];
    const subjectId = subjectRows[0]!.id;

    // (2) F6's FIRST guard. At-least-once is the dispatcher's contract, and a redelivery arriving
    //     after the invoice's money moved again would otherwise compute a non-zero delta and
    //     append a SECOND row for one event. `commission_accruals_basis_event_ux` is the second
    //     guard behind this one, exactly as DD10 keeps its index behind its lock.
    const already = await tx
      .select({ id: commissionAccruals.id })
      .from(commissionAccruals)
      .where(and(eq(commissionAccruals.subjectId, subjectId), eq(commissionAccruals.basisEventId, input.basisEventId)));
    if (already[0]) return { outcome: "already_recorded" as const, accrualId: already[0].id, basis };

    // (3) Σ over EVERY row for this subject, escrowed ones included — see the O-7 note above.
    const sumRows = (await tx.execute(sql`
      select coalesce(sum(amount_paise), 0) as total from commission_accruals where subject_id = ${subjectId}
    `)).rows as { total: string | number }[];
    const priorPaise = Number(sumRows[0]!.total); // sum() over bigint arrives as numeric text
    const deltaPaise = basis.targetPaise - priorPaise;

    // (4) DD4's attempt path. Nothing is ever PAYABLE to an `external_rmp`: the composite FK plus
    //     `commission_accruals_payable_class_ck` refuse the row outright, so writing it would poison
    //     the consumer instead of recording a fact. The attempt becomes an EVENT, keyed on the basis
    //     event so a redelivery records one attempt rather than a stream of them.
    if (counterparty.payeeClass === "external_rmp") {
      if (deltaPaise !== 0) {
        await appendEvent(tx, payoutClassBlocked.make({
          actor: input.actor,
          occurredAt: input.occurredAt,
          causationId: input.basisEventId,
          idempotencyKey: `partners.payout_blocked:${input.basisEventId}:${subjectId}`,
          payload: {
            counterpartyId: counterparty.counterpartyId,
            payeeClass: "external_rmp",
            amountPaise: Math.abs(deltaPaise),
            reason: `commission accrual refused: ${DIRECTION_PAYABLE} to an external_rmp counterparty`,
          },
        }));
      }
      return { outcome: "payout_blocked" as const, payeeClass: counterparty.payeeClass, basis, priorPaise };
    }

    if (deltaPaise === 0) return { outcome: "no_delta" as const, basis, priorPaise };

    const state = counterparty.status === "suspended" ? "escrowed" : "accrued";
    const accrualId = newId();
    await tx.insert(commissionAccruals).values({
      id: accrualId,
      subjectId,
      counterpartyId: counterparty.counterpartyId,
      payeeClass: counterparty.payeeClass,
      agreementId: agreement.agreementId,
      direction: DIRECTION_PAYABLE,
      invoiceId: attribution.invoiceId,
      instrumentId: attribution.instrumentId,
      kind: deltaPaise < 0 ? "reversal" : "accrual",
      state,
      amountPaise: deltaPaise,
      rateSnapshot: { ...rateSnapshotOf(agreement, attribution.issuedAt), basis },
      basisEventId: input.basisEventId,
      basisEventName: input.basisEventName,
      occurredAt: input.occurredAt,
    });
    return { outcome: "appended" as const, accrualId, deltaPaise, state, basis, priorPaise };
  });
}

/**
 * The ledger, as a reader sees it. **`rateBps` and `agreementVersionNo` come off the ROW's own
 * snapshot, never off the agreement table** — that is DD6's whole point and Assertion Book F7's
 * first leg: after an amendment, what a past commission was worth is what the row says it was
 * worth, and re-reading the current version would rewrite history at report time.
 */
export type AccrualLedgerRow = {
  id: string;
  subjectId: string | null;
  counterpartyId: string;
  agreementId: string;
  invoiceId: string | null;
  instrumentId: string | null;
  kind: string;
  state: string;
  amountPaise: number;
  rateBps: number | null;
  agreementVersionNo: number | null;
  basisEventId: string | null;
  basisEventName: string | null;
  periodKey: string | null;
  occurredAt: Date;
  seq: number;
};

const snapshotNumber = (snapshot: unknown, key: string): number | null => {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

export async function accrualLedger(
  exec: Db | Tx,
  filter: { counterpartyId?: string; invoiceId?: string },
): Promise<AccrualLedgerRow[]> {
  const wheres = [];
  if (filter.counterpartyId !== undefined) wheres.push(eq(commissionAccruals.counterpartyId, filter.counterpartyId));
  if (filter.invoiceId !== undefined) wheres.push(eq(commissionAccruals.invoiceId, filter.invoiceId));
  const rows = await exec
    .select()
    .from(commissionAccruals)
    .where(wheres.length === 0 ? undefined : and(...wheres))
    .orderBy(asc(commissionAccruals.seq));
  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subjectId,
    counterpartyId: row.counterpartyId,
    agreementId: row.agreementId,
    invoiceId: row.invoiceId,
    instrumentId: row.instrumentId,
    kind: row.kind,
    state: row.state,
    amountPaise: row.amountPaise,
    rateBps: snapshotNumber(row.rateSnapshot, "payableRateBps"),
    agreementVersionNo: snapshotNumber(row.rateSnapshot, "versionNo"),
    basisEventId: row.basisEventId,
    basisEventName: row.basisEventName,
    periodKey: row.periodKey,
    occurredAt: row.occurredAt,
    seq: row.seq,
  }));
}

/**
 * O-7 — **no payable total includes an escrowed row.** The two totals are separate readers rather
 * than one reader with a flag, because "what we owe" and "what we have frozen" are answers to
 * different questions and a caller that conflates them is the bug this shape prevents.
 */
export async function payableTotalPaise(exec: Db | Tx, counterpartyId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    select coalesce(sum(amount_paise), 0) as total from commission_accruals
    where counterparty_id = ${counterpartyId} and direction = ${DIRECTION_PAYABLE} and state = 'accrued'
  `)).rows as { total: string | number }[];
  return Number(rows[0]!.total);
}

export async function escrowedTotalPaise(exec: Db | Tx, counterpartyId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    select coalesce(sum(amount_paise), 0) as total from commission_accruals
    where counterparty_id = ${counterpartyId} and direction = ${DIRECTION_PAYABLE} and state = 'escrowed'
  `)).rows as { total: string | number }[];
  return Number(rows[0]!.total);
}
