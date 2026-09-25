import { screen } from "@testing-library/react";
import { renderWithRouter } from "../../test-utils";
import { ReturnPlanCard, returnPlanOf } from "./short-book";

/**
 * PARITY P4 — "expiry return bana do": the copilot's return PLAN is a card at the desk that writes
 * nothing; it opens the office's returns side. A plan with nothing to return or destroy is no card.
 */
describe("the agent's return card at the desk (parity P4)", () => {
  it("a return plan is a card; an empty one, or another tool's payload, is not", () => {
    const plan = { kind: "supplier_return_plan", href: "/pharmacy/office?view=returns", vendors: 2, batches: 5, taxablePaise: 42_000, toDestroy: 1 };
    expect(returnPlanOf(plan)).toEqual(plan);
    expect(returnPlanOf({ ...plan, batches: 0, toDestroy: 0 })).toBeNull();
    expect(returnPlanOf({ ...plan, batches: 0, toDestroy: 2 })).not.toBeNull();
    expect(returnPlanOf({ kind: "payment_run_plan", bills: 3 })).toBeNull();
    expect(returnPlanOf(null)).toBeNull();
  });

  it("says what the agent would draft and offers the office", async () => {
    renderWithRouter(<ReturnPlanCard plan={{ kind: "supplier_return_plan", href: "/pharmacy/office?view=returns", vendors: 2, batches: 5, taxablePaise: 42_000, toDestroy: 1 }} onDone={() => undefined} />);
    const card = await screen.findByTestId("desk-return-card");
    expect(card).toHaveTextContent("vendors: 2 · batches: 5 · 1 to destroy");
    expect(screen.getByRole("button", { name: "Open the office" })).toBeTruthy();
  });
});
