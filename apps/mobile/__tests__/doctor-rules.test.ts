import { readFileSync } from "fs";
import { join } from "path";
import {
  LONG_WAIT_MINUTES, SKIP_REASONS, ageSexOf, besideName, briefResults, completionBody, followUpChoices, longestWait, parkedSince,
  rowName, unissuedRxRows, visitKind, waitMinutes,
  LAST_VISIT_LIST_CHARS, REPORT_LINES, guardianBrief, reportsCard, joinWithMore, lastCompletedVisit, lastVisitCard, showsLastVisit,
} from "../src/doctor/rules";
import { translate } from "../src/i18n";
import { guardianMayStandIn } from "../src/vitals/guardian";
import webEn from "../../web/src/locales/en.json";
import webHi from "../../web/src/locales/hi.json";

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

  // ——— owner 2026-10-09: guardian only, and the last visit ———
  const en = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
  const hi = (k: string, v?: Record<string, string | number>) => translate("hi", k, v);

  it("a guardian may stand in on every visit type (owner 2026-10-09) — the one rule the server, the web and the phone ask", () => {
    expect(["new", "revisit", "renewal", "referral", undefined, null].map((v) => guardianMayStandIn(v))).toEqual(Array(6).fill(true));
  });

  it("the guardian card, its one-line form and the row chip are worded by ONE function", () => {
    expect(guardianBrief(en, { relation: "son", name: "Rakesh" })).toEqual({
      title: "Guardian only", who: "Son: Rakesh", tail: " · reports · no vitals", compact: "Guardian only · Son: Rakesh", chip: "Guardian · Son",
    });
    // Owner 2026-10-09 — a NEW patient's guardian has no reports from here to show: the line says "new".
    expect(guardianBrief(en, { relation: "son", name: "Rakesh" }, "new").tail).toBe(" · new · no vitals");
    expect(["revisit", "renewal", undefined].map((v) => guardianBrief(en, { relation: "son", name: null }, v).tail)).toEqual(Array(3).fill(" · reports · no vitals"));
    const noName = guardianBrief(en, { relation: "son", name: null });
    expect(`${noName.who}${noName.tail}`).toBe("Son · reports · no vitals");
    expect(noName.compact).toBe("Guardian only · Son");
    expect(guardianBrief(hi, { relation: "son", name: null }).title).toBe("केवल अभिभावक");
    // A relation a newer server sends and this build has no word for is shown as sent, never as a key.
    expect(guardianBrief(en, { relation: "neighbour", name: null }).chip).toBe("Guardian · neighbour");
    // "Other relative" is two characters too long for the line: the doctor's screens say "Relative".
    const other = guardianBrief(en, { relation: "other_relative", name: null });
    expect([`${other.who}${other.tail}`, other.chip]).toEqual(["Relative · reports · no vitals", "Guardian · Relative"]);
  });

  it("the last-visit card's rows come from ONE function that the web brief and the phone's patient page both call", () => {
    const card = lastVisitCard(en, {
      encounter: { serviceDate: "2026-08-24", chiefComplaint: "  ", diagnosis: "Type 2 diabetes mellitus", advisedTests: [{ name: "HbA1c" }, { name: "Lipid profile" }, { name: "HbA1c" }] },
      deskComplaint: { text: "Pair mein jhunjhuni" },
      prescriptions: [{ status: "active", lines: [{ drug: "Metformin 1 g", dose: "1 tab" }] }, { status: "superseded", lines: [{ drug: "Old" }] }],
    }, "Dr. Chandan Kumar");
    expect(card).toEqual({
      title: "Last visit · 24 Aug", doctor: "Dr. Chandan Kumar",
      rows: [
        { key: "complaint", label: "Complaint", value: "Pair mein jhunjhuni" }, // the doctor recorded none: the desk's words
        { key: "diagnosis", label: "Diagnosis", value: "Type 2 diabetes mellitus" },
        { key: "tests", label: "Tests", value: "HbA1c, Lipid profile" },
        { key: "medicines", label: "Medicines", value: "Metformin 1 g" },
      ],
    });
    const bare = lastVisitCard(en, { encounter: { serviceDate: "2026-08-24" } }, null);
    expect(bare.rows.map((r) => r.value)).toEqual(["—", "—", "—", "—"]);
    // Both screens call it, and neither words a row of its own.
    for (const file of ["../src/doctor/brief.tsx", "../../web/src/components/last-visit.tsx"]) {
      expect(read(file)).toMatch(/lastVisitCard\(/);
      expect(read(file)).not.toMatch(/lastVisit\.(complaint|diagnosis|tests|medicines)/);
    }
    expect(read("../../web/src/screens/opd-consult-v2.tsx")).toMatch(/<LastVisitCard /);
  });

  it("a long list stops inside two lines and says how many more; which visit is 'last' is the newest completed one that is not today's", () => {
    const many = ["Atorvastatin 10 mg", "Metformin 500 mg", "Telmisartan 40 mg", "Aspirin 75 mg", "Pantoprazole 40 mg"];
    const out = joinWithMore(many);
    expect(out).toBe("Atorvastatin 10 mg, Metformin 500 mg +3");
    expect(out.length).toBeLessThanOrEqual(LAST_VISIT_LIST_CHARS);
    expect(joinWithMore(["A very long single test name that runs past the budget on its own"])).toBe("A very long single test name that runs past the budget on its own");
    const items = [
      { encounterId: "today", serviceDate: "2026-10-06", status: "completed" },
      { encounterId: "open", serviceDate: "2026-09-30", status: "awaiting_results" },
      { encounterId: "aug", serviceDate: "2026-08-24", status: "completed" },
      { encounterId: "jan", serviceDate: "2026-01-02", status: "completed" },
      { encounterId: "left", serviceDate: "2026-09-01", status: "abandoned" },
    ];
    expect(lastCompletedVisit(items, "today")?.encounterId).toBe("aug");
    expect(lastCompletedVisit([items[0]!], "today")).toBeNull();
    expect([showsLastVisit("revisit"), showsLastVisit("renewal"), showsLastVisit("new"), showsLastVisit(undefined)]).toEqual([true, true, false, false]);
  });

  it("the Reports card is built on briefResults' own rule: since the last visit, newest first, three lines and a count of the rest", () => {
    const l = (analyteName: string, value: string, unit: string | null, verifiedAt: string, flag: string | null = "N") => ({ orderableName: analyteName, analyteName, value, unit, flag, verifiedAt });
    const labs = [l("HbA1c", "8.9", "%", "2026-10-06T06:00:00.000Z", "H"), l("Creatinine", "1.3", "mg/dL", "2026-10-05T06:00:00.000Z"), l("Hb", "11.2", "g/dL", "2026-10-03T06:00:00.000Z"), l("Old sugar", "140", null, "2026-08-01T06:00:00.000Z")];
    const imaging = [{ studyName: "X-ray chest PA", impression: "No active lung lesion", criticalCategory: null, signedAt: "2026-10-04T07:00:00.000Z" }];
    const card = reportsCard(en, labs, imaging, "2026-09-12");
    expect(card).toEqual({
      title: "Reports", more: 1,
      lines: [
        { name: "HbA1c", rest: " · 8.9 % · 6 Oct", abnormal: true },
        { name: "Creatinine", rest: " · 1.3 mg/dL · 5 Oct", abnormal: false },
        { name: "X-ray chest PA", rest: " · ready · 4 Oct", abnormal: false },
      ],
    });
    expect(card!.lines).toHaveLength(REPORT_LINES);
    // The same rows, in the same order, as the patient page's "since then" block.
    expect(briefResults(labs, imaging, "2026-09-12").lines.map((x) => x.what.split(/[ :]/)[0])).toEqual(["HbA1c", "Creatinine", "X-ray", "Hb"]);
    // Nothing since the last visit (the page says "none since"): no card. Nothing at all: no card.
    expect(reportsCard(en, [labs[3]!], [], "2026-09-12")).toBeNull();
    expect(reportsCard(en, [], [], null)).toBeNull();
    expect(reportsCard(hi, labs, imaging, "2026-09-12")!.lines[2]!.rest).toBe(" · तैयार · 4 Oct");
    // Both screens call it.
    for (const file of ["../src/screens/consult.tsx", "../../web/src/components/guardian-reports.tsx"]) expect(read(file)).toMatch(/reportsCard\(/);
  });

  it("every new label fits one line of a 360 px phone: 34 characters at most, in English and in Hindi", () => {
    const BUDGET = 34;
    const keys = ["patientAbsent.cardTitle", "patientAbsent.compact", "patientAbsent.chip", "lastVisit.title", "lastVisit.complaint", "lastVisit.diagnosis", "lastVisit.tests", "lastVisit.medicines",
      "patientAbsent.short", "patientAbsent.title", "patientAbsent.hint", "reports.title", "reports.ready"];
    const relations = Object.keys((webEn as { patientAbsent: { relation: Record<string, string> } }).patientAbsent.relation);
    expect(relations).toContain("other_relative");
    for (const [name, t, web] of [["en", en, webEn], ["hi", hi, webHi]] as const) {
      const pa = (web as { patientAbsent: Record<string, unknown> }).patientAbsent;
      expect([name, pa.cardTitle]).toEqual([name, t("patientAbsent.cardTitle")]); // the web's wording, not a second one
      for (const k of keys) {
        // The longest thing a template can be filled with here: the longest relation, a short date.
        const longest = Math.max(...relations.map((r) => { const g = guardianBrief(t, { relation: r, name: null }); return Math.max(g.title.length, g.compact.length, g.chip.length, t(k, { date: "24 Aug" }).length); }));
        expect([name, k, longest <= BUDGET]).toEqual([name, k, true]);
      }
      // "Guardian with reports" is also a row of the action card and a swipe strip: 24 at most.
      expect([name, t("patientAbsent.short").length <= 24]).toEqual([name, true]);
      // The hint under the bench is the one longer line: small type, one line at 360 px (looked at), 44 at most.
      expect([name, t("mobile.scan.benchHint").length <= 44]).toEqual([name, true]);
      // The card's detail line is composed: test it with every relation and no name.
      for (const r of relations) {
        for (const visitType of ["revisit", "new"]) {
          const g = guardianBrief(t, { relation: r, name: null }, visitType);
          expect([name, r, visitType, `${g.who}${g.tail}`.length <= BUDGET]).toEqual([name, r, visitType, true]);
        }
      }
    }
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

  it("says REFERRAL for a visit an internal referral opened", () => {
    const enc = { id: "e", patientId: "p", visitType: "new", dangerFlagged: false, status: "waiting" };
    expect(visitKind({ encounter: enc })).toBe("new");
    expect(visitKind({ encounter: { ...enc, visitType: "renewal" } })).toBe("renewal");
    expect(visitKind({ encounter: { ...enc, visitType: "revisit", referredFromEncounterId: "e0" } })).toBe("referral");
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
