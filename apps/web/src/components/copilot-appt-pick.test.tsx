import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopilotApptPicker } from "./copilot-appt-pick";
import type { CopilotApptPick } from "@hmis/contracts";
import type { CopilotProposal } from "../lib/copilot-api";

/**
 * E2.1 — pick the patient, pick a time, see the confirm card, confirm (spec SPEC-copilot-appt-2026-10-11).
 * Nothing is confirmed without the card, and the tap sends the proposal of the patient that was tapped.
 */
const at = (hhmm: string) => new Date(`2026-08-19T${hhmm}:00+05:30`).toISOString();
const twoRameshes: CopilotApptPick = {
  kind: "apptPick", action: "book", pickPatient: true,
  rows: [
    { patient: { name: "Ramesh Kumar", uhid: "HMS00110012", ageSex: "40M", phoneLast4: "0011" }, doctor: "Dr Meera Rao", mode: "in_person", from: null, noMobile: false,
      times: [{ at: at("09:00"), proposal: 0 }, { at: at("09:10"), proposal: 1 }] },
    { patient: { name: "Ramesh Kumar", uhid: "HMS00110020", ageSex: "62M", phoneLast4: "0012" }, doctor: "Dr Meera Rao", mode: "in_person", from: null, noMobile: false,
      times: [{ at: at("09:00"), proposal: 2 }, { at: at("09:10"), proposal: 3 }] },
  ],
};
const proposals: CopilotProposal[] = [0, 1, 2, 3].map((n) => ({ id: `p${String(n)}` }));

describe("CopilotApptPicker", () => {
  it("a searched patient is tapped first; the confirm card names who and when; Confirm sends THAT patient's proposal", async () => {
    const sent: CopilotProposal[] = [];
    render(<CopilotApptPicker pick={twoRameshes} proposals={proposals} busy={false} onConfirm={(p) => sent.push(p)} onDismiss={() => undefined} />);
    expect(screen.queryByTestId("copilot-appt-time-0")).toBeNull();
    await userEvent.click(screen.getByTestId("copilot-appt-patient-1"));
    expect(screen.queryByTestId("copilot-appt-time-0")).toBeNull();
    await userEvent.click(screen.getByTestId("copilot-appt-time-3"));
    expect(sent).toEqual([]);
    const card = screen.getByTestId("copilot-appt-confirm");
    expect(card).toHaveTextContent("HMS00110020");
    expect(card).toHaveTextContent("Dr Meera Rao");
    expect(card).toHaveTextContent("09:10");
    await userEvent.click(screen.getByTestId("copilot-appt-confirm-go"));
    expect(sent).toEqual([{ id: "p3" }]);
  });

  it("a UHID's single patient goes straight to the times; Cancel on the card goes back without confirming", async () => {
    const sent: CopilotProposal[] = [];
    const direct: CopilotApptPick = { ...twoRameshes, pickPatient: false, rows: [twoRameshes.rows[0]!] };
    render(<CopilotApptPicker pick={direct} proposals={proposals} busy={false} onConfirm={(p) => sent.push(p)} onDismiss={() => undefined} />);
    await userEvent.click(screen.getByTestId("copilot-appt-time-0"));
    await userEvent.click(screen.getByTestId("copilot-appt-confirm-cancel"));
    expect(screen.queryByTestId("copilot-appt-confirm")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("a tele-call with no mobile on record offers no time", async () => {
    const noMobile: CopilotApptPick = { ...twoRameshes, pickPatient: false, rows: [{ ...twoRameshes.rows[0]!, mode: "tele", noMobile: true, times: [] }] };
    render(<CopilotApptPicker pick={noMobile} proposals={[]} busy={false} onConfirm={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByTestId("copilot-appt-nomobile")).toBeInTheDocument();
    expect(screen.queryByTestId("copilot-appt-time-0")).toBeNull();
  });
});
