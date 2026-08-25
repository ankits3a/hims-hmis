import { and, asc, eq, sql } from "drizzle-orm";
import { attributionIds, receivableExpectations } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * V2 / DD13 — THE AGING READ MODEL: what partners owe this hospital, and how long they have owed it.
 *
 * ═══ THE ONE PROPERTY THIS FILE EXISTS TO MAKE TRUE (V2) ═══
 *
 * **A hospital attribution that never appears in any statement AGES AND APPEARS HERE.** That is
 * the whole reason an expectation is created at referral time rather than when a statement arrives:
 * a reconciliation built only from statements can only ever check the partner's arithmetic against
 * itself, and the referral a partner simply never mentions is invisible to it for ever. Here it is
 * a row that gets older every day, moves through the buckets, and is written off (V5) only after
 * it has been visible for the whole configured window — DD13's "appears in the aging read model
 * before it does", implemented rather than promised.
 *
 * ═══ DD15 — NOTHING ON THIS SURFACE CARRIES PATIENT IDENTITY, BY CONSTRUCTION ═══
 *
 * Every field below is an instrument id, an attribution id, a code this hospital minted, a state,
 * a date or an amount. **`attribution_ids.patient_id` is deliberately not selected**, and neither
 * is any column of `patients` — no name, no UHID, no phone, no patient id. This is 11h's
 * sealed-patient lesson applied at design time instead of at review time: the cheapest way to keep
 * a partner-facing view identity-free is for the query behind it never to reach the identity, so
 * that a later screen cannot render what it was never handed. `aging.test.ts` walks the row SHAPE
 * against the patients table's own column list and refuses a match, with a negative control.
 *
 * ═══ THE CLAIM AND THE MONEY ARE READ FROM DIFFERENT TABLES, ON PURPOSE (DD5) ═══
 *
 * `outstandingPaise`, `disputedPaise` and `writtenOffPaise` come from `receivable_expectations` —
 * they are CLAIMS, and a claim's number is what the hospital says it is owed. `confirmedPaise`
 * comes from `commission_accruals` — it is MONEY, it is append-only, and a late correction has
 * already moved it by a signed row rather than by an edit. Reading the confirmed total off the
 * expectations instead would double-count the day a partner lists one referral twice, which is
 * exactly the shape V3's correction path produces.
 */

