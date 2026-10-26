import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { HousekeepingBoard } from "./housekeeping-board";
import type { TaskBoardView, TaskCard } from "@hmis/contracts";

/** E1.4 HOUSEKEEPING (issue #721) — the supervisor's board: housekeeping's kinds, terminal cleans in words, Check. */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const card = (over: Partial<TaskCard>): TaskCard => ({
  id: "t1", kind: "bed_clean_routine", label: "Bed clean", priority: "routine", state: "assigned",
  placeResourceId: "r1", placeName: "F05-MED-F-B02", placeCode: "F05-MED-F-B02", floorName: "Floor 5", note: null,
  dueAt: iso(20), createdAt: iso(-25), assigneeId: "w1", assigneeName: "Worker One", proofNeeded: "tap", verifyRequired: true,
  mergedCount: 0, escalatedRung: 0, version: 3, ...over,
});

describe("HousekeepingBoard (E1.4)", () => {
  let posted: string[];
  let refuse: boolean;
  beforeEach(() => {
    setToken("t");
    posted = [];
    refuse = false;
    const view: TaskBoardView = {
      serverNow: new Date(NOW).toISOString(),
      floors: [{ floorId: null, floorName: "Floor 5", tasks: [
        card({ id: "term", kind: "bed_clean_terminal", label: "Terminal clean", dueAt: iso(-15.5) }),
        card({ id: "rout" }),
      ] }],
      workers: [{ userId: "w1", name: "Worker One", onDuty: true, open: 2, inProgress: 0 }],
      toVerify: [card({ id: "chk", kind: "bed_clean_terminal", label: "Terminal clean", state: "done", placeCode: "F05-ISO-01" })],
      counts: { open: 2, late: 1, pool: 0, notShown: 0 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push(raw);
        if (refuse) {
          return new Response(JSON.stringify({
            statusCode: 403, code: "terminal_needs_supervisor",
            message: "A terminal clean is checked by the housekeeping supervisor (infection control).",
            fix: "Ask the housekeeping supervisor to check this bed.",
          }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ id: "chk", state: "verified", version: 4 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/housekeeping/board") ? view
        : raw.endsWith("/housekeeping/supervisor") ? { serverNow: new Date(NOW).toISOString(), missed: [], needsYou: [], people: [] }
          : raw.endsWith("/proof") ? { proof: null }
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["housekeeping.view"], scoped: { department: {}, floor: {} } } }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads housekeeping's board, late first, and flags a terminal clean in words", async () => {
    renderWithProviders(<HousekeepingBoard />);
    expect(await screen.findByRole("heading", { name: "Housekeeping" })).toBeInTheDocument();
    const floor = await screen.findByTestId("floor-Floor 5");
    const rows = within(floor).getAllByTestId(/^row-(?!clock$|flag$)/);
    expect(rows[0]).toHaveAttribute("data-testid", "row-term");
    expect(within(rows[0]!).getByTestId("row-flag")).toHaveTextContent("Supervisor checks");
    expect(within(rows[0]!).getByTestId("row-clock")).toHaveTextContent("15 min late");
    expect(within(rows[1]!).queryByTestId("row-flag")).toBeNull();
  });

  it("Check opens the confirm sheet; Pass posts it, and a refusal shows the server's rule and fix (HK-1, #973)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HousekeepingBoard />);
    const item = await screen.findByTestId("verify-chk");
    expect(item).toHaveTextContent("F05-ISO-01 · Terminal clean");
    refuse = true;
    await user.click(within(item).getByRole("button", { name: "Check" }));
    const sheet = within(await screen.findByTestId("hk-confirm"));
    await user.click(sheet.getByRole("button", { name: "Pass · bed ready" }));
    expect(await sheet.findByRole("alert")).toHaveTextContent(
      "A terminal clean is checked by the housekeeping supervisor (infection control). Ask the housekeeping supervisor to check this bed.",
    );
    expect(posted).toEqual(["/api/housekeeping/tasks/chk/confirm"]);
    // Fail needs a reason before anything is sent.
    await user.click(sheet.getByRole("button", { name: "Fail" }));
    expect(await sheet.findByRole("alert")).toHaveTextContent("Pick a reason for Fail.");
    expect(posted).toHaveLength(1);
  });
});
