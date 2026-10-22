import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErBoardScreen } from "./er-board";
import { ErDesk, istClockToIso } from "./er-desk";
import { ErTriage } from "./er-triage";
import type { ErBoard, ErDeskView, ErTile } from "@hmis/contracts";

/**
 * ER lane 1 (#808) — the ER desk (an unknown in three taps, the refusal in words, a stale band) and the tracking board
 * (clocks in words, wall mode, no money anywhere). Server stubbed.
 */
const NOW = Date.now();
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const tile = (over: Partial<ErTile>): ErTile => ({
  episodeId: "e1", episodeNo: "ER26-000101", label: "Unknown-0007", labelHi: "अज्ञात-0007", uhid: "HMS0000101", sex: "male",
  ageBand: "young_adult", ageYears: null, state: "arrived", arrivalMode: "ambulance_108", arrivedAt: iso(-9), triageDueAt: iso(-4),
  chips: ["unidentified", "ambulance"], esi: null, bayCode: null, doctor: null, doctorDueAt: null, retriageDueAt: null, ews: null, ...over,
});
const BOARD: ErBoard = {
  generatedAt: iso(0), wall: false,
  stats: { inDepartment: 2, waitingTriage: 2, longestTriageWaitMinutes: 9, expected: 1, arrivalsToday: 7, broughtDeadToday: 0, bays: { free: 52, total: 60 } },
  expected: [{ preAlertId: "p1", mode: "ambulance_108", expectedAt: iso(6), expiresAt: iso(126), count: 2, arrivedCount: 0, sex: "male", ageBand: null, complaint: "Road accident", patientId: null, patientLabel: null }],
  waiting: [tile({}), tile({ episodeId: "e2", episodeNo: "ER26-000102", label: "Ramesh Kumar", labelHi: null, ageYears: 41, ageBand: null, arrivedAt: iso(-2), triageDueAt: iso(3), chips: ["name_alert"], arrivalMode: "walk_in" })],
  inTreatment: [],
};
const DESK: ErDeskView = {
  generatedAt: iso(0), expected: [],
  episodes: [{
    episodeId: "e9", episodeNo: "ER26-000090", patientId: "01J00000000000000000000009", uhid: "HMS0000090", name: "Sita Devi", nameHi: null,
    unidentified: false, sex: "female", ageBand: null, ageYears: 37, state: "arrived", arrivalMode: "walk_in", arrivedAt: iso(-30), registeredAt: iso(-12),
    returnedWithin24h: false, band: { serial: "ER26-000090-1", stale: true }, identity: { mergeRequestId: "01J0000000000000000000000M", stage: "merged", trueUhid: "HMS0000090" },
  }],
};

