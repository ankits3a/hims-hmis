import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { OFFICE_PAGES } from "./pages";
import { TeleBills } from "./tele-bills";

/**
 * #647 — a tele-call's bill that failed at "Spoke to patient" was written as an event and shown
 * nowhere. The billing office lists every such visit still waiting, and retries the bill.
 */
const ROW = {
  encounterId: "enc-1", visitNo: "V2608170001", appointmentId: "ap-1",
  patient: { uhid: "HMS0000001234", name: "Asha Devi", alias: null, restricted: false },
  doctorName: "Dr Meera Rao", slotStart: "2026-08-17T04:00:00.000Z", quotePaise: 50000,
  firstFailedAt: "2026-08-17T04:10:00.000Z", lastFailedAt: "2026-08-17T04:15:00.000Z", lastCode: "receipt_patient_mismatch", attempts: 2,
  state: "open",
};

function mock(opts: { retry: "ok" | "refused"; rows?: unknown[] }): { posts: string[] } {
  let rows = opts.rows ?? [ROW];
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-1" }, permissions: { hospital: ["billing.invoice.issue"], scoped: { department: {}, floor: {} } } });
    if (path === "/opd/tele/bill-failures") return json({ items: rows });
    if (path === "/opd/tele/bill-failures/enc-1/retry" && init?.method === "POST") {
      posts.push(path);
      if (opts.retry === "refused") return json({ statusCode: 409, message: "the receipt belongs to another patient", code: "tele_bill_retry_failed", detail: { code: "receipt_patient_mismatch" } }, 409);
      rows = [{ ...ROW, state: "billed" }];
      return json({ encounterId: "enc-1", state: "billed" }, 201);
    }
    return new Response("{}", { status: 404 });
  }));
  return { posts };
}

describe("#647 — failed tele-call bills in the billing office", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("is a page of the office's Unbilled side", () => {
    expect(OFFICE_PAGES).toContainEqual({ side: "unbilled", key: "tele" });
  });

  it("lists who, which visit, which doctor, the slot, the paid amount, how often and why", async () => {
    mock({ retry: "ok" });
    renderWithProviders(<TeleBills />);
    const row = await screen.findByTestId("tele-bill-enc-1");
    expect(row).toHaveTextContent("Asha Devi");
    expect(row).toHaveTextContent("HMS0000001234");
    expect(row).toHaveTextContent("V2608170001");
    expect(row).toHaveTextContent("Dr Meera Rao");
    expect(row).toHaveTextContent("09:30");
    expect(row).toHaveTextContent("₹500");
    expect(row).toHaveTextContent("2 tries");
    expect(row).toHaveTextContent("receipt_patient_mismatch");
    expect(within(row).getByRole("button", { name: "Retry bill" })).toBeEnabled();
  });

  it("Retry posts once; a refusal stays on the row, in the server's words", async () => {
    const { posts } = mock({ retry: "refused" });
    renderWithProviders(<TeleBills />);
    const row = await screen.findByTestId("tele-bill-enc-1");
    await userEvent.click(within(row).getByRole("button", { name: "Retry bill" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(await within(row).findByRole("alert")).toHaveTextContent("the receipt belongs to another patient");
  });

  it("a retried bill waits for the doctor: the row says so and offers no second retry", async () => {
    const { posts } = mock({ retry: "ok" });
    renderWithProviders(<TeleBills />);
    const row = await screen.findByTestId("tele-bill-enc-1");
    await userEvent.click(within(row).getByRole("button", { name: "Retry bill" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("tele-bill-enc-1")).toHaveTextContent("Bill raised — waiting for the doctor"));
    expect(within(screen.getByTestId("tele-bill-enc-1")).queryByRole("button", { name: "Retry bill" })).toBeNull();
  });

  it("none waiting: says so in a line", async () => {
    mock({ retry: "ok", rows: [] });
    renderWithProviders(<TeleBills />);
    expect(await screen.findByTestId("tele-bills-none")).toHaveTextContent("No failed tele-call bills.");
  });
});
