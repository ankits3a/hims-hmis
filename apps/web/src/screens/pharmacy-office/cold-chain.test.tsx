import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { isOutOfRange, parseCelsius } from "../../lib/cold-chain-api";
import { renderWithRouter } from "../../test-utils";
import { ColdChainView } from "./cold-chain";
import type { WireColdExcursion, WireColdUnit } from "../../lib/cold-chain-api";

/**
 * PHARMACY STAGE D3 — the fridge log as an office page: each fridge with today's two slots, the record sheet
 * (warning before a reading that will hold the store's cold stock), the history, and the excursion panel where
 * only a holder of `pharmacy.coldchain.manage` decides each held batch and closes it.
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
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const UNIT: WireColdUnit = {
  id: "u-1", label: "Vaccine fridge 1", lowC: "2.0", highC: "8.0", active: true, store: { id: "s1", code: "PHARM-OPD", name: "OPD pharmacy counter" },
  slots: [{ slot: "09:00", state: "missed", readingId: null }, { slot: "17:00", state: "upcoming", readingId: null }],
  lastReading: null, openExcursion: null,
};
const EXCURSION: WireColdExcursion = {
  id: "e-1", no: "CE-000001", unit: { id: "u-1", label: "Vaccine fridge 1" }, store: { id: "s1", code: "PHARM-OPD", name: "OPD pharmacy counter" },
  lowC: "2.0", highC: "8.0", openedAt: "2026-09-28T04:00:00.000Z",
  reading: { id: "r1", currentC: "9.5", minC: "3.0", maxC: "9.5", takenAt: "2026-09-28T04:00:00.000Z" },
  batches: [
    { batchId: "b1", batchNo: "INS-1", expiryDate: "2027-03-31", itemId: "i1", itemName: "Insulin glargine", qtyOnHand: 12, decision: null },
    { batchId: "b2", batchNo: "VAX-7", expiryDate: "2027-01-31", itemId: "i2", itemName: "Hepatitis B vaccine", qtyOnHand: 5, decision: null },
  ],
  closed: null,
};
const ROUTES = {
  "GET /pharmacy/cold-chain/units": { items: [{ ...UNIT, openExcursion: { id: "e-1", no: "CE-000001", openedAt: EXCURSION.openedAt, batches: 2 } }] },
  "GET /pharmacy/cold-chain/units/u-1/readings": { items: [] },
  "GET /pharmacy/cold-chain/excursions": { items: [EXCURSION] },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the fridge log (pharmacy stage D3)", () => {
  it("parses a one-decimal temperature and warns on an out-of-range reading", () => {
    expect(parseCelsius("4.5")).toBe(4.5);
    expect(parseCelsius("-18")).toBe(-18);
    expect(parseCelsius("4.55")).toBeNull();
    expect(parseCelsius("")).toBeNull();
    expect(isOutOfRange(UNIT, [5, 3, 7.9])).toBe(false);
    expect(isOutOfRange(UNIT, [5, 1.9, 7])).toBe(true);
  });

  it("a recorder sees the slots and the open excursion, records a reading, and cannot decide the held batches", async () => {
    const calls = mock({
      ...ROUTES,
      "POST /pharmacy/cold-chain/readings": { readingId: "r2", outOfRange: true, opened: null },
    }, ["pharmacy.coldchain.record"]);
    renderWithRouter(<ColdChainView />);
    expect(await screen.findByTestId("cold-slot-Vaccine fridge 1-09:00")).toHaveTextContent("missed");
    expect(screen.getByTestId("cold-excursion-Vaccine fridge 1")).toHaveTextContent("CE-000001 open · 2 batches on hold");
    expect(await screen.findByTestId("cold-ex-CE-000001")).toHaveTextContent("Insulin glargine");
    expect(screen.queryByTestId("cold-decide-INS-1-release")).toBeNull();
    expect(screen.queryByTestId("cold-add-unit")).toBeNull();

    await userEvent.click(screen.getByTestId("cold-record-Vaccine fridge 1"));
    await userEvent.type(screen.getByTestId("cold-current"), "5.0");
    await userEvent.type(screen.getByTestId("cold-min"), "3.2");
    await userEvent.type(screen.getByTestId("cold-max"), "8.4");
    expect(screen.getByTestId("cold-warn")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("cold-record-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pharmacy/cold-chain/readings")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ unitId: "u-1", currentC: 5, minC: 3.2, maxC: 8.4 });
  });

  it("the in-charge decides every held batch — a release needs its reason — and closes the excursion", async () => {
    const calls = mock({
      ...ROUTES,
      "POST /pharmacy/cold-chain/excursions/e-1/close": { excursionId: "e-1", writeOffId: "wo-1" },
    }, ["pharmacy.coldchain.manage"]);
    renderWithRouter(<ColdChainView />);
    const close = await screen.findByTestId("cold-ex-close-CE-000001");
    expect(close).toBeDisabled();
    await userEvent.click(screen.getByTestId("cold-decide-INS-1-release"));
    await userEvent.click(screen.getByTestId("cold-decide-VAX-7-write_off"));
    expect(close).toBeDisabled(); // the release has no reason yet
    await userEvent.type(screen.getByTestId("cold-reason-INS-1"), "Stable 28 days below 30 °C (label)");
    expect(close).toBeEnabled();
    await userEvent.click(close);
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/cold-chain/excursions/e-1/close")).toBe(true));
    expect(calls.find((c) => c.path === "/pharmacy/cold-chain/excursions/e-1/close")?.body).toEqual({
      decisions: [
        { batchId: "b1", decision: "release", reason: "Stable 28 days below 30 °C (label)" },
        { batchId: "b2", decision: "write_off" },
      ],
      note: null,
    });
  });
});
