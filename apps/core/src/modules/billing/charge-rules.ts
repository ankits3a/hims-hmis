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
  opts: { couponCodes?: string[] } = {},
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
    },
    now,
  );
  return { encounterId, visitType: encounter.visitType, free: false, feeServiceId, draft, freeReason: null };
}
