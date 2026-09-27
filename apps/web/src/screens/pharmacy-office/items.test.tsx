import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { ItemsView } from "./items";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireMergePreview, WireMergeSummary, WireOfficeItems } from "../../lib/item-merge-api";

/**
 * PHARMACY P6 (hygiene) — the office's items side: the agent's possible duplicates open the merge sheet
 * (A and B side by side, what moves, what stays, "not undone"), a reason submits it for the medical
 * superintendent's approval, S swaps which one stays, a refusal says why and submits nothing, and an
 * approved merge is carried out with M.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") && method === "GET" ? `${path}?${raw.split("?")[1]!}` : path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-head" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const HEAD = ["materials.items.merge", "materials.items.read", "materials.stock.read"];
const A = { id: "i-a", code: "CROC500", name: "Crocin 500 tablet" };
const B = { id: "i-b", code: "CROC500X", name: "Crocin 500 tab" };

const side = (x: typeof A, over: Partial<WireMergePreview["survivor"]> = {}): WireMergePreview["survivor"] => ({
  ...x, itemClass: "drug", baseUom: "tablet", active: true, mergedIntoItemId: null,
  medicine: { id: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet" }, controlled: false,
  packs: [{ uom: "tablet", multiplier: 1 }, { uom: "strip", multiplier: 10 }], onHandBase: 50, barcodes: [], ...over,
});

const preview = (over: Partial<WireMergePreview> = {}): WireMergePreview => ({
  survivor: side(A), merged: side(B, { onHandBase: 30, barcodes: ["8901234567890"] }), refusals: [],
  stock: [{ storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", batchId: "b-1", batchNo: "CR-B", expiryDate: "2027-03-31", ownership: "owned", qtyBase: 30, into: "new_batch" }],
  moves: [
    { key: "stock", count: 30, detail: ["CR-B"] }, { key: "orderLines", count: 1, detail: ["MPO2609250001 · 4 strip"] }, { key: "barcodes", count: 1, detail: ["8901234567890"] },
    { key: "saleItemRetired", count: 1, detail: [] }, { key: "shelf", count: 1, detail: ["R-7"] },
  ],
  stays: [{ key: "ledgerRows", count: 3, detail: [] }, { key: "dispenseLines", count: 2, detail: [] }],
  irreversible: true, ...over,
});

const summary = (over: Partial<WireMergeSummary> = {}): WireMergeSummary => ({
  id: "mg-1", status: "requested", source: "agent", reason: "registered twice", survivor: A, merged: B, approvalId: "ap-1", approvalStatus: "pending",
  requestedBy: "u-head", requestedAt: "2026-09-26T05:00:00Z", mergedBy: null, mergedAt: null, ...over,
});

const office = (over: Partial<WireOfficeItems> = {}): WireOfficeItems => ({
  duplicates: [{ why: "same_medicine", itemClass: "drug", survivor: { ...A, onHandBase: 50 }, merged: { ...B, onHandBase: 30 } }],
  scanned: 412, awaitingApproval: [], readyToMerge: [], recent: [], ...over,
});

describe("the office's items side (pharmacy P6 hygiene)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("the office opens on the items side for the materials head who holds only the merge grant", async () => {
    mock({ "GET /pharmacy/office/items": office() }, ["materials.items.merge"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=items");
    expect(await screen.findByTestId("items-view")).toBeTruthy();
    expect(await screen.findByTestId("items-agent")).toHaveTextContent("1 pair looks like one item registered twice (412 items checked)");
  });

  it("a duplicate opens the merge sheet — A and B side by side, what moves, what stays, not undone — and a reason submits it for approval", async () => {
    const calls = mock({
      "GET /pharmacy/office/items": office(),
      "GET /pharmacy/office/item-merges/preview": preview(),
      "POST /pharmacy/office/item-merges": { merge: summary() },
    }, HEAD);
    renderWithRouter(<ItemsView />);
    await userEvent.click(within(await screen.findByTestId("items-section-duplicates")).getByTestId("dup-row-CROC500X"));
    const sheet = await screen.findByTestId("merge-sheet");
    expect(await within(sheet).findByTestId("side-stays")).toHaveTextContent("CROC500");
    expect(within(sheet).getByTestId("side-retired")).toHaveTextContent("8901234567890");
    expect(within(sheet).getByTestId("merge-stock")).toHaveTextContent("CR-B");
    expect(within(sheet).getByTestId("move-orderLines")).toHaveTextContent("1 open purchase-order line — MPO2609250001 · 4 strip");
    expect(within(sheet).getByTestId("move-saleItemRetired")).toHaveTextContent("B's sale registration is retired");
    expect(within(sheet).getByTestId("merge-stays")).toHaveTextContent("3 stock ledger rows");
    expect(within(sheet).getByTestId("merge-irreversible")).toHaveTextContent("A merge is not undone");
    expect(calls.some((c) => c.path === "/pharmacy/office/item-merges/preview?survivorItemId=i-a&mergedItemId=i-b")).toBe(true);

    await userEvent.type(within(sheet).getByLabelText(/Why these are one item/), "the same strip registered twice{Enter}");
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/pharmacy/office/item-merges")?.body).toEqual({
      survivorItemId: "i-a", mergedItemId: "i-b", reason: "the same strip registered twice", source: "agent",
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent to the medical superintendent");
  });

  it("S swaps which one stays", async () => {
    const calls = mock({ "GET /pharmacy/office/items": office(), "GET /pharmacy/office/item-merges/preview": preview() }, HEAD);
    renderWithRouter(<ItemsView />);
    await userEvent.click(await screen.findByTestId("dup-row-CROC500X"));
    const sheet = await screen.findByTestId("merge-sheet");
    await within(sheet).findByTestId("side-stays");
    sheet.focus();
    await userEvent.keyboard("s");
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/item-merges/preview?survivorItemId=i-b&mergedItemId=i-a")).toBe(true));
  });

  it("a refusal says why — not one thing, or open work to finish — and nothing can be submitted", async () => {
    const calls = mock({
      "GET /pharmacy/office/items": office(),
      "GET /pharmacy/office/item-merges/preview": preview({ refusals: [
        { rule: "different_drug", message: "CROC500X stocks Dolo 650 and CROC500 Crocin 500 — not the same medicine", ref: null },
        { rule: "open_dispense", message: "dispense P2609260004 is verified with a line on it — hand it over or cancel it first", ref: "P2609260004" },
      ] }),
    }, HEAD);
    renderWithRouter(<ItemsView />);
    await userEvent.click(await screen.findByTestId("dup-row-CROC500X"));
    const sheet = await screen.findByTestId("merge-sheet");
    expect(await within(sheet).findByTestId("merge-invalid")).toHaveTextContent("not the same medicine");
    expect(within(sheet).getByTestId("merge-blocked")).toHaveTextContent("P2609260004");
    expect(within(sheet).getByRole("button", { name: "Submit for approval" })).toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a merge waiting on the MS says so; an approved one is carried out with M", async () => {
    const calls = mock({
      "GET /pharmacy/office/items": office({ duplicates: [], awaitingApproval: [summary({ id: "mg-0", merged: { id: "i-c", code: "CROC500Y", name: "Crocin" } })], readyToMerge: [summary({ approvalStatus: "granted" })] }),
      "GET /pharmacy/office/item-merges/preview": preview(),
      "GET /pharmacy/office/item-merges/mg-1": { merge: { ...summary({ approvalStatus: "granted" }), names: {}, approval: { status: "granted", approverRole: "medical_superintendent", decidedBy: "u-ms", decisionNote: "same strip" }, moved: null } },
      "POST /pharmacy/office/item-merges/mg-1/merge": { merge: { ...summary({ status: "merged" }), names: { "u-head": "Head" }, approval: null, moved: { unitsMoved: 30 } } },
    }, HEAD);
    renderWithRouter(<ItemsView />);
    expect(within(await screen.findByTestId("items-section-awaiting")).getByTestId("merge-row-CROC500Y")).toHaveTextContent("Waiting on the MS");
    await userEvent.click(within(screen.getByTestId("items-section-ready")).getByTestId("merge-row-CROC500X"));
    const sheet = await screen.findByTestId("merge-sheet");
    expect(await within(sheet).findByText(/same strip/)).toBeTruthy();
    await within(sheet).findByRole("button", { name: /Merge now/ });
    sheet.focus();
    await userEvent.keyboard("m");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pharmacy/office/item-merges/mg-1/merge")).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent("Merged.");
  });
});
