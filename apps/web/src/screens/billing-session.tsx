import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoneyInput } from "../components/money-input";
import { SubmitButton } from "../components/submit-button";
import { fmtIst, fmtPaise } from "../lib/format";
import { api } from "../lib/api";
import { billingErrorCode, billingErrorMessage } from "../lib/billing-api";
import { useAuth } from "../lib/auth";
import "../styles/paper-pine.css";
import "./billing-session.css";

/**
 * THE CASHIER SESSION SCREEN (Plan 08 T15 / D9) — the drawer: open it with a float, count it down
 * note by note, and close it.
 *
 *  · THE DENOMINATION FOLD IS THE MONEY ASSERTION (K43). The rows are rupee denominations and the
 *    keys the server accepts are PAISE — face value × 100 — so the counted total this screen shows
 *    the cashier is `Σ denominationPaise(row) × count`, the SAME fold `sumDenominations`
 *    (`modules/billing/cash-math.ts`) runs over the JSONB she posts. Dropping the ×100 would show
 *    her ₹71.00 where the drawer holds ₹7,100.00 and file a variance approval for the difference.
 *  · THE TEN ROWS ARE THE SERVER'S TEN. `CASH_DENOMINATIONS_PAISE` is a hardcoded list in the
 *    server module, not `billing_config` data (pipeline A carried item 10); a key it does not know
 *    is refused `invalid_paise`, so this grid matches it key for key and in its order.
 *  · A VARIANCE LOCKS THE CASHIER OUT, and the screen says so. `beginClose` moves a non-zero
 *    variance to `closing`, `requireOpenSession` accepts only `open`, and a `billing_variance`
 *    approval is filed BY THE CASHIER so the kernel's requester/approver SoD makes the approver
 *    someone else, structurally (D9/K13). Correct by design and operationally surprising — pipeline
 *    A carried it as item 18 precisely so this screen would render the consequence rather than let
 *    her find it at the next receipt.
 *  · THE VARIANCE IS RENDERED SIGNED. `fmtPaise(-172000)` is `-₹1,720.00`; a magnitude would tell
 *    her the drawer is wrong without telling her which way.
 *  · A CLOSED DRAWER IS NOT A CURRENT ONE. `GET /billing/sessions/current` serves only `open` and
 *    `closing` rows, so the day summary is held from the close RESPONSE — refetching would answer
 *    `null` and the figures would vanish the moment they mattered.
 *
 * `refetchInterval` follows the 15 s convention; T13's counter owns that convention's teeth
 * (K39/W-3) and this screen's assertion is presence only, stated as such in the suite.
 */
const POLL_MS = 15_000;

/** The rupee rows the cashier counts, high to low — the face values of `CASH_DENOMINATIONS_PAISE`. */
const DENOMINATION_RUPEES = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

/** The PAISE key of a rupee row: face value × 100. The only keys `beginClose` will accept. */
function denominationPaise(rupees: number): number {
  return rupees * 100;
}

/** A note count: blank is a legal zero, and nothing but a positive safe integer counts as notes. */
function noteCount(text: string | undefined): number {
  if (text === undefined || text.trim() === "") return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * THE FOLD — `sumDenominations`'s client-side twin. Σ over the rows of PAISE × count. The ×100
 * lives in `denominationPaise` and nowhere else, so there is exactly one place this arithmetic can
 * be got wrong and exactly one assertion (K43) standing over it.
 */
function countedCashPaise(counts: Record<number, string>): number {
  let total = 0;
  for (const rupees of DENOMINATION_RUPEES) {
    total += denominationPaise(rupees) * noteCount(counts[rupees]);
  }
  return total;
}

/** The counted rows only, keyed in paise — an empty object is a legal zero count, not an error. */
function countedDenominations(counts: Record<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rupees of DENOMINATION_RUPEES) {
    const n = noteCount(counts[rupees]);
    if (n > 0) out[String(denominationPaise(rupees))] = n;
  }
  return out;
}

