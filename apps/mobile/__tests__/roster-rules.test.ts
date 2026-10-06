import { readFileSync } from "fs";
import { join } from "path";
import { translate } from "../src/i18n";
import { NetworkError, ApiError } from "../src/api";
import { rosterRefusal } from "../src/roster/api";
import {
  backupOf, clockNoteOf, coverBuckets, dutyWhatKey, flaggablePeople, greetingKey, greetingName, hasNoTakeCycle, isDaytime, istDay, opdFallbackOf,
  requestTone, shortUnit, takeTillOf, weekOf,
} from "../src/roster/rules";
import type { WireBoardDepartment, WireCoverRequest, WireMyDuty } from "../src/roster/rules";
import { clockLine, dayLong, dowShort, dutyWhat, reasonText, shortWhen, whyNot } from "../src/roster/words";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");
const en = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const hi = (k: string, v?: Record<string, string | number>) => translate("hi", k, v);

const unit = (name: string, startsAt: string, endsAt: string) => ({ teamId: "t", code: "MED-U1", name, startsAt, endsAt });
const dept = (over: Partial<WireBoardDepartment> = {}): WireBoardDepartment => ({
  departmentId: "d-med", code: "MED", name: "General Medicine", units: 5, source: "published", skeleton: false,
  unitOnTake: unit("General Medicine Unit III", "2026-10-06T02:30:00.000Z", "2026-10-07T02:30:00.000Z"), backupUnit: null,
  inTheBuilding: [], facultyOnCall: [], ...over,
});
const duty = (over: Partial<WireMyDuty> = {}): WireMyDuty => ({
  assignmentId: "a1", userId: "u1", positionKey: "ward_jr", positionLabel: "Ward JR", startsAt: "2026-10-06T03:30:00.000Z", endsAt: "2026-10-06T12:00:00.000Z",
  istDate: "2026-10-06", night: false, mode: "site", kind: "duty", departmentId: "d-med", teamId: "t", teamName: "General Medicine Unit I", activities: ["ward"], upcoming: true, ...over,
});
const request = (over: Partial<WireCoverRequest> = {}): WireCoverRequest => ({
  requestId: "r1", kind: "cover", status: "asked", crossUnit: false,
  owner: { userId: "u1", name: "Dr. Meena Joshi" }, counterpart: { userId: "u2", name: "Dr. Arjun Rao" }, requestedBy: { userId: "u1", name: "Dr. Meena Joshi" },
  duty: duty(), give: null, note: null, requestedAt: "2026-10-06T04:00:00.000Z", answeredAt: null, decidedBy: null, decidedAt: null, refusedRule: null, check: null,
  youMay: { answer: false, approve: false, withdraw: true }, ...over,
});

