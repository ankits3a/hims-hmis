import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { TenderEditor } from "./tender-editor";
import { parseRupees } from "./money-input";
import type { TenderMode, WireTender } from "../lib/billing-api";

/** The last value `onChange` emitted — the thing that becomes `receipt.tenders` in a request body. */
function lastEmit(onChange: ReturnType<typeof vi.fn>): WireTender[] {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]![0] as WireTender[];
}

/** The second half of every emission: does this editor hold anything the cashier entered? */
function lastDrafted(onChange: ReturnType<typeof vi.fn>): boolean {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]![1] as boolean;
}

/** Flips the `lane` prop the way `billing-counter`'s three lane buttons do. */
function LaneHarness(
  { onChange }: { onChange: (tenders: WireTender[], drafted: boolean) => void },
): React.ReactElement {
  const [lane, setLane] = useState<{ mode: TenderMode; amountPaise: number; nonce: number } | null>(null);
  return (
    <>
      <button
        type="button"
        data-testid="press-cash"
        onClick={() => { setLane({ mode: "cash", amountPaise: 50000, nonce: 1 }); }}
      >
        cash lane
      </button>
      <TenderEditor payablePaise={50000} onChange={onChange} lane={lane} />
    </>
  );
}

/** `#tender-amount-0` — the ONE control in the row that can change the money. */
function amountField(): HTMLInputElement {
  return screen.getByLabelText("Amount", { selector: "#tender-amount-0" }) as HTMLInputElement;
}

