import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresPaying } from "./stores-paying";
import { StoresServices } from "./stores-services";
import type { WireAuditFlag, WirePayingDesk, WireServiceEntryRow, WireTaxTables } from "@hmis/contracts";

/**
 * #1116 (S6c) — the paying desk's remaining screens: the CA's tables entered and signed on the Tax tab (who recorded the
 * signature is shown), the Tally ledger names, the MSME objections and the half-yearly dues report, the auditor's flags
 * (Upheld with one line, Dismiss with a reason; never offered to the flagged department's HOD), and the department's
 * reversing service entry. The server half: modules/stores/acceptance/stores-s6c-1116.test.ts and paying-s6c.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const DESK: WirePayingDesk = {
  can: { book: true, release: false, prepare: true, record: true, owner: false, export: true },
  toBook: [{ kind: "grn", id: "g1", no: "GRN-0001", vendorId: "v1", vendorName: "Supplier One", at: "2026-11-01T06:30:00.000Z", poNo: "PO-1" }],
  holds: [], due: [], runs: [], payments: [],
  settings: { version: 1, holdsCoverPharmacy: false, msmeRule: "as_today", outOfPatternMultipleBps: 20_000, firstBillLimitPaise: 10_000_000, tdsGoods: false, msmeTradersOnClock: true, setAt: null, setBy: null },
};
const TAX: WireTaxTables = {
  tds: null, gstCredit: null, canManage: true,
  drafts: [{
    id: "t1", kind: "tds", version: 1, documentRef: "ca-tds.pdf", createdBy: { id: "u1", name: "Accounts" }, createdAt: "2026-11-10T06:30:00.000Z", signed: null,
    rules: [{ nature: "contract", section: "contract work", rateBps: { individual: 100, other: 200 }, panMissingRateBps: 2_000, threshold: { kind: "bill", paise: 3_000_000 }, on: true, categoryCodes: ["HSK"] }],
  }],
};
const flag = (o: Partial<WireAuditFlag>): WireAuditFlag => ({
  id: "f1", kind: "split_po", text: "Split purchase: PO-1, PO-2 · one supplier, Housekeeping · 2 orders within 7 days", departments: [], night: "2026-11-10",
  cites: [{ type: "po", id: "p1", no: "PO-1" }, { type: "po", id: "p2", no: "PO-2" }], raisedAt: "2026-11-10T17:00:00.000Z", status: "open", stale: false,
  review: null, canReview: true, refusal: null, ...o,
});
const SHEET: WireServiceEntryRow = {
  id: "s1", sesNo: "SES-0001", purchaseOrderId: "po9", poNo: "PO-9", vendorId: "v2", vendorName: "Laundry Co", department: { id: "d1", code: "ICU", name: "ICU" },
  period: { kind: "month", key: "2026-10", start: "2026-10-01", end: "2026-10-31" }, source: "laundry_month", sourceRef: null, status: "confirmed", lines: [],
  confirmedBy: { id: "u3", name: "Incharge" }, confirmedAt: "2026-11-01T06:30:00.000Z", billNo: null, reversed: false, reversal: false,
};

function mock(over: Record<string, unknown> = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path in over) return json(over[path]);
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["materials.bills.manage", "stores.tax.manage"], scoped: { department: {}, floor: {} } } });
    if (path === "/stores/pay/desk") return json(DESK);
    if (path === "/stores/pay/tax-tables") return json(TAX);
    if (path === "/stores/pay/tax-tables/t1/sign") return json({ ...TAX.drafts[0], signed: { by: { id: "u1", name: "Accounts" }, at: "2026-11-10T07:00:00.000Z", documentRef: "signed.pdf" } });
    if (path === "/stores/pay/tds-certificates" && method === "GET") return json([]);
    if (path === "/stores/pay/suppliers") return json([{ id: "v1", code: "SUP1", name: "Supplier One" }]);
    if (path === "/stores/pay/tally-ledgers" && method === "GET") return json({ names: {}, needed: ["purchase:HSK"] });
    if (path === "/stores/pay/tally-ledgers") return json({ names: { "purchase:HSK": "Purchase — Housekeeping" }, needed: [] });
    if (path === "/stores/pay/by-group") return json({ asOf: "2026-11-10", totalPaise: 0, byGroup: [], byDepartment: [] });
    if (path === "/stores/pay/msme-objections" && method === "GET") return json([]);
    if (path === "/stores/pay/msme-objections") return json({ id: "o1" });
    if (path === "/stores/pay/msme-report") return json({ half: "2026-H2", from: "2026-10-01", to: "2027-03-31", asOf: "2026-11-10", totalPaise: 2_360_000, rows: [{ billId: "b1", billNo: "SB-1", vendorBillNo: "MC/2", vendorId: "v3", vendorName: "Micro Co", udyam: null, msmeClass: "micro", acceptanceDate: "2026-09-11", daysOutstanding: 60, outstandingPaise: 2_360_000 }] });
    if (path === "/stores/pay/flags") return json([flag({}), flag({ id: "f2", kind: "more_than_book", departments: [{ id: "d1", code: "ICU", name: "ICU" }], canReview: false, refusal: "hod_reviews_own" })]);
    if (path === "/stores/pay/flags/f1/review") return json(flag({ status: "upheld", canReview: false }));
    if (path === "/stores/pay/services/departments") return json([{ id: "d1", code: "ICU", name: "ICU" }]);
    if (path === "/stores/pay/services") return json([]);
    if (path === "/stores/pay/services/sheets") return json([SHEET]);
    if (path === "/stores/pay/services/s1/reverse") return json({ ...SHEET, id: "s2" });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.innerWidth = 1366; window.innerHeight = 768; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the paying desk's S6c screens (#1116)", () => {
  it("the Tax tab says TDS not checked while no table is signed, shows the draft and records the CA's signature with its document", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />);
    await user.click(await screen.findByRole("button", { name: "Tax" }));
    const tds = await screen.findByTestId("table-tds");
    expect(within(tds).getByText("TDS not checked")).toBeInTheDocument();
    const draft = within(tds).getByTestId("draft-t1");
    expect(within(draft).getByText("Not signed")).toBeInTheDocument();
    expect(within(draft).getByText("Contract or manpower")).toBeInTheDocument();
    await user.click(within(draft).getByRole("button", { name: "Record signature" }));
    await user.type(within(draft).getByLabelText("CA's signed document"), "ca-signed-2026.pdf");
    await user.click(within(draft).getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.path === "/stores/pay/tax-tables/t1/sign")?.body).toEqual({ documentRef: "ca-signed-2026.pdf" });
  });

  it("a new TDS version is entered row by row and saved as a draft with the CA's document", async () => {
    const calls = mock({ "/stores/pay/tax-tables": { ...TAX, drafts: [] } });
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />);
    await user.click(await screen.findByRole("button", { name: "Tax" }));
    const tds = await screen.findByTestId("table-tds");
    await user.click(within(tds).getByRole("button", { name: "New version" }));
    await user.click(within(tds).getByRole("button", { name: "Add row" }));
    await user.type(within(tds).getByLabelText("Section (as in the Act)"), "contract work");
    await user.clear(within(tds).getByLabelText("Others %"));
    await user.type(within(tds).getByLabelText("Others %"), "2");
    await user.type(within(tds).getByLabelText("Document"), "ca-tds-v1.pdf");
    await user.click(within(tds).getByRole("button", { name: "Save draft" }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/stores/pay/tax-tables");
    expect(post?.body).toMatchObject({ kind: "tds", documentRef: "ca-tds-v1.pdf", rules: [{ nature: "contract", section: "contract work", rateBps: { individual: 0, other: 200 } }] });
  });

  it("Exports names a missing Stores Tally ledger; Due raises an MSME objection on a GRN and lists the half-yearly dues", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />);
    await user.click(await screen.findByRole("tab", { name: "Exports" }));
    const led = await screen.findByTestId("tally-ledgers");
    expect(within(led).getByText("Name missing")).toBeInTheDocument();
    await user.type(within(led).getByLabelText("Purchase · HSK"), "Purchase — Housekeeping");
    await user.click(within(led).getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/stores/pay/tally-ledgers")?.body).toEqual({ names: { "purchase:HSK": "Purchase — Housekeeping" } });

    await user.click(screen.getByRole("tab", { name: "Due" }));
    const report = await screen.findByTestId("msme-report");
    expect(await within(report).findByText("SB-1")).toBeInTheDocument();
    expect(within(report).getByText("60 days")).toBeInTheDocument();
    const obj = screen.getByTestId("msme-objections");
    await user.selectOptions(within(obj).getByLabelText("GRN or service entry"), "grn:g1");
    await user.type(within(obj).getByLabelText("Reason"), "12 pieces torn");
    await user.click(within(obj).getByRole("button", { name: "Raise objection" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/stores/pay/msme-objections")?.body).toMatchObject({ grnId: "g1", kind: "qc_rejection", reason: "12 pieces torn" });
  });

  it("the auditor's flags: Upheld needs one line on what was done; the HOD of a flagged department is told another reviewer decides", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />, "/stores/pay?flags=1");
    const f1 = await screen.findByTestId("flag-f1");
    expect(within(f1).getByText("Split purchase")).toBeInTheDocument();
    expect(within(f1).getByText("PO-1")).toBeInTheDocument();
    const f2 = screen.getByTestId("flag-f2");
    expect(within(f2).getByText("Your department: another reviewer decides")).toBeInTheDocument();
    expect(within(f2).queryByRole("button", { name: "Upheld" })).toBeNull();
    await user.click(within(f1).getByRole("button", { name: "Upheld" }));
    const save = within(f1).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.type(within(f1).getByLabelText("What was done"), "PO tier rule explained to the buyer");
    await user.click(save);
    expect(calls.find((c) => c.path === "/stores/pay/flags/f1/review")?.body).toEqual({ verdict: "upheld", note: "PO tier rule explained to the buyer" });
  });

  it("at 390 px the department reverses an unbilled service entry with a reason", async () => {
    window.innerWidth = 390;
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresServices />);
    const sheet = await screen.findByTestId("sheet-s1");
    expect(within(sheet).getByText("Confirmed")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Reverse" }));
    await user.type(within(sheet).getByLabelText("Reason"), "linen count entered twice");
    await user.click(within(sheet).getByRole("button", { name: "Reverse" }));
    expect(calls.find((c) => c.path === "/stores/pay/services/s1/reverse")?.body).toEqual({ reason: "linen count entered twice" });
    expect(await within(sheet).findByText("Reversed")).toBeInTheDocument();
  });
});
