import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresGate } from "../stores-gate";
import type { WireGatePass } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1119, spec docs/specs/1119-stores-gate-passes.md (owner APPROVED 2026-11-18): the web half,
 * D6. The guard's Gate screen at 390 px: it opens on the scanner, the typed last four digits find the pass, "Let
 * out" (or "Let in") is reachable in at most two taps with no horizontal scroll, and every status shows a word.
 * The server half: apps/core/src/modules/stores/acceptance/stores-s2c-1119.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const PASS: WireGatePass = {
  id: "gp1", passNo: "MGP2611100007", kind: "returnable", purpose: "repair", party: "Sharma Electricals with a long name that must not wrap",
  dueBack: "2026-11-12", status: "raised", store: { id: "g1", code: "GEN-MAIN", name: "Central store" }, ref: null, note: null,
  lines: [{ itemId: "i1", itemCode: "EL-DRL-0001", itemName: "Electric drill", baseUom: "piece", qty: 2, out: 0, back: 0 }],
  raisedBy: { id: "u9", name: "Keeper" }, raisedAt: "2026-11-10T06:30:00.000Z", scans: [],
};

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path, query] = raw.replace(/^.*\/api/, "").split("?") as [string, string | undefined];
    const method = init?.method ?? "GET";
    calls.push({ method, path: query === undefined ? path : `${path}?${query}`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["stores.gatepass.scan"], scoped: { department: {}, floor: {} } } });
    if (path === "/stores/gate-passes/lookup" && method === "GET") return json({ pass: PASS, act: "exit" });
    if (path === "/stores/gate-passes/scan" && method === "POST") return json({ pass: { ...PASS, status: "out" }, duplicate: false, flag: null });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => {
  setToken("t");
  window.innerWidth = 390;
  // A camera that opens and never reads: the screen must still offer the typed fallback beside it.
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, {
    mediaDevices: { getUserMedia: vi.fn(() => new Promise<MediaStream>(() => undefined)) },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Gate screen at 390 px (spec #1119)", () => {
  it("spec #1119 D6: opens on the scanner; the typed last four digits find the pass; Let out in at most two taps with no horizontal scroll; every status shows a word", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresGate />);

    // Opens on the camera, with no tap.
    expect(await screen.findByTestId("qr-scan")).toBeInTheDocument();
    const root = screen.getByTestId("stores-gate");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");

    // The typed fallback: four digits, no id typing, no tap to search.
    await user.type(screen.getByLabelText("Type last 4"), "0007");
    const card = await screen.findByTestId("gate-pass");
    expect(calls.some((c) => c.method === "GET" && c.path === "/stores/gate-passes/lookup?code=0007")).toBe(true);
    expect(within(card).getByText("MGP2611100007")).toBeInTheDocument();
    expect(within(card).getByText("Returnable")).toBeInTheDocument();
    expect(within(card).getByText("Not out yet")).toBeInTheDocument();
    const line = within(card).getByTestId("gate-line-i1");
    expect(line.style.whiteSpace).toBe("nowrap");
    expect(line.style.overflow).toBe("hidden");
    expect(line.textContent).toContain("2");

    let taps = 0;
    await user.click(within(card).getByRole("button", { name: "Let out" })); taps += 1;
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Recorded"));
    expect(taps).toBeLessThanOrEqual(2);
    const post = calls.find((c) => c.method === "POST" && c.path === "/stores/gate-passes/scan")!;
    expect(post.body).toMatchObject({ code: "MGP2611100007", act: "exit" });
    expect((post.body as { clientKey: string }).clientKey).toEqual(expect.any(String));
  });
});
