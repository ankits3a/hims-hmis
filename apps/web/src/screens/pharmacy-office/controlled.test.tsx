import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import type { WireControlledToday } from "../../lib/controlled-api";

/**
 * PHARMACY P6 — the office's Controlled side: the day's card names what the law is waiting for, L opens
 * the licences, C counts the cabinet with a witness's username and PIN, a waiting act is posted under two
 * keys, and the balance shows whether the register meets the stock ledger.
 */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-keeper" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response("{}", { status: 404 });
    const v = routes[key];
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const KEEPER = ["pharmacy.ndps.custody", "pharmacy.ndps.witness", "pharmacy.licences.manage", "pharmacy.register.read"];

const TODAY: WireControlledToday = {
  storePresent: true, storeId: "s-ndps",
  licences: {
    ndps_rmi: { kind: "ndps_rmi", name: "recognition as a Recognised Medical Institution (NDPS Rules r.52-O, Form 3G)", state: "current", daysLeft: 47, renewalDue: true,
      licence: { id: "l1", kind: "ndps_rmi", licenceNo: "RMI/MH/117", form: "Form 3G", issuingAuthority: "Controller of Drugs", holderName: "Sunrise Hospital", responsiblePerson: "Dr Rao", validFrom: "2024-01-01", validUntil: "2026-11-10", documentRef: null, note: null, recordedBy: "u", recordedAt: "2026-09-01T00:00:00Z" } },
    schedule_x: { kind: "schedule_x", name: "the Schedule X retail drug licence (D&C Rules r.61(3), Form 20F)", state: "missing", licence: null, daysLeft: null, renewalDue: false },
  },
  checkedToday: null, discrepancies: [], custodianPairHeld: true,
  pending: { grns: [{ id: "g1", grnNo: "G2609240001", challanNo: "CH-9", status: "accepted" }], transfers: [], writeOffs: [], adjustments: [] },
  needsYou: [
    { key: "licence_missing", params: { name: "the Schedule X retail drug licence (D&C Rules r.61(3), Form 20F)", until: "" } },
    { key: "licence_renewal", params: { name: "RMI recognition", until: "2026-11-10", days: 47 } },
    { key: "checkNotDone", params: { day: "2026-09-26" } },
    { key: "actsWaiting", params: { count: 1 } },
  ],
};

beforeEach(() => { setToken("t"); window.history.replaceState(null, "", "/pharmacy/office?view=controlled"); });
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("the office's Controlled side (pharmacy P6)", () => {
  it("names what needs the in-charge today, and each licence's state", async () => {
    mock({ "GET /pharmacy/controlled/today": TODAY }, KEEPER);
    renderWithRouter(<PharmacyOffice />);
    const needs = await screen.findByTestId("controlled-needs");
    expect(within(needs).getByTestId("need-licence_missing")).toHaveTextContent("Form 20F");
    expect(within(needs).getByTestId("need-licence_renewal")).toHaveTextContent("47 days left");
    expect(within(needs).getByTestId("need-checkNotDone")).toBeInTheDocument();
    expect(screen.getByTestId("licence-schedule_x")).toHaveTextContent("None on file");
    expect(screen.getByTestId("licence-ndps_rmi")).toHaveTextContent("RMI/MH/117");
  });

  it("C counts the cabinet: every batch, the witness's username and PIN, then one call", async () => {
    const calls = mock({
      "GET /pharmacy/controlled/today": TODAY,
      "GET /pharmacy/controlled/check": { lines: [{ batchId: "b1", itemId: "i", drugName: "Morcontin 10 tablet", batchNo: "MO-1", expiryDate: "2027-12-31", unit: "tablet", onHand: 50, reserved: 0 }] },
      "POST /pharmacy/controlled/checks": { countId: "c1", balanced: true, approvalId: null, lines: [] },
    }, KEEPER);
    renderWithRouter(<PharmacyOffice />);
    const view = await screen.findByTestId("controlled-view");
    fireEvent.keyDown(view, { key: "c" });
    const sheet = await screen.findByTestId("check-sheet");
    const submit = within(sheet).getByTestId("check-submit");
    expect(submit).toBeDisabled();
    await userEvent.type(await within(sheet).findByTestId("count-MO-1"), "50");
    await userEvent.type(within(sheet).getByTestId("witness-username"), "ph.witness");
    await userEvent.type(within(sheet).getByTestId("witness-pin"), "1357");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/pharmacy/controlled/checks").map((c) => c.body))
      .toEqual([{ witness: { username: "ph.witness", pin: "1357" }, lines: [{ batchId: "b1", countedQty: 50 }] }]));
  });

  it("a waiting GRN is posted into the cabinet under two keys", async () => {
    const calls = mock({ "GET /pharmacy/controlled/today": TODAY, "POST /pharmacy/controlled/acts": { act: "grn_post", refId: "g1" } }, KEEPER);
    renderWithRouter(<PharmacyOffice />);
    await userEvent.click(await screen.findByTestId("act-g1"));
    const sheet = await screen.findByTestId("act-sheet");
    await userEvent.type(within(sheet).getByTestId("witness-username"), "ph.witness");
    await userEvent.type(within(sheet).getByTestId("witness-pin"), "1357");
    await userEvent.click(within(sheet).getByTestId("act-submit"));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/pharmacy/controlled/acts").map((c) => c.body))
      .toEqual([{ witness: { username: "ph.witness", pin: "1357" }, act: "grn_post", grnId: "g1" }]));
  });

  it("B shows the balance beside the stock ledger and says when they do not meet", async () => {
    mock({
      "GET /pharmacy/controlled/today": TODAY,
      "GET /pharmacy/controlled/balance": {
        storeResourceId: "s-ndps", fromDay: "2026-09-26", toDay: "2026-09-26", reconciled: false,
        rows: [{ itemId: "i", drugName: "Morcontin 10 tablet", unit: "tablet", batchId: "b1", batchNo: "MO-1", expiryDate: null, ndpsClass: "narcotic", scheduleFlag: "H",
          opening: 44, received: 20, issued: 9, destroyed: 3, adjusted: -2, closing: 50, ledgerClosing: 49, registerRows: 4, ledgerRows: 5, reconciled: false }],
      },
    }, KEEPER);
    renderWithRouter(<PharmacyOffice />);
    const view = await screen.findByTestId("controlled-view");
    fireEvent.keyDown(view, { key: "b" });
    await userEvent.click(await screen.findByTestId("balance-load"));
    expect(await screen.findByTestId("balance-verdict")).toHaveTextContent("does NOT meet");
    expect(screen.getByTestId("balance-table")).toHaveTextContent("✗");
  });

  it("another side of the office carries the cabinet's list in one line", async () => {
    window.history.replaceState(null, "", "/pharmacy/office");
    mock({ "GET /pharmacy/controlled/today": TODAY, "GET /pharmacy/office/today": { awaitingYou: [], drafts: [], waiting: [], toReceive: [], overdue: [], shortages: [], plan: { orders: 0, lines: 0, unassigned: 0, unmatched: 0, alreadyDrafted: 0 } } },
      [...KEEPER, "materials.po.raise"]);
    renderWithRouter(<PharmacyOffice />);
    expect(await screen.findByTestId("controlled-strip")).toHaveTextContent("4 things need you");
  });
});
