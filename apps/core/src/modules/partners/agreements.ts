import { and, desc, eq, isNull, lte, or, gt } from "drizzle-orm";
import { z } from "zod";
import { counterparties, partnerAgreements } from "../../kernel/db/schema";
import { PartnersError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD6 — VERSIONED, EFFECTIVE-DATED AGREEMENTS, AND THE INSTANT THE VERSION IS PINNED AT.
 *
 * The shape is `tariff_versions`' deliberately (schema/partners.ts's header says why), and this
 * file is the resolver: given a counterparty and an INSTANT, which version governed, and what did
 * its `terms` jsonb actually say.
 *
 * ═══ THE INSTANT IS THE INVOICE'S `issued_at`, NEVER THE PAYMENT'S ═══
 *
 * This is DD6's ruling and it is a consequence of DD12's rewrite rather than a free choice. Under
 * delta-to-target every event re-reads the WHOLE invoice and appends the difference; if a later
 * payment recomputed that whole invoice at a later rate, an amendment would retroactively rewrite
 * every earlier accrual for that invoice — which is exactly what DD6 exists to forbid. Pinning at
 * issue makes each invoice single-versioned: **the terms live when the hospital billed are the
 * terms that govern the commission on that bill.** `occurredAt` still orders the stream and still
 * drives the kicker's period; it no longer selects the rate. (Assertion Book F7, two legs.)
 *
 * ═══ `terms` IS DATA AND THIS FILE PARSES IT LOOSELY ON PURPOSE (DD3) ═══
 *
 * No rate, no category and no partner code appears in `apps/` — every one of them arrives at
 * commissioning as a row. The zod object below therefore describes only the keys the ACCRUAL lane
 * reads and, being a plain `z.object`, STRIPS the rest rather than refusing it: the receivable and
 * P&L lanes land in later tasks whose Files lists do not include this file, and a strict schema
 * here would make their terms unparseable in a file they may not edit. `rawTerms` is carried
 * beside the parsed value for exactly those readers.
 */

/** A commission rate is basis points of an eligible base: 0 … 10 000 bps (0 % … 100 %). */
const rateBps = z.number().int().nonnegative().max(10_000);

/**
 * O-6's volume kicker AS DATA. `periodKind` fixes the period the threshold is counted over, and a
 * tier pays a FLAT bonus for the period once its activation count is reached — the highest tier
 * whose `minActivations` is met wins, and tiers do not stack. The count is of ACTIVATED
 * instruments (`membership_instances.activated_at`), never of rows fed in by an import: that is
 * what makes book-stuffing before a threshold cut-off unprofitable by construction rather than by
 * detection (O-6, Assertion Book F10). `kicker.ts` owns the counting and the period arithmetic.
 */
const kickerTerms = z.object({
  periodKind: z.enum(["month", "quarter"]),
  tiers: z
    .array(z.object({ minActivations: z.number().int().positive(), bonusPaise: z.number().int().nonnegative() }))
    .default([]),
});

export const accrualTermsSchema = z.object({
  /** What the hospital OWES this counterparty, in bps of the eligible COLLECTED base (DD12). */
  payableRateBps: rateBps,
  /**
   * The `invoice_lines.category` values a commission is computed on. An empty list is a real,
   * expressible agreement — one that earns on nothing — and is NOT the same as an absent key, so
   * it is deliberately not defaulted: an agreement whose eligible set was never configured must
   * fail to parse rather than silently accrue on every line in the hospital.
   */
  eligibleCategories: z.array(z.string().min(1)),
  kicker: kickerTerms.nullable().default(null),
});

export type AccrualTerms = z.infer<typeof accrualTermsSchema>;

export type ResolvedAgreement = {
  agreementId: string;
  counterpartyId: string;
  versionNo: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  terms: AccrualTerms;
  /** The jsonb as stored, for the lanes this task does not own (receivables, P&L). */
  rawTerms: unknown;
};

/** What a counterparty is and where it stands — O-7's `status`, and DD4's frozen `payee_class`. */
export type CounterpartyFacts = {
  counterpartyId: string;
  payeeClass: string;
  status: string;
};

