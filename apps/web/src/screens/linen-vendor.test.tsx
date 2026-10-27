import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenVendor } from "./linen-vendor";
import type { LinenFloorView, LinenVendorDeskView } from "@hmis/contracts";

/** LD-2 (#979) — the vendor desk: late challans first, the dock return per item, the par verdict in words, a held bill. */
const now = new Date().toISOString();
const later = new Date(Date.now() + 3_600_000).toISOString();
const desk = (over: Partial<LinenVendorDeskView> = {}): LinenVendorDeskView => ({
  serverNow: now, month: "2026-09",
  vendors: [{ id: "v1", name: "Clean Wash", turnaroundHours: 24, rushTurnaroundHours: 12, gstRateBps: 1800 }],
  openChallans: [
    { id: "c1", challanNo: "CH-LN-1", batchId: "b1", linenVendorId: "v1", vendorName: "Clean Wash", pieces: 10, weightGrams: 6500, rush: false, sentAt: now, dueAt: later, late: false, open: true,
      lines: [{ itemCode: "bedsheet", sent: 10, accepted: 0, damaged: 0, stained: 0, missing: 10 }] },
    { id: "c2", challanNo: "CH-LN-2", batchId: "b2", linenVendorId: "v1", vendorName: "Clean Wash", pieces: 4, weightGrams: 2400, rush: true, sentAt: now, dueAt: now, late: true, open: true,
      lines: [{ itemCode: "towel", sent: 4, accepted: 2, damaged: 0, stained: 0, missing: 2 }] },
  ],
  reports: [{
    linenVendorId: "v1", vendorName: "Clean Wash", month: "2026-09", piecesSent: 20, lost: 5, damaged: 3, batches: 1, lateBatches: 0,
    belowPar: true, lossBelowPar: true, lateBelowPar: false, monthOver: true, proposed: { lines: [], totalPaise: 320_000 }, reversals: [],
    recovery: { id: "r1", state: "proposed", proposedPaise: 320_000, approvedPaise: null, proposedBy: "someone-else" },
  }],
  bills: [{
    id: "bl1", linenVendorId: "v1", month: "2026-09", vendorBillNo: "CW/101",
    lines: [{ itemCode: "bedsheet", billed: 16, accepted: 15, flagged: true, billedPaise: 24_000, acceptedPaise: 19_500 }],
    billedPaise: 28_320, acceptedValuePaise: 19_500, gstPaise: 3510, recoveryPaise: 0, payablePaise: 23_010, heldPaise: 5310, state: "held", checkedBy: "desk",
  }],
  recoveries: [],
  licences: [
    { id: "l1", kind: "etp_consent", licenceNo: "SPCB/ETP/1", authority: "SPCB", validTo: "2026-12-01", daysLeft: 35, state: "red" },
    { id: "l2", kind: "boiler", licenceNo: "IBR/77", authority: "Boilers", validTo: "2027-06-01", daysLeft: 217, state: "ok" },
  ],
  chemicals: { month: "2026-09", kgWashed: 80, items: [{ itemId: "i", name: "Detergent", uom: "kg", qty: 4, costPaise: 40_000, perKg: 0.05, costPerKgPaise: 500 }], inHouseCostPerKgPaise: 500, vendorKgSent: 20, vendorCostPerKgPaise: 600 },
  ...over,
});
const floor = { rounds: [], holds: [], soiledRoom: { general: { bedsheet: 12 }, infectedBags: [] }, bedsWaiting: [], mlcBeds: [], sealedBags: [], beds: [] } as unknown as LinenFloorView;

describe("LinenVendor (LD-2)", () => {
  let posts: { url: string; body: unknown }[];
  let perms: string[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    perms = ["linen.vendor", "linen.recovery.approve", "linen.bill.approve", "linen.handle"];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.includes("/linen/vendor-desk") ? desk() : raw.endsWith("/linen/floor") ? floor
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }
          : { id: "x", state: "approved", challanId: "c1", closed: false, condemnRequests: 0, batchNo: "LN-9", movements: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a late challan comes first; Return records accepted, damaged and stained per item against the challan", async () => {
    renderWithProviders(<LinenVendor />);
    await screen.findByTestId("challan-CH-LN-1");
    const rows = screen.getByTestId("vendor-challans").querySelectorAll("tbody tr");
    expect(rows[0]).toHaveAttribute("data-testid", "challan-CH-LN-2");
    expect(rows[0]).toHaveTextContent("Late");
    fireEvent.click(screen.getByTestId("return-CH-LN-1"));
    fireEvent.change(screen.getByTestId("ret-bedsheet-accepted"), { target: { value: "8" } });
    fireEvent.change(screen.getByTestId("ret-bedsheet-damaged"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("ret-bedsheet-stained"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("return-save-CH-LN-1"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/challans\/c1\/return$/);
    expect(posts[0]!.body).toEqual({ lines: [{ itemCode: "bedsheet", accepted: 8, damaged: 1, stained: 1 }] });
  });

  it("sending to the vendor needs the vendor and the weight: the challan goes with the batch", async () => {
    renderWithProviders(<LinenVendor />);
    const go = await screen.findByTestId("send-go");
    fireEvent.change(await screen.findByTestId("send-bedsheet"), { target: { value: "10" } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByTestId("send-kg"), { target: { value: "6.5" } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ infected: false, mode: "vendor", linenVendorId: "v1", weightGrams: 6500, lines: [{ itemCode: "bedsheet", qty: 10 }] });
  });

  it("the month says below par in words with the proposed amount; the approver approves someone else's recovery", async () => {
    renderWithProviders(<LinenVendor />);
    const r = await screen.findByTestId("report-v1");
    expect(r).toHaveTextContent("Below par");
    expect(r).toHaveTextContent("lost 5");
    expect(r).toHaveTextContent("₹3,200");
    fireEvent.click(screen.getByTestId("approve-v1"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/recoveries\/r1\/approve$/);
  });

  it("a held bill names the flagged line and the excess; stores approves it; licences show red with days left", async () => {
    renderWithProviders(<LinenVendor />);
    const b = await screen.findByTestId("bill-CW/101");
    expect(b).toHaveTextContent("billed 16, accepted 15");
    expect(b).toHaveTextContent("₹53.10 held for stores");
    fireEvent.click(screen.getByTestId("bill-approve-CW/101"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/bills\/bl1\/approve$/);
    expect(screen.getByTestId("licence-etp_consent")).toHaveTextContent("35 days left");
    expect(screen.getByTestId("vendor-perkg")).toHaveTextContent("₹5/kg");
  });

  it("without the approver's permission there is no Approve; the desk sees Raise only when nothing is raised", async () => {
    perms = ["linen.vendor"];
    renderWithProviders(<LinenVendor />);
    await screen.findByTestId("report-v1");
    expect(screen.queryByTestId("approve-v1")).toBeNull();
    expect(screen.queryByTestId("raise-v1")).toBeNull();
  });
});
