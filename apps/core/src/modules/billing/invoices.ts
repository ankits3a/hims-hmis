import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  allocations, creditNotes, enteredInErrorMarks, invoiceLines, invoices, receipts, receiptTenders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { loadEnv } from "../../kernel/config";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { getApproval } from "../../kernel/approvals/worklist";
import { getEncounter } from "../opd";
import { resolveEncounterByPrefix } from "../../kernel/episodes/encounter-resolvers";
import {
  consumeEntitlements, counterForWinner, couponRedemptionStates, couponSource, COUPON_SOURCE_KEY,
  entitlementCountersOf, membershipSource, MEMBERSHIP_SOURCE_KEY, narrowToRedeemableCoupons,
  narrowToUsableEntitlements, redeemCoupons, resolveInstruments,
} from "../membership";
import { assertPaise, loadPricingContext, percentAmount, priceInvoiceLines } from "../tariff";
import { allocateOnTx } from "./receipts";
import { emitFeeSettled } from "./settle-hooks";
import { resolveRegisteredSources } from "./benefit-sources";
import { assertCashAccepted } from "./cash-law";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { nextDocNo } from "./series";
import { requireOpenSession } from "./sessions";
import { settlementState } from "./settlement";
import { istDay } from "./time";
import { totalInvoice } from "./totals";
import {
  advanceReceived, cashThresholdBlocked, cashThresholdWarned, invoiceCreditExtended, invoiceIssued,
  paymentReceived, receiptRecorded,
} from "./events";
import type { CashLawVerdict, CashThresholdDetail, TenderInput, TenderMode } from "./cash-law";
import type { BillingConfig, FeeBps } from "./config";
import type { Settlement } from "./settlement";
import type { InvoiceTotals } from "./totals";
import type { EntitlementCounterState, EntitlementConsume, ResolvedInstruments } from "../membership";
import type { CouponRedemptionRequest } from "../membership";
import type { InvoiceLineInput, PricedLine } from "../tariff";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D2 — `issueInvoice`, the module's core transaction, plus the invoice-side settlement
 * readers and the invoice read surface.
 *
 * PLAN DEVIATION, DISCLOSED (T5 report): the plan's Files list put `outstandingOf` and
 * `invoiceSettlement` in `settlement.ts`, but `settlement.ts` is one of the five files
 * `billing-purity.test.ts` (T2, and outside this task's Files list) sweeps for `from "../../kernel`
 * and `await ` — a SQL reader cannot live there without either breaking that shipped test or
 * silently relaxing it. The pure state function stays where T2 put it; the readers that feed it
 * live here, beside the writer whose rows they read. Reported as a plan defect rather than
 * resolved by editing a file this task does not own.
 */

/** The permission the credit lane needs (owner ruling 2). T11's manifest declares it. */
export const CREDIT_EXTEND_PERMISSION = "billing.credit.extend";

/** The two approval types this transaction checks on execute, and the subjects they bind to. */
export const CREDIT_APPROVAL_TYPE = "billing_credit_extension";
export const CREDIT_APPROVAL_SUBJECT = "billing_credit";
export const DISCOUNT_APPROVAL_TYPE = "billing_discount";
export const DISCOUNT_APPROVAL_SUBJECT = "billing_discount";

/**
 * A discount approval is filed BEFORE the invoice exists, so it cannot name the invoice id. It
 * binds to the client-supplied draft id plus the line it pays for — the pair the counter screen
 * already holds while the bill is being built.
 */
export function discountSubjectId(draftId: string, lineId: string): string {
  return `${draftId}:${lineId}`;
}

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;

export type IssueInvoiceInput = {
  draftId: string; // client-supplied; the subject id every pre-invoice approval binds to
  patientId: string;
  encounterId?: string;
  buyerGstin?: string; // ruling 4 — the whole Phase-1 B2B provision
  buyerLegalName?: string;
  lines: InvoiceLineInput[];
  tags?: string[]; // request-level pricing eligibility tags
  receipt?: {
    tenders: TenderInput[]; panNumber?: string; form60?: boolean; note?: string;
    /**
     * PLAN 07b T5 — how much of the surplus was HANDED BACK as change, declared by the cashier.
     *
     * The surplus itself has always been computed (`unallocatedPaise`) and shown at the counter
     * under "Change due / banked as advance" — two outcomes, one record. Whichever the cashier
     * did, the ledger wrote an unallocated receipt balance, which IS a patient advance; so when
     * the money was handed over, that advance was fictional and the drawer was short by the same
     * amount at close, with nothing to explain the variance. Declaring it is what separates the
     * two lanes, and `expectedCash` subtracts it.
     */
    changeGivenPaise?: number;
  };
  credit?: { reason: string; approvalId?: string };
  discountApprovals?: Record<string, string>; // lineId -> approvalId, for `requiresApproval` winners
  /**
   * PLAN 15 T7 / DD12 — **SETTLE FROM MONEY THE HOSPITAL ALREADY HOLDS.**
   *
   * Until this field, an invoice could be settled ONLY by tenders taken in the same call: D2 step 3
   * refuses to persist a remainder without a credit extension, and `allocateReceipt` cannot run
   * before the invoice exists. **That left no path at all for a deposit-then-discharge flow** — the
   * shape Plan 15's whole money design is built on, where the patient paid at booking and the bill
   * is composed at discharge days later. Recorded as finding T7-a rather than worked around.
   *
   * Each entry is allocated INSIDE this transaction through `allocateOnTx`, so the invoice is never
   * momentarily unsettled and D2 step 3's invariant is untouched. Every guard `allocateReceipt`
   * applies applies here — the receipt must belong to the invoice's patient, must not be
   * entered-in-error, must have room, and must not drive the patient's advance negative.
   */
  settleFromReceipts?: { receiptId: string; amountPaise: number }[];
  /**
   * PLAN 09 / DD2 — coupon codes physically handed across the counter (a card's own bundled
   * coupons need none: `resolveInstruments` finds those from the patient's instruments).
   *
   * NO HTTP CALLER CAN SET THIS YET, and that is a gap this task reports rather than closes:
   * `billing.controller.ts`'s `issueInvoiceBody` has no such field and that file is in NO task's
   * Files list for this phase. Bundled coupons therefore reach the money path and presented ones
   * do not, until a later phase widens the body. It is typed here because this is the seam the
   * composer reads and because the coupon lane is otherwise untestable.
   */
  couponCodes?: string[];
  /**
   * RC-2 T2 / D3 — the code printed on a partner's referral slip, as the counter presented it.
   * Resolved to a counterparty by the registered provider; NEVER inferred from
   * `opd_encounters.referral_source`, which `openLabWalkinInTx` defaults to `external_rmp` on
   * every direct lab walk-in that named no referrer (spike S3).
   */
  attributionCode?: string;
};

export type IssueInvoiceResult = {
  invoiceId: string;
  invoiceNo: string;
  totals: InvoiceTotals;
  receiptId: string | null;
  receiptNo: string | null;
  allocatedPaise: number;
  /** PLAN 15 T7 — what `settleFromReceipts` cleared, reported separately from the tender lane. */
  settledFromHeldPaise: number;
  unallocatedPaise: number; // the change-due / banked-advance lane (D2 step 5) — never an error
  creditExtended: boolean;
  settlement: Settlement;
  warnings: string[];
};

export type PreviewInvoiceInput = {
  encounterId?: string;
  lines: InvoiceLineInput[];
  tags?: string[];
  /**
   * PLAN 09 — the subject a member benefit is resolved for. A preview that could not compose the
   * benefit would QUOTE a different number from the one the invoice charges, and a counter that
   * quotes high and bills low teaches its clerks not to trust the quote. When it is absent the
   * encounter's own patient is used (`resolveEncounter` already reads that row); when there is
   * neither, nothing is composed, because there is no member to resolve.
   */
  patientId?: string;
  couponCodes?: string[];
  /**
   * RC-2 T2 / D3 — the code printed on a partner's referral slip, as the counter presented it.
   * Resolved to a counterparty by the registered provider; NEVER inferred from
   * `opd_encounters.referral_source`, which `openLabWalkinInTx` defaults to `external_rmp` on
   * every direct lab walk-in that named no referrer (spike S3).
   */
  attributionCode?: string;
};
export type PricedDraft = {
  tariffVersionId: string;
  intendedPayer: string;
  lines: PricedLine[];
  totals: InvoiceTotals;
};

// ---------------------------------------------------------------------------------------------
// Settlement readers (D1). Settlement is DERIVED — no status column exists on `invoices`, which
// is what keeps the immutability triggers total.
// ---------------------------------------------------------------------------------------------

/**
 * Which of these documents carry an `entered-in-error` mark. Read as a set rather than as a
 * correlated NOT EXISTS: drizzle renders a column interpolated into a `sql` SELECT FIELD without
 * its table qualifier, so a correlated subquery written that way silently compares the wrong two
 * columns and returns zero — measured, not assumed. Every aggregate below therefore reads ONE
 * table at a time, where the unqualified name is unambiguous.
 */
async function enteredInErrorDocIds(exec: Db | Tx, docType: string, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await exec
    .select({ docId: enteredInErrorMarks.docId })
    .from(enteredInErrorMarks)
    .where(and(eq(enteredInErrorMarks.docType, docType), inArray(enteredInErrorMarks.docId, docIds)));
  return new Set(rows.map((r) => r.docId));
}

/** Effective allocation against one invoice: Sigma apply - Sigma reverse. Append-only (D1). */
async function allocatedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(eq(allocations.invoiceId, invoiceId));
  return Number(rows[0]!.total); // sum() over bigint arrives as numeric text
}

