import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErMciScreen } from "./er-mci";
import type { ErMciBoard } from "@hmis/contracts";

/** ER lane 8 (#815) — the MCI board: counts by tag in words, a pack registered by its number with one tag tap, a re-tag. */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const MCI = "01J00000000000000000000M01";
const EP = "01J00000000000000000000P01";
const now = new Date().toISOString();
const count = {
  mciId: MCI, name: "Bus collision NH-30", place: "Bypass km 12", declaredAt: now, stoodDownAt: null, asOf: now, total: 3,
  byTag: { red: 1, yellow: 1, green: 0, black: 1, untagged: 0 },
  byOutcome: { inDepartment: 3, admitted: 0, discharged: 0, referredOut: 0, died: 0, left: 0 },
};
const RUNNING: ErMciBoard = {
  active: count, recent: [], packsReady: 37, bays: { free: 4, total: 60 }, surge: { free: 2, total: 2 }, hospitalBedsFree: 41, stops: null, teams: [], serverNow: now,
  patients: [{ episodeId: EP, episodeNo: "ER26-000501", label: "Unknown-MCI26-003", tag: "black", esi: null, bayCode: null, state: "arrived", arrivedAt: now }],
};
const IDLE: ErMciBoard = { ...RUNNING, active: null, patients: [], surge: { free: 0, total: 0 } };

describe("ER lane 8 (#815) the MCI board", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let board: ErMciBoard = RUNNING;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ episodeNo: "ER26-000502", alias: "Unknown-MCI26-004", tag: "red", mciId: MCI, packs: [] });
      }
      if (raw.endsWith("/er/mci")) return json(board);
      if (raw.endsWith("/er/mci/family")) {
        return json({
          mciId: MCI, name: "Bus collision NH-30", asOf: now, withheld: 2, script: ["We do not give the name or the condition of any patient to the press or over the phone."],
          rows: [{ label: "Asha Family", packNo: null, stage: "Being seen", where: "ER · B4" }],
        });
      }
      if (raw.endsWith("/auth/me")) return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["er.mci", "er.arrival.register"], scoped: { department: {}, floor: {} } } });
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); board = RUNNING; });

  it("shows the counts by tag in words, and registers a pack by its number with one tag tap", async () => {
    renderWithRouter(<ErMciScreen />, "/er/mci");
    const tiles = await screen.findByTestId("er-mci-count");
    expect(tiles).toHaveTextContent("Red · Immediate");
    expect(tiles).toHaveTextContent("Black · Expectant");
    expect(screen.getByTestId("er-mci-stats")).toHaveTextContent("41 ward beds free");
    const reg = screen.getByTestId("er-mci-register");
    await userEvent.type(within(reg).getByRole("textbox"), "mci26-004");
    await userEvent.click(within(reg).getByRole("button", { name: "Red · Immediate" }));
    await userEvent.click(screen.getByTestId("er-mci-register-go"));
    expect(posted[0]!.url).toContain("/er/mci/arrivals");
    expect(posted[0]!.body).toMatchObject({ packNo: "mci26-004", tag: "red" });
  });

  it("a Black re-tag waits for the reason", async () => {
    renderWithRouter(<ErMciScreen />, "/er/mci");
    const row = await screen.findByTestId("er-mci-patient");
    const red = within(row).getByTestId("er-mci-tag-red");
    expect(red).toBeDisabled();
    await userEvent.type(within(row).getByRole("textbox"), "Breathing on re-check");
    await userEvent.click(red);
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, tag: "red", reason: "Breathing on re-check" });
  });

  it("#877: the MS answers the OPD / elective OT stop proposal; the answer is shown", async () => {
    board = { ...RUNNING, stops: { state: "proposed", decidedAt: null, note: null } };
    renderWithRouter(<ErMciScreen />, "/er/mci");
    const box = await screen.findByTestId("er-mci-stops");
    expect(box).toHaveTextContent("stop new OPD registrations and elective OT lists");
    await userEvent.type(within(box).getByRole("textbox"), "Till 18:00");
    await userEvent.click(within(box).getByTestId("er-mci-stops-confirm"));
    expect(posted[0]!.url).toContain("/er/mci/stops");
    expect(posted[0]!.body).toMatchObject({ mciId: MCI, decision: "confirm", note: "Till 18:00" });
  });

  it("#877: a decided stop shows the MS's answer, without buttons", async () => {
    board = { ...RUNNING, stops: { state: "declined", decidedAt: now, note: null } };
    renderWithRouter(<ErMciScreen />, "/er/mci");
    expect(await screen.findByTestId("er-mci-stops-answer")).toHaveTextContent("MS declined the stop");
    expect(screen.queryByTestId("er-mci-stops-confirm")).toBeNull();
  });

  it("#877: the family desk lists name, stage and place only, counts the withheld and shows the press script", async () => {
    renderWithRouter(<ErMciScreen />, "/er/mci");
    await userEvent.click(await screen.findByTestId("er-mci-family-open"));
    expect(await screen.findByTestId("er-mci-family-rows")).toHaveTextContent("Asha Family · Being seen · ER · B4");
    expect(screen.getByTestId("er-mci-family-withheld")).toHaveTextContent("Not listed here: 2");
    expect(screen.getByTestId("er-mci-press-script")).toHaveTextContent("We do not give the name");
  });

  it("#877: the teams per zone from the roster, with who is on duty", async () => {
    board = {
      ...RUNNING,
      teams: [
        { zone: "ER", teams: [{ code: "CAS-A", name: "Casualty team A", members: [{ name: "Dr Lead", role: "lead" }] }], onDuty: [{ name: "Sister One", position: "Staff nurse" }] },
        { zone: "Surge · Ward 7", teams: [], onDuty: [] },
      ],
    };
    renderWithRouter(<ErMciScreen />, "/er/mci");
    const zones = await screen.findAllByTestId("er-mci-zone");
    expect(zones[0]).toHaveTextContent("Casualty team A");
    expect(zones[0]).toHaveTextContent("Dr Lead (lead)");
    expect(zones[0]).toHaveTextContent("Sister One · Staff nurse");
    expect(zones[1]).toHaveTextContent("No team on the roster for this zone");
  });

  it("with no Code Yellow running, offers the declaration and the packs", async () => {
    board = IDLE;
    renderWithRouter(<ErMciScreen />, "/er/mci");
    await userEvent.type(within(await screen.findByTestId("er-mci-declare")).getAllByRole("textbox")[0]!, "Factory fire");
    await userEvent.click(screen.getByTestId("er-mci-declare-go"));
    expect(posted[0]!.url).toContain("/er/mci/declare");
    expect(posted[0]!.body).toMatchObject({ name: "Factory fire" });
    expect(screen.getByTestId("er-mci-packs-ready")).toHaveTextContent("37");
  });
});
