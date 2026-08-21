import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { SubmitButton } from "./submit-button";

/**
 * THIS FILE OWNS THE SINGLE-SUBMIT PROPERTY, with teeth (EXECUTION-LESSONS §3.34).
 *
 * The convention "a money write cannot be fired twice" is honoured by thirteen buttons across four
 * billing screens. Repeating it in thirteen places would produce thirteen implementations and zero
 * tests — which is exactly how the 15 s polling convention ended up unprotected on the back office.
 * So the guard lives in ONE component and its discrimination is proved HERE, once.
 *
 * The load-bearing assertion is the SYNCHRONOUS double click, and the idiom it uses was chosen by
 * MEASUREMENT, not by reasoning. The obvious spelling — two `fireEvent.click` calls — does NOT
 * discriminate: Testing Library wraps each one in `act()`, React re-renders in between, and
 * `disabled={busy}` blocks the second click before the handler sees it. Written that way this test
 * passed against a component with no latch at all (the mutant SURVIVED). Two RAW dispatches inside
 * one `act` block is the shape that separates them — probe: shipped `calls=1`, latch-deleted
 * `calls=2`, `disabled` true in both. A disabled attribute proves the DOM, not the handler.
 */

/** A handler that stays in flight until the test releases it. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SubmitButton", () => {
  it("TWO SYNCHRONOUS CLICKS CALL THE HANDLER ONCE — the ref latch, not the disabled attribute, is what stops the second", async () => {
    const d = deferred();
    const handler = vi.fn(() => d.promise);
    renderWithProviders(<SubmitButton data-testid="go" onClick={handler}>Pay</SubmitButton>);

    const button = screen.getByTestId("go");
    /*
     * RAW dispatch, both in ONE act block — and that detail is the whole test, established by
     * measurement rather than by reasoning. Testing Library's `fireEvent` wraps EACH call in
     * `act()`, so React re-renders between the two and `disabled={busy}` blocks the second click
     * before it ever reaches the handler: written with `fireEvent` twice, this test passes against
     * a component with NO latch at all (measured — the latch-deleted mutant SURVIVED it). Two
     * native events in a single task is the shape that separates them: probe against the shipped
     * component `calls=1`, against the latch-deleted mutant `calls=2`, with `disabled` true in
     * BOTH — so the attribute demonstrably is not what stops the second call.
     */
    const click = (): boolean =>
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await act(async () => {
      click();
      click();
    });

    expect(handler).toHaveBeenCalledTimes(1);

    d.resolve();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("the button is disabled WHILE in flight and usable again once the write settles — the affordance, and proof the latch releases", async () => {
    const d = deferred();
    const handler = vi.fn(() => d.promise);
    renderWithProviders(<SubmitButton data-testid="go" onClick={handler}>Pay</SubmitButton>);
    const button = screen.getByTestId("go");

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    d.resolve();
    await waitFor(() => expect(button).not.toBeDisabled());

    // a SECOND, legitimate write — the guard is per-click, not once-per-lifetime
    const user = userEvent.setup();
    await user.click(button);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  /**
   * NOT-OVER-BROAD (EXECUTION-LESSONS §3.44). A guard on a money path must not refuse the work it
   * exists to protect. The adjacent case that matters here is a REFUSAL: the counter's whole error
   * lane is 409s and 400s the cashier corrects and retries (`cash_threshold_blocked`,
   * `pan_required`, `over_cap`). If the latch did not release on a rejected handler, the first
   * refusal would brick the button and the cashier could never submit the corrected invoice.
   */
  it("a handler that REJECTS still releases the latch, and the rejection is REPORTED rather than leaked as an unhandled rejection", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = deferred();
    const handler = vi.fn(() => first.promise);
    renderWithProviders(<SubmitButton data-testid="go" onClick={handler}>Pay</SubmitButton>);
    const button = screen.getByTestId("go");

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    first.reject(new Error("cash_threshold_blocked"));
    await waitFor(() => expect(button).not.toBeDisabled());

    // Not decoration: without the catch this rejection is UNHANDLED, and vitest attributes an
    // unhandled rejection to whichever file is running when it lands — a red suite around green
    // tests, in a file that did nothing wrong (Plan 07 §2.16). Caught here, and reported.
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("rejected"), expect.any(Error));

    const user = userEvent.setup();
    await user.click(button);
    expect(handler).toHaveBeenCalledTimes(2);
    reported.mockRestore();
  });

  /**
   * The client half of migration 0013. The key is minted HERE because this is the only place that
   * knows where an attempt begins — and it is minted PER ATTEMPT, not per component, so a
   * deliberate second submit is a new attempt rather than a replay of the first. That distinction
   * is the whole reason the key is client-minted instead of hashed from the request: two genuine
   * ₹100 payments a minute apart must both be taken.
   */
  it("mints a FRESH idempotency key for every attempt and hands it to the handler", async () => {
    const keys: string[] = [];
    const handler = vi.fn(async (k: string) => {
      keys.push(k);
      await Promise.resolve();
    });
    renderWithProviders(<SubmitButton data-testid="go" onClick={handler}>Pay</SubmitButton>);
    const button = screen.getByTestId("go");
    const user = userEvent.setup();

    await user.click(button);
    await waitFor(() => expect(keys).toHaveLength(1));
    await user.click(button);
    await waitFor(() => expect(keys).toHaveLength(2));

    expect(keys[0]).toMatch(/\S/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("an explicitly disabled button never reaches the handler, and the caller's own disabled state survives the guard", async () => {
    const handler = vi.fn(async () => {});
    renderWithProviders(<SubmitButton data-testid="go" disabled onClick={handler}>Pay</SubmitButton>);

    const button = screen.getByTestId("go");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(handler).not.toHaveBeenCalled();
  });
});

/**
 * THE ENFORCEMENT POINT. The guard above is only worth what its adoption is worth, and the
 * discovery review's own finding on the 15 s polling convention is the warning: `POLL_MS` is
 * declared eleven times, so no single artefact's removal fails anything and the convention drifted
 * out of coverage one screen at a time. A source sweep is the artefact this convention was missing
 * — the `billing-purity.test.ts` precedent in `apps/core`, applied to a UI idiom.
 *
 * THE CENSUS IS PART OF THE ASSERTION (EXECUTION-LESSONS §2.37(b)): thirteen write lanes existed
 * when the guard landed, and they are pinned per screen below. A new money lane must update this
 * number deliberately — which is the point, not an inconvenience. The pair of checks is what makes
 * it discriminate: `offenders` alone would be satisfied by deleting every button, and the counts
 * alone would be satisfied by leaving a bare lane beside a guarded one.
 */
const WRITE_LANES: Record<string, number> = {
  "screens/billing-counter": 1, // submit-invoice
  "screens/billing-dues": 4, // clear-submit, clearance-submit, apply-submit, take-advance-submit
  "screens/billing-session": 3, // open-submit, close-submit, confirm-close
  "screens/billing-office": 5, // refund-request-submit, issue-submit, pay-submit, recon-submit, eie-confirm-submit
  "components/alerts-bell": 1, // mark-read — Plan 08.5 T5 / D11: the bell mounts SubmitButton prospectively
};

/**
 * Vitest runs each workspace from its own package root, so `src` resolves off `cwd`. The plan's
 * File Structure amendment 1 EXTENDS this to resolve any full relative path under `src/` — it
 * resolved `src/screens/<name>.tsx` only, and the bell lives in `src/components/`. A WRONG path
 * here cannot produce a false green: `readFileSync` throws, which fails the test loudly rather
 * than sweeping an empty file set and reporting no offenders — that property is preserved:
 * `resolve` + `readFileSync` throw exactly the same way for a path under `components/` as they
 * did for one under `screens/`.
 */
function screenSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), "src", `${relPath}.tsx`), "utf8");
}

