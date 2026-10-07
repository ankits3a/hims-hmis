import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { PrintComputers } from "./admin-print-computers";

/**
 * Decision 0047 — the administrator's panel for the counters' print computers. The server decides
 * which computers exist and whether one is running; this pins what the SCREEN decides.
 */
type Reply = { status: number; body: unknown };
function routes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    const r = typeof h === "function" ? h() : h;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }));
}
function calls(method: string, path: string): { body: unknown }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === path)
    .map(([, init]) => ({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }));
}
const PC1 = { id: "PC1", name: "Front desk 1", printer: "HP LaserJet M1005", printers: ["HP LaserJet M1005"], platform: "win32", appVersion: "1.0.0", lastSeenAt: "2026-10-07T05:10:00.000Z", alive: true, revoked: false, createdAt: "2026-10-07T04:00:00.000Z" };
const PC2 = { ...PC1, id: "PC2", name: "Front desk 2", printer: null, alive: false, lastSeenAt: null, appVersion: null };
const GONE = { ...PC1, id: "PC3", name: "Old desk", revoked: true, alive: false };

describe("decision 0047 — Print computers (admin)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists each computer with its state as a word, its printer, and never a removed one", async () => {
    routes({ "GET /api/print/computers": { status: 200, body: { aliveSeconds: 90, computers: [PC1, PC2, GONE] } } });
    renderWithProviders(<PrintComputers open onClose={() => undefined} />);
    expect(await screen.findByTestId("print-computer-state-PC1")).toHaveTextContent("Connected");
    expect(screen.getByTestId("print-computer-PC1")).toHaveTextContent("Printer: HP LaserJet M1005");
    expect(screen.getByTestId("print-computer-PC1")).toHaveTextContent("version 1.0.0");
    expect(screen.getByTestId("print-computer-state-PC2")).toHaveTextContent("Not running");
    expect(screen.getByTestId("print-computer-PC2")).toHaveTextContent("No printer chosen on that computer yet");
    expect(screen.getByTestId("print-computer-PC2")).toHaveTextContent("has not asked for work yet");
    expect(screen.queryByTestId("print-computer-PC3")).not.toBeInTheDocument();
    // A test page cannot reach a computer that is not running: the button is there and disabled.
    expect(screen.getByTestId("print-computer-test-PC2")).toBeDisabled();
    expect(screen.getByTestId("print-computer-test-PC1")).toBeEnabled();
    expect(screen.getByTestId("print-computer-download")).toHaveAttribute("href", "/app/hmis-print-latest-win-x64.zip");
  });

  it("an empty hospital says so, and adding a computer shows the code once with what to do with it", async () => {
    routes({
      "GET /api/print/computers": { status: 200, body: { aliveSeconds: 90, computers: [] } },
      "POST /api/print/computers/codes": { status: 201, body: { code: "ABCD-EFGH", expiresAt: "2026-10-07T05:25:00.000Z" } },
    });
    renderWithProviders(<PrintComputers open onClose={() => undefined} />);
    expect(await screen.findByTestId("print-computers-none")).toBeInTheDocument();
    expect(screen.getByTestId("print-computer-make-code")).toBeDisabled();
    await userEvent.type(screen.getByTestId("print-computer-name"), "  Front desk 1 ");
    await userEvent.click(screen.getByTestId("print-computer-make-code"));
    expect(await screen.findByTestId("print-computer-code-value")).toHaveTextContent("ABCD-EFGH");
    expect(calls("POST", "/api/print/computers/codes")).toEqual([{ body: { name: "Front desk 1" } }]);
    const shown = screen.getByTestId("print-computer-code");
    expect(shown).toHaveTextContent("Code for Front desk 1");
    expect(shown).toHaveTextContent("Good for 15 minutes, for one computer.");
    expect(shown).toHaveTextContent("Double-click install.cmd");
    expect(shown).toHaveTextContent("Menu → Printing");
  });

  it("Remove takes two taps, then says the key no longer works", async () => {
    let list = [PC1];
    routes({
      "GET /api/print/computers": () => ({ status: 200, body: { aliveSeconds: 90, computers: list } }),
      "POST /api/print/computers/PC1/revoke": () => { list = []; return { status: 201, body: { revoked: true } }; },
    });
    renderWithProviders(<PrintComputers open onClose={() => undefined} />);
    const remove = await screen.findByTestId("print-computer-remove-PC1");
    await userEvent.click(remove);
    expect(calls("POST", "/api/print/computers/PC1/revoke")).toHaveLength(0);
    expect(remove).toHaveTextContent("tap again to confirm");
    await userEvent.click(remove);
    await waitFor(() => { expect(calls("POST", "/api/print/computers/PC1/revoke")).toHaveLength(1); });
    expect(await screen.findByTestId("print-computers-notice")).toHaveTextContent("Front desk 1 was removed. Its key no longer works.");
    await waitFor(() => { expect(screen.queryByTestId("print-computer-PC1")).not.toBeInTheDocument(); });
  });

  it("a test page: sent is good news; a computer that went off in the meantime is a sentence, not a code", async () => {
    let reply: Reply = { status: 201, body: { jobId: "J1" } };
    routes({
      "GET /api/print/computers": { status: 200, body: { aliveSeconds: 90, computers: [PC1] } },
      "POST /api/print/computers/PC1/test": () => reply,
    });
    renderWithProviders(<PrintComputers open onClose={() => undefined} />);
    await userEvent.click(await screen.findByTestId("print-computer-test-PC1"));
    expect(await screen.findByTestId("print-computers-notice")).toHaveTextContent("A test page was sent to Front desk 1.");
    reply = { status: 409, body: { code: "print_computer_offline", message: "x" } };
    await userEvent.click(screen.getByTestId("print-computer-test-PC1"));
    expect(await screen.findByTestId("print-computers-refusal")).toHaveTextContent("Front desk 1 is not running, so nothing was sent.");
  });
});
