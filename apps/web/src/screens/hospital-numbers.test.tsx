import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HospitalNumbers } from "./hospital-numbers";
import type { NumbersTab, WireImagingMetrics, WirePharmacyMetrics } from "./hospital-numbers";
import type { WireLabMetrics } from "./lab-metrics";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * HOSPITAL NUMBERS (#777) — the screen lays out what the three metrics reads return, a tab per
 * grant. The figures are the server's (`modules/{lab,radiology,pharmacy}/metrics.test.ts`); this file
 * pins that a tab shows only for its permission, that each tab's figures reach the page, that money
 * is rupees in Indian grouping, that margin rows appear only when the server sent margin, and that a
 * figure the server did not send is a dash.
 */
const T = (n: number, medianMin: number | null, p90Min: number | null) => ({ n, medianMin, p90Min });
const NONE = T(0, null, null);

const LAB: WireLabMetrics = {
  from: "x", to: "x",
  totals: { orders: 3, tests: 4, published: 4, delivered: 3 },
  bySource: [
    { source: "opd", orders: 1, tests: 2, published: 1, delivered: 1 },
    { source: "ipd", orders: 1, tests: 1, published: 1, delivered: 1 },
    { source: "walk_in", orders: 1, tests: 1, published: 2, delivered: 1 },
  ],
  byTest: [],
  reportTimes: { placedToPublished: T(3, 120, 200), receivedToPublished: NONE, publishedToDelivered: NONE },
  testTimes: [],
  parameterTimes: [],
};

const IMAGING: WireImagingMetrics = {
  from: "x", to: "x",
  totals: { orders: 4, studies: 6, signed: 5, delivered: 5 },
  bySource: [
    { source: "opd", orders: 1, studies: 3, signed: 3, delivered: 3 },
    { source: "ipd", orders: 2, studies: 2, signed: 1, delivered: null },
    { source: "walk_in", orders: 1, studies: 1, signed: 1, delivered: 1 },
  ],
  byModality: [
    { modality: "xray", orders: 1, studies: 1, signed: 1, delivered: 1 },
    { modality: "usg", orders: 2, studies: 3, signed: 3, delivered: 3 },
  ],
  times: { placedToDone: T(6, 45, 315), doneToSigned: T(5, 30, 52), signedToDelivered: NONE, placedToSigned: T(5, 100, 408) },
};

const PHARMACY: WirePharmacyMetrics = {
  from: "x", to: "x",
  bills: 4, salesPaise: 12_345_678, returnsPaise: 45_000, netPaise: 12_300_678,
  prescriptions: { received: 5, full: 1, part: 1, none: 3 },
  receivedToDispensed: T(2, 35, 39),
  topItems: [{ itemId: "i1", itemCode: "CROC500", itemName: "Crocin 500", qtyBase: 25, amountPaise: 30_000 }],
  purchases: { grns: 1, valuePaise: 55_000 },
};

function mount(perms: string[], opts: { margin?: boolean; initialTab?: NumbersTab } = {}): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(raw);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (raw.startsWith("/api/auth/me")) {
      return json({ actor: { type: "user", id: "o" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    }
    if (raw.startsWith("/api/lab/metrics")) return json(LAB);
    if (raw.startsWith("/api/radiology/metrics")) return json(IMAGING);
    if (raw.startsWith("/api/pharmacy/metrics")) {
      return json(opts.margin === true ? { ...PHARMACY, margin: { revenuePaise: 100_000, costPaise: 14_000, profitPaise: 86_000, marginBps: 8600 } } : PHARMACY);
    }
    return new Response("{}", { status: 404 });
  }));
  setToken("t-1");
  renderWithProviders(<HospitalNumbers {...(opts.initialTab === undefined ? {} : { initialTab: opts.initialTab })} />);
  return seen;
}

const ALL = ["lab.metrics.read", "radiology.metrics.read", "pharmacy.metrics.read"];
const rows = (testId: string): (string | null)[] => within(screen.getByTestId(testId)).getAllByRole("row").map((r) => r.textContent);

afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