describe("the single-submit convention across the billing screens", () => {
  it("NO billing screen still fires an async write from a bare Button — the idiom that double-posted is gone from all four", () => {
    const offenders: string[] = [];
    for (const name of Object.keys(WRITE_LANES)) {
      screenSource(name).split("\n").forEach((line, i) => {
        if (line.includes("onClick={() => void ")) offenders.push(`${name}.tsx:${String(i + 1)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The server mechanism (migration 0013) is inert unless the client actually sends a key, and
   * "every call site remembers to" is the §3.34 shape that has already cost this plan twice. The
   * census below is the artefact: `idemKey` followed by `,` or `)` is a USE (the handler
   * signatures spell it `idemKey: string`, which cannot match), so this counts the write calls
   * that actually thread the attempt key through to `api()`.
   */
  const KEYED_WRITES: Record<string, number> = {
    "screens/billing-counter": 1, // issueInvoice
    "screens/billing-dues": 5, // receipt ×2, allocation ×2, credit-note
    "screens/billing-office": 4, // refund request, issue, pay, eie
  };

  it("every write to an idempotency-protected route threads the attempt key through to api()", () => {
    const counted: Record<string, number> = {};
    for (const name of Object.keys(KEYED_WRITES)) {
      counted[name] = (screenSource(name).match(/idemKey[,)]/g) ?? []).length;
    }
    expect(counted).toEqual(KEYED_WRITES);
  });

  it("every one of the thirteen write lanes mounts a SubmitButton — the sweep above cannot be satisfied by deleting the buttons", () => {
    const counted: Record<string, number> = {};
    for (const name of Object.keys(WRITE_LANES)) {
      const src = screenSource(name);
      expect(src, `${name}.tsx must import SubmitButton`).toContain("submit-button");
      counted[name] = src.split("<SubmitButton").length - 1;
    }
    expect(counted).toEqual(WRITE_LANES);
  });
});
