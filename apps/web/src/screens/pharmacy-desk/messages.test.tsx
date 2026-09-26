import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { BillMessageLine, MessagesChip } from "./messages";
import type { WirePatientMessages } from "../../lib/messages-api";

/**
 * PHARMACY P6 (patient messages) — the rail's consent chip: one tap after asking turns reminders on and
 * says who recorded it; "stop all messages" is as easy; a stopped patient cannot be tapped back into
 * reminders; nobody without `pharmacy.messages.consent` can tap at all. And the hand-over's quiet line.
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
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-ph" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    const status = (out as { statusCode?: number }).statusCode ?? 200;
    return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const BASE: WirePatientMessages = {
  hasPhone: true, phoneLast4: "3210", language: "hi", channel: null, refillReminders: false, remindersConsent: null, stopped: null,
  bill: { state: "not_yet", channel: null, at: null },
};
const PH = ["pharmacy.dispense.read", "pharmacy.messages.consent"];

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the consent chip (P6 patient messages)", () => {
  it("one tap after asking turns reminders on, and says who recorded the yes", async () => {
    const calls = mock({
      "GET /pharmacy/dispenses/d1/messages": BASE,
      "POST /pharmacy/dispenses/d1/messages": { ...BASE, refillReminders: true, remindersConsent: { at: "2026-09-26T05:00:00.000Z", byName: "Anita Verma", via: "pharmacy_desk" } },
    }, PH);
    renderWithProviders(<MessagesChip dispenseId="d1" />);
    const on = await screen.findByTestId("desk-reminders-turn-on");
    expect(on).toHaveTextContent("SMS reminders: off · turn on");
    await waitFor(() => expect(on).toBeEnabled());
    await userEvent.click(on);
    expect(await screen.findByTestId("desk-reminders-on")).toHaveTextContent("SMS reminders: on");
    expect(screen.getByTestId("desk-reminders-consent")).toHaveTextContent("recorded by Anita Verma");
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/pharmacy/dispenses/d1/messages", body: { change: "reminders_on" } }]);
  });

  it("stop is one tap too; a stopped patient shows who asked, and can only be turned back on — not into reminders", async () => {
    const stopped = { ...BASE, stopped: { at: "2026-09-26T05:00:00.000Z", byName: "Anita Verma", via: "pharmacy_desk" } };
    const calls = mock({ "GET /pharmacy/dispenses/d1/messages": BASE, "POST /pharmacy/dispenses/d1/messages": stopped }, PH);
    renderWithProviders(<MessagesChip dispenseId="d1" />);
    const stop = await screen.findByTestId("desk-messages-stop");
    await waitFor(() => expect(stop).toBeEnabled());
    await userEvent.click(stop);
    expect(await screen.findByTestId("desk-messages-stopped")).toHaveTextContent("Messages stopped");
    expect(screen.queryByTestId("desk-reminders-turn-on")).toBeNull();
    expect(screen.getByTestId("desk-messages-resume")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ change: "stop" }]);
  });

  it("the language is one tap, and the chip reads it back", async () => {
    const calls = mock({ "GET /pharmacy/dispenses/d1/messages": BASE, "POST /pharmacy/dispenses/d1/messages": { ...BASE, language: "en" } }, PH);
    renderWithProviders(<MessagesChip dispenseId="d1" />);
    const en = await screen.findByTestId("desk-messages-lang-en");
    expect(screen.getByTestId("desk-messages-lang-hi")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(en).toBeEnabled());
    await userEvent.click(en);
    await waitFor(() => expect(screen.getByTestId("desk-messages-lang-en")).toHaveAttribute("aria-pressed", "true"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ change: "language", language: "en" }]);
  });

  it("without the consent grant the chip is read-only: nothing to tap", async () => {
    const calls = mock({ "GET /pharmacy/dispenses/d1/messages": BASE }, ["pharmacy.dispense.read"]);
    renderWithProviders(<MessagesChip dispenseId="d1" />);
    const on = await screen.findByTestId("desk-reminders-turn-on");
    expect(on).toBeDisabled();
    expect(screen.queryByTestId("desk-messages-stop")).toBeNull();
    await userEvent.click(on);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a patient with no phone gets no chip to tap", async () => {
    mock({ "GET /pharmacy/dispenses/d1/messages": { ...BASE, hasPhone: false, phoneLast4: null } }, PH);
    renderWithProviders(<MessagesChip dispenseId="d1" />);
    expect(await screen.findByTestId("desk-messages-nophone")).toHaveTextContent("No phone on record");
    expect(screen.queryByTestId("desk-reminders-turn-on")).toBeNull();
  });
});

describe("the hand-over's bill line", () => {
  it.each([
    ["logged_only", "sms", "Bill message recorded, not sent — no SMS provider yet."],
    ["sent", "sms", "Bill sent by SMS."],
    ["stopped", null, "No bill message: the patient asked for no messages."],
    ["no_phone", null, "No bill message: no phone on record."],
  ] as const)("says %s quietly", async (state, channel, text) => {
    mock({ "GET /pharmacy/dispenses/d1/messages": { ...BASE, bill: { state, channel, at: null } } }, PH);
    renderWithProviders(<BillMessageLine dispenseId="d1" />);
    expect(await screen.findByTestId("desk-bill-message")).toHaveTextContent(text);
  });

  it("says nothing before the hand-over", async () => {
    const calls = mock({ "GET /pharmacy/dispenses/d1/messages": BASE }, PH);
    renderWithProviders(<BillMessageLine dispenseId="d1" />);
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/dispenses/d1/messages")).toBe(true));
    expect(screen.queryByTestId("desk-bill-message")).toBeNull();
  });
});
