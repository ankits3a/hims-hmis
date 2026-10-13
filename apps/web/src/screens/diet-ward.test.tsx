import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DietWard } from "./diet-ward";
import { sheetView, stubFetch } from "./diet-fixture";

/** E4.4 DIET (issue #736) — the ward diet sheet: NPO in red, allergies, and acts by permission (a nurse: NPO only). */
describe("DietWard (E4.4)", () => {
  let posted: string[];
  beforeEach(() => { setToken("t"); posted = []; try { localStorage.clear(); } catch { /* none */ } });
  afterEach(() => { vi.unstubAllGlobals(); });
  const routes = { "/diet/wards": [{ id: "w1", code: "W1", name: "Medical Ward 1" }], "/diet/wards/w1/sheet": sheetView() };

  it("a nurse sees the NPO badge and allergies, can lift NPO and set it, but never 'Order diet'", async () => {
    stubFetch(routes, ["diet.view", "diet.npo", "diet.serve"], posted);
    renderWithProviders(<DietWard />);
    const a1 = await screen.findByTestId("dw-bed-a1");
    expect(within(a1).getByTestId("dw-npo")).toHaveTextContent("NPO");
    expect(within(a1).getByTestId("dw-allergies")).toHaveTextContent("Peanut");
    expect(within(a1).getByTestId("dw-diet")).toHaveTextContent("No order — normal tray");
    expect(within(a1).getByTestId("dw-lift-npo")).toBeInTheDocument();
    expect(screen.queryByTestId("dw-order")).toBeNull();
    const a2 = screen.getByTestId("dw-bed-a2");
    expect(within(a2).getByTestId("dw-set-npo")).toBeInTheDocument();
    expect(within(a2).getByTestId("dw-diet")).toHaveTextContent("200 ml every 3 h");
    // The next tray is dispatched: the nurse taps it delivered.
    await userEvent.setup().click(within(a2).getByTestId("dw-delivered"));
    expect(posted).toEqual(["/api/diet/lines/l2/serve"]);
    expect(within(a1).queryByTestId("dw-delivered")).toBeNull(); // a withdrawn tray is never served
    expect(screen.getByTestId("diet-ward").textContent ?? "").not.toMatch(/₹|paise|price|amount/i);
  });

  it("a doctor orders a diet; a Ryle's feed asks ml and hours", async () => {
    const user = userEvent.setup();
    stubFetch({ ...routes, "/diet/catalogue": [
      { code: "normal", label: "Normal", therapeutic: false, tubeFeed: false, npo: false },
      { code: "ryles_feed", label: "Ryle's tube feed", therapeutic: true, tubeFeed: true, npo: false },
    ] }, ["diet.view", "diet.order", "diet.npo"], posted);
    renderWithProviders(<DietWard />);
    const a1 = await screen.findByTestId("dw-bed-a1");
    await user.click(within(a1).getByTestId("dw-order"));
    const panel = await within(a1).findByTestId("dw-order-panel");
    await vi.waitFor(() => expect(within(panel).getAllByRole("option")).toHaveLength(2));
    expect(within(panel).queryByTestId("dw-ml")).toBeNull();
    await user.selectOptions(within(panel).getByTestId("dw-code"), "ryles_feed");
    expect(within(panel).getByTestId("dw-ml")).toBeInTheDocument();
    await user.click(within(panel).getByTestId("dw-order-save"));
    expect(posted).toEqual(["/api/diet/orders"]);
  });
});
