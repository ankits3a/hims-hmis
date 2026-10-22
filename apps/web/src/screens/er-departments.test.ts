import { ER_CALL_DEPARTMENTS } from "./er-patient";
import { ER_TRIAGE_DEPARTMENTS } from "./er-triage";

/**
 * #870 — the ER's department pickers send a code the server looks up in the roster's department masters
 * (`orgDepartmentByCode`); a code the masters lack is refused `department_not_found`. The web cannot import the core
 * module, so the master codes are pinned here: keep this list equal to ORG_DEPARTMENTS in
 * apps/core/src/modules/roster/masters.ts.
 */
const ROSTER_DEPARTMENT_CODES = new Set([
  "MED", "SUR", "PED", "OBG", "ORT", "ENT", "OPH", "DER", "PSY", "CAR", "DEN", "PHY", "RESP", "ANAE", "CAS",
  "RAD", "PATH", "MICR", "BIOC", "COMM", "FMT", "NURS", "PHAR", "ADMN",
]);

describe("ER department pickers offer roster department codes only", () => {
  it("triage's take-unit specialties", () => {
    expect(ER_TRIAGE_DEPARTMENTS.filter((c) => !ROSTER_DEPARTMENT_CODES.has(c))).toEqual([]);
  });

  it("the specialty call's departments", () => {
    expect(ER_CALL_DEPARTMENTS.filter((c) => !ROSTER_DEPARTMENT_CODES.has(c))).toEqual([]);
  });
});
