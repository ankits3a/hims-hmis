import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { fetchFeeQuote } from "../lib/billing-api";
import type {
  WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult, WirePricedLine,
} from "../lib/billing-api";
import { fmtIst, useDebounced } from "../lib/format";
import type { WireDoctorSummary } from "../lib/opd-api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { matchReasonKeys, searchPatients } from "../lib/patients-api";
import type { WirePatientHit } from "../lib/patients-api";

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

/**
 * RC-3 T2 / DD2 — THE THREE LAWFUL EXITS, LIFTED VERBATIM FROM `counter-desk.tsx`.
 *
 * The shipped screen's own header states the rule and this seat inherits it unchanged rather than
 * paraphrasing it:
 *
 *   > "Owner ruling R-2 is that nobody passes the counter unbilled, and the system has exactly three
 *   > ways to satisfy that: a settled invoice, a credit-extended invoice with a reason, or a FREE
 *   > REVISIT with no invoice at all … All three are correct and they look nothing alike to the
 *   > patient, so the screen says which one happened rather than leaving the clerk to infer it from
 *   > an empty total."
 *
 * The derivation is copied rather than re-derived on purpose (D1): it is a proven money path, and
 * the point of building the seat beside the old screen instead of on top of it is that a reviewer
 * can see this half is unchanged.
 */
export function counterExit(
  quote: WireFeeQuote | null,
  issued: WireIssueInvoiceResult | null,
  visitOpen: boolean,
): "free" | "settled" | "credit" | null {
  if (!visitOpen) return null;
  if (quote?.free === true) return "free";
  if (issued === null) return null;
  return issued.creditExtended ? "credit" : "settled";
}

/**
 * T2 — THE DOSSIER. A RENDERING of `usePatientInHand`, never a second store (D2).
 *
 * `patient-in-hand.tsx` already carries `{ patientId, encounterId }` across route changes and was
 * built because "four screens each mounted their own PatientPicker with its own useState". The
 * design's accreting left column is that value drawn, plus per-encounter server reads (the quote,
 * the token) which stay server-owned because they are not session state.
 */
