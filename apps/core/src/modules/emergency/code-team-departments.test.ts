import { ER_CODE_KINDS, ER_CODE_TEAM } from "@hmis/contracts";
import { ORG_DEPARTMENTS } from "../roster";

/**
 * #870 — a code pages "the department on take" by looking its code up in the roster's department masters
 * (`orgDepartmentByCode`). A code the masters do not have finds nothing and the page silently falls back to the role,
 * so every named department must be a real roster master code. Null means "no department: the role" on purpose.
 */
describe("ER code team ↔ roster department masters", () => {
  const rosterCodes = new Set(ORG_DEPARTMENTS.map((d) => d.code));

  it("every code team's department is a roster master department code", () => {
    const unknown = ER_CODE_KINDS
      .map((k) => ({ kind: k, departmentCode: ER_CODE_TEAM[k].departmentCode }))
      .filter((t) => t.departmentCode !== null && !rosterCodes.has(t.departmentCode));
    expect(unknown).toEqual([]);
  });
});
