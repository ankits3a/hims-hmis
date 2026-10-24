import type {
  IpdEmarDose, IpdEmarDueList, IpdEmarLabelSheet, IpdEmarOrderLine, IpdEmarPatient, IpdEmarPharmacyQueue, IpdEmarScan, IpdEmarWardChart,
} from "@hmis/contracts";

/*
  E4.3 (#735) — synthetic eMAR data for the screen tests and the stub-API browser walk. Every name, number and id is made
  up: ids are `01EMARFAKE…`, people are "Test Patient …", the band and label codes are fake.
*/
export const eid = (n: number): string => `01EMARFAKE${String(n).padStart(16, "0")}`;
const at = (base: number, minutes: number): string => new Date(base + minutes * 60_000).toISOString();

export function orderLine(over: Partial<IpdEmarOrderLine> = {}): IpdEmarOrderLine {
  return {
    orderId: eid(1), title: "Ceftriaxone 1 g", tallMan: null, lasa: false, highAlert: false, narcotic: false, timeCritical: true,
    doseWords: "1 g · IV · BD", doseValue: 1, doseUnit: "g", route: "iv", frequency: "BD", prn: null, weightBased: false, weightKg: null,
    startAt: new Date(Date.UTC(2026, 2, 10, 3, 30)).toISOString(), stopAt: new Date(Date.UTC(2026, 2, 15, 3, 30)).toISOString(),
    status: "active", verification: "verified", issued: true, ownMedicine: false, verbalSignBy: null, verbal: false, allergyFlag: false,
    infusion: null, prnNextAt: null, prnGiven24h: 0, ...over,
  };
}

export function dose(base: number, over: Partial<IpdEmarDose> = {}): IpdEmarDose {
  return {
    doseId: eid(50), orderId: eid(1), dueAt: at(base, 10), windowStart: at(base, -20), windowEnd: at(base, 40), status: "scheduled",
    reoffer: false, prn: false, outcome: null, ...over,
  };
}

export function emarPatientOf(base: number, over: Partial<IpdEmarPatient> = {}): IpdEmarPatient {
  const insulin = orderLine({ orderId: eid(2), title: "Actrapid 100 IU/ml", doseWords: "8 unit · SC · TDS", highAlert: true, route: "sc", frequency: "TDS" });
  const lasa = orderLine({ orderId: eid(3), title: "Hydroxyzine 25 mg", tallMan: "hydrOXYzine vs hydrALAZINE", lasa: true, doseWords: "25 mg · oral · HS", route: "oral", frequency: "HS", timeCritical: false });
  const prn = orderLine({ orderId: eid(4), title: "Paracetamol 500 mg", doseWords: "500 mg · oral · SOS", route: "oral", frequency: "SOS", prn: { minIntervalMinutes: 240, max24h: 4 }, prnGiven24h: 1, prnNextAt: at(base, 90), timeCritical: false });
  return {
    asOf: new Date(base).toISOString(), admissionId: eid(100), admissionNo: "IP26-000101",
    identity: { name: "Test Patient Asha", uhid: "UH-FAKE-0101", ageYears: 54, sex: "female", sealed: false },
    bedCode: "F05-MED-F-B01", wardName: "Medicine Female", alerts: ["Allergy: Penicillin (severe)"], npo: false, weightKg: 58,
    orders: [orderLine(), insulin, lasa, prn,
      orderLine({ orderId: eid(6), title: "Noradrenaline 4 mg/4 ml", doseWords: "4 mg · IV · OD", highAlert: true, infusion: "running", frequency: "OD" }),
      orderLine({ orderId: eid(7), title: "Morphine 10 mg/ml", doseWords: "5 mg · IV · BD", highAlert: true, narcotic: true })],
    doses: [dose(base), dose(base, { doseId: eid(51), orderId: eid(2), dueAt: at(base, 5), windowStart: at(base, -25), windowEnd: at(base, 35) }),
      dose(base, { doseId: eid(52), orderId: eid(1), dueAt: at(base, -600), status: "given", outcome: { actId: eid(60), kind: "given", at: at(base, -598), byName: "Nurse Fake One", reason: null, patientCheck: "scan", late: false, secondNurseName: null, corrected: null } })],
    narcotic: [], ...over,
  };
}

