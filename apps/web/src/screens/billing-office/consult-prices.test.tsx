import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";
import { ConsultPrices, rupeesToPaise } from "./consult-prices";
import type { WireConsultPrices } from "../../lib/billing-api";

/**
 * OWNER, 2026-10-05 — "build a price list in billing screen so that I could change values from
 * there. Revisit charge, New and Renewal charges." A change is proposed, then approved by the owner
 * (not the proposer), and charged from that moment.
 */
const ROWS: WireConsultPrices["rows"] = [
  { branch: "new", serviceId: "s-new", code: "OPD-CONSULT-NEW", activePaise: 30000 },
  { branch: "renewal", serviceId: "s-ren", code: "OPD-CONSULT-RENEWAL", activePaise: 15000 },
  { branch: "revisit", serviceId: "s-rev", code: "OPD-CONSULT-REVISIT", activePaise: null },
];
const PENDING: NonNullable<WireConsultPrices["pending"]> = {
  versionId: "v2", versionNo: 2, approvalId: "a1", approvalStatus: "pending",
  proposedBy: { id: "u-editor", name: "Price Editor" }, proposedAt: "2026-10-05T05:00:00.000Z", note: "owner's fees",
  prices: { new: 10000, renewal: 15000, revisit: 5000 },
};

function mock(me: string, perms: string[], start: WireConsultPrices): { posts: { path: string; body: unknown }[] } {
  let current = start;
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/billing/office/needs") return json({ rows: [], money: { toPayCount: 0, toPayPaise: 0, shortPaise: 0 } });
    if (path === "/billing/consult-prices" && (init?.method ?? "GET") === "GET") return json(current);
    if (path.startsWith("/billing/consult-prices") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === "/billing/consult-prices/now") {
        const prices = (body as { prices: Record<string, number> }).prices;
        current = { ...current, activeVersionNo: 2, rows: current.rows.map((r) => ({ ...r, activePaise: prices[r.branch] ?? r.activePaise })) };
      } else if (path === "/billing/consult-prices") {
        const prices = (body as { prices: Record<string, number> }).prices;
        current = { ...current, pending: { ...PENDING, proposedBy: { id: me, name: "Me" }, prices: { new: prices.new ?? 30000, renewal: prices.renewal ?? 15000, revisit: prices.revisit ?? null } } };
      } else {
        const p = current.pending!;
        current = { ...current, activeVersionNo: 2, pending: null, rows: current.rows.map((r) => ({ ...r, activePaise: p.prices[r.branch] })) };
      }
      return json(current);
    }
    return new Response("{}", { status: 404 });
  }));
  return { posts };
}