export function Dossier({
  quote, issued,
}: { quote: WireFeeQuote | null; issued: WireIssueInvoiceResult | null }): React.ReactElement {
  const { t } = useTranslation();
  const { inHand } = usePatientInHand();
  const exit = counterExit(quote, issued, inHand?.encounterId != null);

  return (
    <aside aria-label={t("registrationCounter.dossier.title")} data-testid="dossier">
      {inHand === null ? (
        <p data-testid="dossier-empty">{t("registrationCounter.dossier.nobody")}</p>
      ) : (
        <>
          <p data-testid="dossier-patient">{inHand.patientId}</p>
          {inHand.encounterId !== null && <p data-testid="dossier-encounter">{inHand.encounterId}</p>}

          {quote !== null && <QuotePanel quote={quote} />}

          {/*
            THE TENDER GUARD, and it is the one thing in this component that must not be simplified.
            `counter-desk.tsx` gates collection on `quote.free === false && issued === null &&
            quote.draft !== null`. A free revisit has `draft: null`, so a guard that checked only
            `issued === null` would render a tender panel over a null draft — tender buttons on a ₹0
            bill, which is the mutant this task's assertion book names.
          */}
          {quote?.free === false && issued === null && quote.draft !== null && (
            <div data-testid="collect">
              <p>{t("registrationCounter.exit.collect", { amount: quote.draft.totals.netPayablePaise / 100 })}</p>
            </div>
          )}

          {exit !== null && (
            <p data-testid={`exit-${exit}`}>{t(`registrationCounter.exit.${exit}`)}</p>
          )}
        </>
      )}
    </aside>
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-3 T4 — SEARCH-FIRST FIND WITH MATCH REASONS, AND THE WAIT MODEL (D6 / D7)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * D7 — WAIT v0, AND IT IS PURE WITH `now` AS A PARAMETER.
 *
 * `waitingCount × avgConsultMinutes`, rendered as minutes AND a clock time. The design's own legend
 * says why both: *"wait shown as minutes and a clock time, because patients ask 'kitne baje?'"* — a
 * relative number is what the clerk reasons with and an absolute one is what the patient goes and
 * sits down on.
 *
 * ═══ THE ARITHMETIC IS CLIENT-SIDE ON PURPOSE, AND THE SEAM IS THE COLUMN ═══
 *
 * RC-1's D7 ruled it so: a future pace model (per-doctor observed service time, time-of-day decay,
 * anything) replaces THIS COLUMN'S READ and never the wire shape. Putting the multiplication on the
 * server would have made the wire carry a computed minute count, and then the model change is a
 * wire change and every consumer moves with it.
 *
 * ═══ `now` IS A PARAMETER BECAUSE A DEFAULT `new Date()` IS A CALENDAR BOMB ═══
 *
 * The 18a lane spent a debugging session this week on exactly this shape (ledger §2.158): a fixture
 * that mixed a fictional clock with the real one passed for as long as the real clock happened to
 * agree with it. A function that reads the wall clock internally cannot be asserted at 10:00 — the
 * caller supplies the instant, the test supplies a fixed one, and the component's default is the
 * ONLY place `new Date()` appears.
 */
export function waitEstimate(
  waitingCount: number, avgConsultMinutes: number, now: Date,
): { minutes: number; clock: string } {
  const minutes = waitingCount * avgConsultMinutes;
  return { minutes, clock: fmtIst(new Date(now.getTime() + minutes * 60_000).toISOString()) };
}

/**
 * T4 — the wait line for one doctor's queue: how many are ahead, how long, and by when.
 *
 * `avgConsultMinutes` is read off the summary row and never defaulted here. It reaches this
 * component because T4 widened `WireDoctorSummary` to declare a field the server had been sending
 * since RC-1 — the fallback for an unreadable department already lives once, server-side, in
 * `summaryByDoctor`.
 */
export function WaitLine({
  summary, now = new Date(),
}: { summary: WireDoctorSummary; now?: Date }): React.ReactElement {
  const { t } = useTranslation();
  const { minutes, clock } = waitEstimate(summary.waitingCount, summary.avgConsultMinutes, now);
  return (
    <span data-testid={`wait-${summary.doctor.id}`}>
      {t("registrationCounter.wait.ahead", { count: summary.waitingCount })}
      {" · "}
      {t("registrationCounter.wait.line", { minutes, clock })}
    </span>
  );
}

/**
 * T4 — SEARCH FIRST. The owner's ruling for this seat and the first thing the design says on the
 * screen: *"Search before you type a single form field — a duplicate stopped here costs nothing."*
 *
 * Picking a row takes the patient IN HAND (`takePatient`) rather than navigating. That is the whole
 * difference between this seat and `counter-desk.tsx`'s linear flow: the dossier is a rendering of
 * `usePatientInHand` (D2), so the act of choosing a person is the act that fills the left column,
 * and it survives every route change afterwards.
 */
export function FindPanel({ onRegisterNew }: { onRegisterNew?: () => void } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { takePatient } = usePatientInHand();
  const [raw, setRaw] = useState("");
  const q = useDebounced(raw.trim(), 200);

  const hits = useQuery({
    queryKey: ["rc-patient-search", q],
    queryFn: () => searchPatients(q),
    enabled: q.length > 0,
  });
  const items: WirePatientHit[] = hits.data ?? [];

  return (
    <section aria-label={t("registrationCounter.find.title")} data-testid="find-panel">
      <label htmlFor="rc-find">{t("registrationCounter.find.title")}</label>
      <input
        id="rc-find" data-testid="find-input" value={raw} autoFocus
        placeholder={t("registrationCounter.find.placeholder")}
        onChange={(e) => setRaw(e.target.value)}
      />
      <p data-testid="find-hint">{t("registrationCounter.find.hint")}</p>

      {/*
        SEARCH-FIRST IS A GUARD, NOT A HEADING. The design states the mechanism in the empty state
        itself — *"Register new … the button only wakes after a real search"* — and that is the
        whole of the ruling: the door to a new record does not exist until a query has been typed
        AND has come back empty. A register-new button on an empty search box is how the duplicate
        this seat exists to prevent gets created, and the hint above it would be advice rather than
        a rail. `!hits.isFetching` is part of the guard: offering the door while the answer is still
        in flight offers it to a clerk whose patient is about to appear.
      */}
      {q.length > 0 && items.length === 0 && !hits.isFetching && (
        <p data-testid="find-none">
          {t("registrationCounter.find.none")}
          <button type="button" data-testid="find-register-new" onClick={() => onRegisterNew?.()}>
            {t("registrationCounter.find.registerNew")}
          </button>
        </p>
      )}

      <ul>
        {items.map((hit) => (
          <li key={hit.id}>
            <button type="button" data-testid={`find-hit-${hit.id}`} onClick={() => takePatient(hit.id)}>
              <span data-testid={`find-name-${hit.id}`}>{hit.name}</span>
              <span data-testid={`find-uhid-${hit.id}`}>{hit.uhid}</span>
              {hit.phone !== null && <span data-testid={`find-phone-${hit.id}`}>{hit.phone}</span>}
              {/*
                D6 — REASONS, NEVER A SCORE. `matchReasonKeys` is where the ruling is enforceable
                and it is unit-asserted there; this renders exactly what it returns, in order, and
                has no arithmetic of its own to get wrong. A row the server explained gets its
                lanes; a row it did not gets "on file", so no row is ever the only unexplained one.
              */}
              <span data-testid={`find-why-${hit.id}`}>
                {matchReasonKeys(hit.matchedOn).map((key) => (
                  <span key={key} data-testid={`find-reason-${hit.id}`}>{t(key)}</span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
