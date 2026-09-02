import { render } from "@testing-library/react";
import { code128BBars, code128BChecksum, code128BPattern, drawRank, SpecimenLabel } from "./specimen-label";

/**
 * PLAN 17c T2 — the barcode is asserted against the SPECIFICATION, not against itself:
 * Code 128's published example ("Wikipedia", subset B) has checksum 88.
 */
it("code128 B — the published worked example checksums to 88, framed by START B and STOP", () => {
  expect(code128BChecksum("Wikipedia")).toBe(88);
  const pattern = code128BPattern("Wikipedia");
  expect(pattern.startsWith("211214")).toBe(true);
  expect(pattern.endsWith("2331112")).toBe(true);
  /** Every symbol is six modules wide except STOP (seven): 11 symbols + STOP. */
  expect(pattern.length).toBe(6 * 11 + 7);
});

it("an S number encodes to bars that fit a 50 mm label with quiet zones at 0.25 mm per module", () => {
  const { bars, widthModules } = code128BBars("S2609010211");
  expect(bars[0]!.x).toBe(10);
  expect(widthModules * 0.25).toBeLessThan(50);
  expect(bars.length).toBe(3 * 14 + 1); // three bars per symbol, STOP has four
  expect(() => code128BPattern("नमूना")).toThrow(/subset B/);
});

it("order of draw: culture, citrate, serum, heparin, EDTA, fluoride — anything else after", () => {
  const sorted = ["fluoride", "edta", "urine_container", "sst", "citrate"].sort((a, b) => drawRank(a) - drawRank(b));
  expect(sorted).toEqual(["citrate", "sst", "edta", "fluoride", "urine_container"]);
});

it("the label carries the number, the person and the tube — never a bare id", () => {
  const { getByTestId } = render(
    <SpecimenLabel specimenNo="S2609010211" patientDisplay="Farida Khatoon" uhid="U23011884" container="sst"
      specimenType="serum" codes={["LFT"]} serviceDate="2026-09-02" tokenNo={118} />,
  );
  const svg = getByTestId("label-S2609010211");
  expect(svg).toHaveTextContent("Farida Khatoon");
  expect(svg).toHaveTextContent("U23011884");
  expect(svg).toHaveTextContent("S2609010211");
  expect(svg).toHaveTextContent("gold · serum");
  expect(svg).toHaveTextContent("T-118");
  expect(svg.querySelectorAll('[data-testid="barcode"] rect').length).toBe(3 * 14 + 1);
});
