import { lmsValueAt, rowAt } from "./paeds-data/lms";
import { WHO_HCFA } from "./paeds-data/who-hcfa";
import { WHO_WFA } from "./paeds-data/who-wfa";
import { ageYmd, dateAtAge, growthIndicators, immunisationStatus, mergeImmunisation, whoZ } from "./paeds";
import type { GrowthInput, ImmunisationBody } from "./paeds";

/**
 * THE PAEDIATRICS PROFILE'S ARITHMETIC (01-CONSULT-ENGINE.md §6.2) — age in years, months and days;
 * WHO z-scores and centiles against WHO's own worked examples; the IAP 2023 timetable's due, overdue
 * and given; and "given today" as an append-only record.
 */

describe("age in years, months and days, on the hospital's calendar", () => {
  it("counts completed years, then months, then days — and the IST date, not the UTC one", () => {
    expect(ageYmd(new Date("2025-06-15T00:00:00Z"), new Date("2026-09-28T06:00:00Z"))).toEqual({ years: 1, months: 3, days: 13, totalDays: 470 });
    // 20:00 UTC on the 27th is 01:30 IST on the 28th: the child is a day older at the desk.
    expect(ageYmd(new Date("2025-06-15T00:00:00Z"), new Date("2026-09-27T20:00:00Z")).days).toBe(13);
  });
  it("a birthday on the 31st reaches a short month on its last day", () => {
    expect(ageYmd(new Date("2024-01-31T00:00:00Z"), new Date("2026-03-01T06:00:00Z"))).toEqual({ years: 2, months: 1, days: 1, totalDays: 760 });
    expect(ageYmd(new Date("2026-09-28T00:00:00Z"), new Date("2026-09-28T06:00:00Z"))).toEqual({ years: 0, months: 0, days: 0, totalDays: 0 });
  });
  it("a scheduled age lands on a calendar date", () => {
    expect(dateAtAge("2026-06-01", { w: 6 })).toBe("2026-07-13");
    expect(dateAtAge("2026-01-31", { m: 1 })).toBe("2026-02-28");
    expect(dateAtAge("2012-02-29", { y: 9 })).toBe("2021-02-28");
  });
});

describe("WHO Child Growth Standards — z-scores against WHO's own worked examples", () => {
  /*
    Source: the WHO `anthro` package's own test suite (the reference implementation of the WHO
    Child Growth Standards), https://github.com/WorldHealthOrganization/anthro/tree/master/tests/testthat
  */
  it("weight-for-age: a girl of 1522 days weighing 17 kg is z = 0.24 (anthro test-zscore-weight-for-age.R)", () => {
    expect(whoZ("wfa", "girl", 1522, 17)?.z).toBe(0.24);
  });
  it("length-for-age: a boy of 44 days, 50 cm long, is round(((50/56.4833)^1 − 1)/(0.03492 × 1), 2) (anthro test-zscore-length-for-age.R)", () => {
    expect(whoZ("lhfa", "boy", 44, 50, "length")?.z).toBe(Math.round(((50 / 56.4833 - 1) / 0.03492) * 100) / 100);
  });
  it("length-for-age: a girl of 24 months (731 days), 77.5 cm, is z = −2.55 (anthro test-zscores.R)", () => {
    expect(whoZ("lhfa", "girl", 731, 77.5, null)?.z).toBe(-2.55);
  });
  it("a child under 2 measured STANDING gains the WHO's 0.7 cm: a boy of 9 months at 60 cm reads 60.7 cm, z = −5.02 (anthro test-zscores.R)", () => {
    const r = whoZ("lhfa", "boy", 274, 60, "height");
    expect(r?.value).toBeCloseTo(60.7, 5);
    expect(r?.z).toBeCloseTo(-5.02, 2);
  });
  /*
    Source: WHO. Weight-for-age BOYS, birth to 5 years (z-scores), https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/wfa-boys-0-5-zscores.pdf
    and Head circumference-for-age BOYS, birth to 5 years (z-scores), https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/hcfa_boys_0_5_zscores.pdf
    Each published cell is the LMS curve at that SD, rounded to one decimal, at the month's exact age
    (month 12 = 365.25 days); the daily table's row is day 365, a quarter-day earlier. So each value is
    held to the published cell ± 0.05 (the rounding) + 0.01 (the quarter day).
  */
  it.each([
    ["wfa at birth", WHO_WFA, 0, ["2.1", "2.5", "2.9", "3.3", "3.9", "4.4", "5.0"]],
    ["wfa at 12 months", WHO_WFA, 365, ["6.9", "7.7", "8.6", "9.6", "10.8", "12.0", "13.3"]],
    ["hcfa at birth", WHO_HCFA, 0, ["30.7", "31.9", "33.2", "34.5", "35.7", "37.0", "38.3"]],
    ["hcfa at 12 months", WHO_HCFA, 365, ["42.2", "43.5", "44.8", "46.1", "47.4", "48.6", "49.9"]],
  ])("the boys' %s table reproduces WHO's published −3…+3 SD row", (_name, table, day, cells) => {
    const row = rowAt(table, "boy", day)!;
    [-3, -2, -1, 0, 1, 2, 3].forEach((z, i) => { expect(Math.abs(lmsValueAt(z, row) - Number(cells[i]))).toBeLessThanOrEqual(0.06); });
  });
  it("beyond +3 SD weight-for-age is WHO's restricted z: measured in units of the 2→3 SD distance", () => {
    const row = rowAt(WHO_WFA, "boy", 0)!;
    const sd3 = lmsValueAt(3, row);
    const sd23 = sd3 - lmsValueAt(2, row);
    expect(whoZ("wfa", "boy", 0, 5.6)?.z).toBe(Math.round((3 + (5.6 - sd3) / sd23) * 100) / 100);
  });
  it("a centile is the normal CDF of z: the median is the 50th, +2 SD the 97.7th", () => {
    const row = rowAt(WHO_HCFA, "boy", 365)!;
    expect(whoZ("hcfa", "boy", 365, row[1])?.percentile).toBe(50);
    expect(whoZ("hcfa", "boy", 365, lmsValueAt(2, row))?.percentile).toBe(97.7);
  });
  it("no z-score past the WHO table (5 years), or for a measurement that is not a number above zero", () => {
    expect(whoZ("wfa", "boy", 1827, 18)).toBeNull();
    expect(whoZ("wfa", "boy", 400, 0)).toBeNull();
  });
});

