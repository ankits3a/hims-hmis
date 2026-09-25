import { render, screen } from "@testing-library/react";
import "./i18n";
import { ShortcutLegend, useScreenKeys } from "./keyboard";

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