describe("the roster's reading rules — one file for the web and the phone", () => {
  it("the web board and web My duties read the SAME file, and neither keeps its own copy of a rule", () => {
    const board = read("../../web/src/screens/roster-on-now.tsx");
    expect(board).toContain('from "../../../../packages/contracts/src/roster-board"');
    expect(board).not.toMatch(/function (shortUnit|isDaytime)\(/);
    expect(board).not.toMatch(/const istMinutes = /);
    const mine = read("../../web/src/screens/roster-my-duties.tsx");
    expect(mine).toContain('from "../../../../packages/contracts/src/roster-board"');
    expect(mine).not.toMatch(/export function weekOf\(/);
    // The wire shapes too: the web's API file re-exports them and defines none of these itself.
    const api = read("../../web/src/lib/roster-api.ts");
    expect(api).toContain('from "../../../../packages/contracts/src/roster-board"');
    expect(api).not.toMatch(/export type (WireOnNowBoard|WireMyDuties|WireCoverRequest|WireBoardDepartment) =/);
    // …and the phone grows no second copy either.
    expect(read("../src/roster/rules.ts")).not.toMatch(/export (function|const|type) /);
  });

  it("the take runs 08:00 to 08:00 IST: at 02:40 it is still yesterday's unit, and the note says so", () => {
    const take = unit("General Medicine Unit II", "2026-10-05T02:30:00.000Z", "2026-10-06T02:30:00.000Z");
    // 02:40 IST on the 6th = 21:10 UTC on the 5th.
    expect(clockNoteOf({ at: "2026-10-05T21:10:00.000Z", departments: [dept({ unitOnTake: take })] })).toEqual({ key: "noteLate", take });
    // 21:00 IST the same take day: the night team is in.
    expect(clockNoteOf({ at: "2026-10-05T15:30:00.000Z", departments: [dept({ unitOnTake: take })] }).key).toBe("noteNight");
    // 11:00 IST: today's units took over.
    expect(clockNoteOf({ at: "2026-10-05T05:30:00.000Z", departments: [dept({ unitOnTake: take })] }).key).toBe("noteDay");
    expect(clockNoteOf({ at: "2026-10-05T05:30:00.000Z", departments: [dept({ unitOnTake: null })] })).toEqual({ key: "intro" });
  });

  it("a unit's till: one-unit departments say so; a handover on another day is flagged as not today", () => {
    expect(takeTillOf(dept({ unitOnTake: null }), "2026-10-06T06:00:00.000Z")).toBeNull();
    expect(takeTillOf(dept({ units: 1 }), "2026-10-06T06:00:00.000Z")).toEqual({ single: true });
    // 11:30 IST on the 6th, handover 08:00 IST on the 7th.
    expect(takeTillOf(dept(), "2026-10-06T06:00:00.000Z")).toMatchObject({ single: false, sameDay: false });
    // 02:00 IST on the 7th, same handover: it is today.
    expect(takeTillOf(dept(), "2026-10-06T20:30:00.000Z")).toMatchObject({ single: false, sameDay: true });
  });

  it("the overflow: the named backup unit, General Medicine for a one-unit department, else nobody", () => {
    const med = dept();
    expect(backupOf(dept({ backupUnit: unit("General Medicine Unit II", "x", "y") }), { departments: [med] })).toEqual({ key: "backup", unit: "Unit II" });
    const ent = dept({ departmentId: "d-ent", code: "ENT", name: "ENT", units: 1 });
    expect(backupOf(ent, { departments: [med, ent] })).toEqual({ key: "coveredBy", dept: "General Medicine" });
    expect(backupOf(ent, { departments: [ent] })).toEqual({ key: "singleBackup" });
    expect(backupOf(med, { departments: [med] })).toEqual({ key: "noBackup" });
  });

  it("an OPD-only hospital gets ONE quiet line, and a take cycle that does not exist is told apart from an unpublished roster", () => {
    const opd = dept({ source: "static", inOpd: [] });
    expect(opdFallbackOf({ departments: [opd, opd] })).toBe("opdFallbackAll");
    expect(opdFallbackOf({ departments: [opd, dept()] })).toBe("opdFallbackSome");
    expect(opdFallbackOf({ departments: [dept()] })).toBeNull();
    const hole = { kind: "no_take_cycle" as const, departmentId: "d-med", departmentName: "General Medicine", from: "", to: "", positionKey: null, positionLabel: null, userId: null, name: null, count: null };
    expect(hasNoTakeCycle(dept(), { holes: [hole] })).toBe(true);
    expect(hasNoTakeCycle(dept({ departmentId: "d-ent" }), { holes: [hole] })).toBe(false);
  });

  it("a flag may name anybody the row shows — once each, vacancies left out", () => {
    const d = dept({
      inTheBuilding: [{ userId: "u1", name: "Dr. A", positionKey: "ward_jr", positionLabel: "", cadre: "junior_resident", phone: null }],
      facultyOnCall: [{ userId: "u1", name: "Dr. A", positionKey: "faculty_on_call", positionLabel: "", callTier: 1 }, { userId: null, name: null, positionKey: "faculty_on_call", positionLabel: "", callTier: 2 }, { userId: "u3", name: "Dr. C", positionKey: "faculty_on_call", positionLabel: "", callTier: 3 }],
    });
    expect(flaggablePeople(d)).toEqual([{ userId: "u1", name: "Dr. A" }, { userId: "u3", name: "Dr. C" }]);
  });

  it("names a duty in two words, in both languages", () => {
    expect(dutyWhat(duty({ activities: ["opd"] }), en)).toBe("OPD");
    expect(dutyWhat(duty({ night: true, positionKey: "ward_jr" }), en)).toBe("Ward night");
    // A night duty of a post with no word of its own falls back, never shows a raw key.
    expect(dutyWhatKey(duty({ night: true, positionKey: "casualty_mo" }))).toEqual({ key: "rosterMyDuties.night.casualty_mo", fallback: "rosterMyDuties.night.other" });
    expect(dutyWhat(duty({ night: true, positionKey: "casualty_mo" }), en)).toBe("Night duty");
    expect(dutyWhat(duty({ startsAt: "2026-10-06T02:30:00.000Z", endsAt: "2026-10-07T02:30:00.000Z" }), en)).toBe("Take · 24 hours");
    expect(dutyWhat(duty({ kind: "teaching" }), en)).toBe("Teaching");
    expect(dutyWhat(duty({ activities: [], mode: "call" }), en)).toBe("On call");
    expect(dutyWhat(duty({ activities: [] }), en)).toBe("Day duty");
    expect(dutyWhat(duty({ activities: ["opd"] }), hi)).toBe(translate("hi", "rosterMyDuties.what.opd"));
  });

  it("the day after a night is REST — twelve hours from when the night ended — unless a duty is rostered", () => {
    const night = duty({ assignmentId: "n", night: true, istDate: "2026-10-06", startsAt: "2026-10-06T14:30:00.000Z", endsAt: "2026-10-07T02:30:00.000Z" });
    const week = weekOf({ days: ["2026-10-06", "2026-10-07", "2026-10-08"], duties: [night] });
    expect(week[0]).toMatchObject({ istDate: "2026-10-06", duty: night, rest: null });
    expect(week[1]).toEqual({ istDate: "2026-10-07", duty: null, rest: { until: "2026-10-07T14:30:00.000Z" } });
    expect(week[2]).toEqual({ istDate: "2026-10-08", duty: null, rest: null });
    // A night and a day on one date: the night is the day's headline.
    const both = weekOf({ days: ["2026-10-06"], duties: [duty({ assignmentId: "d" }), night] });
    expect(both[0]!.duty?.assignmentId).toBe("n");
    // An "off" row is not a duty.
    expect(weekOf({ days: ["2026-10-06"], duties: [duty({ kind: "off" })] })[0]!.duty).toBeNull();
  });

  it("sorts the requests on my page: mine to answer, mine to watch, already answered — and which duties are already asked about", () => {
    const iAsked = request();
    const askedOfMe = request({ requestId: "r2", owner: { userId: "u2", name: "Dr. Arjun Rao" }, counterpart: { userId: "u1", name: "Dr. Meena Joshi" }, duty: duty({ assignmentId: "a9" }), youMay: { answer: true, approve: false, withdraw: false } });
    const iAnswered = request({ requestId: "r3", status: "accepted", owner: { userId: "u2", name: "Dr. Arjun Rao" }, counterpart: { userId: "u1", name: "x" }, duty: duty({ assignmentId: "a8" }), give: duty({ assignmentId: "a7" }) });
    const withdrawn = request({ requestId: "r4", status: "withdrawn" });
    const b = coverBuckets([iAsked, askedOfMe, iAnswered, withdrawn], "u1");
    expect(b.ofMe.map((r) => r.requestId)).toEqual(["r2"]);
    expect(b.mine.map((r) => r.requestId)).toEqual(["r1"]);
    expect(b.answered.map((r) => r.requestId)).toEqual(["r3"]);
    expect([...b.asked].sort()).toEqual(["a1", "a7", "a8", "a9"]);
    expect([requestTone("approved"), requestTone("refused"), requestTone("declined"), requestTone("asked"), requestTone("accepted")]).toEqual(["ok", "bad", "bad", "open", "open"]);
  });

  it("greets by first name, by the IST hour — never the device's zone", () => {
    expect(greetingName("Dr. Meena Joshi")).toBe("Dr. Meena");
    expect(greetingName("Meena Joshi")).toBe("Meena");
    expect(greetingName(null)).toBe("");
    expect(greetingKey("2026-10-06T03:00:00.000Z")).toBe("morning"); // 08:30 IST
    expect(greetingKey("2026-10-06T07:00:00.000Z")).toBe("afternoon"); // 12:30 IST
    expect(greetingKey("2026-10-06T12:00:00.000Z")).toBe("evening"); // 17:30 IST
    expect(istDay("2026-10-05T19:00:00.000Z")).toBe("2026-10-06"); // 00:30 IST
    expect(isDaytime("2026-10-06T03:00:00.000Z")).toBe(true);
    expect(isDaytime("2026-10-06T15:00:00.000Z")).toBe(false); // 20:30 IST
    expect(shortUnit("General Medicine Unit III", "General Medicine")).toBe("Unit III");
    expect(shortUnit("ENT Unit I", "General Medicine")).toBe("ENT Unit I");
  });

  it("says days and clock times in IST and in the reader's language, from the app's own words", () => {
    // 2026-10-04T11:09Z = Sunday 16:39 IST.
    expect(clockLine("2026-10-04T11:09:00.000Z", en)).toBe("Sunday 4 October, 16:39");
    expect(clockLine("2026-10-04T11:09:00.000Z", hi)).toBe("रविवार 4 अक्टूबर, 16:39");
    expect(shortWhen("2026-10-04T20:00:00.000Z", en)).toBe("Mon 5 Oct, 01:30");
    expect(dowShort("2026-10-07", en)).toBe("WED");
    expect(dayLong("2026-10-10", en)).toBe("Saturday 10 Oct");
  });

  it("says why somebody cannot take a duty; leave is only ever 'unavailable'; an unknown rule names itself", () => {
    expect(whyNot({ reason: { ruleKey: "night_one_in_three", severity: "block", params: {} }, near: { istDate: "2026-10-11", night: true } }, en)).toBe("Has Sunday night. This would be a second night in three.");
    expect(whyNot({ reason: { ruleKey: "unavailable", severity: "unavailable", params: {} }, near: { istDate: "2026-10-11", night: true } }, en)).toBe("Unavailable on those days.");
    expect(reasonText({ ruleKey: "some_new_rule" }, en)).toBe("It would break a roster rule (some_new_rule).");
  });

  it("a refusal is the web's sentence for its code; no signal says nothing was changed; a new code names itself", () => {
    expect(rosterRefusal(new ApiError(409, "cover_already_asked", { statusCode: 409, message: "x", code: "cover_already_asked" }), en)).toBe(en("roster.refusal.cover_already_asked"));
    expect(rosterRefusal(new ApiError(409, "brand_new", { code: "brand_new" }), en)).toBe("The roster refused this (brand_new). Nothing was changed.");
    expect(rosterRefusal(new ApiError(403, "Forbidden", { message: "Forbidden" }), en)).toBe(en("rosterOnNow.forbidden"));
    expect(rosterRefusal(new NetworkError("x"), en)).toBe("The server could not be reached. Nothing was changed.");
    expect(rosterRefusal(new ApiError(409, "cover_not_open", { code: "cover_not_open" }), hi)).toBe(hi("roster.refusal.cover_not_open"));
  });
});
