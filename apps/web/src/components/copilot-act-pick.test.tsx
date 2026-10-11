import { screen } from "@testing-library/react";
import { renderWithProviders as render } from "../test-utils";
import userEvent from "@testing-library/user-event";
import { CopilotActPicker } from "./copilot-act-pick";
import type { CopilotCoverPick, CopilotLeavePick } from "@hmis/contracts";
import type { CopilotProposal } from "../lib/copilot-api";

/** E2.2 — pick a kind (or a person), see the card, Confirm sends THAT proposal; nothing is sent before. */
const proposals: CopilotProposal[] = [0, 1, 2, 3].map((n) => ({ id: `p${String(n)}` }));
const LEAVE: CopilotLeavePick = {
  kind: "leavePick", from: "2026-11-20", to: "2026-11-22", days: 3,
  options: [{ leave: "CL", proposal: 0 }, { leave: "EL", proposal: 1 }, { leave: "ML", proposal: 2 }, { leave: "comp_off", proposal: 3 }],
};

describe("CopilotActPicker (E2.2)", () => {
  it("a leave with no kind said: tap the kind, see the days, Confirm sends that kind's proposal", async () => {
    const sent: CopilotProposal[] = [];
    render(<CopilotActPicker pick={LEAVE} proposals={proposals} busy={false} onConfirm={(p) => sent.push(p)} onDismiss={() => undefined} />);
    expect(screen.queryByTestId("copilot-act-confirm")).toBeNull();
    await userEvent.click(screen.getByTestId("copilot-act-option-1"));
    expect(sent).toEqual([]);
    expect(screen.getByTestId("copilot-act-confirm")).toHaveTextContent("Earned leave");
    expect(screen.getByTestId("copilot-act-confirm")).toHaveTextContent("3 days");
    await userEvent.click(screen.getByTestId("copilot-act-confirm-go"));
    expect(sent).toEqual([{ id: "p1" }]);
  });

  it("a leave whose kind was said goes straight to the card", async () => {
    const sent: CopilotProposal[] = [];
    const one: CopilotLeavePick = { ...LEAVE, from: "2026-11-20", to: "2026-11-20", days: 1, options: [{ leave: "CL", proposal: 0 }] };
    render(<CopilotActPicker pick={one} proposals={proposals} busy={false} onConfirm={(p) => sent.push(p)} onDismiss={() => undefined} />);
    expect(screen.getByTestId("copilot-act-confirm")).toHaveTextContent("Casual leave");
    await userEvent.click(screen.getByTestId("copilot-act-confirm-go"));
    expect(sent).toEqual([{ id: "p0" }]);
  });

  it("a cover card names who takes it and what a swap gives back; Cancel on the card sends nothing", async () => {
    const sent: CopilotProposal[] = [];
    const cover: CopilotCoverPick = {
      kind: "coverPick", more: 0,
      duty: { istDate: "2026-11-10", night: true, startsAt: "2026-11-10T14:30:00.000Z", endsAt: "2026-11-11T02:30:00.000Z", post: "Ward junior resident" },
      options: [{ name: "Dr. Rohit Bansal", grade: "jr1", teamName: "Unit II", crossUnit: false, give: null, proposal: 2 }],
    };
    render(<CopilotActPicker pick={cover} proposals={proposals} busy={false} onConfirm={(p) => sent.push(p)} onDismiss={() => undefined} />);
    await userEvent.click(screen.getByTestId("copilot-act-option-0"));
    expect(screen.getByTestId("copilot-act-confirm")).toHaveTextContent("Dr. Rohit Bansal takes it");
    await userEvent.click(screen.getByTestId("copilot-act-back"));
    expect(screen.queryByTestId("copilot-act-confirm")).toBeNull();
    expect(sent).toEqual([]);
  });
});
