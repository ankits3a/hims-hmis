import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpdScribe } from "./opd-scribe";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * ═══ THE DESK SCRIBE — OWNER RULINGS 2026-09-12 AND 2026-10-06 ═══
 *
 * *"Let's enable it [the Desk Scribe] to type the drugs as well as lab tests … typing the
 * prescriptions … will mark the patient as Consulted even if the doctor hasn't … operated
 * dashboard."* The claims that carry the screen, each executed:
 *
 *   1. NOTHING IS TYPED AGAINST A VISIT THE SERVER HAS NOT NAMED — the read-back comes first.
 *   2. ONE SAVE SENDS THE MEDICINES AND THE TESTS, and it goes to the paper road
 *      (`/opd/paper/visits/:id/transcription`) — never to the doctor's issue route and never to the
 *      old draft that waited for a tap nobody came to give.
 *   3. THE SCRIBE CLEARS NO WARNING. A line the checks warn about says "held for the doctor" and
 *      offers no reason box.
 *   4. NO MOUSE IS NEEDED: the whole happy path below is typed.
 */
const BACK = {
  encounterId: "E-1", patientId: "P-1", visitNo: "V2610060004", serviceDate: "2026-10-06",
  patient: { uhid: "U00110049", name: "Geeta Devi", alias: null, administrativeGender: "female", dob: "1984-02-03" },
  doctorCode: "DR-0029", departmentName: "General Medicine", roomName: "R2", filed: [],
};
const PAPER_STATE = {
  encounterId: "E-1", visitNo: "V2610060004", serviceDate: "2026-10-06", status: "waiting",
  patient: { id: "P-1", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false },
  doctorId: "D-1", doctorCode: "DR-0029", doctorName: "Dr Chandan", tokenNo: 4,
  completedVia: null, paperCompletedAt: null, paperCompletedByName: null, evidenceKind: null,
  documents: [], prescription: null, held: null, advisedTests: [], confirmedAt: null, confirmedByName: null,
};
const PARA = { id: "M-1", name: "Paracetamol 500 mg Tablet", form: "Tablet", strength: "500 mg", code: "D0230", routeClass: "oral", salts: ["Paracetamol"], prefix: true, reviewed: true };
const PRICE_LIST = { items: [
  { serviceId: "S-CBC", code: "LAB-CBC", name: "Complete blood count", category: "lab", pricePaise: 25000 },
  { serviceId: "S-LFT", code: "LAB-LFT", name: "Liver function test", category: "lab", pricePaise: 60000 },
] };

