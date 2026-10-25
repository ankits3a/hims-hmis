import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdNarcotics } from "./ipd-narcotics";
import type { IpdNarcoticWard } from "@hmis/contracts";

/*
  2026-10-14 — the ward narcotic register screen. Every value is synthetic: ids are `01NARCFAKE…`, people are "Test …".
*/
const api = vi.hoisted(() => ({ getNarcoticWard: vi.fn(), recordNarcoticCount: vi.fn(), resolveNarcoticException: vi.fn() }));
vi.mock("../lib/ipd-emar-api", async (orig) => ({ ...(await orig<typeof import("../lib/ipd-emar-api")>()), ...api }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const nid = (n: number): string => `01NARCFAKE${String(n).padStart(16, "0")}`;
const AT = new Date(Date.UTC(2026, 2, 11, 8, 30)).toISOString();

function wardOf(over: Partial<IpdNarcoticWard> = {}): IpdNarcoticWard {
  return {
    asOf: AT, ward: { id: nid(1), code: "MED-W1", name: "Medicine Ward 1" }, wards: [{ id: nid(1), code: "MED-W1", name: "Medicine Ward 1" }],
    shift: "evening", countDue: true, canResolve: false,
    drugs: [{
      medicineId: nid(2), name: "Test Morphine 10 mg/ml", unit: "ampoule", opening: 0, openingAt: null, received: 4, given: 0.5, wasted: 0.5, returned: 0,
      transferredIn: 0, transferredOut: 0, expected: 3, lastCount: null,
    }],
    exceptions: [],
    lines: [{
      entryId: nid(3), at: AT, kind: "wasted", medicineName: "Test Morphine 10 mg/ml", qty: 0.5, unit: "ampoule", patient: "Test Patient Asha",
      bedCode: "MED-B01", byName: "Test Nurse One", witnessName: "Test Nurse Two",
    }],
    ...over,
  };
}

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.emar.view", "ipd.emar.give"], scoped: { department: {}, floor: {} } } }), { status: 200 })));
  for (const f of Object.values(api)) f.mockReset();
  api.getNarcoticWard.mockResolvedValue(wardOf());
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the ward narcotic register", () => {
  it("shows each drug's running balance, the count due and the register lines with the witness", async () => {
    renderWithRouter(<IpdNarcotics />, "/ipd/narcotics");
    expect(await screen.findByTestId(`ipdk-expected-${nid(2)}`)).toHaveTextContent("3");
    const row = screen.getByTestId(`ipdk-drug-${nid(2)}`);
    expect(row).toHaveTextContent("Test Morphine 10 mg/ml");
    expect(row).toHaveTextContent("4");
    expect(screen.getByTestId("ipdk-count-due")).toHaveTextContent("Count due this shift");
    const lines = screen.getByTestId("ipdk-lines");
    expect(lines).toHaveTextContent("Wasted");
    expect(lines).toHaveTextContent("witness Test Nurse Two");
  });

  it("the shift count needs every drug counted and the second nurse's username and PIN; a mismatch says who was told", async () => {
    api.recordNarcoticCount.mockResolvedValue({ roundId: nid(9), mismatches: 1, lines: [] });
    renderWithRouter(<IpdNarcotics />, "/ipd/narcotics");
    const save = await screen.findByTestId("ipdk-count-save");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId(`ipdk-counted-${nid(2)}`), "2");
    await userEvent.type(screen.getByTestId("ipdk-second-user"), "test.nurse2");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipdk-second-pin"), "8642");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(api.recordNarcoticCount).toHaveBeenCalledWith(nid(1), [{ medicineId: nid(2), unit: "ampoule", counted: 2 }], { username: "test.nurse2", pin: "8642" }));
    expect(await screen.findByTestId("ipdk-said")).toHaveTextContent("1 mismatch — supervisor and pharmacy told");
  });

  it("a refused count shows the rule and the fix", async () => {
    api.recordNarcoticCount.mockRejectedValue(new ApiError(409, {
      statusCode: 409, code: "second_nurse_not_confirmed", message: "x", rule: "The second nurse's username and PIN do not match.", fix: "Try again",
    }));
    renderWithRouter(<IpdNarcotics />, "/ipd/narcotics");
    await userEvent.type(await screen.findByTestId(`ipdk-counted-${nid(2)}`), "3");
    await userEvent.type(screen.getByTestId("ipdk-second-user"), "test.nurse2");
    await userEvent.type(screen.getByTestId("ipdk-second-pin"), "0000");
    await userEvent.click(screen.getByTestId("ipdk-count-save"));
    expect(await screen.findByTestId("ipdk-refusal")).toHaveTextContent("username and PIN do not match");
  });

  it("an open exception is closed by the supervisor with what was found; a nurse sees it without the button", async () => {
    const exc = { countId: nid(5), at: AT, medicineName: "Test Morphine 10 mg/ml", unit: "ampoule", expected: 2, counted: 1, variance: -1, byName: "Test Nurse One", witnessName: "Test Nurse Two", resolution: null };
    api.getNarcoticWard.mockResolvedValue(wardOf({ exceptions: [exc] }));
    const { unmount } = renderWithRouter(<IpdNarcotics />, "/ipd/narcotics");
    const row = await screen.findByTestId(`ipdk-exc-${nid(5)}`);
    expect(row).toHaveTextContent("register 2, counted 1 ampoule");
    expect(within(row).queryByTestId(`ipdk-resolve-${nid(5)}`)).toBeNull();
    unmount();

    api.getNarcoticWard.mockResolvedValue(wardOf({ exceptions: [exc], canResolve: true }));
    api.resolveNarcoticException.mockResolvedValue({ countId: nid(5), resolvedAt: AT });
    renderWithRouter(<IpdNarcotics />, "/ipd/narcotics");
    await userEvent.type(await screen.findByTestId(`ipdk-note-${nid(5)}`), "Ampoule broken in the tray");
    await userEvent.click(screen.getByTestId(`ipdk-resolve-${nid(5)}`));
    await waitFor(() => expect(api.resolveNarcoticException).toHaveBeenCalledWith(nid(5), "Ampoule broken in the tray"));
  });
});
