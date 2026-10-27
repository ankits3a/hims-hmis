import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenPlant } from "./linen-plant";
import type { LinenFloorView, LinenHandlerView, LinenLaundryView } from "@hmis/contracts";

/**
 * LD-1 (#978) — the laundry floor: an infected batch is named in words, a batch back for rewash says it cannot be
 * released, a machine down sends its waiting work to the vendor, Start posts a cycle and Finish then takes readings.
 */
const now = new Date().toISOString();
const laundry: LinenLaundryView = {
  serverNow: now, bedsWaiting: [{ bedId: "x", bedName: "4B-12", wardId: "b", short: { bedsheet: 1 }, rush: true, raisedAt: now }], holds: [],
  rush: { day: "2026-10-26", wards: [], theatreCases: 0 },
  plant: {
    serverNow: now,
    machines: [{ id: "w1", code: "W1", kind: "washer", name: "Washer 1", state: "up", downReason: null, running: false }],
    queue: [
      { batchId: "b1", batchNo: "LN-1", infected: true, stream: "ward", state: "rewash", pieces: 2, sentAt: now },
      { batchId: "b2", batchNo: "LN-2", infected: false, stream: "ward", state: "sent", pieces: 5, sentAt: now },
      { batchId: "b3", batchNo: "LN-3", infected: false, stream: "theatre", state: "qc", pieces: 4, sentAt: now },
    ],
    vendorQueue: [],
  },
};
const floor: LinenFloorView = {
  rounds: [], holds: [], bedsWaiting: [], mlcBeds: [], sealedBags: [], beds: [],
  soiledRoom: { general: { bedsheet: 7 }, infectedBags: [{ tag: "INF-1", wardId: "b", weightGrams: 1200 }] },
};
const handler: LinenHandlerView = {
  serverNow: now, wards: [], items: [{ code: "bedsheet", name: "Bedsheet", unitsPerSet: 1 }, { code: "ot_gown", name: "OT gown", unitsPerSet: 0 }],
  soiled: { general: {}, infected: {} },
  inTransit: [{ id: "b3", batchNo: "LN-3", infected: false, state: "qc", vendorName: null, sentAt: now, receivedAt: null, piecesSent: 4, piecesReceived: null, lines: [{ itemCode: "ot_gown", sent: 4, received: null }] }],
};

describe("LinenPlant (LD-1)", () => {
  let posts: { url: string; body: unknown }[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/laundry") ? laundry : raw.endsWith("/linen/floor") ? floor : raw.endsWith("/linen/handler") ? handler
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["linen.plant", "linen.qc", "linen.handle"], scoped: { department: {}, floor: {} } } }
          : raw.endsWith("/linen/cycles") ? { id: "c1" } : { id: "x", state: "ok" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("names the infected batch in words, says a rewash batch cannot be released, and lists the soiled room by bag", async () => {
    renderWithProviders(<LinenPlant />);
    const tile = await screen.findByTestId("pb-LN-1");
    expect(tile).toHaveTextContent("Infected batch");
    expect(tile).toHaveTextContent("Cannot be released");
    expect(screen.getByTestId("plant-needs")).toHaveTextContent("Batch LN-1 · rewash");
    expect(screen.getByTestId("plant-needs")).toHaveTextContent("4B-12 waiting for linen");
    expect(screen.getByTestId("plant-infected-bags")).toHaveTextContent("1 kg · 1 bag");
  });

  it("Start posts one cycle on a free washer; a theatre batch at check offers CSSD with a signature", async () => {
    renderWithProviders(<LinenPlant />);
    fireEvent.click(await screen.findByTestId("start-LN-2"));
    await waitFor(() => expect(screen.getByTestId("start-machine")).toHaveValue("w1"));
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/cycles$/);
    expect(posts[0]!.body).toEqual({ machineId: "w1", batchIds: ["b2"], program: "warm" });

    fireEvent.click(await screen.findByTestId("cssd-LN-3"));
    const form = screen.getByTestId("sign-form");
    expect(within(form).getByTestId("sign-go")).toBeDisabled();
    fireEvent.change(within(form).getByTestId("sign-name"), { target: { value: "cssd.nurse" } });
    fireEvent.change(within(form).getByTestId("sign-pin"), { target: { value: "1357" } });
    fireEvent.click(within(form).getByTestId("sign-go"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toMatch(/\/linen\/laundry\/batches\/b3\/cssd$/);
    expect(posts[1]!.body).toEqual({ cssdSign: { username: "cssd.nurse", pin: "1357" } });
  });

  it("quality check starts every piece at pass and posts the four outcomes", async () => {
    renderWithProviders(<LinenPlant />);
    fireEvent.click(await screen.findByTestId("qc-LN-3"));
    await waitFor(() => expect(screen.getByTestId("qc-pass-ot_gown")).toHaveValue("4"));
    fireEvent.change(screen.getByTestId("qc-pass-ot_gown"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("qc-mend-ot_gown"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("qc-go"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ lines: [{ itemCode: "ot_gown", pass: 3, rewash: 0, mend: 1, condemn: 0 }] });
  });

  it("LD-2 (#979): with a vendor set up, To vendor asks for the vendor and the weight — the challan", async () => {
    laundry.plant.vendors = [{ id: "v1", name: "Clean Wash" }];
    try {
      renderWithProviders(<LinenPlant />);
      fireEvent.click(await screen.findByTestId("vendor-LN-2"));
      expect(posts).toHaveLength(0);
      const go = screen.getByTestId("vendor-go");
      expect(go).toBeDisabled();
      fireEvent.change(screen.getByTestId("vendor-kg"), { target: { value: "3.2" } });
      fireEvent.click(go);
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]!.url).toMatch(/\/linen\/laundry\/batches\/b2\/vendor$/);
      expect(posts[0]!.body).toEqual({ linenVendorId: "v1", weightGrams: 3200 });
    } finally {
      delete laundry.plant.vendors;
    }
  });
});