describe("growth: which reference, and why a number is missing", () => {
  const base: GrowthInput = {
    sex: "boy", ageDays: 365, dobEstimated: false,
    weight: { kg: 9.65, ageDays: 365, today: true }, lengthCm: 75.7, measure: "length", headCircCm: 46.1,
  };
  const byKey = (g: GrowthInput) => Object.fromEntries(growthIndicators(g).map((r) => [r.key, r]));
  it("under 5 years: all four indicators against WHO 2006, BMI from today's weight and length", () => {
    const r = byKey(base);
    expect(r.wfa).toMatchObject({ reference: "WHO 2006", reason: null });
    expect(r.wfa!.z).toBeCloseTo(0, 1);
    expect(r.bfa!.value).toBeCloseTo(9.65 / (0.757 * 0.757), 5);
    expect(r.hcfa!.reason).toBeNull();
  });
  it("5 to 18 years: IAP 2015 LMS values are not published, so no z-score is shown and the reason says so", () => {
    const r = byKey({ ...base, ageDays: 2600, weight: { kg: 22, ageDays: 2600, today: true }, lengthCm: 120, measure: "height", headCircCm: null });
    for (const k of ["wfa", "lhfa", "bfa"]) expect(r[k]).toMatchObject({ z: null, percentile: null, reason: "iap_2015_lms_unpublished" });
    expect(r.bfa!.value).toBeCloseTo(22 / 1.44, 5); // the BMI itself is still arithmetic, and shown
    expect(r.hcfa!.reason).toBe("not_measured");
  });
  it("an estimated date of birth, or a sex the standards do not chart, computes nothing", () => {
    expect(growthIndicators({ ...base, dobEstimated: true }).every((r) => r.z === null && r.reason === "dob_estimated")).toBe(true);
    expect(growthIndicators({ ...base, sex: null }).every((r) => r.z === null && r.reason === "sex_not_charted")).toBe(true);
  });
  it("a weight from an earlier visit is charted at the age it was taken — but no BMI is made from it and today's length", () => {
    const r = byKey({ ...base, weight: { kg: 9.0, ageDays: 300, today: false } });
    expect(r.wfa!.z).toBe(whoZ("wfa", "boy", 300, 9.0)!.z);
    expect(r.bfa).toMatchObject({ z: null, reason: "weight_not_today" });
  });
});

