import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { DrugField, detailOf, saysAlready } from "./drug-field";
import type { WireMedicineHit } from "../lib/formulary-api";

/**
 * THE DOCTOR'S DRUG FIELD SAYS WHEN A PRODUCT HAS NOT BEEN REVIEWED BY PHARMACY (formulary phase 2).
 *
 * A component that is still the national release's own entry carries no drug class and no
 * interaction pairs, so the checks cannot see it as they would a reviewed moiety. The pick stays
 * allowed. The row says so before the tap.
 */
const hit = (over: Partial<WireMedicineHit> & Pick<WireMedicineHit, "id" | "name">): WireMedicineHit => ({
  form: "Oral tablet", strength: "625 mg", code: null, routeClass: "systemic",
  salts: [], prefix: true, reviewed: true, ...over,
});

function Harness(): React.ReactElement {
  const [value, setValue] = useState("");
  return <DrugField value={value} onText={setValue} onPick={(h) => { setValue(h.name); }} inputId="rx-drug" />;
}

describe("DrugField — the reviewed flag", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("marks only the product with an unreviewed component, and still lets it be picked", async () => {
    const user = userEvent.setup();
    stubFetch({
      "GET /api/formulary/medicines/search": {
        items: [
          hit({ id: "m-mox", name: "Mox 250", salts: ["amoxicillin"], reviewed: true }),
          hit({ id: "m-aug", name: "Moxclav 625", salts: ["amoxicillin", "Clavulanate potassium"], reviewed: false }),
        ],
      },
    });
    renderWithProviders(<Harness />);

    await user.type(screen.getByRole("textbox"), "mox");

    expect(await screen.findByTestId("rx-drug-unreviewed-m-aug")).toHaveTextContent("not yet reviewed by pharmacy");
    expect(screen.queryByTestId("rx-drug-unreviewed-m-mox")).toBeNull();
    await user.click(screen.getByTestId("rx-drug-hit-m-aug"));
    expect(screen.getByRole("textbox")).toHaveValue("Moxclav 625");
  });

  it("says nothing when an older server sends no flag at all", async () => {
    const user = userEvent.setup();
    const older: Partial<WireMedicineHit> = hit({ id: "m-old", name: "Moxikind 500" });
    delete older.reviewed;
    stubFetch({ "GET /api/formulary/medicines/search": { items: [older] } });
    renderWithProviders(<Harness />);

    await user.type(screen.getByRole("textbox"), "mox");

    expect(await screen.findByTestId("rx-drug-hit-m-old")).toBeInTheDocument();
    expect(screen.queryByTestId("rx-drug-unreviewed-m-old")).toBeNull();
  });
});

/**
 * ═══ A SUGGESTION SAYS EACH THING ONCE (owner, 2026-09-17) ═══
 *
 * "remove the duplicacy in sentence while autosuggesting drugs while the user is searching."
 */
describe("the second line says what the NAME does not", () => {
  const hit = (over: Partial<Parameters<typeof detailOf>[0]> = {}) => ({
    name: "Paracetamol 500 mg oral tablet", salts: ["Paracetamol"], strength: "500 mg", code: "D0230", ...over,
  });

  it("drops a moiety and a strength the name already carries, and keeps the code", () => {
    expect(detailOf(hit())).toBe("D0230");
  });

  it("keeps the moieties of a combination whose brand name hides them — the case the line exists for", () => {
    expect(detailOf(hit({
      name: "Augmentin 625", salts: ["Amoxicillin", "Clavulanic acid"], strength: "625 mg", code: "D1680",
    }))).toBe("Amoxicillin + Clavulanic acid · 625 mg · D1680");
  });

  it("compares with the spacing squashed out: 500mg in a name is 500 mg in a column", () => {
    expect(detailOf(hit({ name: "Paracetamol Tablets IP 500mg", strength: "500 mg" }))).toBe("D0230");
    expect(saysAlready("Paracetamol Tablets IP 500mg", "Tablet")).toBe(true);
    expect(saysAlready("Augmentin 625", "Tablet")).toBe(false);
  });
});
