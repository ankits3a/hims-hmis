import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DeskModal } from "./desk-modal";
import { renderWithProviders } from "../test-utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE PROMISES A DIALOG MAKES TO SOMEBODY WHO CANNOT USE A MOUSE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `DeskModal` replaced `@/components/ui/dialog` on the consult screen, and replacing a library
 * component means inheriting its accessibility rather than assuming it. These are the four things
 * the shadcn dialog did for free and that a hand-written `<div>` does not, each one asserted here
 * because each one is invisible in a screenshot and obvious to the person who needs it.
 *
 * The consult screen is why they matter concretely: this dialog opens because a PRESCRIPTION WAS
 * REFUSED, on a screen whose entire keyboard map is signed off, in front of a doctor holding a pen.
 */
function Harness(): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => { setOpen(true); }}>open</button>
      <DeskModal open={open} onClose={() => { setOpen(false); }} title="Override the refusal" testId="m">
        <input data-testid="reason" aria-label="Reason" />
      </DeskModal>
    </>
  );
}

describe("DeskModal", () => {
  it("is a labelled modal dialog, named by its own visible title", async () => {
    renderWithProviders(<Harness />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    /* The name comes FROM the heading a sighted reader sees — one title, not two that can disagree. */
    expect(dialog).toHaveAccessibleName("Override the refusal");
  });

  /**
   * ESCAPE CLOSES. On this screen the dialog is the thing standing between a doctor and the
   * prescription line they were fixing; one that cannot be dismissed from the keyboard traps them.
   */
  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /**
   * FOCUS MOVES IN, to the first field. Without this the next keystroke goes to whatever had focus
   * on the page behind, and a screen reader keeps reading the page rather than announcing the
   * dialog — so the doctor types a reason into a form they can no longer see.
   */
  it("puts the cursor in the first field when it opens", async () => {
    renderWithProviders(<Harness />);
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByTestId("reason")).toHaveFocus());
  });

  /**
   * AND FOCUS COMES BACK. Dropping it on `<body>` is what makes a keyboard user re-tab through an
   * entire prescription form to get back to where they were.
   */
  it("returns focus to whatever opened it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    /* Re-open from a known control, then close: focus must land back on that control. */
    const opener = screen.getByTestId("opener");
    opener.focus();
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("renders nothing at all when closed — not a hidden node the tab order can still reach", () => {
    renderWithProviders(
      <DeskModal open={false} onClose={() => { /* unused */ }} title="Closed" testId="m">
        <input data-testid="reason" />
      </DeskModal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("reason")).toBeNull();
  });
});