export function scanOf(base: number, over: { highAlert?: boolean; lasa?: boolean; ok?: boolean; weight?: boolean; npo?: "none" | "sips" | "doctor" } = {}): IpdEmarScan {
  const p = emarPatientOf(base);
  const order = over.highAlert === true ? p.orders[1]! : over.lasa === true ? p.orders[2]! : p.orders[0]!;
  const d = p.doses.find((x) => x.orderId === order.orderId) ?? null;
  return {
    asOf: new Date(base).toISOString(), admissionId: p.admissionId, bandSerial: "IP26-000101-1",
    label: {
      labelId: eid(70), orderId: order.orderId, order, dose: d,
      checks: [
        { key: "patient", ok: over.ok !== false, words: over.ok === false ? "Label is for another patient" : "Right patient" },
        { key: "drug", ok: true, words: order.tallMan ?? order.title },
        { key: "dose", ok: true, words: order.doseWords },
        { key: "time", ok: true, words: "Due now" },
        { key: "route", ok: true, words: order.route.toUpperCase() },
      ],
      needs: { secondNurse: order.highAlert, lasaConfirm: order.lasa, weight: over.weight === true, lateReason: false, npo: over.npo ?? "none" },
    },
  };
}

export function dueOf(base: number): IpdEmarDueList {
  return {
    asOf: new Date(base).toISOString(),
    items: [
      { doseId: eid(51), admissionId: eid(100), bedCode: "F05-MED-F-B01", name: "Test Patient Asha", sealed: false, orderId: eid(2), title: "Actrapid 100 IU/ml", doseWords: "8 unit · SC · TDS", route: "sc", dueAt: at(base, 5), windowEnd: at(base, 35), status: "scheduled", overdue: false, highAlert: true },
      { doseId: eid(53), admissionId: eid(101), bedCode: "F05-MED-F-B02", name: "Test Patient Bina", sealed: false, orderId: eid(5), title: "Levetiracetam 500 mg", doseWords: "500 mg · oral · BD", route: "oral", dueAt: at(base, -50), windowEnd: at(base, -20), status: "missed", overdue: true, highAlert: false },
    ],
  };
}

export function pharmacyQueueOf(base: number): IpdEmarPharmacyQueue {
  const who = { admissionId: eid(100), identity: { name: "Test Patient Asha", uhid: "UH-FAKE-0101", ageYears: 54, sex: "female", sealed: false }, bedCode: "F05-MED-F-B01", wardName: "Medicine Female", alerts: ["Allergy: Penicillin (severe)"] };
  return {
    asOf: new Date(base).toISOString(),
    toVerify: [
      { ...who, order: orderLine({ orderId: eid(10), title: "Amoxyclav 625 mg", verification: "pending", issued: false, doseWords: "625 mg · oral · TDS", route: "oral", frequency: "TDS" }), orderedByName: "Dr Fake Consultant", orderedAt: at(base, -15),
        allergyOverrideReason: "Tolerated before", findings: [{ check: "allergy", severity: "stop", words: "Allergy: Penicillin — prescriber overrode: Tolerated before" }, { check: "duplicate", severity: "warn", words: "Same class (penicillin) as Ampicillin 500 mg" }], interactionDataPresent: false },
      { ...who, admissionId: eid(101), identity: { ...who.identity, name: "Test Patient Bina", uhid: "UH-FAKE-0102" }, bedCode: "F05-MED-F-B02", alerts: ["Allergy: none recorded"],
        order: orderLine({ orderId: eid(11), title: "Pantoprazole 40 mg", verification: "pending", issued: false, doseWords: "40 mg · IV · OD", frequency: "OD", timeCritical: false }), orderedByName: "Dr Fake Resident", orderedAt: at(base, -5), allergyOverrideReason: null, findings: [], interactionDataPresent: true },
    ],
    issued: [{ ...who, order: orderLine({ orderId: eid(15), title: "Ondansetron 4 mg", doseWords: "4 mg · oral · TDS", route: "oral", frequency: "TDS", timeCritical: false }), orderedByName: "Dr Fake Consultant", orderedAt: at(base, -400), allergyOverrideReason: null }],
    toIssue: [{ ...who, order: orderLine({ orderId: eid(12), title: "Actrapid 100 IU/ml", highAlert: true, issued: false, doseWords: "8 unit · SC · TDS" }), orderedByName: "Dr Fake Consultant", orderedAt: at(base, -40), allergyOverrideReason: null }],
    allergyFlags: [{ flagId: eid(20), orderId: eid(13), admissionId: eid(102), identity: { name: "Test Patient Chand", uhid: "UH-FAKE-0103", ageYears: 40, sex: "male", sealed: false }, bedCode: "F05-MED-M-B03", title: "Ceftriaxone 1 g", substances: ["Ceftriaxone"], raisedAt: at(base, -30), orderActive: true, doctorDecision: "continue", doctorReason: "Mild rash; benefit outweighs" }],
    returnsOwed: [{ issueId: eid(30), orderId: eid(14), admissionId: eid(100), identity: who.identity, bedCode: "F05-MED-F-B01", title: "Ondansetron 4 mg", units: 10, returnedUnits: 0, ownMedicine: false, issuedAt: at(base, -300) }],
  };
}

