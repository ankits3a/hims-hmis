import { useRef, useState } from "react";
import { newIdempotencyKey } from "../lib/api";
import { Button } from "@/components/ui/button";

/**
 * A WRITE button that cannot be fired twice (Plan 08 pipeline C discovery review, finding 2).
 *
 * Every money write on the four billing screens was `<Button onClick={() => void handler()}>` with
 * no in-flight guard anywhere, so a double click posted the request twice. The server offers no
 * idempotency key on `POST /billing/invoices` or `POST /billing/receipts`, so the duplicate is a
 * real second document: a duplicated cash receipt inflates the patient's advance and manufactures
 * exactly the drawer variance `44c8b86` was written to remove; a duplicated invoice POST issues a
 * second invoice number against one encounter. One physical payment, two rows.
 *
 * THE REF IS THE GUARD; `disabled` IS ONLY THE AFFORDANCE. `busy` is state, and React batches
 * state updates — two clicks in the SAME TICK both observe `busy === false` and both call the
 * handler, because no re-render has happened in between. `inFlight` flips SYNCHRONOUSLY inside the
 * first handler call, so the second one returns before it can reach the network. A guard written
 * as `disabled={busy}` alone proves the DOM and stops nothing; the mutant that deletes the ref and
 * keeps the attribute is the one this component's spec is built to kill.
 *
 * The latch is per BUTTON, by construction: each lane mounts its own instance, so guarding the pay
 * lane never disables the reconciliation upload beside it.
 */
export function SubmitButton({
  onClick,
  disabled,
  children,
  plain,
  style,
  ...rest
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  onClick: (idempotencyKey: string) => Promise<void>;
  /**
   * ═══ FD-25 — THE LATCH WITHOUT THE SHADCN PAINT ═══
   *
   * This component's value is the ref latch, and the latch has nothing to do with what the button
   * looks like. But it renders `@/components/ui/button`, so an FD-25 screen faced a choice between
   * keeping the guard and wearing the design system — and either answer is wrong. A screen that
   * hand-rolls its own button to get the right colour re-buys the double-click defect this file
   * exists to prevent; one that keeps SubmitButton has a shadcn control sitting in a paper-and-pine
   * column, which is the seam the owner has now called out three times.
   *
   * `plain` is the third answer: the same latch, rendering a bare `<button>` that takes whatever
   * class the design system gives it (`pri`, `sec`, `sec grn`). Existing callers pass nothing and
   * are untouched, so the billing screens keep exactly the button they have.
   */
  plain?: boolean;
}): React.ReactElement {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const handle = (): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    /*
     * ONE KEY PER ATTEMPT, minted here because this is the only place that knows where an attempt
     * BEGINS. Every request the handler makes travels under it, and the server's uniqueness is per
     * (actor, route, key) — so a lane that posts a receipt and then an allocation is two distinct
     * claims under one key, exactly as intended. A handler that ignores the argument simply gets no
     * server-side protection, which is why `submit-button.test.tsx` sweeps for that.
     */
    const idempotencyKey = newIdempotencyKey();
    void (async () => {
      try {
        await onClick(idempotencyKey);
      } catch (e) {
        /*
         * THE REJECTION IS CAUGHT HERE, AND THAT IS NOT DEFENSIVE PADDING. Without it the async
         * IIFE's promise rejects with nobody holding it, and an unhandled rejection in this
         * harness is not a local problem: vitest attributes it to whichever FILE is running when
         * it lands, so it surfaces as a flake in an innocent suite (Plan 07 §2.16 — `f84f1b1`
         * shipped CI-red that way, with all 524 tests passing and the suite failing around them).
         * Every one of the thirteen lanes already catches its own refusal and renders it, so this
         * path means a genuine programming error: it is reported, never silently swallowed.
         */
        console.error("SubmitButton: the write handler rejected without handling its own error", e);
      } finally {
        // Always released, including when the handler throws: a refusal the cashier can correct
        // (a 409 cash threshold, a 400 pan_required) must leave the button usable for the retry.
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  if (plain === true) {
    /* `type` defaults to "button": a latched write inside a form must not also submit the form. */
    const { className, type, ...bare } = rest as { className?: string; type?: "button" | "submit" | "reset" };
    return (
      <button
        {...bare}
        type={type ?? "button"}
        className={className}
        style={style}
        disabled={disabled === true || busy}
        onClick={handle}
      >
        {children}
      </button>
    );
  }

  return (
    <Button {...rest} style={style} disabled={disabled === true || busy} onClick={handle}>
      {children}
    </Button>
  );
}
