import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoneyInput } from "../components/money-input";
import { SubmitButton } from "../components/submit-button";
import { fmtIst, fmtPaise } from "../lib/format";
import { api } from "../lib/api";
import { billingErrorMessage } from "../lib/billing-api";
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

export function BillingSession(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [floatPaise, setFloatPaise] = useState<number | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [closeLane, setCloseLane] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  /** The finished drawer, held from the close response — `sessions/current` will not serve it. */
  const [closed, setClosed] = useState<WireCashierSession | null>(null);

  const current = useQuery({
    queryKey: ["billing-session", "current"],
    queryFn: () => api<{ session: WireCashierSession | null }>("GET", "/billing/sessions/current"),
    refetchInterval: POLL_MS,
  });

  const live = current.data?.session ?? null;
  const counted = countedCashPaise(counts);

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["billing-session"] });
  };

  /**
   * A drawer the response says is `closed` is kept locally; anything else lives on the server.
   *
   * THE FLOAT RESET IS LOAD-BEARING, NOT TIDINESS. `openForm` is rendered only while
   * `live === null || live.status === "closing"`, so `MoneyInput` UNMOUNTS for the life of an open
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

  const confirmClose = async (): Promise<void> => {
    if (live === null) return;
    setCloseError(null);
    try {
      // No body: the granted approval is checked on execute, at the server, which owns it.
      const row = await api<WireCashierSession>("POST", `/billing/sessions/${encodeURIComponent(live.id)}/confirm-close`);
      await land(row);
    } catch (e) {
      setCloseError(billingErrorMessage(e));
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
        `key` clears the VISIBLE box on the one path where this form does not unmount: a drawer
        confirmed out of `closing` keeps `openForm` mounted throughout, because both branches of
        `live === null || live.status === "closing"` render it. `MoneyInput` seeds its text once in
        a `useState` initializer and documents that parents needing a reset must remount with a
        `key` — so without this the box would still show the finished drawer's float while
        `land`'s reset had already cleared the value behind it. Pairs with that reset.
      */}
      <MoneyInput
        key={closed?.id ?? "new"}
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
          {live.varianceApprovalId !== null && (
            <p role="status" data-testid="approval-pending" className="text-sm text-amber-800">
              {t("billingSession.approvalPending", { approvalId: live.varianceApprovalId })}
            </p>
          )}
          <p role="status" data-testid="lockout-banner" className="text-sm font-semibold text-amber-800">
            {t("billingSession.lockout")}
          </p>
          {closeError !== null && (
            <p role="alert" data-testid="close-error" className="text-sm text-red-600">{closeError}</p>
          )}
          <SubmitButton data-testid="confirm-close" onClick={() => confirmClose()}>
            {t("billingSession.confirmClose")}
          </SubmitButton>
        </div>
      )}

      {/* ——— the finished drawer: the day summary, from the response that closed it ——— */}
      {closed !== null && (
        <div data-testid="day-summary" className="space-y-1 rounded border p-2">
          <h2 className="text-sm font-semibold">{t("billingSession.summary.title")}</h2>
          <p className="text-sm">
            {t("billingSession.float")}:{" "}
            <span data-testid="summary-float" className="tabular-nums">{fmtPaise(closed.openingFloatPaise)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.close.counted")}:{" "}
            <span data-testid="summary-counted" className="tabular-nums">{fmtPaise(closed.countedCashPaise ?? 0)}</span>
          </p>
          <p className="text-sm">
            {t("billingSession.expected")}:{" "}
            <span data-testid="summary-expected" className="tabular-nums">{fmtPaise(closed.expectedCashPaise ?? 0)}</span>
          </p>
          {varianceBlock(closed.variancePaise ?? 0, "summary-variance")}
          <p className="text-sm">
            {t("billingSession.closedAt")}:{" "}
            <span data-testid="summary-closed-at" className="tabular-nums">
              {closed.closedAt === null ? "—" : fmtIst(closed.closedAt)}
            </span>
          </p>
          {closed.closeNote !== null && (
            <p data-testid="summary-note" className="text-sm text-neutral-600">{closed.closeNote}</p>
          )}
        </div>
      )}

      {live === null && (
        <p data-testid="no-session" className="text-sm text-neutral-500">{t("billingSession.noSession")}</p>
      )}
      {/*
        The open form stays available while a drawer is `closing` ON PURPOSE. The cashier's honest
        next move — start a fresh drawer and keep working — is exactly what the lockout forbids, and
        a hidden control would leave her guessing why the counter stopped taking money. She may ask;
        the server refuses; the refusal is rendered where she asked.
      */}
      {(live === null || live.status === "closing") && openForm}
    </div>
  );
}
