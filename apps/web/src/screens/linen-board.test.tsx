import { screen, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenBoard } from "./linen-board";
import type { LinenBoardView, LinenWardState } from "@hmis/contracts";

/**
 * E2.4 LINEN (issue #728) — the supervisor's board: wards below par first in words (never colour alone), laundry out
 * and in today, the infected batch named in words, the week's top losses, and "+N more" instead of a scroll.
 */
const NOW = Date.now();
const ward = (over: Partial<LinenWardState>): LinenWardState => ({
  wardId: "w", wardName: "Ward", floorName: "Floor 3", beds: 10, bedsByClass: { general: 10 },
  items: [{ itemCode: "bedsheet", par: 30, parSource: "computed", onHand: 30, short: 0 }], belowPar: false, shortPieces: 0, lastCountAt: null, ...over,
});

describe("LinenBoard (E2.4)", () => {
  let view: LinenBoardView;
  beforeEach(() => {
    setToken("t");
    view = {
      serverNow: new Date(NOW).toISOString(),
      counts: { wards: 62, belowPar: 1, shortPieces: 18 },
      wards: [
        ward({ wardId: "g", wardName: "General ward", belowPar: true, shortPieces: 18, items: [{ itemCode: "bedsheet", par: 30, parSource: "computed", onHand: 12, short: 18 }] }),
        ...Array.from({ length: 61 }, (_, i) => ward({ wardId: `ok${i}`, wardName: `Ward ${i}` })),
      ],
      laundryToday: { outPieces: 120, inPieces: 96, infectedOutPieces: 12, shortPieces: 2 },
      inTransit: [
        { id: "b1", batchNo: "LN-20261012-0001", infected: true, state: "sent", vendorName: null, sentAt: new Date(NOW).toISOString(), receivedAt: null, piecesSent: 12, piecesReceived: null, lines: [] },
        { id: "b2", batchNo: "LN-20261012-0002", infected: false, state: "sent", vendorName: "City Laundry", sentAt: new Date(NOW).toISOString(), receivedAt: null, piecesSent: 108, piecesReceived: null, lines: [] },
      ],
      shorts: [],
      variance: { from: new Date(NOW - 7 * 86_400_000).toISOString(), to: new Date(NOW).toISOString(), top: [
        { wardId: "g", wardName: "General ward", itemCode: "towel", opening: 20, issued: 10, returned: 13, counted: 15, countedAt: new Date(NOW).toISOString(), missing: 2 },
      ] },
      condemnPending: [],
      items: [{ code: "bedsheet", name: "Bedsheet", unitsPerSet: 1 }, { code: "towel", name: "Towel", unitsPerSet: 1 }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.endsWith("/linen/board") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.view"], scoped: { department: {}, floor: {} } } }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the ward below par comes first and says so in words", async () => {
    renderWithProviders(<LinenBoard />);
    const list = await screen.findByTestId("linen-wards");
    const rows = await within(list).findAllByTestId(/^ward-(?!state$)/);
    expect(rows[0]).toHaveAttribute("data-testid", "ward-g");
    expect(within(rows[0]!).getByTestId("ward-state")).toHaveTextContent("Below par · short 18");
    expect(within(rows[0]!).getByText(/Bedsheet 12\/30/)).toBeInTheDocument();
    expect(within(rows[1]!).getByTestId("ward-state")).toHaveTextContent("At par");
    expect(screen.getByTestId("linen-more")).toHaveTextContent(/^\+\d+ more$/);
  });

  it("laundry out and in today, the infected batch named in words, and the week's loss", async () => {
    renderWithProviders(<LinenBoard />);
    expect(await screen.findByTestId("linen-out")).toHaveTextContent("120to laundry today");
    expect(screen.getByTestId("linen-in")).toHaveTextContent("96back today");
    expect(screen.getByTestId("linen-infected")).toHaveTextContent("12infected out today");
    expect(within(screen.getByTestId("batch-LN-20261012-0001")).getByTestId("batch-infected")).toHaveTextContent("Infected batch");
    expect(within(screen.getByTestId("batch-LN-20261012-0002")).queryByTestId("batch-infected")).toBeNull();
    const loss = screen.getByTestId("loss-g-towel");
    expect(loss).toHaveTextContent("2 missing");
    expect(loss).toHaveTextContent("Opening 20 + issued 10 − returned 13 − counted 15");
  });
});
