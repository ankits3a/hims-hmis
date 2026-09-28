import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoneyInput } from "../components/money-input";
import { SubmitButton } from "../components/submit-button";
import { fmtIst, fmtPaise } from "../lib/format";
import { api } from "../lib/api";
import { billingErrorCode, billingErrorMessage } from "../lib/billing-api";
import { useAuth } from "../lib/auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

  const varianceBlock = (variancePaise: number, idPrefix: string): React.ReactElement => (
    <p className="text-sm">
      {t("billingSession.variance")}:{" "}
      <span
        data-testid={idPrefix}
        className={`font-semibold tabular-nums ${variancePaise === 0 ? "" : "text-red-600"}`}
      >
        {fmtPaise(variancePaise)}
      </span>
      {variancePaise !== 0 && (
        <span data-testid="variance-direction" className="ml-2 text-neutral-600">
          {variancePaise < 0 ? t("billingSession.short") : t("billingSession.over")}
        </span>
      )}
    </p>
  );

  const openForm = (
    <div className="space-y-2 rounded border p-2">
      <h2 className="text-sm font-semibold">{t("billingSession.open.title")}</h2>
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
      {openError !== null && (
        <p role="alert" data-testid="open-error" className="text-sm text-red-600">{openError}</p>
      )}
      <SubmitButton data-testid="open-submit" onClick={() => openDrawer()}>
        {t("billingSession.open.submit")}
      </SubmitButton>
    </div>
  );

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("billingSession.title")}</h1>

      {live !== null && (
        <div className="space-y-2 rounded border p-2">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge data-testid="session-status" variant={live.status === "open" ? "default" : "outline"}>
              {t(`billingSession.status.${live.status}`)}
            </Badge>
            <span>
              {t("billingSession.openedAt")}:{" "}
              <span data-testid="session-opened-at" className="tabular-nums">{fmtIst(live.openedAt)}</span>
            </span>
            <span>
              {t("billingSession.float")}:{" "}
              <span data-testid="session-float" className="tabular-nums">{fmtPaise(live.openingFloatPaise)}</span>
            </span>
          </div>

          {live.status === "open" && !closeLane && (
            <Button data-testid="close-open" onClick={() => setCloseLane(true)}>
              {t("billingSession.close.open")}
            </Button>
          )}
        </div>
      )}

      {/* ——— the count-down: ten rows, paise keys, one running total ——— */}
      {live !== null && live.status === "open" && closeLane && (
        <div className="space-y-2 rounded border p-2">
          <h2 className="text-sm font-semibold">{t("billingSession.close.title")}</h2>
          <p className="text-sm text-amber-700">{t("billingSession.close.warning")}</p>
          <table className="text-sm">
            <tbody>
              {DENOMINATION_RUPEES.map((rupees) => (
                <tr key={rupees} data-testid={`denom-row-${String(rupees)}`} data-denom={String(denominationPaise(rupees))}>
                  <td className="pr-3">
                    <label htmlFor={`denom-${String(rupees)}`}>
                      {t("billingSession.close.denom", { rupees })}
                    </label>
                  </td>
                  <td>
                    <input
                      id={`denom-${String(rupees)}`}
                      type="number"
                      min="0"
                      inputMode="numeric"
                      autoComplete="off"
                      value={counts[rupees] ?? ""}
                      onChange={(e) => setCounts((prev) => ({ ...prev, [rupees]: e.target.value }))}
                      className="w-24 rounded border px-2 py-1 text-right tabular-nums"
                    />
                  </td>
                  <td className="pl-3 tabular-nums text-neutral-600">
                    {fmtPaise(denominationPaise(rupees) * noteCount(counts[rupees]))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm">
            {t("billingSession.close.counted")}:{" "}
            <span data-testid="counted-total" className="font-semibold tabular-nums">{fmtPaise(counted)}</span>
          </p>
          <label className="block text-sm font-medium" htmlFor="close-note">{t("billingSession.close.note")}</label>
          <input
            id="close-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded border px-2 py-1"
          />
          {closeError !== null && (
            <p role="alert" data-testid="close-error" className="text-sm text-red-600">{closeError}</p>
          )}
          <div className="flex gap-2">
            <SubmitButton data-testid="close-submit" onClick={() => beginClose()}>
              {t("billingSession.close.submit")}
            </SubmitButton>
            <Button variant="outline" onClick={() => setCloseLane(false)}>{t("billingSession.cancel")}</Button>
          </div>
        </div>
      )}

      {/* ——— awaiting the variance approval: the numbers, the approval, and the lockout ——— */}
      {live !== null && live.status === "closing" && (
        <div className="space-y-2 rounded border border-amber-400 p-2">
          <p className="text-sm">
            {t("billingSession.close.counted")}:{" "}
            <span data-testid="closing-counted" className="tabular-nums">{fmtPaise(live.countedCashPaise ?? 0)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.expected")}:{" "}
            <span data-testid="closing-expected" className="tabular-nums">{fmtPaise(live.expectedCashPaise ?? 0)}</span>
          </p>
          {varianceBlock(live.variancePaise ?? 0, "variance-figure")}

          {/*
            BESIDE THE COUNT, which is where the owner asked for it and where it belongs: the figure
            somebody is staring at when they realise it is wrong is the figure they should be able
            to act on. It sits ABOVE the lockout banner, so the way out is read before the wall.
          */}
          {!recounting ? (
            <button
              type="button"
              data-testid="recount-open"
              className="text-sm underline"
              onClick={() => { setRecounting(true); setCloseError(null); }}
            >
              {t("billingSession.recount.open")}
            </button>
          ) : (
            <div data-testid="recount-form" className="space-y-2 rounded border border-neutral-300 p-2">
              <p className="text-sm text-neutral-700">{t("billingSession.recount.explain")}</p>
              <label className="block text-sm" htmlFor="recount-reason">{t("billingSession.recount.reason")}</label>
              <input
                id="recount-reason"
                data-testid="recount-reason"
                className="w-full rounded border px-2 py-1 text-sm"
                value={reason}
                onChange={(e) => { setReason(e.target.value); }}
              />
              <div className="flex gap-2">
                <SubmitButton data-testid="recount-submit" onClick={() => recount()}>
                  {t("billingSession.recount.submit")}
                </SubmitButton>
                <button
                  type="button"
                  data-testid="recount-cancel"
                  className="text-sm underline"
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
            `cashier_sessions_live_ux` for as long as this one is `closing`. So the wording says who
            decides (the `billing_variance` type's `approverRole`, billing_manager) and — when the
            approval is readable — since when; the finish step is shown only when it can succeed, or,
            when its status is unknowable to this reader, labelled as the step AFTER approval; and
            the open form is gone until the drawer is closed.
          */}
          {approvalStatus === "rejected" ? (
            <p role="status" data-testid="approval-pending" className="text-sm text-red-700">
              {t("billingSession.approvalRejected")}
            </p>
          ) : approvalStatus === "granted" ? (
            <p role="status" data-testid="approval-pending" className="text-sm text-green-700">
              {t("billingSession.approvalGranted")}
            </p>
          ) : (
            live.varianceApprovalId !== null && (
              <p role="status" data-testid="approval-pending" className="text-sm text-amber-800">
                {approval.data !== undefined
                  ? t("billingSession.approvalPendingSince", { time: fmtIst(approval.data.approval.requestedAt) })
                  : t("billingSession.approvalPending")}
              </p>
            )
          )}
          {approvalStatus !== "granted" && (
            <p role="status" data-testid="lockout-banner" className="text-sm font-semibold text-amber-800">
              {t("billingSession.lockout")}
            </p>
          )}
          {closeError !== null && (
            <p role="alert" data-testid="close-error" className="text-sm text-red-600">{closeError}</p>
          )}
          {(approvalStatus === null || approvalStatus === "granted") && (
            <div className="space-y-1">
              {approvalStatus === null && (
                <p data-testid="confirm-close-hint" className="text-sm text-neutral-600">
                  {t("billingSession.confirmCloseHint")}
                </p>
              )}
              <SubmitButton data-testid="confirm-close" onClick={() => confirmClose()}>
                {t("billingSession.confirmClose")}
              </SubmitButton>
            </div>
          )}
        </div>
      )}

      {/* ——— the finished drawer: the day summary, from the response that closed it ——— */}
      {finished !== null && (
        <div data-testid="day-summary" className="space-y-1 rounded border p-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold">{t("billingSession.summary.title")}</h2>
            <Badge data-testid="summary-status" variant="outline">{t("billingSession.status.closed")}</Badge>
          </div>
          <p className="text-sm">
            {t("billingSession.openedAt")}:{" "}
            <span data-testid="summary-opened-at" className="tabular-nums">{fmtIst(finished.openedAt)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.float")}:{" "}
            <span data-testid="summary-float" className="tabular-nums">{fmtPaise(finished.openingFloatPaise)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.close.counted")}:{" "}
            <span data-testid="summary-counted" className="tabular-nums">{fmtPaise(finished.countedCashPaise ?? 0)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.expected")}:{" "}
            <span data-testid="summary-expected" className="tabular-nums">{fmtPaise(finished.expectedCashPaise ?? 0)}</span>
          </p>
          {varianceBlock(finished.variancePaise ?? 0, "summary-variance")}
          <p className="text-sm">
            {t("billingSession.closedAt")}:{" "}
            <span data-testid="summary-closed-at" className="tabular-nums">
              {finished.closedAt === null ? "—" : fmtIst(finished.closedAt)}
            </span>
          </p>
          {finished.closeNote !== null && (
            <p data-testid="summary-note" className="text-sm text-neutral-600">{finished.closeNote}</p>
          )}
        </div>
      )}

      {live === null && (
        <p data-testid="no-session" className="text-sm text-neutral-500">{t("billingSession.noSession")}</p>
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
  );
}