describe("ER lane 1 (#808) screens", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let refuse: Record<string, unknown> | null;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    refuse = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (refuse !== null) return json(refuse, 409);
        return json({
          episodeId: "e3", episodeNo: "ER26-000103", patientId: "01J00000000000000000000003", uhid: "HMS0000103", state: "arrived",
          arrivedAt: iso(0), registeredAt: iso(0), returnedWithin24h: false, alias: "Unknown-0008", aliasHi: "अज्ञात-0008",
          band: { bandId: "b3", bandSerial: "ER26-000103-1", printedAt: iso(0), band: {
            name: "Unknown-0008", nameHi: "अज्ञात-0008", uhid: "HMS0000103", ageSex: "~30 y U", episodeNo: "ER26-000103", arrivedOn: "15 Oct 2026, 14:02",
            allergyWords: ["Allergy: unknown"], alertWords: ["Unidentified"], size: "adult", site: "wrist", barcode: "ER26-000103-1", qr: "ERBAND1|ER26-000103-1|HMS0000103",
          } },
        });
      }
      if (raw.includes("/er/board")) return json(raw.includes("/er/board/wall") ? { ...BOARD, wall: true } : BOARD);
      if (raw.endsWith("/er/desk")) return json(DESK);
      if (raw.endsWith("/auth/me")) {
        return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.arrival.register"], scoped: { department: {}, floor: {} } } });
      }
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("an unknown patient is three taps — sex, age band, Register — and the band comes back to print", async () => {
    renderWithRouter(<ErDesk />, "/er/desk");
    const register = await screen.findByTestId("er-desk-register-unknown");
    expect(register).toBeDisabled();
    await userEvent.click(within(screen.getByTestId("er-desk-sex")).getByText("Not known"));
    await userEvent.click(within(screen.getByTestId("er-desk-age")).getByText("Adult ~30"));
    await userEvent.click(register);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toContain("/er/arrivals/unidentified");
    expect(posted[0]!.body).toMatchObject({ sex: "unknown", ageBand: "young_adult", arrivalMode: "walk_in" });
    expect(Object.keys(posted[0]!.body).sort()).toEqual(["ageBand", "arrivalMode", "idempotencyKey", "sex"]);
    const band = await screen.findByTestId("er-desk-band");
    expect(band).toHaveTextContent("Unknown-0008");
    expect(band).toHaveTextContent("Allergy: unknown · Unidentified");
  });

  it("a refusal shows its rule and its fix in words", async () => {
    refuse = { statusCode: 409, code: "episode_already_open", message: "x", rule: "x", fix: "y", detail: { episodeId: "e9" } };
    renderWithRouter(<ErDesk />, "/er/desk");
    await userEvent.click(within(await screen.findByTestId("er-desk-sex")).getByText("Male"));
    await userEvent.click(within(screen.getByTestId("er-desk-age")).getByText("Elderly ~70"));
    await userEvent.click(screen.getByTestId("er-desk-register-unknown"));
    expect(await screen.findByTestId("er-desk-refusal")).toHaveTextContent("Already in the ER — one open episode per patient.");
    expect(screen.getByTestId("er-desk-refusal")).toHaveTextContent("Open current episode");
  });

  it("the desk row says when the band names someone else now, and that the patient was entered late", async () => {
    renderWithRouter(<ErDesk />, "/er/desk");
    const row = await screen.findByTestId("er-desk-row");
    expect(row).toHaveTextContent("Band shows the old name");
    expect(row).toHaveTextContent("Identified → HMS0000090");
    expect(row).toHaveTextContent(/Came \d\d:\d\d · entered \d\d:\d\d/);
  });

  it("the board words its clocks: overdue triage, the ambulance's ETA, the count — and never money", async () => {
    renderWithRouter(<ErBoardScreen />, "/er/board");
    const tiles = await screen.findAllByTestId("er-board-tile");
    expect(tiles[0]).toHaveTextContent("Unknown-0007");
    expect(tiles[0]).toHaveTextContent(/Triage overdue \d+ min/);
    expect(tiles[0]).toHaveTextContent("Unidentified");
    expect(tiles[1]).toHaveTextContent(/Triage in \d+ min/);
    expect(tiles[1]).toHaveTextContent("Name alert");
    const exp = screen.getByTestId("er-board-expected");
    expect(exp).toHaveTextContent(/In \d+ min/);
    expect(exp).toHaveTextContent("0 of 2 came");
    expect(document.body.textContent ?? "").not.toMatch(/₹|paid|deposit|bill/i);
  });

  it("a brought-dead retry after a failed send carries the same examination time and the same key", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (fail) { fail = false; return json({ statusCode: 500, message: "upstream" }, 500); }
        return json({ episodeId: "e4", episodeNo: "ER26-000104", patientId: "01J00000000000000000000004", uhid: "HMS0000104", alias: "Unknown-0009" });
      }
      if (raw.endsWith("/er/doctors")) return json([{ userId: "01J0000000000000000000000D", name: "Dr Anil" }]);
      if (raw.endsWith("/er/desk")) return json(DESK);
      if (raw.endsWith("/auth/me")) {
        return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.arrival.register"], scoped: { department: {}, floor: {} } } });
      }
      return json([]);
    }));
    renderWithRouter(<ErDesk />, "/er/desk");
    await userEvent.click(await screen.findByTestId("er-desk-tab-dead"));
    await userEvent.click(within(screen.getByTestId("er-desk-dead-sex")).getByText("Male"));
    await userEvent.click(within(screen.getByTestId("er-desk-dead-age")).getByText("Adult ~50"));
    await userEvent.selectOptions(await screen.findByTestId("er-desk-dead-doctor"), "01J0000000000000000000000D");
    await userEvent.click(screen.getByTestId("er-desk-dead-record"));
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 5));
    await userEvent.click(screen.getByTestId("er-desk-dead-record"));
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body.idempotencyKey).toBe(posted[0]!.body.idempotencyKey);
    expect(posted[1]!.body.examinedAt).toBe(posted[0]!.body.examinedAt);
  });

  it("a time typed at the desk is today's IST time, or yesterday's when it is later than now", () => {
    const now = Date.parse("2026-06-01T10:00:00Z"); // 15:30 IST — a fixed instant passed in, not the clock read
    expect(istClockToIso("15:10", now)).toBe("2026-06-01T09:40:00.000Z");
    expect(istClockToIso("23:50", now)).toBe("2026-05-31T18:20:00.000Z");
    expect(istClockToIso("abc", now)).toBeNull();
  });
});