describe("TenderEditor", () => {
  it("adds and removes tender rows, starting from one cash row", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TenderEditor payablePaise={50000} onChange={onChange} />);
    const user = userEvent.setup();

    expect(screen.getByTestId("tender-row-0")).toBeInTheDocument();
    expect(screen.queryByTestId("tender-row-1")).toBeNull();
    // a single row carries no remove control — a receipt with zero tenders is not a state
    expect(screen.queryByTestId("tender-remove-0")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add tender" }));
    await user.click(screen.getByRole("button", { name: "Add tender" }));
    expect(screen.getByTestId("tender-row-2")).toBeInTheDocument();

    // fill the middle row so its removal is observable in the emitted value, not just the DOM
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-1" }), "120");
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 12000 }]);

    await user.click(screen.getByTestId("tender-remove-1"));
    expect(screen.queryByTestId("tender-row-2")).toBeNull();
    expect(lastEmit(onChange)).toEqual([]);
  });

  it("the running total renders SHORT, EXACT and OVER against the payable — over is not an error", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TenderEditor payablePaise={50000} onChange={onChange} />);
    const user = userEvent.setup();

    expect(screen.getByTestId("tender-payable")).toHaveTextContent("₹500.00");
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Short by ₹500.00");

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "300");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹300.00");
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Short by ₹200.00");

    await user.clear(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "500");
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Exact");

    // D2 step 5: an over-tender is the change-due / banked-advance lane, never a refusal.
    await user.clear(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "520.50");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹520.50");
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Over by ₹20.50");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("upi and card rows require a reference — and the requirement is NOT over-broad: a cash row does not", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TenderEditor payablePaise={50000} onChange={onChange} />);
    const user = userEvent.setup();

    // §3.44's adjacent case FIRST: cash asks for no reference and is emitted without one.
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "500");
    expect(screen.queryByLabelText("Reference", { selector: "#tender-ref-0" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 50000 }]);

    // the guard's own path: switching the SAME row to upi demands the reference and, until it is
    // typed, drops the row from the emitted value — an unreconcilable tender cannot be posted.
    await user.selectOptions(screen.getByLabelText("Mode", { selector: "#tender-mode-0" }), "upi");
    expect(screen.getByRole("alert")).toHaveTextContent("A reference is required for UPI and card");
    expect(lastEmit(onChange)).toEqual([]);
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Short by ₹500.00");

    await user.type(screen.getByLabelText("Reference", { selector: "#tender-ref-0" }), "UPI-77123");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(lastEmit(onChange)).toEqual([{ mode: "upi", amountPaise: 50000, refText: "UPI-77123" }]);

    // card behaves as upi does
    await user.selectOptions(screen.getByLabelText("Mode", { selector: "#tender-mode-0" }), "card");
    expect(lastEmit(onChange)).toEqual([{ mode: "card", amountPaise: 50000, refText: "UPI-77123" }]);
  });

  it("onChange carries { mode, amountPaise, refText? } with INTEGER paise, in row order", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TenderEditor payablePaise={112330} onChange={onChange} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "112.33");
    await user.click(screen.getByRole("button", { name: "Add tender" }));
    await user.selectOptions(screen.getByLabelText("Mode", { selector: "#tender-mode-1" }), "card");
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-1" }), "1010.99");
    await user.type(screen.getByLabelText("Reference", { selector: "#tender-ref-1" }), "CARD-4411");

    const emitted = lastEmit(onChange);
    expect(emitted).toEqual([
      { mode: "cash", amountPaise: 11233 },
      { mode: "card", amountPaise: 101099, refText: "CARD-4411" },
    ]);
    // K38's property, at the component that produces the value: every amount is an INTEGER, and
    // the cash row carries no `refText` key at all rather than an empty string.
    for (const tender of emitted) expect(Number.isInteger(tender.amountPaise)).toBe(true);
    expect(Object.keys(emitted[0]!)).toEqual(["mode", "amountPaise"]);
    expect(JSON.stringify(emitted)).toBe(
      '[{"mode":"cash","amountPaise":11233},{"mode":"card","amountPaise":101099,"refText":"CARD-4411"}]',
    );
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 BACKLOG 2 — THE FIELD SHOWS WHAT WILL BE POSTED

     A lane press seeds an amount into ROW STATE and `toWire` posts it. The `MoneyInput` that
     displays and edits that amount was mounted with no `value`, so the cashier read a BLANK box
     while the full payable was armed — and a figure typed BEFORE the press vanished with nothing
     in its place, because the seed mints a fresh `row.key` and remounts the subtree. The reference
     box two lines below was already bound; only the control carrying the money was not.

     THE DISCRIMINATING ASSERTION IS THE FIELD AGAINST THE WIRE. The posted body is byte-identical
     fixed and unfixed — 50000 either way, the lane's arming is what it is — so a test that only
     inspects the request proves nothing here.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("FD-25 backlog 2: a lane-seeded amount is IN the field the cashier edits, not only in the value it emits", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <TenderEditor payablePaise={50000} onChange={onChange} lane={{ mode: "cash", amountPaise: 50000, nonce: 1 }} />,
    );

    const amount = await screen.findByLabelText("Amount", { selector: "#tender-amount-0" });
    // THE AMOUNT, read both ways and format-independently: what the box says and what becomes
    // `receipt.tenders` are ONE number. (`parseRupees("")` is `{ ok: true, paise: undefined }`,
    // which is what an unfixed run puts on the left of this.)
    expect(parseRupees((amount as HTMLInputElement).value))
      .toEqual({ ok: true, paise: lastEmit(onChange)[0]!.amountPaise });
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 50000 }]);
    expect(amount).toHaveValue("500.00");                                   // the readable secondary
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹500.00");  // and the screen agrees
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Exact");
  });

  it("FD-25 backlog 2: a lane pressed over a typed amount replaces it VISIBLY — the field never disagrees with the wire", async () => {
    const onChange = vi.fn();
    renderWithProviders(<LaneHarness onChange={onChange} />);
    const user = userEvent.setup();

    await user.type(amountField(), "300");
    expect(parseRupees(amountField().value)).toEqual({ ok: true, paise: 30000 });
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 30000 }]);

    await user.click(screen.getByTestId("press-cash"));

    // ₹500 recorded against a drawer that took ₹300: unfixed, the box goes BLANK here while the
    // full payable is on the wire, so nothing on the row states the figure it is about to post.
    expect(parseRupees(amountField().value))
      .toEqual({ ok: true, paise: lastEmit(onChange)[0]!.amountPaise });
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 50000 }]);
    expect(amountField()).toHaveValue("500.00");
  });
  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 CLOSE REVIEW — NULL IS NOT ZERO, AND THIS FOOTER IS WHERE IT WAS STILL SPENT AS ONE

     `billing-counter` knows the difference between "the server says ₹0" and "this screen has no
     price" — a failed fetch, a price for a draft since edited — and passed `payablePaise ?? 0`
     here anyway, on the reasoning that the arithmetic needs a number and nothing could be tendered
     against the zero. That covered POSTING and not STATING: the footer rendered the invented zero
     as a hard money fact and, with nothing typed, `0 === 0` lit the GREEN "Exact" pill. A cashier
     reads "Payable: ₹0.00 · Exact" as the verdict — settled, nothing to take — twelve lines under
     a red "the price could not be fetched" alert, and waves the patient through.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("FD-25 close review: an UNKNOWN payable states no figure and no verdict — and never a settled ₹0", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TenderEditor payablePaise={null} onChange={onChange} />);
    const user = userEvent.setup();

    expect(screen.getByTestId("tender-payable")).toHaveTextContent("—");
    // THE KILL: unfixed this is the green `pill on` reading "Exact", on a bill nobody has priced.
    expect(screen.queryByTestId("tender-state")).toBeNull();

    // the RUNNING TOTAL is this component's own fact and is still stated — the missing half is the
    // comparison, not the money the cashier has counted into the box
    await user.type(amountField(), "300");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹300.00");
    expect(screen.queryByTestId("tender-state")).toBeNull();
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 30000 }]);
  });

  /**
   * ═══ WHAT A BARE DIGIT WOULD DESTROY, ANSWERED BY THE COMPONENT THAT HOLDS IT ═══
   *
   * `billing-counter`'s lane keys REPLACE this whole row array, and the emitted tenders cannot tell
   * the screen what is at stake: an incomplete row — a UPI amount typed with the reference still
   * blank — is deliberately absent from them and is exactly the work that would be thrown away. So
   * the editor reports it. A row a LANE installed is explicitly NOT the cashier's work, which is
   * what keeps pressing 1 and then 2 to correct a lane from being refused.
   */
  it("FD-25 close review: the editor reports whether it holds anything the cashier entered", async () => {
    const onChange = vi.fn();
    renderWithProviders(<LaneHarness onChange={onChange} />);
    const user = userEvent.setup();

    expect(lastDrafted(onChange)).toBe(false);                    // the pristine mount

    await user.type(amountField(), "300");
    expect(lastDrafted(onChange)).toBe(true);                     // ₹300 the cashier counted out

    await user.click(screen.getByTestId("press-cash"));
    expect(lastEmit(onChange)).toEqual([{ mode: "cash", amountPaise: 50000 }]);
    expect(lastDrafted(onChange)).toBe(false);                    // the lane's own row, replaceable

    await user.click(screen.getByRole("button", { name: "Add tender" }));
    expect(lastDrafted(onChange)).toBe(true);                     // the second half of a mixed tender
  });

});
