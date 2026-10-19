import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CopilotSettings } from "./copilot-settings";

/**
 * #619 — decision 0006's two per-doctor toggles, as the doctor sees them: proactive (off = the copilot
 * speaks only when asked, F2) and drafting clinical prose (off = retrieve, check and structure only).
 * Both OFF by default; the doctor always confirms and submits — that part is not a setting.
 */
function mock(initial: { proactive: boolean; draftProse: boolean }): { puts: unknown[] } {
  let cur = { ...initial };
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0]!.replace(/^.*\/api/, "");
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/opd/consult/copilot-settings" && (init?.method ?? "GET") === "GET") return json(cur);
    if (path === "/opd/consult/copilot-settings" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Partial<typeof cur>;
      puts.push(body);
      cur = { ...cur, ...body };
      return json(cur);
    }
    return new Response("{}", { status: 404 });
  }));
  return { puts };
}

describe("#619 — the doctor's copilot settings", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("shows both toggles OFF with what off means, and the line that the doctor always submits", async () => {
    mock({ proactive: false, draftProse: false });
    renderWithProviders(<CopilotSettings />);
    const pro = await screen.findByRole("switch", { name: "Speak up without being asked" });
    const draft = screen.getByRole("switch", { name: "Draft clinical sentences" });
    expect(pro).toHaveAttribute("aria-checked", "false");
    expect(draft).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("copilot-setting-proactive")).toHaveTextContent("Off: the copilot answers only when you ask (F2).");
    expect(screen.getByTestId("copilot-setting-draftProse")).toHaveTextContent("Off: it finds, checks and arranges — it writes no clinical sentence.");
    expect(screen.getByTestId("copilot-settings")).toHaveTextContent("You always confirm and submit");
  });

  it("one tap saves one toggle on the server, and the switch shows what the server kept", async () => {
    const { puts } = mock({ proactive: false, draftProse: false });
    renderWithProviders(<CopilotSettings />);
    const draft = await screen.findByRole("switch", { name: "Draft clinical sentences" });
    await userEvent.click(draft);
    await waitFor(() => { expect(puts).toEqual([{ draftProse: true }]); });
    await waitFor(() => { expect(screen.getByRole("switch", { name: "Draft clinical sentences" })).toHaveAttribute("aria-checked", "true"); });
    expect(screen.getByTestId("copilot-setting-draftProse")).toHaveTextContent("On: it may draft a sentence for you to check; nothing is saved until you submit.");
    expect(screen.getByRole("switch", { name: "Speak up without being asked" })).toHaveAttribute("aria-checked", "false");
  });
});
