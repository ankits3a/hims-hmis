import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaterialsTransfers } from "./materials-transfers";
import type { WireIndent } from "../lib/indents-api";

type Reply = { status: number; body: unknown };
type Handler = unknown | ((init?: RequestInit) => unknown);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const out = typeof h === "function" ? (h as (i?: RequestInit) => unknown)(init) : h;
    const reply = (out !== null && typeof out === "object" && "status" in out && "body" in out) ? out as Reply : { status: 200, body: out };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const posted = (path: string): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).endsWith(path))
  .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
const asked = (fragment: string): boolean => vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(fragment));
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

const STORES = [
  { id: "s-main", code: "MAIN", name: "Main store", status: "active" },
  { id: "s-ward", code: "WARD-3", name: "Ward 3", status: "active" },
];
const GLOVES = {
  id: "i-glove", code: "GLOVE-M", name: "Examination gloves M", class: "consumable", formularyMedicineId: null, hsnCode: null, gstRateBps: 1200,
  baseUom: "piece", batchTracked: true, serialTracked: false, storageClass: "ambient", shelfLifeDays: null, abcClass: null, vedClass: null, active: true,
};
const ASKED: WireIndent = {
  id: "01INDENT00000000000000A001", indentNo: "MIN2609290001", status: "requested", note: "night shift",
  from: { id: "s-ward", code: "WARD-3", name: "Ward 3" }, to: { id: "s-main", code: "MAIN", name: "Main store" },
  requestedBy: { id: "u-n", name: "Sister Anita" }, requestedAt: "2026-09-29T04:30:00.000Z",
  decidedBy: null, decidedAt: null, rejectReason: null, cancelReason: null, transfer: null,
  lines: [
    { lineIdx: 0, itemId: "i-glove", itemCode: "GLOVE-M", itemName: "Examination gloves M", baseUom: "piece", qtyBase: 100, qtyIssued: null, available: 60 },
    { lineIdx: 1, itemId: "i-gauze", itemCode: "GAUZE-10", itemName: "Gauze 10 cm", baseUom: "roll", qtyBase: 10, qtyIssued: null, available: 0 },
  ],
};
const ISSUED: WireIndent = {
  ...ASKED, id: "01INDENT00000000000000B002", indentNo: "MIN2609280004", status: "issued", note: null,
  decidedBy: { id: "u-sk", name: "Suresh" }, decidedAt: "2026-09-28T09:00:00.000Z",
  transfer: { id: "01TRANSFER0000000000QRS456", ref: "TR-QRS456", status: "in_transit" },
  lines: [{ ...ASKED.lines[0]!, qtyIssued: 60, available: null }, { ...ASKED.lines[1]!, qtyIssued: 0, available: null }],
};
const REJECTED: WireIndent = {
  ...ASKED, id: "01INDENT00000000000000C003", indentNo: "MIN2609270002", status: "rejected", note: null,
  decidedBy: { id: "u-sk", name: "Suresh" }, decidedAt: "2026-09-27T09:00:00.000Z", rejectReason: "ward holds a week's stock",
  lines: ASKED.lines.map((l) => ({ ...l, available: null })),
};
const base = (hospital: string[], indents: WireIndent[]): Record<string, Handler> => ({
  "GET /api/auth/me": me(hospital),
  "GET /api/materials/stores": { stores: STORES },
  "GET /api/materials/transfers/worklist": { awaiting: [], recent: [] },
  "GET /api/materials/indents": { indents },
});

