import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { LabStation } from "../../screens/lab-seat";
import { StationShell } from "./station-shell";

/**
 * PLAN 17-F F1 — the station shell, against the owner's layout ruling (25 Sep 2026).
 *
 * jsdom computes no CSS, so the breakpoints (drawer below 1280, Menu below 1100, switch into the
 * Menu at 1000) are walked in Chromium, not here. What IS pinned here is the part a CSS change
 * cannot fake: who sees which station, that the list is ONE column with the clocks under it, that
 * the clocks fold unless something has run out, and that the list folds only when a copilot takes
 * its place.
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
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("F1 — the station switch shows the stations this person may work, and marks the one they are on", async () => {
  me(["lab.collection.operate", "lab.accession.operate"]);
  renderWithProviders(
    <LabStation station="bench" title="Bench" place="Haematology" stats={[]} list={<p>queue</p>}>
      <p>work</p>
    </LabStation>,
  );
  const sw = within(screen.getByRole("navigation", { name: "Stations" }));
  await waitFor(() => expect(sw.getByRole("link", { name: "Collection" })).toBeInTheDocument());
  expect(sw.getByRole("link", { name: "Bench" })).toHaveAttribute("aria-current", "page");
  expect(sw.getByRole("link", { name: "Collection" })).toHaveAttribute("href", "/lab/collection");
  // No grant, no door: the desk, verify and the report centre are not offered.
  expect(sw.queryByRole("link", { name: "Lab desk" })).toBeNull();
  expect(sw.queryByRole("link", { name: "Verify & report" })).toBeNull();
  expect(sw.queryByRole("link", { name: "Report centre" })).toBeNull();
});

it("F1 — the current station is shown even to a person the switch would otherwise hide it from", () => {
  me([]);
  renderWithProviders(
    <LabStation station="verify" title="Verify" place="Pathology" stats={[]} list={<p>queue</p>}><p>work</p></LabStation>,
  );
  const sw = within(screen.getByRole("navigation", { name: "Stations" }));
  expect(sw.getByRole("link", { name: "Verify & report" })).toHaveAttribute("aria-current", "page");
  expect(sw.getAllByRole("link")).toHaveLength(1);
});

it("F1 — three columns: the station's day in the lane, the work in the centre, the one list on the right", () => {
  me([]);
  renderWithProviders(
    <LabStation
      station="desk"
      title="Lab reception"
      place="Counter L-01"
      stats={[{ label: "arrived on the portal today", value: 4, tone: "live" }]}
      list={<section aria-label="Arrived on the portal"><p>Farida</p></section>}
    >
      <p>the work</p>
    </LabStation>,
  );
  const lane = within(screen.getByRole("complementary", { name: "In hand" }));
  expect(lane.getByRole("heading", { level: 1, name: "Lab reception" })).toBeInTheDocument();
  expect(lane.getByText("Counter L-01")).toBeInTheDocument();
  expect(within(lane.getByRole("list", { name: "Counts this seat watches" })).getByText("4")).toBeInTheDocument();
  expect(within(screen.getByRole("main")).getByText("the work")).toBeInTheDocument();
  const right = within(screen.getByRole("complementary", { name: "List and clocks" }));
  expect(right.getByRole("region", { name: "Arrived on the portal" })).toBeInTheDocument();
  expect(screen.getByTestId("seat-clock")).toBeInTheDocument();
});

it("F1 — Clocks running is folded while nothing has run out, and a click opens it", async () => {
  me([]);
  renderWithProviders(
    <LabStation station="bench" title="Bench" place="H" stats={[]} list={<p>q</p>} clocks={<p>Troponin — call now</p>} clocksSummary="0 open">
      <p>w</p>
    </LabStation>,
  );
  const toggle = screen.getByTestId("station-clocks-toggle");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("0 open")).toBeInTheDocument();
  expect(screen.queryByText("Troponin — call now")).toBeNull();
  await userEvent.click(toggle);
  expect(screen.getByText("Troponin — call now")).toBeInTheDocument();
});

it("F1 — an alert opens the clocks without a click", () => {
  me([]);
  renderWithProviders(
    <LabStation station="bench" title="Bench" place="H" stats={[]} list={<p>q</p>} clocks={<p>Troponin — call now</p>} clocksAlert>
      <p>w</p>
    </LabStation>,
  );
  expect(screen.getByTestId("station-clocks-toggle")).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Troponin — call now")).toBeInTheDocument();
});

function Harness({ inHand, copilot }: { inHand: boolean; copilot?: React.ReactNode }): React.ReactElement {
  return (
    <StationShell brand="Central lab" stations={[]} current="desk" title="t" place="p" stats={[]} statsLabel="c"
      list={<p>Kamla Devi · STAT</p>} listSummary="15 on the list · next Kamla Devi" inHand={inHand} copilot={copilot}>
      <p>w</p>
    </StationShell>
  );
}

it("F1 — with something in hand but no copilot, the list stays: nothing would take its place", () => {
  me([]);
  renderWithProviders(<Harness inHand />);
  expect(screen.getByText("Kamla Devi · STAT")).toBeInTheDocument();
  expect(screen.queryByTestId("station-list-folded")).toBeNull();
});

it("F1 — with something in hand and a copilot, the list folds to one line and the copilot takes the column", async () => {
  me([]);
  renderWithProviders(<Harness inHand copilot={<section aria-label="Copilot">checked</section>} />);
  expect(screen.queryByText("Kamla Devi · STAT")).toBeNull();
  expect(screen.getByTestId("station-list-folded")).toHaveTextContent("15 on the list · next Kamla Devi");
  expect(screen.getByRole("region", { name: "Copilot" })).toBeInTheDocument();
  await userEvent.click(screen.getByTestId("station-list-folded"));
  expect(screen.getByText("Kamla Devi · STAT")).toBeInTheDocument();
});

it("F1 — with nobody in hand the copilot panel is not shown, and the list is whole", () => {
  me([]);
  renderWithProviders(<Harness inHand={false} copilot={<section aria-label="Copilot">checked</section>} />);
  expect(screen.getByText("Kamla Devi · STAT")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Copilot" })).toBeNull();
});
