import { getEncounter, reviewAnchorFor } from "../opd";
import { loadBillingConfig } from "./config";
import { BillingError } from "./errors";
import { previewInvoice } from "./invoices";
import type { ChargeRules } from "./config";
import type { PricedDraft } from "./invoices";
import type { EncounterRow } from "../opd";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 D8 — the OPD fee branch. `billing_config.charge_rules` is DATA (D-17), validated
 * against `services` by `validate:billing` (config.ts), so which service a visit is charged for
 * is never a constant in code.
 *
 * `refunds.ts` (T8) carries a private copy of this branch because its own task could not create
 * this file; this is the canonical one, and it is the one the gate and the daily close read.
 */

/** The preview's line id — nothing is persisted, so a stable id keeps a quote deterministic. */
export const FEE_LINE_ID = "fee";

/**
 * The service a visit's consultation fee is charged against, or `null` when the visit is FREE.
 *
 * `revisit` is free (spec:224, Plan 07's owner decision): the null is the free branch, not a
 * missing mapping, which is why the gate treats it as "nothing to collect" rather than as an
 * error. A visit type outside the three OPD ships has no rule to apply at all.
 */
export function feeServiceFor(encounter: EncounterRow, rules: ChargeRules): string | null {
  switch (encounter.visitType) {
    case "revisit":
      return null;
    case "new":
      return rules.opdConsult.new;
    case "renewal":
      return rules.opdConsult.renewal;
    default:
      throw new BillingError(
        "fee_not_applicable",
        `no charge rule for visit type "${encounter.visitType}"`,
        { encounterId: encounter.id, visitType: encounter.visitType },
      );
  }
}

export type FeeQuote = {
  encounterId: string;
  visitType: string;
  free: boolean; // the revisit branch — no fee service, no draft
  feeServiceId: string | null;
  draft: PricedDraft | null;
  /**
   * RC-1 T5 / D8 — WHY it is free, named (the receipt and the seat print the rule: "review visit —
   * free till <date> (<doctor>)"). Naming only: null never un-frees anything.
   */
  freeReason: { kind: "review_window"; doctorName: string | null; seenOn: string; windowEndsOn: string } | null;
  /**
   * FD-7 T9 / R4 — THE SLIP THE DESK CAPTURED, so the cashier's field can PRE-FILL from it.
   *
   * Without this the quote would silently price with a stored code the billing screen could not see,
   * and the cashier's own field — blank — would issue the invoice without it. That is exactly the
   * disagreement RC-2's review named ("a seat that quoted ₹450 would still have issued at ₹500"),
   * arriving from the opposite direction. The screen shows what the desk captured, and any edit the
   * cashier makes is therefore explicit and travels on the invoice.
   */
  attributionCode: string | null;
  /**
   * RC-2 T5 / D7 — CORPORATE v0: the payer, named on the quote, on BOTH branches.
   *
   * `PricedDraft.intendedPayer` already carries it — but only when there IS a draft, and a
   * review-window revisit has `draft: null`. The seat needs to say "bill to panel — nothing to
   * collect" on a free visit exactly as much as on a priced one, so the fact is lifted to the quote
   * itself rather than read out of a nullable child.
   *
   * It is also the ANSWER to a question T3 created: with a non-`self` payer the membership, coupon
   * and referral sources do not compose at all, so the seat sees a bill with no benefit chips and
   * no explanation. This is the explanation, and it is why T3 deliberately emits no rejected
   * candidate — a chip that was never in the contest should not be rendered as one that lost.
   *
   * NOT panel machinery: no rate list, no e-authorisation record, no claim file. Plan 21 owns those
   * and a second home for them would be worse than none.
   */
  intendedPayer: string;
};

