import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenHandle } from "./linen-handle";
import type { LinenHandlerView } from "@hmis/contracts";

/**
 * E2.4 LINEN (issue #728) — the handler's phone: pick a ward, pick the job, big − / + steppers, Save. Top up starts at
 * the ward's shortfall and never goes above it; Save posts only the items with a count, with a per-tap key.
 */
const view: LinenHandlerView = {
  serverNow: new Date().toISOString(),
  wards: [{
    wardId: "g", wardName: "General ward", floorName: "Floor 3", beds: 10, bedsByClass: { general: 10 }, belowPar: true, shortPieces: 5, lastCountAt: null,
    items: [
      { itemCode: "bedsheet", par: 30, parSource: "computed", onHand: 27, short: 3 },
      { itemCode: "towel", par: 30, parSource: "computed", onHand: 28, short: 2 },
      { itemCode: "ot_gown", par: 0, parSource: "computed", onHand: 0, short: 0 },
    ],
  }],
  items: [{ code: "bedsheet", name: "Bedsheet", unitsPerSet: 1 }, { code: "towel", name: "Towel", unitsPerSet: 1 }, { code: "ot_gown", name: "OT gown", unitsPerSet: 0 }],
  soiled: { general: {}, infected: { bedsheet: 2 } },
  inTransit: [],
};

describe("LinenHandle (E2.4)", () => {
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    try { localStorage.removeItem("hmis.linen.ward"); } catch { /* none */ }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/handler") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.handle"], scoped: { department: {}, floor: {} } } }
          : { movements: 2 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("Hindi first on every job button", async () => {
    renderWithProviders(<LinenHandle />);
    const b = await screen.findByTestId("linen-mode-topUp");
    expect(b.querySelector(".hi")).toHaveTextContent("भरें");
    expect(b.querySelector(".en")).toHaveTextContent("Top up");
    expect(screen.getByTestId("linen-mode-infected").querySelector(".hi")).toHaveTextContent("संक्रमित");
  });

  it("top up starts at the shortfall, + stops at par, Save posts the counts with a key", async () => {
    renderWithProviders(<LinenHandle />);
    await waitFor(() => expect(screen.getByTestId("linen-ward").querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("linen-ward"), { target: { value: "g" } });
    fireEvent.click(screen.getByTestId("linen-mode-topUp"));
    expect(screen.getByTestId("qty-bedsheet")).toHaveValue("3");
    expect(screen.queryByTestId("step-ot_gown")).toBeNull(); // theatre linen is not in a ward bed's set
    fireEvent.click(screen.getByTestId("plus-bedsheet"));
    expect(screen.getByTestId("qty-bedsheet")).toHaveValue("3");
    fireEvent.click(screen.getByTestId("minus-towel"));
    fireEvent.click(screen.getByTestId("minus-towel"));
    fireEvent.click(screen.getByTestId("linen-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/wards\/g\/top-up$/);
    expect(posts[0]!.body).toMatchObject({ lines: [{ itemCode: "bedsheet", qty: 3 }] });
    expect(typeof (posts[0]!.body as { idempotencyKey?: unknown }).idempotencyKey).toBe("string");
    expect(await screen.findByTestId("linen-notice")).toHaveTextContent("Topped up");
  });

  it("an infected laundry batch offers only what waits in the infected pool", async () => {
    renderWithProviders(<LinenHandle />);
    fireEvent.click(await screen.findByTestId("linen-mode-laundryOut"));
    expect(screen.queryByTestId("step-bedsheet")).toBeNull();
    fireEvent.click(screen.getByTestId("linen-infected-batch"));
    expect(screen.getByTestId("qty-bedsheet")).toHaveValue("2");
    fireEvent.click(screen.getByTestId("linen-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ infected: true, lines: [{ itemCode: "bedsheet", qty: 2 }] });
  });
});
