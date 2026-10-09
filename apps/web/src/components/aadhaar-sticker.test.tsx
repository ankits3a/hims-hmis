import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { AadhaarSticker } from "./aadhaar-sticker";

/**
 * "ADD YOUR AADHAAR" (owner 2026-10-09) — the sticker is drawn ONLY while the server says
 * `needsAadhaar`, cannot be dismissed, and goes when the number is saved. The number typed appears in
 * no request but the one POST, and nowhere on the page after it.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const posts = (): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).includes("/me/identity"))
  .map(([, init]) => JSON.parse(String(init?.body)));
const ME = { status: 200, body: { actor: { type: "user", id: "u-1" } } };
const owes = { aadhaarConfigured: true, aadhaar: null, attendance: "not_linked", needsAadhaar: true };

describe("AadhaarSticker", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("draws nothing when the server says the person owes nothing", async () => {
    mockRoutes({ "GET /api/auth/me": ME, "GET /api/me/identity": { status: 200, body: { ...owes, aadhaar: "XXXX XXXX 0124", needsAadhaar: false } } });
    renderWithProviders(<AadhaarSticker />);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/me/identity"))).toBe(true));
    expect(screen.queryByTestId("aadhaar-sticker")).not.toBeInTheDocument();
  });

  it("draws nothing when signed out, and asks nothing", async () => {
    setToken(null);
    mockRoutes({ "GET /api/me/identity": { status: 200, body: owes } });
    renderWithProviders(<AadhaarSticker />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("aadhaar-sticker")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/me/identity"))).toBe(false);
  });

  it("shows while needsAadhaar; has no close; Save waits for twelve digits; after a LINKED save it is gone and says so", async () => {
    let saved = false;
    mockRoutes({
      "GET /api/auth/me": ME,
      "GET /api/me/identity": () => ({ status: 200, body: saved ? { ...owes, aadhaar: "XXXX XXXX 0124", attendance: "linked", needsAadhaar: false } : owes }),
      "POST /api/me/identity": () => { saved = true; return { status: 200, body: { ...owes, aadhaar: "XXXX XXXX 0124", attendance: "linked", needsAadhaar: false } }; },
    });
    renderWithProviders(<AadhaarSticker />);
    const sticker = await screen.findByTestId("aadhaar-sticker");
    expect(sticker).toHaveTextContent("Add your Aadhaar to see attendance");
    // Not dismissable: its only button opens the box.
    expect(within(sticker).getAllByRole("button").map((b) => b.textContent)).toEqual(["Add Aadhaar"]);

    await userEvent.click(within(sticker).getByRole("button", { name: "Add Aadhaar" }));
    const panel = screen.getByTestId("aadhaar-sticker-panel");
    const box = within(panel).getByTestId("aadhaar-self-input");
    expect(box).toHaveAttribute("inputmode", "numeric");
    expect(box).toHaveAttribute("autocomplete", "off");
    await userEvent.type(box, "2345 6789 012");
    expect(within(panel).getByTestId("aadhaar-self-save")).toBeDisabled();
    await userEvent.type(box, "4");
    await userEvent.click(within(panel).getByTestId("aadhaar-self-save"));

    await waitFor(() => expect(posts()).toEqual([{ aadhaar: "2345 6789 0124" }]));
    expect(await screen.findByTestId("aadhaar-saved")).toHaveTextContent("Attendance linked");
    expect(screen.queryByTestId("aadhaar-sticker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("aadhaar-sticker-panel")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/2345|6789/);
  });

  it("a number the machine does not hold yet: 'Saved · attendance team will match', and the sticker is gone", async () => {
    mockRoutes({
      "GET /api/auth/me": ME,
      "GET /api/me/identity": { status: 200, body: owes },
      "POST /api/me/identity": { status: 200, body: { ...owes, aadhaar: "XXXX XXXX 0124", needsAadhaar: false } },
    });
    renderWithProviders(<AadhaarSticker />);
    await userEvent.click(await screen.findByRole("button", { name: "Add Aadhaar" }));
    await userEvent.type(screen.getByTestId("aadhaar-self-input"), "234567890124");
    await userEvent.click(screen.getByTestId("aadhaar-self-save"));
    expect(await screen.findByTestId("aadhaar-saved")).toHaveTextContent("Saved · attendance team will match");
    expect(screen.queryByTestId("aadhaar-sticker")).not.toBeInTheDocument();
  });

  it("a refusal is a fixed line in the box, the sticker stays, and nothing the server said is echoed", async () => {
    mockRoutes({
      "GET /api/auth/me": ME,
      "GET /api/me/identity": { status: 200, body: owes },
      "POST /api/me/identity": { status: 400, body: { code: "aadhaar_invalid", problem: "bad_check_digit", message: "server words" } },
    });
    renderWithProviders(<AadhaarSticker />);
    await userEvent.click(await screen.findByRole("button", { name: "Add Aadhaar" }));
    await userEvent.type(screen.getByTestId("aadhaar-self-input"), "234567890125");
    await userEvent.click(screen.getByTestId("aadhaar-self-save"));
    expect(await screen.findByTestId("aadhaar-self-error")).toHaveTextContent("Not a valid Aadhaar");
    expect(document.body.textContent).not.toContain("server words");
    expect(screen.getByTestId("aadhaar-sticker")).toBeInTheDocument();
  });
});
