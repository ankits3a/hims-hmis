import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyPharmacists } from "./pharmacy-pharmacists";
import type { WirePharmacist } from "../lib/pharmacy-api";

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
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const REG = {
  id: "reg-1", userId: "u-mehta", council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-123456", validUntil: "2030-03-31",
  recordedBy: "u-in", recordedAt: "2026-08-17T04:00:00.000Z", endedAt: null, endedBy: null, endReason: null,
};
const PEOPLE: WirePharmacist[] = [
  { userId: "u-in", username: "ph.incharge", fullName: "Anita Rao", active: true, current: null, history: [] },
  { userId: "u-mehta", username: "ph.mehta", fullName: "Rohit Mehta", active: true, current: REG, history: [
    REG, { ...REG, id: "reg-0", registrationNo: "MSPC-000001", endedAt: "2026-08-17T04:00:00.000Z", endedBy: "u-in", endReason: "superseded by the renewal" },
  ] },
];

/**
 * PHARMACY P2 — the register of pharmacists: who may dispense, filed by someone else.
 */
describe("PharmacyPharmacists (P2)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows who is registered and who is not, files a registration, and shows the server's refusal", async () => {
    mockRoutes({
      "GET /api/pharmacy/pharmacists": { status: 200, body: { items: PEOPLE } },
      "POST /api/pharmacy/pharmacists/u-in/registrations": { status: 403, body: { statusCode: 403, code: "self_registration", message: "x" } },
    });
    renderWithProviders(<PharmacyPharmacists />);
    expect(await screen.findByTestId("pharmacist-status-u-in")).toHaveTextContent("No registration on file");
    expect(screen.getByTestId("pharmacist-status-u-mehta")).toHaveTextContent("Maharashtra State Pharmacy Council · MSPC-123456 · valid until 2030-03-31");
    expect(within(screen.getByTestId("pharmacist-u-mehta")).getByRole("list", { name: "Earlier registrations" })).toHaveTextContent("MSPC-000001");

    const card = screen.getByTestId("pharmacist-u-in");
    await userEvent.click(within(card).getByRole("button", { name: "File registration" }));
    const save = within(card).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(within(card).getByLabelText("State pharmacy council"), "Karnataka State Pharmacy Council");
    await userEvent.type(within(card).getByLabelText("Registration number"), "KSPC-42");
    await userEvent.click(save);
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/pharmacists/u-in/registrations")).toEqual([
      { council: "Karnataka State Pharmacy Council", registrationNo: "KSPC-42", validUntil: null },
    ]));
    expect(await screen.findByRole("alert")).toHaveTextContent("filed and ended by someone else, never by its holder");
  });

  it("ends a registration only with a reason", async () => {
    mockRoutes({
      "GET /api/pharmacy/pharmacists": { status: 200, body: { items: PEOPLE } },
      "POST /api/pharmacy/pharmacists/registrations/reg-1/end": { status: 201, body: { ok: true } },
    });
    renderWithProviders(<PharmacyPharmacists />);
    const card = await screen.findByTestId("pharmacist-u-mehta");
    await userEvent.click(within(card).getByRole("button", { name: "End registration" }));
    const confirm = within(card).getByRole("button", { name: "End it" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(card).getByLabelText("Reason"), "left the hospital");
    await userEvent.click(confirm);
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/pharmacists/registrations/reg-1/end")).toEqual([{ reason: "left the hospital" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Registration ended for Rohit Mehta.");
  });
});