export async function counterpartyFacts(exec: Db | Tx, counterpartyId: string): Promise<CounterpartyFacts | null> {
  const rows = await exec
    .select({ id: counterparties.id, payeeClass: counterparties.payeeClass, status: counterparties.status })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  const row = rows[0];
  if (!row) return null;
  return { counterpartyId: row.id, payeeClass: row.payeeClass, status: row.status };
}

/**
 * The version that governed `at`, or `null`.
 *
 * `status = 'active'` only: a `draft` version has not been agreed and a `superseded` one has been
 * replaced, and neither may price a commission. The window is `[effective_from, effective_to)` —
 * half-open, so an amendment effective at instant X governs X itself and the version it replaces
 * governs everything strictly before it, with no instant belonging to two versions. Where two
 * ACTIVE rows still overlap (a data error the schema cannot forbid, since `partner_agreements`
 * carries no exclusion constraint), the HIGHEST `version_no` wins and the choice is deterministic
 * rather than arbitrary — a replay must reach the same answer as the live run did.
 */
export async function resolveAgreementAt(
  exec: Db | Tx,
  counterpartyId: string,
  at: Date,
): Promise<ResolvedAgreement | null> {
  const rows = await exec
    .select({
      id: partnerAgreements.id,
      counterpartyId: partnerAgreements.counterpartyId,
      versionNo: partnerAgreements.versionNo,
      effectiveFrom: partnerAgreements.effectiveFrom,
      effectiveTo: partnerAgreements.effectiveTo,
      terms: partnerAgreements.terms,
    })
    .from(partnerAgreements)
    .where(
      and(
        eq(partnerAgreements.counterpartyId, counterpartyId),
        eq(partnerAgreements.status, "active"),
        lte(partnerAgreements.effectiveFrom, at),
        or(isNull(partnerAgreements.effectiveTo), gt(partnerAgreements.effectiveTo, at)),
      ),
    )
    .orderBy(desc(partnerAgreements.versionNo))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const parsed = accrualTermsSchema.safeParse(row.terms);
  if (!parsed.success) {
    // A version whose terms this lane cannot read is a CONFIGURATION defect, and it is louder as
    // a refusal than as a silent zero: an agreement that accrued nothing because its jsonb was
    // misspelled is indistinguishable from one that earns nothing, and only one of those is a bug.
    throw new PartnersError(
      "unknown_agreement",
      `partner_agreements ${row.id} (v${String(row.versionNo)}) has terms this accrual lane cannot read`,
      parsed.error.issues,
    );
  }
  return {
    agreementId: row.id,
    counterpartyId: row.counterpartyId,
    versionNo: row.versionNo,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    terms: parsed.data,
    rawTerms: row.terms,
  };
}

/** `resolveAgreementAt` for the callers that cannot proceed without one. */
export async function requireAgreementAt(
  exec: Db | Tx,
  counterpartyId: string,
  at: Date,
): Promise<ResolvedAgreement> {
  const found = await resolveAgreementAt(exec, counterpartyId, at);
  if (found === null) {
    throw new PartnersError(
      "no_effective_agreement",
      `no active partner_agreements version for ${counterpartyId} at ${at.toISOString()}`,
      { counterpartyId, at: at.toISOString() },
    );
  }
  return found;
}

/**
 * DD6's SNAPSHOT — the resolved numbers, never a pointer. It is written onto every accrual row so
 * that an amendment cannot rewrite what a past commission was worth: the row carries the rate it
 * was computed at, the version that supplied it, and the INSTANT that version was pinned at, which
 * is the invoice's own `issued_at` and not the event's.
 */
export function rateSnapshotOf(agreement: ResolvedAgreement, pinnedAt: Date): {
  agreementId: string;
  versionNo: number;
  effectiveFrom: string;
  payableRateBps: number;
  eligibleCategories: string[];
  pinnedAt: string;
  pinnedTo: "invoice.issued_at";
} {
  return {
    agreementId: agreement.agreementId,
    versionNo: agreement.versionNo,
    effectiveFrom: agreement.effectiveFrom.toISOString(),
    payableRateBps: agreement.terms.payableRateBps,
    eligibleCategories: [...agreement.terms.eligibleCategories],
    pinnedAt: pinnedAt.toISOString(),
    pinnedTo: "invoice.issued_at",
  };
}
