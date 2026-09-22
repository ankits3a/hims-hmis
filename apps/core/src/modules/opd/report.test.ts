import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdAppointments, opdDepartments, opdEncounters, patients } from "../../kernel/db/schema";
import { ageLabel, loadOpdDepartmentReport, loadOpdReport, rangeFor, shortAddress } from "./report";
import {
  departmentReportCsvRows, fileStem, rangeLabel, renderDepartmentReport, renderReport, reportCsvRows, sheetText,
} from "./report-render";
import type { Db } from "../../kernel/db/client";

/**
 * THE OPD REPORT — owner requests 2026-09-19 (the day report) and 2026-09-20 (this week, Monday to
 * Saturday, and this month). Two rules are under test above all: "New" is NEW TO THE HOSPITAL, which
 * `visit_type` is not, and a week ENDS ON SATURDAY — so a Sunday's consultations are named rather
 * than silently dropped.
 */
const MON = "2026-09-14";
const WED = "2026-09-16";
const THU = "2026-09-17";
const DAY = "2026-09-18"; // Friday
const SAT = "2026-09-19";
const SUN = "2026-09-20";
const NOW = new Date("2026-09-19T06:00:00.000Z"); // Saturday morning IST — the week is still open
const LATER = new Date("2026-09-22T06:00:00.000Z"); // the Tuesday after — every period above is closed

