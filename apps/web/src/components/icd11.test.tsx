import { cleanup, render, screen } from "@testing-library/react";
import "../lib/i18n";
import { ICD11_CITATION, Icd11Citation, Icd11Pill, Icd11Scope } from "./icd11";

/**
 * The ICD-11 pill and WHO's citation. The code and title are SYNTHETIC — WHO's mapping data is
 * downloaded at load time and never committed (owner ruling 2026-09-26, licence §1.2.4) — but the
 * citation is WHO's own §1.3 text, which is exactly the one string here that must be verbatim.
 */
const REF = { code: "ZZ00&ZZ9P1", title: "Synthetic title", uri: "https://synthetic.invalid/release/2026-01/mms/1", release: "2026-01" };

describe("Icd11Pill + Icd11Citation", () => {
  afterEach(() => { cleanup(); });

  it("P1: the pill reads 'ICD-11 <code>' and carries WHO's title as its tooltip", () => {
    render(<Icd11Pill icd11={REF} testId="pill" />);
    const pill = screen.getByTestId("pill");
    expect(pill.textContent).toBe("ICD-11 ZZ00&ZZ9P1");
    expect(pill.getAttribute("title")).toBe("Synthetic title");
    expect(pill.getAttribute("data-uri")).toBe(REF.uri);
  });

  it("P2: a null answer renders NOTHING — no pill, no label, no citation", () => {
    const { container } = render(<Icd11Scope><Icd11Pill icd11={null} testId="pill" /><Icd11Citation /></Icd11Scope>);
    expect(screen.queryByTestId("pill")).toBeNull();
    expect(screen.queryByTestId("icd11-citation")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("P3: WHO's §1.3 citation appears ONCE however many pills the screen shows, and goes when they do", () => {
    const view = (n: number) => (
      <Icd11Scope>
        {Array.from({ length: n }, (_, i) => <Icd11Pill key={i} icd11={REF} />)}
        <Icd11Citation />
      </Icd11Scope>
    );
    const { rerender } = render(view(3));
    const cites = screen.getAllByTestId("icd11-citation");
    expect(cites).toHaveLength(1);
    expect(cites[0]!.textContent).toContain(ICD11_CITATION);
    expect(ICD11_CITATION).toBe(
      "International Classification of Diseases, Eleventh Revision (ICD-11), World Health Organization (WHO) 2019 https://icd.who.int/browse11. "
      + "Licensed under the Creative Commons Attribution-NoDerivatives 3.0 IGO licence (CC BY-ND 3.0 IGO).",
    );
    /* The release the pills came from is named — it is ours (§1.2.5), and it says which table spoke. */
    expect(cites[0]!.textContent).toContain("2026-01");
    rerender(view(0));
    expect(screen.queryByTestId("icd11-citation")).toBeNull();
  });
});
