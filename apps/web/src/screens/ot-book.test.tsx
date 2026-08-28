import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { OtBook } from "./ot-book";

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

function bodyOf(path: string): Record<string, unknown> {
  const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith(path));
  return JSON.parse(typeof call?.[1]?.body === "string" ? call[1].body : "{}") as Record<string, unknown>;
}

async function fillBooking(): Promise<void> {
  await userEvent.type(screen.getByLabelText(/^Patient$/i), "p-1");
  await userEvent.type(screen.getByLabelText(/Procedure class/i), "gynae_dnc");
  await userEvent.type(screen.getByLabelText(/Procedure code/i), "DNC");
  await userEvent.type(screen.getByLabelText(/^Surgeon$/i), "u-surgeon");
  await userEvent.type(screen.getByLabelText(/List date/i), "2026-09-02");
  await userEvent.type(screen.getByLabelText(/^Theatre$/i), "res-ot-1");
}

describe("OtBook", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("books a case and only then offers the deposit, which is held in integer paise", async () => {
    mockRoutes({
      "POST /api/ot/cases": {
        status: 201, body: { caseId: "c-1", encounterId: "e-1", encounterNo: "D2609020001" },
      },
      "POST /api/ot/encounters/e-1/deposit-hold": { status: 201, body: { id: "h-1" } },
    });
    renderWithProviders(<OtBook />);

    // Nothing to hold a deposit against before the encounter exists.
    expect(screen.queryByRole("button", { name: /Hold the deposit/i })).not.toBeInTheDocument();

    await fillBooking();
    await userEvent.click(screen.getByRole("button", { name: /Book the case/i }));
    expect(await screen.findByText(/D2609020001/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^Receipt$/i), "r-1");
    await userEvent.type(screen.getByLabelText(/Amount/i), "60000");
    await userEvent.click(screen.getByRole("button", { name: /Hold the deposit/i }));

    await screen.findByText(/60000\.00/);
    // ₹60,000 typed as rupees crosses the wire as 6,000,000 paise — the one conversion, at the edge.
    expect(bodyOf("/deposit-hold")).toEqual({ receiptId: "r-1", amountPaise: 6_000_000 });
  });

  it("renders the server's privilege refusal as a sentence, not a code", async () => {
    mockRoutes({
      "POST /api/ot/cases": {
        status: 403,
        body: { statusCode: 403, message: "not privileged", code: "privilege_refused" },
      },
    });
    renderWithProviders(<OtBook />);
    await fillBooking();
    await userEvent.click(screen.getByRole("button", { name: /Book the case/i }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("This surgeon is not privileged for this procedure class.");
  });
});
