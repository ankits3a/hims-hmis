import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaperConsults } from "./paper-consults";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * ═══ CONSULTED ON PAPER — THE DOCTOR'S LOOK, THE SUPERVISOR'S REOPEN (OWNER RULING 2026-10-06) ═══
 *
 * Nothing on this screen holds a patient: ruling A let the pharmacy dispense already. What the
 * rows below execute is the rest —
 *   · the visit with a HELD line comes first and cannot be waved through with "looks right";
 *   · "correct it" puts the held line back beside what was typed and asks the DOCTOR for the reason
 *     the desk was never allowed to give;
 *   · the supervisor's list is every doctor's, and "reopen" needs a reason.
 */
const LINE_A = { drug: "Tab Paracetamol", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false };
const LINE_PEN = { drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false };
const PEN_ALERT = { kind: "allergy", hard: true, text: "Allergy on record: Penicillin", substance: "Penicillin" };
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  encounterId: "E-1", visitNo: "V2610060004", serviceDate: "2026-10-06", status: "completed",
  patient: { id: "P-1", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false },
  doctorId: "D-1", doctorCode: "DR-0029", doctorName: "Dr Chandan", tokenNo: 4,
  completedVia: "paper", paperCompletedAt: "2026-10-06T05:10:00.000Z", paperCompletedByName: "Priya Kumari", evidenceKind: "transcription",
  documents: [], prescription: { id: "RX-1", version: 1, issuedAt: "2026-10-06T05:10:00.000Z", transcribedByName: "Priya Kumari", lines: [LINE_A] },
  held: null, advisedTests: [], confirmedAt: null, confirmedByName: null,
  ...over,
});
const HELD = row({ held: { lines: [LINE_PEN], alerts: [[PEN_ALERT]], note: null, draftedByName: "Priya Kumari", draftedAt: "2026-10-06T05:10:00.000Z" } });
const CLEAN = row({
  encounterId: "E-2", visitNo: "V2610060007", tokenNo: 7, evidenceKind: "slip_photo", prescription: null,
  patient: { id: "P-2", uhid: "U00110050", name: "Vikash Kumar", alias: null, restricted: false },
});

function stub(perms: string[], items: unknown[], over: Record<string, unknown> = {}): void {
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u-d" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } },
    "GET /api/opd/paper/consults": (_i?: RequestInit, url?: string) => ({ date: "2026-10-06", scope: url?.includes("scope=all") ? "all" : "mine", items }),
    "GET /api/formulary/medicines/search": { items: [] },
    ...over,
  });
}
const posted = (path: string): Record<string, unknown>[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0] === path)
  .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
