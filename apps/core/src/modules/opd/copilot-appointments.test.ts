import { matchIntent, modelIntentNames } from "../../kernel/copilot/phrasebook";
import { asksTele, nameQuery, namedDoctors, parseWhen } from "./copilot-appt-words";

/**
 * E2.1 — the words of a booking question, read by rules (no model). Pure: `today` is passed in, never
 * read from the clock. 2026-08-17 is a Monday.
 */
const MON = "2026-08-17";

describe("E2.1 — reading the day and time", () => {
  it.each([
    ["aaj", { day: MON, from: null }],
    ["kal 10 baje", { day: "2026-08-18", from: "10:00" }],
    ["tomorrow 4 pm", { day: "2026-08-18", from: "16:00" }],
    ["parso shaam", { day: "2026-08-19", from: "16:00" }],
    ["कल 11 बजे", { day: "2026-08-18", from: "11:00" }],
    ["friday 10:30", { day: "2026-08-21", from: "10:30" }],
    ["shukravar", { day: "2026-08-21", from: null }],
    ["monday", { day: MON, from: null }],
    ["20 aug 9:15 am", { day: "2026-08-20", from: "09:15" }],
    ["aug 20", { day: "2026-08-20", from: null }],
    ["20/8 ko 4 baje", { day: "2026-08-20", from: "16:00" }],
    ["10/8", { day: "2027-08-10", from: null }],
    ["25 tarikh", { day: "2026-08-25", from: null }],
    ["Dr Singh U00110012", { day: null, from: null }],
  ])("%s", (typed, want) => {
    expect(parseWhen(typed, MON)).toEqual(want);
  });

  it("a date is read once: '20/8' is not also read as a time", () => {
    expect(parseWhen("20/8", MON).from).toBeNull();
  });
});

describe("E2.1 — tele-call words", () => {
  it.each([["tele call kal", true], ["phone pe dikhana hai", true], ["फ़ोन पर", true], ["video consult", true],
    ["kal appointment", false], ["mobile 98765", false], ["telephone number", true]])("%s → %s", (typed, want) => {
    expect(asksTele(typed)).toBe(want);
  });
});

describe("E2.1 — which doctor", () => {
  const docs = [
    { id: "d1", displayName: "Dr. Anil Sharma" },
    { id: "d2", displayName: "Dr Priya Singh" },
    { id: "d3", displayName: "Dr Rakesh Singh" },
  ];
  it("a word after 'Dr' names a doctor", () => {
    expect(namedDoctors("Dr Sharma kal", docs).doctors.map((d) => d.id)).toEqual(["d1"]);
    expect(namedDoctors("doctor priya ke paas", docs).doctors.map((d) => d.id)).toEqual(["d2"]);
  });
  it("two doctors share the word: both, so the clerk is asked which", () => {
    expect(namedDoctors("Dr Singh kal", docs).doctors.map((d) => d.id).sort()).toEqual(["d2", "d3"]);
  });
  it("a full name needs no 'Dr'", () => {
    expect(namedDoctors("Priya Singh ke saath", docs).doctors.map((d) => d.id)).toEqual(["d2"]);
  });
  it("a lone name word without 'Dr' is a PATIENT, never a doctor (Anil Kumar is not Dr Anil Sharma's)", () => {
    expect(namedDoctors("Anil Kumar ka appointment kal", docs).doctors).toEqual([]);
  });
});

describe("E2.1 — the words left are the patient's name", () => {
  it("cues, days, times, glue and the doctor are not a name", () => {
    const { tokens } = namedDoctors("Dr Sharma", [{ id: "d1", displayName: "Dr Anil Sharma" }]);
    expect(nameQuery("Ramesh Kumar ka Dr Sharma ke saath kal 10 baje appointment laga do", tokens)).toBe("ramesh kumar saath");
    expect(nameQuery("book appointment kal", new Set())).toBe("");
    expect(nameQuery("सुनीता देवी का अपॉइंटमेंट कल", new Set())).toBe("सुनीता देवी");
  });
});

describe("E2.1 — the floor routes booking and moving (no model)", () => {
  it.each([
    ["Dr Singh kal 10 baje <<P1>> ka appointment", "appointment_book"],
    ["<<P1>> ka appointment book karo Dr Sharma parso", "appointment_book"],
    ["Ramesh ka appointment laga do Dr Sharma ke saath", "appointment_book"],
    ["अपॉइंटमेंट बुक करो <<P1>> डॉ शर्मा कल", "appointment_book"],
    ["<<P1>> ka appointment kal pe shift karo", "appointment_move"],
    ["move <<P1>>'s appointment to friday", "appointment_move"],
    ["<<P1>> ka appointment reschedule kar do", "appointment_move"],
    ["<<P1>> ki date badal do monday", "appointment_move"],
  ])("%s → %s", (q, intent) => {
    expect(matchIntent(q)?.intent).toBe(intent);
  });
  it.each([
    "dolo short book mein likh do",
    "meri duty shift kar do saturday",
    "aaj kitni booking hui",
  ])("%s is not an appointment act", (q) => {
    expect(["appointment_book", "appointment_move"]).not.toContain(matchIntent(q)?.intent);
  });
});

describe("E2.1 — booking and moving are the floor's alone", () => {
  it("no model is offered either act on its menu", () => {
    expect(modelIntentNames()).not.toContain("appointment_book");
    expect(modelIntentNames()).not.toContain("appointment_move");
  });
});
