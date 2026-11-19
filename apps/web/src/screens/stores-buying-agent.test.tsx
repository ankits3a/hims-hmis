import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresBuying } from "./stores-buying";
import type { WireAgentProposal, WireBuyException, WireBuyingDesk, WireStoresPoSheet } from "@hmis/contracts";

/**
 * #1115 (S5c) — the buyer agent's drafts on the buying desk wait for a person's tap: the night's groups (Make group /
 * Not this), a quote read from a PDF (each line with the page and the line of text it came from; Confirm line), the
 * single-source sheet's one tap, and the owner's advance on the PO sheet. The server half: modules/stores/acceptance/
 * stores-s5c-1115.test.ts and modules/stores/buyer-agent.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const line = (o: Partial<WireAgentProposal["lines"][number]>): WireAgentProposal["lines"][number] => ({
  lineIdx: 0, prId: "p1", itemId: "i1", itemName: "Visitor chair", qtyBase: 2, baseUom: "piece", estimatePaise: 800_000, vendorId: null, ratePaise: null,
  discountBps: null, gstRateBps: null, source: null, state: "draft", ...o,
});
const proposal = (o: Partial<WireAgentProposal>): WireAgentProposal => ({
  id: "pr1", kind: "grouping", status: "open", madeAt: "2026-11-10T16:30:00.000Z", byAgent: true, label: "Furniture · Supplier One", band: "A", estimatePaise: 800_000,
  departments: [{ id: "d1", name: "ICU" }], groupId: null, rfqId: null, vendorId: null, vendorName: null, lines: [line({})], suppliers: [], replyBy: null,
  deliveryDate: null, readable: null, reader: null, hasDocument: false, closed: null, ...o,
});
const READ = proposal({
  id: "qr1", kind: "quote_read", label: null, band: null, rfqId: "r1", vendorId: "v1", vendorName: "Supplier One", readable: true, reader: "model", hasDocument: true,
  lines: [line({ prId: null, itemName: "Label printer", ratePaise: 1_450_000, discountBps: 500, gstRateBps: 1800, source: { page: 1, text: "Label printer Qty 2 Rate 14500.00 Disc 5% GST 18%" } })],
});
const DESK: WireBuyingDesk = {
  can: { buy: true, approveAward: false, owner: false }, buyNow: [], groupable: [], groups: [], rfqs: [], awards: [], pos: [],
  proposals: [proposal({}), READ], exceptions: [],
};
const EXC: WireBuyException = {
  id: "e1", kind: "single_source", groupId: "g1", vendorId: "v1", vendorName: "Supplier One", reason: "Only the maker's spare fits", valuePaise: 3_000_000,
  needsOwner: false, status: "waiting_certificate", raisedBy: { id: "u2", name: "Buyer" }, raisedAt: "2026-11-10T06:30:00.000Z", steps: [], confirmBy: null, mine: "certify",
};
const PO: WireStoresPoSheet = {
  poId: "po1", poNo: "PO2611100001", status: "approved", tier: "head", totalPaise: 1_062_000, vendorName: "Supplier One", band: "C", rank: null, reason: "Single source: maker's module",
  awardId: "a1", awardStatus: "approved", canApprove: false, canApproveBoth: false, payTerms: { kind: "after_grn" },
  advance: {
    id: "ad1", poId: "po1", pctBps: 3000, amountPaise: 318_600, guaranteeNo: "BG-1", guaranteeBank: "A bank", guaranteeValidTo: "2027-06-30", guaranteePaise: 1_000_000,
    status: "requested", requestedBy: { id: "u2", name: "Buyer" }, requestedAt: "2026-11-10T06:30:00.000Z", decidedBy: null, decidedAt: null, reason: null,
  },
};

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["stores.buying.manage"], scoped: { department: {}, floor: {} } } });
    if (path === "/stores/buying/desk") return json(DESK);
    if (path === "/stores/agent/drafts/pr1/group") return json({ group: { id: "g9" }, actId: "act1" });
    if (path === "/stores/agent/drafts/qr1" && method === "GET") return json(READ);
    if (path === "/stores/agent/drafts/qr1/pdf") return json({ pdfBase64: "JVBERi0xLjQK" });
    if (path === "/stores/agent/drafts/qr1/lines") return json({ proposal: { ...READ, status: "confirmed" }, quote: { id: "q1" } });
    if (path === "/stores/buying/exceptions/e1" && method === "GET") return json(EXC);
    if (path === "/stores/buying/exceptions/e1/sign") return json({ ...EXC, status: "waiting_approval", mine: null });
    if (path === "/stores/buying/pos/po1" && method === "GET") return json(PO);
    if (path === "/stores/buying/advances/ad1/decide") return json({ ...PO.advance, status: "approved" });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.innerWidth = 1366; window.innerHeight = 768; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the buyer agent on the buying desk (#1115 S5c)", () => {
  it("the night's groups wait for Make group: the tap is the only write, and the screen says nothing was sent", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresBuying />);
    await user.click(await screen.findByRole("tab", { name: "Grouping" }));
    const box = await screen.findByTestId("agent-groups");
    expect(within(box).getByText("Drafted at night. Nothing sent or ordered.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    await user.click(within(screen.getByTestId("agent-group-pr1")).getByRole("button", { name: "Make group" }));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/stores/agent/drafts/pr1/group"]);
  });

  it("a quote read from a PDF shows each line's source and is entered only by Confirm line, with the numbers the person confirms", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresBuying />);
    await user.click(await screen.findByRole("tab", { name: "RFQs" }));
    await user.click(within(await screen.findByTestId("quote-reads")).getByRole("button", { name: "Open" }));
    const src = await screen.findByTestId("read-source-0");
    expect(src).toHaveTextContent("Page 1: Label printer Qty 2 Rate 14500.00 Disc 5% GST 18%");
    const rate = within(screen.getByTestId("read-line-0")).getByPlaceholderText(/Rate/);
    await user.clear(rate);
    await user.type(rate, "14400");
    await user.click(within(screen.getByTestId("read-line-0")).getByRole("button", { name: "Confirm line" }));
    const post = calls.find((c) => c.path === "/stores/agent/drafts/qr1/lines");
    expect(post?.body).toEqual({ lineIdx: 0, ratePaise: 1_440_000, discountBps: 500, gstRateBps: 1800 });
  });

  it("at 390 px the HOD certifies a single-source purchase from its notice in one tap", async () => {
    window.innerWidth = 390;
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresBuying />, "/stores/buying?exception=e1");
    const sheet = await screen.findByTestId("exception-sheet");
    expect(within(sheet).getByText("Only the maker's spare fits")).toBeInTheDocument();
    expect(within(sheet).getByText("Certificate due")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Certify" }));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/stores/buying/exceptions/e1/sign"]);
    expect(await within(sheet).findByText("Approval due")).toBeInTheDocument();
  });

  it("the owner approves an equipment advance on the PO sheet: percent, amount and the bank guarantee are shown; pay after GRN until then", async () => {
    window.innerWidth = 390;
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresBuying />, "/stores/buying?po=po1");
    const box = await screen.findByTestId("advance-decision");
    expect(screen.getByText("Pay after GRN")).toBeInTheDocument();
    expect(within(box).getByText(/BG-1 · A bank/)).toBeInTheDocument();
    await user.click(within(box).getByRole("button", { name: "Approve advance" }));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/stores/buying/advances/ad1/decide"]);
  });
});
