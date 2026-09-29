import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouterState } from "@tanstack/react-router";
import { setToken } from "../../lib/api";
import i18next from "../../lib/i18n";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import { routeOf } from "./today";
import type { WireNeedRow } from "../../lib/office-needs-api";

/**
 * GAP-CLOSURE B3 — the Menu artboard: the stores screens are pages of the office's header menu. A side
 * with several entries opens a dropdown; an entry renders its existing screen inside the frame at
 * `/pharmacy/office?view=<side>&page=<entry>`; a person sees only the entries their grants open.
 */
function mock(perms: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/pharmacy/office/needs") {
      return new Response(JSON.stringify({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Every other read is refused: each screen still draws its own heading, which is what is asserted.
    return new Response("{}", { status: 404 });
  }));
}

/** Where the router is — the URL is the office's state, so this is the assertion that reload and back/forward depend on. */
function Where(): React.ReactElement {
  const at = useRouterState({ select: (s) => `${s.location.pathname}${s.location.searchStr}` });
  return <output data-testid="where">{at}</output>;
}

const EVERY_GRANT = [
  "materials.po.raise", "materials.vendors.manage", "pharmacy.dispense.read", "materials.bills.manage", "materials.returns.manage",
  "materials.stock.read", "materials.grn.capture", "materials.counts.perform", "pharmacy.downtime.enter",
  "materials.items.manage", "pharmacy.sale_items.manage", "formulary.manage", "materials.items.merge",
  "pharmacy.register.read", "pharmacy.ndps.custody", "pharmacy.retail.manage", "pharmacy.pharmacists.manage", "pharmacy.messages.manage",
  "pharmacy.reports.read",
];

/** The twelve folded screens: side, entry, and the heading the screen draws. */
const FOLDED: [string, string, string][] = [
  ["buy", "reorder", "pharmacyReorder.title"],
  ["buy", "vendors", "materialsVendors.title"],
  ["stock", "grn", "materialsGrn.title"],
  ["stock", "opening", "materialsGrn.title"],
  ["stock", "counts", "materialsCounts.title"],
  ["stock", "transfers", "materialsTransfers.title"],
  ["stock", "downtime", "pharmacyDowntime.title"],
  ["items", "master", "materialsItems.title"],
  ["items", "sells", "pharmacyItems.title"],
  ["items", "formulary", "formularyAdmin.title"],
  ["law", "h1", "pharmacyH1.title"],
  ["law", "retail", "pharmacyRetailLicence.title"],
  ["law", "pharmacists", "pharmacyPharmacists.title"],
];