/** Sigma non-EIE credit-note nets against one invoice (D1). Nothing credits until T7 ships. */
async function creditedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({ id: creditNotes.id, netPaise: creditNotes.netPaise })
    .from(creditNotes)
    .where(eq(creditNotes.invoiceId, invoiceId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "credit_note", rows.map((r) => r.id));
  let total = 0;
  for (const row of rows) {
    if (!dead.has(row.id)) total += row.netPaise;
  }
  return total;
}

/** The invoice's derived settlement — `settlementState` fed from the ledger (D1). */
export async function invoiceSettlement(exec: Db | Tx, invoiceId: string): Promise<Settlement> {
  const rows = await exec
    .select({ netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  const creditedPaise = await creditedPaiseOf(exec, invoiceId);
  const allocatedPaise = await allocatedPaiseOf(exec, invoiceId);
  return settlementState(row.netPayablePaise, creditedPaise, allocatedPaise);
}

/** The invoice's outstanding paise, floored at zero (D1). */
export async function outstandingOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const settlement = await invoiceSettlement(exec, invoiceId);
  return settlement.outstandingPaise;
}

/**
 * The patient's total receivable across every non-EIE invoice — the number the per-patient
 * outstanding cap (owner ruling 2) is compared against. Each invoice's own outstanding is floored
 * at zero first, so one over-collected bill can never mask another bill's dues.
 */
export async function patientOutstandingPaise(exec: Db | Tx, patientId: string): Promise<number> {
  const rows = await exec
    .select({ id: invoices.id, netPayablePaise: invoices.netPayablePaise })
    .from(invoices)
    .where(eq(invoices.patientId, patientId));
  if (rows.length === 0) return 0;
  const dead = await enteredInErrorDocIds(exec, "invoice", rows.map((r) => r.id));
  let total = 0;
  for (const row of rows) {
    if (dead.has(row.id)) continue;
    const creditedPaise = await creditedPaiseOf(exec, row.id);
    const allocatedPaise = await allocatedPaiseOf(exec, row.id);
    total += settlementState(row.netPayablePaise, creditedPaise, allocatedPaise).outstandingPaise;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function getInvoice(
  exec: Db | Tx,
  invoiceId: string,
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const rows = await exec.select().from(invoices).where(eq(invoices.id, invoiceId));
  const invoice = rows[0];
  if (!invoice) return null;
  const lines = await exec
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNo));
  return { invoice, lines };
}

/** Arrival order is `seq`, never the id — ULIDs are not insertion-ordered (§3.26). */
export async function listInvoices(
  exec: Db | Tx,
  filters: { patientId?: string; encounterId?: string } = {},
): Promise<InvoiceRow[]> {
  const conditions = [];
  if (filters.patientId !== undefined) conditions.push(eq(invoices.patientId, filters.patientId));
  if (filters.encounterId !== undefined) conditions.push(eq(invoices.encounterId, filters.encounterId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return exec.select().from(invoices).where(where).orderBy(asc(invoices.seq));
}

// ---------------------------------------------------------------------------------------------
// D2 step 1 — everything before the transaction: resolve, load, belt, price. PURE after the load.
// ---------------------------------------------------------------------------------------------

/**
 * ═══ PLAN 15 T7 / DD11-F2 — THE ENCOUNTER RESOLVER REGISTRY, NOW IN THE KERNEL ═══
 *
 * **Before it, `issueInvoice` could bill an OPD encounter and nothing else.** `resolveEncounter`
 * called `getEncounter` — OPD's reader over `opd_encounters` — and threw `unknown_encounter` for
 * anything it did not find, so every discharge bill the mini-OT composed for a `D…` encounter would
 * have been refused. That is the adversarial pass's finding F2, and the registry is the seam that
 * closed it.
 *
 * **PLAN 17 PHASE 0 T3 MOVED THE REGISTRY TO `kernel/episodes/encounter-resolvers.ts`**, because
 * the order envelope is its second consumer and a kernel seam cannot import a module. The three
 * names below are RE-EXPORTED from here unchanged, so `modules/billing`'s public surface is exactly
 * what it was and no importer outside this module changed. What did NOT move is
 * `resolveEncounter` itself: it falls back to OPD's reader for any id matching no registered
 * prefix, and carrying that into the kernel would have inverted the dependency this registry
 * exists to invert. See that file's header for the full reasoning.
 */
export type { EncounterResolver } from "../../kernel/episodes/encounter-resolvers";
export { registerEncounterResolver, registeredEncounterPrefixes } from "../../kernel/episodes/encounter-resolvers";

async function resolveEncounter(
  db: Db,
  encounterId: string | undefined,
): Promise<{ intendedPayer: string; patientId: string | null }> {
  if (encounterId === undefined) return { intendedPayer: "self", patientId: null };

  /**
   * The longest-prefix-first match now lives in the kernel (T3). What billing still owns is the
   * two answers it gives to the two outcomes: a prefix that matched and resolved to nothing is a
   * refusal, because the module owning that letter has spoken; a string no prefix matched falls
   * through to the OPD reader below.
   */
  const byPrefix = await resolveEncounterByPrefix(db, encounterId);
  if (byPrefix.matched) {
    if (!byPrefix.resolved) throw new BillingError("unknown_encounter", `unknown encounter ${encounterId}`);
    return { intendedPayer: byPrefix.resolved.intendedPayer, patientId: byPrefix.resolved.patientId };
  }

  /**
   * NO REGISTERED PREFIX MATCHED — fall back to OPD's reader.
   *
   * This is deliberate rather than lazy, and it is what keeps this change additive: every shipped
   * caller passes an `opd_encounters` id, several tests pass ids that are not episode numbers at
   * all, and `previewInvoice` is reachable with a bare id from the counter screen. Making the
   * registry mandatory would turn a seam into a breaking change. An id that matches no prefix AND
   * no OPD row still throws `unknown_encounter`, exactly as before (A32's third leg).
   */
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new BillingError("unknown_encounter", `unknown encounter ${encounterId}`);
  return { intendedPayer: encounter.intendedPayer, patientId: encounter.patientId };
}

/**
 * M3 at OUR boundary. The tariff stress test warned that `priceInvoiceLines` is reachable by a
 * non-controller caller with unparsed money, and this plan is exactly that caller: every
 * externally supplied amount is integer-checked HERE, before the engine ever runs, so a
 * fractional discount ask is refused as `invalid_paise` rather than pricing something first and
 * failing somewhere deeper.
 */
function assertBoundaryPaise(
  draft: { lines: InvoiceLineInput[]; receipt?: { tenders: TenderInput[]; changeGivenPaise?: number } },
): void {
  for (const line of draft.lines) {
    const manual = line.manualDiscount;
    if (manual !== undefined && manual !== null) {
      assertPaise(manual.value, `line ${line.lineId} manual discount value`);
    }
  }
  for (const tender of draft.receipt?.tenders ?? []) {
    assertPaise(tender.amountPaise, `${tender.mode} tender amount`);
  }
  if (draft.receipt?.changeGivenPaise !== undefined) {
    assertPaise(draft.receipt.changeGivenPaise, "change given");
  }
}

// ---------------------------------------------------------------------------------------------
// PLAN 09 / DD2 — the member-benefit composition, behind MEMBER_BENEFITS_ENABLED
// ---------------------------------------------------------------------------------------------

/**
 * DD14's flag, read HERE — and NOT through `loadConfig()`. The reason is F1's scar and it is
 * measured rather than argued.
 *
 * `loadConfig()` parses the WHOLE environment through a zod schema in which `DATABASE_URL` and
 * `SECRET_KEY` are REQUIRED with no default. `apps/core/.env` exists on the build host and can
 * NEVER exist in CI, where the workflow sets `TEST_DATABASE_URL` and nothing else — so a
 * `loadConfig()` on this code path would resolve on exactly one machine in the world and throw on
 * the machine that decides. `kernel/worker/jobs.ts` carries the same lesson in its own header
 * ("THIS FUNCTION READS NO ENVIRONMENT... the caller resolves config"), and its remedy — have the
 * caller hand the value down — is not available here: the caller is `billing.controller.ts`, which
 * is in no task's Files list for this phase and cannot be widened to pass one.
 *
 * So this reads the ONE key, with `z.enum(["true","false"])` and never a coercing boolean helper —
 * under coercion the string "false" is non-empty and therefore TRUE, which would arm member
 * benefits for an operator who wrote the value that means off. (The helper is not NAMED here on
 * purpose: `billing-purity.test.ts` sweeps every file in this directory for that token, and S12
 * binds this task's diff.) That spelling is `kernel/config.ts`'s, deliberately duplicated rather
 * than approximated, and `entitlements.test.ts` pins the two readers against each other BY
 * EXECUTION on all six inputs — "true", "false", absent, "1", "TRUE" and "" — so the duplicate
 * cannot drift into a disagreement.
 *
 * `loadEnv()` is idempotent and is what makes an operator's `.env` flip visible to a process that
 * has not otherwise parsed config; `process.env` always wins over the file (CI stays authoritative).
 */
const memberBenefitsFlag = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export function memberBenefitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) loadEnv();
  return memberBenefitsFlag.parse(env.MEMBER_BENEFITS_ENABLED);
}

/**
 * Everything the money path resolved about this person's instruments, kept beside the priced draft
 * so the WRITE half (below, inside the transaction) can attribute each winning candidate to the
 * counter or coupon it came from. `null` whenever the flag is off or there is no subject.
 */
type BenefitContext = {
  resolved: ResolvedInstruments;
  counters: EntitlementCounterState[];
};

/**
 * DD2's composition, and it is four lines of it.
 *
 *     const base = await loadPricingContext(db, { at: now, tags });
 *     const ctx  = { ...base, sources: [...base.sources, membershipSource(r), couponSource(r)] };
 *
 * `modules/tariff` is byte-untouched: `propose` stays pure and synchronous because the lookup
 * happens HERE, once, before the transaction, in exactly the place `loadPricingContext` already
 * runs. The order `[rule, manual, membership, coupon]` is a RULING and not an accident — the
 * contest sorts by amount first and the array position decides EXACT ties only, where a standing
 * hospital rule should beat a commercial instrument and a paid durable membership should beat a
 * one-shot coupon. That is explainable to a member across a counter, which is the test a tie-break
 * rule has to pass.
 *
 * ═══ TWO PASSES, AND THE SECOND IS THE CHEAP ONE (relay note 12) ═══
 *
 * `ResolvedInstruments.billGrossPaise` is REQUIRED and carries K4's minimum-BILL threshold, which
 * cannot be evaluated inside `propose`: that signature sees one line at a time and `PricingContext`
 * has no notion of an invoice total. So the draft is priced ONCE on the base context purely to sum
 * `grossPaise`, and that sum is spread over the resolved value before the sources are built.
 * `priceInvoiceLines` is pure and synchronous — the first pass is arithmetic, not I/O.
 *
 * ═══ WHAT IS NARROWED BEFORE PRICING, AND WHY IT IS NOT A REFUSAL ═══
 *
 * An exhausted or lapsed entitlement counter, and a single-use coupon already spent, are dropped
 * from the resolved value rather than refused at commit. A member who has used their four free
 * consults is simply billed in full; if the refusal lived only at the write, their FIFTH visit
 * could not be invoiced at all.
 */
async function composeBenefits(
  db: Db,
  args: { patientId: string | null; couponCodes: string[] | undefined; attributionCode: string | undefined; at: Date; lines: InvoiceLineInput[] },
  ctx: Awaited<ReturnType<typeof loadPricingContext>>,
): Promise<{ ctx: typeof ctx; benefits: BenefitContext | null }> {
  // A presented attribution code is a third reason to compose: a walk-in with no member record and
  // no coupon can still arrive on a partner's slip, and returning early would drop that referral
  // silently — the failure mode this task exists to prevent, one branch earlier.
  const registered = await resolveRegisteredSources(db, {
    attributionCode: args.attributionCode, patientId: args.patientId, at: args.at,
  });
  const withRegistered = (c: typeof ctx): typeof ctx =>
    registered.length === 0 ? c : { ...c, sources: [...c.sources, ...registered] };

  if (args.patientId === null && (args.couponCodes ?? []).length === 0) {
    return { ctx: withRegistered(ctx), benefits: null };
  }

  const found = await resolveInstruments(db, {
    patientId: args.patientId,
    presentedCodes: args.couponCodes,
    at: args.at,
    /**
     * REVIEW MAJOR 3 — ON THE MONEY PATH A PRESENTED CODE IS A COUPON, NEVER A CARD.
     *
     * `loadInstances` matches `byPatient OR byCode` against `membership_instances.card_code`. That
     * bearer behaviour is deliberate and tested for the RECOGNITION surface, which is actor-gated
     * through `visiblePatientIds` and shows a card to whoever holds it. It was never safe HERE, and
     * until RC-2 it was unreachable here: no HTTP caller could set `couponCodes` at all. T1 opened
     * `?coupon=` on the quote and T2 declared it on both invoice bodies, and with the `or(...)` that
     * made a STRANGER'S CARD applicable to anyone's bill — proposing their percentage and then
     * burning THEIR entitlement counter against THIS invoice's line.
     *
     * The composer's subject is the invoice's own patient, which is what `resolveInstruments`'
     * header has always said it is. Coupons still resolve by code, because a coupon is what the
     * counter actually presents.
     */
    codesAreCouponsOnly: true,
  });
  if (found.memberships.length === 0 && found.coupons.length === 0) return { ctx: withRegistered(ctx), benefits: null };

  const counters = await entitlementCountersOf(db, found.memberships.map((m) => m.instanceId));
  const couponStates = await couponRedemptionStates(db, found.coupons.map((c) => c.couponId));
  const usable = narrowToRedeemableCoupons(narrowToUsableEntitlements(found, counters, args.at), couponStates);

  // Pass one: the draft's own gross, before any adjustment. Pure and synchronous.
  const grossPaise = priceInvoiceLines(ctx, args.lines).reduce((total, line) => total + line.grossPaise, 0);
  const resolved: ResolvedInstruments = { ...usable, billGrossPaise: grossPaise };

  return {
    // Registered sources come LAST: `runContest` uses this array's index for exact ties only, and on
    // a tie a benefit the patient bought beats one a channel partner brought (D3's tie-break ruling).
    ctx: { ...ctx, sources: [...ctx.sources, membershipSource(resolved), couponSource(resolved), ...registered] },
    benefits: { resolved, counters },
  };
}

async function priceDraftWithBenefits(
  db: Db,
  draft: {
    encounterId?: string; patientId?: string; lines: InvoiceLineInput[]; tags?: string[];
    receipt?: { tenders: TenderInput[] }; couponCodes?: string[]; attributionCode?: string;
  },
  now: Date,
): Promise<{ priced: PricedDraft; benefits: BenefitContext | null }> {
  const encounter = await resolveEncounter(db, draft.encounterId);
  // `loadPricingContext` takes Db, NOT Tx (§14.5) and runs OUTSIDE any transaction; the engine
  // itself is pure and synchronous, so pricing holds no connection and no lock.
  const base = await loadPricingContext(db, { at: now, tags: draft.tags ?? [] });
  assertBoundaryPaise(draft);
  // D1 — THE FLAG IS LOAD-BEARING. With it off nothing above is called at all: no membership table
  // is read, no source is appended, and every pre-existing billing test prices exactly as before.
  //
  // RC-2 T3 / D6 — AND THE SECOND CONDITION IS THE PAYER. Member, coupon and referral benefits
  // apply to the SELF-PAY SHARE ONLY (department brainstorm O-3's default, made executable here):
  // TPA, corporate and scheme rates are TARIFF SUBSTITUTION, not contestants, so a member discount
  // composed on top of a panel rate is money given away twice — once as a rate the hospital already
  // conceded, once as a benefit — on a bill the hospital does not collect from the patient at all.
  //
  // The gate sits HERE rather than inside `composeBenefits` because `resolveEncounter` has already
  // read the payer one line above: no new query, and the refusal is visible at the same altitude as
  // the flag it sits beside. An encounter-less draft resolves to `self` (see `resolveEncounter`), so
  // every shipped caller that names no encounter prices exactly as before.
  //
  // NOT recorded as a rejected candidate, and that is a DECIDED correction to this phase's own
  // doc: `AdjustmentCandidate.rejected` means "contested and refused", and a payer-ineligible
  // instrument was never in the contest. Claiming otherwise would put a losing chip on screen that
  // never ran. The fact the seat needs already travels — `PricedDraft.intendedPayer` — and T5 names
  // it on the quote, which is the honest rendering of "bill to panel, nothing to collect".
  const benefitsApply = memberBenefitsEnabled() && encounter.intendedPayer === "self";
  const composed = benefitsApply
    ? await composeBenefits(
        db,
        {
          patientId: draft.patientId ?? encounter.patientId,
          couponCodes: draft.couponCodes,
          attributionCode: draft.attributionCode,
          at: now,
          lines: draft.lines,
        },
        base,
      )
    : { ctx: base, benefits: null };
  const lines = priceInvoiceLines(composed.ctx, draft.lines);
  return {
    priced: {
      tariffVersionId: composed.ctx.tariff.versionId,
      intendedPayer: encounter.intendedPayer,
      lines,
      totals: totalInvoice(lines),
    },
    benefits: composed.benefits,
  };
}

/**
 * THE WRITE HALF of DD2's composition: every WINNING instrument candidate becomes a row.
 *
 * ═══ IT KEYS OFF `winner`, NEVER `candidates` ═══
 *
 * A benefit that PROPOSED and lost consumes nothing — the contest is best-single-benefit, so a
 * losing candidate cost the member nothing and taking a unit for it would charge them for a
 * discount they never received. `candidates` stays the D-8 audit record of what was offered;
 * `winner` is what was given.
 *
 * ═══ A WINNER NAMES A BENEFIT KEY, NOT AN INSTRUMENT ═══
 *
 * `benefitCandidate` sets `ruleKey = term.benefitKey` for a membership and the coupon's own CODE
 * for a coupon (relay note 13). Coupon codes are unique (`coupon_definitions_code_ux`), so that
 * side is exact. The membership side is resolved by `counterForWinner`, in arrival order — DD11's
 * duplicate-card case, routed to a human rather than guessed at.
 *
 * ═══ THE ONE REFUSAL THIS CAN RAISE, AND WHY IT IS A REFUSAL ═══
 *
 * A bill that wins the same entitlement on MORE lines than the counter still holds — two consults
 * on one bill against a last free consult — is refused whole by `consumeEntitlements`, with the
 * counter, the remaining and the ask in the detail. The alternative is to consume what is left and
 * honour the rest anyway, which is a silent giveaway of exactly the kind this tier exists to stop.
 * Splitting such a bill is a counter action; paying for it out of a counter nobody decremented is
 * not. (It is a `MembershipError`, and `billing.controller.ts`'s `toHttp` ladder — frozen for this
 * phase — has no arm for that class, so over HTTP it is a 500 rather than a typed 409 until a
 * later phase adds one. Recorded rather than worked around: the fix is one line in a file no task
 * in this phase may edit.)
 */
async function consumeWinningInstruments(
  tx: Tx,
  actor: Actor,
  input: {
    invoiceId: string;
    patientId: string;
    at: Date;
    lines: { priced: PricedLine; invoiceLineId: string }[];
    benefits: BenefitContext;
  },
): Promise<void> {
  const consumes: EntitlementConsume[] = [];
  const byCoupon = new Map<string, CouponRedemptionRequest>();

  for (const { priced, invoiceLineId } of input.lines) {
    const winner = priced.winner;
    if (winner === null || winner.ruleKey === null) continue;
    if (winner.sourceKey === MEMBERSHIP_SOURCE_KEY) {
      const target = counterForWinner(input.benefits.resolved, input.benefits.counters, {
        benefitKey: winner.ruleKey,
        at: input.at,
      });
      // No counter for this key means an UNLIMITED percentage benefit: there is nothing to move.
      if (target !== null) {
        consumes.push({ instanceId: target.instanceId, benefitKey: winner.ruleKey, invoiceLineId });
      }
      continue;
    }
    if (winner.sourceKey !== COUPON_SOURCE_KEY) continue;
    const coupon = input.benefits.resolved.coupons.find((c) => c.code === winner.ruleKey);
    if (coupon === undefined) continue;
    const running = byCoupon.get(coupon.couponId);
    byCoupon.set(coupon.couponId, {
      couponId: coupon.couponId,
      instanceId: coupon.instanceId,
      // ONE redemption per coupon per invoice, carrying what the coupon actually took off the
      // whole bill. Integer addition over the winning candidates — no division anywhere (S12).
      amountPaise: (running?.amountPaise ?? 0) + winner.amountPaise,
    });
  }

  await consumeEntitlements(tx, actor, { invoiceId: input.invoiceId, at: input.at, consumes });
  await redeemCoupons(tx, actor, {
    invoiceId: input.invoiceId,
    patientId: input.patientId,
    at: input.at,
    redemptions: [...byCoupon.values()],
  });
}

/**
 * The fee-quote core (D8): prices a draft exactly as `issueInvoice` would and persists NOTHING.
 * T10's `feeQuote` composes this with the charge-rule branch.
 *
 * It returns `PricedDraft` and NOT the benefit context: the priced lines already carry the D-8
 * contest record a member is owed, and the resolved instruments carry card codes and plan ids that
 * the recognition surface gates through `visiblePatientIds` and this route does not.
 */
export async function previewInvoice(db: Db, input: PreviewInvoiceInput, now: Date = new Date()): Promise<PricedDraft> {
  return (await priceDraftWithBenefits(db, input, now)).priced;
}

// ---------------------------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------------------------

/**
 * E-26's `expectedNetPaise`, stamped HERE — at CAPTURE, never at reconciliation (self-review 12).
 * Stamping it when the statement arrives would let a later fee-config revision rewrite what
 * "expected" meant for money the hospital already took; T9 compares the settled amount against
 * this stored number. Cash settles at face value and carries no expectation.
 */
export function tenderExpectedNetPaise(mode: TenderMode, amountPaise: number, feeBps: FeeBps): number | null {
  if (mode === "cash") return null;
  return amountPaise - percentAmount(amountPaise, feeBps[mode]);
}

/**
 * One receipt with its tenders (D1: money in; an advance and a bill payment are the same row).
 * Exported because T6's `recordReceipt` writes the identical rows and cannot edit this file.
 */
export async function insertReceiptWithTenders(
  tx: Tx,
  actor: Actor,
  cfg: BillingConfig,
  input: {
    patientId: string; cashierSessionId: string; tenders: TenderInput[];
    panNumber?: string; form60?: boolean; note?: string; changeGivenPaise?: number; at: Date;
  },
): Promise<{ receiptId: string; receiptNo: string; totalPaise: number }> {
  let totalPaise = 0;
  for (const tender of input.tenders) {
    if (tender.mode !== "cash" && (tender.refText ?? "").trim() === "") {
      throw new BillingError("tender_ref_required", `a ${tender.mode} tender needs a settlement reference`);
    }
    totalPaise += tender.amountPaise;
  }

  const receiptId = newId();
  const receiptNo = await nextDocNo(tx, cfg, "receipt", input.at);
  await tx.insert(receipts).values({
    id: receiptId,
    receiptNo,
    patientId: input.patientId,
    cashierSessionId: input.cashierSessionId,
    receivedBy: actor.id,
    receivedAt: input.at,
    serviceDay: istDay(input.at), // the C-2 episode grain
    totalPaise,
    panNumber: input.panNumber ?? null,
    form60: input.form60 ?? false,
    degraded: cfg.degradedTender, // E-24 stamp
    changeGivenPaise: input.changeGivenPaise ?? 0, // PLAN 07b T5 — the cashier's declaration
    note: input.note ?? null,
  });
  for (const tender of input.tenders) {
    await tx.insert(receiptTenders).values({
      id: newId(),
      receiptId,
      mode: tender.mode,
      amountPaise: tender.amountPaise,
      refText: tender.refText ?? null,
      state: "captured", // E-25 lifecycle start
      expectedNetPaise: tenderExpectedNetPaise(tender.mode, tender.amountPaise, cfg.feeBps),
    });
  }
  return { receiptId, receiptNo, totalPaise };
}

// ---------------------------------------------------------------------------------------------
// Approvals — check-on-execute BY DESIGN (Global Constraint 1, roadmap trap 1). Plan 08.5 puts
// the dispatcher on a clock; this section still verifies against the approvals row at execution
// time, never via an event consumer — the loop existing does not change it.
// ---------------------------------------------------------------------------------------------

async function assertGrantedApproval(
  db: Db,
  approvalId: string,
  expected: { typeKey: string; subjectType: string; subjectId: string; patientId: string; amountPaise?: number },
): Promise<void> {
  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === expected.typeKey &&
    approval.subjectType === expected.subjectType &&
    approval.subjectId === expected.subjectId &&
    approval.patientId === expected.patientId &&
    (expected.amountPaise === undefined || approval.amountPaise === expected.amountPaise);
  if (!bound) {
    throw new BillingError(
      "approval_subject_mismatch",
      `approval ${approvalId} does not bind to this ${expected.typeKey} request`,
      { expected, got: { typeKey: approval.typeKey, subjectType: approval.subjectType, subjectId: approval.subjectId, patientId: approval.patientId, amountPaise: approval.amountPaise } },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// D2 — the one transaction
// ---------------------------------------------------------------------------------------------

/**
 * D2, frozen order: load and price OUTSIDE (above), then ONE transaction that allocates the
 * document number, verifies the discount approvals, settles the credit question, persists the
 * invoice and its lines VERBATIM from the engine's `PricedLine[]`, records the receipt with its
 * tenders under the C-2 cash law, allocates against the invoice, and appends the events.
 *
 * The credit decision is evaluated BEFORE the insert because `credit_extended`, `credit_reason`
 * and `credit_approval_id` are columns on the invoice row and the row is immutable the moment it
 * lands (migration 0012's triggers): there is no later UPDATE in which to record them.
 *
 * NO INVOICE-ROW LOCK IS TAKEN HERE, deliberately. This function only INSERTS fresh rows, so it
 * has nothing to serialize against. The `SELECT id FROM invoices ... FOR UPDATE` belongs to the
 * ALLOCATION writers (T6), where concurrent allocations against one existing invoice must not
 * overpay it. Adding a lock here would serialize unrelated issues for no invariant.
 *
 * `hasPermission` and `getApproval` are kernel readers that take `Db`, so both run on the OUTER
 * handle from inside this transaction. Both read already-committed governance rows that nothing
 * in this transaction can change, and neither writes.
 */
export async function issueInvoice(
  db: Db,
  actor: Actor,
  input: IssueInvoiceInput,
  now: Date = new Date(),
): Promise<IssueInvoiceResult> {
  const cfg = await loadBillingConfig(db);
  const { priced: draft, benefits } = await priceDraftWithBenefits(db, input, now);
  const { totals } = draft;

  // Pure arithmetic over what the caller handed in and what the engine returned.
  let receiptTotalPaise = 0;
  for (const tender of input.receipt?.tenders ?? []) receiptTotalPaise += tender.amountPaise;
  // PLAN 15 T7 — money already held counts toward settlement for D2 step 3's remainder check. It is
  // NOT part of `receiptTotalPaise`: that figure drives the change-due lane below, and a deposit
  // that exceeds the bill is a REFUND question (§3A), never change handed across a counter.
  let heldSettlementPaise = 0;
  for (const held of input.settleFromReceipts ?? []) heldSettlementPaise += held.amountPaise;
  const allocatedPaise = Math.min(receiptTotalPaise, totals.netPayablePaise);
  const remainderPaise = totals.netPayablePaise - allocatedPaise - heldSettlementPaise;
  // D2 step 5: overpayment is NOT an error. The surplus stays unallocated on the receipt — it IS
  // the change-due / banked-advance lane, and refusing it would refuse ordinary cash transactions.
  const unallocatedPaise = receiptTotalPaise - allocatedPaise;
  /**
   * PLAN 07b T5 — the two guards that keep the declaration honest.
   *
   * You cannot hand back more than the surplus (the rest is the hospital's money), and you cannot
   * hand back CASH against a card-only payment — that is not change, it is a refund, and refunds
   * have an approval ladder this route deliberately does not have.
   */
  const changeGivenPaise = input.receipt?.changeGivenPaise ?? 0;
  if (changeGivenPaise > 0) {
    /**
     * RC-1 CLOSE M4 — the ceiling is the SMALLER of the receipt's surplus and the CASH actually
     * tendered. The original pair of guards compared against the whole-receipt surplus and only
     * checked that a cash tender EXISTS, so ₹1 of cash beside a card overpayment authorised
     * handing back the card's surplus as cash — a refund with an approval ladder, walking out as
     * change. (The guard was unreachable while the controller stripped the field; T1 made it
     * live, and this is its first re-read since 07b wrote it.)
     */
    let cashTenderedPaise = 0;
    for (const t of input.receipt?.tenders ?? []) if (t.mode === "cash") cashTenderedPaise += t.amountPaise;
    if (cashTenderedPaise === 0) {
      throw new BillingError(
        "change_without_cash",
        "change can only be handed back against a cash tender — returning money on a card payment is a refund",
      );
    }
    const changeCeilingPaise = Math.min(unallocatedPaise, cashTenderedPaise);
    if (changeGivenPaise > changeCeilingPaise) {
      throw new BillingError(
        "change_exceeds_surplus",
        `change of ${String(changeGivenPaise)} exceeds the ${String(changeCeilingPaise)} handable surplus on this receipt (surplus ${String(unallocatedPaise)}, cash tendered ${String(cashTenderedPaise)})`,
        { changeGivenPaise, unallocatedPaise, cashTenderedPaise },
      );
    }
  }

  try {
    return await withTx(db, async (tx) => {
      const invoiceId = newId();
      const invoiceNo = await nextDocNo(tx, cfg, "invoice", now);

      // Every `requiresApproval` winner the engine produced must be covered by a GRANTED approval
      // bound to this draft, this line, this patient and this exact benefit (D2 step 2).
      for (const line of draft.lines) {
        const winner = line.winner;
        if (winner === null || !winner.requiresApproval) continue;
        const approvalId = input.discountApprovals?.[line.lineId];
        if (approvalId === undefined) {
          throw new BillingError(
            "discount_approval_missing",
            `line ${line.lineId} carries a discount that needs approval and none was supplied`,
            { lineId: line.lineId, amountPaise: winner.amountPaise },
          );
        }
        await assertGrantedApproval(db, approvalId, {
          typeKey: DISCOUNT_APPROVAL_TYPE,
          subjectType: DISCOUNT_APPROVAL_SUBJECT,
          subjectId: discountSubjectId(input.draftId, line.lineId),
          patientId: input.patientId,
          amountPaise: winner.amountPaise,
        });
      }

      // D2 step 3 — remainder > 0 is the credit lane or a refusal. Nothing else may persist an
      // unsettled invoice: that is the invariant that stops a counter minting dues silently.
      const warnings: string[] = [];
      let creditBlock: { reason: string; approvalId?: string } | null = null;
      if (remainderPaise > 0) {
        const credit = input.credit;
        // A credit block without a reason is not a credit block (the reason is mandatory, owner
        // ruling 2) — so it lands on the same refusal as no credit block at all.
        if (credit === undefined || credit.reason.trim() === "") {
          throw new BillingError(
            "unsettled_issue_refused",
            `${String(remainderPaise)}p would be left unsettled and no credit extension was requested`,
            { remainderPaise },
          );
        }
        if (!(await hasPermission(db, actor.id, CREDIT_EXTEND_PERMISSION, "hospital"))) {
          throw new BillingError("credit_permission_required", `extending credit needs ${CREDIT_EXTEND_PERMISSION}`);
        }
        if (remainderPaise > cfg.creditCapPaise) {
          if (credit.approvalId === undefined) {
            throw new BillingError(
              "credit_approval_required",
              `${String(remainderPaise)}p exceeds the per-invoice credit cap ${String(cfg.creditCapPaise)}p`,
              { remainderPaise, creditCapPaise: cfg.creditCapPaise },
            );
          }
          await assertGrantedApproval(db, credit.approvalId, {
            typeKey: CREDIT_APPROVAL_TYPE,
            subjectType: CREDIT_APPROVAL_SUBJECT,
            subjectId: input.draftId,
            patientId: input.patientId,
          });
        }
        if (cfg.outstandingCapMode !== "off") {
          const prospectivePaise = (await patientOutstandingPaise(tx, input.patientId)) + remainderPaise;
          if (prospectivePaise > cfg.outstandingCapPaise) {
            if (cfg.outstandingCapMode === "block") {
              throw new BillingError(
                "outstanding_cap_exceeded",
                `patient dues would reach ${String(prospectivePaise)}p against a cap of ${String(cfg.outstandingCapPaise)}p`,
                { prospectivePaise, outstandingCapPaise: cfg.outstandingCapPaise },
              );
            }
            warnings.push("outstanding_cap");
          }
        }
        creditBlock = { reason: credit.reason, approvalId: credit.approvalId };
      }

      // The two §15 numbers are persisted EXACTLY as `totalInvoice` returned them — sums of the
      // LINE heads. No code path here applies a tax head to an invoice-level base (K18/M-I2).
      await tx.insert(invoices).values({
        id: invoiceId,
        invoiceNo,
        patientId: input.patientId,
        encounterId: input.encounterId ?? null,
        tariffVersionId: draft.tariffVersionId, // the pin (§14.5)
        intendedPayer: draft.intendedPayer,
        buyerGstin: input.buyerGstin ?? null,
        buyerLegalName: input.buyerLegalName ?? null,
        grossPaise: totals.grossPaise,
        discountPaise: totals.discountPaise,
        taxableBasePaise: totals.taxableBasePaise,
        cgstPaise: totals.cgstPaise,
        sgstPaise: totals.sgstPaise,
        rawTotalPaise: totals.rawTotalPaise,
        roundingPaise: totals.roundingPaise,
        netPayablePaise: totals.netPayablePaise,
        creditExtended: creditBlock !== null,
        creditReason: creditBlock?.reason ?? null,
        creditApprovalId: creditBlock?.approvalId ?? null,
        issuedBy: actor.id,
        issuedAt: now,
        serviceDay: istDay(now),
      });

      // `PricedLine` persisted verbatim, `candidates` jsonb = the D-8 contest record.
      const storedLines = draft.lines.map((line, index) => ({
        id: newId(),
        invoiceId,
        lineNo: index + 1,
        serviceId: line.serviceId,
        serviceName: line.serviceName,
        category: line.category,
        qty: line.qty,
        unitPaise: line.unitPaise,
        grossPaise: line.grossPaise,
        regulatedClamp: line.regulatedClamp,
        candidates: line.candidates,
        winner: line.winner,
        discountPaise: line.discountPaise,
        taxableBasePaise: line.taxableBasePaise,
        sacCode: line.gst.sacCode,
        rateBps: line.gst.rateBps,
        exempt: line.gst.exempt,
        exemptReason: line.gst.exemptReason,
        cgstPaise: line.gst.cgstPaise,
        sgstPaise: line.gst.sgstPaise,
        netPaise: line.netPaise,
      }));
      await tx.insert(invoiceLines).values(storedLines);

      // PLAN 09 / DD10 — the CONSUME half, inside this transaction and under the counter lock.
      // It runs AFTER the lines are inserted because a movement's `invoice_line_id` is a REAL
      // foreign key: a consumption naming a line that never existed would be a benefit nobody can
      // audit, and C2's restore is defined per LINE.
      if (benefits !== null) {
        await consumeWinningInstruments(tx, actor, {
          invoiceId,
          patientId: input.patientId,
          at: now,
          lines: draft.lines.map((line, index) => ({ priced: line, invoiceLineId: storedLines[index]!.id })),
          benefits,
        });
      }

      let receiptId: string | null = null;
      let receiptNo: string | null = null;
      let cashVerdict: CashLawVerdict | null = null;
      const receipt = input.receipt;
      if (receipt !== undefined) {
        const session = await requireOpenSession(tx, actor); // D9 — the ACTING cashier's drawer
        cashVerdict = await assertCashAccepted(tx, cfg, {
          patientId: input.patientId,
          tenders: receipt.tenders,
          panNumber: receipt.panNumber,
          form60: receipt.form60,
          at: now,
        });
        const written = await insertReceiptWithTenders(tx, actor, cfg, {
          patientId: input.patientId,
          cashierSessionId: session.id,
          tenders: receipt.tenders,
          panNumber: receipt.panNumber,
          form60: receipt.form60,
          note: receipt.note,
          changeGivenPaise,
          at: now,
        });
        receiptId = written.receiptId;
        receiptNo = written.receiptNo;
        if (allocatedPaise > 0) {
          await tx.insert(allocations).values({
            id: newId(),
            receiptId,
            invoiceId,
            amountPaise: allocatedPaise,
            kind: "apply",
            reversalOfId: null,
            reason: null,
            actorId: actor.id,
            at: now,
          });
        }
      }

      /**
       * PLAN 15 T7 / DD12 — settle from money already held, INSIDE this transaction.
       *
       * `allocateOnTx` is `allocateReceipt`'s own body, so every guard it applies applies here:
       * the receipt must belong to this invoice's patient, must not be entered-in-error, must have
       * room, and must not drive the patient's advance negative. Running it here rather than after
       * the commit is what keeps D2 step 3's "no unsettled invoice" invariant true — see the field's
       * own docstring on `IssueInvoiceInput`.
       *
       * It runs AFTER the tenders' allocation above so that the two together cannot exceed the
       * invoice: `allocateOnTx`'s `over_allocation` check reads the allocations already written in
       * this transaction and refuses the excess rather than silently over-settling.
       */
      for (const held of input.settleFromReceipts ?? []) {
        await allocateOnTx(tx, actor, {
          receiptId: held.receiptId, invoiceId, amountPaise: held.amountPaise,
        }, now);
      }

      // D2 step 4. correlationId is the invoice id on every invoice-scoped emission.
      const scope = { patientId: input.patientId, encounterId: input.encounterId, correlationId: invoiceId };
      await appendEvent(
        tx,
        invoiceIssued.make({
          actor,
          payload: { invoiceId, invoiceNo, patientId: input.patientId, netPayablePaise: totals.netPayablePaise },
          ...scope,
        }),
      );
      if (creditBlock !== null) {
        await appendEvent(
          tx,
          invoiceCreditExtended.make({
            actor,
            payload: { invoiceId, invoiceNo, patientId: input.patientId, remainderPaise, reason: creditBlock.reason },
            ...scope,
          }),
        );
      }
      if (receiptId !== null && receiptNo !== null) {
        await appendEvent(
          tx,
          receiptRecorded.make({
            actor,
            payload: { receiptId, receiptNo, patientId: input.patientId, totalPaise: receiptTotalPaise },
            ...scope,
          }),
        );
        if (allocatedPaise > 0) {
          await appendEvent(
            tx,
            paymentReceived.make({
              actor,
              payload: { receiptId, invoiceId, patientId: input.patientId, amountPaise: allocatedPaise },
              ...scope,
            }),
          );
        }
        if (unallocatedPaise > 0) {
          await appendEvent(
            tx,
            advanceReceived.make({
              actor,
              payload: { receiptId, patientId: input.patientId, amountPaise: unallocatedPaise },
              ...scope,
            }),
          );
        }
        if (cashVerdict !== null && cashVerdict.warned) {
          await appendEvent(
            tx,
            cashThresholdWarned.make({
              actor,
              payload: {
                patientId: input.patientId,
                episodeCashPaise: cashVerdict.episodeCashPaise,
                thresholdPaise: cfg.cashWarnPaise,
              },
              ...scope,
            }),
          );
        }
      }

      // The settlement state counts BOTH lanes: the tenders taken here and the deposit already
      // held. An invoice cleared entirely from a booking deposit is SETTLED, not outstanding.
      const settlement = settlementState(totals.netPayablePaise, 0, allocatedPaise + heldSettlementPaise);
      /**
       * RC-1 T3 / D2 — the token's board flip rides the SAME commit as the money. The hook
       * receives "an invoice for this encounter is now settled / credit-extended"; whether that
       * invoice actually covers the CONSULT FEE is the registered hook's question to answer (it
       * re-derives through `encounterFeeStatuses`, the one projection), so a pharmacy-only
       * invoice settling never flips a token by accident.
       */
      if (input.encounterId !== undefined && (creditBlock !== null || settlement.state === "settled")) {
        await emitFeeSettled(tx, actor, {
          encounterId: input.encounterId, invoiceId,
          via: creditBlock !== null ? "credit_extended" : "invoice",
        }, now);
      }

      return {
        invoiceId,
        invoiceNo,
        totals,
        receiptId,
        receiptNo,
        allocatedPaise,
        settledFromHeldPaise: heldSettlementPaise,
        unallocatedPaise,
        creditExtended: creditBlock !== null,
        settlement,
        warnings,
      };
    });
  } catch (e) {
    if (e instanceof BillingError && e.code === "cash_threshold_blocked") {
      // The refusal rolls its own transaction back by construction, so the C-2 audit event is
      // appended in a transaction of its own AFTER it. An event that only survives when the money
      // was accepted would be the opposite of an audit trail.
      const detail = e.detail as CashThresholdDetail;
      await withTx(db, (tx) =>
        appendEvent(
          tx,
          cashThresholdBlocked.make({
            actor,
            payload: {
              patientId: input.patientId,
              episodeCashPaise: detail.episodeCashPaise,
              thresholdPaise: detail.thresholdPaise,
            },
            patientId: input.patientId,
            encounterId: input.encounterId,
          }),
        ),
      );
    }
    throw e;
  }
}
