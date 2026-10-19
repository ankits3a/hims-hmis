import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabMetrics, rangeFor } from "./lab-metrics";
import type { WireLabMetrics } from "./lab-metrics";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * LAB NUMBERS (#768) — the screen lays out what `GET /lab/metrics` returns: counts by source and by
 * test, then median / 90% / n for every report, test and parameter step. The figures are the
 * server's (`modules/lab/metrics.test.ts`); this file pins that each one reaches the page, that an
 * empty step reads as a dash rather than a zero, and what range each preset asks for.
 */
const T = (n: number, medianMin: number | null, p90Min: number | null) => ({ n, medianMin, p90Min });
const NONE = T(0, null, null);
const BODY: WireLabMetrics = {
  from: "x", to: "x",
  totals: { orders: 3, tests: 4, published: 4, delivered: 3 },
  bySource: [
    { source: "opd", orders: 1, tests: 2, published: 1, delivered: 1 },
    { source: "ipd", orders: 1, tests: 1, published: 1, delivered: 1 },
    { source: "walk_in", orders: 1, tests: 1, published: 2, delivered: 1 },
  ],
  byTest: [{ serviceId: "s-cbc", code: "CBC", name: "Complete blood count", orders: 2, tests: 2, published: 3, delivered: 2 }],
  reportTimes: { placedToPublished: T(3, 120, 200), receivedToPublished: T(4, 57.5, 147), publishedToDelivered: T(3, 30, 54) },
  testTimes: [{
    serviceId: "s-cbc", code: "CBC", name: "Complete blood count",
    placedToCollected: T(2, 17.5, 19.5), collectedToReceived: T(2, 20, 20), receivedToEntered: T(2, 20, 20),
    enteredToVerified: NONE, placedToVerified: T(2, 80, 88),
  }],
  parameterTimes: [{ analyteId: "a-wbc", code: "WBC", name: "WBC count", mode: "machine", receivedToEntered: T(1, 20, 20), enteredToVerified: T(1, 30, 30) }],
};

function mount(seen: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(raw);
    if (raw.startsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "o" }, permissions: { hospital: ["lab.metrics.read"], scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    if (raw.startsWith("/api/lab/metrics")) return new Response(JSON.stringify(BODY), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
  setToken("t-1");
  renderWithProviders(<LabMetrics />);
}

afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

describe("Lab numbers", () => {
  it("shows counts by source with a total, and counts by test", async () => {
    const seen: string[] = [];
    mount(seen);
    const source = await screen.findByTestId("lab-metrics-source");
    const rows = within(source).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toEqual(["SourceOrdersTestsPublishedDelivered", "OPD1211", "IPD1111", "Walk-in1121", "Total3443"]);
    const byTest = screen.getByTestId("lab-metrics-test");
    expect(within(byTest).getAllByRole("row")[1]!.textContent).toBe("Complete blood count2232");
    // Today, from and to the same IST day — the clock is read, never pinned.
    const url = seen.find((u) => u.startsWith("/api/lab/metrics"))!;
    const m = /from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(url);
    expect(m?.[1]).toBe(m?.[2]);
  });

  it("shows every time as median / 90% with n, and a dash for a step with no data", async () => {
    mount([]);
    const reports = await screen.findByTestId("lab-metrics-report-times");
    expect(within(reports).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "Order → published120 / 200 n 3", "Sample → published57.5 / 147 n 4", "Published → delivered30 / 54 n 3",
    ]);
    const tests = screen.getByTestId("lab-metrics-test-times");
    expect(within(tests).getAllByRole("row")[1]!.textContent).toBe(
      "Complete blood count17.5 / 19.5 n 220 / 20 n 220 / 20 n 2—80 / 88 n 2",
    );
    const params = screen.getByTestId("lab-metrics-param-times");
    expect(within(params).getAllByRole("row")[1]!.textContent).toBe("WBC countMachine20 / 20 n 130 / 30 n 1");
  });

  it("custom range shows two dates and refuses From after To without asking the server", async () => {
    const seen: string[] = [];
    mount(seen);
    await screen.findByTestId("lab-metrics-source");
    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    const from = screen.getByLabelText("From");
    const before = seen.filter((u) => u.startsWith("/api/lab/metrics")).length;
    await userEvent.clear(from);
    await userEvent.type(from, "2999-01-01");
    await waitFor(() => { expect(screen.getByRole("alert")).toHaveTextContent("From must be on or before To"); });
    expect(seen.filter((u) => u.startsWith("/api/lab/metrics")).length).toBe(before);
  });
});

describe("rangeFor — what each preset asks for", () => {
  it("today is one day; a week starts on Monday; a month on the 1st", () => {
    expect(rangeFor("today", "2026-10-15")).toEqual({ from: "2026-10-15", to: "2026-10-15" });
    expect(rangeFor("week", "2026-10-15")).toEqual({ from: "2026-10-12", to: "2026-10-15" }); // a Thursday
    expect(rangeFor("week", "2026-10-12")).toEqual({ from: "2026-10-12", to: "2026-10-12" }); // a Monday
    expect(rangeFor("week", "2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" }); // a Sunday
    expect(rangeFor("month", "2026-10-15")).toEqual({ from: "2026-10-01", to: "2026-10-15" });
  });
});
