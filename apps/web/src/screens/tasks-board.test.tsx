import { screen, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { TasksBoard } from "./tasks-board";
import type { TaskBoardView, TaskCard } from "@hmis/contracts";

/**
 * E0.1 TASK ENGINE (issue #713) — the supervisor's board: floors, late first with the lateness in words
 * (never colour alone), the worker load column, and "+N more" instead of a scroll.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const card = (over: Partial<TaskCard>): TaskCard => ({
  id: "t1", kind: "general", label: "General task", priority: "routine", state: "assigned",
  placeResourceId: "r1", placeName: "Room 201", placeCode: "201", floorName: "Floor 2", note: null,
  dueAt: iso(30), createdAt: iso(-5), assigneeId: "w1", assigneeName: "Worker One", proofNeeded: "none", verifyRequired: false,
  mergedCount: 0, escalatedRung: 0, version: 2, ...over,
});

describe("TasksBoard (E0.1)", () => {
  let view: TaskBoardView;
  beforeEach(() => {
    setToken("t");
    view = {
      serverNow: new Date(NOW).toISOString(),
      floors: [
        { floorId: null, floorName: "Floor 2", tasks: [card({ id: "late", dueAt: iso(-12.5) }), card({ id: "soon", dueAt: iso(5), assigneeId: null, assigneeName: null, state: "created" })] },
        { floorId: null, floorName: "Floor 3", tasks: Array.from({ length: 40 }, (_, i) => card({ id: `f3-${i}`, floorName: "Floor 3", dueAt: iso(40 + i) })) },
      ],
      workers: [
        { userId: "w1", name: "Worker One", onDuty: true, open: 41, inProgress: 1 },
        { userId: "w2", name: "Worker Two", onDuty: true, open: 0, inProgress: 0 },
      ],
      toVerify: [],
      counts: { open: 42, late: 1, pool: 1 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.endsWith("/tasks/board") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["tasks.view"], scoped: { department: {}, floor: {} } } }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("late first, the lateness in words beside the colour", async () => {
    renderWithProviders(<TasksBoard />);
    const floor = await screen.findByTestId("floor-Floor 2");
    const rows = within(floor).getAllByTestId(/^row-(?!clock$)/);
    expect(rows[0]).toHaveAttribute("data-testid", "row-late");
    expect(within(rows[0]!).getByTestId("row-clock")).toHaveTextContent("12 min late");
    expect(within(rows[1]!).getByText(/Nobody yet/)).toBeInTheDocument();
    expect(within(floor).getByText("1 late · 2 open")).toBeInTheDocument();
    expect(screen.getByTestId("board-late")).toHaveTextContent("1late");
  });

  it("a floor with more rows than fit says +N more instead of scrolling", async () => {
    renderWithProviders(<TasksBoard />);
    const floor = await screen.findByTestId("floor-Floor 3");
    expect(within(floor).getByTestId("floor-more")).toHaveTextContent(/^\+\d+ more$/);
    expect(within(floor).getAllByTestId(/^row-(?!clock$)/).length).toBeLessThan(40);
  });

  it("the worker column shows each worker's load and duty", async () => {
    renderWithProviders(<TasksBoard />);
    const w1 = await screen.findByTestId("worker-w1");
    expect(w1).toHaveTextContent("Worker One");
    expect(w1).toHaveTextContent("41 open");
    expect(w1).toHaveTextContent("On duty");
    expect(w1).toHaveTextContent("1 in progress");
  });
});
