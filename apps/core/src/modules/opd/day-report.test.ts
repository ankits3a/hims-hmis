import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdAppointments, opdDepartments, opdEncounters, patients } from "../../kernel/db/schema";
import { ageLabel, loadOpdDayReport, loadOpdDepartmentDayReport, shortAddress } from "./day-report";
import { dayReportCsvRows, departmentDayReportCsvRows, renderDayReport, renderDepartmentDayReport, sheetText } from "./day-report-render";
import type { Db } from "../../kernel/db/client";

/**
 * THE OPD DAY REPORT — owner request 2026-09-19. The rule under test is the owner's ruling that the
 * report's "New" is NEW TO THE HOSPITAL, which `visit_type` (the per-department fee branch) is not.
 */
const DAY = "2026-09-18"; // a Friday
const NOW = new Date("2026-09-19T06:00:00.000Z"); // the next morning, IST — the day is closed

describe("OPD day report", () => {
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
    completedAt = `${serviceDate}T10:${String(10 + (seq % 40)).padStart(2, "0")}:00+05:30`,
  ): Promise<void> => {
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
  let p6: string; let p7: string; let p8: string; let p10: string;

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

    // P1 — first time at the hospital, in Medicine.
    p1 = await patient("Ramesh Kumar", { addressLine: "Vill. Rampur, PO Bidupur", district: "Vaishali", dob: new Date("1990-03-01T00:00:00Z"), ageYears: undefined, sex: "male" });
    await visit(p1, deptId, DAY, "new");
    // P2 — back on the free follow-up in Medicine.
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
    // P5 — registered AGAIN at the desk today, then merged into the original record.
    p5old = await patient("Gopal Yadav");
    await visit(p5old, deptId, "2026-08-29", "new");
    p5dup = await patient("Gopal Yadav (dup)");
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: p5old }).where(eq(patients.id, p5dup));
    await visit(p5dup, deptId, DAY, "new");
    // P6 — new to the hospital, seen in two departments on the same first day.
    p6 = await patient("Baby Anjali", { sex: "female" });
    // An infant's registration needs a guardian; the age is what is under test, so it is set directly.
    await db.update(patients).set({ dob: new Date("2026-01-10T00:00:00Z") }).where(eq(patients.id, p6));
    await visit(p6, deptId, DAY, "new");
    await visit(p6, dept2Id, DAY, "new");
    // P7 — still waiting to be seen.
    p7 = await patient("Suresh Prasad");
    await visit(p7, deptId, DAY, "new", "waiting");
    // P8 — left without being seen.
    p8 = await patient("Rekha Kumari");
    await visit(p8, deptId, DAY, "new", "abandoned");
    // P9 — a laboratory walk-in: not a consultation.
    await visit(await patient("Lab Only"), labId, DAY, "new");
    // P10 — came once before and left unseen: still new to the hospital today.
    p10 = await patient("Imran Ali");
    await visit(p10, deptId, "2026-09-13", "new", "abandoned");
    await visit(p10, deptId, DAY, "new");

    // Appointments: three stood for Medicine, two did not, one is tomorrow's; one stood for Paediatrics.
    await appointment(p1, deptId, DAY, "checked_in");
    await appointment(p2, deptId, DAY, "booked");
    await appointment(p7, deptId, DAY, "no_show");
    await appointment(p8, deptId, DAY, "cancelled");
    await appointment(p4, deptId, DAY, "rescheduled");
    await appointment(p4, deptId, "2026-09-19", "booked");
    await appointment(p3, dept2Id, DAY, "checked_in");
  });

  it("counts each department's day, and New means new to the HOSPITAL (owner ruling 2026-09-19)", async () => {
    const r = await loadOpdDayReport(db, DAY, NOW);
    expect(r.provisional).toBe(false);
    expect(r.hospital.name).toBe("CRK MEDICAL COLLEGE & HOSPITAL");
    expect(r.departments.map((d) => d.name)).toEqual(["General Medicine", "Paediatrics"]); // no Laboratory
    const med = r.departments.find((d) => d.departmentId === deptId)!;
    const ped = r.departments.find((d) => d.departmentId === dept2Id)!;
    expect(med).toMatchObject({ booked: 3, consulted: 6, new: 3, revisit: 1, renewal: 2, stillOpen: 1 });
    // P3 is `new` to Paediatrics' fee branch and is a RENEWAL here — the whole of the ruling.
    expect(ped).toMatchObject({ booked: 1, consulted: 2, new: 1, revisit: 0, renewal: 1, stillOpen: 0 });
    expect(r.totals).toEqual({ booked: 4, consulted: 8, new: 4, revisit: 1, renewal: 3, stillOpen: 1 });
    expect(r.patientsConsulted).toBe(7); // P6 counted once; P5's two records are one person
    expect(r.newPatients).toBe(3); // P1, P6, P10
  });

  it("follows a merge in both directions: history under the survivor, today under the duplicate — and the reverse", async () => {
    // The reverse: the ORIGINAL record merged into the one registered today.
    await db.update(patients).set({ status: "active", mergedIntoPatientId: null }).where(eq(patients.id, p5dup));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: p5dup }).where(eq(patients.id, p5old));
    const med = (await loadOpdDayReport(db, DAY, NOW)).departments.find((d) => d.departmentId === deptId)!;
    expect(med).toMatchObject({ new: 3, renewal: 2 });
  });

  it("marks today's report provisional", async () => {
    expect((await loadOpdDayReport(db, "2026-09-19", NOW)).provisional).toBe(true);
  });

  it("lists a department's patients in consultation order, aliasing a sealed patient against the READER", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient VIP-7" }).where(eq(patients.id, p2));
    const r = (await loadOpdDepartmentDayReport(db, clerk.actor, DAY, deptId, NOW))!;
    expect(r.department).toMatchObject({ name: "General Medicine", consulted: 6, new: 3 });
    expect(r.rows).toHaveLength(6);
    expect(r.rows.map((x) => x.patientType)).toEqual(["new", "revisit", "renewal", "renewal", "new", "new"]);
    const ramesh = r.rows[0]!;
    expect(ramesh).toMatchObject({
      name: "Ramesh Kumar", age: "36 Y", gender: "M", shortAddress: "Vill. Rampur, Vaishali", patientType: "new", doctor: "Dr Anil",
    });
    const sealed = r.rows[1]!;
    expect(sealed).toMatchObject({ name: "Patient VIP-7", restricted: true, shortAddress: "—" });
    expect(r.rows.map((x) => x.name)).not.toContain("Sita Devi");
    // The duplicate's visit is shown under the surviving record.
    expect(r.rows[3]!.name).toBe("Gopal Yadav");
    expect(r.rows.find((x) => x.name === "Baby Anjali")!.age).toBe("8 M");
  });

  it("returns null for a department that does not exist, and for the laboratory", async () => {
    expect(await loadOpdDepartmentDayReport(db, clerk.actor, DAY, newId(), NOW)).toBeNull();
    expect(await loadOpdDepartmentDayReport(db, clerk.actor, DAY, labId, NOW)).toBeNull();
  });

  it("the CSV and the printable sheet carry the same numbers as the screen, on the letterhead", async () => {
    const r = await loadOpdDayReport(db, DAY, NOW);
    const csv = dayReportCsvRows(r);
    expect(csv[0]).toEqual(["CRK MEDICAL COLLEGE & HOSPITAL"]);
    expect(csv).toContainEqual(["General Medicine", "3", "6", "3", "1", "2", "1"]);
    expect(csv).toContainEqual(["Total", "4", "8", "4", "1", "3", "1"]);
    const doc = renderDayReport(r);
    expect(doc.title).toBe(`OPD-Day-Report-${DAY}`);
    expect(doc.html).toContain("CRK MEDICAL COLLEGE &amp; HOSPITAL");
    expect(doc.html).toContain("data:image/png;base64,");
    expect(doc.html).toContain("18-Sep-2026");
    expect(doc.html).toContain("1 patient is still being seen");

    const dept = (await loadOpdDepartmentDayReport(db, clerk.actor, DAY, deptId, NOW))!;
    const rows = departmentDayReportCsvRows(dept);
    expect(rows).toContainEqual(["1", "10:10", expect.stringMatching(/^V/), "Ramesh Kumar", expect.any(String), "36 Y", "M", "Vill. Rampur, Vaishali", "New", "Dr Anil"]);
    const sheet = renderDepartmentDayReport(dept);
    expect(sheet.title).toBe(`OPD-Day-Report-MED-${DAY}`);
    expect(sheet.html).toContain("Ramesh Kumar");
    expect(sheet.html).toContain("Renewal");
  });
});

describe("OPD day report — the small rules", () => {
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