/**
 * The counter screen's one-keystroke flow (D8): the branch plus a fee line priced exactly as
 * `issueInvoice` would price it, and NOTHING persisted — `previewInvoice` is the shared core, so
 * a quote and the invoice that follows it can never disagree about the money.
 *
 * ═══ RC-2 T1 / D2 — THE CODES THE CLERK IS HOLDING ═══
 *
 * That last sentence was FALSE for a coupon, and had been since Plan 09 shipped. `previewInvoice`
 * has declared `couponCodes` all along (with a comment saying exactly why: "a counter that quotes
 * high and bills low teaches its clerks not to trust the quote"), and this function — the one the
 * counter actually calls — accepted none and forwarded none. So a presented coupon could reach the
 * INVOICE and never the QUOTE, and the two disagreed by the whole discount.
 *
 * The membership half needed no such repair and none is made: `priceDraftWithBenefits` resolves the
 * encounter's own patient when the caller names none, so a member's percentage has always composed
 * into this quote whenever `MEMBER_BENEFITS_ENABLED` is on. Only the codes had no door.
 */
export async function feeQuote(
  db: Db,
  encounterId: string,
  now: Date = new Date(),
  opts: { couponCodes?: string[]; attributionCode?: string } = {},
): Promise<FeeQuote> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) throw new BillingError("unknown_encounter", `unknown encounter ${encounterId}`);
  const cfg = await loadBillingConfig(db);
  const feeServiceId = feeServiceFor(encounter, cfg.chargeRules);
  if (feeServiceId === null) {
    const anchor = await reviewAnchorFor(db, encounter);
    return {
      encounterId, visitType: encounter.visitType, free: true, feeServiceId: null, draft: null,
      freeReason: anchor === null ? null : { kind: "review_window", ...anchor },
      intendedPayer: encounter.intendedPayer,
      // On the FREE branch too: a review visit still carries the partner's slip, and the accrual
      // that hangs off it is the partner's whether or not this particular visit was charged for.
      attributionCode: encounter.attributionCode,
    };
  }
  const draft = await previewInvoice(
    db,
    {
      encounterId,
      lines: [{ lineId: FEE_LINE_ID, serviceId: feeServiceId, qty: 1 }],
      // The whole of D2. An unknown or spent code is NOT an error here: `narrowToRedeemableCoupons`
      // drops it and the quote simply carries no discount, so a mistyped code makes the clerk retype
      // rather than making the counter stall on a patient who is standing there.
      couponCodes: opts.couponCodes,
      /*
       * RC-2 T2 / D3 — the partner slip travels with the question too, for T1's own reason: a
       * referral that repriced the invoice but not the quote is the same disagreement.
       *
       * FD-7 T9 / R4 — AND IT NOW FALLS BACK TO THE ONE THE DESK CAPTURED. That comment used to end
       * "the clerk attaches the slip during registration, long before billing is opened" — which was
       * the intent, with nowhere to attach it to: `attributionCode` was a per-request parameter
       * stored nowhere, so the slip died between the desk and the cashier unless it was re-typed.
       * Migration 0059 gave it a home on the encounter, and this is the read.
       *
       * AN EXPLICIT CODE STILL WINS, because R4 keeps the slip editable at billing and a stored
       * code that overrode the one being typed would make a correction impossible.
       *
       * That alone would NOT be enough, and the hole is worth naming: the billing screen omits the
       * key entirely when its field is blank, so "the cashier cleared it" and "the cashier never
       * touched it" arrive here identically, and the fallback would quietly re-apply the slip they
       * had just removed. The fix is not on this line — it is that `FeeQuote` now RETURNS
       * `attributionCode` so the screen PRE-FILLS it. The field then always shows what is stored,
       * and clearing it is a visible act that travels as a different invoice body.
       */
      attributionCode: opts.attributionCode ?? encounter.attributionCode ?? undefined,
    },
    now,
  );
  return {
    encounterId, visitType: encounter.visitType, free: false, feeServiceId, draft, freeReason: null,
    // Read from the ENCOUNTER, not from `draft.intendedPayer`, so both branches answer identically
    // and the free branch is not a special case the seat has to remember.
    intendedPayer: encounter.intendedPayer,
    // The STORED slip, not `opts.attributionCode`: this field exists so a screen can pre-fill from
    // what the desk captured. Echoing back the caller's own parameter would make it useless.
    attributionCode: encounter.attributionCode,
  };
}