/** `cashier_sessions.$inferSelect` at the wire — timestamps ISO, money integer paise. */
type WireCashierSession = {
  id: string;
  cashierUserId: string;
  status: "open" | "closing" | "closed";
  openedAt: string;
  openingFloatPaise: number;
  denominations: Record<string, number> | null;
  countedCashPaise: number | null;
  expectedCashPaise: number | null;
  variancePaise: number | null;
  varianceApprovalId: string | null;
  closeNote: string | null;
  closedAt: string | null;
};

/**
 * The slice of the kernel's `approvals` row this screen reads (`GET /approvals/:id`), and only for a
 * reader who holds `approvals.requests.read` — which the seeded `cashier` role does NOT.
 */
type WireVarianceApproval = {
  status: "pending" | "granted" | "rejected";
  requestedAt: string;
};

/**
 * UX-AUDIT 2026-09-28 — `GET /billing/sessions/current/open-items`: what is still open on the
 * caller's own live drawer. It carries NO CASH FIGURE by construction (`drawer-open-items.ts`) —
 * the close is a blind count — so nothing here can leak the expected total before she has counted.
 */
type WireOpenItems = {
  receipts: number;
  nonCashUnconfirmed: { count: number; paise: number };
  nonCashMismatched: { count: number; paise: number };
  refundsQueued: { count: number; paise: number };
  refundsPaidHere: number;
  partPaid: {
    count: number;
    paise: number;
    items: { invoiceId: string; invoiceNo: string; outstandingPaise: number; patientName: string | null; uhid: string | null }[];
  };
};

