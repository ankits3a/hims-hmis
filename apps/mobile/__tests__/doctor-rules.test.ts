import { readFileSync } from "fs";
import { join } from "path";
import {
  LONG_WAIT_MINUTES, SKIP_REASONS, ageSexOf, besideName, briefResults, completionBody, followUpChoices, isUnpaid, longestWait, parkedSince,
  rowName, unissuedRxRows, visitKind, waitMinutes,
} from "../src/doctor/rules";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");
const NOW = new Date("2026-10-06T06:30:00.000Z"); // 12:00 IST
const P = { id: "p1", uhid: "U001", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };

describe("the doctor's line — one rules file for the web and the phone", () => {
  it("the web consult screen reads the SAME file: its two libraries re-export it and define nothing of their own", () => {
    const brief = read("../../web/src/lib/brief-history.ts");
    expect(brief).toContain('from "../../../../packages/contracts/src/doctor-queue"');
    expect(brief).not.toMatch(/export function (briefResults|briefRefill|istDay|shortDay)/);
    const label = read("../../web/src/lib/doctor-label.ts");
    expect(label).toContain('from "../../../../packages/contracts/src/doctor-queue"');
    expect(label).not.toMatch(/export function/);
    // …and the phone grows no second copy either.
    expect(read("../src/doctor/rules.ts")).not.toMatch(/export (function|const)/);
  });

  it("the skip reasons are the server's list, read off the server's own file", () => {
    const core = read("../../core/src/modules/opd/skip-reasons.ts");
    const list = /SKIP_REASONS = \[([^\]]+)\]/.exec(core)?.[1]?.match(/"([a-z_]+)"/g)?.map((x) => x.replace(/"/g, ""));
    expect(list).toBeDefined();
    expect([...SKIP_REASONS]).toEqual(list);
  });

  it("writes age and sex as the board does, and nothing at all for a sealed record", () => {
    expect(ageSexOf(P, NOW)).toBe("56 M");
    expect(ageSexOf({ ...P, administrativeGender: "female", dob: "2026-03-01T00:00:00.000Z" }, NOW)).toBe("7 mo F");
    expect(ageSexOf({ ...P, dob: null }, NOW)).toBe("M");
    expect(ageSexOf({ ...P, administrativeGender: "other", dob: null }, NOW)).toBeNull();
    expect(ageSexOf({ ...P, restricted: true, name: null, alias: "Patient K" }, NOW)).toBeNull();
    expect(rowName({ ...P, restricted: true, name: null, alias: "Patient K" })).toEqual({ text: "Patient K", sealed: true });
    expect(rowName(null)).toEqual({ text: null, sealed: false });
  });

  it("counts the wait from when the row became callable, never below zero, and names the longest", () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    expect(waitMinutes({ eligibleAt: at(41), createdAt: at(70) }, NOW)).toBe(41);
    expect(waitMinutes({ eligibleAt: null, createdAt: at(12) }, NOW)).toBe(12);
    expect(waitMinutes({ eligibleAt: at(-5), createdAt: at(1) }, NOW)).toBe(0);
    expect(longestWait([{ eligibleAt: at(14), createdAt: at(14) }, { eligibleAt: at(41), createdAt: at(41) }], NOW)).toBe(41);
    expect(longestWait([], NOW)).toBeNull();
    expect(LONG_WAIT_MINUTES).toBe(40);
  });

  it("says REFERRAL for a visit an internal referral opened, and UNPAID only when the server said unsettled", () => {
    const enc = { id: "e", patientId: "p", visitType: "new", dangerFlagged: false, status: "waiting" };
    expect(visitKind({ encounter: enc })).toBe("new");
    expect(visitKind({ encounter: { ...enc, visitType: "renewal" } })).toBe("renewal");
    expect(visitKind({ encounter: { ...enc, visitType: "revisit", referredFromEncounterId: "e0" } })).toBe("referral");
    expect(isUnpaid({ feeStatus: "unsettled" })).toBe(true);
    // `null` is "no status to report" — a row the server declined to characterise is never stamped.
    expect(isUnpaid({ feeStatus: null })).toBe(false);
    expect(isUnpaid({ feeStatus: "free" })).toBe(false);
  });

  it("reads a parked row only when the server said so in words", () => {
    expect(parkedSince({ parkedAt: "2026-10-06T06:00:00.000Z" })).toBe("2026-10-06T06:00:00.000Z");
    expect(parkedSince({ parkedAt: null })).toBeNull();
    // A server from before the park sends no field at all: that is not "parked".
    expect(parkedSince({})).toBeNull();
  });

  it("offers the default follow-up first and LEAVES IT OUT of the body, so the server's own default applies", () => {
    const choices = followUpChoices({ followUpDefaultDays: 7, followUpExtensionDays: [30, 14, 7] });
    expect(choices).toEqual([
      { days: 7, isDefault: true, send: null }, { days: 14, isDefault: false, send: 14 }, { days: 30, isDefault: false, send: 30 },
    ]);
    expect(followUpChoices(null)).toEqual([{ days: null, isDefault: true, send: null }]);
    expect(completionBody(false, null)).toEqual({ testsOrderedReturnToday: false });
    expect("followUpDays" in completionBody(false, null)).toBe(false);
    expect(completionBody(false, 14)).toEqual({ testsOrderedReturnToday: false, followUpDays: 14 });
    // "Tests ordered — returns today" is not a completion with a follow-up: no days travel with it.
    expect(completionBody(true, 14)).toEqual({ testsOrderedReturnToday: true });
  });

  it("counts the prescription rows typed and not issued — a blank editor row is not a prescription", () => {
    expect(unissuedRxRows(null)).toBe(0);
    expect(unissuedRxRows(undefined)).toBe(0);
    expect(unissuedRxRows([{ drug: "" }, { drug: "   " }])).toBe(0);
    expect(unissuedRxRows([{ drug: "Metformin 500 mg" }, { drug: "" }, { drug: "Telmisartan 40 mg" }])).toBe(2);
  });

  it("lists what the lab and radiology signed since the last visit, newest first, abnormal marked", () => {
    const lab = [
      { orderableName: "HbA1c", analyteName: "HbA1c", value: "8.9", unit: "%", flag: "H", verifiedAt: "2026-09-19T06:00:00.000Z" },
      { orderableName: "RFT", analyteName: "Creatinine", value: "1.3", unit: "mg/dL", flag: "N", verifiedAt: "2026-09-19T05:00:00.000Z" },
      { orderableName: "HbA1c", analyteName: "HbA1c", value: "8.1", unit: "%", flag: "H", verifiedAt: "2026-06-03T06:00:00.000Z" },
    ];
    const r = briefResults(lab, [], "2026-08-24");
    expect(r.noneSince).toBe(false);
    expect(r.lines.map((l) => [l.what, l.abnormal])).toEqual([["HbA1c 8.9 %", true], ["Creatinine 1.3 mg/dL", false]]);
    // Nothing since the last visit, but something on file: the most recent one, marked "none since".
    const none = briefResults(lab.slice(2), [], "2026-08-24");
    expect(none).toEqual({ lines: [{ what: "HbA1c 8.1 %", kind: "lab", day: "2026-06-03", abnormal: true }], noneSince: true });
  });

  it("writes the unit and the shortened designation beside a doctor's name", () => {
    expect(besideName({ unit: "Unit I", designation: "Assistant Professor" })).toBe("Unit I · Asst. Prof.");
    expect(besideName({ unit: null, designation: "Guest Faculty" })).toBe("Guest Faculty");
    expect(besideName({ unit: null, designation: null })).toBeNull();
  });
});
