import { render, screen } from "@testing-library/react";
import "./i18n";
import { ShortcutLegend, legendAppliesTo, useScreenKeys } from "./keyboard";

/**
 * PARITY P3 — the shell's key legend shows the CURRENT screen's keys when the screen registers
 * them, and the front desk's otherwise; unmounting the screen gives the desk legend back.
 */
function Screen({ keys }: { keys: string[] }): null {
  useScreenKeys(keys);
  return null;
}

describe("ShortcutLegend and useScreenKeys", () => {
  it("shows the desk's keys when no screen registers any", () => {
    render(<ShortcutLegend />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("F4 New patient");
  });

  it("shows a registered screen's keys instead, and gives the desk's back when the screen goes", () => {
    const { rerender } = render(<><Screen keys={["⏎ open · P payables"]} /><ShortcutLegend /></>);
    const legend = screen.getByTestId("shortcut-legend-screen");
    expect(legend).toHaveTextContent("⏎ open · P payables");
    expect(legend).not.toHaveTextContent("F4 New patient");
    expect(legend).not.toHaveTextContent("Release the patient");
    rerender(<ShortcutLegend />);
    expect(screen.queryByTestId("shortcut-legend-screen")).toBeNull();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("F4 New patient");
  });
});

/** IPD walk 2026-10-14 — the desk's legend is not drawn under the ward and diet screens, nor on a phone. */
describe("ShortcutLegend scope", () => {
  it("draws nothing on an inpatient or diet path, and the desk legend elsewhere", () => {
    const { rerender } = render(<ShortcutLegend path="/ipd/ward" />);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    rerender(<ShortcutLegend path="/diet/kitchen" />);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    rerender(<ShortcutLegend path="/registration" />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("F4 New patient");
    expect(legendAppliesTo("/ipdx")).toBe(true);
    expect(legendAppliesTo("/ipd")).toBe(false);
  });

  it("is hidden below the sm breakpoint (a phone has no F-keys) and shown from it up", () => {
    render(<ShortcutLegend />);
    const classes = screen.getByRole("contentinfo").className.split(/\s+/);
    expect(classes).toContain("hidden");
    expect(classes).toContain("sm:flex");
    expect(classes).not.toContain("flex");
  });
});