export function labelSheetOf(base: number): IpdEmarLabelSheet {
  return {
    issueId: eid(31),
    labels: [1, 2, 3].map((n) => ({
      labelId: eid(80 + n), code: `EML-${eid(80 + n)}`, seq: n, of: 3, units: n === 3 ? 5 : 10, drug: "Actrapid 100 IU/ml", tallMan: null, doseWords: "8 unit · SC · TDS",
      uhid: "UH-FAKE-0101", name: "Test Patient Asha", admissionNo: "IP26-000101", bedCode: "F05-MED-F-B01", issuedAt: new Date(base).toISOString(), ownMedicine: false, highAlert: true,
    })),
  };
}

export function wardChartOf(base: number): IpdEmarWardChart {
  const IST = 330 * 60_000;
  const start = new Date(Math.floor((base + IST) / 86_400_000) * 86_400_000 - IST);
  const h = (hour: number) => new Date(start.getTime() + hour * 3_600_000).toISOString();
  const p = emarPatientOf(base);
  const mk = (id: number, orderId: string, hour: number, status: IpdEmarDose["status"]): IpdEmarDose => ({
    doseId: eid(id), orderId, dueAt: h(hour), windowStart: h(hour - 1), windowEnd: h(hour + 1), status, reoffer: false, prn: false,
    outcome: status === "scheduled" ? null : { actId: eid(id + 500), kind: status as "given", at: h(hour), byName: "Nurse Fake One", reason: null, patientCheck: "scan", late: false, secondNurseName: null, corrected: null },
  });
  const rest = { ...p } as Partial<IpdEmarPatient>;
  delete rest.asOf;
  delete rest.narcotic;
  return {
    asOf: new Date(base).toISOString(), dayStart: start.toISOString(), dayEnd: new Date(start.getTime() + 86_400_000).toISOString(),
    ward: { id: eid(900), code: "F05-MED-F", name: "Medicine Female" }, wards: [{ id: eid(900), code: "F05-MED-F", name: "Medicine Female" }, { id: eid(901), code: "F05-MED-M", name: "Medicine Male" }],
    patients: [
      { ...(rest as Omit<IpdEmarPatient, "asOf" | "narcotic">), doses: [mk(200, eid(1), 9, "given"), mk(201, eid(1), 21, "scheduled"), mk(202, eid(2), 8, "given"), mk(203, eid(2), 14, "held"), mk(204, eid(2), 20, "scheduled"), mk(205, eid(3), 21, "scheduled")] },
      { ...(rest as Omit<IpdEmarPatient, "asOf" | "narcotic">), admissionId: eid(101), admissionNo: "IP26-000102", identity: { ...p.identity, name: "Test Patient Bina", uhid: "UH-FAKE-0102" }, bedCode: "F05-MED-F-B02", alerts: ["Allergy: none recorded"],
        orders: [orderLine({ orderId: eid(5), title: "Levetiracetam 500 mg", doseWords: "500 mg · oral · BD", route: "oral" })], doses: [mk(206, eid(5), 9, "missed"), mk(207, eid(5), 21, "scheduled")] },
    ],
  };
}

export function flagsOf(base: number, decided = false): { flags: IpdEmarPharmacyQueue["allergyFlags"] } {
  return { flags: [{
    flagId: eid(21), orderId: eid(1), admissionId: eid(100), identity: { name: "Test Patient Asha", uhid: "UH-FAKE-0101", ageYears: 54, sex: "female", sealed: false },
    bedCode: "F05-MED-F-B01", title: "Ceftriaxone 1 g", substances: ["Ceftriaxone"], raisedAt: at(base, -20), orderActive: true,
    doctorDecision: decided ? "continue" : null, doctorReason: decided ? "Mild rash; benefit outweighs" : null,
  }] };
}