describe("the office's header menu (gap-closure B3)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("each entry renders its screen inside the frame, at its own URL", async () => {
    mock(EVERY_GRANT);
    renderWithRouter(<><PharmacyOffice /><Where /></>, "/pharmacy/office");
    await screen.findByTestId("office-view-stock");
    for (const [side, page, title] of FOLDED) {
      await userEvent.click(screen.getByTestId(`office-view-${side}`));
      const drop = await screen.findByTestId(`office-drop-${side}`);
      await userEvent.click(within(drop).getByTestId(`office-entry-${page}`));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/pharmacy/office?view=${side}&page=${page}`));
      const frame = screen.getByTestId(`office-page-${side}`);
      expect(frame).toHaveAttribute("data-page", page);
      // Inside the frame, under the office's header, in the wrapper that keeps the shadcn controls.
      expect(await within(frame).findByRole("heading", { level: 1, name: i18next.t(title) })).toBeInTheDocument();
      expect(frame.querySelector(".pof-legacy h1")).not.toBeNull();
      expect(screen.queryByTestId(`office-drop-${side}`)).toBeNull();
    }
  }, 30_000);

  it("the dropdown names each entry and the address it had; the office's own sides are entries too", async () => {
    mock(EVERY_GRANT);
    renderWithRouter(<><PharmacyOffice /><Where /></>, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-law"));
    const drop = await screen.findByTestId("office-drop-law");
    expect(within(drop).getAllByRole("menuitem").map((b) => b.getAttribute("data-testid"))).toEqual([
      "office-entry-h1", "office-entry-controlled", "office-entry-retail", "office-entry-pharmacists", "office-entry-messages",
    ]);
    expect(within(drop).getByTestId("office-entry-h1")).toHaveTextContent("H1 registerwas /pharmacy/registers/h1");
    expect(within(drop).getByTestId("office-entry-controlled")).toHaveTextContent("Narcotics & Schedule X");
    await userEvent.click(within(drop).getByTestId("office-entry-controlled"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pharmacy/office?view=law&page=controlled"));
    // A side with one entry opens straight away, no dropdown.
    await userEvent.click(screen.getByTestId("office-view-pay"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pharmacy/office?view=pay"));
    expect(screen.queryByTestId("office-drop-pay")).toBeNull();
  });

  it("a URL opens its page directly — a reload lands where the person was", async () => {
    mock(EVERY_GRANT);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=stock&page=counts");
    const frame = await screen.findByTestId("office-page-stock");
    expect(frame).toHaveAttribute("data-page", "counts");
    expect(await within(frame).findByRole("heading", { level: 1, name: i18next.t("materialsCounts.title") })).toBeInTheDocument();
    expect(screen.getByTestId("office-view-stock")).toHaveAttribute("aria-current", "page");
  });

  it("S on Today opens the Stock menu from the keyboard; ↓ and ⏎ choose; Esc closes", async () => {
    mock(EVERY_GRANT);
    renderWithRouter(<><PharmacyOffice /><Where /></>, "/pharmacy/office");
    await screen.findByTestId("office-view-stock");
    await userEvent.keyboard("s");
    const drop = await screen.findByTestId("office-drop-stock");
    await waitFor(() => expect(within(drop).getByTestId("office-entry-grn")).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(drop).getByTestId("office-entry-counts")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("office-drop-stock")).toBeNull();
    await userEvent.keyboard("s");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pharmacy/office?view=stock&page=counts"));
  });

  it("shows only the entries the person's grants open, and hides a side with none", async () => {
    mock(["materials.stock.read"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    const nav = await screen.findByRole("navigation", { name: "Office" });
    await waitFor(() => expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Stock"]));
    await userEvent.click(screen.getByTestId("office-view-stock"));
    const drop = await screen.findByTestId("office-drop-stock");
    expect(within(drop).getAllByRole("menuitem").map((b) => b.getAttribute("data-testid"))).toEqual(["office-entry-grn", "office-entry-transfers", "office-entry-ledger"]);
  });

  it("a pharmacist whose only grant is the H1 register reaches the office on its Law side", async () => {
    mock(["pharmacy.register.read"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=law&page=h1");
    const nav = await screen.findByRole("navigation", { name: "Office" });
    await waitFor(() => expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Law"]));
    const frame = await screen.findByTestId("office-page-law");
    expect(await within(frame).findByRole("heading", { level: 1, name: i18next.t("pharmacyH1.title") })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("office-view-law"));
    const drop = await screen.findByTestId("office-drop-law");
    // The retail licence, the pharmacists and the messages are other people's.
    expect(within(drop).getAllByRole("menuitem").map((b) => b.getAttribute("data-testid"))).toEqual(["office-entry-h1", "office-entry-controlled"]);
  });

  it("an entry the person may not open falls back to the side's first entry they may", async () => {
    mock(["materials.stock.read"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=stock&page=counts");
    const frame = await screen.findByTestId("office-page-stock");
    await waitFor(() => expect(frame).toHaveAttribute("data-page", "grn"));
    expect(within(frame).queryByRole("heading", { level: 1, name: i18next.t("materialsCounts.title") })).toBeNull();
  });
});

/**
 * Stage D — the four safety registers are pages of the office's menu: the ADR register and the
 * medication-incident log under Law, the fridge log and the emergency trays under Stock.
 */
const STAGE_D: [string, string, string, string][] = [
  ["law", "adr", "adr-view", "pharmacy.adr.record"],
  ["law", "incidents", "incidents-view", "pharmacy.incidents.record"],
  ["stock", "cold", "cold-chain-view", "pharmacy.coldchain.record"],
  ["stock", "trays", "trays-view", "pharmacy.trays.check"],
];

describe("the office's menu carries the stage-D safety pages", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("each stage-D entry is named in the dropdown and renders its register inside the frame, at its own URL", async () => {
    mock([...EVERY_GRANT, ...STAGE_D.map(([, , , g]) => g)]);
    renderWithRouter(<><PharmacyOffice /><Where /></>, "/pharmacy/office");
    await screen.findByTestId("office-view-stock");
    for (const [side, page, view] of STAGE_D) {
      await userEvent.click(screen.getByTestId(`office-view-${side}`));
      const drop = await screen.findByTestId(`office-drop-${side}`);
      const entry = within(drop).getByTestId(`office-entry-${page}`);
      expect(entry).toHaveTextContent(i18next.t(`pharmacyOffice.menu.page.${page}`));
      expect(i18next.exists(`pharmacyOffice.menu.page.${page}`)).toBe(true);
      await userEvent.click(entry);
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/pharmacy/office?view=${side}&page=${page}`));
      const frame = screen.getByTestId(`office-page-${side}`);
      expect(frame).toHaveAttribute("data-page", page);
      expect(await within(frame).findByTestId(view)).toBeInTheDocument();
    }
  }, 30_000);

  it("a person whose only grant is the fridge log sees Stock with that one page and nothing else", async () => {
    mock(["pharmacy.coldchain.record"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=stock");
    const nav = await screen.findByRole("navigation", { name: "Office" });
    await waitFor(() => expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Stock"]));
    const frame = await screen.findByTestId("office-page-stock");
    await waitFor(() => expect(frame).toHaveAttribute("data-page", "cold"));
    expect(await within(frame).findByTestId("cold-chain-view")).toBeInTheDocument();
  });

  it("the Today list's stage-D rows open their page, not only the side", () => {
    const row = (kind: string): WireNeedRow => ({ kind, ref: { id: "x" } }) as unknown as WireNeedRow;
    const cases: [string, string, string][] = [
      ["adr_pvpi_overdue", "law", "adr"], ["adr_pvpi_serious", "law", "adr"], ["adr_pvpi", "law", "adr"],
      ["incident_review_overdue", "law", "incidents"], ["incident_review", "law", "incidents"],
      ["cold_excursion_open", "stock", "cold"], ["cold_reading_missed", "stock", "cold"],
      ["tray_deficient", "stock", "trays"], ["tray_daily_missed", "stock", "trays"], ["tray_monthly_missed", "stock", "trays"], ["tray_expiring", "stock", "trays"],
    ];
    for (const [kind, view, page] of cases) expect([kind, routeOf(row(kind), "pri")]).toEqual([kind, { to: "view", view, page }]);
  });
});
