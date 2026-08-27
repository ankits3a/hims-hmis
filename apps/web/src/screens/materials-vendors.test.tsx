import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { switchLanguage } from "../lib/i18n";
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
   * ═══ THE REFUSAL PATH — **CLOSE REVIEW m6 CHANGED WHAT THIS ASSERTS, AND THE CHANGE IS THE
   *     FINDING** ═══
   *
   * Reinstating before `blacklist_until` (A5's clock) comes back 409 with `blacklist_active`.
   *
   * This leg used to assert the screen rendered **the server's own English sentence**, and it
   * passed — which is exactly why nobody noticed that T9's acceptance asked for the LOCALE STRING.
   * The server's `message` is written in English by `apps/core`; there is no mechanism by which it
   * could ever be anything else. So a Hindi storekeeper got a Hindi form, Hindi buttons, Hindi QC
   * verdicts — and an English sentence at the one moment the screen had something urgent to say.
   *
   * The screen now renders `materialsErrors.<code>`, and the assertion is inverted to match: the
   * locale string is present and **the server's sentence is ABSENT**. The Hindi leg below is the
   * one that could not have passed before, in either direction.
   */
  it("renders the LOCALE string for a refusal — not the server's English sentence, and not the code", async () => {
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
    expect(alert).toHaveTextContent("The blacklist period has not ended yet");
    // NOT the bare code — what a screen with no catalogue at all would have shown…
    expect(alert).not.toHaveTextContent("blacklist_active");
    // …and NOT the server's English sentence, which is what shipped (m6).
    expect(alert).not.toHaveTextContent(/may not be reinstated before then/);
  });

  /**
   * **m6, the leg that actually proves it.** Same refusal, same server response — a Hindi user.
   * Before the fix this rendered the identical English sentence as the leg above, because the
   * screen was showing `body.message` and `body.message` has exactly one language.
   */
  it("m6: a Hindi user gets the refusal in Hindi — the server's `message` never reaches the screen", async () => {
    switchLanguage("hi");
    try {
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
      // BY ITS HINDI LABEL — `/.+/ ` matched the first button on the screen and hit an unstubbed
      // route, which is its own small lesson about loose role queries.
      await user.click(await screen.findByRole("button", { name: "पुनर्बहाल करें" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("प्रतिबंध की अवधि अभी समाप्त नहीं हुई है");
      expect(alert).not.toHaveTextContent(/reinstated before then/);
    } finally {
      switchLanguage("en");
    }
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
