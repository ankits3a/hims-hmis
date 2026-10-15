import { fireEvent, render, screen } from "@testing-library/react-native";
import { I18nProvider, translate } from "../src/i18n";
import { RecordedCard, recordedRole } from "../src/home/recorded";
import type { RecordingCounts, RecordingReport } from "../src/home/recorded";
import { onRecord, recordedPercent, recordingState } from "../../../packages/contracts/src/recording";

/**
 * "RECORDED TODAY" on the phone's home (owner 2026-10-07: "show a daily count on the screens").
 * The figures are the server's; what is under test is which SENTENCE each person reads, that the state
 * is said in words, and that nothing is drawn for a login the server sends no count.
 */
const C: RecordingCounts = { opened: 60, consulted: 48, onScreen: 9, onPaper: 39, photographed: 41, typed: 12, issued: 9, issuedLines: 21, toType: 29, notRecorded: 7, stillOpen: 10 };
const R = (over: Partial<RecordingReport> = {}): RecordingReport => ({
  from: "2026-10-07", to: "2026-10-07", period: "day", anchor: "2026-10-07", scope: "hospital", totals: C, mine: null, days: [], departments: [], doctors: null, ...over,
});
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const show = async (r: RecordingReport | null, seats: string[], permissions: string[], on = { scan: jest.fn(), by: jest.fn() }) => {
  await render(<I18nProvider><RecordedCard r={r} seats={seats} permissions={permissions} t={t} onScan={on.scan} onByDoctor={on.by} /></I18nProvider>);
  return on;
};

describe("recorded today — the home card", () => {
  it("the shared readings: on record, percent, and the word for the state", () => {
    expect(onRecord(C)).toBe(41);
    expect(recordedPercent(C)).toBe(85);
    expect(recordedPercent({ ...C, consulted: 0, notRecorded: 0 })).toBeNull();
    expect(recordingState(C)).toBe("some");
    expect(recordingState({ ...C, notRecorded: 0 })).toBe("all");
    expect(recordingState({ ...C, notRecorded: 48 })).toBe("none");
    expect(recordingState({ ...C, consulted: 0 })).toBe("nothing_yet");
  });

  it("the slip desk reads slips photographed of those consulted, and can go and scan one", async () => {
    const on = await show(R(), ["slips"], ["patients.update", "opd.consult.paper"]);
    expect(screen.getByTestId("recorded-lead")).toHaveTextContent("Not recorded: 7 of 48 consulted.");
    expect(screen.getByTestId("recorded-line")).toHaveTextContent("Slips photographed 41 of 48 consulted · typed 12 · not recorded 7");
    expect(screen.getByTestId("recorded-bar")).toHaveProp("accessibilityLabel", "41 of 48 consultations on record");
    fireEvent.press(screen.getByTestId("recorded-scan"));
    expect(on.scan).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("recorded-by-doctor")).toBeNull();
  });

  it("the scribe reads what waits to be typed, and is told typing is on the computer", async () => {
    await show(R(), ["slips"], ["patients.update", "opd.consult.paper", "opd.prescription.transcribe"]);
    expect(recordedRole(R(), ["slips"], ["opd.consult.paper", "opd.prescription.transcribe"])).toBe("scribe");
    expect(screen.getByTestId("recorded-line")).toHaveTextContent("To type: 29 · typed today 12");
    expect(screen.getByText("Typing opens on the computer: Desk scribe.")).toBeTruthy();
    expect(screen.queryByTestId("recorded-scan")).toBeNull();
  });

  it("a doctor reads their own patients", async () => {
    const mine: RecordingCounts = { ...C, consulted: 22, issued: 9, onPaper: 13, photographed: 10, notRecorded: 3 };
    await show(R({ scope: "mine", totals: mine, mine, departments: null }), ["consult"], ["opd.consult"]);
    expect(screen.getByText("Your patients on record")).toBeTruthy();
    expect(screen.getByTestId("recorded-line")).toHaveTextContent("Your patients: 22 seen · 9 prescribed on the phone or screen · 13 on paper (10 photographed)");
  });

  it("the owner reads the hospital line and can open the list by doctor", async () => {
    const on = await show(R({ doctors: [{ ...C, id: "d1", name: "Dr. Chandan Kumar" }] }), ["onNow"], ["opd.reports.read", "staff.reports.read", "opd.prescription.transcribe"]);
    expect(screen.getByTestId("recorded-line")).toHaveTextContent("48 consulted · 9 prescribed on screen · 41 slips photographed · 12 typed");
    fireEvent.press(screen.getByTestId("recorded-by-doctor"));
    expect(on.by).toHaveBeenCalledTimes(1);
  });

  it("is calm when everything consulted is on record, and says so before anything is consulted", async () => {
    await show(R({ totals: { ...C, notRecorded: 0 } }), ["counter"], ["opd.visits.open"]);
    expect(screen.getByTestId("recorded-lead")).toHaveTextContent("Everything consulted today is on record (48).");
  });

  it("draws nothing when the server sends no count, or none at all arrived", async () => {
    await show(R({ scope: "none", totals: null }), ["counter"], []);
    expect(screen.queryByTestId("home-recorded")).toBeNull();
    await show(null, ["counter"], []);
    expect(screen.queryByTestId("home-recorded")).toBeNull();
  });

  it("says the same in Hindi", () => {
    expect(translate("hi", "recorded.missing", { n: 7, of: 48 })).toBe("बिना रिकॉर्ड: 48 परामर्श में से 7।");
    expect(translate("hi", "recorded.line.scribe", { n: 29, typed: 12 })).toContain("29");
  });
});
