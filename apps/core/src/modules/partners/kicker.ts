import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { commissionAccruals, receivableExpectations } from "../../kernel/db/schema";
import { rateSnapshotOf, requireAgreementAt } from "./agreements";
import { PartnersError } from "./errors";
import type { AccrualTerms, CounterpartyFacts } from "./agreements";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * O-6 — THE VOLUME KICKER, KEYED ON THE ACTIVATION INSTANT, RECOMPUTED AS AN APPEND-ONLY
 * ADJUSTMENT, AND CLOSED ONCE ITS PERIOD HAS BEEN SETTLED.
 *
 * ═══ ACTIVATED, NEVER FED (Assertion Book F10) ═══
 *
 * The count is of `membership_instances.activated_at` falling inside the period — never of rows a
 * partner's drop happened to feed us during it. That is what makes book-stuffing before a
 * threshold cut-off unprofitable BY CONSTRUCTION rather than by detection: a backdated drop
 * landing in October, for cards activated in September, adds nothing to October's count, and
 * September's count is what it always was. Counting fed rows would pay a bonus for the act of
 * uploading a file.
 *
 * C-17 applies here exactly as it applies to an invoice accrual: an UNVERIFIED instance accrues
 * nothing, so it is not counted either. A grace-honored card the book has never confirmed cannot
 * push a partner over a threshold.
 *
 * ═══ RECOMPUTE IS A ROW, AND A SETTLED PERIOD IS CLOSED ═══
 *
 * DD5: the ledger is append-only, so a recompute is a NEW adjustment row naming the period it
 * corrects — never an edit of the earlier one. Retroactivity is real (an agreement may apply a
 * threshold to a whole period), which is why recompute exists at all; a period whose partner
 * statement has been SETTLED is closed to it, and re-opening one is an owner action this phase
 * does not build.
 *
 * **WHAT "SETTLED" READS, and its one limitation, stated rather than implied.** The only statement
 * this phase has a table for is the RECEIVABLE one: T7's import lands one `receivable_expectations`
 * row per statement line, carrying `statement_period` (the plan budgets seventeen tables and there
 * is no partner-statement header table — the phase relay records that ruling). A period is
 * therefore closed once any line of that counterparty's statement for it has reached `matched`.
 * When a payable-statement lane exists, this predicate is the one line to widen.
 *
 * ═══ THE PERIOD IS AN IST CONCEPT ═══
 *
 * A quarter of a hospital's trading year is a calendar fact in India, not a UTC one, and a period
 * boundary read in UTC is 5½ hours wrong twice per period. The offset below is a FOURTH copy of a
 * constant `modules/opd/time.ts`, `modules/billing/time.ts` and `modules/membership/coupon-rules.ts`
 * each already carry — deliberately, and not by oversight: those three export a DAY index and a
 * minute-of-day, and none of them exports a month or quarter boundary, so there is nothing here to
 * import. Reaching into `modules/membership` for it would also open a `partners → membership`
 * module edge that DD1 does not authorise (the direction it fixes is `partners → billing`).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type PeriodKind = "month" | "quarter";

/** `2026-M08` / `2026-Q3` — sortable, unambiguous, and readable in a statement covering note. */
export function periodKeyFor(kind: PeriodKind, at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0-based
  return kind === "month"
    ? `${String(year)}-M${String(month + 1).padStart(2, "0")}`
    : `${String(year)}-Q${String(Math.floor(month / 3) + 1)}`;
}