export function BillingSession(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();

  const [floatPaise, setFloatPaise] = useState<number | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [closeLane, setCloseLane] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  /* FD-11 — the re-count is opt-in: a button, then a reason, then the withdrawal. Never one click. */
  const [recounting, setRecounting] = useState(false);
  const [reason, setReason] = useState("");
  /** The finished drawer, held from the close response — `sessions/current` will not serve it. */
  const [closed, setClosed] = useState<WireCashierSession | null>(null);

  const current = useQuery({
    queryKey: ["billing-session", "current"],
    queryFn: () => api<{ session: WireCashierSession | null }>("GET", "/billing/sessions/current"),
    refetchInterval: POLL_MS,
  });

  const served = current.data?.session ?? null;
  /*
    UX-AUDIT 2026-09-28 — A `closed` ROW IS A FINISHED DRAWER, NOT A LIVE ONE. The wire type admits
    `closed` on `sessions/current` even though the route filters it out today, and a row that
    arrived that way rendered as the live header — "CLOSED · Opened · Float" — with no figures and
    no way to open the next drawer. It is routed to the day summary, which has both.
  */
  const live = served !== null && served.status !== "closed" ? served : null;
  const finished = closed ?? (served !== null && served.status === "closed" ? served : null);
  const counted = countedCashPaise(counts);

  /*
    UX-AUDIT 2026-09-28 — WHETHER "FINISH CLOSING" IS A REAL STEP YET. `confirmClose` refuses
    `approval_not_granted` until the `billing_variance` approval is GRANTED, and the drawer row
    carries only the approval's id. The approval itself is readable only with
    `approvals.requests.read`, which the seeded cashier does not hold — so the status is fetched
    for a reader who may read it (a billing manager counting a drawer herself) and, for everyone
    else, the step is offered as what it is: the move to make AFTER the approval, refused by the
    server before it, and the refusal rendered in words.
  */
  const approvalId = live?.status === "closing" ? live.varianceApprovalId : null;
  const approval = useQuery({
    queryKey: ["billing-session", "approval", approvalId],
    queryFn: () => api<{ approval: WireVarianceApproval }>("GET", `/approvals/${encodeURIComponent(approvalId ?? "")}`),
    enabled: approvalId !== null && can("approvals.requests.read"),
    refetchInterval: POLL_MS,
  });
  const approvalStatus = approval.data?.approval.status ?? null;

  const openItems = useQuery({
    queryKey: ["billing-session", "open-items"],
    queryFn: () => api<{ items: WireOpenItems | null }>("GET", "/billing/sessions/current/open-items"),
    enabled: live !== null,
    refetchInterval: POLL_MS,
  });
  const items = live !== null ? (openItems.data?.items ?? null) : null;

  /*
    UX-AUDIT 2026-09-28 — THE COUNT IS TYPED DOWN A COLUMN. Enter moves to the next note (as Tab
    does), and from the last note to the close note, so a cashier counting from a stack of notes
    never reaches for the mouse. Enter never SUBMITS from the grid: the close is one deliberate press.
  */
  const denomRefs = useRef<(HTMLInputElement | null)[]>([]);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const onDenomKey = (index: number) => (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const next = denomRefs.current[index + 1];
    if (next) next.focus();
    else noteRef.current?.focus();
  };

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["billing-session"] });
  };

  /**
   * A drawer the response says is `closed` is kept locally; anything else lives on the server.
   *
   * THE FLOAT RESET IS LOAD-BEARING, NOT TIDINESS. `openForm` is rendered only while
   * `live === null` (UX-AUDIT 2026-09-28 took `closing` out of that condition), so `MoneyInput` UNMOUNTS for the life of an open
   * drawer and remounts with an EMPTY box once the drawer closes — while `floatPaise` would
   * otherwise survive here. The next Open would then post a float the cashier never typed, and
   * that float anchors `expectedCashPaise`: her real drawer then closes on a MANUFACTURED
   * variance, which files a `billing_variance` approval and locks her out of all counter work
   * (Plan 08 pipeline A carried item 18) — the same lockout shape `44c8b86` was written to remove.
   *
   * The invariant is: THE FLOAT THAT GETS POSTED IS THE FLOAT THE CASHIER CAN SEE. The `key` on
   * the MoneyInput below is the other half of it.
   */
  const land = async (row: WireCashierSession): Promise<void> => {
    setClosed(row.status === "closed" ? row : null);
    setCloseLane(false);
    setCounts({});
    setNote("");
    setFloatPaise(undefined);
    await refresh();
  };

  const openDrawer = async (): Promise<void> => {
    if (floatPaise === undefined) {
      setOpenError(t("billingSession.open.floatRequired"));
      return;
    }
    setOpenError(null);
    try {
      const row = await api<WireCashierSession>("POST", "/billing/sessions", { floatPaise });
      setClosed(null);
      await land(row);
    } catch (e) {
      // Whatever the server calls it — `session_already_open` from the live-session index, or
      // `session_state_conflict` from a drawer that moved under us — it is rendered as it arrived.
      setOpenError(billingErrorMessage(e));
    }
  };

  const beginClose = async (): Promise<void> => {
    if (live === null) return;
    setCloseError(null);
    const denominations = countedDenominations(counts);
    // The note is OPTIONAL and a blank one is OMITTED, never sent as "" — the K49 convention.
    const body: { denominations: Record<string, number>; note?: string } = { denominations };
    if (note.trim() !== "") body.note = note.trim();
    try {
      const row = await api<WireCashierSession>("POST", `/billing/sessions/${encodeURIComponent(live.id)}/close`, body);
      await land(row);
    } catch (e) {
      setCloseError(billingErrorMessage(e));
    }
  };

  /**
   * ═══ FD-11 — WITHDRAW A MISTYPED COUNT AND COUNT AGAIN ═══
   *
   * Owner, on the preview: *"I wrongly typed the closing amount. Now I can't undo it and so I can't
   * close the drawer properly and hence can't proceed on to the dashboard."* Every exit from a typo
   * needed a second human — in a hospital with one supervisor.
   *
   * It is NOT an undo and the copy on the button must not suggest one. The retracted figure is
   * written to the event log before the drawer reopens, and the server files an approval on the
   * next close even if the arithmetic then agrees — so a corrected count still meets a supervisor.
   * What this removes is the dead end, not the second pair of eyes.
   *
   * The reason is REQUIRED and the server refuses a blank one, so it is asked for here rather than
   * posted empty and bounced.
   */
  const recount = async (): Promise<void> => {
    if (live === null) return;
    const why = reason.trim();
    if (why === "") { setCloseError(t("billingSession.recount.reasonRequired")); return; }
    setCloseError(null);
    try {
      const row = await api<WireCashierSession>(
        "POST", `/billing/sessions/${encodeURIComponent(live.id)}/recount`, { reason: why },
      );
      setReason("");
      setRecounting(false);
      await land(row);
    } catch (e) {
      setCloseError(billingErrorMessage(e));
    }
  };

  const confirmClose = async (): Promise<void> => {
    if (live === null) return;
    setCloseError(null);
    try {
      // No body: the granted approval is checked on execute, at the server, which owns it.
      const row = await api<WireCashierSession>("POST", `/billing/sessions/${encodeURIComponent(live.id)}/confirm-close`);
      await land(row);
    } catch (e) {
      // The server's words for this refusal name the session id; the cashier needs the reason.
      setCloseError(billingErrorCode(e) === "approval_not_granted" ? t("billingSession.notApprovedYet") : billingErrorMessage(e));
    }
  };

  // ——— render ———————————————————————————————————————————————————————————————————————————————

  const varianceFig = (variancePaise: number, idPrefix: string): React.ReactElement => (
    <div className="cs-fig">
      <span className="lbl">{t("billingSession.variance")}</span>
      <span className={`v num ${variancePaise === 0 ? "" : "bad"}`}>
        <span data-testid={idPrefix}>{fmtPaise(variancePaise)}</span>
        {variancePaise !== 0 && (
          <span data-testid="variance-direction" className="dir">
            {variancePaise < 0 ? t("billingSession.short") : t("billingSession.over")}
          </span>
        )}
      </span>
    </div>
  );

  const fig = (label: string, testId: string, paise: number): React.ReactElement => (
    <div className="cs-fig">
      <span className="lbl">{label}</span>
      <span data-testid={testId} className="v num">{fmtPaise(paise)}</span>
    </div>
  );

  const openForm = (
    <div className="cs-card cs-open">
      <h2 className="cs-card-h">{t("billingSession.open.title")}</h2>
      <p className="cs-sub">{t("billingSession.open.explain")}</p>
      <div style={{ marginTop: 10 }}>
        {/*
          `key` clears the VISIBLE box whenever a drawer finishes while this form is mounted. It was
          written for a drawer confirmed out of `closing` with the form on screen throughout; since
          UX-AUDIT 2026-09-28 the form is hidden during `closing`, but a finished row can still arrive
          while it is mounted (a `closed` row served by the poll), and `MoneyInput` seeds its text
          once in a `useState` initializer and documents that parents needing a reset must remount
          with a `key`. Pairs with `land`'s reset: the float posted is the float she can see.
        */}
        <MoneyInput
          key={finished?.id ?? "new"}
          id="open-float"
          label={t("billingSession.open.float")}
          onChange={setFloatPaise}
        />
      </div>
      {openError !== null && (
        <p role="alert" data-testid="open-error" className="cs-err" style={{ marginTop: 8 }}>{openError}</p>
      )}
      <div className="cs-actions">
        <SubmitButton plain className="cs-btn pri" data-testid="open-submit" onClick={() => openDrawer()}>
          {t("billingSession.open.submit")}
        </SubmitButton>
      </div>
    </div>
  );

  /*
    UX-AUDIT 2026-09-28 — "OPEN ON THIS DRAWER" (BillingEdge, right panel). Each row is a dot, a
    title, an amount and one line of what to do — the board's grammar. Rows appear only when there
    is something open; an empty drawer says so in words rather than showing four zeros. The
    board's "Ayushman Bharat — nothing to collect" row has no data source on this drawer yet and is
    not invented here.
  */
  const openList = items !== null && (
    <aside className="cs-side" data-testid="open-items" aria-labelledby="cs-open-h">
      <div className="cs-side-h">
        <span id="cs-open-h" className="cs-card-h" style={{ display: "block" }}>{t("billingSession.openItems.title")}</span>
        <span className="cs-sub">{t("billingSession.openItems.sub")}</span>
      </div>
      <div className="cs-side-b">
        {items.nonCashMismatched.count > 0 && (
          <div className="cs-ex red" data-testid="open-mismatched">
            <div className="cs-ex-top">
              <span className="cs-ex-dot" />
              <span className="t">{t("billingSession.openItems.mismatched", { count: items.nonCashMismatched.count })}</span>
              <span className="a num">{fmtPaise(items.nonCashMismatched.paise)}</span>
            </div>
            <div className="cs-ex-body">{t("billingSession.openItems.mismatchedBody")}</div>
          </div>
        )}
        {items.nonCashUnconfirmed.count > 0 && (
          <div className="cs-ex" data-testid="open-unconfirmed">
            <div className="cs-ex-top">
              <span className="cs-ex-dot" />
              <span className="t">{t("billingSession.openItems.unconfirmed", { count: items.nonCashUnconfirmed.count })}</span>
              <span className="a num">{fmtPaise(items.nonCashUnconfirmed.paise)}</span>
            </div>
            <div className="cs-ex-body">{t("billingSession.openItems.unconfirmedBody")}</div>
          </div>
        )}
        {items.refundsQueued.count > 0 && (
          <div className="cs-ex" data-testid="open-refunds">
            <div className="cs-ex-top">
              <span className="cs-ex-dot" />
              <span className="t">{t("billingSession.openItems.refunds", { count: items.refundsQueued.count })}</span>
              <span className="a num">{fmtPaise(items.refundsQueued.paise)}</span>
            </div>
            <div className="cs-ex-body">{t("billingSession.openItems.refundsBody")}</div>
          </div>
        )}
        {items.partPaid.count > 0 && (
          <div className="cs-ex" data-testid="open-part-paid">
            <div className="cs-ex-top">
              <span className="cs-ex-dot" />
              <span className="t">{t("billingSession.openItems.partPaid", { count: items.partPaid.count })}</span>
              <span className="a num">{fmtPaise(items.partPaid.paise)}</span>
            </div>
            <div className="cs-ex-body">{t("billingSession.openItems.partPaidBody")}</div>
            <ul className="cs-ex-list">
              {items.partPaid.items.map((i) => (
                <li key={i.invoiceId}>
                  <span>
                    {i.patientName ?? t("billingSession.openItems.restricted")}
                    <span className="num cs-sub"> · {i.invoiceNo}</span>
                  </span>
                  <span className="num">{fmtPaise(i.outstandingPaise)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {items.nonCashMismatched.count + items.nonCashUnconfirmed.count + items.refundsQueued.count + items.partPaid.count === 0 && (
          <p data-testid="open-clear" className="cs-clear">{t("billingSession.openItems.clear")}</p>
        )}
      </div>
    </aside>
  );

  /*
    UX-AUDIT 2026-09-28 — "IF YOU CLOSED THE DRAWER NOW", AND THE ONE PLACE THIS SCREEN LEAVES ITS
    BOARD. BillingEdge prints "Cash receipted ₹24,150 … Drawer should hold ₹24,650" in this card,
    directly above its own note that "the expected total stays hidden until you have typed yours".
    The two cannot both hold, and the blind count is the money control (pinned in this suite), so the
    card keeps its rows and withholds every cash figure the expected could be derived from: the
    float (hers, typed at open), the receipt and voucher COUNTS, the refunds still held (not in the
    expected until paid) — and "shown after your count" where the board prints the answer.
    DECIDED in docs/superpowers/decisions/2026-09-28-billing-session.md.
  */
  const ifClosedNow = live !== null && live.status === "open" && !closeLane && (
    <div className="cs-card" data-testid="if-closed-now">
      <span className="lbl">{t("billingSession.ifClosed.title")}</span>
      <div className="cs-rows">
        <div className="cs-row"><span>{t("billingSession.ifClosed.float")}</span><span className="num">{fmtPaise(live.openingFloatPaise)}</span></div>
        <div className="cs-row"><span>{t("billingSession.ifClosed.receipts")}</span><span className="num">{items === null ? "—" : String(items.receipts)}</span></div>
        <div className="cs-row"><span>{t("billingSession.ifClosed.refundsPaid")}</span><span className="num">{items === null ? "—" : String(items.refundsPaidHere)}</span></div>
        <div className="cs-row">
          <span>{t("billingSession.ifClosed.refundsHeld")}</span>
          <span className="num">{items === null ? "—" : fmtPaise(items.refundsQueued.paise)}</span>
        </div>
        <div className="cs-row tot">
          <span>{t("billingSession.ifClosed.shouldHold")}</span>
          <span data-testid="should-hold" className="hidden-fig">{t("billingSession.ifClosed.afterCount")}</span>
        </div>
      </div>
      <div className="cs-note">
        <div className="h">{t("billingSession.ifClosed.blindTitle")}</div>
        <div className="b">{t("billingSession.ifClosed.blindBody")}</div>
      </div>
      <button type="button" data-testid="start-count" className="cs-btn wide" onClick={() => setCloseLane(true)}>
        {t("billingSession.ifClosed.start")}
      </button>
    </div>
  );

  /* ——— the count-down: ten rows, paise keys, one running total, the submit pinned in view ——— */
  const countCard = live !== null && live.status === "open" && closeLane && (
    <div className="cs-card cs-count" data-testid="count-card">
      <div className="cs-count-h">
        <h2 className="cs-card-h">{t("billingSession.close.title")}</h2>
        <p className="cs-sub">{t("billingSession.close.warning")}</p>
      </div>
      <table className="cs-denoms">
        <thead>
          <tr>
            <th>{t("billingSession.close.note_col")}</th>
            <th aria-hidden="true" />
            <th>{t("billingSession.close.count_col")}</th>
            <th className="r">{t("billingSession.close.amount_col")}</th>
          </tr>
        </thead>
        <tbody>
          {DENOMINATION_RUPEES.map((rupees, index) => {
            const amount = denominationPaise(rupees) * noteCount(counts[rupees]);
            return (
              <tr key={rupees} data-testid={`denom-row-${String(rupees)}`} data-denom={String(denominationPaise(rupees))}>
                <td className="num">
                  <label htmlFor={`denom-${String(rupees)}`}>{t("billingSession.close.denom", { rupees })}</label>
                </td>
                <td className="x" aria-hidden="true">×</td>
                <td>
                  <input
                    id={`denom-${String(rupees)}`}
                    ref={(el) => { denomRefs.current[index] = el; }}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    autoFocus={index === 0}
                    value={counts[rupees] ?? ""}
                    onKeyDown={onDenomKey(index)}
                    onChange={(e) => setCounts((prev) => ({ ...prev, [rupees]: e.target.value.replace(/[^0-9]/g, "") }))}
                  />
                </td>
                <td className={`r num amt ${amount > 0 ? "on" : ""}`}>{fmtPaise(amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="cs-count-foot">
        <div className="cs-total">
          <span className="lbl">{t("billingSession.close.counted")}</span>
          <span data-testid="counted-total" className="v num">{fmtPaise(counted)}</span>
        </div>
        {closeError !== null && (
          <p role="alert" data-testid="close-error" className="cs-err">{closeError}</p>
        )}
        <div className="cs-foot-row">
          <label className="cs-field-l" htmlFor="close-note">{t("billingSession.close.note")}</label>
          <input id="close-note" ref={noteRef} className="cs-field" value={note} onChange={(e) => setNote(e.target.value)} />
          <SubmitButton plain className="cs-btn pri" data-testid="close-submit" onClick={() => beginClose()}>
            {t("billingSession.close.submit")}
          </SubmitButton>
          <button type="button" className="cs-btn" onClick={() => setCloseLane(false)}>{t("billingSession.cancel")}</button>
        </div>
      </div>
    </div>
  );

  /* ——— awaiting the variance approval: the figures, then ONE warning, then the way out ——— */
  const closingCard = live !== null && live.status === "closing" && (
    <div className="cs-card" data-testid="closing-card">
      <h2 className="cs-card-h">{t("billingSession.closingTitle")}</h2>
      <div className="cs-figs">
        {fig(t("billingSession.close.counted"), "closing-counted", live.countedCashPaise ?? 0)}
        {fig(t("billingSession.expected"), "closing-expected", live.expectedCashPaise ?? 0)}
        {varianceFig(live.variancePaise ?? 0, "variance-figure")}
      </div>
      <div className="cs-actions" style={{ marginTop: 8 }}>
        {/*
          BESIDE THE COUNT, which is where the owner asked for it and where it belongs: the figure
          somebody is staring at when they realise it is wrong is the figure they should be able
          to act on.
        */}
        {!recounting && (
          <button
            type="button"
            data-testid="recount-open"
            className="cs-link"
            onClick={() => { setRecounting(true); setCloseError(null); }}
          >
            {t("billingSession.recount.open")}
          </button>
        )}
      </div>
      {recounting && (
        <div data-testid="recount-form" className="cs-recount">
          <p className="cs-sub" style={{ margin: 0 }}>{t("billingSession.recount.explain")}</p>
          <label className="cs-sub" htmlFor="recount-reason">{t("billingSession.recount.reason")}</label>
          <input
            id="recount-reason"
            data-testid="recount-reason"
            className="cs-field"
            value={reason}
            onChange={(e) => { setReason(e.target.value); }}
          />
          <div className="cs-foot-row">
            <SubmitButton plain className="cs-btn pri" data-testid="recount-submit" onClick={() => recount()}>
              {t("billingSession.recount.submit")}
            </SubmitButton>
            <button
              type="button"
              data-testid="recount-cancel"
              className="cs-link"
              onClick={() => { setRecounting(false); setReason(""); setCloseError(null); }}
            >
              {t("billingSession.recount.cancel")}
            </button>
          </div>
        </div>
      )}

      {/*
        UX-AUDIT 2026-09-28 — ONE STORY, NOT THREE. The panel used to say "you cannot take money
        until a billing manager approves", then name the approval by its raw id ("apr-77"), then
        offer "Confirm close" as if it were available now — with a full "Open a drawer" form
        underneath. The server's truth, from `sessions.ts`: confirm-close is refused until the
        approval is GRANTED, and a second drawer is refused `session_already_open` by
        `cashier_sessions_live_ux` for as long as this one is `closing`. And, second pass: the
        pending line and the lockout said the same sentence twice ("waiting for a billing manager
        to approve this variance" / "until a billing manager approves this variance"). Now the
        lockout is the one headline, and the approval line under it carries only what the headline
        does not — who may decide, and since when.
      */}
      {approvalStatus === "granted" ? (
        <div className="cs-note green">
          <p role="status" data-testid="approval-pending" className="h" style={{ margin: 0 }}>{t("billingSession.approvalGranted")}</p>
        </div>
      ) : (
        <div className={`cs-note ${approvalStatus === "rejected" ? "red" : ""}`}>
          <p role="status" data-testid="lockout-banner" className="h" style={{ margin: 0 }}>{t("billingSession.lockout")}</p>
          {approvalStatus === "rejected" ? (
            <p role="status" data-testid="approval-pending" className="b" style={{ margin: 0 }}>{t("billingSession.approvalRejected")}</p>
          ) : live.varianceApprovalId !== null && (
            <p role="status" data-testid="approval-pending" className="b" style={{ margin: 0 }}>
              {approval.data !== undefined
                ? t("billingSession.approvalPendingSince", { time: fmtIst(approval.data.approval.requestedAt) })
                : t("billingSession.approvalPending")}
            </p>
          )}
        </div>
      )}

      {closeError !== null && (
        <p role="alert" data-testid="close-error" className="cs-err" style={{ marginTop: 10 }}>{closeError}</p>
      )}

      <div className="cs-actions">
        {(approvalStatus === null || approvalStatus === "granted") && (
          <SubmitButton plain className="cs-btn pri" data-testid="confirm-close" onClick={() => confirmClose()}>
            {t("billingSession.confirmClose")}
          </SubmitButton>
        )}
      </div>
      {approvalStatus === null && (
        <p data-testid="confirm-close-hint" className="cs-meta">{t("billingSession.confirmCloseHint")}</p>
      )}
    </div>
  );

  /* ——— the finished drawer: the day summary, from the response that closed it ——— */
  const summaryCard = finished !== null && (
    <div data-testid="day-summary" className="cs-card">
      <div className="cs-foot-row">
        <h2 className="cs-card-h" style={{ margin: 0 }}>{t("billingSession.summary.title")}</h2>
        <span data-testid="summary-status" className="cs-tag dim">{t("billingSession.status.closed")}</span>
      </div>
      <p className="cs-sub" style={{ margin: "4px 0 0" }}>
        {t("billingSession.openedAt")} <span data-testid="summary-opened-at" className="num">{fmtIst(finished.openedAt)}</span>
        {" · "}
        {t("billingSession.closedAt")}{" "}
        <span data-testid="summary-closed-at" className="num">{finished.closedAt === null ? "—" : fmtIst(finished.closedAt)}</span>
      </p>
      <div className="cs-figs">
        {fig(t("billingSession.float"), "summary-float", finished.openingFloatPaise)}
        {fig(t("billingSession.close.counted"), "summary-counted", finished.countedCashPaise ?? 0)}
        {fig(t("billingSession.expected"), "summary-expected", finished.expectedCashPaise ?? 0)}
      </div>
      <div className="cs-figs" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        {varianceFig(finished.variancePaise ?? 0, "summary-variance")}
      </div>
      {finished.closeNote !== null && (
        <p data-testid="summary-note" className="cs-meta">{finished.closeNote}</p>
      )}
    </div>
  );

  return (
    <div className="cs">
      <div className="cs-wrap">
        <h1 className="cs-title">{t("billingSession.title")}</h1>

        {/*
          UX-AUDIT 2026-09-28 — THE DRAWER STRIP (BillingCounter). The board's strip reads "collected
          so far ₹18,450 across 47 receipts"; the RECEIPT COUNT is kept and the rupee figure is not,
          because on a cash-heavy counter the collected total is the expected cash less the float —
          the blind count's answer, one subtraction away.
        */}
        {live !== null && (
          <div className={`cs-strip ${live.status}`} data-testid="drawer-strip">
            <span className="cs-dot" aria-hidden="true" />
            <span data-testid="session-status" className="cs-tag">{t(`billingSession.status.${live.status}`)}</span>
            <span className="cs-strip-text">
              <strong>{t(live.status === "open" ? "billingSession.strip.open" : "billingSession.strip.closing")}</strong>{" "}
              {t("billingSession.strip.since")}{" "}
              <span data-testid="session-opened-at" className="num">{fmtIst(live.openedAt)}</span>
              {" · "}{t("billingSession.strip.float")}{" "}
              <span data-testid="session-float" className="num">{fmtPaise(live.openingFloatPaise)}</span>
              {items !== null && (
                <>
                  {" · "}
                  <span data-testid="session-receipts">{t("billingSession.strip.receipts", { count: items.receipts })}</span>
                </>
              )}
            </span>
            {live.status === "open" && !closeLane && (
              <button type="button" data-testid="close-open" className="cs-btn grn" onClick={() => setCloseLane(true)}>
                {t("billingSession.close.open")}
              </button>
            )}
          </div>
        )}

        <div className={`cs-grid ${live !== null && items !== null ? "two" : ""}`}>
          <div>
            {ifClosedNow}
            {countCard}
            {closingCard}
            {summaryCard}
            {live === null && (
              <p data-testid="no-session" className="cs-sub" style={{ margin: finished !== null ? "12px 0" : "0 0 12px" }}>
                {t("billingSession.noSession")}
              </p>
            )}
            {/*
              UX-AUDIT 2026-09-28 — THE OPEN FORM IS OFFERED ONLY WHEN IT CAN SUCCEED. It used to stay on
              screen while a drawer was `closing`, on the theory that she may ask and the server refuses.
              In the browser that read as a contradiction — "you cannot take money" above an "Open a
              drawer" form — and the refusal was certain: `cashier_sessions_live_ux` holds one LIVE
              (`open` or `closing`) drawer per cashier, so the insert is refused `session_already_open`
              every time. The lockout banner already tells her why the counter stopped; the form returns
              the moment the drawer is closed, or with no drawer at all.
            */}
            {live === null && openForm}
          </div>
          {openList}
        </div>
      </div>
    </div>
  );
}
