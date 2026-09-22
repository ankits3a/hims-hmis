import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderWithProviders } from "../test-utils";
import { SigPanel, joinInstructions, splitInstructions } from "./sig-panel";
import type { SigPatch } from "./sig-panel";

/**
 * ═══ THE SIG PANEL IS THE ONLY CONTROL FOR HOW A DRUG IS TAKEN ═══
 *
 * Owner, 2026-09-18: the deployed prescription tab showed Frequency, Days and the food timing
 * twice — once as the line's own boxes and once as P26's taps. The boxes went; these pin that the
 * panel alone can still say everything they could, and that a value it did not write (a scribe
 * slip's `1-0-0`, a co-pilot's 21 days) is shown and editable rather than silently unselected.
 */
type Line = { frequency: string; instructions: string; durationDays: string };

function Harness({ initial, log }: { initial: Line; log?: SigPatch[] }): React.ReactElement {
  const [line, setLine] = useState(initial);
  return (
    <>
      <SigPanel
        lineIndex={0} {...line}
        onPatch={(p) => { log?.push(p); setLine((l) => ({ ...l, ...p })); }}
      />
      <output data-testid="line">{JSON.stringify(line)}</output>
    </>
  );
}
const lineOf = (): Line => JSON.parse(screen.getByTestId("line").textContent ?? "{}") as Line;

describe("splitInstructions / joinInstructions — one column, two controls", () => {
  const timings = ["After food", "Before food"];

  it("the timing owns the first clause only when it IS a timing text", () => {
    expect(splitInstructions("After food", timings)).toEqual({ timing: "After food", note: "" });
    expect(splitInstructions("After food, with milk", timings)).toEqual({ timing: "After food", note: "with milk" });
    expect(splitInstructions("after food", timings)).toEqual({ timing: null, note: "after food" });
    expect(splitInstructions("After foods", timings)).toEqual({ timing: null, note: "After foods" });
    expect(splitInstructions("", timings)).toEqual({ timing: null, note: "" });
  });

  it("round-trips, so a keystroke in the note never moves the timing", () => {
    for (const [timing, note] of [["After food", ""], ["After food", "with milk"], [null, "alternate days"], ["Before food", "with "]] as const) {
      expect(splitInstructions(joinInstructions(timing, note), timings)).toEqual({ timing, note });
    }
  });
});

describe("SigPanel", () => {
  it("S2: a value the taps do not hold shows under Other, in a box the doctor can edit", () => {
    renderWithProviders(<Harness initial={{ frequency: "1-0-0", instructions: "After food, with milk", durationDays: "21" }} />);

    expect(screen.getByTestId("sig-0-freq-other")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Frequency")).toHaveValue("1-0-0");
    expect(screen.getByTestId("sig-0-days-other")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Days")).toHaveValue(21);
    expect(screen.getByTestId("sig-0-timing-afterFood")).toHaveAttribute("aria-checked", "true");
    // the note box holds only what the timing tap does not — "After food" is not on screen twice
    expect(screen.getByLabelText("Instructions")).toHaveValue("with milk");
  });

  it("S3: a value the taps DO hold opens no box — each fact has one control on screen", () => {
    renderWithProviders(<Harness initial={{ frequency: "BD", instructions: "After food", durationDays: "5" }} />);

    expect(screen.getByTestId("sig-0-freq-BD")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText("Frequency")).toBeNull();
    expect(screen.queryByLabelText("Days")).toBeNull();
    expect(screen.getByLabelText("Instructions")).toHaveValue("");
  });

  it("S4: tapping a timing keeps the note, and typing the note keeps the timing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ frequency: "OD", instructions: "with milk", durationDays: "" }} />);

    await user.click(screen.getByTestId("sig-0-timing-beforeFood"));
    expect(lineOf().instructions).toBe("Before food, with milk");
    await user.type(screen.getByLabelText("Instructions"), ", at 7 am");
    expect(lineOf().instructions).toBe("Before food, with milk, at 7 am");
    await user.click(screen.getByTestId("sig-0-timing-beforeFood")); // second tap clears the timing only
    expect(lineOf().instructions).toBe("with milk, at 7 am");
  });

  it("S5: Other on how-often empties the value and puts the cursor in its box", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ frequency: "BD", instructions: "", durationDays: "" }} />);

    await user.click(screen.getByTestId("sig-0-freq-other"));
    expect(screen.getByLabelText("Frequency")).toHaveFocus();
    await user.keyboard("q6h");
    expect(lineOf().frequency).toBe("q6h");
    await user.click(screen.getByTestId("sig-0-freq-TDS"));
    expect(lineOf().frequency).toBe("TDS");
    expect(screen.queryByLabelText("Frequency")).toBeNull();
  });

  it("S6: Other on days opens a number box; a second tap on Other closes it and clears the days", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ frequency: "OD", instructions: "", durationDays: "5" }} />);

    await user.click(screen.getByTestId("sig-0-days-other"));
    expect(lineOf().durationDays).toBe("");
    expect(screen.getByLabelText("Days")).toHaveFocus();
    await user.keyboard("4");
    expect(lineOf().durationDays).toBe("4");
    await user.click(screen.getByTestId("sig-0-days-other"));
    expect(lineOf().durationDays).toBe("");
    expect(screen.queryByLabelText("Days")).toBeNull();
  });

  it("S7: one Tab stop per row, and the arrow keys move the choice", async () => {
    const user = userEvent.setup();
    const log: SigPatch[] = [];
    renderWithProviders(<Harness initial={{ frequency: "BD", instructions: "", durationDays: "" }} log={log} />);

    const freqRow = screen.getByRole("radiogroup", { name: "How often" });
    const stops = Array.from(freqRow.querySelectorAll("button")).filter((b) => b.tabIndex === 0);
    expect(stops.map((b) => b.dataset.testid)).toEqual(["sig-0-freq-BD"]);

    screen.getByTestId("sig-0-freq-BD").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("sig-0-freq-TDS")).toHaveFocus();
    expect(lineOf().frequency).toBe("TDS");

    // a row with nothing chosen is still reachable: its first pill holds the stop
    const daysRow = screen.getByRole("radiogroup", { name: "For how long" });
    expect(Array.from(daysRow.querySelectorAll("button")).filter((b) => b.tabIndex === 0).map((b) => b.dataset.testid)).toEqual(["sig-0-days-3"]);
  });
});
