import { RosterError } from "./errors";
import {
  CRMI_LEAVE_DAYS, CRMI_TABLE, CRMI_TOTAL_WEEKS, MAX_BLOCK_WEEKS, crmiBlocks, crmiWeeksTotal,
  extensionPostings, internYear, splitBlock,
} from "./interns";

/**
 * PHASE R (R3) — **INVARIANT V17**: the intern year generated from the CRMI table sums to 52 weeks,
 * and an over-limit absence is repeated **in the department where it occurred**.
 *
 * These are pure functions, so this suite needs no database and no clock — which is the point. The
 * regulation is arithmetic, and arithmetic that can only be checked against a fixture is arithmetic
 * nobody re-checks.
 */
describe("roster — the CRMI intern year (V17)", () => {
  const START = "2026-03-01";

  /* ═══════════════════ the regulation, as arithmetic ═══════════════════ */

  it("the transcribed table sums to 52 weeks", () => {
    expect(crmiWeeksTotal()).toBe(CRMI_TOTAL_WEEKS);
    expect(CRMI_TOTAL_WEEKS).toBe(52);
  });

  it("no block runs longer than seven weeks once split, and splitting preserves the total", () => {
    const blocks = crmiBlocks();
    for (const b of blocks) {
      expect(`${b.departmentCode}: ${b.weeks <= MAX_BLOCK_WEEKS}`).toBe(`${b.departmentCode}: true`);
    }
    expect(blocks.reduce((n, b) => n + b.weeks, 0)).toBe(52);
  });

  it("Community Medicine's twelve weeks become two equal sixes, not a seven and a five", () => {
    expect(splitBlock(12)).toEqual([6, 6]);
    expect(splitBlock(7)).toEqual([7]);
    expect(splitBlock(1)).toEqual([1]);
    expect(splitBlock(15)).toEqual([5, 5, 5]);
    const comm = crmiBlocks().filter((b) => b.departmentCode === "COMM");
    expect(comm.map((b) => b.weeks)).toEqual([6, 6]);
    expect(comm.every((b) => b.external)).toBe(true);
  });

  /* ═══════════════════ the year itself ═══════════════════ */

  it("a generated year is 364 days of postings, contiguous and in order", () => {
    const plan = internYear({ batchStartIstDate: START });
    expect(plan.reduce((n, p) => n + p.days, 0)).toBe(52 * 7);
    expect(plan[0]!.startIstDate).toBe(START);
    // half-open and contiguous: one posting's end is the next one's start, with no gap and no overlap
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i]!.startIstDate).toBe(plan[i - 1]!.endIstDate);
    }
    expect(plan[plan.length - 1]!.endIstDate).toBe("2027-02-28"); // 364 days from 1 March 2026
  });

  it("every department the regulation names is served, for exactly the weeks it names", () => {
    const plan = internYear({ batchStartIstDate: START });
    const byDept = new Map<string, number>();
    for (const p of plan) byDept.set(p.departmentCode, (byDept.get(p.departmentCode) ?? 0) + p.days / 7);
    for (const row of CRMI_TABLE) {
      expect(`${row.departmentCode}: ${byDept.get(row.departmentCode)}`).toBe(`${row.departmentCode}: ${row.weeks}`);
    }
  });

  it("sub-batches are STAGGERED, so departments are not all empty at once", () => {
    const total = 4;
    const firsts = Array.from({ length: total }, (_, i) =>
      internYear({ batchStartIstDate: START, subBatch: i, subBatches: total })[0]!.departmentCode);
    // four sub-batches start in four different places — which is the property the hospital needs
    expect(new Set(firsts).size).toBe(total);
    // and each still works the full year
    for (let i = 0; i < total; i += 1) {
      const plan = internYear({ batchStartIstDate: START, subBatch: i, subBatches: total });
      expect(plan.reduce((n, p) => n + p.days, 0)).toBe(52 * 7);
    }
  });

  it("refuses a sub-batch that is not one of the batch, and a start that is not a day", () => {
    expect(() => internYear({ batchStartIstDate: START, subBatch: 4, subBatches: 4 })).toThrow(RosterError);
    expect(() => internYear({ batchStartIstDate: START, subBatch: -1, subBatches: 4 })).toThrow(RosterError);
    expect(() => internYear({ batchStartIstDate: "1 March 2026" })).toThrow(RosterError);
  });

  /* ═══════════════════ V17's second half — where the extension goes ═══════════════════ */

  it("absence inside the allowance costs nothing", () => {
    const plan = internYear({ batchStartIstDate: START });
    expect(extensionPostings(plan, [{ departmentCode: "PED", days: 10 }, { departmentCode: "MED", days: 5 }]))
      .toEqual([]);
  });

  it("absence BEYOND the allowance is repeated IN THE DEPARTMENT WHERE IT OCCURRED", () => {
    const plan = internYear({ batchStartIstDate: START });
    // 15 days go on Medicine; the Paediatrics fortnight is entirely over the line.
    const ext = extensionPostings(plan, [
      { departmentCode: "MED", days: CRMI_LEAVE_DAYS },
      { departmentCode: "PED", days: 14 },
    ]);
    expect(ext).toHaveLength(1);
    expect(ext[0]!.departmentCode).toBe("PED"); // NOT "wherever there is room"
    expect(ext[0]!.days).toBe(14);
    expect(ext[0]!.extension).toBe(true);
    // and it is served after the year's last posting, contiguously
    expect(ext[0]!.startIstDate).toBe(plan[plan.length - 1]!.endIstDate);
  });

  it("the allowance is ONE pool for the year, consumed in the order the absences happened", () => {
    const plan = internYear({ batchStartIstDate: START });
    const ext = extensionPostings(plan, [
      { departmentCode: "MED", days: 10 }, // 10 of 15 used
      { departmentCode: "SUR", days: 10 }, // 5 covered, 5 owed to Surgery
      { departmentCode: "ENT", days: 3 },  // nothing left: 3 owed to ENT
    ]);
    expect(ext.map((e) => [e.departmentCode, e.days])).toEqual([["SUR", 5], ["ENT", 3]]);
    // consecutive, so the intern serves one then the next
    expect(ext[1]!.startIstDate).toBe(ext[0]!.endIstDate);
  });

  it("two absences in ONE department are owed as one posting, not two", () => {
    const plan = internYear({ batchStartIstDate: START });
    const ext = extensionPostings(plan, [
      { departmentCode: "OBG", days: 20 }, // 15 covered, 5 owed
      { departmentCode: "OBG", days: 4 },  // 4 more owed, same department
    ]);
    expect(ext.map((e) => [e.departmentCode, e.days])).toEqual([["OBG", 9]]);
  });

  it("an extension to an EXTERNAL posting is served externally", () => {
    const plan = internYear({ batchStartIstDate: START });
    const ext = extensionPostings(plan, [{ departmentCode: "COMM", days: CRMI_LEAVE_DAYS + 7 }]);
    expect(ext).toHaveLength(1);
    expect(ext[0]!.external).toBe(true);
  });
});
