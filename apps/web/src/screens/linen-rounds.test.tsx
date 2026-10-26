import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenRounds } from "./linen-rounds";
import type { LinenFloorView, LinenHandlerView } from "@hmis/contracts";

/**
 * LD-1 (#978) — the runner's phone: Hindi first; Sign stays off until the ward nurse's name and PIN, or runner-only with
 * a reason; sealed bags by tag, a held bag cannot be ticked; Save opens the round, then signs it.
 */
const now = new Date().toISOString();
const handler: LinenHandlerView = {
  serverNow: now,
  wards: [{
    wardId: "g", wardName: "General ward", floorName: null, beds: 10, bedsByClass: { general: 10 }, belowPar: true, shortPieces: 3, lastCountAt: null,
    items: [{ itemCode: "bedsheet", par: 30, parSource: "computed", onHand: 27, short: 3 }],
  }],
  items: [{ code: "bedsheet", name: "Bedsheet", unitsPerSet: 1 }],
  soiled: { general: {}, infected: {} }, inTransit: [],
};
const floor: LinenFloorView = {
  rounds: [], bedsWaiting: [], soiledRoom: { general: {}, infectedBags: [] }, mlcBeds: ["bed2"],
  holds: [{ id: "h1", kind: "chemo", bedId: "bed2", bedName: "G-2", wardId: "g", state: "active", placedAt: now, releaseAfter: now }],
  sealedBags: [
    { tag: "INF-1", wardId: "g", bedId: "bed1", bedName: "G-1", infected: true, held: false },
    { tag: "CH-1", wardId: "g", bedId: "bed2", bedName: "G-2", infected: true, held: true },
  ],
  beds: [{ bedId: "bed1", bedName: "G-1", wardId: "g" }, { bedId: "bed2", bedName: "G-2", wardId: "g" }],
};

describe("LinenRounds (LD-1)", () => {
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    try { localStorage.setItem("hmis.linen.ward", "g"); } catch { /* none */ }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/handler") ? handler : raw.endsWith("/linen/floor") ? floor
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.handle"], scoped: { department: {}, floor: {} } } }
          : raw.endsWith("/linen/rounds") ? { id: "r1", state: "open" } : { id: "r1", state: "signed" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); try { localStorage.removeItem("hmis.linen.ward"); } catch { /* none */ } });

  it("Hindi first; a held bag cannot be ticked; Sign waits for the nurse's name and PIN; Save opens then signs the pickup", async () => {
    renderWithProviders(<LinenRounds />);
    const tab = await screen.findByTestId("rounds-tab-pickup");
    expect(tab.querySelector(".hi")).toHaveTextContent("गंदा बाहर");
    expect(tab.querySelector(".en")).toHaveTextContent("Soiled out");
    await screen.findByTestId("bag-INF-1");
    expect(screen.getByTestId("bag-CH-1").querySelector("input")).toBeDisabled();
    expect(screen.getByTestId("bag-CH-1")).toHaveTextContent("Held · Chemo, 48 h");
    fireEvent.click(screen.getByTestId("rplus-bedsheet"));
    fireEvent.click(screen.getByTestId("bag-INF-1").querySelector("input")!);
    expect(screen.getByTestId("rounds-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("rounds-signer"), { target: { value: "ward.nurse" } });
    fireEvent.change(screen.getByTestId("rounds-pin"), { target: { value: "2468" } });
    expect(screen.getByTestId("rounds-save")).toBeEnabled();
    fireEvent.click(screen.getByTestId("rounds-save"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]).toMatchObject({ body: { wardId: "g", kind: "pickup" } });
    expect(posts[1]!.url).toMatch(/\/linen\/rounds\/r1\/pickup$/);
    expect(posts[1]!.body).toEqual({ lines: [{ itemCode: "bedsheet", qty: 1 }], bags: [{ tag: "INF-1" }], wardSign: { username: "ward.nurse", pin: "2468" } });
    expect(await screen.findByTestId("rounds-notice")).toHaveTextContent("Pickup signed");
  });

  it("runner only needs a reason; clean in starts at the shortfall", async () => {
    renderWithProviders(<LinenRounds />);
    fireEvent.click(await screen.findByTestId("rounds-tab-delivery"));
    await waitFor(() => expect(screen.getByTestId("rqty-bedsheet")).toHaveValue("3"));
    fireEvent.click(screen.getByTestId("rounds-runner-only"));
    expect(screen.getByTestId("rounds-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("rounds-reason"), { target: { value: "Nurse in a code" } });
    fireEvent.click(screen.getByTestId("rounds-save"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toMatch(/\/linen\/rounds\/r1\/delivery$/);
    expect(posts[1]!.body).toEqual({ lines: [{ itemCode: "bedsheet", qty: 3 }], runnerOnlyReason: "Nurse in a code" });
  });

  it("an MLC bed is suggested for a hold; placing a hold posts the bed", async () => {
    renderWithProviders(<LinenRounds />);
    fireEvent.click(await screen.findByTestId("rounds-tab-bag"));
    const holdBox = await screen.findByTestId("rounds-hold");
    const pick = holdBox.querySelector("select[data-testid='pick-bed']") as HTMLSelectElement;
    await waitFor(() => expect(pick.querySelectorAll("option")).toHaveLength(3));
    expect(pick).toHaveTextContent("G-2 · MLC · hold suggested");
    fireEvent.change(pick, { target: { value: "bed2" } });
    fireEvent.click(screen.getByTestId("hold-save"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ kind: "mlc", bedId: "bed2" });
  });

  it("the ward's holds are listed; a chemo hold ends by itself and has no Release; a radioactive refusal shows in words", async () => {
    floor.holds.push({ id: "r1h", kind: "radioactive", bedId: "bed1", bedName: "G-1", wardId: "g", state: "active", placedAt: now, releaseAfter: null });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") return new Response(JSON.stringify({ code: "not_rso" }), { status: 403, headers: { "Content-Type": "application/json" } });
      const body = raw.endsWith("/linen/handler") ? handler : raw.endsWith("/linen/floor") ? floor
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.handle", "linen.hold.release"], scoped: { department: {}, floor: {} } } } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderWithProviders(<LinenRounds />);
    fireEvent.click(await screen.findByTestId("rounds-tab-bag"));
    expect(await screen.findByTestId("hold-h1")).toHaveTextContent("Ends by itself at");
    expect(screen.queryByTestId("release-h1")).toBeNull();
    fireEvent.click(await screen.findByTestId("release-r1h"));
    expect(await screen.findByText("Only the RSO releases this")).toBeInTheDocument();
    floor.holds.pop();
  });
});
