import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabDesk } from "./lab-desk";

/**
 * PLAN 17b T8 — the lab desk.
 *
 * **The refusal path asserted here is `consent_required`** (DD14 / 02 E1): an HIV test keyed
 * without the counter having taken written consent is not a data problem to fix later, because the
 * tube gets drawn. The screen refuses to send it at all, and the server refuses it again — two
 * independent enforcements of one rule, and this file asserts the first.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const handler = handlers[key];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const CATALOGUE = [
  { serviceId: "svc-tsh", code: "TSH", nameEn: "Thyroid stimulating hormone", nameHi: null,
    discipline: "biochemistry", specimenType: "serum", container: "sst",
    consentRequired: false, sensitive: false, active: true },
  { serviceId: "svc-hiv", code: "HIV", nameEn: "HIV 1 & 2 antibody", nameHi: null,
    discipline: "serology", specimenType: "serum", container: "sst",
    consentRequired: true, sensitive: true, active: true },
];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("DD14 — a consent-class test cannot be ordered until the consent NAMES somebody", async () => {
  mockRoutes({
    "GET /api/lab/catalogue/search": { status: 200, body: CATALOGUE },
    "POST /api/lab/desk/orders": { status: 201, body: {
      orderId: "o-1", orderNo: "L2608300001", orderGroupId: "g-1", itemIds: ["i-1"],
      invoice: { invoiceId: "inv-1", invoiceNo: "INV-1", netPayablePaise: 30000,
        receiptId: null, receiptNo: null, creditExtended: true },
      reflexConsent: false, duplicates: { acknowledged: [], warnings: [] },
    } },
  });
  renderWithProviders(<LabDesk />);

  await waitFor(() => expect(screen.getByText(/HIV 1 & 2 antibody/)).toBeInTheDocument());
  /** The catalogue MARKS it before anybody clicks — the counter sees what it is about to order. */
  expect(screen.getAllByText("[consent]").length).toBeGreaterThan(0);
  expect(screen.getAllByText("[in person]").length).toBeGreaterThan(0);

  const rows = screen.getAllByRole("button", { name: "Add" });
  await userEvent.click(rows[1]!);

  /** The place button is DISABLED and the screen names the tests that are blocking it. */
  expect(screen.getByRole("button", { name: "Place order" })).toBeDisabled();
  expect(screen.getByText(/Consent is required/)).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Consent taken by HIV"), "Nurse Priya");
  expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Place order" }));
  await waitFor(() => expect(screen.getByText(/L2608300001/)).toBeInTheDocument());
});

it("02 D11 — an unacknowledged duplicate blocks the order until the clerk ticks it deliberately", async () => {
  mockRoutes({
    "GET /api/lab/catalogue/search": { status: 200, body: CATALOGUE },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [
      { serviceId: "svc-tsh", duplicateOfItemId: "i-old", reason: "TSH was ordered 4 h ago (L2608290007)" },
    ] },
  });
  renderWithProviders(<LabDesk />);

  await waitFor(() => expect(screen.getByText(/Thyroid stimulating hormone/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Check" }));

  /** The clerk reads WHAT was ordered and WHEN — not a bare "duplicate" toast. */
  await waitFor(() => expect(screen.getByText(/ordered 4 h ago/)).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Place order" })).toBeDisabled();

  await userEvent.click(screen.getByRole("checkbox", { name: /ordered 4 h ago/ }));
  expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled();
});

it("shows the server's refusal verbatim rather than inventing a message", async () => {
  mockRoutes({
    "GET /api/lab/catalogue/search": { status: 200, body: CATALOGUE },
    "POST /api/lab/desk/orders": { status: 404, body: {
      statusCode: 404, code: "unknown_service",
      message: "no lab orderable for svc-x — the advised test is not in this hospital's catalogue",
    } },
  });
  renderWithProviders(<LabDesk />);
  await waitFor(() => expect(screen.getByText(/Thyroid/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Place order" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/not in this hospital's catalogue/));
});
