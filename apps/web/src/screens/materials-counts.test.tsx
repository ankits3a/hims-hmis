import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsCounts } from "./materials-counts";
import type { WireCountHeader, WireCountReview } from "../lib/materials-api";

type Handler = unknown | ((init?: RequestInit) => unknown);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const body = typeof h === "function" ? (h as (i?: RequestInit) => unknown)(init) : h;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
const posted = (path: string): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).endsWith(path))
  .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

const HEADER: WireCountHeader = {
  id: "c1", storeResourceId: "s1", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", status: "counting",
  scheduledBy: "u-head", counterUserId: "u1", counterName: "Ravi Kumar", recountOf: null, recountId: null,
  frozenAt: "2026-09-16T04:30:00.000Z", countedAt: null, submittedAt: null,
  closedBy: null, closedAt: null, closeNote: null, cancelledBy: null, cancelledAt: null, cancelReason: null,
};

/** PLAN 14c, first slice — the counter's blind sheet, and the head's review. */
describe("MaterialsCounts (14c)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the counter fills a blind sheet: every line needs a number, and the sheet's time is sent in IST", async () => {
    mockRoutes({
      "GET /api/auth/me": me(["materials.counts.perform"]),
      "GET /api/materials/counts/mine": { items: [HEADER] },
      "GET /api/materials/counts/c1/sheet": {
        id: "c1", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", frozenAt: HEADER.frozenAt,
        lines: [
          { lineId: "l1", itemCode: "AZEE500", itemName: "Azee 500", baseUom: "tablet", batchNo: "AZ-1", expiryDate: "2027-06-30" },
          { lineId: "l2", itemCode: "CROC500", itemName: "Crocin 500", baseUom: "tablet", batchNo: "CR-1", expiryDate: "2027-03-31" },
        ],
      },
      "POST /api/materials/counts/c1/submit": { ...HEADER, status: "submitted" },
    });
    renderWithProviders(<MaterialsCounts />);
    await userEvent.click(await screen.findByRole("button", { name: "Open sheet" }));
    const sheet = await screen.findByTestId("count-sheet");
    expect(sheet).toHaveTextContent("AZ-1");
    expect(sheet).not.toHaveTextContent(/Books/);
    const submit = within(sheet).getByRole("button", { name: "Submit count" });
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Counted, batch AZ-1" }), "95");
    expect(submit).toBeDisabled();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Counted, batch CR-1" }), "0");
    const dayBox = within(sheet).getByLabelText("Counted on");
    const timeBox = within(sheet).getByLabelText("at (IST)");
    await userEvent.clear(dayBox);
    await userEvent.type(dayBox, "2026-09-16");
    await userEvent.clear(timeBox);
    await userEvent.type(timeBox, "10:20");
    await userEvent.click(submit);
    await waitFor(() => expect(posted("/materials/counts/c1/submit")).toEqual([{
      countedAt: "2026-09-16T04:50:00.000Z",
      lines: [{ lineId: "l1", countedQty: 95 }, { lineId: "l2", countedQty: 0 }],
    }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Count submitted: 2 lines");
    // The counter is not the head: no schedule, no review.
    expect(screen.queryByTestId("count-manager")).toBeNull();
  });

  it("the head schedules a store, reads the variance, and closes the count with a note", async () => {
    const review: WireCountReview = {
      ...HEADER, status: "submitted", countedAt: "2026-09-16T04:50:00.000Z", submittedAt: "2026-09-16T04:55:00.000Z", recountId: "c2",
      lines: [
        { lineId: "l1", itemId: "i1", itemCode: "AZEE500", itemName: "Azee 500", baseUom: "tablet", batchId: "b1", batchNo: "AZ-2", expiryDate: null, systemQty: 40, countedQty: 36, movedQty: 0, varianceQty: -4, variancePaise: -2000, flag: "variance" },
        { lineId: "l2", itemId: "i2", itemCode: "CROC500", itemName: "Crocin 500", baseUom: "tablet", batchId: "b2", batchNo: "CR-1", expiryDate: null, systemQty: 0, countedQty: 3, movedQty: 0, varianceQty: 3, variancePaise: 1500, flag: "recount" },
      ],
      totals: { lines: 2, matched: 0, variances: 2, recounts: 1, netVariancePaise: -500 },
    };
    mockRoutes({
      "GET /api/auth/me": me(["materials.counts.perform", "materials.counts.manage"]),
      "GET /api/materials/counts/mine": { items: [] },
      // The second row was frozen at 01:30 IST on the 17th, which is still the 16th in UTC.
      "GET /api/materials/counts": { items: [{ ...HEADER, status: "submitted" }, { ...HEADER, id: "c9", status: "closed", frozenAt: "2026-09-16T20:00:00.000Z" }] },
      "GET /api/materials/stores": { stores: [{ id: "s1", code: "PHARM-OPD", name: "OPD pharmacy", status: "active" }] },
      "POST /api/materials/counts": { ...HEADER, counterName: "Ravi Kumar" },
      "GET /api/materials/counts/c1": review,
      "POST /api/materials/counts/c1/close": { ...HEADER, status: "closed" },
    });
    renderWithProviders(<MaterialsCounts />);
    const manager = await screen.findByTestId("count-manager");
    await userEvent.selectOptions(await within(manager).findByRole("combobox", { name: "Store" }), "s1");
    await userEvent.click(within(manager).getByRole("button", { name: "Schedule a count" }));
    await waitFor(() => expect(posted("/materials/counts")).toEqual([{ storeResourceId: "s1" }]));
    expect(await screen.findByRole("status")).toHaveTextContent("OPD pharmacy will be counted by Ravi Kumar.");

    expect(await screen.findByTestId("count-row-c9")).toHaveTextContent("2026-09-17 01:30");
    await userEvent.click(within(await screen.findByTestId("count-row-c1")).getByRole("button", { name: "Review" }));
    const box = await screen.findByTestId("count-review");
    expect(within(box).getByTestId("count-totals")).toHaveTextContent("2 lines · 0 match · 2 out · 1 recounted");
    expect(within(box).getByTestId("review-AZ-2")).toHaveTextContent("40036-4");
    expect(within(box).getByTestId("review-CR-1")).toHaveTextContent("+3");
    expect(within(box).getByTestId("review-CR-1")).toHaveTextContent("Recount ordered");
    const close = within(box).getByRole("button", { name: "Close count" });
    expect(close).toBeDisabled();
    await userEvent.type(within(box).getByRole("textbox", { name: "Review note" }), "AZ-2 short 4, reported");
    await userEvent.click(close);
    await waitFor(() => expect(posted("/materials/counts/c1/close")).toEqual([{ note: "AZ-2 short 4, reported" }]));
  });
});