describe("immunisation — the IAP 2023 timetable, due and overdue from the date of birth", () => {
  const byId = (xs: ReturnType<typeof immunisationStatus>) => Object.fromEntries(xs.map((x) => [x.id, x]));
  it("a 17-week-old with nothing recorded: birth and 6-week doses overdue, 14-week doses due, influenza upcoming, Hep B-4 optional", () => {
    const s = byId(immunisationStatus("2026-06-01", "2026-09-28", []));
    expect(s.bcg).toMatchObject({ status: "overdue", dueOn: "2026-06-01", overdueFrom: "2026-06-29" });
    expect(s["dtp-1"]).toMatchObject({ status: "overdue", dueOn: "2026-07-13" });
    expect(s["dtp-3"]).toMatchObject({ status: "due", dueOn: "2026-09-07", overdueFrom: "2026-10-05" });
    expect(s["iiv-1"]).toMatchObject({ status: "upcoming", dueOn: "2026-12-01" });
    expect(s["hepb-4"]!.status).toBe("optional");
    expect(s.tcv).toMatchObject({ dueOn: "2026-12-01", overdueFrom: "2027-04-01" }); // the table's 6-9 mo range
  });
  it("a dose given — here on an earlier visit, today, or on the parent's card — is given, with its date", () => {
    const s = byId(immunisationStatus("2026-06-01", "2026-09-28", [
      { dose: "bcg", on: "2026-06-02", where: "earlier" },
      { dose: "dtp-1", on: "2026-07-14", where: "here" },
      { dose: "dtp-3", on: "2026-09-28", where: "today" },
    ]));
    expect(s.bcg).toMatchObject({ status: "given", givenOn: "2026-06-02", givenWhere: "earlier" });
    expect(s["dtp-1"]).toMatchObject({ status: "given", givenWhere: "here" });
    expect(s["dtp-3"]).toMatchObject({ status: "given_today" });
  });
  it("HPV: the 2nd dose waits for the 1st and falls 6 months after it; a course begun at 15 falls 2 months after, with a 3rd dose", () => {
    let s = byId(immunisationStatus("2012-01-01", "2026-09-28", []));
    expect(s["hpv-1"]).toMatchObject({ status: "due", dueOn: "2021-01-01", overdueFrom: "2027-01-01" }); // 9-14 y
    expect(s["hpv-2"]!.status).toBe("waiting");
    expect(s["hpv-3"]!.status).toBe("not_applicable");
    s = byId(immunisationStatus("2012-01-01", "2026-09-28", [{ dose: "hpv-1", on: "2026-04-01", where: "here" }]));
    expect(s["hpv-2"]).toMatchObject({ status: "upcoming", dueOn: "2026-10-01" });
    expect(s["hpv-3"]!.status).toBe("not_applicable");
    s = byId(immunisationStatus("2010-01-01", "2026-09-28", [{ dose: "hpv-1", on: "2025-07-01", where: "here" }]));
    expect(s["hpv-2"]).toMatchObject({ dueOn: "2025-09-01", status: "overdue" });
    expect(s["hpv-3"]).toMatchObject({ dueOn: "2026-01-01", status: "overdue" });
  });
});

describe("immunisation — 'given today' is append-only", () => {
  let n = 0;
  const id = (): string => `v${String(++n)}`;
  const given = (dose: string, batch = "B1") => ({ dose, batch, site: "left_thigh" as const, brand: "", errorReason: null });
  const body = (g: ImmunisationBody["givenToday"], earlier: ImmunisationBody["earlier"] = []): ImmunisationBody => ({ givenToday: g, earlier, note: "" });

  it("a new entry gets an id; a later save must carry it unchanged", () => {
    const first = mergeImmunisation(null, body([given("dtp-3")]), new Set(), id);
    expect(first.givenToday[0]!.id).toMatch(/^v/);
    expect(() => mergeImmunisation(first, body([]), new Set(), id)).toThrow(/cannot be removed/);
    expect(() => mergeImmunisation(first, body([{ ...first.givenToday[0]!, batch: "B2" }]), new Set(), id)).toThrow(/cannot be changed/);
  });
  it("a wrong entry is marked in error with a reason, never deleted — and the mark cannot be taken back", () => {
    const first = mergeImmunisation(null, body([given("dtp-3")]), new Set(), id);
    const marked = mergeImmunisation(first, body([{ ...first.givenToday[0]!, errorReason: "wrong child" }]), new Set(), id);
    expect(marked.givenToday[0]!.errorReason).toBe("wrong child");
    expect(() => mergeImmunisation(marked, body([{ ...marked.givenToday[0]!, errorReason: null }]), new Set(), id)).toThrow(/cannot be changed/);
  });
  it("a dose already given — on another visit, on the card, or twice in one save — is refused; an unknown dose is refused", () => {
    expect(() => mergeImmunisation(null, body([given("bcg")]), new Set(["bcg"]), id)).toThrow(/already given/);
    expect(() => mergeImmunisation(null, body([given("bcg")], [{ dose: "bcg", on: null, where: "" }]), new Set(), id)).toThrow(/already given/);
    expect(() => mergeImmunisation(null, body([given("bcg"), given("bcg")]), new Set(), id)).toThrow(/already given/);
    expect(() => mergeImmunisation(null, body([given("smallpox")]), new Set(), id)).toThrow(/unknown dose/);
  });
});
