import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErBoardScreen } from "./er-board";
import { ErPatient } from "./er-patient";
import { ErTriage } from "./er-triage";
import type { ErDraft, ErEsiProposal, ErSinceArrival, ErWaitingDisplay } from "@hmis/contracts";

/**
 * ER lane 9 (#816) — the copilot on the ER screens: the triage suggestion ticks the questions but never picks or saves a
 * level (the nurse's tap does, and the shown level travels as `copilotLevel`); the patient view opens on "since
 * arrival" with source chips; a summary Draft fills the discharge form, stamped "Draft"; the waiting display shows a
 * token and a stage word only. Server stubbed.
 */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const EP = "01J00000000000000000000P09";
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.board.wall", "er.triage", "er.care", "er.disposition"], scoped: { department: {}, floor: {} } } };
const tile = (state: string) => ({
  episodeId: EP, episodeNo: "ER26-000123", label: "Ramesh Prasad", labelHi: null, uhid: "HMS0000123", sex: "male", ageBand: null, ageYears: 52,
  state, arrivalMode: "walk_in", arrivedAt: new Date().toISOString(), triageDueAt: null, chips: [], esi: state === "arrived" ? null : 2, bayCode: null,
  doctor: null, doctorDueAt: null, retriageDueAt: null, ews: null,
});
const PROPOSAL: ErEsiProposal = {
  episodeId: EP, level: 2, word: "ESI 2 Emergent", decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false },
  reasons: ['Complaint: "chest pain" (high risk)', 'Complaint: "chest pain" usually needs tests and treatment'], resourcesGuessed: false,
  basedOn: { complaint: "chest pain since 1 hour", ageYears: 52, vitalsAt: null }, source: "rules",
};
const SINCE: ErSinceArrival = {
  episodeId: EP, asOf: new Date().toISOString(), arrivedAt: new Date().toISOString(),
  lines: [
    { key: "vitals", text: "Vitals 14:30: P 128 · BP 96/58 · SpO2 88% on O2", template: "Vitals 14:30: P 128 · BP 96/58 · SpO2 88% on O2", facts: [], source: "vitals", at: null, abnormal: true, records: [{ id: "v1", at: null, label: "vitals" }] },
    { key: "triage", text: "ESI 2 Emergent at 14:06", template: "ESI 2 Emergent at 14:06", facts: [], source: "triage", at: null, abnormal: true, records: [{ id: "t1", at: null, label: "triage" }] },
    { key: "arrival", text: "Arrived 14:02 · walked in", template: "Arrived 14:02 · walked in", facts: [], source: "arrival", at: null, abnormal: false, records: [{ id: "e1", at: null, label: "arrived" }] },
  ],
};
const DRAFT: ErDraft = {
  episodeId: EP, kind: "summary", label: "Draft", source: "template", modelId: null, fallback: "model_off", builtAt: new Date().toISOString(),
  fields: { diagnosis: "Acute coronary syndrome ruled out", treatmentGiven: "Medicines given: Aspirin 300 mg oral at 14:20." }, unverified: [],
};
const WAITING: ErWaitingDisplay = { generatedAt: new Date().toISOString(), rows: [{ token: "0123", stage: "Being seen", stageHi: "डॉक्टर देख रहे हैं" }] };

