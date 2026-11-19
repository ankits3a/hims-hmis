import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresShelf } from "../stores-shelf";

/**
 * ACCEPTANCE — issue #1111, spec docs/specs/1111-stores-masters-shelves.md (owner APPROVED 2026-11-18): the
 * web half, D20. The department shelf at 390 px: one row per item on one line with a status word, "Used" in
 * at most two taps, no horizontal scroll and no money figure for department staff. The server half:
 * apps/core/src/modules/stores/acceptance/stores-s1-1111.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const VIEW = {
  shelf: {
    id: "s1", code: "HSK-F1", name: "Housekeeping F1", kind: "shelf", parentId: "f1", departmentId: "d1", suppliedBy: "g1",
    custodianRoles: [], departmentCode: "HSK", departmentName: "Housekeeping", floorName: "First floor",
  },
  items: [
    { itemId: "i1", code: "HK-MOP-0001", name: "Wet mop refill with a rather long name that must not wrap", baseUom: "piece", trackMode: "shelf", onHand: 12, status: "ok", par: { minBase: 5, reorderBase: 10, maxBase: 30 }, lastCheckAt: null, usePerDay30: 1, usePerOpdVisit: null, usePerBedDay: null },
    { itemId: "i2", code: "HK-GLV-0002", name: "Household gloves", baseUom: "pair", trackMode: "shelf", onHand: 3, status: "low", par: { minBase: 5, reorderBase: 10, maxBase: 30 }, lastCheckAt: null, usePerDay30: 0.5, usePerOpdVisit: null, usePerBedDay: null },
    { itemId: "i3", code: "HK-BIN-0042", name: "Dustbin 20 L", baseUom: "piece", trackMode: "durable", onHand: 0, status: "out", par: null, lastCheckAt: null, usePerDay30: 0, usePerOpdVisit: null, usePerBedDay: null },
  ],
  arriving: [],
  may: { work: true },
};

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") {
      return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: { d1: ["stores.shelf.read", "stores.shelf.work"] }, floor: {} } } });
    }
    if (path === "/stores/shelves/s1" && method === "GET") return json(VIEW);
    if (path === "/stores/shelves/s1/use" && method === "POST") return json({ ledgerEntryIds: ["r1"] });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the department shelf at 390 px (spec #1111)", () => {
  it("spec #1111 D20: one row per item on one line with a status word; Used in two taps; no horizontal scroll; no money", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresShelf shelfId="s1" />);

    const rows = await screen.findAllByTestId(/^shelf-row-/);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // One line: the row never wraps, and the name gives way (ellipsis) before the numbers do.
      expect(row.style.whiteSpace).toBe("nowrap");
      expect(row.style.overflow).toBe("hidden");
    }
    expect(within(screen.getByTestId("shelf-row-i1")).getByText("OK")).toBeInTheDocument();
    expect(within(screen.getByTestId("shelf-row-i2")).getByText("Low")).toBeInTheDocument();
    expect(within(screen.getByTestId("shelf-row-i3")).getByText("Out")).toBeInTheDocument();
    expect(within(screen.getByTestId("shelf-row-i1")).getByText("12")).toBeInTheDocument();

    // No horizontal scroll: the screen clips sideways and never sets a width wider than the phone.
    const root = screen.getByTestId("stores-shelf");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");

    // No money figure anywhere for department staff.
    expect(document.body.textContent ?? "").not.toMatch(/₹|Rs\.?\s?\d|paise/i);

    // Used in at most two taps: the row's Used, then the sheet's primary.
    await user.click(within(screen.getByTestId("shelf-row-i1")).getByRole("button", { name: "Used" }));
    const sheet = await screen.findByTestId("shelf-used-sheet");
    await user.click(within(sheet).getByRole("button", { name: "Used" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/stores/shelves/s1/use")).toBe(true));
    expect(calls.find((c) => c.path === "/stores/shelves/s1/use")!.body).toEqual({ itemId: "i1", qty: 1 });
    expect(await screen.findByText("Saved")).toBeInTheDocument();

    // A durable item offers Check, never Used.
    expect(within(screen.getByTestId("shelf-row-i3")).queryByRole("button", { name: "Used" })).toBeNull();
  });
});
