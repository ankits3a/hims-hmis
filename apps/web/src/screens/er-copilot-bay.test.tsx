import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErTriage } from "./er-triage";
import type { ErBayProposal } from "@hmis/contracts";

/**
 * #898 — the copilot's bay suggestion on the triage screen (T2): it names one bay with its reasons; only the nurse's tap
 * places the patient, through the screen's own place_in_bay. No card before triage, once in a bay, or with nothing to
 * propose. Server stubbed.
 */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const EP = "01J00000000000000000000P09";
const BED = "01J0000000000000000000BED1";
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.triage", "er.care"], scoped: { department: {}, floor: {} } } };
const tile = (esi: number | null, bayCode: string | null) => ({
  episodeId: EP, episodeNo: "ER26-000123", label: "Ramesh Prasad", labelHi: null, uhid: "HMS0000123", sex: "male", ageBand: null, ageYears: 52,
  state: esi === null ? "arrived" : "triaged", arrivalMode: "walk_in", arrivedAt: new Date().toISOString(), triageDueAt: null, chips: [], esi, bayCode,
  doctor: null, doctorDueAt: null, retriageDueAt: null, ews: null,
});
const PROPOSAL: ErBayProposal = {
  episodeId: EP, bay: { bedId: BED, code: "YELLOW-01", room: "Yellow zone", zone: "yellow" }, none: null, wanted: ["yellow"],
  reasons: ["ESI 3: yellow zone", "YELLOW-01 is free (yellow)"], source: "rules",
};

describe("#898 the copilot's bay suggestion", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let esi: number | null = 3;
  let bayCode: string | null = null;
  let proposal: ErBayProposal = PROPOSAL;
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    esi = 3; bayCode = null; proposal = PROPOSAL;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
        return json({ episodeId: EP, bedId: BED, bayCode: "YELLOW-01" });
      }
      if (raw.includes("/er/copilot/bay/")) return json(proposal);
      if (raw.includes("/er/copilot/")) return json({ statusCode: 404 }, 404);
      if (raw.includes("/er/episodes/")) return json({ tile: tile(esi, bayCode), ageYears: 52, complaint: "pain", history: [] });
      if (raw.endsWith("/er/board")) return json({ generatedAt: new Date().toISOString(), wall: false, stats: { inDepartment: 1, waitingTriage: 0, longestTriageWaitMinutes: 0, expected: 0, arrivalsToday: 1, broughtDeadToday: 0, boarding: 0, lwbsToday: 0, bays: { free: 1, total: 2 } }, expected: [], waiting: [], inTreatment: [tile(esi, bayCode)] });
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  // Absence checks wait for the proposal's own fetch to land, so "no card" is not "not loaded yet".
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

  it("names the bay with its reasons; nothing is placed until the nurse taps, then place_in_bay carries that bay", async () => {
    renderWithRouter(<ErTriage />, `/er/triage?episode=${EP}`);
    const card = await screen.findByTestId("er-triage-bay-copilot");
    expect(card).toHaveTextContent("Suggests YELLOW-01 · Yellow zone");
    expect(card).toHaveTextContent("ESI 3: yellow zone");
    expect(posted).toEqual([]);
    await userEvent.click(within(card).getByTestId("er-triage-bay-copilot-place"));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, bedId: BED });
    expect(await screen.findByText(/YELLOW-01/, { selector: "[role=status]" })).toBeInTheDocument();
  });

  it("no card with nothing to propose, before triage, or once in a bay", async () => {
    proposal = { ...PROPOSAL, bay: null, none: "no_bay", reasons: ["ESI 3: yellow zone", "No free bay in that zone"] };
    const a = renderWithRouter(<ErTriage />, `/er/triage?episode=${EP}`);
    await screen.findByTestId("er-triage-who");
    await settle();
    expect(screen.queryByTestId("er-triage-bay-copilot")).toBeNull();
    a.unmount();
    proposal = PROPOSAL; esi = null;
    const b = renderWithRouter(<ErTriage />, `/er/triage?episode=${EP}`);
    await screen.findByTestId("er-triage-who");
    await settle();
    expect(screen.queryByTestId("er-triage-bay-copilot")).toBeNull();
    b.unmount();
    esi = 3; bayCode = "YELLOW-02";
    renderWithRouter(<ErTriage />, `/er/triage?episode=${EP}`);
    await screen.findByTestId("er-triage-who");
    await settle();
    expect(screen.queryByTestId("er-triage-bay-copilot")).toBeNull();
  });
});
