import { addDayIso, mondayIndex } from "@hmis/contracts";
import type { FlowFinding } from "@hmis/contracts";
import { cellOf, dropsOf, flowAskOf, legsOf, rankFindings, statOf } from "./flow";
import type { FlowVisit, VisitLegs } from "./flow";
import { findCandidates, lastWeekdays } from "./flow-learning";
import { FLOW_MAX_WAIT_MIN } from "./flow-rules";

/**
 * HOW LONG PATIENTS WAIT (owner 2026-10-09) — the pure half: a visit's three legs and every exclusion,
 * the floor, the periods and their comparisons with a HANDED clock, and each finding type firing on a
 * fixture built for it and staying silent just under its line. Every day here is handed in; nothing
 * reads the real clock.
 */
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+05:30`);
const plus = (d: Date, min: number): Date => new Date(d.getTime() + min * 60_000);

function visit(o: Partial<FlowVisit> & { day: string; desk: string; a?: number | null; b?: number | null; c?: number | null; dept?: string | null }): FlowVisit {
  const openedAt = at(o.day, o.desk);
  const vitalsAt = o.a === null || o.a === undefined ? null : plus(openedAt, o.a);
  const startedAt = vitalsAt === null || o.b === null || o.b === undefined ? null : plus(vitalsAt, o.b);
  /* `c`: minutes from Start consultation to Complete; given, the visit was completed on a screen unless told otherwise. */
  const completedAt = startedAt === null || o.c === null || o.c === undefined ? null : plus(startedAt, o.c);
  return {
    departmentId: o.dept === undefined ? "D1" : o.dept, serviceDate: o.day, openedAt, vitalsAt, startedAt,
    completedAt, screenCompleted: o.screenCompleted ?? completedAt !== null,
    guardian: o.guardian ?? false, left: o.left ?? false, paperNoStart: o.paperNoStart ?? false, reEntry: o.reEntry ?? false,
  };
}

describe("a visit's legs — from three stored instants", () => {
  const DAY = "2026-10-05";
  it("desk → vitals, vitals → doctor and their sum; a leg that has not happened is simply absent", () => {
    const v = legsOf(visit({ day: DAY, desk: "10:00", a: 12, b: 20 }));
    expect([v.legs.deskToVitals?.min, v.legs.vitalsToDoctor?.min, v.legs.deskToDoctor?.min, v.drop]).toEqual([12, 20, 32, null]);
    const waiting = legsOf(visit({ day: DAY, desk: "10:00", a: 12, b: null }));
    expect([waiting.legs.deskToVitals?.min, waiting.legs.vitalsToDoctor, waiting.legs.deskToDoctor, waiting.drop]).toEqual([12, undefined, undefined, null]);
  });

  it("each exclusion drops what it should and is counted once", () => {
    const vs = [
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, guardian: true }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, left: true }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, paperNoStart: true }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, reEntry: true }),
      visit({ day: DAY, desk: "10:00", a: -1, b: 20 }),
      visit({ day: DAY, desk: "10:00", a: 12, b: FLOW_MAX_WAIT_MIN + 1 }),
      visit({ day: DAY, desk: "10:00", a: FLOW_MAX_WAIT_MIN, b: 0 }),
    ].map(legsOf);
    expect(vs.map((v) => [v.drop, v.legs.deskToVitals?.min ?? null, v.legs.vitalsToDoctor?.min ?? null, v.legs.deskToDoctor?.min ?? null])).toEqual([
      ["guardian", null, null, null],
      ["left", null, null, null],
      ["paperNoStart", 12, null, null], // the desk → vitals wait was real; the start on paper is not
      ["reEntry", 12, null, null],
      ["outOfRange", null, 20, null],
      ["outOfRange", 12, null, null],
      [null, FLOW_MAX_WAIT_MIN, 0, FLOW_MAX_WAIT_MIN], // both edges are in
    ]);
    expect(dropsOf(vs)).toEqual({ guardian: 1, left: 1, paperNoStart: 1, reEntry: 1, outOfRange: 2 });
  });
});

describe("in consultation — Start consultation → Complete, a duration and never a wait (owner 2026-10-09)", () => {
  const DAY = "2026-10-05";
  it("a screen-completed visit has it; paper-closed, under 0 and over the max do not — and only that leg goes", () => {
    const vs = [
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: 9 }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: 9, screenCompleted: false }), // the desk stamped both instants from paper
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: -3 }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: FLOW_MAX_WAIT_MIN + 1 }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: FLOW_MAX_WAIT_MIN }),
      visit({ day: DAY, desk: "10:00", a: 12, b: 20, c: 9, reEntry: true }), // the second start → Complete is real
    ].map(legsOf);
    expect(vs.map((v) => [v.legs.consult?.min ?? null, v.legs.deskToDoctor?.min ?? null, v.drop])).toEqual([
      [9, 32, null],
      [null, 32, null],
      [null, 32, "outOfRange"],
      [null, 32, "outOfRange"],
      [FLOW_MAX_WAIT_MIN, 32, null],
      [9, null, "reEntry"],
    ]);
    /* It starts at Start consultation (the by-hour strip), and desk → doctor never includes it. */
    expect(vs[0]!.legs.consult!.at).toEqual(plus(at(DAY, "10:00"), 32));
  });

  it("is a column of every cell, with the same floor", () => {
    const five = Array.from({ length: 5 }, (_, i) => legsOf(visit({ day: DAY, desk: "10:00", a: 10, b: 10, c: 6 + i })));
    expect(cellOf(five).consult).toEqual({ n: 5, avg: 8, median: 8, p90: 10 });
    expect(cellOf(five.slice(0, 4)).consult).toEqual({ n: 4, avg: null, median: null, p90: null });
  });
});

describe("the floor — a cell shows only with five visits", () => {
  it("four visits: n and nothing else; five: Avg, median and p90", () => {
    expect(statOf([10, 20, 30, 40])).toEqual({ n: 4, avg: null, median: null, p90: null });
    expect(statOf([10, 20, 30, 40, 100])).toEqual({ n: 5, avg: 40, median: 30, p90: 100 });
    expect(statOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, avg: 5.5, median: 5.5, p90: 9 });
  });
  it("cellOf applies it per leg", () => {
    const vs = [12, 13, 14, 15, 16].map((a, i) => legsOf(visit({ day: "2026-10-05", desk: "10:00", a, b: i < 4 ? 10 : null })));
    const c = cellOf(vs);
    expect(c.deskToVitals).toEqual({ n: 5, avg: 14, median: 14, p90: 16 });
    expect(c.vitalsToDoctor).toEqual({ n: 4, avg: null, median: null, p90: null });
  });
});

describe("periods and what each is compared with — the clock is handed in", () => {
  const nowOn = (iso: string): Date => new Date(iso);
  it("today ↔ the same weekday last week; week ↔ last week to the same weekday; month ↔ last month to the same day number — across a month boundary", () => {
    /* Sunday 1 November 2026, 09:00 IST — the first of a month, and the week began in October. */
    const now = nowOn("2026-11-01T09:00:00+05:30");
    const ask = (q: Record<string, string>) => { const r = flowAskOf(q, now); if (!r.ok) throw new Error(r.problem); return r.ask; };
    expect(ask({ period: "today" })).toMatchObject({ range: { from: "2026-11-01", to: "2026-11-01" }, compare: { from: "2026-10-25", to: "2026-10-25" } });
    expect(ask({ period: "week" })).toMatchObject({ range: { from: "2026-10-26", to: "2026-11-01" }, compare: { from: "2026-10-19", to: "2026-10-25" } });
    expect(ask({ period: "month" })).toMatchObject({ range: { from: "2026-11-01", to: "2026-11-01" }, compare: { from: "2026-10-01", to: "2026-10-01" } });
    /* 31 March: the month before has no 31st, so it stops on its last day. */
    const march = flowAskOf({ period: "month" }, nowOn("2027-03-31T12:00:00+05:30"));
    expect(march.ok && march.ask).toMatchObject({ range: { from: "2027-03-01", to: "2027-03-31" }, compare: { from: "2027-02-01", to: "2027-02-28" } });
    /* 23:59 IST is still the same IST day though UTC has moved on; 00:01 IST is the next. */
    const late = flowAskOf({ period: "today" }, nowOn("2026-10-31T23:59:00+05:30"));
    expect(late.ok && late.ask.range.from).toBe("2026-10-31");
  });
  it("a custom range: never the future, at most 92 days; a grouping and a department checked", () => {
    const now = nowOn("2026-11-01T09:00:00+05:30");
    expect(flowAskOf({ from: "2026-10-01", to: "2026-11-02" }, now)).toEqual({ ok: false, problem: "future" });
    expect(flowAskOf({ from: "2026-01-01", to: "2026-10-31" }, now)).toEqual({ ok: false, problem: "too_long" });
    expect(flowAskOf({ from: "2026-10-01", to: "2026-10-31", groupBy: "doctor" }, now)).toEqual({ ok: false, problem: "bad_group" });
    expect(flowAskOf({ period: "year" }, now)).toEqual({ ok: false, problem: "bad_date" });
    expect(flowAskOf({ from: "2026-10-01", to: "2026-10-31", cfrom: "2026-09-01", cto: "2026-09-30", groupBy: "weekday", departmentId: "D1" }, now))
      .toEqual({ ok: true, ask: { range: { from: "2026-10-01", to: "2026-10-31" }, compare: { from: "2026-09-01", to: "2026-09-30" }, groupBy: "weekday", departmentId: "D1" } });
  });
});

/* ═══ the findings ═══ */

/** Friday 9 October 2026. */
const TODAY = "2026-10-09";
const FRIDAY = mondayIndex(TODAY);
const DESK_TIMES = ["10:00", "10:30", "11:00", "11:30", "13:00", "14:00", "15:00", "16:00"];

/** 42 days of an ordinary department: eight visits a day, desk → vitals 10, vitals → doctor 12, in consultation 8. */
function background(o: { dept?: string; days?: number; perDay?: readonly string[]; a?: (day: string, desk: string) => number; b?: (day: string, desk: string) => number; c?: (day: string) => number } = {}): VisitLegs[] {
  const out: VisitLegs[] = [];
  for (let i = 0; i < (o.days ?? 42); i += 1) {
    const day = addDayIso(TODAY, -i);
    for (const desk of o.perDay ?? DESK_TIMES) out.push(legsOf(visit({ dept: o.dept ?? "D1", day, desk, a: o.a?.(day, desk) ?? 10, b: o.b?.(day, desk) ?? 12, c: o.c?.(day) ?? 8 })));
  }
  return out;
}
const fridays = lastWeekdays(TODAY, FRIDAY, 4);
const inWindow = (desk: string): boolean => desk >= "10:00" && desk < "12:00";
const types = (vs: VisitLegs[]): string[] => findCandidates(vs, TODAY).map((c) => `${c.type}:${c.scope}:${String(c.weekday)}:${String(c.hourFrom)}`).sort();

describe("findings — each type fires on a fixture built for it and is silent just under its line", () => {
  it("an ordinary month raises nothing", () => {
    expect(types([...background(), ...background({ dept: "D2" })])).toEqual([]);
  });

  it("bay_peak: desk → vitals 10–12 on ≥ 3 of the last 4 Fridays at ≥ 1.5× the department's median, n ≥ 8", () => {
    const hot = (n: number, onDays: readonly string[]) => background({ a: (day, desk) => (onDays.includes(day) && inWindow(desk) ? n : 10) });
    expect(types(hot(20, fridays.slice(0, 3)))).toEqual([`bay_peak:D1:${String(FRIDAY)}:10`]);
    const c = findCandidates(hot(20, fridays), TODAY)[0]!;
    expect(c).toMatchObject({ type: "bay_peak", leg: "deskToVitals", hourFrom: 10, hourTo: 12, observed: 20, baseline: 10, patients: 16 });
    /* just under: 14.9 minutes is under 1.5 × 10; two Fridays of four are not three. */
    expect(types(hot(14.9, fridays))).toEqual([]);
    expect(types(hot(20, fridays.slice(0, 2)))).toEqual([]);
    /* n under 8: three hot Fridays with two visits each in the window, and a quiet one with one. */
    const thin = background({ perDay: ["10:00", "10:30", "13:00", "14:00", "15:00", "16:00"], a: (day, desk) => (fridays.slice(0, 3).includes(day) && inWindow(desk) ? 20 : 10) })
      .filter((v) => !(v.serviceDate === fridays[3] && v.legs.deskToVitals!.at.getTime() === new Date(`${fridays[3]!}T10:30:00+05:30`).getTime()));
    expect(types(thin)).toEqual([]);
  });

  it("doctor_start_late: vitals → doctor long in the department's first hour on ≥ 3 of the last 4 Fridays — by department, no doctor", () => {
    const early = (b: number, onDays: readonly string[]) => [
      ...background(),
      ...onDays.flatMap((day) => ["08:00", "08:10", "08:20"].map((desk) => legsOf(visit({ day, desk, a: 5, b })))),
    ];
    expect(types(early(30, fridays.slice(0, 3)))).toEqual([`doctor_start_late:D1:${String(FRIDAY)}:8`]);
    const c = findCandidates(early(30, fridays), TODAY).find((x) => x.type === "doctor_start_late")!;
    expect(c).toMatchObject({ leg: "vitalsToDoctor", hourFrom: 8, hourTo: 9, observed: 30, baseline: 12, patients: 12 });
    expect(JSON.stringify(c)).not.toMatch(/doctor(Id|Name)/);
    expect(types(early(17.9, fridays))).toEqual([]);
    expect(types(early(30, fridays.slice(0, 2)))).toEqual([]);
  });

  it("dept_outlier: a department's vitals → doctor median ≥ 1.5× the hospital's over 28 days, n ≥ 30", () => {
    const two = (b2: number, perDay: readonly string[] = ["10:00", "14:00"]) => [...background(), ...background({ dept: "D2", perDay, b: () => b2 })];
    expect(types(two(30))).toEqual(["dept_outlier:D2:null:null"]);
    expect(findCandidates(two(30), TODAY)[0]).toMatchObject({ leg: "vitalsToDoctor", observed: 30, baseline: 12, patients: 56 });
    expect(types(two(17.9))).toEqual([]);
    /* one visit a day: 28 in 28 days is under 30. */
    expect(types(two(30, ["10:00"]))).toEqual([]);
  });

  it("week_regression: this week's desk → doctor median ≥ 25 % over the four weeks before, n ≥ 30 — for the department and the hospital", () => {
    const thisWeek = (b: number) => background({ b: (day) => (day > addDayIso(TODAY, -7) ? b : 12) });
    expect(types(thisWeek(18))).toEqual(["week_regression:D1:null:null", "week_regression:hospital:null:null"]);
    expect(findCandidates(thisWeek(18), TODAY)[0]).toMatchObject({ leg: "deskToDoctor", observed: 28, baseline: 22, patients: 56 });
    expect(types(thisWeek(17.4))).toEqual([]); // 27.4 < 1.25 × 22 = 27.5
  });

  it("consult_up: this week's in-consultation median ≥ 25 % over the four weeks before, n ≥ 30 — department and hospital, never a doctor", () => {
    const longer = (c: number) => background({ c: (day) => (day > addDayIso(TODAY, -7) ? c : 8) });
    expect(types(longer(10))).toEqual(["consult_up:D1:null:null", "consult_up:hospital:null:null"]);
    const f = findCandidates(longer(10), TODAY)[0]!;
    expect(f).toMatchObject({ leg: "consult", observed: 10, baseline: 8, patients: 56 });
    expect(JSON.stringify(f)).not.toMatch(/doctor(Id|Name)/);
    expect(types(longer(9.9))).toEqual([]); // 9.9 < 1.25 × 8 = 10
    /* the waits are untouched by it: desk → doctor stays 22 */
    expect(cellOf(longer(10)).deskToDoctor.median).toBe(22);
  });
});

describe("the seam — a chooser may only reorder", () => {
  const f = (id: string, minutesLost: number) => ({ id, minutesLost }) as FlowFinding;
  it("by minutes lost by default; a ranker's extra ids are ignored and the ids it drops come back at the end", () => {
    expect(rankFindings([f("a", 10), f("b", 90), f("c", 40)]).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(rankFindings([f("a", 10), f("b", 90), f("c", 40)], () => ["c", "zz", "c", "a"]).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});
