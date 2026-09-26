import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireMessagesOffice } from "../../lib/messages-api";

/**
 * PHARMACY P6 (patient messages) — the office's Messages side: the provider is shown as OFF ("console only
 * — not sending") until configured, the two messages' exact DLT text is there to register, the ids the
 * portals issue are recorded here, and the last thirty days are counted.
 */
type Call = { method: string; path: string; body: unknown };
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-incharge" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const OFFICE: WireMessagesOffice = {
  provider: { sms: false, whatsapp: false },
  contactPhone: null,
  templates: [
    { key: "pharmacy_bill_ready", purpose: "bill", dltTemplateId: null, whatsappTemplateName: null, variables: 4,
      text: { en: "{#var#} pharmacy: bill {#var#} for Rs {#var#} is paid ({#var#}). Keep this message; the counter gives a printed copy on request.", hi: "{#var#} फार्मेसी: बिल {#var#}" } },
    { key: "pharmacy_refill_due", purpose: "refill", dltTemplateId: null, whatsappTemplateName: null, variables: 3,
      text: { en: "{#var#}: your medicines from {#var#} may be running low. Please visit the hospital pharmacy or call {#var#}. To stop these reminders, tell the pharmacy.", hi: "{#var#}: …" } },
  ],
  counts: { sent: 0, loggedOnly: 12, queued: 1, failed: 0, suppressed: 2, expired: 0 },
  patients: { remindersOn: 3, stopped: 1 },
  needs: ["provider", "dlt_ids", "contact_phone"],
};
const INCHARGE = ["pharmacy.messages.manage", "pharmacy.reports.read"];

beforeEach(() => { setToken("t"); window.history.replaceState(null, "", "/pharmacy/office?view=messages"); });
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("the office's Messages side (P6 patient messages)", () => {
  it("says the provider is off — console only, not sending — and what stands between a message and a phone", async () => {
    mock({ "GET /pharmacy/office/messages": OFFICE }, INCHARGE);
    renderWithRouter(<PharmacyOffice />);
    const provider = await screen.findByTestId("messages-provider");
    expect(provider).toHaveAttribute("data-live", "no");
    expect(provider).toHaveTextContent("Console only — not sending");
    expect(screen.getByTestId("messages-need-provider")).toBeInTheDocument();
    expect(screen.getByTestId("messages-need-dlt_ids")).toBeInTheDocument();
    expect(screen.getByTestId("messages-need-contact_phone")).toBeInTheDocument();
    expect(screen.getByTestId("messages-count-loggedOnly")).toHaveTextContent("12");
    expect(screen.getByTestId("messages-reminders-on")).toHaveTextContent("3");
    expect(screen.getByTestId("messages-text-en-pharmacy_bill_ready")).toHaveTextContent("{#var#} pharmacy: bill {#var#} for Rs {#var#}");
  });

  it("records the DLT id the portal issued, and the pharmacy's phone", async () => {
    const calls = mock({
      "GET /pharmacy/office/messages": OFFICE,
      "POST /pharmacy/office/messages/templates": { ...OFFICE, needs: ["provider", "dlt_ids", "contact_phone"], templates: [{ ...OFFICE.templates[0]!, dltTemplateId: "1107161234567890123" }, OFFICE.templates[1]!] },
      "POST /pharmacy/office/messages/contact": { ...OFFICE, contactPhone: "0141-2345678", needs: ["provider", "dlt_ids"] },
    }, INCHARGE);
    renderWithRouter(<PharmacyOffice />);
    await userEvent.type(await screen.findByTestId("messages-dlt-pharmacy_bill_ready"), "1107161234567890123");
    await userEvent.click(screen.getByTestId("messages-save-pharmacy_bill_ready"));
    await userEvent.type(screen.getByTestId("messages-contact-phone"), "0141-2345678");
    await userEvent.click(screen.getByTestId("messages-contact-save"));
    await waitFor(() => expect(screen.queryByTestId("messages-need-contact_phone")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/pharmacy/office/messages/templates", { templateKey: "pharmacy_bill_ready", dltTemplateId: "1107161234567890123", whatsappTemplateName: null }],
      ["/pharmacy/office/messages/contact", { phone: "0141-2345678" }],
    ]);
  });

  it("is not a side for someone without the grant", async () => {
    const calls = mock({ "GET /pharmacy/office/messages": OFFICE }, ["pharmacy.reports.read"]);
    renderWithRouter(<PharmacyOffice />);
    await waitFor(() => expect(calls.some((c) => c.path === "/auth/me")).toBe(true));
    expect(screen.queryByTestId("office-view-messages")).toBeNull();
    expect(calls.some((c) => c.path === "/pharmacy/office/messages")).toBe(false);
  });
});