const asked = (fragment: string): boolean => vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(fragment));

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("paper consultations — the doctor's own list", () => {
  it("the held visit is counted and marked; 'looks right' is refused there and works on the clean one", async () => {
    stub(["opd.consult", "opd.visits.read"], [HELD, CLEAN], { "POST /api/opd/paper/visits/E-2/confirm": CLEAN });
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);

    const heldRow = await screen.findByTestId("paper-row-V2610060004");
    expect(asked("scope=mine")).toBe(true);
    expect(within(screen.getByTestId("paper-counts")).getByText("with lines held for you").previousSibling).toHaveTextContent("1");
    expect(within(heldRow).getByTestId("paper-pill-held")).toHaveTextContent("1 line held");

    await user.click(within(heldRow).getByRole("button", { expanded: false }));
    expect(within(heldRow).getByTestId("paper-held")).toHaveTextContent("Tab Penicillin V");
    expect(within(heldRow).getByTestId("paper-held")).toHaveTextContent("Allergy on record: Penicillin");
    expect(within(heldRow).getByTestId("paper-typed-by")).toHaveTextContent("Typed from the doctor's paper prescription by Priya Kumari");
    expect(within(heldRow).getByTestId("paper-looks-right")).toBeDisabled();
    /* A doctor is not a supervisor: no reopen here. */
    expect(within(heldRow).queryByTestId("paper-reopen")).not.toBeInTheDocument();

    const cleanRow = screen.getByTestId("paper-row-V2610060007");
    await user.click(within(cleanRow).getByRole("button", { expanded: false }));
    await user.click(within(cleanRow).getByTestId("paper-looks-right"));
    await waitFor(() => { expect(posted("/api/opd/paper/visits/E-2/confirm")).toHaveLength(1); });
  });

  it("'correct it': the held line comes back beside the typed one, the DOCTOR's reason is required, and it is sent keyed to its line", async () => {
    stub(["opd.consult", "opd.visits.read"], [HELD], {
      "POST /api/opd/paper/visits/E-1/correction-check": { lines: [{ lineIndex: 1, alerts: [PEN_ALERT] }] },
      "POST /api/opd/paper/visits/E-1/correct": HELD,
    });
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);
    const heldRow = await screen.findByTestId("paper-row-V2610060004");
    await user.click(within(heldRow).getByRole("button", { expanded: false }));
    await user.click(within(heldRow).getByTestId("paper-correct"));

    await waitFor(() => { expect(document.getElementById("fix-E-1-drug-1")).toHaveValue("Tab Penicillin V"); });
    expect(document.getElementById("fix-E-1-drug-0")).toHaveValue("Tab Paracetamol");
    const reason = await screen.findByTestId("fix-E-1-reason-1");
    expect(screen.getByTestId("fix-E-1-alert-1-0")).toHaveTextContent("Needs your reason:");
    expect(screen.getByTestId("paper-correct-save")).toBeDisabled();

    await user.type(reason, "the reaction on file was to amoxicillin");
    await user.click(screen.getByTestId("paper-correct-save"));
    await waitFor(() => { expect(posted("/api/opd/paper/visits/E-1/correct")).toHaveLength(1); });
    expect(posted("/api/opd/paper/visits/E-1/correct")[0]).toEqual({
      lines: [LINE_A, LINE_PEN],
      reasons: [{ lineIndex: 1, reason: "the reaction on file was to amoxicillin" }],
    });
  });
});

/**
 * Owner 2026-10-06: "Yes, paper close that visit too." — a visit the doctor started on screen is
 * closed from paper as well. The medicines they had typed and not issued were sent to nobody; the
 * list says so, and "Correct it" puts them in the editor so issuing them is one decision away.
 */
