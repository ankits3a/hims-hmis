import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenStore } from "./linen-store";
import type { LinenBoardView, LinenLaundryView, LinenWardState } from "@hmis/contracts";

/** LD-1 (#978) — the linen store: wards with beds waiting for linen first, Send tops a ward up to par, the vendor's batches. */
const ward = (wardId: string, wardName: string, onHand: number): LinenWardState => ({
  wardId, wardName, floorName: null, beds: 10, bedsByClass: { general: 10 }, belowPar: onHand < 30, shortPieces: Math.max(0, 30 - onHand), lastCountAt: null,
  items: [{ itemCode: "bedsheet", par: 30, parSource: "computed", onHand, short: Math.max(0, 30 - onHand) }],
});
const now = new Date().toISOString();
const board: LinenBoardView = {
  serverNow: now, counts: { wards: 2, belowPar: 2, shortPieces: 25 },
  wards: [ward("a", "4A Medicine", 10), ward("b", "4B Medicine", 25)],
  laundryToday: { outPieces: 0, inPieces: 0, infectedOutPieces: 0, shortPieces: 0 },
  inTransit: [
    { id: "v1", batchNo: "LN-1", infected: true, state: "sent", vendorName: "Sparkle", sentAt: now, receivedAt: null, piecesSent: 12, piecesReceived: null, lines: [] },
    { id: "p1", batchNo: "LN-2", infected: false, state: "washing", vendorName: null, sentAt: now, receivedAt: null, piecesSent: 8, piecesReceived: null, lines: [] },
  ],
  shorts: [], variance: { from: now, to: now, top: [] }, condemnPending: [], items: [{ code: "bedsheet", name: "Bedsheet", unitsPerSet: 1 }],
};
const laundry: LinenLaundryView = {
  serverNow: now,
  bedsWaiting: [{ bedId: "x", bedName: "4B-12", wardId: "b", short: { bedsheet: 1 }, rush: true, raisedAt: now }],
  holds: [{ id: "h", kind: "chemo", bedId: "y", bedName: "4A-03", wardId: "a", state: "active", placedAt: now, releaseAfter: now }],
  rush: { day: "2026-10-26", wards: [{ wardId: "b", wardName: "4B Medicine", discharges: 6, short: {} }], theatreCases: 4 },
  plant: { serverNow: now, machines: [], vendorQueue: [], queue: [{ batchId: "p1", batchNo: "LN-2", infected: false, stream: "ward", state: "washing", pieces: 8, sentAt: now }] },
};

describe("LinenStore (LD-1)", () => {
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/board") ? board : raw.endsWith("/linen/laundry") ? laundry
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.view"], scoped: { department: {}, floor: {} } } }
          : { movements: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a ward with a bed waiting for linen comes first, with its due-out discharges, and Send tops it up to par", async () => {
    renderWithProviders(<LinenStore />);
    await screen.findByTestId("store-b");
    const rows = screen.getByTestId("store-wards").querySelectorAll("tbody tr");
    expect(rows[0]).toHaveAttribute("data-testid", "store-b");
    expect(rows[0]).toHaveTextContent("6");
    expect(screen.getByTestId("send-b")).toHaveTextContent("Send · rush");
    fireEvent.click(screen.getByTestId("send-b"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/wards\/b\/top-up$/);
    expect(posts[0]!.body).not.toHaveProperty("lines");
    expect(typeof (posts[0]!.body as { idempotencyKey?: unknown }).idempotencyKey).toBe("string");
  });

  it("the vendor column leaves out plant batches and names an infected batch in words; holds say not laundry", async () => {
    renderWithProviders(<LinenStore />);
    const vendor = await screen.findByTestId("store-vendor");
    await waitFor(() => expect(vendor).toHaveTextContent("LN-1"));
    expect(vendor).not.toHaveTextContent("LN-2");
    expect(vendor).toHaveTextContent("Infected batch");
    expect(screen.getByTestId("store-holds")).toHaveTextContent("Hold · 4A-03 (Chemo, 48 h)");
  });
});
