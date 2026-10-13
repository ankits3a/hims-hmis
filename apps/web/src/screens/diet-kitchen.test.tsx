import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DietKitchen } from "./diet-kitchen";
import { kitchenView, line, list, stubFetch } from "./diet-fixture";

/** E4.4 DIET (issue #736) — the kitchen board: counts per ward, Build on a preview, Dispatch only after print, sealed labels. */
describe("DietKitchen (E4.4)", () => {
  let posted: string[];
  beforeEach(() => { setToken("t"); posted = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  const lists = [
    list({ id: null, wardId: "w0", wardName: "ICU", state: "preview", counts: { trays: 3, npo: 0, withdrawn: 0, late: 0, byDiet: { liquid_full: 3 } } }),
    list({
      wardId: "w1", state: "built",
      lines: [
        line({ admissionId: "a1", patient: { name: "Guest K", uhid: "UH-SEALED-77", sealed: true }, bedCode: "W1-B07", allergies: ["Allergy: Peanut (severe)"] }),
        line({ id: "l2", admissionId: "a2", patient: { name: "Sita Devi", uhid: "UH-1002", sealed: false }, code: "ryles_feed", tube: "200 ml every 3 h" }),
        line({ id: "l3", admissionId: "a3", state: "withdrawn", withdrawnReason: "npo", patient: { name: "Mohan Lal", uhid: "UH-1003", sealed: false } }),
      ],
    }),
    list({ id: "list2", wardId: "w2", wardName: "Surgical Ward", state: "printed", printedAt: new Date().toISOString() }),
  ];

  it("shows each ward's state and counts; Dispatch appears only on a printed list; Build on a preview", async () => {
    stubFetch({ "/diet/kitchen": kitchenView(lists) }, ["diet.view", "diet.kitchen"], posted);
    renderWithProviders(<DietKitchen />);
    const w1 = await screen.findByTestId("dk-ward-w1");
    expect(within(w1).getByTestId("dk-state")).toHaveTextContent("Built");
    expect(within(w1).getByTestId("dk-card-trays")).toHaveTextContent("2");
    expect(within(w1).getByTestId("dk-card-npo")).toHaveTextContent("1");
    expect(within(w1).queryByTestId("dk-dispatch")).toBeNull();
    expect(within(await screen.findByTestId("dk-ward-w2")).getByTestId("dk-dispatch")).toBeInTheDocument();
    const w0 = screen.getByTestId("dk-ward-w0");
    expect(within(w0).queryByTestId("dk-print")).toBeNull();
    await userEvent.setup().click(within(w0).getByTestId("dk-build"));
    expect(posted).toEqual(["/api/diet/lists/build"]);
    expect(screen.getByTestId("diet-kitchen").textContent ?? "").not.toMatch(/₹|paise|price|amount/i);
  });

  it("a reader without diet.kitchen sees the board but no acts", async () => {
    stubFetch({ "/diet/kitchen": kitchenView(lists) }, ["diet.view"], posted);
    renderWithProviders(<DietKitchen />);
    const w2 = await screen.findByTestId("dk-ward-w2");
    expect(within(w2).queryByTestId("dk-dispatch")).toBeNull();
    expect(screen.queryByTestId("dk-build")).toBeNull();
  });

  it("Print renders the A4 list and one label per tray; a sealed patient's label carries the alias and no UHID; the list is marked printed", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    stubFetch({ "/diet/kitchen": kitchenView(lists) }, ["diet.view", "diet.kitchen"], posted);
    renderWithProviders(<DietKitchen />);
    await userEvent.setup().click(within(await screen.findByTestId("dk-ward-w1")).getByTestId("dk-print"));
    const sheet = await screen.findByTestId("dk-print-sheet");
    const sealed = within(sheet).getByTestId("dk-label-a1");
    expect(within(sealed).getByTestId("dk-label-name")).toHaveTextContent("Guest K");
    expect(within(sealed).getByTestId("dk-label-uhid")).toBeEmptyDOMElement();
    expect(sheet.textContent ?? "").not.toContain("UH-SEALED-77"); // review item 20: a real UHID exists and is never printed
    expect(sealed).toHaveTextContent("W1-B07");
    expect(within(sheet).getByTestId("dk-label-a2")).toHaveTextContent("UH-1002");
    expect(within(sheet).queryByTestId("dk-label-a3")).toBeNull(); // NPO: no tray, no label
    expect(sheet).toHaveTextContent("NPO — no tray");
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // Review item 17: nothing is marked printed until the kitchen confirms the paper came out.
    const confirm = await screen.findByTestId("dk-confirm");
    expect(posted).toEqual([]);
    await userEvent.setup().click(within(confirm).getByTestId("dk-confirm-yes"));
    await vi.waitFor(() => expect(posted).toEqual(["/api/diet/lists/list1/printed"]));
  });

  it("a list changed since print offers 'Reprint changes', never Dispatch; the reprint carries only the changed lines, highlighted", async () => {
    vi.stubGlobal("print", vi.fn());
    const printedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const changed = list({
      id: "list3", wardId: "w3", wardName: "Ortho Ward", state: "printed", printedAt, lastPrintedAt: printedAt, changedSincePrint: true,
      lines: [
        line({ id: "c1", admissionId: "b1", bedCode: "O-B01", patient: { name: "Unchanged Person", uhid: "UH-2001", sealed: false } }),
        line({ id: "c2", admissionId: "b2", bedCode: "O-B02", state: "withdrawn", withdrawnReason: "npo", changedAt: new Date().toISOString(),
          patient: { name: "Now Npo", uhid: "UH-2002", sealed: false } }),
      ],
    });
    stubFetch({ "/diet/kitchen": kitchenView([changed]) }, ["diet.view", "diet.kitchen"], posted);
    renderWithProviders(<DietKitchen />);
    const w3 = await screen.findByTestId("dk-ward-w3");
    expect(within(w3).getByTestId("dk-changed")).toBeInTheDocument();
    expect(within(w3).queryByTestId("dk-dispatch")).toBeNull();
    expect(within(w3).getByTestId("dk-print")).toHaveTextContent("Reprint changes");
    await userEvent.setup().click(within(w3).getByTestId("dk-print"));
    const sheet = await screen.findByTestId("dk-print-sheet");
    expect(sheet).toHaveTextContent("Now Npo");
    expect(sheet).not.toHaveTextContent("Unchanged Person");
    expect(sheet.querySelector("tr.chg")).not.toBeNull();
  });
});
