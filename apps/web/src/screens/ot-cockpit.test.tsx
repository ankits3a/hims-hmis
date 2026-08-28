import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";

// A component test mounts no <RouterProvider>, so `useParams` is stubbed to the case this screen
// is being tested against — the patient-detail.test.tsx precedent.
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ caseId: "c-1" }) }));

const { OtCockpit } = await import("./ot-cockpit");

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const BASE = {
  "GET /api/ot/cases/c-1/gates": { status: 200, body: [{ id: "g-1", caseId: "c-1", kind: "consent", state: "satisfied", satisfiedBy: null, satisfiedAt: null, evidence: null, waivedReason: null }] },
  "GET /api/ot/cockpit/c-1/implants": { status: 200, body: [{ id: "i-1", serial: "SN-1", state: "deploying", serviceCode: "IMPL" }] },
};

describe("OtCockpit", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * The clock buttons send NO time. DD8's five timestamps are the server's, written once and never
   * rewritable — a browser clock must not become the legal record of an incision. This asserts the
   * body is empty rather than merely that the request was made, because "we sent a time and the
   * server ignored it" and "we sent no time" look identical from the outside until they don't.
   */
  it("posts a bare intent for a clock step — never a timestamp", async () => {
    mockRoutes({ ...BASE, "POST /api/ot/cockpit/c-1/incision": { status: 201, body: {} } });
    renderWithProviders(<OtCockpit />);

    await userEvent.click(screen.getByRole("button", { name: /^Incision$/i }));
    await screen.findByText(/Recorded/i);

    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith("/incision"));
    expect(JSON.parse(typeof call?.[1]?.body === "string" ? call[1].body : "null")).toEqual({});
  });

  it("shows a scanned implant as waiting for the store's ledger, not as an error", async () => {
    mockRoutes(BASE);
    renderWithProviders(<OtCockpit />);
    expect(await screen.findByText(/awaiting the store's ledger/i)).toBeInTheDocument();
  });

  it("renders a refused sign-out as the sentence that explains the wait", async () => {
    mockRoutes({
      ...BASE,
      "POST /api/ot/cockpit/c-1/sign-out": {
        status: 422,
        body: { statusCode: 422, message: "implant deploying", code: "implant_deploying" },
      },
    });
    renderWithProviders(<OtCockpit />);
    await userEvent.click(screen.getByRole("button", { name: /^Sign out$/i }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("An implant is still awaiting its ledger entry from the store.");
  });
});
