import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { sayParams } from "../../lib/use-copilot";
import { renderWithProviders } from "../../test-utils";
import { StoresCopilot } from "./stores-copilot";

/**
 * #1113 — the Stores concierge: a lane, a clock and the next step are said in the tower's words, an empty holder is
 * "nobody", and the reorder is a tap on the shelf and a tap on Send — only the second reaches /copilot/confirm.
 */
const calls: { key: string; body: unknown }[] = [];
function mockRoutes(handlers: Record<string, unknown>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push({ key, body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)) });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = handlers[key];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("says a lane, a clock and the next step in the tower's words, and an empty holder as nobody", () => {
  const t = (k: string): string => `T(${k})`;
  expect(sayParams("copilot.answer.storesTicketWhere", { ticket: "MIN2611190007", lane: "in_transit", holder: "", minutes: 12, next: "receive" }, t, "en"))
    .toEqual({ ticket: "MIN2611190007", lane: "T(stores.tower.lane.in_transit)", holder: "T(stores.tower.nobody)", minutes: 12, next: "T(stores.tower.next.receive)" });
  expect(sayParams("copilot.answer.storesTicketStuck", { ticket: "MIN1", clock: "approval", minutes: 61, holder: "Ramesh" }, t, "en").clock).toBe("T(stores.tower.clock.approval)");
});

it("a reorder is a tap on the shelf and a tap on Send, and only Send reaches /copilot/confirm", async () => {
  const proposal = { id: "P1", v: 1, tool: "stores.reorder" };
  mockRoutes({
    "GET /api/copilot/notice": { seen: true },
    "POST /api/copilot/ask": {
      answer: {
        key: "copilot.answer.storesReorderPick", params: { count: 1 },
        payload: { kind: "storesReorderPick", options: [{ proposal: 0, shelfId: "s1", shelf: "Housekeeping F1", lines: [{ itemId: "i1", name: "Wet mop refill", qty: 40 }] }] },
      },
      proposals: [proposal], source: "phrasebook", intent: "stores.reorder", askId: "A1",
    },
    "POST /api/copilot/confirm": { outcome: "done", answer: { key: "copilot.answer.storesReorderSent", params: { ticket: "MIN2611190009" } } },
  });
  const user = userEvent.setup();
  renderWithProviders(<StoresCopilot />);
  await user.type(screen.getByTestId("agent-ask"), "reorder my shelf{Enter}");
  await user.click(await screen.findByTestId("stores-copilot-option-0"));
  expect(calls.some((c) => c.key === "POST /api/copilot/confirm")).toBe(false);
  const send = screen.getByTestId("stores-copilot-send");
  expect(send).toHaveTextContent("Send");
  await user.click(send);
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/copilot/confirm")?.body).toEqual({ proposal }));
  expect(await screen.findByText("Sent: MIN2611190009.")).toBeInTheDocument();
});