export const AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function bucketFor(ageDays: number): AgingBucket {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

/**
 * ONE OPEN CLAIM. Ids, a code, a state, two dates and an amount — see the DD15 note above for what
 * is NOT here and why the absence is structural rather than a habit.
 */
export type AgingItem = {
  expectationId: string;
  counterpartyId: string;
  attributionId: string | null;
  /** The code this hospital printed on the slip. Ours, never the partner's own reference space. */
  attributionCode: string | null;
  serviceHint: string | null;
  amountPaise: number;
  state: string;
  statementRef: string | null;
  statementPeriod: string | null;
  disputeReason: string | null;
  expectedAt: Date;
  dueAt: Date | null;
  ageDays: number;
  bucket: AgingBucket;
  /** Past its configured window and still unconfirmed — V5's sweep will write it off. */
  overdue: boolean;
};

export type AgingReport = {
  asOf: Date;
  buckets: { bucket: AgingBucket; count: number; amountPaise: number }[];
  totals: {
    /** Claims still waiting for a statement — `state = 'expected'`. */
    outstandingPaise: number;
    /** Claims a statement contradicted — `state = 'disputed'`, V1/V6/amount mismatch. */
    disputedPaise: number;
    /** Claims abandoned — V4's voids and V5's expiries. */
    writtenOffPaise: number;
    /** MONEY, from the append-only ledger: what statements actually confirmed, corrections included. */
    confirmedPaise: number;
    outstandingCount: number;
    disputedCount: number;
  };
  /** The worklist: everything still open or contested, oldest first. */
  items: AgingItem[];
};

/**
 * `asOf` is the CALLER's instant, never `new Date()` inside the reader, so a report run twice for
 * one moment answers twice the same — the same discipline every writer in this module keeps, for
 * the same reason.
 */
export async function agingReport(
  exec: Db | Tx,
  input: { counterpartyId?: string; asOf: Date },
): Promise<AgingReport> {
  const wheres = [];
  if (input.counterpartyId !== undefined) {
    wheres.push(eq(receivableExpectations.counterpartyId, input.counterpartyId));
  }

  const rows = await exec
    .select({
      id: receivableExpectations.id,
      counterpartyId: receivableExpectations.counterpartyId,
      attributionId: receivableExpectations.attributionId,
      amountPaise: receivableExpectations.amountPaise,
      state: receivableExpectations.state,
      statementRef: receivableExpectations.statementRef,
      statementPeriod: receivableExpectations.statementPeriod,
      disputeReason: receivableExpectations.disputeReason,
      expectedAt: receivableExpectations.expectedAt,
      dueAt: receivableExpectations.dueAt,
      // The attribution's own two reportable columns. `attributionIds.patientId` is in this table
      // and is NOT selected — DD15, and the omission is the point (see the header).
      attributionCode: attributionIds.code,
      serviceHint: attributionIds.serviceHint,
    })
    .from(receivableExpectations)
    .leftJoin(attributionIds, eq(receivableExpectations.attributionId, attributionIds.id))
    .where(wheres.length === 0 ? undefined : and(...wheres))
    .orderBy(asc(receivableExpectations.expectedAt), asc(receivableExpectations.seq));

  const items: AgingItem[] = [];
  const bucketTotals = new Map<AgingBucket, { count: number; amountPaise: number }>(
    AGING_BUCKETS.map((b) => [b, { count: 0, amountPaise: 0 }]),
  );
  let outstandingPaise = 0;
  let disputedPaise = 0;
  let writtenOffPaise = 0;
  let outstandingCount = 0;
  let disputedCount = 0;

  for (const row of rows) {
    if (row.state === "expected") { outstandingPaise += row.amountPaise; outstandingCount += 1; }
    else if (row.state === "disputed") { disputedPaise += row.amountPaise; disputedCount += 1; }
    else if (row.state === "written_off") { writtenOffPaise += row.amountPaise; }

    if (row.state !== "expected" && row.state !== "disputed") continue;

    // Whole days since the claim was raised. `Math.floor` rather than a round: a claim is not a
    // day old until it has been a day.
    const ageDays = Math.max(Math.floor((input.asOf.getTime() - row.expectedAt.getTime()) / DAY_MS), 0);
    const bucket = bucketFor(ageDays);
    if (row.state === "expected") {
      const tally = bucketTotals.get(bucket)!;
      tally.count += 1;
      tally.amountPaise += row.amountPaise;
    }
    items.push({
      expectationId: row.id,
      counterpartyId: row.counterpartyId,
      attributionId: row.attributionId,
      attributionCode: row.attributionCode,
      serviceHint: row.serviceHint,
      amountPaise: row.amountPaise,
      state: row.state,
      statementRef: row.statementRef,
      statementPeriod: row.statementPeriod,
      disputeReason: row.disputeReason,
      expectedAt: row.expectedAt,
      dueAt: row.dueAt,
      ageDays,
      bucket,
      overdue: row.state === "expected" && row.dueAt !== null && row.dueAt.getTime() < input.asOf.getTime(),
    });
  }

  // MONEY, from the append-only ledger — never from the claims above. See the header's third note.
  const confirmedRows = (await exec.execute(
    input.counterpartyId === undefined
      ? sql`select coalesce(sum(amount_paise), 0) as total from commission_accruals where direction = 'receivable'`
      : sql`select coalesce(sum(amount_paise), 0) as total from commission_accruals
            where direction = 'receivable' and counterparty_id = ${input.counterpartyId}`,
  )).rows as { total: string | number }[];

  return {
    asOf: input.asOf,
    buckets: AGING_BUCKETS.map((bucket) => ({ bucket, ...bucketTotals.get(bucket)! })),
    totals: {
      outstandingPaise, disputedPaise, writtenOffPaise,
      confirmedPaise: Number(confirmedRows[0]!.total),
      outstandingCount, disputedCount,
    },
    items,
  };
}

/** Σ of the append-only receivable ledger for one partner — what its statements actually confirmed. */
export async function receivableTotalPaise(exec: Db | Tx, counterpartyId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    select coalesce(sum(amount_paise), 0) as total from commission_accruals
    where counterparty_id = ${counterpartyId} and direction = 'receivable'
  `)).rows as { total: string | number }[];
  return Number(rows[0]!.total);
}
