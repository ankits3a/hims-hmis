import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { ReturnsView } from "./returns";
import type { WireOfficeReturns, WireReturn, WireReturnableBatch, WireReturnableVendor } from "../../lib/returns-api";

/**
 * GAP-CLOSURE A5 — a person's return to the supplier from the office, and a draft's lines edited.
 * `POST` and `PATCH /materials/supplier-returns` existed with no screen: only the agent's expiry drafts
 * and recall returns could be made, and a draft's lines could not be changed. N opens the new-return
 * sheet; E on a draft edits its lines until it is approved; the server's refusals read as the rule.
 */
type Call = { method: string; path: string; body: unknown };
type Answer = unknown | ((body: unknown) => unknown) | { __status: number; body: unknown };

function mock(routes: Record<string, Answer>, perms: string[], me = "u-ph"): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") ? `${path}?${raw.split("?")[1]!}` : path, body });
    const json = (status: number, v: unknown): Response => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json(200, { actor: { type: "user", id: me }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    if (out !== null && typeof out === "object" && "__status" in out) {
      const e = out as unknown as { __status: number; body: unknown };
      return json(e.__status, e.body);
    }
    return json(200, out);
  }));
  return calls;
}

const PHARMACIST = ["materials.stock.read", "materials.returns.manage"];
const office: WireOfficeReturns = {
  expiring: { expired: 0, d30: 0, d60: 0, d90: 0, expiredValuePaise: 0, d30ValuePaise: 0, d60ValuePaise: 0, d90ValuePaise: 0 },
  plan: { vendors: 0, lines: 0, taxablePaise: 0, toDestroy: 0, toDestroyValuePaise: 0 },
  drafts: [], toDispatch: [], awaitingCredit: [], writeOffsAwaiting: [], writeOffsToPost: [], openRecalls: [], creditPaise: 0,
};
const vendors: WireReturnableVendor[] = [
  { vendorId: "v-acme", vendorCode: "ACME", vendorName: "Acme Distributors", gstin: "10AAACA1234A1Z5", batches: 3, windowDays: 90 },
];
const batch = (over: Partial<WireReturnableBatch> = {}): WireReturnableBatch => ({
  storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy", itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet",
  baseUom: "tablet", pack: { uom: "strip", multiplier: 10 }, batchId: "b-dmg", batchNo: "DMG-1", expiryDate: "2027-06-30", landedCostPaise: 250,
  onHand: 100, reserved: 0, frozen: 0, onOtherDocuments: 0, available: 100, recalled: false, reasons: ["damaged"], pastWindow: false, returnableUntil: "2027-09-28",
  ...over,
});
const held: WireReturnableBatch[] = [
  batch(),
  batch({ batchId: "b-odd", batchNo: "ODD-1", available: 20, onHand: 20 }),
  batch({ batchId: "b-old", batchNo: "OLD-1", expiryDate: "2026-01-31", reasons: [], pastWindow: true }),
];
const line = (batchNo: string, batchId: string, qtyBase: number, note: string | null = null): WireReturn["lines"][number] => ({
  id: `rl-${batchNo}`, itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", hsnCode: "30049099", baseUom: "tablet", pack: { uom: "strip", multiplier: 10 },
  batchId, batchNo, expiryDate: "2027-06-30", storeResourceId: "s-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy",
  reason: "damaged", qtyBase, ratePaise: 250, taxablePaise: qtyBase * 250, gstRateBps: 1200, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: qtyBase * 250,
  ledgerEntryId: null, note,
});
const ret = (over: Partial<WireReturn> = {}): WireReturn => ({
  id: "ret-9", returnNo: "MRT2609280009", status: "draft", source: "manual", vendorId: "v-acme", vendorCode: "ACME", vendorName: "Acme Distributors",
  recallId: null, lineCount: 2, interState: false, taxablePaise: 6_250, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 6_250, creditedPaise: 0,
  debitNoteNo: null, debitNoteDate: null, createdBy: "u-ph", createdAt: "2026-09-28T05:00:00Z", approvedBy: null, approvedAt: null, dispatchedBy: null, dispatchedAt: null,
  note: null, vendorGstin: "10AAACA1234A1Z5", closeReason: null, cancelReason: null, recallNo: null, names: { "u-ph": "Pharm One" },
  lines: [line("DMG-1", "b-dmg", 20, "crushed carton"), line("ODD-1", "b-odd", 5)], credit: null, ...over,
});