describe("paper consultations — the draft the doctor left on the screen", () => {
  it("'ask the desk to re-check': a reason is required and sent; the row then says it is with the desk, and later what the desk said (decision 0043)", async () => {
    const SENT = row({ recheck: { reason: "Line 1 — I wrote 650, not 500", askedAt: "2026-10-06T06:00:00.000Z", askedByName: "Dr Chandan", doneAt: null, doneByName: null, doneNote: null } });
    stub(["opd.consult", "opd.visits.read"], [row({})], { "POST /api/opd/paper/visits/E-1/recheck": SENT });
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);
    const r = await screen.findByTestId("paper-row-V2610060004");
    await user.click(within(r).getByRole("button", { expanded: false }));
    await user.click(within(r).getByTestId("paper-ask-recheck"));
    expect(within(r).getByTestId("paper-recheck-go")).toBeDisabled(); // no reason, nothing sent
    await user.type(within(r).getByTestId("paper-recheck-reason"), "Line 1 — I wrote 650, not 500");
    await user.click(within(r).getByTestId("paper-recheck-go"));
    await waitFor(() => { expect(posted("/api/opd/paper/visits/E-1/recheck")).toEqual([{ reason: "Line 1 — I wrote 650, not 500" }]); });
  });

  it("a visit sent back wears it on the row; once the desk has looked, the row says so with the desk's note", async () => {
    const open = row({ recheck: { reason: "check line 2", askedAt: "2026-10-06T06:00:00.000Z", askedByName: "Dr Chandan", doneAt: null, doneByName: null, doneNote: null } });
    const done = row({ encounterId: "E-2", visitNo: "V2610060007", recheck: { reason: "check line 2", askedAt: "2026-10-06T06:00:00.000Z", askedByName: "Dr Chandan", doneAt: "2026-10-06T06:20:00.000Z", doneByName: "Priya Kumari", doneNote: "matches the paper" } });
    stub(["opd.consult", "opd.visits.read"], [open, done]);
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);
    expect(within(await screen.findByTestId("paper-row-V2610060004")).getByTestId("paper-pill-sent-back")).toHaveTextContent("sent back to the desk");
    const d = screen.getByTestId("paper-row-V2610060007");
    expect(within(d).getByTestId("paper-pill-rechecked")).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { expanded: false }));
    expect(within(d).getByTestId("paper-recheck-state")).toHaveTextContent("The desk looked again — Priya Kumari");
    expect(within(d).getByTestId("paper-recheck-state")).toHaveTextContent("The desk says: matches the paper");
  });

  it("names the unissued draft on the row, and 'Correct it' carries it into the editor", async () => {
    const DRAFT_LINE = { drug: "Tab Azithromycin 500", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 3, instructions: null, noSubstitution: false };
    stub(["opd.consult", "opd.visits.read"], [row({ evidenceKind: "slip_photo", prescription: null, doctorDraft: [DRAFT_LINE] })], {
      "POST /api/opd/paper/visits/E-1/correction-check": { lines: [] },
    });
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);
    const r = await screen.findByTestId("paper-row-V2610060004");
    expect(within(r).getByTestId("paper-pill-draft")).toHaveTextContent("your unissued draft");
    await user.click(within(r).getByRole("button", { expanded: false }));
    const block = within(r).getByTestId("paper-doctor-draft");
    expect(block).toHaveTextContent("1 medicine you typed on the screen was NOT issued");
    expect(block).toHaveTextContent("Tab Azithromycin 500");
    await user.click(within(r).getByTestId("paper-correct"));
    await waitFor(() => { expect(document.getElementById("fix-E-1-drug-0")).toHaveValue("Tab Azithromycin 500"); });
  });
});

describe("paper consultations — the supervisor's list", () => {
  it("every doctor's visits; reopen needs a reason, and can withdraw the typed prescription with it", async () => {
    stub(["opd.queue.transfer", "opd.visits.read"], [row({})], { "POST /api/opd/paper/visits/E-1/reopen": { encounter: {} } });
    const user = userEvent.setup();
    renderWithProviders(<PaperConsults />);
    const r = await screen.findByTestId("paper-row-V2610060004");
    expect(asked("scope=all")).toBe(true);
    expect(r).toHaveTextContent("DR-0029");
    await user.click(within(r).getByRole("button", { expanded: false }));
    /* A supervisor is not the doctor: no "looks right", no "correct it". */
    expect(within(r).queryByTestId("paper-looks-right")).not.toBeInTheDocument();
    await user.click(within(r).getByTestId("paper-reopen"));

    expect(screen.getByTestId("paper-reopen-go")).toBeDisabled();
    await user.type(screen.getByTestId("paper-reopen-reason"), "slip was typed on the wrong visit");
    await user.click(screen.getByTestId("paper-reopen-withdraw"));
    await user.click(screen.getByTestId("paper-reopen-go"));
    await waitFor(() => { expect(posted("/api/opd/paper/visits/E-1/reopen")).toHaveLength(1); });
    expect(posted("/api/opd/paper/visits/E-1/reopen")[0]).toEqual({ reason: "slip was typed on the wrong visit", voidTranscription: true });
  });

  it("a day with nothing closed from paper is a sentence, not a blank page", async () => {
    stub(["opd.queue.transfer", "opd.visits.read"], []);
    renderWithProviders(<PaperConsults />);
    expect(await screen.findByTestId("paper-empty")).toHaveTextContent("No visit was closed from paper today.");
  });
});
