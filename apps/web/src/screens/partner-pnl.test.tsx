import { screen } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PartnerPnl } from "./partner-pnl";

/**
 * PLAN 09 T8 — the channel P&L screen.
 *
 * Two things carry the weight: it renders every field the read model declares, per partner, and it
 * reads an EMPTY state cleanly (the acceptance line's "reads zeros with the lanes off and does not
 * error", seen from the screen's side — an empty array from the server renders the empty message,
 * never a crash).
 *
 * `stubFetch` (test-utils.tsx) always answers 200, so the mocked route below is deliberately
 * self-contained — the `counter-instruments.test.tsx` / `partner-receivables.test.tsx` precedent.
 *
 * Every partner, code and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(handler.body), {
        status: handler.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const PNL = "GET /api/partners/pnl";

const PARTNER_A = {
  counterpartyId: "01HCP0000000000000000001",
  counterpartyName: "Invented Diagnostic Partner",
  payeeClass: "channel_partner",
  asOf: "2026-08-19T06:00:00.000Z",
  cardsActive: 42,
  memberSpendPaise: 1_250_000,
  payableCommissionPaise: 60_000,
  receivableExpectedPaise: 30_000,
  receivableMatchedPaise: 90_000,
  receivableDisputedPaise: 5_000,
  netChannelMarginPaise: 30_000,
};

describe("PartnerPnl", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders one row per partner with every field the read model declares", async () => {
    mockRoutes({ [PNL]: { status: 200, body: [PARTNER_A] } });
    renderWithProviders(<PartnerPnl />);

    const row = await screen.findByTestId(`partner-${PARTNER_A.counterpartyId}`);
    expect(row).toHaveTextContent("Invented Diagnostic Partner");
    expect(screen.getByTestId(`cards-active-${PARTNER_A.counterpartyId}`)).toHaveTextContent("42");
    expect(screen.getByTestId(`member-spend-${PARTNER_A.counterpartyId}`)).toHaveTextContent("12,500.00");
    expect(screen.getByTestId(`payable-${PARTNER_A.counterpartyId}`)).toHaveTextContent("600.00");
    expect(screen.getByTestId(`receivable-expected-${PARTNER_A.counterpartyId}`)).toHaveTextContent("300.00");
    expect(screen.getByTestId(`receivable-matched-${PARTNER_A.counterpartyId}`)).toHaveTextContent("900.00");
    expect(screen.getByTestId(`receivable-disputed-${PARTNER_A.counterpartyId}`)).toHaveTextContent("50.00");
    expect(screen.getByTestId(`net-margin-${PARTNER_A.counterpartyId}`)).toHaveTextContent("300.00");
  });

  it("DD15 — the disclosure is on screen and nothing renders a patient's name", async () => {
    mockRoutes({ [PNL]: { status: 200, body: [PARTNER_A] } });
    renderWithProviders(<PartnerPnl />);
    await screen.findByTestId(`partner-${PARTNER_A.counterpartyId}`);
    expect(screen.getByTestId("no-identity")).toBeInTheDocument();
  });

  it("acceptance — an empty read model (both lanes off, no cards yet) renders cleanly, not an error", async () => {
    mockRoutes({ [PNL]: { status: 200, body: [] } });
    renderWithProviders(<PartnerPnl />);

    expect(await screen.findByTestId("empty")).toBeInTheDocument();
    expect(screen.queryByTestId("pnl-table")).toBeNull();
  });
});
