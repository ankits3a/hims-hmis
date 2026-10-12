import { screen, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { BmwBoard } from "./bmw-board";
import type { BmwBagCard, BmwBoardView } from "@hmis/contracts";

/**
 * E1.7 BIO-MEDICAL WASTE (issue #724) — the supervisor's board: bags on site oldest first with the 48-hour clock in
 * words (never colour alone), today's generation by ward, open disputes, the next pickup, "+N more" instead of a scroll.
 */
const NOW = Date.now();
const ago = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const bag = (over: Partial<BmwBagCard>): BmwBagCard => ({
  id: "b1", barcode: "BMWY261012000001", category: "yellow", cytotoxic: false, state: "stored", placeResourceId: "r1",
  placeName: "Ward 3", floorName: "Floor 2", generatedAt: ago(2), deptWeightGrams: 1200, centralWeightGrams: 1210, centralGap: false,
  storageInAt: ago(1), handedOverAt: null, manifestId: null, cbwtfWeightGrams: null, version: 3, ...over,
});

describe("BmwBoard (E1.7)", () => {
  let view: BmwBoardView;
  beforeEach(() => {
    setToken("t");
    view = {
      serverNow: new Date(NOW).toISOString(),
      onSite: [
        bag({ id: "a", barcode: "BMWR261010000001", category: "red", generatedAt: ago(50.5) }),
        bag({ id: "w", barcode: "BMWY261011000002", generatedAt: ago(38.5) }),
        ...Array.from({ length: 60 }, (_, i) => bag({ id: `n${i}`, barcode: `BMWB2610120001${String(i).padStart(2, "0")}`, category: "blue", generatedAt: ago(3) })),
      ],
      counts: { onSite: 62, warning: 1, alert: 1, stored: 62, generatedToday: 4, gramsToday: 5400 },
      today: [{ placeResourceId: "r1", placeName: "Ward 3", bags: 4, grams: 5400, byCategory: { yellow: 3, red: 1, white_translucent: 0, blue: 0 } }],
      disputes: [{ id: "d1", manifestId: "m1", manifestNo: "MF-20261011-0001", category: "yellow", deptGrams: 1000, cbwtfGrams: 1060, gapBasisPoints: 600, state: "open", openedAt: ago(5) }],
      nextPickupAt: new Date(NOW + 3 * 3_600_000).toISOString(),
      lastManifest: { id: "m1", manifestNo: "MF-20261011-0001", cbwtfName: "Bihar Biocare", vehicleNo: "BR06GA1234", handedOverAt: ago(20), bags: 40, deptGrams: 30_000, cbwtfRecorded: true },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.endsWith("/bmw/board") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["bmw.view"], scoped: { department: {}, floor: {} } } }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("oldest first, the clock in words: over 48 h, 38 h · warning", async () => {
    renderWithProviders(<BmwBoard />);
    const list = await screen.findByTestId("bmw-onsite-list");
    const rows = await within(list).findAllByTestId(/^bag-(?!clock$)/);
    expect(rows[0]).toHaveAttribute("data-testid", "bag-BMWR261010000001");
    expect(within(rows[0]!).getByTestId("bag-clock")).toHaveTextContent("50 h · over 48 h");
    expect(within(rows[1]!).getByTestId("bag-clock")).toHaveTextContent("38 h · warning");
    expect(screen.getByTestId("bmw-alert")).toHaveTextContent("1over 48 h");
  });

  it("more bags than fit says +N more instead of scrolling", async () => {
    renderWithProviders(<BmwBoard />);
    const more = await screen.findByTestId("bmw-more");
    expect(more).toHaveTextContent(/^\+\d+ more$/);
  });

  it("today by ward, the open dispute with both weights, and the next pickup", async () => {
    renderWithProviders(<BmwBoard />);
    expect(await screen.findByTestId("ward-r1")).toHaveTextContent("4 bags · 5.40 kg");
    const d = screen.getByTestId("dispute-d1");
    expect(d).toHaveTextContent("+6.0 %");
    expect(d).toHaveTextContent("Ours 1.00 kg · theirs 1.06 kg");
    expect(screen.getByTestId("bmw-pickup")).toHaveTextContent("MF-20261011-0001");
  });
});
