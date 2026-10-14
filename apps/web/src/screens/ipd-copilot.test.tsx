import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdDischarge } from "./ipd-discharge";
import { IpdMyShift } from "./ipd-my-shift";
import { draftOf, fid, handoversOf, myShiftOf, shiftHandover } from "./ipd-nursing.fixture";
import { SinceYesterday } from "./ipd-since";
import type { IpdDischargeDraft, IpdDischargeTracker, IpdHandoverDraft, IpdSinceYesterday, IpdSummaryView } from "@hmis/contracts";

/*
  E5.3 (#740) "Since yesterday", E5.4 (#741) the SBAR draft and the discharge drafter — the three surfaces. Every value is
  synthetic: ids are `01FAKE…`, names are invented, the bodies are fixtures shaped by the contract
  (`packages/contracts/src/ipd/copilot.ts`). No model is involved: the API is a stub.
*/

const copilot = vi.hoisted(() => ({ getSince: vi.fn(), polishSince: vi.fn(), buildSbarDraft: vi.fn(), buildDischargeDraft: vi.fn() }));
vi.mock("../lib/ipd-copilot-api", () => copilot);
const nursing = vi.hoisted(() => ({ getMyShift: vi.fn(), getShiftHandovers: vi.fn(), getHandoverDraft: vi.fn(), giveShiftHandover: vi.fn(), acceptShiftHandover: vi.fn() }));
vi.mock("../lib/ipd-nursing-api", async (orig) => ({ ...(await orig<typeof import("../lib/ipd-nursing-api")>()), ...nursing }));
const discharge = vi.hoisted(() => ({ getDischargeBoard: vi.fn(), getDischargeTracker: vi.fn(), getSummary: vi.fn(), saveSummary: vi.fn(), signSummary: vi.fn() }));
vi.mock("../lib/ipd-discharge-api", async (orig) => ({ ...(await orig<typeof import("../lib/ipd-discharge-api")>()), ...discharge }));
vi.mock("../lib/patients-api", async (orig) => ({ ...(await orig<typeof import("../lib/patients-api")>()), listPatientDocuments: vi.fn(async () => []) }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const NOW = "2026-03-11T12:30:00.000Z"; // 18:00 IST
const MONEY = /₹|paise|rupee|\bfee\b|\bcharges?\b|\bbill\b|payable|deposit|price/i;

const plain: IpdSinceYesterday = {
  admissionId: id(1), asOf: NOW, since: "2026-03-11T01:20:00.000Z", sinceBasis: "last_round", mode: "timeline", stamp: null, polishable: true, truncated: [],
  lines: [
    { key: "ews", text: "NEWS2 reached medium (5 at 12:30), now low — latest 2 at 16:05", source: "ews", abnormal: true, by: "template",
      records: [{ id: id(11), at: "2026-03-11T07:00:00.000Z", label: "NEWS2 5 (medium) at 12:30" }, { id: id(12), at: "2026-03-11T10:35:00.000Z", label: "NEWS2 2 (low) at 16:05" }] },
    { key: "vital:temperatureC", text: "Temperature max 38.9 °C, min 37.1 °C, latest 37.2 °C over 3 readings", source: "vitals", abnormal: true, by: "template",
      records: [{ id: id(11), at: "2026-03-11T07:00:00.000Z", label: "Temp 38.9 °C at 12:30" }] },
    { key: "io", text: "Intake 600 ml, output 350 ml, balance +250 ml", source: "io", abnormal: false, by: "template", records: [{ id: id(13), at: null, label: "In 600 ml (oral) at 09:30" }] },
    { key: "orders:active", text: "No change to orders — 4 active", source: "order", abnormal: false, by: "template", records: [{ id: id(14), at: null, label: "Test Medicine 500 mg" }] },
  ],
};
const reworded: IpdSinceYesterday = {
  ...plain, mode: "model", polishable: false,
  stamp: { label: "Draft", source: "model", modelId: "stub-model-1", promptVersion: "ipd-since-v1", builtAt: NOW },
  lines: plain.lines.map((l) => (l.key === "io" ? { ...l, by: "model" as const, text: "Fluids: intake 600 ml, output 350 ml, balance +250 ml" } : l)),
};

const PERMS = ["ipd.round.sign", "ipd.nursing.view", "ipd.vitals.record", "ipd.handover.shift", "ipd.discharge.view", "ipd.discharge.declare"];

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } }), { status: 200 })));
  for (const f of [...Object.values(copilot), ...Object.values(nursing), ...Object.values(discharge)]) f.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("Since yesterday (E5.3)", () => {
  it("draws the record's lines at once, each with a source chip that opens its records; the model's copy arrives later", async () => {
    copilot.getSince.mockResolvedValue(plain);
    let arrive: (v: IpdSinceYesterday) => void = () => {};
    copilot.polishSince.mockReturnValue(new Promise<IpdSinceYesterday>((resolve) => { arrive = resolve; }));
    renderWithRouter(<SinceYesterday admissionId={id(1)} />, "/");
    const block = await screen.findByTestId("ipd-since");
    // On screen before any model has answered: the plain timeline, labelled as one.
    expect(block).toHaveTextContent("Since 06:50 today");
    expect(screen.getByTestId("ipd-since-mode")).toHaveTextContent("Plain timeline");
    const lines = within(block).getAllByRole("listitem");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent("Needs attention: NEWS2 reached medium (5 at 12:30), now low — latest 2 at 16:05");
    // Every line has its chip; the chip opens the records.
    for (const l of plain.lines) expect(within(screen.getByTestId(`ipd-since-line-${l.key}`)).getByRole("button")).toBeInTheDocument();
    const chip = within(screen.getByTestId("ipd-since-line-ews")).getByRole("button", { name: "Warning score · 2" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("ipd-since-line-ews")).toHaveTextContent("NEWS2 5 (medium) at 12:30");
    expect(block.textContent ?? "").not.toMatch(MONEY);

    arrive(reworded);
    await waitFor(() => expect(screen.getByTestId("ipd-since-mode")).toHaveTextContent("AI wording · stub-model-1 · ipd-since-v1"));
    expect(screen.getByTestId("ipd-since-line-io")).toHaveTextContent("Fluids: intake 600 ml, output 350 ml, balance +250 ml");
    expect(within(screen.getByTestId("ipd-since-line-io")).getByText("AI wording")).toBeInTheDocument();
    expect(within(screen.getByTestId("ipd-since-line-ews")).queryByText("AI wording")).toBeNull();
  });

  it("model down: the plain timeline stays; the page never waits and never errors", async () => {
    copilot.getSince.mockResolvedValue(plain);
    copilot.polishSince.mockRejectedValue(new Error("model down"));
    renderWithRouter(<SinceYesterday admissionId={id(1)} />, "/");
    await screen.findByTestId("ipd-since");
    await waitFor(() => expect(copilot.polishSince).toHaveBeenCalledWith(id(1)));
    expect(screen.getByTestId("ipd-since-mode")).toHaveTextContent("Plain timeline");
    expect(screen.getByTestId("ipd-since-line-io")).toHaveTextContent("Intake 600 ml, output 350 ml, balance +250 ml");
    // Not polishable (a sealed patient, or no model): nothing is asked.
    copilot.polishSince.mockClear();
    copilot.getSince.mockResolvedValue({ ...plain, polishable: false, sinceBasis: "24h", since: "2026-03-10T03:40:00.000Z" });
    renderWithRouter(<SinceYesterday admissionId={id(2)} />, "/");
    await waitFor(() => expect(screen.getAllByTestId("ipd-since")).toHaveLength(2));
    expect(screen.getAllByTestId("ipd-since")[1]).toHaveTextContent("Since yesterday 09:10");
    expect(copilot.polishSince).not.toHaveBeenCalled();
  });
});

describe("SBAR draft on my shift (E5.4)", () => {
  const kept = (admissionId: string): IpdHandoverDraft => {
    const d = draftOf(admissionId);
    return {
      ...d, draftId: id(77), stamp: { label: "Draft", source: "model", modelId: "stub-model-1", promptVersion: "ipd-sbar-v1", builtAt: NOW },
      assessment: [...d.assessment, { text: "Slept in the afternoon; no pain.", source: "note", by: "model", records: [] }],
    };
  };

  it("shows the stamp, fills the model's sentence only into an untouched form, and the give names the draft", async () => {
    nursing.getMyShift.mockResolvedValue(myShiftOf(Date.now()));
    nursing.getShiftHandovers.mockResolvedValue(handoversOf(Date.now(), [shiftHandover(Date.now(), {
      draft: { draftId: id(70), source: "template", modelId: null, promptVersion: "ipd-sbar-v1", builtAt: NOW, builtBy: { id: "u-fake-3", name: "Sister Builder" }, edited: true },
    })]));
    nursing.getHandoverDraft.mockImplementation(async (a: string) => draftOf(a));
    nursing.giveShiftHandover.mockResolvedValue({});
    copilot.buildSbarDraft.mockImplementation(async (a: string) => kept(a));
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    await userEvent.click(await screen.findByTestId("ipdn-handover-open"));
    const pane = await screen.findByTestId("ipdn-handover");
    // A handover waiting for me: signed by a named nurse, and it says which draft it came from.
    expect(within(pane).getByTestId(`ipdn-shift-handover-${fid(701)}`)).toHaveTextContent("Sister Fake");
    // …by whom it was built, and that the signer changed its words.
    expect(within(pane).getByTestId("ipdn-handover-prov")).toHaveTextContent("From copilot draft · Template · ipd-sbar-v1 · built by Sister Builder · edited");

    // READ FIRST: opening a patient reads; nothing is built until the nurse asks.
    await userEvent.click(within(pane).getAllByRole("button", { name: /Draft SBAR/ })[0]!);
    await waitFor(() => expect(within(pane).getByDisplayValue("Day 7. NEWS2 1 at 09:10, falling.")).toBeInTheDocument());
    expect(copilot.buildSbarDraft).not.toHaveBeenCalled();
    await userEvent.click(within(pane).getByTestId("ipdn-sbar-build"));
    const stamp = await within(pane).findByTestId("ipdn-sbar-stamp");
    expect(stamp).toHaveTextContent("Draft · stub-model-1 · ipd-sbar-v1 · built");
    expect(within(pane).queryByTestId("ipdn-sbar-build")).toBeNull();
    expect(stamp).toHaveTextContent("you edit and sign");
    await waitFor(() => expect(within(pane).getByDisplayValue(/Slept in the afternoon; no pain\./)).toBeInTheDocument());
    expect(nursing.giveShiftHandover).not.toHaveBeenCalled();
    await userEvent.click(within(pane).getByRole("button", { name: "Give" }));
    await waitFor(() => expect(nursing.giveShiftHandover).toHaveBeenCalledWith(fid(101), expect.objectContaining({ assessment: expect.stringContaining("Slept in the afternoon; no pain.") as unknown }), id(77)));
  });

  it("reads the kept draft without building; builds by itself only when the records changed; a stale give offers the rebuild", async () => {
    nursing.getMyShift.mockResolvedValue(myShiftOf(Date.now()));
    nursing.getShiftHandovers.mockResolvedValue(handoversOf(Date.now(), []));
    // A kept draft whose records are unchanged: shown as it is, with its id — no build.
    nursing.getHandoverDraft.mockImplementation(async (a: string) => kept(a));
    copilot.buildSbarDraft.mockImplementation(async (a: string) => ({ ...kept(a), draftId: id(78) }));
    nursing.giveShiftHandover.mockRejectedValueOnce(new ApiError(409, { statusCode: 409, code: "shift_handover_draft_stale", message: "changed" })).mockResolvedValue({});
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    await userEvent.click(await screen.findByTestId("ipdn-handover-open"));
    const pane = await screen.findByTestId("ipdn-handover");
    await userEvent.click(within(pane).getAllByRole("button", { name: /Draft SBAR/ })[0]!);
    await within(pane).findByTestId("ipdn-sbar-stamp");
    expect(copilot.buildSbarDraft).not.toHaveBeenCalled();
    expect(within(pane).queryByTestId("ipdn-sbar-build")).toBeNull();
    // The server refuses the give (records changed since the build): the screen says so and offers "Build again".
    await userEvent.click(within(pane).getByRole("button", { name: "Give" }));
    expect(await within(pane).findByTestId("ipdn-sbar-stale")).toHaveTextContent("Records changed. Build again.");
    expect(nursing.giveShiftHandover).toHaveBeenLastCalledWith(fid(101), expect.anything(), id(77));
    await userEvent.click(within(pane).getByRole("button", { name: "Build again" }));
    await waitFor(() => expect(copilot.buildSbarDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(pane).queryByTestId("ipdn-sbar-stale")).toBeNull());
    await userEvent.click(within(pane).getByRole("button", { name: "Give" }));
    await waitFor(() => expect(nursing.giveShiftHandover).toHaveBeenLastCalledWith(fid(101), expect.anything(), id(78)));
  });

  it("builds without a tap when the kept draft is older than the records", async () => {
    nursing.getMyShift.mockResolvedValue(myShiftOf(Date.now()));
    nursing.getShiftHandovers.mockResolvedValue(handoversOf(Date.now(), []));
    nursing.getHandoverDraft.mockImplementation(async (a: string) => ({ ...draftOf(a), changedSinceDraft: true }));
    copilot.buildSbarDraft.mockImplementation(async (a: string) => kept(a));
    renderWithRouter(<IpdMyShift />, "/ipd/my-shift");
    await userEvent.click(await screen.findByTestId("ipdn-handover-open"));
    const pane = await screen.findByTestId("ipdn-handover");
    await userEvent.click(within(pane).getAllByRole("button", { name: /Draft SBAR/ })[0]!);
    await waitFor(() => expect(copilot.buildSbarDraft).toHaveBeenCalledWith(fid(101)));
    expect(await within(pane).findByTestId("ipdn-sbar-stamp")).toHaveTextContent("stub-model-1");
  });
});

describe("Discharge drafter (E5.4)", () => {
  const tracker: IpdDischargeTracker = {
    admissionId: id(1), admissionNo: "IP26-000101", state: "fit_declared",
    patient: { id: id(2), uhid: "UH-FAKE-1", name: "Test Patient One", ageSex: "F 52" }, bedCode: "F05-MED-B01", wardName: "5A Medicine",
    consultant: { id: "u-doc", name: "Fake Rao" }, disposition: "home", fitAt: NOW, targetAt: NOW,
    steps: [{ key: "fit", state: "done", at: NOW, waitingFor: null }, { key: "summary", state: "now", at: null, waitingFor: "Dr Fake Rao" }],
    departments: [], summary: { status: "none", signedBy: null, version: 0 }, gatePass: null, exit: null, blocker: "Summary not signed", bill: null,
    can: { declareFit: false, cancelFit: false, confirm: [], editSummary: true, signSummary: true, settle: false, issueGatePass: false, scan: false, exit: false },
  };
  const draft: IpdDischargeDraft = {
    draftId: id(88), admissionId: id(1),
    stamp: { label: "Draft", source: "template", modelId: null, promptVersion: "ipd-discharge-v1", builtAt: NOW },
    content: {
      diagnosis: { text: "Community-acquired pneumonia" }, course: "Admitted 10 Mar 2026; day 3 of stay. 12 Mar 2026 — Afebrile; plan: Home tomorrow.",
      procedures: "", conditionAtDischarge: "", followUp: "", advice: "", warningSigns: "", pendingResults: "Blood culture",
      medicines: [{ name: "Test Medicine 500 mg", dose: "500 mg", frequency: "TDS", duration: "5 days", source: "order", orderId: id(60) }],
    },
    sources: [{ field: "medicines", source: "order", records: [{ id: id(60), at: NOW, label: "Test Medicine 500 mg" }] }],
    flags: [{ name: "warfarin", where: "course", index: null, reason: "model_invented" }, { name: "asprin", where: "course", index: null, reason: "unverified" }],
    truncated: ["orders"], complete: false,
  };

  it("fills the editor from the record with the stamp and the flags; the save names the draft and keeps the order rows; nothing signs itself", async () => {
    discharge.getDischargeBoard.mockResolvedValue({ rows: [] });
    discharge.getDischargeTracker.mockResolvedValue(tracker);
    discharge.getSummary.mockRejectedValue(new Error("none"));
    copilot.buildDischargeDraft.mockResolvedValue(draft);
    const saved: IpdSummaryView = {
      summaryId: id(90), admissionId: id(1), status: "draft", version: 1, content: draft.content, label: "Draft",
      provenance: { source: "copilot_draft", draftModelId: null, draftPromptVersion: "ipd-discharge-v1", draftedBy: { id: "u-doc", name: "Fake Rao" }, draftedAt: NOW,
        draft: { draftId: id(88), source: "template", modelId: null, promptVersion: "ipd-discharge-v1", builtAt: NOW, builtBy: { id: "u-doc", name: "Fake Rao" }, edited: null } },
      stamp: { label: "Draft", source: "template", modelId: null, promptVersion: "ipd-discharge-v1", builtAt: NOW },
      medicineFlags: [{ name: "Vitamin C 500 mg", where: "medicines", index: 1, reason: "no_active_order" }],
      residentSignedBy: null, signedBy: null, signedAt: null, documentId: null,
    };
    discharge.saveSummary.mockResolvedValue(saved);
    renderWithRouter(<IpdDischarge />, `/ipd/discharge?admission=${id(1)}`);
    await userEvent.click(await screen.findByTestId("ipdd-draft-from-record"));
    const stamp = await screen.findByTestId("ipdd-draft-stamp");
    expect(stamp).toHaveTextContent("Draft · Template · ipd-discharge-v1 · built");
    expect(stamp).toHaveTextContent("check, edit and sign");
    expect(screen.getByTestId("ipdd-medicine-flags")).toHaveTextContent("warfarin — on no order — model text dropped");
    expect(screen.getByTestId("ipdd-medicine-flags")).toHaveTextContent("asprin — not in notes or orders — check");
    // A list cut at the limit is said, in words.
    expect(screen.getByTestId("ipdd-draft-truncated")).toHaveTextContent("List cut short — check orders");
    expect(screen.getByDisplayValue("Community-acquired pneumonia")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Test Medicine 500 mg — 500 mg — TDS — 5 days")).toBeInTheDocument();
    expect(discharge.saveSummary).not.toHaveBeenCalled();
    expect(discharge.signSummary).not.toHaveBeenCalled();

    // The doctor adds a take-home medicine and saves: the drafted row keeps its order, the typed one is typed.
    const meds = screen.getByDisplayValue("Test Medicine 500 mg — 500 mg — TDS — 5 days");
    await userEvent.type(meds, "{enter}Vitamin C 500 mg — — OD");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(discharge.saveSummary).toHaveBeenCalledTimes(1));
    const [admissionId, version, content, draftId] = discharge.saveSummary.mock.calls[0]! as [string, number, IpdDischargeDraft["content"], string];
    expect([admissionId, version, draftId]).toEqual([id(1), 0, id(88)]);
    expect(content.medicines).toEqual([
      { name: "Test Medicine 500 mg", dose: "500 mg", frequency: "TDS", duration: "5 days", source: "order", orderId: id(60) },
      { name: "Vitamin C 500 mg", frequency: "OD", source: "typed" },
    ]);
    // Saved: still a draft, with where it came from and the flagged medicine in words.
    expect(await screen.findByTestId("ipdd-summary-prov")).toHaveTextContent("Started from copilot draft · Template · ipd-discharge-v1");
    expect(screen.getByTestId("ipdd-medicine-flags")).toHaveTextContent("Vitamin C 500 mg — no active order");
    expect(discharge.signSummary).not.toHaveBeenCalled();
    // Unsigned and copilot-sourced: the Draft stamp stays on the saved summary.
    expect(screen.getByTestId("ipdd-draft-stamp")).toHaveTextContent("Draft · Template · ipd-discharge-v1 · built");
    // A typed medicine with no active order: the doctor's reason goes with the signature.
    discharge.signSummary.mockResolvedValue({});
    await userEvent.type(screen.getByTestId("ipdd-ack-reason"), "Take-home supplement");
    await userEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(discharge.signSummary).toHaveBeenCalledWith(id(1), id(90), 1, "Take-home supplement"));
    // The print carries the stamp too.
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    await userEvent.click(screen.getByTestId("ipdd-summary-print-btn"));
    const paper = await screen.findByTestId("ipdd-summary-print");
    expect(paper).toHaveTextContent("Draft · Template · ipd-discharge-v1 · built");
    expect(paper).toHaveTextContent("not signed");
    expect(paper).toHaveTextContent("Vitamin C 500 mg — no active order");
    print.mockRestore();
  });
});