describe("Hospital numbers — tabs per permission", () => {
  it("shows a tab for each grant held, and only those", async () => {
    mount(ALL);
    const tabs = await screen.findByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Lab", "Imaging", "Pharmacy"]);
  });

  it("a pharmacy-only reader sees the Pharmacy tab alone and never asks the lab or imaging", async () => {
    const seen = mount(["pharmacy.metrics.read"]);
    const tabs = await screen.findByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Pharmacy"]);
    await screen.findByTestId("pharmacy-metrics-sales");
    expect(seen.some((u) => u.startsWith("/api/lab/") || u.startsWith("/api/radiology/"))).toBe(false);
  });

  it("with none of the three grants there are no tabs and nothing is asked", async () => {
    const seen = mount(["pharmacy.reports.read"]);
    await screen.findByText("No numbers for your role");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(seen.some((u) => u.includes("/metrics"))).toBe(false);
  });

  it("opens on the tab the address names when it is held, and on the first held tab when it is not", async () => {
    mount(["lab.metrics.read", "radiology.metrics.read"], { initialTab: "imaging" });
    await screen.findByTestId("imaging-metrics-source");
    expect(screen.getByRole("tab", { name: "Imaging" })).toHaveAttribute("aria-selected", "true");
  });

  it("an address naming a tab not held falls back to the first held one", async () => {
    mount(["lab.metrics.read"], { initialTab: "pharmacy" });
    await screen.findByTestId("lab-metrics-source");
    expect(screen.queryByRole("tab", { name: "Pharmacy" })).not.toBeInTheDocument();
  });
});

describe("Hospital numbers — each tab's figures", () => {
  it("Lab: the Lab numbers tables, unchanged", async () => {
    mount(ALL);
    await screen.findByTestId("lab-metrics-source");
    expect(rows("lab-metrics-source")).toEqual(["SourceOrdersTestsPublishedDelivered", "OPD1211", "IPD1111", "Walk-in1121", "Total3443"]);
    expect(rows("lab-metrics-report-times")[1]).toBe("Order → published120 / 200 n 3");
  });

  it("Imaging: counts by source and modality, times; a figure not sent and a step with no data are dashes", async () => {
    mount(ALL);
    await userEvent.click(await screen.findByRole("tab", { name: "Imaging" }));
    await screen.findByTestId("imaging-metrics-source");
    expect(rows("imaging-metrics-source")).toEqual([
      "SourceOrdersStudies doneSignedDelivered", "OPD1333", "IPD221—", "Walk-in1111", "Total4655",
    ]);
    expect(rows("imaging-metrics-modality")).toEqual(["ModalityOrdersStudies doneSignedDelivered", "X-ray1111", "Ultrasound2333"]);
    expect(rows("imaging-metrics-times").slice(1)).toEqual([
      "Order → done45 / 315 n 6", "Done → signed30 / 52 n 5", "Signed → delivered—", "Order → signed100 / 408 n 5",
    ]);
  });

  it("Pharmacy: rupees in Indian grouping, prescriptions, top items, purchases; no margin rows when none was sent", async () => {
    mount(ALL, { initialTab: "pharmacy" });
    await screen.findByTestId("pharmacy-metrics-sales");
    expect(rows("pharmacy-metrics-sales").slice(1)).toEqual([
      "Bills4", "Sales₹1,23,456.78", "Returns₹450.00", "Net sales₹1,23,006.78",
    ]);
    expect(rows("pharmacy-metrics-rx").slice(1)).toEqual([
      "Received5", "Given in full1", "Given in part1", "Not given3", "Received → given35 / 39 n 2",
    ]);
    expect(rows("pharmacy-metrics-top").slice(1)).toEqual(["Crocin 50025₹300.00"]);
    expect(rows("pharmacy-metrics-purchases").slice(1)).toEqual(["GRNs1", "Value at cost₹550.00"]);
    expect(screen.queryByText("Profit")).not.toBeInTheDocument();
  });

  it("Pharmacy: margin rows appear when the server sent margin", async () => {
    mount(ALL, { initialTab: "pharmacy", margin: true });
    await screen.findByTestId("pharmacy-metrics-sales");
    expect(rows("pharmacy-metrics-sales").slice(5)).toEqual([
      "Revenue (taxable)₹1,000.00", "Cost₹140.00", "Profit₹860.00", "Margin86.00%",
    ]);
  });

  it("one period serves every tab: From after To is refused without asking the server", async () => {
    const seen = mount(ALL);
    await screen.findByTestId("lab-metrics-source");
    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    const before = seen.filter((u) => u.includes("/metrics")).length;
    await userEvent.clear(screen.getByLabelText("From"));
    await userEvent.type(screen.getByLabelText("From"), "2999-01-01");
    await waitFor(() => { expect(screen.getByRole("alert")).toHaveTextContent("From must be on or before To"); });
    await userEvent.click(screen.getByRole("tab", { name: "Pharmacy" }));
    expect(seen.filter((u) => u.includes("/metrics")).length).toBe(before);
  });
});
