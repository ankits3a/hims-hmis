import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { MoneyInput } from "./money-input";

/**
 * The harness submits what the FORM STATE holds, serialized exactly as a request body would be —
 * so "yields integer paise" is asserted from the value that would travel, not from the rendered
 * text. `JSON.stringify` is deliberate: it is the one place a float would betray itself
 * (`11232.999999999998` survives a `toBe(11233)` on nothing, but prints).
 */
function Harness({ onSubmit }: { onSubmit: (body: string) => void }): React.ReactElement {
  const [amountPaise, setAmountPaise] = useState<number | undefined>(undefined);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(JSON.stringify({ amountPaise }));
      }}
    >
      <MoneyInput id="amount" label="Amount" value={undefined} onChange={setAmountPaise} />
      <button type="submit">Submit</button>
    </form>
  );
}

describe("MoneyInput", () => {
  it("typing rupees yields INTEGER paise in the submitted body — 112.33 is 11233, never a float", async () => {
    const submitted = vi.fn();
    renderWithProviders(<Harness onSubmit={submitted} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Amount"), "112.33");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(submitted).toHaveBeenCalledWith('{"amountPaise":11233}');
    const value = (JSON.parse(submitted.mock.calls[0]![0] as string) as { amountPaise: number }).amountPaise;
    expect(Number.isInteger(value)).toBe(true);

    // whole rupees and a single decimal both land on the same integer scale
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "500");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith('{"amountPaise":50000}');

    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "0.5");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith('{"amountPaise":50}');
  });

  it("blank is undefined and is NOT an error — an optional amount left empty carries no refusal", async () => {
    const submitted = vi.fn();
    renderWithProviders(<Harness onSubmit={submitted} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith("{}"); // JSON.stringify drops an undefined member
    expect(screen.queryByRole("alert")).toBeNull();

    // typed, then cleared: back to undefined, still with no alert
    await user.type(screen.getByLabelText("Amount"), "12.00");
    await user.clear(screen.getByLabelText("Amount"));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith("{}");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a fractional-paise entry is refused inline and posts nothing — and the refusal is NOT over-broad", async () => {
    const submitted = vi.fn();
    renderWithProviders(<Harness onSubmit={submitted} />);
    const user = userEvent.setup();
    const box = screen.getByLabelText("Amount");

    // §3.44: the guard's own path AND the adjacent input that must still be allowed. 112.335 is a
    // third of a paise — unrepresentable on the wire — so it is refused and NOTHING travels.
    await user.type(box, "112.335");
    expect(screen.getByRole("alert")).toHaveTextContent("Amounts go to paise — at most two decimals");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith("{}");

    // the NOT-OVER-BROAD half: the same amount to two decimals is legitimate and must still pass
    await user.clear(box);
    await user.type(box, "112.33");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted).toHaveBeenLastCalledWith('{"amountPaise":11233}');

    // and so must every other legitimate shape the guard sits next to
    for (const [typed, body] of [["7", '{"amountPaise":700}'], ["7.5", '{"amountPaise":750}'], ["7.05", '{"amountPaise":705}']] as const) {
      await user.clear(box);
      await user.type(box, typed);
      expect(screen.queryByRole("alert")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Submit" }));
      expect(submitted).toHaveBeenLastCalledWith(body);
    }

    // a non-numeric entry is refused by the same guard
    await user.clear(box);
    await user.type(box, "12a");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
