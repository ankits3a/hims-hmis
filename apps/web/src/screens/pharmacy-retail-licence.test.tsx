import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyRetailLicence } from "./pharmacy-retail-licence";

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const LICENCE = {
  id: "l1", form20No: "RLF20-1", form21No: "RLF21-1", validFrom: "2026-01-01", validTo: "2030-12-31",
  pharmacistInCharge: "A. Kulkarni", note: null, recordedBy: "u", recordedAt: "2026-09-17T05:00:00.000Z",
};

/**
 * PHARMACY P19 — the retail licence: what the counter's state is, and a new entry recorded.
 */
describe("PharmacyRetailLicence (P19)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the counter shut, records the licence as typed, and shows the server's refusal", async () => {
    let recorded = false;
    mockRoutes({
      "GET /api/pharmacy/retail/licences": () => ({
        status: 200,
        body: recorded
          ? { items: [LICENCE], state: { storeCode: "PHARM-RETAIL", storePresent: true, state: "current", licence: LICENCE, daysLeft: 1566 } }
          : { items: [], state: { storeCode: "PHARM-RETAIL", storePresent: true, state: "missing", licence: null, daysLeft: null } },
      }),
      "POST /api/pharmacy/retail/licences": () => {
        if (!recorded) { recorded = true; return { status: 201, body: LICENCE }; }
        return { status: 400, body: { statusCode: 400, code: "invalid_retail_licence", message: "x" } };
      },
    });
    renderWithProviders(<PharmacyRetailLicence />);
    expect(await screen.findByTestId("licence-state")).toHaveTextContent("Walk-in sales are closed: no retail drug licence");
    expect(screen.getByText("No licence recorded yet.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Record licence" });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Form 20 no." }), " RLF20-1 ");
    await userEvent.type(screen.getByRole("textbox", { name: "Form 21 no." }), "RLF21-1");
    await userEvent.type(screen.getByLabelText("Valid from"), "2026-01-01");
    await userEvent.type(screen.getByLabelText("Valid until"), "2030-12-31");
    await userEvent.type(screen.getByRole("textbox", { name: "Pharmacist in charge (as on the licence)" }), "A. Kulkarni");
    await userEvent.click(save);

    expect(await screen.findByText("Licence recorded.")).toBeInTheDocument();
    await waitFor(() => { expect(screen.getByTestId("licence-state")).toHaveTextContent("Current: Form 20 RLF20-1, Form 21 RLF21-1, valid until 2030-12-31."); });
    expect(screen.getByTestId("licence-l1")).toHaveTextContent("Latest · Form 20 RLF20-1 · Form 21 RLF21-1 · 2026-01-01 to 2030-12-31 · A. Kulkarni");
    const posted = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    expect(posted).toEqual([{ form20No: "RLF20-1", form21No: "RLF21-1", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni" }]);

    await userEvent.type(screen.getByRole("textbox", { name: "Form 20 no." }), "X");
    await userEvent.type(screen.getByRole("textbox", { name: "Form 21 no." }), "Y");
    await userEvent.type(screen.getByLabelText("Valid from"), "2031-01-01");
    await userEvent.type(screen.getByLabelText("Valid until"), "2030-01-01");
    await userEvent.type(screen.getByRole("textbox", { name: "Pharmacist in charge (as on the licence)" }), "B");
    await userEvent.click(screen.getByRole("button", { name: "Record licence" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("dates that run forwards");
  });
});
