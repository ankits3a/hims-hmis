import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MaintenanceBoard } from "./maintenance-board";
import type { MaintenanceBoardView, MaintenanceTicketView } from "@hmis/contracts";

/** E1.5 MAINTENANCE (issue #722) — the supervisor's board and the raise sheet. Every value is synthetic. */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const ticket = (over: Partial<MaintenanceTicketView>): MaintenanceTicketView => ({
  id: "k1", number: 101, placeResourceId: "r1", placeName: "F05-MED-B02", placeCode: "F05-MED-B02", placeKind: "bed", floorName: "Floor 5",
  itemKind: "bed", itemTag: null, category: "general", urgency: "routine", description: "Rail broken", source: "person", state: "assigned",
  taskState: "assigned", taskId: "t1", bedBlockId: "b1", blockOnRelease: false, replacementFlag: false, assigneeName: "Tech One",
  raisedByName: "Nurse One", raisedAt: iso(-200), dueAt: iso(600), fixedAt: null, closedAt: null, ageMinutes: 200, late: false, ...over,
});

describe("MaintenanceBoard (E1.5)", () => {
  let posts: { url: string; body: unknown }[];
  let refuse: boolean;
  beforeEach(() => {
    setToken("t");
    posts = [];
    refuse = false;
    const view: MaintenanceBoardView = {
      serverNow: new Date(NOW).toISOString(),
      floors: [{ floorName: "Floor 5", tickets: [
        ticket({ id: "crit", number: 102, urgency: "critical", itemKind: "oxygen_point", ageMinutes: 35, blockOnRelease: true, replacementFlag: true }),
        ticket({ id: "rout" }),
        ticket({ id: "lost", number: 103, state: "open", taskState: null, taskId: null, bedBlockId: null, placeCode: "F05-R1", ageMinutes: 1500 }),
      ] }],
      toConfirm: [ticket({ id: "fix", number: 99, state: "fixed", fixedAt: iso(-10) })],
      blockedBeds: [{ bedId: "r1", bedCode: "F05-MED-B02", ticketNumber: 101, state: "assigned", onRelease: false }],
      replacement: [{ placeName: "F05-MED-B07", itemKind: "oxygen_point", itemTag: "OX-12", ticketNumber: 102, raisedAt: iso(-35) }],
      counts: { open: 3, critical: 1, late: 0, toConfirm: 1, blockedBeds: 1, notShown: 0 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
      if (init?.method === "POST") {
        posts.push({ url: raw, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
        if (refuse) {
          return json({ statusCode: 409, code: "verifier_is_doer", message: "The person who did a task cannot check it.", fix: "Ask another supervisor to check it." }, 409);
        }
        if (raw.endsWith("/maintenance/tickets")) return json({ ticketId: "new", number: 104, merged: false, bed: "blocked", replacementFlag: false });
        return json({ id: "fix", number: 99, state: "closed", version: 4 });
      }
      if (raw.endsWith("/maintenance/board")) return json(view);
      if (raw.includes("/maintenance/places")) return json([{ id: "r9", kind: "bed", code: "F05-MED-B09", name: "F05-MED-B09", floorName: "Floor 5" }]);
      if (raw.endsWith("/auth/me")) {
        return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["maintenance.view", "maintenance.raise", "maintenance.confirm", "maintenance.manage"], scoped: { department: {}, floor: {} } } });
      }
      return json({});
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("open repairs by floor, critical first, age in words, the bed effect and replace flag in words; an undispatched one offers Dispatch", async () => {
    renderWithProviders(<MaintenanceBoard />);
    const floor = await screen.findByTestId("mt-floor-Floor 5");
    const rows = within(floor).getAllByTestId(/^mt-row-/);
    expect(rows[0]).toHaveTextContent("#102 · F05-MED-B02 · Oxygen point · Replace?");
    expect(rows[0]).toHaveTextContent("Critical · Blocks on release · With Tech One");
    expect(within(rows[0]!).getByTestId("mt-age")).toHaveTextContent("35 min");
    expect(within(rows[1]!).getByTestId("mt-age")).toHaveTextContent("3 h 20 min");
    expect(rows[2]).toHaveTextContent("Not dispatched");
    expect(within(rows[2]!).getByRole("button", { name: "Dispatch" })).toBeInTheDocument();
    expect(screen.getByTestId("mt-blocked-beds")).toHaveTextContent("F05-MED-B02#101Bed blocked · technician assigned");
    expect(screen.getByTestId("mt-replace")).toHaveTextContent("Oxygen point OX-12 · F05-MED-B07");
  });

  it("Confirm posts the nurse's confirmation; a refusal shows the server's words", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MaintenanceBoard />);
    const item = await screen.findByTestId("mt-confirm-99");
    refuse = true;
    await user.click(within(item).getByRole("button", { name: "Confirm" }));
    expect(await within(item).findByRole("status")).toHaveTextContent("The technician cannot confirm their own repair. Ask another supervisor to check it.");
    expect(posts.map((p) => p.url)).toEqual(["/api/maintenance/tickets/fix/confirm"]);
  });

  it("Report a fault: pick the place, item and urgency, type a note, and the answer says what happened to the bed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MaintenanceBoard />);
    await user.click(await screen.findByTestId("mt-report"));
    const sheet = screen.getByTestId("maintenance-raise");
    const send = within(sheet).getByRole("button", { name: "Report" });
    expect(send).toBeDisabled();
    await user.type(within(sheet).getByRole("textbox", { name: "Where" }), "B09");
    await user.click(await within(sheet).findByRole("option", { name: /F05-MED-B09/ }));
    await user.click(within(sheet).getByRole("button", { name: "Suction" }));
    await user.click(within(sheet).getByRole("button", { name: /Critical/ }));
    await user.type(within(sheet).getByPlaceholderText("A few words"), "No suction pressure");
    await user.click(send);
    expect(await within(sheet).findByTestId("maintenance-raised")).toHaveTextContent("Repair #104 raisedBed blocked until the repair is confirmed");
    expect(posts).toEqual([{ url: "/api/maintenance/tickets", body: { placeResourceId: "r9", itemKind: "suction", urgency: "critical", description: "No suction pressure" } }]);
  });
});
