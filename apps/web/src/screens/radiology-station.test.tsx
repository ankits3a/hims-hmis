import { screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyStation } from "./radiology-station";
import { RadiologyReception } from "./radiology-reception";

/**
 * PLAN 18-S RS1 — the imaging department's screens on the station shell (board
 * `docs/design/2026-09-28-radiology-stations/`). Same layout law as the lab's (17-F F1): the switch
 * shows the stations a person may work plus the one they are on, and the shell wears the department's
 * own seat scope so its paper / pine tokens do not leak into a shadcn screen elsewhere.
 */

function me(permissions: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.split("?")[0] === "/api/auth/me") {
      return new Response(JSON.stringify({
        actor: { type: "user", id: "u-1" },
        permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (raw.split("?")[0] === "/api/radiology/worklist") {
      return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("RS1 — the switch offers the imaging stations this person may work, and marks the one they are on", async () => {
  me(["radiology.schedule", "aerb.registers.read"]);
  renderWithProviders(
    <RadiologyStation station="desk" title="Front desk" place="R-01" stats={[]}><p>work</p></RadiologyStation>,
  );
  const sw = within(screen.getByRole("navigation", { name: "Stations" }));
  await waitFor(() => expect(sw.getByRole("link", { name: "Radiation safety" })).toBeInTheDocument());
  expect(sw.getByRole("link", { name: "Imaging reception" })).toHaveAttribute("aria-current", "page");
  expect(sw.getByRole("link", { name: "Imaging reception" })).toHaveAttribute("href", "/radiology/reception");
  expect(sw.getByRole("link", { name: "Radiation safety" })).toHaveAttribute("href", "/radiology/radiation-safety");
  // No `radiology.worklist.read`, no door to the worklist.
  expect(sw.queryByRole("link", { name: "Imaging worklist" })).toBeNull();
});

it("RS1 — the shell wears the radiology seat scope, not the lab's", () => {
  me([]);
  renderWithProviders(
    <RadiologyStation station="worklist" title="Worklist" place="Imaging" stats={[]}><p>work</p></RadiologyStation>,
  );
  const shell = screen.getByTestId("station-shell");
  expect(shell).toHaveAttribute("data-seat", "radiology");
  expect(within(shell).getByRole("heading", { level: 1, name: "Worklist" })).toBeInTheDocument();
});

it("RS1 — the reception screen is a station: the desk's queue sits in the right column", async () => {
  me(["radiology.schedule"]);
  renderWithProviders(<RadiologyReception />);
  const shell = await screen.findByTestId("station-shell");
  expect(shell).toHaveAttribute("data-station", "desk");
  expect(within(screen.getByTestId("station-right")).getByTestId("radiology-desk-queue")).toBeInTheDocument();
});
