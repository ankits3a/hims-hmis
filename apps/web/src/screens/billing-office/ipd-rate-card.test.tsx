import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";
import { IpdRateCard } from "./ipd-rate-card";
import type { WireIpdRateCard } from "./ipd-rate-card";

/**
 * E0.4 — the owner reviews the IPD rate card in the price list: price or the WORD "Missing" (never
 * colour alone), a count line, and the imported draft shown first. Every figure is a fake test value.
 */
type Cell = WireIpdRateCard["classes"][number]["cells"][number];
const cell = (component: Cell["component"], pricePaise: number | null): Cell => ({
  component, required: component === "room" || component === "nursing" || component === "visit",
  serviceCode: `IPD_${component.toUpperCase()}_X`, pricePaise, state: pricePaise === null ? "no_price" : "priced",
});
const DRAFT_CARD: WireIpdRateCard = {
  version: { versionId: "v-draft", versionNo: 7, status: "draft" },
  classes: [
    { bedClass: "general", label: "General ward", missing: [], cells: [cell("room", 100000), cell("nursing", 20000), cell("rmo", null), cell("visit", 30000), cell("cross_visit", null)] },
    { bedClass: "icu", label: "Intensive care", missing: ["nursing", "visit"], cells: [cell("room", 400000), cell("nursing", null), cell("rmo", null), cell("visit", null), cell("cross_visit", null)] },
  ],
  ready: 1, missing: 1,
};
const IN_FORCE_CARD: WireIpdRateCard = {
  version: { versionId: "v-live", versionNo: 6, status: "activated" },
  classes: DRAFT_CARD.classes.map((c) => ({ ...c, missing: ["room", "nursing", "visit"], cells: c.cells.map((x) => ({ ...x, pricePaise: null, state: "no_price" as const })) })),
  ready: 0, missing: 2,
};

function mock(perms: string[], on: string[] = ["ipd"]): { cardCalls: string[] } {
  const cardCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } }, modules: { dark: ["ipd"], on } });
    if (path === "/billing/office/needs") return json({ rows: [], money: { toPayCount: 0, toPayPaise: 0, shortPaise: 0 } });
    if (path === "/billing/consult-prices") return json({
      rows: [
        { branch: "new", serviceId: "s-new", code: "OPD-CONSULT-NEW", activePaise: 10000 },
        { branch: "renewal", serviceId: "s-ren", code: "OPD-CONSULT-RENEWAL", activePaise: 10000 },
        { branch: "revisit", serviceId: "s-rev", code: "OPD-CONSULT-REVISIT", activePaise: null },
      ],
      activeVersionNo: 6, pending: null,
    });
    if (path === "/tariff/versions") {
      return json({ items: [{ id: "v-live", versionNo: 6, status: "activated" }, { id: "v-draft", versionNo: 7, status: "draft" }] });
    }
    if (path.startsWith("/tariff/ipd-rate-card")) {
      cardCalls.push(path);
      return json(path.includes("versionId=v-draft") ? DRAFT_CARD : IN_FORCE_CARD);
    }
    return new Response("{}", { status: 404 });
  }));
  return { cardCalls };
}

describe("the IPD rate card (E0.4)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("opens on the imported draft: prices, the word Missing on a required gap, Not set on an optional one, and the count", async () => {
    const { cardCalls } = mock(["tariff.read"]);
    renderWithProviders(<IpdRateCard />);
    expect(await screen.findByTestId("ipd-rate-card-count")).toHaveTextContent("1 classes ready to go live, 1 missing");
    expect(cardCalls).toEqual(["/tariff/ipd-rate-card?versionId=v-draft"]);
    expect(screen.getByTestId("ipd-rate-general-room")).toHaveTextContent("₹1,000.00");
    expect(screen.getByTestId("ipd-rate-icu-room")).toHaveTextContent("₹4,000.00");
    expect(screen.getByTestId("ipd-rate-icu-nursing")).toHaveTextContent("Missing");
    expect(screen.getByTestId("ipd-rate-icu-visit")).toHaveTextContent("Missing");
    expect(screen.getByTestId("ipd-rate-general-rmo")).toHaveTextContent("Not set");
    expect(screen.getByTestId("ipd-rate-general")).toHaveAttribute("data-ready", "true");
    expect(screen.getByTestId("ipd-rate-icu")).toHaveAttribute("data-ready", "false");
    const grid = screen.getByTestId("ipd-rate-card-grid");
    expect(within(grid).getAllByText("Missing")).toHaveLength(2);
  });

  it("switches to the version in force", async () => {
    const { cardCalls } = mock(["tariff.read"]);
    renderWithProviders(<IpdRateCard />);
    await screen.findByTestId("ipd-rate-card-count");
    await userEvent.selectOptions(screen.getByTestId("ipd-rate-card-version"), "In force");
    await waitFor(() => expect(screen.getByTestId("ipd-rate-card-count")).toHaveTextContent("0 classes ready to go live, 2 missing"));
    expect(cardCalls).toContain("/tariff/ipd-rate-card");
    expect(within(screen.getByTestId("ipd-rate-card-grid")).getAllByText("Missing")).toHaveLength(6);
  });

  it("a person without the tariff read is told so", async () => {
    mock(["billing.reports.read"]);
    renderWithProviders(<IpdRateCard />);
    expect(await screen.findByTestId("ipd-rate-card-noaccess")).toBeInTheDocument();
  });

  it("sits on the back office's Prices page under the consultation prices", async () => {
    mock(["billing.reports.read", "tariff.read"]);
    renderWithRouter(<BillingOffice />, "/billing/office?view=prices");
    expect(await screen.findByTestId("office-page-prices")).toBeInTheDocument();
    expect(await screen.findByTestId("ipd-rate-card-count")).toHaveTextContent("1 classes ready to go live, 1 missing");
  });

  it("decision 0085 — is not on the Prices page while the server has `ipd` switched off, and asks for nothing", async () => {
    const { cardCalls } = mock(["billing.reports.read", "tariff.read"], []);
    renderWithRouter(<BillingOffice />, "/billing/office?view=prices");
    expect(await screen.findByTestId("office-page-prices")).toBeInTheDocument();
    await screen.findByText(/OPD-CONSULT-NEW|consult/i).catch(() => undefined);
    expect(screen.queryByTestId("ipd-rate-card")).not.toBeInTheDocument();
    expect(cardCalls).toEqual([]);
  });
});
