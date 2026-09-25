import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOfficeReports } from "./pharmacy-office";
import type { TallyLedgers, WireTallyExport, WireTallyPreview } from "../../lib/tally-api";

/**
 * PHARMACY PARITY P5 — the Tally export: 9 opens it for the holder of `pharmacy.tally.export` only;
 * it waits for the ledger names to be confirmed (L opens them, saving confirms); the preview says
 * what the file will carry and warns of an earlier export of the same days; X exports, and the two
 * files download from the recorded export through the app's download path.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path: raw.includes("?") ? `${path}?${raw.split("?")[1]!}` : path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-acc" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    if (typeof out === "string") return new Response(out, { status: 200, headers: { "Content-Type": "application/xml", "Content-Disposition": "attachment; filename=\"tally-pharmacy-2026-09-01-to-2026-09-25-vouchers.xml\"" } });
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const ACCOUNTS = ["pharmacy.reports.read", "pharmacy.tally.export"];
const LEDGERS: TallyLedgers = {
  companyName: "", sales: "Pharmacy Sales", salesReturns: "Pharmacy Sales", outputCgst: "Output CGST", outputSgst: "Output SGST",
  purchases: "Purchase — Medicines", purchaseReturns: "Purchase — Medicines", inputCgst: "Input CGST", inputSgst: "Input SGST", inputIgst: "Input IGST",
  cash: "Cash", bank: "Bank", roundOff: "Round Off", returnShortfall: "Purchase Return Shortfall",
  counterSales: "Pharmacy Counter Sales",
};
const zero = { sale: 0, sales_return: 0, receipt: 0, refund: 0, purchase: 0, purchase_return: 0, supplier_payment: 0, credit_shortfall: 0, return_closed: 0 };
const earlier: WireTallyExport = {
  id: "tx-0", from: "2026-09-01", to: "2026-09-20", voucherCount: 3, counts: { ...zero, sale: 3 }, debitPaise: 16_500,
  checksum: "a".repeat(64), exportedBy: "accounts", exportedAt: "2026-09-21T05:00:00.000Z",
};
const preview = (confirmed: boolean): WireTallyPreview => ({
  from: "2026-09-01", to: "2026-09-25", preset: "month", confirmed, ledgers: LEDGERS, voucherCount: 4, counts: { ...zero, sale: 2, receipt: 1, purchase: 1 },
  debitPaise: 311_500, earlier: [earlier],
  sample: [{
    kind: "sale", type: "Sales", remoteId: "hmis:sale:inv-1", number: "INV/26-27/000001", date: "2026-09-25", reference: "P2609250001",
    party: "Pharmacy Counter Sales", narration: "Pharmacy bill INV/26-27/000001 (dispense P2609250001)", entries: [
      { ledger: "Pharmacy Counter Sales", amountPaise: 4_500, party: true }, { ledger: "Pharmacy Sales", amountPaise: -4_286, party: false },
      { ledger: "Output CGST", amountPaise: -107, party: false }, { ledger: "Output SGST", amountPaise: -107, party: false },
    ],
  }],
});

describe("the Tally export (parity P5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("is offered only to the holder of pharmacy.tally.export", async () => {
    mock({}, ["pharmacy.reports.read"]);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    expect(within(list).queryByTestId("report-tally")).toBeNull();
  });

  it("waits for the ledger names: L opens them, saving confirms them, and the export is then allowed", async () => {
    let confirmed = false;
    const calls = mock({
      "GET /pharmacy/office/tally/preview": () => preview(confirmed),
      "GET /pharmacy/office/tally/exports": { exports: [earlier] },
      "GET /pharmacy/office/tally/ledgers": () => ({ ledgers: LEDGERS, confirmed, updatedBy: null, updatedAt: null }),
      "PUT /pharmacy/office/tally/ledgers": (b: unknown) => { confirmed = true; return { ledgers: b, confirmed: true, updatedBy: "accounts", updatedAt: "2026-09-25T06:00:00.000Z" }; },
    }, ACCOUNTS);
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-tally"));
    expect(await screen.findByTestId("tally-ledger-state")).toHaveTextContent("Confirm the ledger names");
    expect(screen.getByTestId("tally-export")).toBeDisabled();
    expect(screen.getByTestId("tally-earlier")).toHaveTextContent("2026-09-01 – 2026-09-20 by accounts");
    expect(screen.getByTestId("tally-count-sale")).toHaveTextContent("2");
    await userEvent.keyboard("l");
    const dialog = await screen.findByTestId("tally-ledgers");
    const bank = await within(dialog).findByTestId("ledger-bank");
    await userEvent.clear(bank);
    await userEvent.type(bank, "HDFC Current A/c");
    // The one B2C party ledger is the accountant's to name, like any other; there is no ledger per patient to choose.
    const counter = within(dialog).getByTestId("ledger-counterSales");
    expect(counter).toHaveValue("Pharmacy Counter Sales");
    await userEvent.clear(counter);
    await userEvent.type(counter, "Counter Sales — Pharmacy");
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("tally-ledgers-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ ...LEDGERS, bank: "HDFC Current A/c", counterSales: "Counter Sales — Pharmacy" }));
    await waitFor(() => expect(screen.getByTestId("tally-export")).toBeEnabled());
  });

  it("X exports the range; both files download from the recorded export", async () => {
    const made = { ...earlier, id: "tx-1", from: "2026-09-01", to: "2026-09-25", voucherCount: 4, checksum: "b".repeat(64) };
    const calls = mock({
      "GET /pharmacy/office/tally/preview": preview(true),
      "GET /pharmacy/office/tally/exports": { exports: [] },
      "POST /pharmacy/office/tally/exports": { export: made },
      "GET /pharmacy/office/tally/exports/tx-1/vouchers.xml": "<ENVELOPE/>",
      "GET /pharmacy/office/tally/exports/tx-1/masters.xml": "<ENVELOPE/>",
    }, ACCOUNTS);
    const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    await userEvent.click(within(await screen.findByTestId("reports-view")).getByTestId("report-tally"));
    await screen.findByTestId("tally-total");
    expect(screen.getByTestId("tally-voucher-INV/26-27/000001")).toHaveTextContent("Pharmacy Sales");
    await userEvent.keyboard("x");
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ preset: "month" }));
    expect(await screen.findByTestId("tally-done")).toHaveTextContent("4 vouchers exported");
    await userEvent.click(screen.getByTestId("tally-download-masters"));
    await userEvent.click(screen.getByTestId("tally-download-vouchers"));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith(".xml")).map((c) => c.path)).toEqual([
      "/pharmacy/office/tally/exports/tx-1/masters.xml", "/pharmacy/office/tally/exports/tx-1/vouchers.xml",
    ]));
    expect(click).toHaveBeenCalledTimes(2);
    URL.createObjectURL = real.create;
    URL.revokeObjectURL = real.revoke;
    click.mockRestore();
  });
});
