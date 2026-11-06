import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WidalGrid } from "../../components/lab/widal-grid";
import { draftSummary, previewFlag, refText } from "../../lib/lab-quick-api";
import type { QuickLine } from "../../lib/lab-quick-api";

/**
 * ACCEPTANCE — issue #1036, spec docs/specs/1036-widal-titre.md (owner APPROVED 2026-11-06): the web half.
 * A positive Widal titre is named in the summary, and the quick bench has a titre grid for manual slide testing.
 */
const RANGE = { low: null, high: null, text: "Up to 1:80", criticalLow: null, criticalHigh: null };
const line = (code: string, nameEn: string, value: string, flag: QuickLine["flag"]): QuickLine => ({
  analyteId: code, code, nameEn, unit: null, value, low: null, high: null, refText: "Up to 1:80", flag,
});

function Harness(): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({ WIDAL_TO: "", WIDAL_TH: "" });
  return (
    <>
      <WidalGrid
        rows={[{ code: "WIDAL_TO", nameEn: "Widal — S. typhi O", value: values.WIDAL_TO! }, { code: "WIDAL_TH", nameEn: "Widal — S. typhi H", value: values.WIDAL_TH! }]}
        onChange={(code, value) => setValues((v) => ({ ...v, [code]: value }))}
      />
      <output data-testid="to">{values.WIDAL_TO}</output>
    </>
  );
}

describe("#1036 — Widal titres (web)", () => {
  it("spec #1036 D1: the bench shows a Widal antigen's range as 'Up to 1:80'", () => {
    expect(refText(RANGE)).toBe("Up to 1:80");
  });

  it("spec #1036 D3: the draft summary names a flagged Widal line and does not call it in range", () => {
    const s = draftSummary([line("WIDAL_TO", "S. typhi O", "1:160", "A"), line("WIDAL_AH", "S. Paratyphi AH", "Negative", "N")]);
    expect(s).toContain("S. typhi O is abnormal: 1:160");
    expect(s).not.toContain("All reported parameters are within the reference range");
    expect(previewFlag("1:160", RANGE)).toBe("A");
  });

  it("spec #1036 D4: ticking 1:20, 1:40, 1:80 and 1:160 fills 1:160; no tick fills Negative", async () => {
    render(<Harness />);
    const user = userEvent.setup();
    expect(screen.queryByRole("checkbox", { name: "Widal — S. typhi O 1:640" })).toBeNull();
    for (const d of ["1:20", "1:40", "1:80", "1:160"]) await user.click(screen.getByRole("checkbox", { name: `Widal — S. typhi O ${d}` }));
    expect(screen.getByTestId("to").textContent).toBe("1:160");
    expect((screen.getByRole("checkbox", { name: "Widal — S. typhi O 1:80" }) as HTMLInputElement).checked).toBe(true);
    for (const d of ["1:160", "1:80", "1:40", "1:20"]) await user.click(screen.getByRole("checkbox", { name: `Widal — S. typhi O ${d}` }));
    expect(screen.getByTestId("to").textContent).toBe("Negative");
  });
});
