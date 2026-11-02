import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider, translate } from "../../src/i18n";
import { GuardianLink, GuardianSheet, GUARDIAN_RELATIONS } from "../../src/vitals/guardian";
import { guardianBrief } from "../../src/doctor/rules";

/**
 * #971 — ACCEPTANCE, spec docs/specs/971-reports-only-skip-vitals.md (owner APPROVED 2026-10-26):
 * the phone half. The bay's link, the action card and the swipe share one label; the "Who came?"
 * sheet offers Self first and hides the name box for it; the doctor's three readings (card, consult
 * line, queue chip) never say "absent" or "guardian" for a Self visit, and keep their words otherwise.
 */
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
async function wrap(node: React.ReactElement) {
  return await render(<SafeAreaProvider initialMetrics={METRICS}><I18nProvider>{node}</I18nProvider></SafeAreaProvider>);
}
const tEn = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const tHi = (k: string, v?: Record<string, string | number>) => translate("hi", k, v);
const api = { markPatientAbsent: jest.fn() };

describe("#971 — Reports only, Skip vitals (phone)", () => {
  it("spec #971 D1: the phone's way in reads \"Reports only — Skip vitals\", in en and hi", async () => {
    await wrap(<GuardianLink onPress={() => undefined} />);
    expect(screen.getByText("Reports only — Skip vitals ›")).toBeTruthy();
    expect(tEn("patientAbsent.short")).toBe("Reports only — Skip vitals");
    expect(tEn("patientAbsent.action")).toBe("Reports only — Skip vitals");
    expect(tHi("patientAbsent.short")).not.toBe("अभिभावक रिपोर्ट के साथ");
  });

  it("spec #971 D2: Self is the first chip, and choosing it hides the name box", async () => {
    expect(GUARDIAN_RELATIONS[0]).toBe("self");
    await wrap(<GuardianSheet api={api} encounterId="e1" onDone={() => undefined} onClose={() => undefined} />);
    expect(screen.getByTestId("patient-absent-relation-self")).toBeTruthy();
    expect(screen.getByText("Self")).toBeTruthy();
    expect(tHi("patientAbsent.relation.self")).not.toBe("patientAbsent.relation.self");
    expect(screen.getByTestId("patient-absent-name")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("patient-absent-relation-self"));
    expect(screen.queryByTestId("patient-absent-name")).toBeNull();
  });

  it("spec #971 D3: the doctor's readings never say absent or guardian for Self", () => {
    const g = guardianBrief(tEn, { relation: "self", name: null }, "revisit");
    expect([g.title, g.who, g.tail, g.compact, g.chip].join(" ")).not.toMatch(/absent|guardian/i);
    expect(g.title).toBe("Reports only");
    expect(g.compact).toBe("Reports only · vitals skipped");
  });

  it("spec #971 D4: a guardian's visit keeps the doctor's words", () => {
    const g = guardianBrief(tEn, { relation: "son", name: "Rakesh" }, "revisit");
    expect(g).toEqual({ title: "Guardian only", who: "Son: Rakesh", tail: " · reports · no vitals", compact: "Guardian only · Son: Rakesh", chip: "Guardian · Son" });
  });
});
