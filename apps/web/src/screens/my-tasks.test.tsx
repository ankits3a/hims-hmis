import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MyTasks } from "./my-tasks";
import type { MyTasksView, TaskCard } from "@hmis/contracts";

/**
 * E0.1 TASK ENGINE (issue #713) — My tasks: one action per card (Accept · Start · Done), the pool below,
 * a late task says how late in words, and a refusal is a few words on one line. The server is stubbed.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const card = (over: Partial<TaskCard>): TaskCard => ({
  id: "t1", kind: "general", label: "General task", priority: "routine", state: "assigned",
  placeResourceId: "r1", placeName: "Room 201", placeCode: "201", floorName: "Floor 2", note: null,
  dueAt: iso(29.5), createdAt: iso(-5), assigneeId: "me", assigneeName: "me", proofNeeded: "none", verifyRequired: false,
  mergedCount: 0, escalatedRung: 0, version: 2, ...over,
});

describe("MyTasks (E0.1)", () => {
  const posted: string[] = [];
  let view: MyTasksView;
  let refuse: string | null;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    refuse = null;
    view = {
      serverNow: new Date(NOW).toISOString(),
      mine: [
        card({ id: "a", state: "assigned" }),
        card({ id: "b", state: "accepted", dueAt: iso(-12.5), priority: "urgent" }),
        card({ id: "c", state: "in_progress", mergedCount: 2 }),
      ],
      pool: [card({ id: "p", state: "created", assigneeId: null, assigneeName: null, placeName: null, floorName: null })],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push(raw);
        if (refuse !== null) return new Response(JSON.stringify({ code: refuse, message: "x" }), { status: 409, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ id: "a", state: "accepted", version: 3 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/tasks/mine") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["tasks.work"], scoped: { department: {}, floor: {} } } }
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("one button per card, by stage: Accept, Start, Done; the pool offers Accept", async () => {
    renderWithProviders(<MyTasks />);
    expect(within(await screen.findByTestId("task-a")).getByTestId("task-accept")).toHaveTextContent("Accept");
    expect(within(screen.getByTestId("task-b")).getByTestId("task-start")).toHaveTextContent("Start");
    expect(within(screen.getByTestId("task-c")).getByTestId("task-done")).toHaveTextContent("Done");
    expect(within(screen.getByTestId("task-p")).getByTestId("task-accept")).toBeInTheDocument();
    expect(screen.getByText("Open to take")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-p")).getByText("No place given")).toBeInTheDocument();
    expect(screen.queryByText(/photo/i)).toBeNull();
  });

  it("says how late in words, with the place and the floor", async () => {
    renderWithProviders(<MyTasks />);
    const late = await screen.findByTestId("task-b");
    expect(within(late).getByTestId("task-clock")).toHaveTextContent("12 min late");
    expect(within(late).getByText("Urgent")).toBeInTheDocument();
    expect(within(late).getByText("Room 201 · Floor 2")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-a")).getByTestId("task-clock")).toHaveTextContent("Due in 30 min");
    expect(within(screen.getByTestId("task-c")).getByText("Asked 2×")).toBeInTheDocument();
  });

  it("Accept posts to the task's accept door with its version", async () => {
    renderWithProviders(<MyTasks />);
    await userEvent.click(within(await screen.findByTestId("task-a")).getByTestId("task-accept"));
    expect(posted).toEqual([expect.stringContaining("/tasks/a/accept")]);
  });

  it("a refusal is a short notice: someone else took it", async () => {
    refuse = "already_taken";
    renderWithProviders(<MyTasks />);
    await userEvent.click(within(await screen.findByTestId("task-p")).getByTestId("task-accept"));
    expect(await screen.findByTestId("my-tasks-notice")).toHaveTextContent("Someone took it");
  });

  it("an empty list says so", async () => {
    view = { serverNow: new Date(NOW).toISOString(), mine: [], pool: [] };
    renderWithProviders(<MyTasks />);
    expect(await screen.findByTestId("my-tasks-none")).toHaveTextContent("No tasks now");
  });
});
