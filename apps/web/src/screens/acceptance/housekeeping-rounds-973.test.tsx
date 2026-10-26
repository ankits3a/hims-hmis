import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { HousekeepingBoard } from "../housekeeping-board";
import { DoorRequest } from "../door-request";
import type { HkSupervisorView, TaskBoardView } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #973, spec docs/specs/973-housekeeping-rounds.md (owner APPROVED 2026-10-26): the two done-means a
 * screen carries. D6: the supervisor board names a missed round. D7: the door page sends a request with no login and
 * no patient detail. No date is pinned: every instant is relative to the real clock.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const BOARD: TaskBoardView = {
  serverNow: iso(0), floors: [], workers: [], toVerify: [], counts: { open: 0, late: 0, pool: 0, notShown: 0 },
};
const SUPERVISOR: HkSupervisorView = {
  serverNow: iso(0),
  missed: [{ areaId: "a1", areaName: "Floor 2 toilet (gents)", floorName: "Floor 2", taskId: "t1", slotStart: iso(-80), dueAt: iso(-20.5), assigneeInitials: "R. K." }],
  needsYou: [],
  people: [],
};

describe("#973 — housekeeping rounds on screen", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); window.location.hash = ""; });

  it("spec #973 D6: a round not scanned by its due time shows as missed on the supervisor board", async () => {
    setToken("t");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "sup" }, permissions: { hospital: ["housekeeping.view"], scoped: { department: {}, floor: {} } } },
      "GET /api/housekeeping/board": BOARD,
      "GET /api/housekeeping/supervisor": SUPERVISOR,
    });
    renderWithProviders(<HousekeepingBoard />);
    const missed = await screen.findByRole("region", { name: /missed rounds/i });
    expect(await within(missed).findByText("Floor 2 toilet (gents)")).toBeInTheDocument();
    expect(within(missed).getByText(/20 min late/i)).toBeInTheDocument();
  });

  it("spec #973 D7: a request from a door QR, with no login, is sent with the need only", async () => {
    window.location.hash = "#a1.area-1.1.sig";
    stubFetch({ "POST /api/housekeeping/door": { requestId: "r1", taskId: "t1" } });
    renderWithProviders(<DoorRequest />);
    // The board's four needs ("Anyone · Raise a request").
    for (const need of [/^Clean room/, /^Toilet dirty/, /^Spill/, /^Bin full/]) expect(await screen.findByRole("button", { name: need })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Bin full/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ token: "a1.area-1.1.sig", need: "bin" });
    });
    expect(await screen.findByText(/sent/i)).toBeInTheDocument();
    // No login: the page never asked who is calling, and no patient detail is collected.
    const calls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes("/auth/"))).toBe(false);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