describe("OPD report", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string; // General Medicine
  let dept2Id: string; // Paediatrics
  let labId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let phone = 9000000000;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  const patient = async (name: string, over: Record<string, unknown> = {}): Promise<string> => {
    phone += 1;
    return (await mkPatient(db, clerk.actor, { name, phone: String(phone), ...over })).id;
  };

  let seq = 0;
  const visit = async (
    patientId: string, departmentId: string, serviceDate: string, visitType: string, status = "completed",
  ): Promise<void> => {
    const completedAt = `${serviceDate}T10:${String(10 + (seq % 40)).padStart(2, "0")}:00+05:30`;
    seq += 1;
    await db.insert(opdEncounters).values({
      id: newId(), visitNo: `V${String(seq).padStart(10, "0")}`, patientId, departmentId,
      doctorId: departmentId === dept2Id ? drp.doctorId : dra.doctorId,
      workflowInstanceId: newId(), serviceDate, visitType, status,
      consultCompletedAt: status === "completed" ? new Date(completedAt) : null,
      openedBy: clerk.id, updatedBy: clerk.id,
    });
  };

  const appointment = async (patientId: string, departmentId: string, serviceDate: string, status: string): Promise<void> => {
    seq += 1;
    const slotStart = new Date(`${serviceDate}T09:${String(seq % 60).padStart(2, "0")}:00+05:30`);
    await db.insert(opdAppointments).values({
      id: newId(), appointmentNo: `A${String(seq).padStart(8, "0")}`, patientId,
      doctorId: departmentId === dept2Id ? drp.doctorId : dra.doctorId, departmentId, serviceDate,
      slotStart, slotEnd: new Date(slotStart.getTime() + 600_000), status, bookedBy: clerk.id, updatedBy: clerk.id,
    });
  };

  let p1: string; let p2: string; let p3: string; let p4: string; let p5old: string; let p5dup: string;
  let p6: string; let p7: string; let p8: string; let p10: string; let p11: string;

  beforeEach(async () => {
    seq = 0;
    await truncateAll(db);
    await seedOpdBase(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId; dept2Id = masters.dept2Id;
    labId = newId();
    await db.insert(opdDepartments).values({ id: labId, code: "LAB", name: "Laboratory", createdBy: "t", updatedBy: "t" });
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId, displayName: "Dr Anil" });
    drp = await mkDoctor(db, { username: "drp", departmentId: dept2Id, roomId: masters.room2Id, displayName: "Dr Priya" });
    clerk = await mkUser(db, "clerk", ["front_office"]);

    // ── Friday, the day every "day" assertion below is about ──
    // P1 — first time at the hospital, in Medicine.
    p1 = await patient("Ramesh Kumar", { addressLine: "Vill. Rampur, PO Bidupur", district: "Vaishali", dob: new Date("1990-03-01T00:00:00Z"), ageYears: undefined, sex: "male" });
    await visit(p1, deptId, DAY, "new");
    // P2 — back on the free follow-up in Medicine; her first visit was earlier THIS MONTH.
    p2 = await patient("Sita Devi", { sex: "female" });
    await visit(p2, deptId, "2026-09-08", "new");
    await visit(p2, deptId, DAY, "revisit");
    // P3 — a Medicine patient's FIRST Paediatrics visit: `new` to the fee branch, NOT new to the hospital.
    p3 = await patient("Mohan Lal");
    await visit(p3, deptId, "2026-08-09", "new");
    await visit(p3, dept2Id, DAY, "new");
    // P4 — the follow-up lapsed, a fresh fee in Medicine.
    p4 = await patient("Kavita Sharma");
    await visit(p4, deptId, "2026-07-20", "new");
    await visit(p4, deptId, DAY, "renewal");
    // P5 — registered AGAIN at the desk, then merged into the original record.
    p5old = await patient("Gopal Yadav");
    await visit(p5old, deptId, "2026-08-29", "new");
    p5dup = await patient("Gopal Yadav (dup)");
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: p5old }).where(eq(patients.id, p5dup));
    await visit(p5dup, deptId, DAY, "new");
    // P6 — new to the hospital, seen in two departments on the same first day.
    p6 = await patient("Baby Anjali", { sex: "female" });
    await db.update(patients).set({ dob: new Date("2026-01-10T00:00:00Z") }).where(eq(patients.id, p6));
    await visit(p6, deptId, DAY, "new");
    await visit(p6, dept2Id, DAY, "new");
    // P7 — still waiting to be seen. P8 — left without being seen.
    p7 = await patient("Suresh Prasad");
    await visit(p7, deptId, DAY, "new", "waiting");
    p8 = await patient("Rekha Kumari");
    await visit(p8, deptId, DAY, "new", "abandoned");
    // A laboratory walk-in: not a consultation.
    await visit(await patient("Lab Only"), labId, DAY, "new");
    // P10 — came once before and left unseen: still new to the hospital today.
    p10 = await patient("Imran Ali");
    await visit(p10, deptId, "2026-09-13", "new", "abandoned");
    await visit(p10, deptId, DAY, "new");

    // ── The rest of the week: new on Wednesday, back on Thursday ──
    p11 = await patient("Nazia Parveen", { sex: "female" });
    await visit(p11, deptId, WED, "new");
    await visit(p11, deptId, THU, "revisit");

    // ── The SUNDAY the week does not cover ──
    await visit(await patient("Sunday Patient"), deptId, SUN, "new");

    // Appointments: three stood for Medicine on Friday, two did not, one is Saturday's; one for Paediatrics.
    await appointment(p1, deptId, DAY, "checked_in");
    await appointment(p2, deptId, DAY, "booked");
    await appointment(p7, deptId, DAY, "no_show");
    await appointment(p8, deptId, DAY, "cancelled");
    await appointment(p4, deptId, DAY, "rescheduled");
    await appointment(p4, deptId, SAT, "booked");
    await appointment(p3, dept2Id, DAY, "checked_in");
  });

  const day = (d: string, now = NOW) => loadOpdReport(db, rangeFor("day", d), now);
  const week = (anchor: string, now = NOW) => loadOpdReport(db, rangeFor("week", anchor), now);
  const month = (anchor: string, now = NOW) => loadOpdReport(db, rangeFor("month", anchor), now);

  it("counts one day, and New means new to the HOSPITAL (owner ruling 2026-09-19)", async () => {
    const r = await day(DAY);
    expect(r).toMatchObject({ period: "day", from: DAY, to: DAY, provisional: false });
    expect(r.departments.map((d) => d.name)).toEqual(["General Medicine", "Paediatrics"]); // no Laboratory
    const med = r.departments.find((d) => d.departmentId === deptId)!;
    const ped = r.departments.find((d) => d.departmentId === dept2Id)!;
    expect(med).toMatchObject({ booked: 3, consulted: 6, new: 3, revisit: 1, renewal: 2, stillOpen: 1 });
    // P3 is `new` to Paediatrics' fee branch and is a RENEWAL here — the whole of the ruling.
    expect(ped).toMatchObject({ booked: 1, consulted: 2, new: 1, revisit: 0, renewal: 1, stillOpen: 0 });
    expect(r.totals).toEqual({ booked: 4, consulted: 8, new: 4, revisit: 1, renewal: 3, stillOpen: 1 });
    expect(r.patientsConsulted).toBe(7); // P6 counted once; P5's two records are one person
    expect(r.newPatients).toBe(3); // P1, P6, P10
    expect(r.excludedSunday).toBeNull(); // only a week can exclude one
  });

  it("counts a week as MONDAY TO SATURDAY, and names the Sunday it leaves out (owner ruling 2026-09-20)", async () => {
    const r = await week(SAT, LATER);
    expect(r).toMatchObject({ period: "week", from: MON, to: SAT, anchor: SAT, provisional: false });
    // Wednesday's first visit + Thursday's follow-up + Friday's day.
    expect(r.totals).toEqual({ booked: 5, consulted: 10, new: 5, revisit: 2, renewal: 3, stillOpen: 1 });
    expect(r.patientsConsulted).toBe(8); // the day's seven + Nazia
    expect(r.newPatients).toBe(4);       // P1, P6, P10 + Nazia, counted once each
    // Sunday is not in the week, and the week says so rather than being quietly short.
    expect(r.excludedSunday).toEqual({ date: SUN, consulted: 1 });
  });

  it("a week that contains today ends today, and says the period is not over", async () => {
    const r = await week("2026-09-17", new Date("2026-09-17T06:00:00.000Z"));
    expect(r).toMatchObject({ from: MON, to: "2026-09-17", provisional: true });
    expect(r.totals.consulted).toBe(2); // Wednesday and Thursday only — Friday has not happened
  });

  it("a Sunday belongs to the week that began the Monday before it", async () => {
    const r = await week(SUN, LATER);
    expect(r).toMatchObject({ from: MON, to: SAT });
    expect(r.excludedSunday).toEqual({ date: SUN, consulted: 1 });
  });

  it("counts a month from the 1st to the anchor", async () => {
    const r = await month(SAT, LATER);
    expect(r).toMatchObject({ period: "month", from: "2026-09-01", to: SAT });
    // The week's ten plus Sita's own first visit on the 8th; August's visits are another month.
    expect(r.totals).toEqual({ booked: 5, consulted: 11, new: 6, revisit: 2, renewal: 3, stillOpen: 1 });
    expect(r.patientsConsulted).toBe(8);
    expect(r.newPatients).toBe(5); // + Sita, new to the hospital on the 8th
    expect(r.excludedSunday).toBeNull();
  });

  it("follows a merge in both directions: history under the survivor, today under the duplicate — and the reverse", async () => {
    await db.update(patients).set({ status: "active", mergedIntoPatientId: null }).where(eq(patients.id, p5dup));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: p5dup }).where(eq(patients.id, p5old));
    const med = (await day(DAY)).departments.find((d) => d.departmentId === deptId)!;
    expect(med).toMatchObject({ new: 3, renewal: 2 });
  });

  it("lists a department's patients in visit order, with the date, aliasing a sealed patient against the READER", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient VIP-7" }).where(eq(patients.id, p2));
    const r = (await loadOpdDepartmentReport(db, clerk.actor, rangeFor("week", SAT), deptId, LATER))!;
    expect(r.department).toMatchObject({ name: "General Medicine", consulted: 8, new: 4 });
    expect(r.rows.map((x) => x.date)).toEqual([WED, THU, DAY, DAY, DAY, DAY, DAY, DAY]);
    expect(r.rows[0]).toMatchObject({ name: "Nazia Parveen", patientType: "new" });
    expect(r.rows[1]).toMatchObject({ name: "Nazia Parveen", patientType: "revisit" });
    const ramesh = r.rows[2]!;
    expect(ramesh).toMatchObject({
      name: "Ramesh Kumar", age: "36 Y", gender: "M", shortAddress: "Vill. Rampur, Vaishali", patientType: "new", doctor: "Dr Anil",
    });
    expect(r.rows[3]).toMatchObject({ name: "Patient VIP-7", restricted: true, shortAddress: "—" });
    expect(r.rows.map((x) => x.name)).not.toContain("Sita Devi");
    expect(r.rows.find((x) => x.name === "Baby Anjali")!.age).toBe("8 M");
    expect(r.excludedSunday).toEqual({ date: SUN, consulted: 1 });
  });

  it("returns null for a department that does not exist, and for the laboratory", async () => {
    expect(await loadOpdDepartmentReport(db, clerk.actor, rangeFor("day", DAY), newId(), NOW)).toBeNull();
    expect(await loadOpdDepartmentReport(db, clerk.actor, rangeFor("day", DAY), labId, NOW)).toBeNull();
  });

  it("the CSV and the printable sheet carry the same numbers as the screen, on the letterhead", async () => {
    const r = await day(DAY);
    const csv = reportCsvRows(r);
    expect(csv[0]).toEqual(["CRK MEDICAL COLLEGE & HOSPITAL"]);
    expect(csv).toContainEqual(["General Medicine", "3", "6", "3", "1", "2", "1"]);
    expect(csv).toContainEqual(["Total", "4", "8", "4", "1", "3", "1"]);
    const doc = renderReport(r);
    expect(doc.title).toBe(`OPD-Day-Report-${DAY}`);
    expect(doc.html).toContain("CRK MEDICAL COLLEGE &amp; HOSPITAL");
    expect(doc.html).toContain("data:image/png;base64,");
    expect(doc.html).toContain("18-Sep-2026, Friday");
    expect(doc.html).toContain("1 patient is still being seen");

    const dept = (await loadOpdDepartmentReport(db, clerk.actor, rangeFor("day", DAY), deptId, NOW))!;
    const rows = departmentReportCsvRows(dept);
    expect(rows).toContainEqual(["1", DAY, "10:10", expect.stringMatching(/^V/), "Ramesh Kumar", expect.any(String), "36 Y", "M", "Vill. Rampur, Vaishali", "New", "Dr Anil"]);
    const sheet = renderDepartmentReport(dept);
    expect(sheet.title).toBe(`OPD-Day-Report-MED-${DAY}`);
    expect(sheet.html).toContain("Ramesh Kumar");
    expect(sheet.html).not.toContain("<th>Date</th>"); // one day needs no date column
  });

  it("a weekly sheet says which days it counted, prints the Sunday it left out, and dates every row", async () => {
    const r = await week(SAT, LATER);
    const doc = renderReport(r);
    expect(doc.title).toBe(`OPD-Week-Report-${MON}-to-${SAT}`);
    expect(doc.html).toContain("OPD Weekly Report");
    expect(doc.html).toContain("14-Sep-2026 to 19-Sep-2026 · 6 days");
    expect(doc.html).toContain("1 consultation on Sunday 20-Sep-2026 is not included");
    expect(doc.html).toContain("<b>Week</b> — Monday to Saturday");
    const csv = reportCsvRows(r);
    expect(csv).toContainEqual(["Period", `${MON} to ${SAT}`]);
    expect(csv.some((row) => row[0] === "Note" && row[1]?.includes("Sunday 20-Sep-2026"))).toBe(true);

    const dept = (await loadOpdDepartmentReport(db, clerk.actor, rangeFor("week", SAT), deptId, LATER))!;
    const sheet = renderDepartmentReport(dept);
    expect(sheet.title).toBe(`OPD-Week-Report-MED-${MON}-to-${SAT}`);
    expect(sheet.html).toContain("<th>Date</th>");
    expect(sheet.html).toContain("16-Sep");
    expect(departmentReportCsvRows(dept)[0]).toEqual(["CRK MEDICAL COLLEGE & HOSPITAL"]);
  });

  it("a monthly sheet is titled and named for its month", async () => {
    const doc = renderReport(await month(SAT, LATER));
    expect(doc.title).toBe(`OPD-Month-Report-2026-09-01-to-${SAT}`);
    expect(doc.html).toContain("OPD Monthly Report");
    expect(doc.html).toContain("01-Sep-2026 to 19-Sep-2026 · 19 days");
    expect(doc.html).not.toContain("<b>Week</b>"); // the week rule belongs on a weekly sheet only
  });
});

