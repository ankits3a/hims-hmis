import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouterState } from "@tanstack/react-router";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StockLedgerPage } from "./ledger";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireLedgerRow, WireStockLedger } from "../../lib/stock-ledger-api";

/**
 * GAP-CLOSURE A5 — Stock → Stock ledger: "where did these 50 strips go". `GET /materials/stock/movements`
 * had no screen. One item, optionally a store, a batch and dates → the opening balance, every movement
 * with its running balance, who and the document, the closing balance; CSV of what is on screen.
 */
type Call = { method: string; path: string };

function mock(routes: Record<string, unknown>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path: raw.includes("?") ? `${path}?${raw.split("?")[1]!}` : path });
    const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/office/needs") return json({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } });
    const key = `${method} ${path}`;
    return key in routes ? json(routes[key]) : new Response("{}", { status: 404 });
  }));
  return calls;
}

const row = (over: Partial<WireLedgerRow>): WireLedgerRow => ({
  seq: 1, occurredAt: "2026-09-24T00:00:00.000Z", kind: "grn", reason: "grn", refType: "grn", refId: "g-1", docNo: "GRN2609240001", link: { kind: "grn" },
  storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", batchId: "b-1", batchNo: "CR-1", expiryDate: "2027-06-30",
  qtyIn: 0, qtyOut: 0, balance: 0, actorId: "u-ph", actorName: "Pharm One", ...over,
});
const ledger: WireStockLedger = {
  item: { id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", pack: { uom: "strip", multiplier: 10 } },
  storeResourceId: null, batchId: null, from: null, to: null, opening: 0, totalIn: 500, totalOut: 500, closing: 0, truncated: false,
  batches: [{ id: "b-1", batchNo: "CR-1", expiryDate: "2027-06-30" }],
  rows: [
    row({ seq: 1, qtyIn: 500, balance: 500 }),
    row({ seq: 2, occurredAt: "2026-09-25T06:10:00.000Z", kind: "dispense", reason: "consume", refType: "pharmacy_dispense", refId: "d-1", docNo: null, link: null, qtyOut: 300, balance: 200 }),
    row({ seq: 3, occurredAt: "2026-09-26T09:00:00.000Z", kind: "transfer_out", reason: "issue", refType: "transfer", refId: "t-1", docNo: null, link: { kind: "transfer" }, qtyOut: 150, balance: 50, actorName: "Store Keeper" }),
    row({ seq: 4, occurredAt: "2026-09-28T08:00:00.000Z", kind: "supplier_return", reason: "return", refType: "supplier_return", refId: "rl-1", docNo: "MDN2609280001", link: { kind: "return", id: "ret-1" }, qtyOut: 50, balance: 0 }),
  ],
};
const EMPTY_RETURNS = {
  expiring: { expired: 0, d30: 0, d60: 0, d90: 0, expiredValuePaise: 0, d30ValuePaise: 0, d60ValuePaise: 0, d90ValuePaise: 0 },
  plan: { vendors: 0, lines: 0, taxablePaise: 0, toDestroy: 0, toDestroyValuePaise: 0 },
  drafts: [], toDispatch: [], awaitingCredit: [], writeOffsAwaiting: [], writeOffsToPost: [], openRecalls: [], creditPaise: 0,
};

function Where(): React.ReactElement {
  const at = useRouterState({ select: (s) => `${s.location.pathname}${s.location.searchStr}` });
  return <output data-testid="where">{at}</output>;
}

describe("the stock ledger — where it went (gap-closure A5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("an item picked from the keyboard: opening, each movement with its running balance, who and the document; closing", async () => {
    const calls = mock({
      "GET /materials/stores": { stores: [{ id: "s-opd", code: "PHARM-OPD", name: "OPD pharmacy", status: "active" }] },
      "GET /materials/stock/ledger/items": { items: [{ id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet" }] },
      "GET /materials/stock/ledger": ledger,
    }, ["materials.stock.read"]);
    const opened: unknown[] = [];
    renderWithRouter(<StockLedgerPage onOpen={(l) => opened.push(l)} />);
    expect(await screen.findByTestId("ledger-empty")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("ledger-item-search")).toHaveFocus());
    await userEvent.keyboard("croc");
    await screen.findByTestId("ledger-item-CROC500");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByTestId("ledger-item-picked")).toHaveTextContent("Crocin 500 tablet");
    const rows = await screen.findByTestId("ledger-rows");
    expect(calls.some((c) => c.path === "/materials/stock/ledger?itemId=i-croc")).toBe(true);
    expect(within(rows).getByTestId("ledger-opening")).toHaveTextContent("Opening balance");
    expect(within(rows).getByTestId("ledger-row-1")).toHaveTextContent("GRN in");
    expect(within(rows).getByTestId("ledger-row-1")).toHaveTextContent("+500");
    expect(within(rows).getByTestId("ledger-row-2")).toHaveTextContent("Dispensed");
    expect(within(rows).getByTestId("ledger-row-2")).toHaveTextContent("−300");
    expect(within(rows).getByTestId("ledger-row-2")).toHaveTextContent("200");
    expect(within(rows).getByTestId("ledger-row-3")).toHaveTextContent("Store Keeper");
    expect(within(rows).getByTestId("ledger-row-4")).toHaveTextContent("Returned to supplier");
    expect(within(rows).getByTestId("ledger-closing")).toHaveTextContent("−500");
    expect(screen.getByTestId("ledger-sum-in")).toHaveTextContent("+50 strip");
    expect(screen.getByTestId("ledger-sum-closing")).toHaveTextContent("0 tablet");
    // The document opens where the office keeps it; a dispense has no document link.
    await userEvent.click(within(rows).getByTestId("ledger-doc-4"));
    expect(opened).toEqual([{ kind: "return", id: "ret-1" }]);
    expect(within(rows).queryByTestId("ledger-doc-2")).toBeNull();
    // Store, batch and dates narrow the question.
    await userEvent.selectOptions(screen.getByTestId("ledger-store"), "s-opd");
    await userEvent.selectOptions(screen.getByTestId("ledger-batch"), "b-1");
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/stock/ledger?itemId=i-croc&resourceId=s-opd&batchId=b-1")).toBe(true));
    await userEvent.type(screen.getByTestId("ledger-from"), "2026-09-25");
    await userEvent.type(screen.getByTestId("ledger-to"), "2026-09-20");
    expect(await screen.findByRole("alert")).toHaveTextContent("The from date comes on or before the to date.");
  });

  it("X exports the statement as CSV: the opening row, every movement, the closing row", async () => {
    mock({
      "GET /materials/stores": { stores: [] },
      "GET /materials/stock/ledger/items": { items: [{ id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet" }] },
      "GET /materials/stock/ledger": ledger,
    }, ["materials.stock.read"]);
    const made: Blob[] = [];
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithRouter(<StockLedgerPage />);
    await userEvent.type(await screen.findByTestId("ledger-item-search"), "croc");
    await userEvent.click(await screen.findByTestId("ledger-item-CROC500"));
    await screen.findByTestId("ledger-rows");
    screen.getByTestId("stock-ledger").focus();
    await userEvent.keyboard("x");
    await waitFor(() => expect(made).toHaveLength(1));
    URL.createObjectURL = real.create;
    URL.revokeObjectURL = real.revoke;
    click.mockRestore();
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(made[0]!); });
    const lines = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Date,Time,Kind,Document,Store,Batch,Expiry,In (tablet),Out (tablet),Balance (tablet),By");
    expect(lines[1]).toContain("Opening balance");
    expect(lines[2]).toContain("GRN in,GRN2609240001,PHARM-OPD,CR-1,2027-06-30,500,,500,Pharm One");
    expect(lines[5]).toContain("Returned to supplier,MDN2609280001");
    expect(lines[6]).toContain("Closing balance");
    expect(lines).toHaveLength(7);
  });

  it("is Stock → Stock ledger in the office menu; a return's number opens its sheet on the Returns side", async () => {
    mock({
      "GET /materials/stores": { stores: [] },
      "GET /materials/stock/ledger/items": { items: [{ id: "i-croc", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet" }] },
      "GET /materials/stock/ledger": ledger,
      "GET /pharmacy/office/returns": EMPTY_RETURNS,
      "GET /materials/supplier-returns/ret-1": { return: {
        id: "ret-1", returnNo: "MRT2609280001", status: "dispatched", source: "manual", vendorId: "v-acme", vendorCode: "ACME", vendorName: "Acme Distributors",
        recallId: null, lineCount: 0, interState: false, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0, creditedPaise: 0,
        debitNoteNo: "MDN2609280001", debitNoteDate: "2026-09-28", createdBy: "u-ph", createdAt: "2026-09-28T05:00:00Z", approvedBy: "u-head", approvedAt: null,
        dispatchedBy: "u-1", dispatchedAt: null, note: null, vendorGstin: null, closeReason: null, cancelReason: null, recallNo: null, names: {}, lines: [], credit: null,
      } },
    }, ["materials.stock.read", "materials.returns.manage"]);
    renderWithRouter(<><PharmacyOffice /><Where /></>, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-stock"));
    const drop = await screen.findByTestId("office-drop-stock");
    expect(within(drop).getByTestId("office-entry-ledger")).toHaveTextContent("Stock ledger — where it went");
    await userEvent.click(within(drop).getByTestId("office-entry-ledger"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pharmacy/office?view=stock&page=ledger"));
    const frame = screen.getByTestId("office-page-stock");
    expect(within(frame).getByRole("heading", { level: 1, name: "Stock ledger — where it went" })).toBeInTheDocument();
    await userEvent.type(within(frame).getByTestId("ledger-item-search"), "croc");
    await userEvent.click(await within(frame).findByTestId("ledger-item-CROC500"));
    await userEvent.click(await within(frame).findByTestId("ledger-doc-4"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/pharmacy/office?view=returns&page=returns"));
    expect(await screen.findByTestId("return-sheet")).toBeInTheDocument();
  });
});
