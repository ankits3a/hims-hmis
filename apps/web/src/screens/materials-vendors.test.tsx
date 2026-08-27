import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsVendors } from "./materials-vendors";

/**
 * PLAN 14 T9 — the vendor master screen.
 *
 * T9's acceptance: **one refusal path, asserted as the LOCALE STRING.** Here it is
 * `blacklist_active` — O-11's three-year clock, refused by the server when a reinstatement is
 * attempted early.
 *
 * The other property this file carries is A7's, at the last place it could leak: **what renders is
 * what the server sent, and the server sends `"••••9012"`.** There is no client-side masking helper
 * to get wrong, and the leg below asserts the full number is nowhere in the DOM.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status, headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** MASKED by the server (T4, A7). This is exactly the shape the wire carries. */
const BLACKLISTED = {
  id: "v-1", code: "ACME", legalName: "Acme Pharma Pvt Ltd", tradeName: null,
  gstin: null, pan: null, msmeClass: null, paymentTermsDays: null, classFlags: {},
  bank: { accountNo: "••••9012", ifsc: "HDFC0001234" },
  firstPaymentAllowedAt: null,
  status: "blacklisted" as const,
  blacklistUntil: "2029-08-27T06:00:00.000Z", blacklistReason: "quality_failure",
};

describe("MaterialsVendors", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists vendors with their status, and shows when a blacklist ends", async () => {
    mockRoutes({ "GET /api/materials/vendors": { status: 200, body: { vendors: [BLACKLISTED] } } });
    renderWithProviders(<MaterialsVendors />);
    expect(await screen.findByText("ACME")).toBeInTheDocument();
    expect(screen.getByText("Blacklisted")).toBeInTheDocument();
    // The question anybody asks about a blacklisted vendor is "when can we use them again".
    expect(screen.getByText("until 2029-08-27")).toBeInTheDocument();
  });

  /**
   * **THE REFUSAL PATH.** Reinstating before `blacklist_until` — A5's clock — comes back 409 with
   * `blacklist_active`, and the screen renders the SERVER'S SENTENCE.
   */
  it("renders the server's refusal when a blacklist is reinstated early — the sentence, not the code", async () => {
    mockRoutes({
      "GET /api/materials/vendors": { status: 200, body: { vendors: [BLACKLISTED] } },
      "POST /api/materials/vendors/v-1/reinstate": {
        status: 409,
        body: {
          statusCode: 409, code: "blacklist_active",
          message: "vendor ACME is blacklisted until 2029-08-27T06:00:00.000Z and may not be "
            + "reinstated before then (O-11: 3 years)",
        },
      },
    });
    renderWithProviders(<MaterialsVendors />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reinstate" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/may not be reinstated before then/);
    expect(alert).not.toHaveTextContent("blacklist_active");
  });

  /**
   * **A7 AT THE LAST HOP.** The masked value renders; the full account number is nowhere in the
   * document. There is no client-side unmasking path because there is no client-side masking path.
   */
  it("renders only the masked account number — the full one is nowhere in the DOM", async () => {
    mockRoutes({ "GET /api/materials/vendors": { status: 200, body: { vendors: [BLACKLISTED] } } });
    const { container } = renderWithProviders(<MaterialsVendors />);
    await screen.findByText("ACME");
    expect(screen.getByText("••••9012")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain("123456789012");
    expect(container.textContent ?? "").not.toContain("12345678");
  });

  /** O-11 — the reason is a CLOSED list, so the control is a select and not a text box. */
  it("offers exactly O-11's four blacklist reasons, as a select", async () => {
    mockRoutes({
      "GET /api/materials/vendors": {
        status: 200,
        body: { vendors: [{ ...BLACKLISTED, status: "active", blacklistUntil: null, blacklistReason: null }] },
      },
      "GET /api/materials/vendors/v-1": {
        status: 200,
        body: {
          vendor: { ...BLACKLISTED, status: "active", blacklistUntil: null, blacklistReason: null },
          documents: [],
        },
      },
    });
    renderWithProviders(<MaterialsVendors />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open" }));

    const select = await screen.findByLabelText("Reason");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Quality failure", "Regulatory breach", "Integrity breach", "Chronic non-supply",
    ]);
    // …and the action says what it commits the hospital to.
    expect(screen.getByRole("button", { name: "Blacklist for three years" })).toBeInTheDocument();
  });

  it("a new vendor is created as a draft, and the screen says so before it is used", async () => {
    mockRoutes({
      "GET /api/materials/vendors": { status: 200, body: { vendors: [] } },
      "POST /api/materials/vendors": { status: 201, body: { vendorId: "v-new" } },
    });
    renderWithProviders(<MaterialsVendors />);
    const user = userEvent.setup();
    expect(screen.getByText(/cannot be received from until its GST certificate and PAN/)).toBeInTheDocument();

    await user.type(await screen.findByLabelText(/^Code$/), "NEWCO");
    await user.type(screen.getByLabelText(/^Legal name$/), "New Company Pvt Ltd");
    await user.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("NEWCO registered");
    });
  });
});
