import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchFeeQuote } from "../lib/billing-api";
import type { WireAdjustmentCandidate, WireFeeQuote, WirePricedLine } from "../lib/billing-api";

/**
 * RC-3 — DESK ONE, THE REGISTRATION COUNTER SEAT.
 *
 * ═══ THIS SCREEN IS NEW AND `counter-desk.tsx` STAYS (D1) ═══
 *
 * The shipped counter (07b T3) is a LINEAR three-phase flow — `find | opened | done`, one walk-in
 * start to finish. Desk One is a persistent DOSSIER with a workspace beside it, where the patient
 * stays in hand across register → queue → bill → appointment. That is a different shape, not a
 * longer version of the same one.
 *
 * Rewriting in place would have put a PROVEN money path and an UNPROVEN layout in one diff, and a
 * reviewer could not have told which half a defect came from. So the old screen keeps serving until
 * this one is proved, and RC-4 deletes one. Its three lawful exits and its idempotency-key
 * discipline are lifted verbatim in T2, with its own header cited rather than paraphrased.
 *
 * ═══ WHAT THIS PHASE ACTUALLY IS: WIRING (the phase doc's §1) ═══
 *
 * RC-1 and RC-2 shipped EIGHT rails with zero web consumers — `matchedOn` was not even declared in
 * a web type. So almost nothing here is new server behaviour and almost everything is a FIRST
 * CONSUMER, which is the condition under which a rail's design assumptions get tested for the first
 * time. RC-1's CRITICAL (a deferred visit crashing `recordVitals`) was exactly that class.
 */

/** T1 — the money the counter quotes, and WHY it is that number. */
export function QuotePanel({ quote }: { quote: WireFeeQuote }): React.ReactElement {
  const { t } = useTranslation();

  /**
   * D5 / the owner's BEST SINGLE BENEFIT ruling, rendered as a CONTEST rather than a total.
   *
   * `PricedLine.candidates[]` and `.winner` have travelled since Plan 06 (RC-2's spike proved it
   * end to end), so the seat shows which chip won AND why the others lost. It must never sum them:
   * the house rule is one winner per line, and a panel that added two benefits would be showing a
   * number the server will not charge.
   */
  const line: WirePricedLine | null = quote.draft?.lines[0] ?? null;
  const winner = line?.winner ?? null;
  const losers = (line?.candidates ?? []).filter((c) => c !== winner);

  return (
    <section aria-label={t("registrationCounter.quote.title")} data-testid="quote-panel">
      {/*
        D5's second half — a payer-ineligible instrument is ABSENT WITH A REASON, never a losing
        chip. RC-2 T3 deliberately emits no candidate when the payer is not self, because
        `AdjustmentCandidate.rejected` means "contested and refused" and such an instrument was
        never in the contest. Rendering it as a loser would claim a contest that never ran.
      */}
      {quote.intendedPayer !== "self" && (
        <p data-testid="payer-note">{t("registrationCounter.quote.billToPanel", { payer: quote.intendedPayer })}</p>
      )}

      {quote.free ? (
        <div data-testid="free-branch">
          {/*
            RC-1 T5 / D8's `freeReason`, shipped server-side and never rendered until now. The seat
            NAMES the rule — "review visit — free till <date> (<doctor>)" — because a ₹0 bill with no
            story is the one a clerk cannot defend to a patient who expected to pay.
          */}
          <p data-testid="free-reason">
            {quote.freeReason === null
              ? t("registrationCounter.quote.freeNoReason")
              : t("registrationCounter.quote.freeReviewWindow", {
                  doctor: quote.freeReason.doctorName ?? t("registrationCounter.quote.theDoctor"),
                  until: quote.freeReason.windowEndsOn,
                })}
          </p>
          {/* No tender controls at all on this branch — T2 proves that by execution. */}
        </div>
      ) : (
        <div data-testid="priced-branch">
          {winner !== null && (
            <p data-testid="benefit-applied">
              {t("registrationCounter.quote.benefitApplied", {
                reason: winner.reason, amount: winner.amountPaise / 100,
              })}
            </p>
          )}
          {losers.map((c: WireAdjustmentCandidate) => (
            <p key={`${c.sourceKey}:${c.ruleKey ?? ""}`} data-testid="benefit-lost" aria-disabled="true">
              {t("registrationCounter.quote.benefitLost", {
                reason: c.reason,
                why: c.rejected === null ? t("registrationCounter.quote.aBiggerBenefitWon") : c.rejected.detail,
              })}
            </p>
          ))}
          <p data-testid="payable">
            {t("registrationCounter.quote.payable", { amount: (quote.draft?.totals.netPayablePaise ?? 0) / 100 })}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * T1's other half — the codes the clerk is holding travel WITH the question.
 *
 * RC-2 opened both doors server-side (`?coupon=` and `?referral=` on the quote, `couponCodes` and
 * `attributionCode` on both invoice bodies) and no screen ever sent one. This is the first sender.
 */
export function useQuote(encounterId: string | null): {
  quote: WireFeeQuote | null;
  reprice: (couponCodes: string[], attributionCode?: string) => Promise<void>;
  error: string | null;
} {
  const [quote, setQuote] = useState<WireFeeQuote | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reprice(couponCodes: string[], attributionCode?: string): Promise<void> {
    if (encounterId === null) return;
    setError(null);
    try {
      setQuote(await fetchFeeQuote(encounterId, couponCodes, attributionCode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return { quote, reprice, error };
}