/** ER lane 2 (#809) — the triage screen: the four questions give a proposal; a down-triage opens the reason box. */
describe("ER lane 2 (#809) triage screen", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  const view = {
    tile: tile({ episodeId: "01J00000000000000000000T01", label: "Unknown-0011", labelHi: "अज्ञात-0011" }),
    ageYears: null, complaint: "Chest pain since morning", history: [],
  };
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ episodeId: view.tile.episodeId, level: 3, algorithmLevel: 2, downTriage: true, retriageDueAt: iso(30), doctorDueAt: iso(20), ews: null, take: null });
      }
      if (raw.includes("/er/episodes/")) return json(view);
      if (raw.includes("/er/board")) return json(BOARD);
      if (raw.endsWith("/er/bays")) return json([{ bedId: "01J00000000000000000000B01", code: "ER-R1", zone: "Resus", status: "free", episodeId: null }]);
      if (raw.endsWith("/er/triage-doctors")) return json([{ userId: "d1", name: "Dr Ritu Singh" }]);
      if (raw.endsWith("/auth/me")) return json({ actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.triage"], scoped: { department: {}, floor: {} } } });
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the four answers show the ESI proposal; picking less urgent asks why, and the reason goes with the triage", async () => {
    renderWithRouter(<ErTriage />, `/er/triage?episode=${view.tile.episodeId}`);
    await screen.findByTestId("er-triage-who");
    const save = screen.getByTestId("er-triage-save");
    await userEvent.click(within(screen.getByTestId("er-triage-q-a")).getByText("No"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-b")).getByText("Yes"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-c")).getByText("Two or more"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-d")).getByText("No"));
    expect(screen.getByTestId("er-triage-proposal")).toHaveTextContent("ESI 2 · Emergent");
    await userEvent.click(within(screen.getByTestId("er-triage-level")).getByText("Urgent"));
    expect(save).toBeDisabled();
    await userEvent.type(within(screen.getByTestId("er-triage-reason")).getByRole("textbox"), "Pain settled");
    await userEvent.click(save);
    expect(posted[0]!.url).toContain("/er/triage");
    expect(posted[0]!.body).toMatchObject({ level: 3, reason: "Pain settled", decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } });
    expect(document.body.textContent ?? "").not.toMatch(/₹|paid|deposit|bill/i);
  });

  it("an up-triage asks no reason", async () => {
    renderWithRouter(<ErTriage />, `/er/triage?episode=${view.tile.episodeId}`);
    await screen.findByTestId("er-triage-who");
    await userEvent.click(within(screen.getByTestId("er-triage-q-a")).getByText("No"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-b")).getByText("No"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-c")).getByText("None"));
    await userEvent.click(within(screen.getByTestId("er-triage-q-d")).getByText("No"));
    await userEvent.click(within(screen.getByTestId("er-triage-level")).getByText("Emergent"));
    expect(screen.queryByTestId("er-triage-reason")).toBeNull();
    expect(screen.getByTestId("er-triage-save")).toBeEnabled();
  });
});
