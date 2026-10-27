import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../../test-utils";
import { GuardianAbsentAction, GuardianCard, GuardianLine, PatientAbsentNotice, PatientAbsentTag } from "../../components/patient-absent";
import en from "../../locales/en.json";
import hi from "../../locales/hi.json";

/**
 * ACCEPTANCE — issue #971, spec docs/specs/971-reports-only-skip-vitals.md (owner APPROVED 2026-10-26):
 * the web half. The vitals bay (`short`) and Desk One (the button) share `GuardianAbsentAction`; the
 * doctor's queue chip, brief card, consult line and the desk's sentence share the readers below.
 */
const SELF = { relation: "self", name: null };
const SON = { relation: "son", name: "Rakesh" };

function words(): string {
  return document.body.textContent ?? "";
}

describe("#971 — Reports only, Skip vitals (web)", () => {
  it("spec #971 D1: the bay's link and Desk One's button read \"Reports only — Skip vitals\", in en and hi", () => {
    renderWithProviders(<GuardianAbsentAction encounterId="e1" onDone={() => undefined} testId="bay" short />);
    renderWithProviders(<GuardianAbsentAction encounterId="e1" onDone={() => undefined} testId="desk" />);
    expect(screen.getByTestId("bay-open").textContent).toBe("Reports only — Skip vitals");
    expect(screen.getByTestId("desk-open").textContent).toBe("Reports only — Skip vitals");
    expect(en.patientAbsent.action).toBe("Reports only — Skip vitals");
    expect(hi.patientAbsent.action).not.toBe("मरीज़ नहीं आए — अभिभावक रिपोर्ट लेकर आए");
    expect(hi.patientAbsent.short).toBe(hi.patientAbsent.action);
  });

  it("spec #971 D2: Self is the first choice in Who came?, and choosing it hides the name box", () => {
    renderWithProviders(<GuardianAbsentAction encounterId="e1" onDone={() => undefined} testId="pa" />);
    fireEvent.click(screen.getByTestId("pa-open"));
    const select = screen.getByTestId("pa-relation") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter((v) => v !== "");
    expect(values[0]).toBe("self");
    expect(select.options[1]!.textContent).toBe("Self");
    expect((hi.patientAbsent.relation as Record<string, string>).self).toBeTruthy();
    expect(screen.getByTestId("pa-name")).toBeTruthy();
    fireEvent.change(select, { target: { value: "self" } });
    expect(screen.queryByTestId("pa-name")).toBeNull();
  });

  it("spec #971 D3: no reader says \"absent\" or \"guardian\" for a Self visit", () => {
    renderWithProviders(
      <>
        <PatientAbsentNotice absent={SELF} />
        <PatientAbsentTag absent={SELF} visitType="revisit" testId="chip" />
        <GuardianCard absent={SELF} visitType="revisit" testId="card" />
        <GuardianLine absent={SELF} testId="line" />
      </>,
    );
    expect(words()).not.toMatch(/absent|guardian/i);
    expect(screen.getByTestId("card").textContent).toContain("Reports only");
    expect(screen.getByTestId("line").textContent).toContain("vitals skipped");
  });

  it("spec #971 D4: a guardian visit keeps the doctor's words exactly", () => {
    renderWithProviders(
      <>
        <PatientAbsentNotice absent={SON} />
        <PatientAbsentTag absent={SON} visitType="revisit" testId="chip" />
        <GuardianCard absent={SON} visitType="revisit" testId="card" />
        <GuardianLine absent={SON} testId="line" />
      </>,
    );
    expect(screen.getByTestId("patient-absent-notice").textContent).toBe("Patient absent — guardian (Son: Rakesh) brought reports. Vitals not taken.");
    expect(screen.getByTestId("chip").textContent).toBe("Guardian · Son");
    expect(screen.getByTestId("card").textContent).toBe("Guardian onlySon: Rakesh · reports · no vitals");
    expect(screen.getByTestId("line").textContent).toBe("Guardian only · Son: Rakesh");
  });
});