describe("a manual return to the supplier, and a draft's lines edited (gap-closure A5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("N opens the sheet: the supplier, its stock searched, a batch added in strips with its reason and note, saved as a draft", async () => {
    const calls = mock({
      "GET /pharmacy/office/returns": office,
      "GET /materials/supplier-returns/vendors": { vendors },
      "GET /materials/supplier-returns/returnable": { batches: held },
      "POST /materials/supplier-returns": { return: ret({ lines: [line("DMG-1", "b-dmg", 30, "crushed carton")] }) },
      "GET /materials/supplier-returns/ret-9": { return: ret({ lines: [line("DMG-1", "b-dmg", 30, "crushed carton")] }) },
    }, PHARMACIST);
    renderWithRouter(<ReturnsView />);
    const view = await screen.findByTestId("returns-view");
    await screen.findByTestId("returns-new");
    view.focus();
    await userEvent.keyboard("n");
    const sheet = await screen.findByTestId("new-return-sheet");
    await userEvent.selectOptions(await within(sheet).findByTestId("new-return-vendor"), "v-acme");
    expect(within(sheet).getByTestId("new-return-vendor-facts")).toHaveTextContent("GSTIN 10AAACA1234A1Z5");
    const save = within(sheet).getByTestId("new-return-save");
    expect(save).toBeDisabled(); // no lines yet
    await userEvent.type(within(sheet).getByLabelText("Add a batch"), "dmg");
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/supplier-returns/returnable?vendorId=v-acme&q=dmg")).toBe(true));
    // Past its window a batch is destroyed, not returned: it cannot be added.
    expect(await within(sheet).findByTestId("return-hit-OLD-1-PHARM-OPD")).toBeDisabled();
    await userEvent.click(within(sheet).getByTestId("return-hit-DMG-1-PHARM-OPD"));
    const row = await within(sheet).findByTestId("draft-line-DMG-1-PHARM-OPD");
    await waitFor(() => expect(within(row).getByLabelText("Quantity of batch DMG-1")).toHaveFocus());
    await userEvent.type(within(row).getByLabelText("Quantity of batch DMG-1"), "3");
    await userEvent.type(within(row).getByLabelText("Note for batch DMG-1"), "crushed carton");
    expect(row).toHaveTextContent("30 tablet");
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/materials/supplier-returns")?.body).toEqual({
      vendorId: "v-acme", note: null, lines: [{ batchId: "b-dmg", storeResourceId: "s-opd", qtyBase: 30, reason: "damaged", note: "crushed carton" }],
    }));
    // The draft opens on its own sheet, the approve → dispatch flow unchanged.
    const opened = await screen.findByTestId("return-sheet");
    expect(await within(opened).findByTestId("return-line-note-DMG-1")).toHaveTextContent("crushed carton");
    expect(screen.getByRole("status")).toHaveTextContent("MRT2609280009");
  });

  it("more than is free cannot be saved; the server's refusal reads as the rule that fired, with its numbers", async () => {
    const calls = mock({
      "GET /pharmacy/office/returns": office,
      "GET /materials/supplier-returns/vendors": { vendors },
      "GET /materials/supplier-returns/returnable": { batches: held },
      "POST /materials/supplier-returns": { __status: 409, body: { code: "insufficient_stock", message: "x", detail: { batchNo: "ODD-1", available: 12, required: 20 } } },
    }, PHARMACIST);
    renderWithRouter(<ReturnsView />);
    await userEvent.click(await screen.findByTestId("returns-new"));
    const sheet = await screen.findByTestId("new-return-sheet");
    await userEvent.selectOptions(await within(sheet).findByTestId("new-return-vendor"), "v-acme");
    await userEvent.type(within(sheet).getByLabelText("Add a batch"), "odd");
    await userEvent.click(await within(sheet).findByTestId("return-hit-ODD-1-PHARM-OPD"));
    const row = await within(sheet).findByTestId("draft-line-ODD-1-PHARM-OPD");
    await userEvent.type(within(row).getByLabelText("Quantity of batch ODD-1"), "3"); // 3 strips = 30 > 20 free
    expect(within(row).getByRole("alert")).toHaveTextContent("More than is free — at most 2 strip");
    expect(within(sheet).getByTestId("new-return-save")).toBeDisabled();
    await userEvent.clear(within(row).getByLabelText("Quantity of batch ODD-1"));
    await userEvent.type(within(row).getByLabelText("Quantity of batch ODD-1"), "2");
    await userEvent.click(within(sheet).getByTestId("new-return-save"));
    // Somebody reserved some of it meanwhile: the server says so, in the rule's words.
    expect(await within(sheet).findByTestId("new-return-error")).toHaveTextContent("Only 12 of batch ODD-1 is free to return");
    expect(within(sheet).getByTestId("new-return-error")).toHaveTextContent("the line asks 20");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("E edits a draft's lines — a quantity changed, a line removed, a line added — and every line is sent; approval waits", async () => {
    let current = ret();
    const calls = mock({
      "GET /pharmacy/office/returns": { ...office, drafts: [ret()] },
      "GET /materials/supplier-returns/ret-9": () => ({ return: current }),
      "GET /materials/supplier-returns/returnable": { batches: [...held, batch({ batchId: "b-new", batchNo: "NEW-1" })] },
      "PATCH /materials/supplier-returns/ret-9": (b: unknown) => {
        const body = b as { lines: { batchId: string; qtyBase: number; note: string | null }[] };
        current = ret({ lines: body.lines.map((l) => line(l.batchId === "b-dmg" ? "DMG-1" : "NEW-1", l.batchId, l.qtyBase, l.note)) });
        return { return: current };
      },
    }, [...PHARMACIST, "materials.returns.approve"], "u-head");
    renderWithRouter(<ReturnsView />);
    await userEvent.click(within(await screen.findByTestId("returns-section-drafts")).getByTestId("return-row-MRT2609280009"));
    const sheet = await screen.findByTestId("return-sheet");
    await within(sheet).findByTestId("return-line-DMG-1");
    expect(within(sheet).getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    sheet.focus();
    await userEvent.keyboard("e");
    const edit = await within(sheet).findByTestId("return-edit");
    // While editing, the head is not offered the approval of lines not yet saved.
    expect(within(sheet).queryByRole("button", { name: /Approve/ })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.path === "/materials/supplier-returns/returnable?vendorId=v-acme&exceptReturnId=ret-9")).toBe(true));
    const dmg = within(edit).getByTestId("draft-line-DMG-1-PHARM-OPD");
    expect(within(dmg).getByLabelText("Quantity of batch DMG-1")).toHaveValue("2"); // 20 tablets shown as 2 strips
    await userEvent.clear(within(dmg).getByLabelText("Quantity of batch DMG-1"));
    await userEvent.type(within(dmg).getByLabelText("Quantity of batch DMG-1"), "4");
    await userEvent.click(within(edit).getByTestId("remove-line-ODD-1"));
    await userEvent.type(within(edit).getByLabelText("Add a batch"), "new");
    await userEvent.click(await within(edit).findByTestId("return-hit-NEW-1-PHARM-OPD"));
    const added = await within(edit).findByTestId("draft-line-NEW-1-PHARM-OPD");
    await userEvent.selectOptions(within(added).getByLabelText("Unit for batch NEW-1"), "base");
    await userEvent.type(within(added).getByLabelText("Quantity of batch NEW-1"), "7");
    await userEvent.click(within(edit).getByTestId("return-edit-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      note: null,
      lines: [
        { batchId: "b-dmg", storeResourceId: "s-opd", qtyBase: 40, reason: "damaged", note: "crushed carton" },
        { batchId: "b-new", storeResourceId: "s-opd", qtyBase: 7, reason: "damaged", note: null },
      ],
    }));
    await waitFor(() => expect(within(sheet).queryByTestId("return-edit")).toBeNull());
    expect(await within(sheet).findByTestId("return-line-NEW-1")).toBeInTheDocument();
    expect(within(sheet).queryByTestId("return-line-ODD-1")).toBeNull();
    expect(within(sheet).getByRole("button", { name: /Approve/ })).toBeInTheDocument();
  });

  it("an approved return's lines are not editable, and without materials.returns.manage there is no New return", async () => {
    mock({
      "GET /pharmacy/office/returns": { ...office, toDispatch: [ret({ status: "approved", approvedBy: "u-head" })] },
      "GET /materials/supplier-returns/ret-9": { return: ret({ status: "approved", approvedBy: "u-head" }) },
    }, ["materials.stock.read", "materials.returns.approve"], "u-head");
    renderWithRouter(<ReturnsView />);
    await screen.findByTestId("returns-counts");
    expect(screen.queryByTestId("returns-new")).toBeNull();
    await userEvent.click(within(await screen.findByTestId("returns-section-toDispatch")).getByTestId("return-row-MRT2609280009"));
    const sheet = await screen.findByTestId("return-sheet");
    await within(sheet).findByTestId("return-line-DMG-1");
    expect(within(sheet).queryByTestId("return-edit-lines")).toBeNull();
    sheet.focus();
    await userEvent.keyboard("e");
    expect(within(sheet).queryByTestId("return-edit")).toBeNull();
  });
});