function stub(over: Record<string, unknown> = {}): void {
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u-s" }, permissions: { hospital: ["opd.prescription.transcribe", "opd.consult.paper", "opd.visits.read", "patients.read", "formulary.read", "tariff.read"], scoped: { department: {}, floor: {} } } },
    "GET /api/opd/visits/by-number/V2610060004": BACK,
    "GET /api/opd/visits/E-1": { encounter: { id: "E-1" }, feeUnpaid: false, feeBypass: null },
    "GET /api/opd/paper/visits/E-1": PAPER_STATE,
    "GET /api/tariff/price-list": PRICE_LIST,
    "GET /api/opd/paper/sent-back": { items: [] },
    "GET /api/formulary/medicines/search": { items: [PARA] },
    "POST /api/opd/paper/visits/E-1/check": { lines: [] },
    "POST /api/opd/paper/visits/E-1/transcription": (init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { lines: unknown[]; advisedTests?: unknown[] };
      return {
        encounterId: "E-1", visitNo: "V2610060004",
        paper: { outcome: "marked", consulted: true, encounterId: "E-1", visitNo: "V2610060004" },
        prescription: b.lines.length === 0 ? null : { prescriptionId: "RX-1", version: 1, lineCount: b.lines.length },
        held: [], advisedTests: (b.advisedTests ?? []).map((x) => ({ ...(x as object), transcribedBy: "u-s" })),
      };
    },
    ...over,
  });
}
function posted(path: string): Record<string, unknown>[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0] === path)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
}
const calledAny = (fragment: string): boolean => vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(fragment));

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the desk scribe — the doctor's paper, typed", () => {
  it("scan, read-back, type a medicine and a test WITHOUT A MOUSE, Ctrl+Enter — one save to the paper road, and the visit is marked consulted", async () => {
    stub();
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);

    /* The QR on the prescription footer encodes exactly the visit number, so a wedge scanner types this. */
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    /* THE READ-BACK: the server's name for the patient, before a single line is typed. */
    expect(await screen.findByTestId("scribe-name")).toHaveTextContent("Geeta Devi");
    expect(screen.getByTestId("scribe-readback")).toHaveTextContent("V2610060004");
    expect(screen.getByTestId("paper-slip-none")).toBeInTheDocument();

    /* Focus lands in the first medicine box; ↓ Enter picks the catalogue medicine (and its id). */
    const drug = document.getElementById("scribe-drug-0") as HTMLInputElement;
    await waitFor(() => { expect(drug).toHaveFocus(); });
    await user.keyboard("para");
    await screen.findByTestId("scribe-drug-0-hits");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(drug).toHaveValue("Paracetamol 500 mg Tablet");
    await user.keyboard("{Tab}1 tab{Tab}TDS{Tab}5");

    /* The test box: two letters, Enter takes the first match. */
    await user.click(screen.getByTestId("scribe-test-q"));
    await user.keyboard("cbc{Enter}");
    expect(screen.getByTestId("scribe-test-LAB-CBC")).toBeInTheDocument();

    expect(screen.getByTestId("scribe-summary")).toHaveTextContent("1 medicine to the pharmacy · 1 test to the lab");
    await user.keyboard("{Control>}{Enter}{/Control}");

    const saved = await screen.findByTestId("scribe-saved");
    expect(within(saved).getByTestId("scribe-done-sent")).toHaveTextContent("1 medicine sent to the pharmacy");
    expect(within(saved).getByTestId("scribe-done-tests")).toHaveTextContent("1 test sent");
    expect(within(saved).getByTestId("scribe-done-paper")).toHaveTextContent("The visit is now marked consulted.");

    const bodies = posted("/api/opd/paper/visits/E-1/transcription");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      lines: [{ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false, medicineId: "M-1", source: "paper" }],
      advisedTests: [{ serviceId: "S-CBC", code: "LAB-CBC", name: "Complete blood count", pricePaise: 25000 }],
      note: null,
    });
    /* It is the paper road and ONLY the paper road: not the draft that waits for a tap, not the doctor's issue route. */
    expect(calledAny("prescription-draft")).toBe(false);
    expect(calledAny("/api/opd/visits/E-1/prescriptions")).toBe(false);

    /* Enter starts the next slip — the box is empty and focused again. */
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("scribe-visit")).toHaveValue("");
  });

  it("THE SCRIBE CLEARS NO WARNING: a warned line says it is held for the doctor, offers no reason box, and the result lists it as not sent", async () => {
    const PEN_ALERT = { kind: "allergy", hard: true, text: "Allergy on record: Penicillin", substance: "Penicillin" };
    stub({
      "GET /api/formulary/medicines/search": { items: [] },
      "POST /api/opd/paper/visits/E-1/check": { lines: [{ lineIndex: 0, alerts: [PEN_ALERT] }] },
      "POST /api/opd/paper/visits/E-1/transcription": {
        encounterId: "E-1", visitNo: "V2610060004",
        paper: { outcome: "marked", consulted: true, encounterId: "E-1", visitNo: "V2610060004" },
        prescription: null, advisedTests: [],
        held: [{ line: { drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false }, alerts: [PEN_ALERT] }],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    await screen.findByTestId("scribe-name");
    await user.type(document.getElementById("scribe-drug-0")!, "Tab Penicillin V");
    await user.type(screen.getByTestId("scribe-dose-0"), "1 tab");
    await user.type(screen.getByTestId("scribe-freq-0"), "BD");

    const alert = await screen.findByTestId("scribe-alert-0-0");
    expect(alert).toHaveTextContent("Held for the doctor:");
    expect(alert).toHaveTextContent("Allergy on record: Penicillin");
    expect(screen.queryByTestId("scribe-reason-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("scribe-summary")).toHaveTextContent("1 held for the doctor");

    await user.click(screen.getByTestId("scribe-save"));
    const held = await screen.findByTestId("scribe-done-held");
    expect(held).toHaveTextContent("1 medicine held for the doctor — it was not sent");
    expect(held).toHaveTextContent("Tab Penicillin V");
    expect(screen.queryByTestId("scribe-done-sent")).not.toBeInTheDocument();
    /* No override travels from this seat — the body carries lines and nothing that could clear a warning. */
    expect(Object.keys(posted("/api/opd/paper/visits/E-1/transcription")[0]!).sort()).toEqual(["lines", "note"]);
  });

  /**
   * ═══ FOUND BY THE BROWSER WALK, 2026-10-06 — THE KEYSTROKE AFTER ENTER ═══
   *
   * Enter adds a line. The first build moved the focus on a timer, so a scribe typing at speed put
   * the first letter of the next medicine into the DAYS box they had just left — "5" became "5p",
   * no longer a number, and the days were silently erased. `delay: null` is what makes this row
   * honest: user-event's default yields to timers between keys, which is exactly the gap a fast
   * typist does not leave.
   */
  it("Enter moves to the next line IN THE SAME KEYSTROKE — nothing typed straight after it lands in the old line", async () => {
    stub({ "GET /api/formulary/medicines/search": { items: [] } });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    await screen.findByTestId("scribe-name");
    await user.click(document.getElementById("scribe-drug-0")!);
    await user.keyboard("Tab PCM{Tab}1 tab{Tab}TDS{Tab}5{Enter}Tab Pantop");
    expect(screen.getByTestId("scribe-days-0")).toHaveValue("5");
    expect(document.getElementById("scribe-drug-0")).toHaveValue("Tab PCM");
    expect(document.getElementById("scribe-drug-1")).toHaveValue("Tab Pantop");
    /* And a stray letter in the days box is ignored, never allowed to erase the number. */
    await user.type(screen.getByTestId("scribe-days-0"), "x");
    expect(screen.getByTestId("scribe-days-0")).toHaveValue("5");
  });

  it("a medicine with no dose is not sent half-typed: the save is refused on the screen and says why", async () => {
    stub({ "GET /api/formulary/medicines/search": { items: [] } });
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    await screen.findByTestId("scribe-name");
    await user.type(document.getElementById("scribe-drug-0")!, "Tab Cetirizine");
    expect(await screen.findByTestId("scribe-incomplete")).toHaveTextContent("1 medicine has no dose or frequency");
    expect(screen.getByTestId("scribe-save")).toBeDisabled();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(posted("/api/opd/paper/visits/E-1/transcription")).toHaveLength(0);
  });

  it("what this desk typed before comes back into the table, held lines included — a second save must not type the first away", async () => {
    stub({
      "GET /api/opd/paper/visits/E-1": {
        ...PAPER_STATE, status: "completed", completedVia: "paper", paperCompletedByName: "Priya Kumari",
        prescription: { id: "RX-1", version: 1, issuedAt: "2026-10-06T05:00:00.000Z", transcribedByName: "Priya Kumari", lines: [{ drug: "Tab Paracetamol", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false }] },
        held: { lines: [{ drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false }], alerts: [[]], note: "line 2 unclear", draftedByName: "Priya Kumari", draftedAt: "2026-10-06T05:00:00.000Z" },
        advisedTests: [{ serviceId: "S-LFT", code: "LAB-LFT", name: "Liver function test", pricePaise: 60000, transcribedBy: "u-p", transcribedByName: "Priya Kumari" }],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    await waitFor(() => { expect(document.getElementById("scribe-drug-1")).toHaveValue("Tab Penicillin V"); });
    expect(document.getElementById("scribe-drug-0")).toHaveValue("Tab Paracetamol");
    expect(screen.getByTestId("scribe-test-LAB-LFT")).toBeInTheDocument();
    expect(screen.getByTestId("scribe-note")).toHaveValue("line 2 unclear");
    expect(screen.getByTestId("scribe-status")).toHaveTextContent("Already marked consulted from paper by Priya Kumari");
  });

  it("the doctor issued on the screen: no medicine table to type over it — the tests can still be typed and saved alone", async () => {
    stub({
      "GET /api/opd/paper/visits/E-1": {
        ...PAPER_STATE, status: "completed",
        prescription: { id: "RX-9", version: 1, issuedAt: "2026-10-06T05:00:00.000Z", transcribedByName: null, lines: [{ drug: "Tab X", dose: "1", route: "oral", frequency: "OD", durationDays: null, instructions: null, noSubstitution: false }] },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610060004{Enter}");
    expect(await screen.findByTestId("scribe-doctor-issued")).toBeInTheDocument();
    expect(screen.queryByTestId("scribe-lines")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("scribe-test-q"), "liver{Enter}");
    await user.click(screen.getByTestId("scribe-save"));
    await screen.findByTestId("scribe-saved");
    expect(posted("/api/opd/paper/visits/E-1/transcription")[0]).toMatchObject({ lines: [], advisedTests: [{ serviceId: "S-LFT" }] });
  });

  it("a number the server does not know is said so, and nothing can be typed against it", async () => {
    stub();
    const user = userEvent.setup();
    renderWithProviders(<OpdScribe />);
    await user.type(screen.getByTestId("scribe-visit"), "V2610069999{Enter}");
    expect(await screen.findByTestId("scribe-not-found")).toHaveTextContent("V2610069999");
    expect(screen.queryByTestId("scribe-lines")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scribe-save")).not.toBeInTheDocument();
  });

  it("what a doctor sent back is listed with the reason; a tap opens that visit, and 'I have looked again' answers it (decision 0043)", async () => {
    const SENT = { ...PAPER_STATE, encounterId: "E-1", visitNo: "V2610060004", patient: { id: "P-1", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false }, doctorCode: "DR-0029",
      recheck: { reason: "Line 1 — I wrote 650, not 500", askedAt: "2026-10-06T06:00:00.000Z", askedByName: "Dr Chandan", doneAt: null, doneByName: null, doneNote: null } };
    stub({ "GET /api/opd/paper/sent-back": { items: [SENT] }, "POST /api/opd/paper/visits/E-1/recheck-done": SENT });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<OpdScribe />);
    const box = await screen.findByTestId("scribe-sent-back");
    expect(box).toHaveTextContent("1 paper the doctor sent back");
    expect(box).toHaveTextContent("Doctor asks: Line 1 — I wrote 650, not 500");
    await user.click(screen.getByTestId("scribe-looked-V2610060004"));
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([input, init]) => init?.method === "POST" && String(input).includes("/opd/paper/visits/E-1/recheck-done"))).toBe(true);
    });
    await user.click(within(screen.getByTestId("scribe-sent-back-V2610060004")).getAllByRole("button")[0]!);
    expect(await screen.findByTestId("scribe-name")).toHaveTextContent("Geeta Devi");
  });
});
