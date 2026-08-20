import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { TenderEditor } from "./tender-editor";
import type { WireTender } from "../lib/billing-api";

/** The last value `onChange` emitted — the thing that becomes `receipt.tenders` in a request body. */
function lastEmit(onChange: ReturnType<typeof vi.fn>): WireTender[] {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]![0] as WireTender[];
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
});
