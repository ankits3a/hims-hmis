import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresAssetPassport, StoresAssets } from "../stores-assets";
import type { WireAssetPassportFull, WireAssetRegisterRow } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1114, spec docs/specs/1114-stores-asset-passport.md (owner APPROVED 2026-11-19, decision 0100):
 * the web half of S4a, D19 and D20. The passport on the phone (390 px) opened by a scan or the typed last four, and
 * `/stores/assets` at 16:9 (1366 × 768). The server half: apps/core/src/modules/stores/acceptance/stores-s4a-1114.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const PASSPORT: WireAssetPassportFull = {
  access: "full", tagReplaced: false,
  unit: { id: "u1", tagNo: "AST2611000001", last4: "0001", name: "Patient monitor with a long model name that must not wrap", itemId: "i1", serial: "SN-001", make: "Philips", model: "MX450", liveTags: ["AST2611000001"], origin: "grn" },
  status: "in_use", out: null, transfer: null,
  place: { id: "s1", code: "ICU-F1", name: "ICU shelf", kind: "shelf" },
  department: { id: "d1", name: "ICU" },
  putToUse: "2026-11-10",
  dues: { warranty: { date: "2027-11-09", word: "ok" }, amc: null, calibration: { date: "2026-11-20", word: "due_soon" } },
  next: { what: "calibration", date: "2026-11-20", word: "due_soon" },
  events: [{ kind: "placed", at: "2026-11-10T06:35:00.000Z", by: { id: "u2", name: "ICU in-charge" }, where: "ICU shelf", note: null }],
  device: null, replace: false,
  can: { reportFault: true, addDetails: false, transfer: true, foundHere: false, acceptTransfer: false },
};

const ROWS: WireAssetRegisterRow[] = [
  { unitId: "u1", tagNo: "AST2611000001", last4: "0001", name: "Patient monitor", category: "Medical equipment", status: "in_use", place: "ICU shelf", department: "ICU", next: { what: "calibration", date: "2026-11-20", word: "due_soon" } },
  { unitId: "u2", tagNo: "AST2611000002", last4: "0002", name: "Patient monitor", category: "Medical equipment", status: "in_store", place: "Central store (non-drug)", department: null, next: null },
];

function mock(permissions: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path, query] = raw.replace(/^.*\/api/, "").split("?") as [string, string | undefined];
    const method = init?.method ?? "GET";
    calls.push({ method, path: query === undefined ? path : `${path}?${query}`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u2" }, permissions: { hospital: permissions, scoped: { department: { d1: ["stores.shelf.read", "stores.shelf.work"] }, floor: {} } } });
    if (path === "/stores/assets/lookup" && method === "GET") return json(PASSPORT);
    if (path === "/stores/assets/u1/fault" && method === "POST") return json({ ...PASSPORT, events: [{ kind: "fault_reported", at: "2026-11-10T07:00:00.000Z", by: { id: "u2", name: "ICU in-charge" }, where: "ICU shelf", note: "screen flickers" }, ...PASSPORT.events] });
    if (path === "/stores/assets/mine") return json({ rows: [] });
    if (path === "/stores/assets/register") return json({ rows: ROWS });
    if (path === "/stores/assets/due") return json({ rows: [] });
    if (path === "/stores/assets/verification") return json({ rounds: [], departments: [] });
    if (path === "/stores/assets/grns") return json({ lines: [] });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("the asset passport and the assets desk (spec #1114)", () => {
  it("spec #1114 D19: a scan (the typed last four) opens the passport on one screen with the status word, place, holder and next due date, no horizontal scroll, and Report fault in at most two taps", async () => {
    setToken("t");
    window.innerWidth = 390;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => new Promise<MediaStream>(() => undefined)) } });
    const calls = mock([]);
    const user = userEvent.setup();
    renderWithRouter(<StoresAssetPassport />);

    expect(await screen.findByTestId("qr-scan")).toBeInTheDocument();
    const root = screen.getByTestId("stores-asset");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");
    await user.type(screen.getByLabelText("Type last 4"), "0001");
    const card = await screen.findByTestId("asset-passport");
    expect(calls.some((c) => c.method === "GET" && c.path === "/stores/assets/lookup?code=0001")).toBe(true);
    expect(within(card).getByText("0001")).toBeInTheDocument();
    expect(within(card).getByText("In use")).toBeInTheDocument();
    expect(within(card).getByText("ICU shelf")).toBeInTheDocument();
    expect(within(card).getByText("ICU")).toBeInTheDocument();
    expect(within(card).getByTestId("asset-next").textContent).toContain("20 Nov 2026");
    expect(within(card).getByTestId("asset-next").textContent).toContain("Due soon");
    const name = within(card).getByTestId("asset-name");
    expect(name.style.whiteSpace).toBe("nowrap");
    expect(name.style.overflow).toBe("hidden");

    let taps = 0;
    await user.click(within(card).getByRole("button", { name: "Report fault" })); taps += 1;
    await user.type(screen.getByLabelText("What is wrong"), "screen flickers");
    await user.click(screen.getByRole("button", { name: "Send" })); taps += 1;
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Fault reported"));
    expect(taps).toBeLessThanOrEqual(2);
    const post = calls.find((c) => c.method === "POST" && c.path === "/stores/assets/u1/fault")!;
    expect(post.body).toMatchObject({ text: "screen flickers" });
  });

  it("spec #1114 D20: /stores/assets shows the Register, Due, Verification, Condemnation and Exports tabs at 1366 × 768, and every status is a word", async () => {
    setToken("t");
    window.innerWidth = 1366;
    window.innerHeight = 768;
    mock(["stores.assets.read", "stores.assets.manage", "stores.assets.export", "stores.masters.manage"]);
    renderWithRouter(<StoresAssets />);
    const tabs = await screen.findByRole("tablist");
    for (const t of ["Register", "Due", "Verification", "Condemnation", "Exports"]) {
      expect(within(tabs).getByRole("tab", { name: t })).toBeInTheDocument();
    }
    const register = await screen.findByTestId("asset-register");
    expect(within(register).getByText("In use")).toBeInTheDocument();
    expect(within(register).getByText("In store")).toBeInTheDocument();
    expect(within(register).getByText("Due soon")).toBeInTheDocument();
    expect(screen.getByTestId("stores-assets").style.maxWidth).toBe("100%");
  });
});
