import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fetchFeeQuote } from "../lib/billing-api";
import type {
  TenderMode, WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult, WirePricedLine,
} from "../lib/billing-api";
import { fmtIst, useDebounced } from "../lib/format";
import { todayIst } from "../lib/opd-api";
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
  quote, issued, canCollect, onConfirm,
}: {
  quote: WireFeeQuote | null;
  issued: WireIssueInvoiceResult | null;
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
            canCollect ? (
              <div data-testid="collect">
                <p>{t("registrationCounter.exit.collect", { amount: quote.draft.totals.netPayablePaise / 100 })}</p>
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
              <button type="button" data-testid="exit-confirm" onClick={() => onConfirm?.()}>
                {t("registrationCounter.exit.next")}
              </button>
            </p>
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
  | "clear-desk" | "close-overlay" | "confirm" | "toggle-queues" | "new-walkin"
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
  overlayOpen: boolean,
): SeatAction | null {
  const mod = e.ctrlKey || e.metaKey;

  // Ctrl+K belongs to the global palette. Claimed by nobody here, on purpose.
  if (mod && (e.key === "k" || e.key === "K")) return null;

  if (e.key === "Escape") return overlayOpen ? "close-overlay" : "clear-desk";
  if (mod && e.key === "Enter") return "confirm";
  if (isTypingTarget(target)) return null;

  if (e.key === "q" || e.key === "Q") return "toggle-queues";
  if (mod && (e.key === "n" || e.key === "N")) return "new-walkin";

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
    <div role="dialog" aria-label={t("registrationCounter.queues.title")} data-testid="queues-overlay">
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
export function RegistrationCounter({
  onRegisterNew,
}: { onRegisterNew?: () => void } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { inHand, release } = usePatientInHand();
  const [overlay, setOverlay] = useState<"queues" | null>(null);
  const [tender, setTender] = useState<TenderMode | null>(null);
  const summaries = useQueueSummary(todayIst());

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
  const { quote, reprice } = useQuote(inHand?.encounterId ?? null);
  useEffect(() => {
    void reprice([]);
  }, [reprice]);

  const clearDesk = useCallback((): void => {
    setOverlay(null);
    setTender(null);
    release();
  }, [release]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = seatKey(e, e.target, overlay !== null);
      switch (action) {
        case "toggle-queues": setOverlay((o) => (o === null ? "queues" : null)); break;
        case "close-overlay": setOverlay(null); break;
        case "clear-desk": clearDesk(); break;
        case "new-walkin": onRegisterNew?.(); break;
        case "tender:cash": case "tender:upi": case "tender:card":
          setTender(action.slice("tender:".length) as TenderMode); break;
        /*
          `confirm` (Ctrl+Enter) IS IN THE MAP AND IS DELIBERATELY NOT CONSUMED HERE.
          The design's `hotEnter` advances whatever stage the seat is on, and this phase's seat has
          exactly one stage: find. The bill and the appointment cross over in RC-4, and *that* is
          when there is something to confirm. Wiring it to a no-op now would put a shortcut in the
          legend that does nothing — worse than an absent one, because a clerk who presses it and
          sees nothing happen stops trusting the legend. It falls through WITHOUT `preventDefault`,
          so Ctrl+Enter still reaches whatever field has focus.
        */
        case "confirm": return;
        case null: return; // Ctrl+K and every unclaimed key belong to the global map
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, clearDesk, onRegisterNew]);

  return (
    <div data-seat="registration-counter" data-testid="registration-counter">
      <h1>{t("registrationCounter.title")}</h1>
      {/*
        `canCollect={false}` and `issued={null}` are the same admission stated twice, and both are
        deliberate for RC-3: this seat issues no invoice, takes no payment and opens no visit, so it
        has neither an `issued` result of its own nor any server signal for one. The `settled` and
        `credit` exits are therefore unreachable HERE — not removed, but unreachable — and RC-4 is
        the phase that brings the bill across and makes all three lawful exits real on this screen.
        Stated here rather than left for a reader to infer from a literal `null`.
      */}
      <Dossier quote={quote} issued={null} canCollect={false} onConfirm={clearDesk} />
      {inHand === null && <FindPanel onRegisterNew={onRegisterNew} />}
      {tender !== null && <p data-testid="tender-chosen">{tender}</p>}
      {overlay === "queues" && <QueuesOverlay items={summaries} onClose={() => setOverlay(null)} />}
    </div>
  );
}