describe("the consultation price list (owner, 2026-10-05)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("reads rupees the way a person types them", () => {
    expect(rupeesToPaise("100")).toBe(10000);
    expect(rupeesToPaise("150.5")).toBe(15050);
    expect(rupeesToPaise("₹1,250.00")).toBe(125000);
    expect(rupeesToPaise("0")).toBe(0);
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("10.555")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
  });

  it("the billing manager sees the three prices in force and sends only what changed for approval", async () => {
    const { posts } = mock("u-editor", ["billing.reports.read", "billing.config.write"], { rows: ROWS, activeVersionNo: 1, pending: null });
    renderWithProviders(<ConsultPrices />);
    expect(await screen.findByTestId("consult-price-new-active")).toHaveTextContent("₹300.00");
    expect(screen.getByTestId("consult-price-renewal-active")).toHaveTextContent("₹150.00");
    expect(screen.getByTestId("consult-price-revisit-active")).toHaveTextContent("Free");
    expect(screen.getByTestId("consult-prices-send")).toBeDisabled(); // nothing changed yet
    expect(screen.queryByTestId("consult-prices-now")).toBeNull(); // only the admin changes directly
    expect(screen.getByTestId("consult-prices-rule")).toHaveTextContent("goes to the admin for approval");

    const input = screen.getByLabelText("New price for New consultation, in rupees");
    await userEvent.clear(input);
    await userEvent.type(input, "100");
    await userEvent.type(screen.getByLabelText("New price for Revisit, in rupees"), "50");
    await userEvent.click(screen.getByTestId("consult-prices-send"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/billing/consult-prices", body: { prices: { new: 10000, revisit: 5000 } } });
    expect(await screen.findByTestId("consult-prices-waiting")).toHaveTextContent("You sent this. The admin must approve it");
    expect(screen.queryByTestId("consult-approve")).toBeNull();
  });

  it("the admin sees what is waiting, who asked, and approves it with a note", async () => {
    const { posts } = mock("u-owner", ["billing.reports.read", "tariff.versions.activate"], { rows: ROWS, activeVersionNo: 1, pending: PENDING });
    renderWithProviders(<ConsultPrices />);
    expect(await screen.findByTestId("consult-prices-proposer")).toHaveTextContent("Proposed by Price Editor on 05 Oct, 10:30");
    expect(screen.getByTestId("consult-pending-new")).toHaveTextContent("₹300.00→₹100.00");
    expect(screen.getByTestId("consult-pending-revisit")).toHaveTextContent("Free→₹50.00");
    expect(screen.queryByTestId("consult-prices-send")).toBeNull(); // one change at a time
    expect(screen.queryByTestId("consult-prices-now")).toBeNull();

    const approve = screen.getByTestId("consult-approve");
    expect(approve).toBeDisabled(); // the note is required
    await userEvent.type(screen.getByTestId("consult-decision-note"), "ok from today");
    await userEvent.click(approve);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/billing/consult-prices/v2/decision", body: { approve: true, note: "ok from today" } });
    expect(await screen.findByRole("status")).toHaveTextContent("charged from now");
    expect(screen.getByTestId("consult-price-new-active")).toHaveTextContent("₹100.00");
  });

  it("owner ruling 2026-10-05: the admin changes prices directly, with a required reason", async () => {
    const { posts } = mock("u-owner", ["billing.reports.read", "billing.config.write", "tariff.versions.activate"], { rows: ROWS, activeVersionNo: 1, pending: null });
    renderWithProviders(<ConsultPrices />);
    const now = await screen.findByTestId("consult-prices-now");
    expect(screen.queryByTestId("consult-prices-send")).toBeNull();
    expect(screen.getByTestId("consult-prices-rule")).toHaveTextContent("charged from the moment you save it");
    const input = screen.getByLabelText("New price for New consultation, in rupees");
    await userEvent.clear(input);
    await userEvent.type(input, "100");
    expect(now).toBeDisabled(); // the reason is required
    await userEvent.type(screen.getByTestId("consult-prices-note"), "owner's new fees");
    await userEvent.click(now);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/billing/consult-prices/now", body: { prices: { new: 10000 }, note: "owner's new fees" } });
    expect(await screen.findByRole("status")).toHaveTextContent("recorded with your name and reason");
    expect(screen.getByTestId("consult-price-new-active")).toHaveTextContent("₹100.00");
  });

  it("a reader without the billing office's read is told so", async () => {
    mock("u-nurse", ["opd.queue.read"], { rows: ROWS, activeVersionNo: 1, pending: null });
    renderWithProviders(<ConsultPrices />);
    expect(await screen.findByTestId("consult-prices-noaccess")).toBeInTheDocument();
  });

  it("is a page of the back office's header menu", async () => {
    mock("u-owner", ["billing.reports.read"], { rows: ROWS, activeVersionNo: 1, pending: null });
    renderWithRouter(<BillingOffice />, "/billing/office?view=prices");
    expect(await screen.findByTestId("office-page-prices")).toBeInTheDocument();
    expect(await screen.findByTestId("consult-price-new-active")).toHaveTextContent("₹300.00");
    expect(screen.getByTestId("office-view-prices")).toHaveTextContent("Prices");
  });
});