describe("ER lane 9 (#816) copilot screens", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  let state = "arrived";
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    state = "arrived";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
        if (raw.includes("/er/copilot/drafts/")) return json(DRAFT);
        return json({ episodeId: EP, level: 1, algorithmLevel: 2, downTriage: false, retriageDueAt: null, doctorDueAt: new Date().toISOString(), ews: null, take: null });
      }
      if (raw.includes("/er/copilot/esi/")) return json(PROPOSAL);
      if (raw.includes("/er/copilot/since/")) return json(SINCE);
      if (raw.endsWith("/er/copilot/waiting")) return json(WAITING);
      if (raw.includes("/er/care/")) return json({ episodeId: EP, stabilisedAt: null, allergyWords: [], notes: [], orders: [], meds: [], procedures: [], consents: [], calls: [], criticals: [] });
      if (raw.includes("/er/episodes/")) return json({ tile: tile(state), ageYears: 52, complaint: "chest pain since 1 hour", history: [] });
      if (raw.endsWith("/er/board")) return json({ generatedAt: new Date().toISOString(), wall: false, stats: { inDepartment: 1, waitingTriage: 1, longestTriageWaitMinutes: 2, expected: 0, arrivalsToday: 1, broughtDeadToday: 0, boarding: 0, lwbsToday: 0, bays: { free: 1, total: 2 } }, expected: [], waiting: [tile(state)], inTreatment: [] });
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the triage suggestion ticks the answers but saves nothing; the nurse's level is the only level sent", async () => {
    renderWithRouter(<ErTriage />, `/er/triage?episode=${EP}`);
    const card = await screen.findByTestId("er-triage-copilot");
    expect(card).toHaveTextContent("Suggests ESI 2 Emergent");
    expect(card).toHaveTextContent('Complaint: "chest pain" (high risk)');
    await userEvent.click(within(card).getByTestId("er-triage-copilot-use"));
    expect(posted).toEqual([]);
    expect(within(screen.getByTestId("er-triage-q-b")).getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId("er-triage-q-c")).getByRole("button", { name: "Two or more" })).toHaveAttribute("aria-pressed", "true");
    // No level is picked for the nurse: Triage stays disabled until they tap one.
    expect(screen.getByTestId("er-triage-save")).toBeDisabled();
    await userEvent.click(within(screen.getByTestId("er-triage-level")).getByRole("button", { name: /^1/ }));
    await userEvent.click(screen.getByTestId("er-triage-save"));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, level: 1, decision: PROPOSAL.decision });
    // The server recomputes the proposal at the tap (review #894): the screen never sends a level of its own.
    expect(posted[0]!.body).not.toHaveProperty("copilotLevel");
  });

  it("the ER patient opens on 'since arrival' with source chips, and a summary Draft fills the discharge form", async () => {
    state = "in_treatment";
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    const since = await screen.findByTestId("er-patient-since");
    const lines = within(since).getAllByTestId("er-patient-since-line");
    expect(lines.map((l) => l.textContent)).toEqual([
      "VitalsVitals 14:30: P 128 · BP 96/58 · SpO2 88% on O2", "TriageESI 2 Emergent at 14:06", "ArrivalArrived 14:02 · walked in",
    ]);
    await userEvent.click(screen.getByTestId("er-patient-bar-dispo"));
    const form = screen.getByTestId("er-patient-dispoform");
    await userEvent.click(within(within(form).getByTestId("er-draft-summary")).getByRole("button"));
    expect(await within(form).findByText("Draft")).toBeInTheDocument();
    expect(within(form).getByLabelText("Diagnosis")).toHaveValue("Acute coronary syndrome ruled out");
    expect(within(form).getByLabelText("Treatment given")).toHaveValue("Medicines given: Aspirin 300 mg oral at 14:20.");
    // The draft is a read: only the draft request went out, no discharge.
    expect(posted.map((p) => p.url)).toEqual([expect.stringContaining(`/er/copilot/drafts/${EP}/summary`)]);
    expect(document.body.textContent ?? "").not.toMatch(/₹|paid|deposit|price/i);
  });

  it("the waiting display shows a token and a stage word, nothing else", async () => {
    renderWithRouter(<ErBoardScreen />, "/er/board?waiting=1");
    const row = await screen.findByTestId("er-waiting-row");
    expect(row).toHaveTextContent("0123");
    expect(row).toHaveTextContent("Being seen");
    expect(screen.getByTestId("er-waiting").textContent ?? "").not.toContain("Ramesh");
  });
});
