import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../lib/api";
import { billingErrorMessage, fetchFeeQuote, issueInvoice } from "../lib/billing-api";
import type {
  TenderMode, WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult, WirePricedLine, WireTender,
} from "../lib/billing-api";
import { fmtIst, useDebounced } from "../lib/format";
import { COUNTER_SEQUENCES, TOKEN_LANES, getOpdConfig, joinQueue, opdErrorMessage, putCounterFlow, todayIst, walkIn } from "../lib/opd-api";
import type {
  CounterSequence, TokenLane, WireCounterFlow, WireDoctorSummary, WireDuplicateCandidate, WireOpdConfig, WireWalkInBody,
} from "../lib/opd-api";
import { SubmitButton } from "../components/submit-button";
import { TenderEditor } from "../components/tender-editor";
import { MoneyInput } from "../components/money-input";
import { usePaletteOptional } from "../components/command-palette";
import { useAuth } from "../lib/auth";
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
  /**
   * ═══ CLOSE REVIEW F2 (MAJOR) — THE WINNER WAS BEING DRAWN AS A LOSER TOO, ON EVERY REAL QUOTE ═══
   *
   * This read `candidates.filter((c) => c !== winner)`. Server-side that works: `runContest`
   * (`tariff/contest.ts:78`) returns `winner: valid[0]`, a REFERENCE INTO `candidates`. **JSON does
   * not carry references.** `api()` parses the response, so the winner arrives as a structurally
   * equal but referentially distinct object and `c !== winner` is true for every candidate —
   * including the winner. The counter rendered "Member benefit — ₹100 off" and, immediately below
   * it in grey, "Member benefit — not applied (a bigger benefit won)": a money panel contradicting
   * itself about which benefit applied. The total was never wrong (the server's number is printed),
   * which is exactly why it survived.
   *
   * Compared by `(sourceKey, ruleKey)` — the pair already used as the React key below, and the pair
   * `contest.ts:70-76` itself sorts on, so it is the contest's own notion of which candidate this is.
   */
  const line: WirePricedLine | null = quote.draft?.lines[0] ?? null;
  const winner = line?.winner ?? null;
  const sameCandidate = (a: WireAdjustmentCandidate, b: WireAdjustmentCandidate): boolean =>
    a.sourceKey === b.sourceKey && a.ruleKey === b.ruleKey;
  const losers = (line?.candidates ?? []).filter((c) => winner === null || !sameCandidate(c, winner));

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
  /**
   * ═══ CLOSE REVIEW F1 (CRITICAL) — THE QUOTE IS STORED *WITH THE ENCOUNTER IT PRICED* ═══
   *
   * It used to be a bare `WireFeeQuote | null`, and that state outlived its patient. `reprice`
   * returns early when there is no encounter and the `catch` only set `error`, so neither path
   * cleared it — and `clearDesk` did not touch it either. One counter cycle: patient A is priced;
   * the clerk clears the desk; the clerk picks patient B, whom `takePatient` puts in hand with
   * `encounterId: null` (`patient-in-hand.tsx:75`) — and the dossier, now non-empty again, rendered
   * **A's bill under B's name**: A's benefit chips, A's review-window reason (a doctor's name and
   * dates, which is PHI), and "Collect ₹400" for a patient who owes nothing.
   *
   * The fix is not another `setQuote(null)` in a third place — it is making the bad state
   * unrepresentable. The quote is stored WITH the `encounterId` it was fetched for, and the
   * accessor hands it back only when the two still agree. A stale quote cannot be rendered because
   * it cannot be returned, on every path, including the ones nobody has written yet.
   */
  const [priced, setPriced] = useState<{ encounterId: string; quote: WireFeeQuote } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quote = priced !== null && priced.encounterId === encounterId ? priced.quote : null;

  /**
   * `useCallback` WAS ADDED BY THE FIRST CONSUMER, and that is §1 of this phase doc happening to
   * this phase's own code. T1 shipped `reprice` as a plain function — correct for a caller that
   * only ever invokes it from a click. T5's seat has to fetch the quote when a patient arrives,
   * which puts `reprice` in an effect's dependency list, and an unstable identity there is an
   * infinite refetch loop. Nothing was wrong with the rail until something used it.
   */
  const reprice = useCallback(async (couponCodes: string[], attributionCode?: string): Promise<void> => {
    if (encounterId === null) return;
    setError(null);
    try {
      setPriced({ encounterId, quote: await fetchFeeQuote(encounterId, couponCodes, attributionCode) });
    } catch (e) {
      // F13 — and the failed fetch drops the stale price too. A refused or errored quote that
      // leaves the last one on screen is the same defect as F1 arriving by a different road.
      setPriced(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [encounterId]);

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
  quote, issued, canCollect, token, tokenNote, onConfirm, onSettle, settleError,
}: {
  quote: WireFeeQuote | null;
  issued: WireIssueInvoiceResult | null;
  /** RC-4 T3 — D2's "token" noun. `null` until a visit is opened from this seat. */
  token?: number | null;
  /**
   * RC-4 T2 — what stands where the token would be while it is OWED rather than absent: under
   * `bill_first` the number does not exist until the money is taken, and under `token_on_payment`
   * it exists but the slip has not left the printer. A blank line would read as "no visit".
   */
  tokenNote?: "afterPayment" | "joining" | null;
  /**
   * RC-4 T2 — THE SEAT TAKES MONEY, for the visits it opened itself. Present when the caller can
   * settle; the panel is the lifted `counter-desk.tsx` tender block. Absent means F4's answer
   * stands: price, do not instruct.
   */
  onSettle?: (tenders: WireTender[], changeGivenPaise: number | undefined, idempotencyKey: string) => Promise<void>;
  settleError?: string | null;
  /**
   * ═══ CLOSE REVIEW F4 (CRITICAL) — REQUIRED, BECAUSE THE SEAT CANNOT ANSWER IT ═══
   *
   * The seat used to hard-code `issued={null}` into this component. `feeQuote`
   * (`billing/charge-rules.ts`) is a PRICE quote: it reads nothing about issued invoices,
   * allocations or settlement, and no other payment signal reaches this screen — `WireQueueEntryView`
   * still carries no fee status and nothing on the web subscribes to `queue.fee_status_changed`.
   * So the collect guard reduced to `free === false && draft !== null`, which is **true for every
   * chargeable visit whether or not it has been paid**. A clerk who bills a patient at `/counter`,
   * keeps them in hand and switches to the seat — which is precisely the side-by-side comparison
   * D1 asks the owner to make — was shown "Collect ₹400" on a settled encounter. Charging twice.
   *
   * It is REQUIRED rather than defaulted so that every caller has to state which it is. A default
   * of `true` would have preserved exactly the bug, silently, for the next screen to mount this.
   */
  canCollect: boolean;
  onConfirm?: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { inHand } = usePatientInHand();
  const exit = counterExit(quote, issued, inHand?.encounterId != null);

  return (
    <aside aria-label={t("registrationCounter.dossier.title")} data-testid="dossier" className="text-sm">
      {inHand === null ? (
        <p data-testid="dossier-empty" className="text-muted-foreground">{t("registrationCounter.dossier.nobody")}</p>
      ) : (
        <>
          <p data-testid="dossier-patient">{inHand.patientId}</p>
          {inHand.encounterId !== null && <p data-testid="dossier-encounter">{inHand.encounterId}</p>}
          {token != null && (
            <p data-testid="dossier-token" className="text-2xl font-semibold tabular-nums">
              {t("registrationCounter.dossier.token", { token })}
            </p>
          )}
          {token == null && tokenNote != null && (
            <p data-testid={`dossier-token-${tokenNote}`} className="text-muted-foreground">
              {t(`registrationCounter.dossier.token_${tokenNote}`)}
            </p>
          )}

          {quote !== null && <QuotePanel quote={quote} />}

          {/*
            THE TENDER GUARD, and it is the one thing in this component that must not be simplified.
            `counter-desk.tsx` gates collection on `quote.free === false && issued === null &&
            quote.draft !== null`. A free revisit has `draft: null`, so a guard that checked only
            `issued === null` would render a tender panel over a null draft — tender buttons on a ₹0
            bill, which is the mutant this task's assertion book names.
          */}
          {quote?.free === false && issued === null && quote.draft !== null && (
            canCollect ? (
              <div data-testid="collect">
                <p>{t("registrationCounter.exit.collect", { amount: quote.draft.totals.netPayablePaise / 100 })}</p>
                {onSettle !== undefined && (
                  <CollectPanel payablePaise={quote.draft.totals.netPayablePaise} onSettle={onSettle} error={settleError ?? null} />
                )}
              </div>
            ) : (
              /*
                F4 — the PRICE without the INSTRUCTION. A surface that cannot see whether the money
                has already been taken may still say what the visit costs; it may not tell a clerk
                to collect it. The note names where the money is actually taken, so the screen is a
                dead end for the clerk rather than a trap.
              */
              <div data-testid="priced-elsewhere">
                <p>{t("registrationCounter.exit.pricedElsewhere", { amount: quote.draft.totals.netPayablePaise / 100 })}</p>
              </div>
            )
          )}

          {exit !== null && (
            <p data-testid={`exit-${exit}`}>
              {t(`registrationCounter.exit.${exit}`)}
              {/*
                T2's assertion book asks for the exit AND its confirmation — "confirming releases
                the token" — and the confirmation is lifted from `counter-desk.tsx` like the exits
                themselves: its `reset()` ends with `release()`, so acknowledging that the patient
                is served is the same act as clearing the desk for the next one. The seat binds the
                same call to `Esc` (T5's map), because a busy counter reaches for the keyboard; the
                button is what makes the same act discoverable to a clerk on their first day.
              */}
              <button type="button" data-testid="exit-confirm" disabled={onConfirm === undefined} onClick={() => onConfirm?.()}>
                {t("registrationCounter.exit.next")}
              </button>
            </p>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * RC-4 T2 — THE TENDER BLOCK, LIFTED FROM `counter-desk.tsx` (its `collect` div and `settle`).
 *
 * F15 removed a `1/2/3` scaffold from this seat because it could not see whether an encounter had
 * been paid. What changed is not the seat's sight — it is that the seat now OPENS visits itself,
 * and for a visit it opened moments ago it knows there is no invoice yet as surely as `/counter`
 * does: that is `counter-desk.tsx`'s own model, and the same proven money path is reused for it.
 *
 * THE CHANGE LANE IS THE PART THAT MUST NOT BE SIMPLIFIED, and it is copied with its reason:
 * change is declared only when CASH was tendered, and the default is capped at the cash side —
 * the server's M4 ceiling is min(surplus, cash tendered), and a whole-surplus default hard-failed
 * every mixed tender where cash < surplus. A card-side surplus stays a banked advance.
 */
export function CollectPanel({
  payablePaise, onSettle, error,
}: {
  payablePaise: number;
  onSettle: (tenders: WireTender[], changeGivenPaise: number | undefined, idempotencyKey: string) => Promise<void>;
  error: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const [tenders, setTenders] = useState<WireTender[]>([]);
  const [changeGivenPaise, setChangeGivenPaise] = useState<number | undefined>(undefined);

  const tenderedPaise = tenders.reduce((n, x) => n + x.amountPaise, 0);
  const surplusPaise = Math.max(0, tenderedPaise - payablePaise);
  const hasCash = tenders.some((x) => x.mode === "cash");
  const cashTenderedPaise = tenders.reduce((n, x) => n + (x.mode === "cash" ? x.amountPaise : 0), 0);

  return (
    <div data-testid="collect-panel" className="space-y-2">
      <TenderEditor payablePaise={payablePaise} onChange={setTenders} />
      {surplusPaise > 0 && hasCash && (
        <div data-testid="change-lane">
          <p>{t("registrationCounter.collect.surplus", { amount: surplusPaise / 100 })}</p>
          <MoneyInput
            id="rc-change-given" label={t("registrationCounter.collect.changeGiven")}
            value={changeGivenPaise ?? Math.min(surplusPaise, cashTenderedPaise)} onChange={setChangeGivenPaise}
          />
          <p className="text-xs text-muted-foreground">{t("registrationCounter.collect.changeHint")}</p>
        </div>
      )}
      {surplusPaise > 0 && !hasCash && (
        <p data-testid="surplus-no-cash" className="text-muted-foreground">{t("registrationCounter.collect.surplusNoCash")}</p>
      )}
      {error !== null && <p data-testid="settle-error" role="alert">{error}</p>}
      <SubmitButton
        data-testid="settle" disabled={tenders.length === 0}
        onClick={(k) => onSettle(
          tenders,
          surplusPaise > 0 && cashTenderedPaise > 0 ? changeGivenPaise ?? Math.min(surplusPaise, cashTenderedPaise) : undefined,
          k,
        )}
      >
        {t("registrationCounter.collect.settle")}
      </SubmitButton>
    </div>
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
      <label htmlFor="rc-find" className="text-base font-semibold">{t("registrationCounter.find.title")}</label>
      <input
        id="rc-find" data-testid="find-input" value={raw} autoFocus
        className="mt-3 h-12 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
        placeholder={t("registrationCounter.find.placeholder")}
        onChange={(e) => setRaw(e.target.value)}
      />
      <p data-testid="find-hint" className="mt-1 text-xs text-muted-foreground">{t("registrationCounter.find.hint")}</p>

      {/*
        SEARCH-FIRST IS A GUARD, NOT A HEADING. The design states the mechanism in the empty state
        itself — *"Register new … the button only wakes after a real search"* — and that is the
        whole of the ruling: the door to a new record does not exist until a query has been typed
        AND has come back empty. A register-new button on an empty search box is how the duplicate
        this seat exists to prevent gets created, and the hint above it would be advice rather than
        a rail. `!hits.isFetching` is part of the guard: offering the door while the answer is still
        in flight offers it to a clerk whose patient is about to appear.
      */}
      {/*
        CLOSE REVIEW F3 (MAJOR) — AN ERRORED SEARCH IS NOT AN EMPTY ONE, AND THIS IS WHERE THE
        DISTINCTION IS WORTH THE MOST. `App.tsx:8` sets `retry: false`, so a 403 (the seat's route
        needs `opd.visits.open`; the search route needs `patients.read`, and they are not the same
        grant), a 500 or a dropped connection settles immediately with `data === undefined` — which
        read as `items = []` and offered the REGISTER-NEW DOOR. The screen whose stated purpose is
        "a duplicate stopped here costs nothing" invited the clerk to create one at exactly the
        moment the system could not tell them whether the patient already existed.
      */}
      {q.length > 0 && hits.isError && (
        <p data-testid="find-error">{t("registrationCounter.find.searchFailed")}</p>
      )}

      {q.length > 0 && items.length === 0 && !hits.isFetching && !hits.isError && (
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

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-3 T5 — THE KEYBOARD MAP, THE QUEUES OVERLAY, AND THE SEAT ITSELF (D3)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * `1 · 2 · 3` ARE THE TENDER EDITOR'S OWN LANES, IN ITS OWN ORDER.
 *
 * `tender-editor.tsx:23` declares `const MODES: TenderMode[] = ["cash", "upi", "card"]` and renders
 * its buttons in that order; the design's keydown map assigns 1/2/3 to cash/upi/card. Those two
 * facts have to agree or the seat is a money defect: a clerk who presses `2` for the second button
 * they can see, and gets a card payment recorded against a UPI transfer, has created a
 * reconciliation the cashier session will not balance.
 *
 * `MODES` is not exported, so this cannot import it. The alignment is therefore asserted against
 * `tender-editor.tsx` READ AS TEXT — the same discipline `nav-parity.test.ts` uses on `router.tsx`
 * and `membership/guardrails.test.ts` uses on web screens, and for the same reason: an invariant
 * two files both state and neither checks is a claim, not a guarantee.
 */
export const SEAT_TENDER_ORDER: readonly TenderMode[] = ["cash", "upi", "card"];

export type SeatAction =
  | "clear-desk" | "close-overlay" | "confirm" | "toggle-queues"
  | "tender:cash" | "tender:upi" | "tender:card";

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * THE SEAT'S KEY DECISION, EXTRACTED SO IT CAN BE ASSERTED AND MUTATED ON ITS OWN.
 *
 * That is `keyboard.tsx`'s own pattern — `shouldOpenPalette` exists for exactly this reason — and
 * the ORDER of the branches below is lifted from the design's `keydown` handler rather than
 * re-derived, because the order IS the behaviour:
 *
 *   · `Ctrl+K` returns `null`. **The seat does not rebind it.** `KeyboardProvider` already opens the
 *     command palette from anywhere in the application, and a seat that handled it too would either
 *     open the palette twice or shadow the global one with a local imitation. A shortcut a clerk
 *     learns on one screen has to mean the same thing on the next.
 *   · `Escape` is decided BEFORE the typing guard: it closes the overlay if one is open, and clears
 *     the desk otherwise. A clerk hitting Escape with the cursor in the search box means "start
 *     again", and a guard that swallowed it would leave the only way out of a half-served patient
 *     being the mouse.
 *   · While typing, ONLY `Ctrl+Enter` survives. This is the guard that matters: `Q` and `1/2/3` are
 *     bare characters, and a search for "Q Mohan" or a mobile number beginning `1` would otherwise
 *     throw a queue overlay over the screen, or tender a payment, mid-keystroke.
 */
export function seatKey(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  target: EventTarget | null,
  state: { overlayOpen: boolean; modalOpen: boolean },
): SeatAction | null {
  const mod = e.ctrlKey || e.metaKey;

  /**
   * ═══ CLOSE REVIEW F7 (MAJOR) — A MODAL OWNS THE KEYBOARD WHILE IT IS OPEN ═══
   *
   * The seat listens on `window`. The command palette's Escape handler is a REACT `onKeyDown` on
   * its dialog that calls `preventDefault()` and NOT `stopPropagation()` — and React 18 dispatches
   * from the root container, which is below `window`. So the native event always reached this
   * function, `overlayOpen` tracked only the seat's OWN queues overlay, and the branch taken was
   * `clear-desk`.
   *
   * A clerk who pressed Ctrl+K, saw it was not what they wanted, and pressed Esc **lost the patient
   * in hand**, with no message — the exact defect `patient-in-hand.tsx` was built to end ("the
   * simplest walk-in therefore cost three searches for the same person"). Any Escape dismissing a
   * browser autofill dropdown in the search box did it too.
   *
   * This is FIRST and it is total: while a modal is open the seat claims no key at all, not just
   * Escape. Fixing it inside the palette (adding `stopPropagation`) would have fixed this one
   * modal; the rule belongs to whoever is listening globally.
   */
  if (state.modalOpen) return null;

  // Ctrl+K belongs to the global palette. Claimed by nobody here, on purpose.
  if (mod && (e.key === "k" || e.key === "K")) return null;

  if (e.key === "Escape") return state.overlayOpen ? "close-overlay" : "clear-desk";
  if (mod && e.key === "Enter") return "confirm";

  /**
   * ═══ §6.4 RULED — THE SEAT CLAIMS NO NEW-PATIENT CHORD AT ALL, AND THAT IS THE FIX ═══
   *
   * The close review found two things wrong with `Ctrl+N` here. It sat BELOW the typing guard, and
   * the find input carries `autoFocus` — so at the one moment a clerk reaches for the new-patient
   * door, focus is in an `INPUT` and the shortcut did nothing. Moving it up fixed that. But the
   * second finding could not be fixed in this file: **Chrome does not deliver `Ctrl+N` to the page**
   * (non-overridable, new window), and Firefox opens a window regardless of `preventDefault`.
   *
   * Ruled rather than sent up, under the owner's standing rule that an industry-standard choice is
   * decided and only money, procurement or law stops: **`Alt+N`, and it lives in `keyboard.tsx`
   * with its seven siblings.** The seat therefore returns `null` here for exactly the reason it
   * returns `null` for `Ctrl+K` — a shortcut a clerk learns on one screen has to mean the same
   * thing on the next, and a navigation chord belongs to the global map, not to a seat.
   *
   * The `Register new` button remains the mouse path, and `F2` still reaches the same destination.
   */
  if (isTypingTarget(target)) return null;

  if (e.key === "q" || e.key === "Q") return "toggle-queues";

  if (!mod && /^[123]$/.test(e.key)) {
    const lane = SEAT_TENDER_ORDER[Number(e.key) - 1];
    if (lane !== undefined) return `tender:${lane}`;
  }
  return null;
}

/**
 * The day's board for EVERY active doctor — `departmentId` is omitted, which
 * `opd-queue.controller.ts:110` reads as "all of them". The overlay's whole claim is "every line in
 * the building", so a departmental read would make it quietly answer a smaller question.
 */
export function useQueueSummary(serviceDate: string): WireDoctorSummary[] {
  const q = useQuery({
    queryKey: ["rc-queue-summary", serviceDate],
    queryFn: () => api<{ items: WireDoctorSummary[] }>("GET", `/opd/queues/summary?serviceDate=${serviceDate}`),
  });
  return q.data?.items ?? [];
}

/**
 * T5 — "EVERY LINE IN THE BUILDING", behind `Q`.
 *
 * The seat's clerk is asked "kis line mein kam wait hai?" several times an hour and the answer
 * currently lives on a different screen. Each row is T4's `WaitLine`, so the overlay adds a
 * surface and no second wait model.
 */
export function QueuesOverlay({
  items, onClose, now = new Date(),
}: { items: WireDoctorSummary[]; onClose: () => void; now?: Date }): React.ReactElement {
  const { t } = useTranslation();
  const waiting = items.reduce((n, s) => n + s.waitingCount, 0);
  return (
    <div
      role="dialog" aria-label={t("registrationCounter.queues.title")} data-testid="queues-overlay"
      className="fixed inset-x-0 top-16 mx-auto max-h-[76vh] w-[640px] max-w-[92vw] overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg"
    >
      <header>
        <h2>{t("registrationCounter.queues.title")}</h2>
        <span data-testid="queues-total">{t("registrationCounter.queues.total", { count: waiting })}</span>
        <button type="button" data-testid="queues-close" onClick={onClose}>{t("registrationCounter.queues.close")}</button>
      </header>
      <ul>
        {items.map((s) => (
          <li key={s.doctor.id} data-testid={`queues-row-${s.doctor.id}`}>
            <span>{s.doctor.displayName}</span>
            {/*
              THE ONE CONSUMER OF `--seat-faint`, and it exists so the token is not itself a rail
              with no consumer — the defect §1 of this phase doc is entirely about. The design uses
              TWO weights of grey (`--dim` for what a clerk reads, `--faint` for what is merely
              there); the shadcn registry has one muted foreground, so the second weight is a
              seat-local token, and a seat-local token nothing reads would be a colour nobody could
              tell had gone wrong. Resolves inside the seat's root and nowhere else — which is the
              alias layer's scoping doing exactly what D3 asks of it.
            */}
            {s.roomCode !== null && <span style={{ color: "var(--seat-faint)" }}>{s.roomCode}</span>}
            <WaitLine summary={s} now={now} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ═══ DESK ONE. THE SEAT ITSELF. ═══
 *
 * `data-seat="registration-counter"` on the root is not decoration: it is the whole of D3's
 * mechanism. `styles.css`'s alias block hangs off this attribute, so the seat's paper-and-pine
 * palette reaches every shadcn component mounted inside it and reaches nothing outside it. Put
 * this attribute on `<body>` or on the app shell and the mutant the assertion book names has
 * happened — every screen in the application turns green.
 *
 * `counter-desk.tsx` is untouched and still serves `/counter` (D1). RC-4 deletes one of the two,
 * and which one is an owner ruling this phase carries rather than defaults (§6).
 */
export function RegistrationCounter(): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, release } = usePatientInHand();
  const { can } = useAuth();
  const palette = usePaletteOptional();
  const queryClient = useQueryClient();
  const { flow, failed: flowFailed } = useCounterFlow();
  const [overlay, setOverlay] = useState<"queues" | null>(null);
  /**
   * F16 — "start again" has to mean the SEARCH BOX too. `clearDesk` reset the overlay and released
   * the patient and left the typed query sitting there, so Escape on a finished patient left the
   * previous person's mobile number in the box for the next one. `FindPanel` owns its own input
   * state (correctly — it is a control, not session state), so the desk generation REMOUNTS it,
   * which is the one way to clear a child's state without lifting it up for the sake of a reset.
   */
  const [deskGen, setDeskGen] = useState(0);
  /**
   * RC-4 T1 / D1 — the register panel opens IN PLACE. `onRegisterNew` used to navigate to
   * `/registration?new=true`, abandoning the dossier, the search and the patient session to open a
   * form; leaving is the defect this seat exists to remove.
   */
  const [registering, setRegistering] = useState(false);
  /**
   * RC-4 T2 — THE VISIT THIS SEAT OPENED, AND THE INVOICE IT ISSUED, each stored WITH ITS
   * ENCOUNTER (F1's pattern: the bad state is unrepresentable, not cleared in three places). The
   * accessors below hand either back only while the patient in hand still agrees.
   */
  const [visit, setVisit] = useState<SeatVisit | null>(null);
  const [issuedFor, setIssuedFor] = useState<SeatIssued | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const summaries = useQueueSummary(todayIst());
  const encounterId = inHand?.encounterId ?? null;
  const hereVisit = visit !== null && visit.encounterId === encounterId ? visit : null;
  const issued = issuedFor !== null && issuedFor.encounterId === encounterId ? issuedFor.result : null;

  /**
   * THE DRAWER IS THE COUNTER'S PRECONDITION, lifted from `counter-desk.tsx` with its reason: a
   * clerk with a closed drawer cannot FINISH a walk-in, and discovering that at the payment step
   * — after the visit is open — is a half-done walk-in caused purely by the order of the checks.
   * Under `bill_first` it is worse than half-done: a deferred visit with no money and no token is
   * a patient nobody will call. So the drawer is read on mount and the bill-first door is shut
   * without it (`RegisterPanel`), while a queue-first visit that cannot be settled here says so.
   */
  const drawer = useQuery({
    queryKey: ["billing", "sessions", "current"],
    queryFn: () => api<{ session: { id: string; status: "open" | "closing" | "closed" } | null }>("GET", "/billing/sessions/current"),
  });
  const drawerOpen = drawer.data?.session?.status === "open";

  /**
   * D2's "live bill", and the CONTRACT PASS at close is what caught its absence: this screen was
   * handing `quote={null}` into the panel T1 built, so `QuotePanel`, `useQuote`, `freeReason`,
   * `intendedPayer` and the whole benefits contest had no consumer in the assembled seat — inside
   * the phase whose §1 finding is that eight rails shipped with no consumer. Thirty-three green
   * tests did not notice, because every one of them handed `QuotePanel` a quote directly.
   *
   * The seat RE-FETCHES and never computes: the quote already composes the benefits server-side
   * (RC-2's finding), so the money on this screen is the money the invoice will charge.
   */
  const { quote, reprice } = useQuote(encounterId);
  useEffect(() => {
    void reprice([]);
  }, [reprice]);

  const clearDesk = useCallback((): void => {
    setOverlay(null);
    setRegistering(false);
    setVisit(null);
    setIssuedFor(null);
    setSettleError(null);
    setDeskGen((n) => n + 1);
    release();
  }, [release]);

  /**
   * RC-4 T2 — SETTLE, lifted from `counter-desk.tsx:settle`. The draft id is the visit's, stable
   * across attempts; the idempotency key is `SubmitButton`'s, one per attempt — the house
   * convention, and why a corrected retry after a refusal is safe.
   */
  const settle = useCallback(async (tenders: WireTender[], changeGivenPaise: number | undefined, idemKey: string): Promise<void> => {
    if (hereVisit === null || quote === null || quote.draft === null || quote.encounterId !== hereVisit.encounterId) return;
    setSettleError(null);
    try {
      const result = await issueInvoice({
        draftId: hereVisit.draftId,
        patientId: hereVisit.patientId,
        encounterId: hereVisit.encounterId,
        lines: quote.draft.lines.map((l) => ({ lineId: l.lineId, serviceId: l.serviceId, qty: l.qty })),
        receipt: { tenders, ...(changeGivenPaise === undefined ? {} : { changeGivenPaise }) },
      }, idemKey);
      setIssuedFor({ encounterId: hereVisit.encounterId, result });
    } catch (e) {
      setSettleError(billingErrorMessage(e));
    }
  }, [hereVisit, quote]);

  /**
   * ═══ RC-4 T2 / D3 — THE DEFERRED JOIN FIRES AFTER THE MONEY, AND ONLY THEN ═══
   *
   * This effect is the whole of "the token leaves the printer already PAID". `joinQueue` has no
   * settlement gate server-side — the stamp is derived, so the server would stamp an early join
   * UNPAID, truthfully — which means the discipline lives here and nowhere else. `shouldJoinNow`
   * is pure so the mutant the assertion book names (the join firing before settlement) can be
   * applied to it and killed on its own; the effect only carries its answer to the wire.
   */
  useEffect(() => {
    if (!shouldJoinNow(hereVisit, quote, issued)) return;
    const target = hereVisit!;
    setVisit({ ...target, joining: true });
    void joinQueue(target.encounterId).then(
      (r) => setVisit((v) => (v?.encounterId === target.encounterId ? { ...v, joining: false, tokenNo: r.tokenNo } : v)),
      (e: unknown) => setVisit((v) => (v?.encounterId === target.encounterId ? { ...v, joining: false, joinError: opdErrorMessage(e) } : v)),
    );
  }, [hereVisit, quote, issued]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = seatKey(e, e.target, { overlayOpen: overlay !== null, modalOpen: palette?.isOpen ?? false });
      switch (action) {
        case "toggle-queues": setOverlay((o) => (o === null ? "queues" : null)); break;
        case "close-overlay": setOverlay(null); break;
        case "clear-desk": clearDesk(); break;
        /*
          F15 — THE TENDER LANES ARE IN THE MAP AND ARE NOT CONSUMED HERE. RC-4 T2 brought the
          tender block across, but `TenderEditor` owns its own mode buttons and its rows, and a
          bare `1` pressed outside a field has no row to land in; binding the lanes without that
          row would print a mode nothing reads, which is the scaffold F15 removed. Falls through
          WITHOUT `preventDefault`, so the keystroke still reaches the focused field.
        */
        case "tender:cash": case "tender:upi": case "tender:card": return;
        /*
          `confirm` (Ctrl+Enter) IS IN THE MAP AND IS DELIBERATELY NOT CONSUMED HERE.
          The design's `hotEnter` advances whatever stage the seat is on; the stages now cross
          (register → bill → queue) but each has its own submit with its own idempotency key, and
          a chord that "advanced" would have to pick one. Wiring it to a no-op would put a shortcut
          in the legend that does nothing — worse than an absent one. It falls through WITHOUT
          `preventDefault`, so Ctrl+Enter still reaches whatever field has focus.
        */
        case "confirm": return;
        case null: return; // Ctrl+K and every unclaimed key belong to the global map
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, clearDesk, palette?.isOpen]);

  const canCollect = hereVisit !== null && issued === null && drawerOpen;
  const tokenNote: "afterPayment" | "joining" | null =
    hereVisit === null || tokenToShow(hereVisit, quote, issued) !== null ? null
      : hereVisit.joining ? "joining"
        : "afterPayment";

  /**
   * ═══ CLOSE REVIEW F8 (MAJOR) — THE ALIAS LAYER HAD NO CONSUMER ═══
   *
   * T5 shipped eighteen aliased shadcn variables scoped to `[data-seat]` and this screen carried
   * **not one `className` and not one `components/ui` import**. Every element was a bare `div`.
   * So the assertion book's clause — "the alias block changes no computed colour on any OTHER
   * screen" — was true because the block changed no computed colour on ANY screen, this one
   * included, and `/counter/seat` rendered as unstyled HTML: no paper, no pine, no dossier beside a
   * workspace. **§1's own defect — a rail with no consumer — reproduced by the task that ships the
   * theming mechanism.** The reviewers were right to call it MAJOR: the signed-off design was not
   * on screen.
   *
   * What follows is the MECHANISM's consumer, not Desk One's full build-out. `bg-background`,
   * `bg-card`, `text-foreground`, `text-muted-foreground` and `border-border` compile (through
   * `@theme inline`) to `var(--background)` and friends, so they resolve to paper-and-pine inside
   * this root and to the greyscale registry values everywhere else — which is the whole claim D3
   * makes, now actually exercised. The two-column dossier/workspace is the design's shape. The
   * cards, the queue bars and the story chips are RC-4's, and calling this the finished seat would
   * be the overstatement the reviewers just corrected.
   */
  return (
    <div
      data-seat="registration-counter" data-testid="registration-counter"
      className="min-h-screen bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">{t("registrationCounter.title")}</h1>
        {/*
          RC-4 T4 / D5 — the flow, worn openly. A clerk sees which sequence the counter is in and
          a supervisor changes it here; the seat's own walk-in re-reads the server at open (T2), so
          the pill is a display of the truth and never the truth itself. `onSaved` writes the
          SERVER'S answer into the shared query — the same key `opd-vitals` and `opd-consult`
          read — so every consumer in this tab moves with it and none is left on a stale value.
        */}
        <FlowPill
          flow={flow} failed={flowFailed} canManage={can("opd.counter.flow.manage")}
          onSaved={(config) => queryClient.setQueryData(["opd", "config"], config)}
        />
      </header>
      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        {/*
          RC-4 T2 — `canCollect` and `issued` are now ANSWERED rather than admitted. Both are true
          only for the visit THIS seat opened, in this session, with the drawer open: the one case
          in which the seat knows there is no invoice yet, which is exactly the knowledge `/counter`
          has always run on. A patient taken in hand from anywhere else still gets F4's answer —
          the price, and where to pay it.
        */}
        <div className="w-full shrink-0 rounded-lg border border-border bg-card p-4 lg:w-80">
          <Dossier
            quote={quote} issued={issued} canCollect={canCollect}
            token={tokenToShow(hereVisit, quote, issued)} tokenNote={tokenNote}
            onConfirm={tokenNote === "joining" ? undefined : clearDesk} onSettle={settle} settleError={settleError}
          />
          {hereVisit?.joinError != null && (
            <div data-testid="join-failed" role="alert">
              <p>{t("registrationCounter.join.failed", { reason: hereVisit.joinError })}</p>
              <button type="button" data-testid="join-retry" onClick={() => setVisit({ ...hereVisit, joinError: null })}>
                {t("registrationCounter.join.retry")}
              </button>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-4">
          {inHand === null && (registering
            ? <RegisterPanel doctors={summaries} drawerOpen={drawerOpen} onCancel={() => setRegistering(false)}
                onOpened={(o) => { setVisit(o); setRegistering(false); }} />
            : <FindPanel key={deskGen} onRegisterNew={() => setRegistering(true)} />)}
          {/*
            RC-4 T2 — THE EXISTING PATIENT'S DOOR. `takePatient` puts a found patient in hand with
            `encounterId: null` (`patient-in-hand.tsx`), and until now the workspace went blank
            there: the seat could FIND a returning patient and could not open their visit —
            `walkInBodyFor`'s `existingId` branch was exported, unit-tested and consumed by nothing.
            The same panel serves, with the four fields folded away.
          */}
          {inHand !== null && inHand.encounterId === null && (
            <RegisterPanel doctors={summaries} drawerOpen={drawerOpen} existingId={inHand.patientId}
              onOpened={(o) => setVisit(o)} />
          )}
        </div>
      </div>
      {overlay === "queues" && <QueuesOverlay items={summaries} onClose={() => setOverlay(null)} />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T4 — THE FLOW PILL, WORN OPENLY (D5)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The pill polls at the ops-mode cadence (`command-palette.tsx`): two counters converge within it. */
export const FLOW_POLL_MS = 15_000;

/**
 * THE HOSPITAL'S CURRENT FLOW, READ FROM THE SERVER AND NOWHERE ELSE.
 *
 * D5 as originally written said the pill reads "the department the seat is working under". That
 * was wrong, and measuring for this task corrected it: `counter_sequence` and `token_lane` are two
 * columns on `opd_config` (`kernel/db/schema/opd.ts:36`), HOSPITAL-WIDE — one setting for every
 * counter, not one per department. So the pill has exactly one source of truth, `GET /opd/config`,
 * and two counters that showed different sequences would be showing a stale cache, which is the
 * mutant the assertion book names. Hence: polled, never trusted past the poll, and the walk-in
 * itself re-reads at the moment of opening (T2) so the poll's staleness can never reach the wire.
 */
export function useCounterFlow(): { flow: WireCounterFlow | null; failed: boolean } {
  const q = useQuery({
    queryKey: ["opd", "config"],
    queryFn: getOpdConfig,
    refetchInterval: FLOW_POLL_MS,
    staleTime: 0,
  });
  const flow = q.data === undefined ? null : { counterSequence: q.data.counterSequence, tokenLane: q.data.tokenLane };
  return { flow, failed: q.isError };
}

/**
 * The pill. A clerk SEES which sequence the counter is in; only a holder of
 * `opd.counter.flow.manage` (the front-office supervisor, by RC-1's ruling — narrower than
 * `opd.config.manage` on purpose) gets the controls. The write is `PUT /opd/config/counter-flow`,
 * whose body is EXACTLY the two flow keys: `putCounterFlow` sends one key at a time and the
 * server's zod strips anything else, so this control cannot be widened into a config editor by
 * accident. What the pill shows after a write is what the SERVER RETURNED, never what was asked.
 */
export function FlowPill({
  flow, failed, canManage, onSaved,
}: {
  flow: WireCounterFlow | null;
  failed: boolean;
  canManage: boolean;
  onSaved: (config: WireOpdConfig) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function change(patch: Partial<WireCounterFlow>): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      onSaved(await putCounterFlow(patch));
    } catch (e) {
      setError(opdErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="flow-pill" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t("registrationCounter.flow.label")}</span>
      {flow === null ? (
        <span data-testid={failed ? "flow-unknown" : "flow-loading"} className="text-muted-foreground">
          {t(failed ? "registrationCounter.flow.unknown" : "registrationCounter.flow.loading")}
        </span>
      ) : canManage ? (
        <>
          <select
            data-testid="flow-sequence" aria-label={t("registrationCounter.flow.sequence")} value={flow.counterSequence}
            disabled={saving} onChange={(e) => void change({ counterSequence: e.target.value as CounterSequence })}
            className="h-8 rounded-md border border-input bg-background px-2"
          >
            {COUNTER_SEQUENCES.map((seq) => (
              <option key={seq} value={seq}>{t(`registrationCounter.flow.${seq}`)}</option>
            ))}
          </select>
          {/* The lane is meaningful only under queue_first (RC-1 D3); under bill_first it is not offered. */}
          {flow.counterSequence === "queue_first" && (
            <select
              data-testid="flow-lane" aria-label={t("registrationCounter.flow.lane")} value={flow.tokenLane}
              disabled={saving} onChange={(e) => void change({ tokenLane: e.target.value as TokenLane })}
              className="h-8 rounded-md border border-input bg-background px-2"
            >
              {TOKEN_LANES.map((lane) => (
                <option key={lane} value={lane}>{t(`registrationCounter.flow.${lane}`)}</option>
              ))}
            </select>
          )}
        </>
      ) : (
        <>
          <span data-testid="flow-sequence" className="rounded-full border border-border px-2 py-0.5">
            {t(`registrationCounter.flow.${flow.counterSequence}`)}
          </span>
          {flow.counterSequence === "queue_first" && (
            <span data-testid="flow-lane" className="rounded-full border border-border px-2 py-0.5">
              {t(`registrationCounter.flow.${flow.tokenLane}`)}
            </span>
          )}
          <span data-testid="flow-locked" className="text-muted-foreground">{t("registrationCounter.flow.locked")}</span>
        </>
      )}
      {error !== null && <span data-testid="flow-error" role="alert">{t("registrationCounter.flow.saveFailed", { reason: error })}</span>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T2 — BILL-FIRST: THE DEFERRED JOIN, AND WHEN THE TOKEN MAY BE SHOWN (D3)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The visit THIS seat opened. `tokenNo` is a number from the walk-in under `queue_first` and
 * `null` under `bill_first` until `joinQueue` fills it — `WireWalkInDeferredResult`'s own shape.
 * The flow is recorded AT OPEN, because the flow decides whether a join is still owed, and a
 * supervisor flipping the pill mid-visit must not change what this visit already is.
 */
export type SeatVisit = {
  encounterId: string;
  patientId: string;
  tokenNo: number | null;
  flow: WireCounterFlow;
  /** The invoice DRAFT id, stable for this visit — not an idempotency key (`counter-desk.tsx`). */
  draftId: string;
  joining: boolean;
  joinError: string | null;
};

export type SeatIssued = { encounterId: string; result: WireIssueInvoiceResult };

/** Lifted from `counter-desk.tsx:newIdemKey` — the draft id is minted once per visit, not per attempt. */
export function newDraftId(): string {
  return `seat-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * "THE MONEY IS TAKEN" — the one predicate both the join and the token lane read. All three
 * lawful exits count: settled, credit-extended, or a free revisit with no invoice at all. Every
 * term is matched on the VISIT'S encounter, so a quote or an invoice for the last patient can
 * never answer for this one (F1's class).
 */
export function moneyDone(visit: SeatVisit, quote: WireFeeQuote | null, issued: WireIssueInvoiceResult | null): boolean {
  if (issued !== null) return true;
  return quote !== null && quote.encounterId === visit.encounterId && quote.free === true;
}

/**
 * THE JOIN FIRES AFTER THE MONEY, AND ONLY UNDER `bill_first`. The mutant the assertion book
 * names is this function returning true on a priced, unissued visit — an UNPAID token on the
 * board in the one lane whose entire purpose is that it never appears. A failed join stays
 * failed until the clerk retries (`joinError` cleared), so a refusal does not loop.
 */
export function shouldJoinNow(visit: SeatVisit | null, quote: WireFeeQuote | null, issued: WireIssueInvoiceResult | null): boolean {
  if (visit === null || visit.flow.counterSequence !== "bill_first") return false;
  if (visit.tokenNo !== null || visit.joining || visit.joinError !== null) return false;
  return moneyDone(visit, quote, issued);
}

/**
 * WHICH NUMBER THE CLERK MAY READ OUT. `token_lane` is "printing and stamps only" (RC-1 D3): under
 * `queue_first` + `token_on_payment` the number exists from the join but the slip does not leave
 * the printer until the money — so the dossier holds it back the same way. Under `bill_first` the
 * lane is meaningless and the number simply does not exist until the join.
 */
export function tokenToShow(visit: SeatVisit | null, quote: WireFeeQuote | null, issued: WireIssueInvoiceResult | null): number | null {
  if (visit === null || visit.tokenNo === null) return null;
  if (visit.flow.counterSequence === "queue_first" && visit.flow.tokenLane === "token_on_payment" && !moneyDone(visit, quote, issued)) {
    return null;
  }
  return visit.tokenNo;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T1 — THE SEAT OPENS A VISIT, AND REGISTERS IN FOUR FIELDS WITHOUT LEAVING (D1 / D2)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The design's four: name · mobile · age · sex (`desk-one.html`'s `nm/mob/age/sex`). */
export type SeatRegisterFields = { name: string; phone: string; ageYears: string; sex: string };

export const EMPTY_REGISTER: SeatRegisterFields = { name: "", phone: "", ageYears: "", sex: "unknown" };

/**
 * THE WALK-IN BODY, AS A PURE FUNCTION — extracted for the reason `seatKey` and `counterExit` are.
 *
 * It is LIFTED from `counter-desk.tsx:135-150` rather than re-derived (D2), because that is a
 * proven money path and the point of building this seat beside the old screen is that a reviewer
 * can see this half is unchanged. What is added is the design's fourth field: `ageYears`, which
 * `registerBody` accepts (`patients.controller.ts:89`, `int 0..130`) and the old screen never sent.
 *
 * ═══ THE THREE THINGS THAT ARE EASY TO GET WRONG HERE, AND ARE NOT ARBITRARY ═══
 *
 * 1. **`ageYears` is a NUMBER on the wire and a STRING in the field.** An empty box must send
 *    NOTHING rather than `0` — a patient recorded as a newborn because the clerk left the age
 *    blank is a worse error than an absent age, and `0` is a legal value the schema accepts.
 * 2. **An empty phone is OMITTED, not sent as `""`.** The old screen does this and it matters: the
 *    registration schema's phone is optional, and an empty string is a value rather than an absence.
 * 3. **`sex` and NOT `administrativeGender`.** `registerBody` declares `sex`; zod strips unknown
 *    keys, so the other spelling would vanish silently — the exact defect Plan 22c-A's close review
 *    found as its C1, where a PATCH carrying `administrativeGender` returned HTTP 200 with nothing
 *    written. The wrong field name here fails the same way: quietly, with a success code.
 */
export function walkInBodyFor(
  patient: { existingId: string } | { fields: SeatRegisterFields },
  doctor: WireDoctorSummary,
  acknowledgeDuplicates: boolean,
): WireWalkInBody {
  const identity: WireWalkInBody["patient"] = "existingId" in patient
    ? { existingId: patient.existingId }
    : {
        register: {
          name: patient.fields.name.trim(),
          sex: patient.fields.sex,
          ...(patient.fields.phone.trim() === "" ? {} : { phone: patient.fields.phone.trim() }),
          ...(patient.fields.ageYears.trim() === "" ? {} : { ageYears: Number(patient.fields.ageYears) }),
        },
      };
  return {
    patient: identity,
    departmentId: doctor.doctor.departmentId,
    doctorId: doctor.doctor.id,
    ...(acknowledgeDuplicates ? { acknowledgedDuplicates: true } : {}),
  };
}

/**
 * T1 — REGISTER IN PLACE. THE SEAT NO LONGER NAVIGATES AWAY (D1).
 *
 * RC-3's `Register new` button called `onRegisterNew`, which left for `/registration?new=true` —
 * and leaving is the defect this seat exists to remove. The clerk had a dossier, a search and a
 * patient session in hand, and the only way to create a record abandoned all three. Four fields,
 * inline, with `usePatientInHand` intact across the whole act.
 *
 * The duplicate path is lifted too, and it is the one branch that must not be simplified: the
 * server refuses a suspicious registration with **409 + `detail.candidates`**, and the clerk's
 * answer — "no, these are different people" — comes back as `acknowledgedDuplicates: true`. A panel
 * that swallowed the 409 would leave the clerk at a dead end in front of a waiting patient, which
 * is worse than the duplicate it was trying to prevent.
 */
export function RegisterPanel({
  doctors, drawerOpen, existingId, onCancel, onOpened,
}: {
  doctors: WireDoctorSummary[];
  /** RC-4 T2 — the bill-first door is shut without a drawer: a deferred visit with no money is a patient nobody calls. */
  drawerOpen: boolean;
  /** RC-4 T2 — a patient already on file: the four fields fold away and only the doctor is asked. */
  existingId?: string;
  onCancel?: () => void;
  onOpened?: (opened: SeatVisit) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { takePatient, takeEncounter } = usePatientInHand();
  const [fields, setFields] = useState<SeatRegisterFields>(EMPTY_REGISTER);
  const [doctorId, setDoctorId] = useState("");
  const [duplicates, setDuplicates] = useState<WireDuplicateCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doctor = doctors.find((d) => d.doctor.id === doctorId) ?? null;
  const ready = (existingId !== undefined || fields.name.trim() !== "") && doctor !== null;

  const set = (k: keyof SeatRegisterFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => {
    setFields((f) => ({ ...f, [k]: e.target.value }));
  };

  async function open(acknowledgeDuplicates: boolean, idempotencyKey: string): Promise<void> {
    if (doctor === null) return;
    setError(null);
    setDuplicates(null);
    try {
      /*
        RC-4 T2 — THE FLOW IS READ AT THE MOMENT OF OPENING, not from a cache. `counter_sequence`
        is hospital-wide and a supervisor can flip it from another counter; a seat that opened on
        a cached value would send a queue-first walk-in under bill-first — a token before the
        money, in the lane whose purpose is that there is none. One GET per registration is the
        price, and it is the same route the pill reads.
      */
      const config = await getOpdConfig();
      const flow: WireCounterFlow = { counterSequence: config.counterSequence, tokenLane: config.tokenLane };
      if (flow.counterSequence === "bill_first" && !drawerOpen) {
        setError(t("registrationCounter.register.drawerNeeded"));
        return;
      }
      const body = walkInBodyFor(existingId === undefined ? { fields } : { existingId }, doctor, acknowledgeDuplicates);
      const result = flow.counterSequence === "bill_first"
        ? await walkIn({ ...body, join: "defer" }, idempotencyKey)
        : await walkIn(body, idempotencyKey);
      takePatient(result.patientId);
      takeEncounter(result.encounter.id);
      /*
        RC-4 T3 / D2's "token" noun — and it costs NO extra fetch. `WireWalkInResult` extends
        `WireOpenVisitResult`, which has carried `tokenNo` since 07b; the seat was throwing it
        away. Under `bill_first` it is NULL here by the wire's own shape (`WireWalkInDeferredResult`)
        and `joinQueue` fills it after the money. The PAID stamp itself lives on the BOARD (D7).
      */
      onOpened?.({
        encounterId: result.encounter.id, patientId: result.patientId, tokenNo: result.tokenNo,
        flow, draftId: newDraftId(), joining: false, joinError: null,
      });
    } catch (e) {
      // LIFTED VERBATIM: a 409 carrying candidates is a QUESTION, not a failure.
      if (e instanceof ApiError && e.status === 409) {
        const detail = (e.body as { detail?: { candidates?: WireDuplicateCandidate[] } } | undefined)?.detail;
        if (detail?.candidates !== undefined) { setDuplicates(detail.candidates); return; }
      }
      setError(opdErrorMessage(e));
    }
  }

  return (
    <section aria-label={t(existingId === undefined ? "registrationCounter.register.title" : "registrationCounter.register.existingTitle")} data-testid="register-panel" className="text-sm">
      <h2 className="text-base font-semibold">
        {t(existingId === undefined ? "registrationCounter.register.title" : "registrationCounter.register.existingTitle")}
      </h2>

      {existingId === undefined && <>
      <label htmlFor="rc-reg-name">{t("registrationCounter.register.name")}</label>
      <input id="rc-reg-name" data-testid="reg-name" value={fields.name} onChange={set("name")}
        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3" />

      <label htmlFor="rc-reg-phone">{t("registrationCounter.register.phone")}</label>
      <input id="rc-reg-phone" data-testid="reg-phone" inputMode="numeric" value={fields.phone} onChange={set("phone")}
        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3" />

      <label htmlFor="rc-reg-age">{t("registrationCounter.register.ageYears")}</label>
      <input id="rc-reg-age" data-testid="reg-age" inputMode="numeric" value={fields.ageYears} onChange={set("ageYears")}
        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3" />

      <label htmlFor="rc-reg-sex">{t("registrationCounter.register.sex")}</label>
      <select id="rc-reg-sex" data-testid="reg-sex" value={fields.sex} onChange={set("sex")}
        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3">
        <option value="unknown">{t("registrationCounter.register.sexUnknown")}</option>
        <option value="male">{t("registrationCounter.register.sexMale")}</option>
        <option value="female">{t("registrationCounter.register.sexFemale")}</option>
        <option value="other">{t("registrationCounter.register.sexOther")}</option>
      </select>
      </>}

      <label htmlFor="rc-reg-doctor">{t("registrationCounter.register.doctor")}</label>
      <select id="rc-reg-doctor" data-testid="reg-doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}
        className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3">
        <option value="">{t("registrationCounter.register.pickDoctor")}</option>
        {doctors.map((d) => (
          <option key={d.doctor.id} value={d.doctor.id}>
            {d.doctor.displayName} · {d.waitingCount}
          </option>
        ))}
      </select>

      {duplicates !== null && (
        <div data-testid="reg-duplicates" role="alert">
          <p>{t("registrationCounter.register.duplicateWarning")}</p>
          <ul>
            {duplicates.map((c) => (
              <li key={c.id} data-testid={`reg-dup-${c.id}`}>{c.name ?? "—"} · {c.uhid}</li>
            ))}
          </ul>
          {/*
            THE WAY THROUGH. Without it a near-match is a dead end at a counter with a queue behind
            it — the clerk can neither proceed nor explain why. The acknowledgement is the clerk's
            judgement, recorded, which is what `acknowledgedDuplicates` is for.
          */}
          <SubmitButton data-testid="reg-acknowledge" onClick={(k) => open(true, k)}>
            {t("registrationCounter.register.registerAnyway")}
          </SubmitButton>
        </div>
      )}

      {error !== null && <p data-testid="reg-error" role="alert">{error}</p>}

      <SubmitButton data-testid="reg-submit" disabled={!ready} onClick={(k) => open(false, k)}>
        {t(existingId === undefined ? "registrationCounter.register.submit" : "registrationCounter.register.openVisit")}
      </SubmitButton>
      {onCancel !== undefined && (
        <button type="button" data-testid="reg-cancel" onClick={onCancel}>{t("registrationCounter.register.cancel")}</button>
      )}
    </section>
  );
}