/** Pharmacy gap A6b — indents at the top of the transfers screen. */
describe("MaterialsTransfers — indents", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the supplying store issues an indent: each line starts at what was asked, the shelf is shown, and the quantities sent are the ones typed", async () => {
    let tries = 0;
    mockRoutes({
      ...base(["materials.stock.read", "materials.stock.issue"], [ASKED, ISSUED, REJECTED]),
      "POST /api/materials/indents/01INDENT00000000000000A001/issue": () => {
        tries += 1;
        return tries === 1
          ? { status: 409, body: { statusCode: 409, code: "insufficient_stock", message: "x" } }
          : { status: 201, body: { indent: { ...ASKED, status: "issued", transfer: { id: "01TRANSFER0000000000NEW001", ref: "TR-NEW001", status: "in_transit" } } } };
      },
    });
    renderWithProviders(<MaterialsTransfers />);
    const row = await screen.findByTestId("indent-MIN2609290001");
    expect(row).toHaveTextContent("Ward 3 → Main store");
    expect(row).toHaveTextContent("asked by Sister Anita at 10:00");
    expect(row).toHaveTextContent("GLOVE-M · 100 piece (60 on the shelf)");
    // The issuer does not hold the requesting side's grant: no Cancel, no Raise.
    expect(within(row).queryByRole("button", { name: "Cancel indent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Raise an indent" })).toBeNull();
    // Answered indents: the transfer, or the reason.
    expect(screen.getByTestId("answered-MIN2609280004")).toHaveTextContent("Issued · as TR-QRS456 · GLOVE-M 60 of 100, GAUZE-10 0 of 10");
    expect(screen.getByTestId("answered-MIN2609270002")).toHaveTextContent("Rejected · ward holds a week's stock");

    await userEvent.click(within(row).getByRole("button", { name: "Issue" }));
    const sheet = await screen.findByTestId("indent-issue");
    expect(sheet).toHaveAccessibleName("Issue MIN2609290001 to Ward 3");
    const gloves = within(sheet).getByRole("textbox", { name: "Issue, GLOVE-M" });
    const gauze = within(sheet).getByRole("textbox", { name: "Issue, GAUZE-10" });
    expect(gloves).toHaveValue("100");
    expect(gauze).toHaveValue("10");
    expect(within(sheet).getByTestId("issue-line-0")).toHaveTextContent("60");
    const submit = within(sheet).getByRole("button", { name: "Issue as a transfer" });
    await userEvent.clear(gloves);
    await userEvent.type(gloves, "101");
    expect(submit).toBeDisabled(); // more than asked
    await userEvent.clear(gloves);
    await userEvent.type(gloves, "0");
    await userEvent.clear(gauze);
    await userEvent.type(gauze, "0");
    expect(submit).toBeDisabled(); // nothing at all
    await userEvent.clear(gloves);
    await userEvent.type(gloves, "60");
    await userEvent.click(submit);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("There is not enough available stock");
    await userEvent.click(submit);
    expect(await screen.findByTestId("indent-done")).toHaveTextContent("MIN2609290001 issued as TR-NEW001. It is in transit until Ward 3 confirms it.");
    expect(screen.queryByTestId("indent-issue")).toBeNull();
    expect(posted("/indents/01INDENT00000000000000A001/issue")[1]).toEqual({ lines: [{ lineIdx: 0, qtyBase: 60 }, { lineIdx: 1, qtyBase: 0 }] });
  });

  it("rejects with a reason, in a sheet", async () => {
    mockRoutes({
      ...base(["materials.stock.read", "materials.stock.issue"], [ASKED]),
      "POST /api/materials/indents/01INDENT00000000000000A001/reject": { status: 201, body: { indent: { ...REJECTED, indentNo: "MIN2609290001" } } },
    });
    renderWithProviders(<MaterialsTransfers />);
    const row = await screen.findByTestId("indent-MIN2609290001");
    await userEvent.click(within(row).getByRole("button", { name: "Reject" }));
    const sheet = await screen.findByTestId("indent-reject");
    const go = within(sheet).getByRole("button", { name: "Reject" });
    expect(go).toBeDisabled();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Reason" }), "ward holds a week's stock");
    await userEvent.click(go);
    expect(await screen.findByTestId("indent-done")).toHaveTextContent("MIN2609290001 rejected.");
    expect(posted("/indents/01INDENT00000000000000A001/reject")).toEqual([{ reason: "ward holds a week's stock" }]);
  });

  it("the requester raises an indent in a sheet and cancels one — no Issue or Reject without the supplying grant", async () => {
    mockRoutes({
      ...base(["materials.stock.read", "materials.stock.receive"], [ASKED]),
      "GET /api/materials/items": { items: [GLOVES] },
      "POST /api/materials/indents": { status: 201, body: { indent: { ...ASKED, indentNo: "MIN2609290002" } } },
      "POST /api/materials/indents/01INDENT00000000000000A001/cancel": { status: 201, body: { indent: { ...ASKED, status: "cancelled", cancelReason: "raised twice" } } },
    });
    renderWithProviders(<MaterialsTransfers />);
    const row = await screen.findByTestId("indent-MIN2609290001");
    expect(within(row).queryByRole("button", { name: "Issue" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Reject" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Raise an indent" }));
    const sheet = await screen.findByTestId("indent-raise");
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Requesting store" }), "s-ward");
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Supplying store" }), "s-main");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Item name or code" }), "glove");
    await userEvent.click(within(sheet).getByRole("button", { name: "Find" }));
    await userEvent.click(await within(sheet).findByRole("button", { name: "Add" }));
    const send = within(sheet).getByRole("button", { name: "Send indent" });
    expect(send).toBeDisabled();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Quantity, GLOVE-M" }), "50");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Note" }), "night shift");
    await userEvent.click(send);
    expect(await screen.findByTestId("indent-done")).toHaveTextContent("MIN2609290002 sent to Main store.");
    expect(posted("/materials/indents")).toEqual([{ fromResourceId: "s-ward", toResourceId: "s-main", note: "night shift", lines: [{ itemId: "i-glove", qtyBase: 50 }] }]);

    await userEvent.click(within(screen.getByTestId("indent-MIN2609290001")).getByRole("button", { name: "Cancel indent" }));
    const cancel = await screen.findByTestId("indent-cancel");
    await userEvent.type(within(cancel).getByRole("textbox", { name: "Reason" }), "raised twice");
    await userEvent.click(within(cancel).getByRole("button", { name: "Cancel indent" }));
    expect(await screen.findByTestId("indent-done")).toHaveTextContent("MIN2609290001 cancelled.");
    expect(posted("/indents/01INDENT00000000000000A001/cancel")).toEqual([{ reason: "raised twice" }]);
  });

  it("narrows the indents to the chosen store, and says when none is waiting", async () => {
    mockRoutes(base(["materials.stock.read"], []));
    renderWithProviders(<MaterialsTransfers />);
    expect(await screen.findByText("No indent is waiting.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Store" }), "s-ward");
    await waitFor(() => { expect(asked("/api/materials/indents?storeId=s-ward")).toBe(true); });
  });
});
