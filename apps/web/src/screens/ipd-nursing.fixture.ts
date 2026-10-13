import type {
  IpdHandoverDraft, IpdMyShift, IpdNurseStation, IpdNursingChart, IpdShiftHandoverCard, IpdShiftHandoverList, IpdStationBed,
} from "@hmis/contracts";

/*
  E4.1 (#733) — SYNTHETIC fixtures for the nursing screens' tests and the stub-API browser walk. Ids are `01FAKE…`,
  people are "Test Patient A…", staff "Sister Fake"; nothing here is a real patient, bed or person.
*/
export const fid = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const at = (now: number, min: number): string => new Date(now + min * 60_000).toISOString();
const WARD = { id: fid(900), code: "F05-MED-F", name: "5F Medicine (Female)" };

function person(n: number, name: string, ageSex: string): IpdStationBed["patient"] {
  return { admissionId: fid(100 + n), admissionNo: `IP26-0001${String(n).padStart(2, "0")}`, name, uhid: `UH-FAKE-${n}`, ageSex, sealed: false };
}

export function stationBeds(now: number, count = 12): IpdStationBed[] {
  const base: IpdStationBed[] = [
    { bedId: fid(1), code: "F05-MED-F-B01", status: "occupied", since: at(now, -3000), patient: person(1, "Test Patient A", "F 67"), consultant: "Dr Fake One", dayOfStay: 3,
      chips: ["allergy", "fall_risk"], score: { kind: "news2", value: 7, band: "high", complete: true, trend: "up", at: at(now, -20) }, scoreKind: "news2",
      next: { kind: "vitals", dueAt: at(now, -5), overdue: true }, alert: { alertId: fid(501), band: "high", raisedAt: at(now, -20), acknowledgedAt: null },
      discharge: null, transferring: false, needs: 90 },
    { bedId: fid(2), code: "F05-MED-F-B02", status: "occupied", since: at(now, -1500), patient: person(2, "Test Patient B", "F 29"), consultant: "Dr Fake Two", dayOfStay: 2,
      chips: ["obstetric"], score: { kind: "meows", value: 4, band: "medium", complete: true, trend: "flat", at: at(now, -50) }, scoreKind: "meows",
      next: { kind: "vitals", dueAt: at(now, 10), overdue: false }, alert: { alertId: fid(502), band: "medium", raisedAt: at(now, -50), acknowledgedAt: at(now, -40) },
      discharge: null, transferring: false, needs: 60 },
    { bedId: fid(3), code: "F05-MED-F-B03", status: "occupied", since: at(now, -40), patient: person(3, "Test Patient C", "F 7"), consultant: "Dr Fake Three", dayOfStay: 1,
      chips: ["isolation"], score: null, scoreKind: "pews", next: { kind: "assessment", dueAt: at(now, 20), overdue: false }, alert: null,
      discharge: null, transferring: false, needs: 40 },
    { bedId: fid(4), code: "F05-MED-F-B04", status: "occupied", since: at(now, -9000), patient: person(4, "Test Patient D", "F 54"), consultant: "Dr Fake One", dayOfStay: 7,
      chips: ["pressure_risk", "name_alert"], score: { kind: "news2", value: 1, band: "low", complete: true, trend: "down", at: at(now, -100) }, scoreKind: "news2",
      next: { kind: "vitals", dueAt: at(now, 140), overdue: false }, alert: null, discharge: "fit_declared", transferring: false, needs: 5 },
    { bedId: fid(5), code: "F05-MED-F-B05", status: "cleaning", since: at(now, -34), patient: null, consultant: null, dayOfStay: null, chips: [], score: null, scoreKind: null, next: null, alert: null, discharge: null, transferring: false, needs: 0 },
    { bedId: fid(6), code: "F05-MED-F-B06", status: "available", since: at(now, -120), patient: null, consultant: null, dayOfStay: null, chips: [], score: null, scoreKind: null, next: null, alert: null, discharge: null, transferring: false, needs: 0 },
    { bedId: fid(7), code: "F05-MED-F-B07", status: "reserved", since: at(now, -10), patient: null, consultant: null, dayOfStay: null, chips: [], score: null, scoreKind: null, next: null, alert: null, discharge: null, transferring: false, needs: 0 },
  ];
  const out = [...base];
  for (let i = base.length + 1; out.length < count; i++) {
    out.push({
      bedId: fid(i), code: `F05-MED-F-B${String(i).padStart(2, "0")}`, status: "occupied", since: at(now, -2000), patient: person(i, `Test Patient ${String.fromCharCode(64 + i)}`, `F ${30 + i}`),
      consultant: "Dr Fake Two", dayOfStay: 1 + (i % 5), chips: i % 3 === 0 ? ["fall_risk"] : [],
      score: { kind: "news2", value: i % 4, band: "low", complete: i % 2 === 0, trend: "flat", at: at(now, -60) }, scoreKind: "news2",
      next: { kind: "vitals", dueAt: at(now, 30 + i * 7), overdue: false }, alert: null, discharge: null, transferring: i === 9, needs: 3,
    });
  }
  return out;
}

export function stationOf(now: number, opts: { night?: boolean; count?: number } = {}): IpdNurseStation {
  const beds = stationBeds(now, opts.count ?? 12);
  return {
    asOf: new Date(now).toISOString(), wards: [WARD, { id: fid(901), code: "F05-SUR-M", name: "5M Surgery (Male)" }], ward: WARD,
    shift: { key: opts.night ? "night" : "morning", startsAt: at(now, -180), endsAt: at(now, 180) }, night: opts.night ?? false,
    top: { census: beds.filter((b) => b.patient !== null).length, beds: beds.length, free: 1, expected: 1, dischargesToday: 2, overdue: 1, alerts: 2, handoversWaiting: 1 },
    beds,
  };
}

