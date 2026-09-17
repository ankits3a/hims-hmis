import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CountAdjustments } from "./count-adjustments";
import type { WireAdjustment, WireCountReview } from "../lib/materials-api";

const REVIEW: WireCountReview = {
  id: "c1", storeResourceId: "s1", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", status: "submitted",
  scheduledBy: "u-head", counterUserId: "u-keeper", counterName: "Keeper", recountOf: null, recountId: "c2",
  frozenAt: "2026-09-16T04:30:00.000Z", countedAt: "2026-09-16T04:50:00.000Z", submittedAt: "2026-09-16T04:55:00.000Z",
  closedBy: null, closedAt: null, closeNote: null, cancelledBy: null, cancelledAt: null, cancelReason: null,
  lines: [
    { lineId: "l1", itemId: "i1", itemCode: "AZEE500", itemName: "Azee 500", baseUom: "tablet", batchId: "b1", batchNo: "AZ-1", expiryDate: null, systemQty: 100, countedQty: 97, movedQty: 0, varianceQty: -3, variancePaise: -1500, flag: "variance" },
    { lineId: "l2", itemId: "i1", itemCode: "AZEE500", itemName: "Azee 500", baseUom: "tablet", batchId: "b2", batchNo: "AZ-2", expiryDate: null, systemQty: 40, countedQty: 41, movedQty: 0, varianceQty: 1, variancePaise: 500, flag: "variance" },
    { lineId: "l3", itemId: "i2", itemCode: "CROC500", itemName: "Crocin", baseUom: "tablet", batchId: "b3", batchNo: "CR-1", expiryDate: null, systemQty: 20, countedQty: 10, movedQty: 0, varianceQty: -10, variancePaise: -5000, flag: "recount" },
    { lineId: "l4", itemId: "i2", itemCode: "CROC500", itemName: "Crocin", baseUom: "tablet", batchId: "b4", batchNo: "CR-2", expiryDate: null, systemQty: 5, countedQty: 5, movedQty: 0, varianceQty: 0, variancePaise: 0, flag: "match" },
  ],
  totals: { lines: 4, matched: 1, variances: 3, recounts: 1, netVariancePaise: -6000 },
};
const ADJ = (over: Partial<WireAdjustment>): WireAdjustment => ({
  id: "a1", countId: "c1", countLineId: "l1", batchId: "b1", batchNo: "AZ-1", itemId: "i1", itemCode: "AZEE500",
  qtyDelta: -3, valuePaise: -1500, reasonCode: "shrinkage", note: null, approvalId: "ap1", approvalStatus: "pending",
  status: "requested", requestedBy: "u-head", requestedAt: "2026-09-16T05:00:00.000Z", postedAt: null, ledgerEntryId: null, ...over,
});

function stub(adjustments: () => WireAdjustment[]): unknown[] {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST") {
      posts.push([url.replace(/^.*\/api/, ""), JSON.parse(String(init.body))]);
      return json(url.endsWith("/post") ? { posted: 1, refused: 0 } : { approvalId: "ap1", adjustments: [] });
    }
    if (url.includes("/adjustments")) return json({ items: adjustments() });
    return new Response("{}", { status: 404 });
  }));
  return posts;
}

/** PLAN 14c, second slice — the head asks with a reason per line; books only what the MS approved. */
describe("CountAdjustments (14c)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("offers only variance lines, fits the reasons to the direction, and asks with them", async () => {
    const posts = stub(() => []);
    renderWithProviders(<CountAdjustments review={REVIEW} />);
    const panel = await screen.findByTestId("count-adjustments");
    expect(within(panel).queryByTestId("adjust-CR-1")).toBeNull();
    expect(within(panel).queryByTestId("adjust-CR-2")).toBeNull();
    const ask = within(panel).getByRole("button", { name: /Ask to book/ });
    expect(ask).toBeDisabled();
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Book batch AZ-1" }));
    await userEvent.click(within(panel).getByRole("checkbox", { name: "Book batch AZ-2" }));
    const loss = within(panel).getByRole("combobox", { name: "Reason for batch AZ-1" });
    expect(within(loss).queryByRole("option", { name: "Found stock" })).toBeNull();
    await userEvent.selectOptions(loss, "damage");
    const gain = within(panel).getByRole("combobox", { name: "Reason for batch AZ-2" });
    expect(within(gain).queryByRole("option", { name: "Damaged" })).toBeNull();
    await userEvent.type(within(panel).getByRole("textbox", { name: "Note for the approver" }), "strips torn");
    expect(ask).toHaveTextContent("Ask to book 2 lines (net -₹10.00)");
    await userEvent.click(ask);
    await waitFor(() => expect(posts).toEqual([["/materials/counts/c1/adjustments", {
      lines: [{ lineId: "l1", reasonCode: "damage" }, { lineId: "l2", reasonCode: "found" }], note: "strips torn",
    }]]));
  });

  it("shows what was asked, and books only once the MS has approved", async () => {
    let status = "pending";
    const posts = stub(() => [ADJ({ approvalStatus: status })]);
    const view = renderWithProviders(<CountAdjustments review={REVIEW} />);
    const panel = await screen.findByTestId("count-adjustments");
    expect(await within(panel).findByTestId("adjustment-AZ-1")).toHaveTextContent("Missing (unexplained) · asked · awaiting the MS");
    expect(within(panel).queryByTestId("adjust-AZ-1")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Book the approved adjustment" })).toBeNull();
    view.unmount();

    status = "granted";
    renderWithProviders(<CountAdjustments review={REVIEW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Book the approved adjustment" }));
    await waitFor(() => expect(posts).toEqual([["/materials/adjustments/ap1/post", {}]]));
    expect(await screen.findByRole("status")).toHaveTextContent("Booked 1 line.");
  });
});