describe("OPD report — the periods themselves", () => {
  it("a week runs Monday to Saturday, whichever day the reader anchors on", () => {
    for (const anchor of ["2026-09-14", "2026-09-16", "2026-09-19", "2026-09-20"]) {
      expect(rangeFor("week", anchor)).toMatchObject({ from: "2026-09-14" });
    }
    expect(rangeFor("week", "2026-09-19").to).toBe("2026-09-19"); // Saturday: the whole week
    expect(rangeFor("week", "2026-09-20").to).toBe("2026-09-19"); // Sunday: still the week that ended
    expect(rangeFor("week", "2026-09-16").to).toBe("2026-09-16"); // Wednesday: up to today, not Saturday
    expect(rangeFor("week", "2026-09-21")).toMatchObject({ from: "2026-09-21", to: "2026-09-21" }); // the next Monday
  });

  it("a month runs from the 1st to the anchor, and a day is itself", () => {
    expect(rangeFor("month", "2026-09-20")).toMatchObject({ from: "2026-09-01", to: "2026-09-20" });
    expect(rangeFor("month", "2026-01-01")).toMatchObject({ from: "2026-01-01", to: "2026-01-01" });
    expect(rangeFor("day", "2026-09-20")).toMatchObject({ from: "2026-09-20", to: "2026-09-20" });
  });

  it("says which days a sheet covers", () => {
    expect(rangeLabel(rangeFor("day", "2026-09-18"))).toBe("18-Sep-2026, Friday");
    expect(rangeLabel(rangeFor("week", "2026-09-19"))).toBe("14-Sep-2026 to 19-Sep-2026 · 6 days");
    expect(rangeLabel(rangeFor("month", "2026-09-19"))).toBe("01-Sep-2026 to 19-Sep-2026 · 19 days");
  });

  it("names a file after its period", () => {
    expect(fileStem(rangeFor("week", "2026-09-19"))).toBe("OPD-Week-Report-2026-09-14-to-2026-09-19");
    expect(fileStem(rangeFor("month", "2026-09-19"), { code: "PED" })).toBe("OPD-Month-Report-PED-2026-09-01-to-2026-09-19");
  });
});