export function myShiftOf(now: number, night = false): IpdMyShift {
  const s = stationOf(now, { night });
  const occ = s.beds.filter((b) => b.patient !== null).slice(0, 6);
  return {
    asOf: s.asOf, night, ward: s.ward, wards: s.wards, shift: s.shift,
    patients: occ.map((b) => ({ identity: b.patient!, bedCode: b.code, scoreKind: b.scoreKind ?? "news2" })),
    now: [
      { kind: "ews", admissionId: fid(101), bedCode: "F05-MED-F-B01", name: "Test Patient A", dueAt: at(now, -20), overdue: true, refId: fid(501), band: "high" },
      { kind: "vitals", admissionId: fid(101), bedCode: "F05-MED-F-B01", name: "Test Patient A", dueAt: at(now, -5), overdue: true, refId: null, band: null },
      { kind: "vitals", admissionId: fid(102), bedCode: "F05-MED-F-B02", name: "Test Patient B", dueAt: at(now, 10), overdue: false, refId: null, band: null },
      { kind: "assessment", admissionId: fid(103), bedCode: "F05-MED-F-B03", name: "Test Patient C", dueAt: at(now, 20), overdue: false, refId: null, band: null },
      { kind: "handover", admissionId: fid(104), bedCode: "F05-MED-F-B04", name: "Test Patient D", dueAt: at(now, -15), overdue: true, refId: fid(701), band: null },
    ],
  };
}

export function shiftHandover(now: number, over: Partial<IpdShiftHandoverCard> = {}): IpdShiftHandoverCard {
  return {
    handoverId: fid(701), identity: person(4, "Test Patient D", "F 54")!, bedCode: "F05-MED-F-B04", wardId: WARD.id, wardName: WARD.name,
    shift: "night", sbar: { situation: "Day 7, fit for discharge tomorrow.", background: "Admitted with synthetic pneumonia.", assessment: "NEWS2 1, falling.", recommendation: "Discharge teaching in the morning." },
    givenAt: at(now, -15), givenBy: { id: "u-fake-2", name: "Sister Fake" }, givenByViewer: false, ...over,
  };
}
export const handoversOf = (now: number, cards?: IpdShiftHandoverCard[]): IpdShiftHandoverList =>
  ({ asOf: new Date(now).toISOString(), handovers: cards ?? [shiftHandover(now)] });

export function chartOf(now: number): IpdNursingChart {
  const v = (n: number, min: number, value: number, band: "low" | "low_medium" | "medium" | "high", pulse: number, late = false): IpdNursingChart["vitals"][number] => ({
    id: fid(300 + n), observedAt: at(now, min), recordedAt: at(now, late ? min + 25 : min + 1), lateEntry: late, source: "person", recordedBy: "Sister Fake", refused: false,
    values: { temperatureC: 38.4, pulse, respRate: 22, systolic: 104, diastolic: 66, spo2: 93, onOxygen: value >= 5, consciousness: "alert", painScore: 3, capRefillSec: null },
    score: { kind: "news2", value, band, complete: true },
  });
  return {
    asOf: new Date(now).toISOString(), identity: person(1, "Test Patient A", "F 67")!, bedCode: "F05-MED-F-B01", scoreKind: "news2",
    vitals: [v(1, -20, 7, "high", 124), v(2, -80, 5, "medium", 112, true), v(3, -320, 3, "low", 98), v(4, -560, 2, "low", 94)],
    assessment: {
      id: fid(401), happenedAt: at(now, -3000), recordedAt: at(now, -2990), lateEntry: false, recordedBy: "Sister Fake",
      morse: 55, morseRisk: "high", braden: 14, bradenRisk: "moderate", painScore: 3, nutrition: "at_risk", allergies: ["Penicillin"],
      linesDevices: [{ kind: "peripheral_iv", site: "left forearm" }], obstetric: "none",
    },
    assessmentDueAt: null,
    io: { since: at(now, -300), inMl: 1450, outMl: 900, entries: [
      { id: fid(601), observedAt: at(now, -60), direction: "in", kind: "iv", volumeMl: 500, recordedBy: "Sister Fake", source: "person" },
      { id: fid(602), observedAt: at(now, -90), direction: "out", kind: "urine", volumeMl: 400, recordedBy: "Sister Fake", source: "person" },
    ] },
    notes: [{ id: fid(801), observedAt: at(now, -25), recordedAt: at(now, -24), category: "escalation", text: "Score 7. Duty doctor informed.", source: "person", recordedBy: "Sister Fake", lateEntry: false }],
    alert: { alertId: fid(501), band: "high", raisedAt: at(now, -20), acknowledgedAt: null },
    next: { kind: "vitals", dueAt: at(now, -5), overdue: true },
  };
}

export function draftOf(admissionId: string): IpdHandoverDraft {
  return {
    admissionId,
    situation: [{ text: "Day 7. NEWS2 1 at 09:10, falling.", source: "vitals" }],
    background: [{ text: "Admitted for synthetic pneumonia.", source: "admission" }],
    assessment: [{ text: "Morse 55 (high fall risk).", source: "assessment" }, { text: "In 1450 ml, out 900 ml since 08:00.", source: "io" }],
    recommendation: [{ text: "Next vitals due 13:10.", source: "vitals" }],
  };
}
