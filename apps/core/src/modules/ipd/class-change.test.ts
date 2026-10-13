import { applyClassChanges, nextNoonIst } from "./class-change";

/** E3.1 (#729) — the class change's two pure rules: "next noon" and the split of a stay at that instant. */
const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("nextNoonIst", () => {
  it("is today's 12:00 IST before noon, tomorrow's at or after it", () => {
    expect(nextNoonIst(ist("2026-03-11T09:00:00"))).toEqual(ist("2026-03-11T12:00:00"));
    expect(nextNoonIst(ist("2026-03-11T12:00:00"))).toEqual(ist("2026-03-12T12:00:00"));
    expect(nextNoonIst(ist("2026-03-11T23:59:00"))).toEqual(ist("2026-03-12T12:00:00"));
    expect(nextNoonIst(ist("2026-03-12T00:01:00"))).toEqual(ist("2026-03-12T12:00:00"));
  });
});

describe("applyClassChanges", () => {
  const stay = { id: "s1", bedClass: "general" as const, billedClass: "general" as const, startedAt: ist("2026-03-10T10:00:00"), endedAt: null };

  it("splits an open stay at the effective instant; the later part bills at the new class", () => {
    expect(applyClassChanges([stay], [{ stayId: "s1", toClass: "private", effectiveFrom: ist("2026-03-11T12:00:00") }])).toEqual([
      { ...stay, endedAt: ist("2026-03-11T12:00:00") },
      { ...stay, startedAt: ist("2026-03-11T12:00:00"), billedClass: "private" },
    ]);
  });

  it("ignores a change on another stay or one after the stay ended (the patient left the bed first)", () => {
    const ended = { ...stay, endedAt: ist("2026-03-11T11:00:00") };
    expect(applyClassChanges([ended], [
      { stayId: "s1", toClass: "private", effectiveFrom: ist("2026-03-11T12:00:00") },
      { stayId: "s2", toClass: "suite", effectiveFrom: ist("2026-03-10T12:00:00") },
    ])).toEqual([ended]);
  });

  it("applies two changes in order", () => {
    const parts = applyClassChanges([stay], [
      { stayId: "s1", toClass: "general", effectiveFrom: ist("2026-03-13T12:00:00") },
      { stayId: "s1", toClass: "private", effectiveFrom: ist("2026-03-11T12:00:00") },
    ]);
    expect(parts.map((p) => p.billedClass)).toEqual(["general", "private", "general"]);
  });
});
