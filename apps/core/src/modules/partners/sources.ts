import { z } from "zod";
import { assertPaise, percentAmount } from "../tariff";
import { counterpartyFacts, resolveAgreementAt } from "./agreements";
import { findAttributionByCode } from "./attribution";
import type { AdjustmentCandidate, AdjustmentSource, InvoiceLineInput, PricingContext } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T2 / D3 — REFERRAL AS A DISCOUNT, AND THE ONE THING IT IS NOT KEYED ON.
 *
 * `modules/membership/sources.ts` is the template and this file follows it deliberately: the
 * resolution is impure and happens ONCE, before the transaction, in `composeBenefits`; `propose`
 * is pure and synchronous; `modules/tariff` stays byte-untouched. The source key is appended LAST,
 * so `[rule, manual, membership, coupon, referral]`. That position is a ruling in the same shape
 * as Plan 09's: `runContest` sorts by amount and the array index decides EXACT ties only, and on a
 * tie **a benefit the patient bought beats one a channel partner brought**. That is the version
 * explainable across a counter, which is the test a tie-break rule has to pass.
 *
 * ═══ THE TRAP THIS FILE EXISTS TO AVOID (spike S3, §2.149) ═══
 *
 * `opd_encounters.referral_source` is an enum — `self | internal_doctor | external_rmp | camp |
 * other` — and it is the obvious thing to key a referral discount on. It is the wrong thing, and
 * the proof is a WRITER rather than a reader:
 *
 *     encounters.ts:340   referralSource: input.referralSource ?? "external_rmp"
 *
 * `openLabWalkinInTx` stamps `external_rmp` on EVERY direct lab walk-in whose caller named no
 * referrer. A discount keyed on that column would therefore fire on visits nobody referred, and
 * would open a partner-attributed candidate against no partner. RC-1's CLOSE named this class
 * exactly — *a spike about "who breaks on this state" greps WRITERS, not just readers* — and this
 * is the same class caught one phase earlier, before the money moved rather than after.
 *
 * So the column is treated as what its own schema comment calls it: **attribution CAPTURE**. The
 * discount is keyed on a RESOLVED COUNTERPARTY, reached from the code printed on the partner's own
 * slip through `attribution_ids` — the row somebody wrote, which is the only join `partners` has
 * ever permitted itself (DD13/V7's no-fuzzy-join rule). No resolution ⇒ NO CANDIDATE, never a zero
 * candidate: a zero would put a partner's name on a bill they had nothing to do with.
 *
 * ═══ `external_rmp` IS REFUSED EXPLICITLY, AND THAT IS A LEGAL BOUNDARY ═══
 *
 * `counterparties.payee_class` is CHECK-constrained to `channel_partner | staff_internal |
 * external_rmp`, so an external-RMP counterparty is a real row this resolver can reach. It
 * proposes nothing, by a named branch rather than by falling through some other condition:
 * per-patient payment to an external registered medical practitioner is prohibited (IMC
 * Regulations 2002 cl. 6.4; the department brainstorm's §11.19-C fix 1 holds the whole lane
 * structurally OFF). A refusal that happens to work because of an unrelated check is a refusal
 * that stops working when that check moves.
 *
 * ═══ WHAT IS **NOT** WRITTEN HERE, AND WHY (D4) ═══
 *
 * NO commission accrual, no `commission.accrued` event, no `commission_accruals` row.
 * `COMMISSION_ACCRUAL_ENABLED` stays off pending owner ruling O-8, and the month-end payout lane is
 * Plan 21's. What travels instead is the FACT: the winning candidate's `ruleKey` is the attribution
 * code and its `reason` names the counterparty, so the partner ledger can be reconstructed from
 * `invoice_lines.candidates` — the D-8 audit record — without this phase opening a second home for
 * money that has not been ruled on.
 *
 * ═══ THE TERMS ARE DATA, READ THE WAY `agreements.ts` PRESCRIBES ═══
 *
 * `partner_agreements.terms` is jsonb and `accrualTermsSchema` is a plain `z.object` that STRIPS
 * unknown keys precisely so later lanes can add their own. Its header says so in as many words —
 * "the receivable and P&L lanes land in later tasks whose Files lists do not include this file,
 * and a strict schema here would make their terms unparseable". This is one of those lanes, so it
 * parses its OWN keys off `rawTerms` and `agreements.ts` is not edited. No migration, no column.
 */
export const REFERRAL_SOURCE_KEY = "referral";

/**
 * The patient-facing half of an agreement, which is a DIFFERENT number from `payableRateBps`.
 * What the hospital gives the patient and what it owes the partner are two terms that happen to
 * live in one document; conflating them would make a 10% commission silently become a 10% discount.
 * Absent or unreadable ⇒ this agreement simply has no patient discount (the common case today,
 * since every shipped agreement predates this key).
 */
const referralBenefitSchema = z.object({
  patientDiscountBps: z.number().int().nonnegative().max(10_000),
  /**
   * The `invoice_lines.category` values the discount reaches. Deliberately NOT defaulted, for
   * `eligibleCategories`' own stated reason: an empty list is a real agreement that discounts
   * nothing, and is not the same fact as a key nobody configured.
   */
  patientDiscountCategories: z.array(z.string().min(1)),
  patientDiscountCapPaise: z.number().int().nonnegative().nullable().default(null),
  patientDiscountTitle: z.string().min(1).default("Partner referral"),
});

export type ResolvedReferral = {
  attributionId: string;
  code: string;
  counterpartyId: string;
  payeeClass: string;
  discountBps: number;
  categories: string[];
  capPaise: number | null;
  title: string;
};

/** The attribution states a slip may be presented in. `expired` and `void` are refusals. */
const PRESENTABLE_STATES = new Set(["issued", "claimed"]);

/**
 * IMPURE, and called ONCE per draft from `composeBenefits` — never from inside `propose`.
 *
 * Every refusal returns `null` rather than throwing. A partner slip that has expired, been voided,
 * or belongs to a suspended counterparty must still let the patient be billed: refusing the
 * INVOICE would strand somebody at the counter over a marketing arrangement they are not party to.
 * The clerk sees no referral chip, which is the honest rendering of "this slip buys nothing".
 */
export async function resolveReferral(
  db: Db,
  args: { code: string | undefined; at: Date },
): Promise<ResolvedReferral | null> {
  const code = (args.code ?? "").trim();
  if (code === "") return null;

  const scanned = await findAttributionByCode(db, code);
  if (scanned === null) return null;
  if (!PRESENTABLE_STATES.has(scanned.state)) return null;
  if (scanned.expiresAt !== null && scanned.expiresAt.getTime() <= args.at.getTime()) return null;

  const facts = await counterpartyFacts(db, scanned.counterpartyId);
  if (facts === null) return null;
  // THE LEGAL BRANCH — named, not incidental. See this file's header.
  if (facts.payeeClass === "external_rmp") return null;
  if (facts.status !== "active") return null;

  const agreement = await resolveAgreementAt(db, scanned.counterpartyId, args.at);
  if (agreement === null) return null;

  const parsed = referralBenefitSchema.safeParse(agreement.rawTerms ?? {});
  if (!parsed.success) return null;

  return {
    attributionId: scanned.attributionId,
    code: scanned.code,
    counterpartyId: scanned.counterpartyId,
    payeeClass: facts.payeeClass,
    discountBps: parsed.data.patientDiscountBps,
    categories: parsed.data.patientDiscountCategories,
    capPaise: parsed.data.patientDiscountCapPaise,
    title: parsed.data.patientDiscountTitle,
  };
}

/**
 * PURE AND SYNCHRONOUS, like its two siblings: reads only its three arguments and the plain value
 * the factory closed over. No `await`, no clock — the instant is `ctx.asOf`, the one time authority
 * the engine pins. `sources.test.ts` asserts that by scanning this file's text and by running
 * `propose` with `Date.now` stubbed to throw.
 */
export function referralSource(resolved: ResolvedReferral): AdjustmentSource {
  return {
    key: REFERRAL_SOURCE_KEY,
    propose(ctx: PricingContext, line: InvoiceLineInput, grossPaise: number): AdjustmentCandidate[] {
      if (resolved.discountBps === 0) return [];
      const service = ctx.services[line.serviceId];
      if (service === undefined) return [];
      if (!resolved.categories.includes(service.category)) return [];

      assertPaise(grossPaise, "referral gross");
      const raw = percentAmount(grossPaise, resolved.discountBps);
      const base: AdjustmentCandidate = {
        // B7: the candidate's `sourceKey` IS the source's own key. `runContest` indexes its
        // precedence map by this string and falls back to MAX_SAFE_INTEGER, so a mismatch sorts
        // last on every tie and nothing fails — which is why the constant is used, not respelled.
        sourceKey: REFERRAL_SOURCE_KEY,
        // The attribution code is the audit handle: it is what reconstructs the partner ledger from
        // `invoice_lines.candidates` without this phase writing an accrual (D4).
        ruleKey: resolved.code,
        kind: "percent_bps",
        // Never a `DiscountCategory`: a referral is not charity, scheme, employee or
        // negotiated-corporate, and `ctx.manualCaps` must not reach it. Its cap is its own.
        discountCategory: null,
        amountPaise: Math.min(raw, grossPaise), // candidates are pre-capped at gross
        reason: `${resolved.title} (${resolved.counterpartyId})`,
        requiresApproval: false,
        rejected: null,
      };
      if (resolved.capPaise !== null && raw > resolved.capPaise) {
        return [{
          ...base,
          amountPaise: raw, // the ASK — the audit record, never the clamped amount
          rejected: { code: "over_cap", detail: `${raw}p exceeds the ${resolved.capPaise}p cap on "${resolved.code}"` },
        }];
      }
      return [base];
    },
  };
}