/** The half-open instant range `[start, end)` an IST period key names. */
export function periodBounds(periodKey: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(M(\d{2})|Q([1-4]))$/.exec(periodKey);
  // A plain Error, deliberately: `PartnersErrorCode` is CLOSED for this phase and carries no code
  // for "the caller passed nonsense". Borrowing a neighbouring code to look tidy would put a
  // programming mistake into the same bucket as a refusal an operator can act on.
  if (match === null) throw new Error(`unreadable period key ${periodKey} (expected YYYY-Mnn or YYYY-Qn)`);
  const year = Number(match[1]);
  const monthIndex = match[3] !== undefined ? Number(match[3]) - 1 : (Number(match[4]) - 1) * 3;
  const months = match[3] !== undefined ? 1 : 3;
  const startUtc = Date.UTC(year, monthIndex, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  const endUtc = Date.UTC(year, monthIndex + months, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  return { start: new Date(startUtc), end: new Date(endUtc) };
}

/** O-6 — activated inside the period, verified, and this counterparty's. */
export async function countActivations(
  exec: Db | Tx,
  counterpartyId: string,
  bounds: { start: Date; end: Date },
): Promise<number> {
  const rows = (await exec.execute(sql`
    select count(*)::int as n from membership_instances
    where counterparty_id = ${counterpartyId}
      and verified = true
      and activated_at is not null
      and activated_at >= ${bounds.start.toISOString()}::timestamptz
      and activated_at <  ${bounds.end.toISOString()}::timestamptz
  `)).rows as { n: number }[];
  return rows[0]!.n;
}

/** See the header: the RECEIVABLE statement is the only settled-period signal this phase ships. */
export async function periodSettled(exec: Db | Tx, counterpartyId: string, periodKey: string): Promise<boolean> {
  const rows = await exec
    .select({ id: receivableExpectations.id })
    .from(receivableExpectations)
    .where(
      and(
        eq(receivableExpectations.counterpartyId, counterpartyId),
        eq(receivableExpectations.statementPeriod, periodKey),
        eq(receivableExpectations.state, "matched"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Tiers do not stack: the highest one whose threshold is met is what the period earns. */
export function kickerBonusPaise(kicker: AccrualTerms["kicker"], activations: number): number {
  if (kicker === null) return 0;
  let earned = 0;
  for (const tier of kicker.tiers) {
    if (activations >= tier.minActivations && tier.bonusPaise > earned) earned = tier.bonusPaise;
  }
  return earned;
}

export type KickerRecomputeInput = {
  actor: Actor;
  counterparty: CounterpartyFacts;
  periodKey: string;
  /** The instant the recompute is FOR — stamped on the row, never `new Date()` inside a writer. */
  occurredAt: Date;
};

export type KickerRecomputeResult =
  | { outcome: "appended"; accrualId: string; activations: number; earnedPaise: number; deltaPaise: number; state: "accrued" | "escrowed" }
  | { outcome: "no_delta"; activations: number; earnedPaise: number; priorPaise: number }
  | { outcome: "no_kicker"; activations: number };

/**
 * Recompute one counterparty's kicker for one period.
 *
 * The agreement is resolved at the period's LAST instant, not at `occurredAt` and not at the
 * period's start: the unit being priced is the PERIOD, and the terms in force when it closed are
 * the terms under which its volume was agreed. That is the same pinning discipline DD6 applies to
 * an invoice, applied to the only other unit this ledger prices.
 *
 * `subject_id` and `basis_event_id` are NULL — Postgres treats NULLs as distinct, so
 * `commission_accruals_basis_event_ux` does not constrain adjustment rows and cannot. What makes a
 * recompute idempotent instead is the arithmetic: it appends the DIFFERENCE between what the
 * period has earned and what has already been paid for it, so running it twice in a row appends
 * nothing the second time.
 */
export async function recomputeKicker(db: Db, input: KickerRecomputeInput): Promise<KickerRecomputeResult> {
  const { counterparty, periodKey } = input;
  const bounds = periodBounds(periodKey);
  if (await periodSettled(db, counterparty.counterpartyId, periodKey)) {
    throw new PartnersError(
      "period_closed",
      `period ${periodKey} has a settled statement for ${counterparty.counterpartyId}; re-opening it is an owner action`,
      { counterpartyId: counterparty.counterpartyId, periodKey },
    );
  }
  const agreement = await requireAgreementAt(db, counterparty.counterpartyId, new Date(bounds.end.getTime() - 1));
  const activations = await countActivations(db, counterparty.counterpartyId, bounds);
  if (agreement.terms.kicker === null) return { outcome: "no_kicker", activations };
  const earnedPaise = kickerBonusPaise(agreement.terms.kicker, activations);

  return withTx(db, async (tx) => {
    // THE SERIALIZER, and the mode is the point (the phase relay's measured lesson, applied).
    // `SELECT sum(…) … FOR UPDATE` is not even legal Postgres — a locking clause cannot ride an
    // aggregate — so the row that is locked is the COUNTERPARTY's, in `FOR NO KEY UPDATE`: the
    // weakest mode that still conflicts with a second recompute and does NOT conflict with the
    // `FOR KEY SHARE` every `commission_accruals` insert takes on this same row through DD4's
    // composite foreign key. Under `FOR UPDATE` a recompute would stall every invoice accrual for
    // that partner while it ran.
    await tx.execute(sql`select id from counterparties where id = ${counterparty.counterpartyId} for no key update`);
    const priorRows = (await tx.execute(sql`
      select coalesce(sum(amount_paise), 0) as total from commission_accruals
      where counterparty_id = ${counterparty.counterpartyId}
        and period_key = ${periodKey}
        and kind = 'kicker'
    `)).rows as { total: string | number }[];
    const priorPaise = Number(priorRows[0]!.total);
    const deltaPaise = earnedPaise - priorPaise;
    if (deltaPaise === 0) return { outcome: "no_delta" as const, activations, earnedPaise, priorPaise };

    const state = counterparty.status === "suspended" ? "escrowed" : "accrued";
    const accrualId = newId();
    await tx.insert(commissionAccruals).values({
      id: accrualId,
      subjectId: null,
      counterpartyId: counterparty.counterpartyId,
      payeeClass: counterparty.payeeClass,
      agreementId: agreement.agreementId,
      direction: "payable",
      invoiceId: null,
      kind: "kicker",
      state,
      amountPaise: deltaPaise,
      rateSnapshot: {
        ...rateSnapshotOf(agreement, new Date(bounds.end.getTime() - 1)),
        kicker: agreement.terms.kicker,
        activations,
        earnedPaise,
        priorPaise,
      },
      basisEventId: null,
      basisEventName: null,
      periodKey,
      occurredAt: input.occurredAt,
    });
    return { outcome: "appended" as const, accrualId, activations, earnedPaise, deltaPaise, state };
  });
}