describe("OPD report — the small rules", () => {
  it("writes an age the way the register does", () => {
    expect(ageLabel(null, "2026-09-18")).toBe("—");
    expect(ageLabel(new Date("1990-09-18T00:00:00Z"), "2026-09-18")).toBe("36 Y");
    expect(ageLabel(new Date("1990-09-19T00:00:00Z"), "2026-09-18")).toBe("35 Y");
    expect(ageLabel(new Date("2026-01-10T00:00:00Z"), "2026-09-18")).toBe("8 M");
    expect(ageLabel(new Date("2026-09-06T00:00:00Z"), "2026-09-18")).toBe("12 D");
  });

  it("shortens an address to locality and district", () => {
    expect(shortAddress("Vill. Rampur, PO Bidupur, PS Hajipur", "Vaishali", "844101")).toBe("Vill. Rampur, Vaishali");
    expect(shortAddress("Hajipur", "hajipur", null)).toBe("Hajipur");
    expect(shortAddress(null, "Vaishali", null)).toBe("Vaishali");
    expect(shortAddress(null, null, "844101")).toBe("844101");
    expect(shortAddress("  ", null, null)).toBe("—");
    expect(shortAddress("A very long locality name that runs on and on, PO X", null, null)).toBe("A very long locality name that…");
  });

  it("never lets a typed name run as a spreadsheet formula", () => {
    expect(sheetText("=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(sheetText("+91 98765")).toBe("'+91 98765");
    expect(sheetText("Ramesh")).toBe("Ramesh");
  });
});
