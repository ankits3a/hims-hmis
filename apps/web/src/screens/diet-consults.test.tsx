import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DietConsults } from "./diet-consults";
import { consultsView, kitchenView, stubFetch } from "./diet-fixture";

/** E4.4 DIET (issue #736) — the dietician's queue: alias for a sealed patient, the wait, Complete with a note; meal rounds. */
describe("DietConsults (E4.4)", () => {
  let posted: string[];
  beforeEach(() => { setToken("t"); posted = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the waiting consult (alias, 26 h, hot) and completes it with a note", async () => {
    stubFetch({ "/diet/consults": consultsView(), "/diet/rounds": kitchenView([]).rounds }, ["diet.manage"], posted);
    renderWithProviders(<DietConsults />);
    const row = await screen.findByTestId("dc-c1");
    expect(within(row).getByTestId("dc-name")).toHaveTextContent("Guest K");
    expect(within(row).getByTestId("dc-wait")).toHaveTextContent("26 h");
    expect(row).toHaveClass("hot");
    const user = userEvent.setup();
    expect(within(row).getByTestId("dc-complete")).toBeDisabled();
    await user.type(within(row).getByTestId("dc-note"), "Low potassium diet");
    await user.click(within(row).getByTestId("dc-complete"));
    expect(posted).toEqual(["/api/diet/consults/c1/complete"]);
    expect(await screen.findByTestId("dc-round-lunch")).toBeInTheDocument();
  });
});
