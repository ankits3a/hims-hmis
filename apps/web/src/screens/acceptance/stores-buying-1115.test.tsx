import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresBuying } from "../stores-buying";
import type { WireAward, WireBuyingDesk, WireComparative, WireStoresPoSheet } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1115, spec docs/specs/1115-stores-buying-desk.md (owner APPROVED 2026-11-19, decision 0100): the
 * web half of S5b, D19 and D20. The buying desk at 1366 × 768 shows its six tabs, and a comparative of 3 suppliers × 10
 * lines fits with no sideways scroll (jsdom has no layout: the table is fixed-layout at 100 % width inside a box that
 * hides overflow, and every status is a word). At 390 px the owner opens an award or a PO from its notice and approves
 * in one tap on the sheet (the notice is the first), with value, band, supplier, L-rank and the reason when not L1.
 * A real-browser walk measures both (the PR's screenshots). The server half: apps/core/src/modules/stores/acceptance/
 * stores-s5b-1115.test.ts.
 */
type Call = { method: string; path: string };

const suppliers = ["v1", "v2", "v3"].map((id, i) => ({
  vendorId: id, name: `Supplier ${["One", "Two", "Three"][i]!}`, quoteId: `q${id}`, version: 1, kind: "quote" as const, late: false, admitted: false,
  technical: null, wholeRank: i + 1, paymentTermsDays: 30, deliveryDays: 7 + i, warrantyMonths: 12,
  totals: { grossPaise: 1_000_000, discountPaise: 0, taxablePaise: 1_000_000, gstPaise: 180_000, freightPaise: 0, otherPaise: 0, beforeGstPaise: 1_000_000, landedPaise: 1_180_000 + i * 10_000 },
}));
const COMPARATIVE: WireComparative = {
  rfqId: "r1", rfqNo: "RFQ2611100001", band: "B", equipment: false, sealed: false, received: 3, invited: 3, replyBy: "2026-11-12T06:30:00.000Z", reinvite: false,
  suppliers,
  lines: Array.from({ length: 10 }, (_, n) => ({
    itemId: `i${String(n)}`, itemName: `A long item name number ${String(n)} that would push a column wide`, baseUom: "piece", qtyBase: 10 + n,
    cells: suppliers.map((s, i) => ({ vendorId: s.vendorId, ratePaise: 10_000 + i, discountPaise: 0, taxablePaise: 100_000, gstPaise: 18_000, freightPaise: 0, otherPaise: 0, landedPaise: 118_000 + i, rank: i + 1 })),
  })),
};
const DESK: WireBuyingDesk = {
  can: { buy: true, approveAward: false, owner: false },
  buyNow: [{ prId: "p9", prNo: "MPR2611100009", priority: "urgent", department: { id: "d1", code: "ICU", name: "ICU" }, band: "A", estimatePaise: 300_000, status: "approved", lines: [{ prId: "p9", lineIdx: 0, itemId: "i1", itemName: "Suction pump", qtyBase: 1, baseUom: "piece", estimatePaise: 300_000, groupId: null }] }],
  groupable: [], groups: [],
  rfqs: [{ id: "r1", rfqNo: "RFQ2611100001", groupId: "g1", band: "B", equipment: false, status: "compared", replyBy: "2026-11-12T06:30:00.000Z", deliveryDate: "2026-11-30", invitees: [], lines: [], sent: null, received: 3 }],
  awards: [], pos: [],
};
const AWARD: WireAward = {
  id: "a1", rfqId: "r1", rfqNo: "RFQ2611100001", groupId: "g1", band: "C", equipment: true, status: "proposed", reason: "L1 failed the demo",
  proposedBy: { id: "u2", name: "Buyer" }, proposedAt: "2026-11-12T06:30:00.000Z", totalPaise: 12_390_000,
  lines: [{ itemId: "i1", itemName: "Patient monitor", qtyBase: 1, vendorId: "v2", vendorName: "Supplier Two", ratePaise: 10_500_000, landedPaise: 12_390_000, rank: 2 }],
  seats: [{ seat: "materials_head", holders: [{ id: "u3", name: "Head" }], signedBy: { id: "u3", name: "Head" }, onBehalfOf: null, at: "2026-11-12T07:00:00.000Z", kind: "sign" }],
  ownerSigned: false, mine: { seat: "owner", canSign: true }, poIds: [],
};
const PO_SHEET: WireStoresPoSheet = {
  poId: "po1", poNo: "PO2611100001", status: "pending_approval", tier: "owner", totalPaise: 6_018_000, vendorName: "Supplier One", band: "B", rank: 1,
  reason: null, awardId: "a2", awardStatus: "approved", canApprove: true, canApproveBoth: false,
};

function mock(perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/stores/buying/desk") return json(DESK);
    if (path === "/stores/rfqs/r1/comparative") return json(COMPARATIVE);
    if (path === "/stores/awards/a1" && method === "GET") return json(AWARD);
    if (path === "/stores/awards/a1/approve") return json({ ...AWARD, status: "approved", ownerSigned: true });
    if (path === "/stores/buying/pos/po1" && method === "GET") return json(PO_SHEET);
    if (path === "/stores/buying/pos/po1/approve") return json({ ...PO_SHEET, status: "approved" });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the buying desk (spec #1115)", () => {
  it("spec #1115 D19: at 1366 × 768 the desk shows Buy now, Grouping, RFQs, Comparisons, Awards and POs; a 3 × 10 comparative fits with no sideways scroll; every status is a word", async () => {
    window.innerWidth = 1366;
    window.innerHeight = 768;
    mock(["stores.buying.manage"]);
    const user = userEvent.setup();
    renderWithRouter(<StoresBuying />);
    const tabs = await screen.findByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Buy now", "Grouping", "RFQs", "Comparisons", "Awards", "POs"]);
    // Buy now: the urgent request, its band and status as words.
    expect(await screen.findByText("MPR2611100009")).toBeInTheDocument();
    expect(screen.getByText("One quote")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: "Comparisons" }));
    await user.click(await screen.findByRole("button", { name: /RFQ2611100001/ }));
    const table = await screen.findByTestId("comparative-table");
    expect(table.style.tableLayout).toBe("fixed");
    expect(table.style.width).toBe("100%");
    const box = screen.getByTestId("comparative-box");
    expect(box.style.overflowX).toBe("hidden");
    expect(within(table).getAllByTestId(/^cmp-line-/)).toHaveLength(10);
    expect(within(table).getAllByRole("columnheader").filter((h) => /Supplier/.test(h.textContent ?? ""))).toHaveLength(3);
    expect(within(table).getAllByText("L1").length).toBeGreaterThanOrEqual(10);
    expect(screen.getByText("Compared")).toBeInTheDocument();
    const root = screen.getByTestId("stores-buying");
    expect(root.style.overflowX).toBe("hidden");
  });

  it("spec #1115 D20: at 390 px the owner opens an award and a PO from the notice and approves each in one tap with no sideways scroll; the sheet shows value, band, supplier, L-rank and the reason when not L1", async () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    let calls = mock([]);
    const user = userEvent.setup();
    const { unmount } = renderWithRouter(<StoresBuying />, "/stores/buying?award=a1");
    const sheet = await screen.findByTestId("approve-sheet");
    expect(sheet.style.overflowX).toBe("hidden");
    expect(sheet.style.maxWidth).toBe("100%");
    expect(within(sheet).getByText("₹1,23,900")).toBeInTheDocument();
    expect(within(sheet).getByText("Committee")).toBeInTheDocument();
    expect(within(sheet).getByText("Supplier Two")).toBeInTheDocument();
    expect(within(sheet).getByText("L2")).toBeInTheDocument();
    expect(within(sheet).getByText("L1 failed the demo")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Approve" }));
    expect(await within(sheet).findByText("Approved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/stores/awards/a1/approve"]);
    unmount();
    vi.unstubAllGlobals();

    calls = mock([]);
    renderWithRouter(<StoresBuying />, "/stores/buying?po=po1");
    const po = await screen.findByTestId("approve-sheet");
    expect(within(po).getByText("₹60,180")).toBeInTheDocument();
    expect(within(po).getByText("Three quotes")).toBeInTheDocument();
    expect(within(po).getByText("Supplier One")).toBeInTheDocument();
    expect(within(po).getByText("L1")).toBeInTheDocument();
    await user.click(within(po).getByRole("button", { name: "Approve" }));
    expect(await within(po).findByText("Approved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/stores/buying/pos/po1/approve"]);
  });
});
