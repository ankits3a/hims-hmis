import { seatsFor } from "../src/seats";

/**
 * QUICK LAB ON THE PHONE (spec 2026-10-12) — each of the three screens behind its web menu's grant,
 * and all three gone while the lab runs Full. An unknown mode (not read yet, or the read failed)
 * hides nothing, so a failed read never locks the lab out of its own screens.
 */
const none = { hospital: [], scoped: { department: {}, floor: {} } };
const LAB = ["lab.worklist.read", "lab.results.enter", "lab.reports.print"];

describe("quick lab seats", () => {
  it("each screen needs its own grant", () => {
    expect(seatsFor({ ...none, hospital: ["lab.worklist.read"] }, "quick").map((s) => s.key)).toEqual(["qcollect"]);
    expect(seatsFor({ ...none, hospital: ["lab.results.enter"] }, "quick").map((s) => s.key)).toEqual(["qbench"]);
    expect(seatsFor({ ...none, hospital: ["lab.reports.print"] }, "quick").map((s) => s.key)).toEqual(["qreports"]);
    expect(seatsFor({ ...none, hospital: ["opd.vitals.record"] }, "quick").map((s) => s.key)).toEqual(["vitals"]);
  });

  it("shows all three in Quick mode and while the mode is unknown", () => {
    expect(seatsFor({ ...none, hospital: LAB }, "quick").map((s) => s.key)).toEqual(["qcollect", "qbench", "qreports"]);
    expect(seatsFor({ ...none, hospital: LAB }, null).map((s) => s.key)).toEqual(["qcollect", "qbench", "qreports"]);
    expect(seatsFor({ ...none, hospital: LAB }).map((s) => s.key)).toEqual(["qcollect", "qbench", "qreports"]);
  });

  it("hides all three in Full mode, and nothing else", () => {
    expect(seatsFor({ ...none, hospital: [...LAB, "roster.read"] }, "full").map((s) => s.key)).toEqual(["onNow", "myDuties"]);
  });

  it("a department-scoped lab grant does not open them: every quick route is hospital-wide", () => {
    expect(seatsFor({ hospital: [], scoped: { department: { d1: LAB }, floor: {} } }, "quick")).toEqual([]);
  });

  it("is milestone M7", () => {
    expect(seatsFor({ ...none, hospital: LAB }, "quick").map((s) => s.milestone)).toEqual(["M7", "M7", "M7"]);
  });

  it("the Quick counter needs lab.desk.operate hospital-wide, and goes in Full mode", () => {
    expect(seatsFor({ ...none, hospital: ["lab.desk.operate"] }, "quick").map((s) => s.key)).toEqual(["qcounter"]);
    expect(seatsFor({ ...none, hospital: ["lab.desk.operate"] }, null).map((s) => s.key)).toEqual(["qcounter"]);
    expect(seatsFor({ ...none, hospital: ["lab.desk.operate", ...LAB] }, "full")).toEqual([]);
    expect(seatsFor({ hospital: [], scoped: { department: { d1: ["lab.desk.operate"] }, floor: {} } }, "quick")).toEqual([]);
    expect(seatsFor({ ...none, hospital: ["lab.desk.operate", ...LAB] }, "quick").map((s) => s.key)).toEqual(["qcounter", "qcollect", "qbench", "qreports"]);
  });
});
