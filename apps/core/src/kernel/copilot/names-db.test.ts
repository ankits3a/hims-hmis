import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDoctor, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { istDayString } from "../approvals/cumulative";
import { withTx } from "../db/client";
import { dayNameQueries, loadDayNames, maskForAsk, nameDays, nameIndexFor, NAME_LOAD_TIMEOUT_MS } from "./names";
import type { Db } from "../db/client";

/**
 * E0.6 — the name source at the database (spec items 1–2; done-means 2 for the confidential alias, 4).
 * Dates are derived from the real clock at run time, never pinned.
 */
const DAY = 24 * 60 * 60 * 1000;
const dayOffset = (days: number): string => istDayString(new Date(Date.now() + days * DAY));

let uhidSeq = 0;
async function patient(db: Db, name: string, over: { alias?: string; kin?: string; createdAt?: Date } = {}): Promise<string> {
  const id = newId();
  uhidSeq += 1;
  await db.execute(sql`insert into patients (id, uhid, name, sex, administrative_gender, created_by, updated_by,
      is_confidential, alias, father_husband_name, created_at)
    values (${id}, ${`T${String(uhidSeq).padStart(8, "0")}`}, ${name}, 'unknown', 'unknown', 't', 't',
      ${over.alias !== undefined}, ${over.alias ?? null}, ${over.kin ?? null}, ${(over.createdAt ?? new Date(Date.now() - 30 * DAY)).toISOString()})`);
  return id;
}

let visitSeq = 0;
async function visit(db: Db, patientId: string, serviceDate: string): Promise<void> {
  visitSeq += 1;
  await db.execute(sql`insert into opd_encounters (id, visit_no, patient_id, workflow_instance_id, service_date, visit_type, opened_by, updated_by)
    values (${newId()}, ${`T${String(visitSeq).padStart(10, "0")}`}, ${patientId}, 'wf', ${serviceDate}, 'new', 't', 't')`);
}

describe("E0.6 — the day's names at the database", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("reads today's and yesterday's visits, today's live appointments and today's registrations — nothing else", async () => {
    await seedOpdBase(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doctor = await mkDoctor(db, { username: "dr_names", departmentId: deptId, roomId });
    const today = dayOffset(0);

    await visit(db, await patient(db, "Ramesh Kumar"), today);
    await visit(db, await patient(db, "Night Spill"), dayOffset(-1));
    await visit(db, await patient(db, "Old Visit"), dayOffset(-10));
    await patient(db, "Walked In", { createdAt: new Date() });
    await patient(db, "Never Came");
    await visit(db, await patient(db, "Farida Khatoon", { alias: "Patient Rose", kin: "Salim Khan" }), today);

    for (const [name, status] of [["Booked Today", "booked"], ["Cancelled Today", "cancelled"]] as const) {
      const pid = await patient(db, name);
      await db.execute(sql`insert into opd_appointments (id, appointment_no, patient_id, doctor_id, department_id, service_date,
          slot_start, slot_end, status, booked_by, updated_by)
        values (${newId()}, ${`A${newId().slice(0, 10)}`}, ${pid}, ${doctor.doctorId}, ${deptId}, ${today},
          now(), now() + interval '10 minutes', ${status}, 't', 't')`);
    }

    const names = await loadDayNames(db, nameDays(new Date(), today));
    expect(names.sort()).toEqual(
      ["Booked Today", "Farida Khatoon", "Night Spill", "Patient Rose", "Ramesh Kumar", "Salim Khan", "Walked In"].sort(),
    );

    // Done-means 2, at the database: the confidential patient's real name AND alias both mask.
    const index = await nameIndexFor(loadDayNames, db, nameDays(new Date(), today));
    expect(maskForAsk("Farida ka bill", [], index).masked).toBe("<<P1>> ka bill");
    expect(maskForAsk("Rose ka bill", [], index).masked).toBe("<<P1>> ka bill");
  });

  it("done-means 4: 4,000 patients seen today — the name step is under the ceiling, and every read uses an index", async () => {
    const today = dayOffset(0);
    /*
      A realistic spread of doctors and clerks: with one value in the leading column, the existing
      (doctor_id, service_date) and (opened_by, service_date) indexes impersonate the new one.
    */
    await seedOpdBase(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doctors: string[] = [];
    for (let i = 0; i < 8; i += 1) doctors.push((await mkDoctor(db, { username: `dr_load_${String(i)}`, departmentId: deptId, roomId })).doctorId);
    const docs = sql.raw(`array[${doctors.map((d) => `'${d}'`).join(",")}]`);
    await db.execute(sql`insert into patients (id, uhid, name, sex, administrative_gender, created_by, updated_by, created_at)
      select 'p' || g, 'L' || lpad(g::text, 8, '0'), 'Name' || g || ' Surname' || (g % 300), 'unknown', 'unknown', 't', 't',
             now() - interval '30 days'
      from generate_series(1, 4000) g`);
    await db.execute(sql`insert into opd_encounters (id, visit_no, patient_id, workflow_instance_id, service_date, visit_type, opened_by, updated_by, doctor_id)
      select 'e' || g, 'L' || lpad(g::text, 10, '0'), 'p' || g, 'wf', ${today}::date, 'new', 'clerk' || (g % 60), 't', (${docs})[1 + g % 8]
      from generate_series(1, 4000) g`);
    // Ninety earlier days of the same desk, so today is the small slice it is in production.
    await db.execute(sql`insert into opd_encounters (id, visit_no, patient_id, workflow_instance_id, service_date, visit_type, opened_by, updated_by, doctor_id)
      select 'o' || g, 'M' || lpad(g::text, 10, '0'), 'p' || (1 + g % 4000), 'wf', ${today}::date - (2 + g % 90), 'revisit',
             'clerk' || (g % 60), 't', (${docs})[1 + g % 8]
      from generate_series(1, 90000) g`);
    await db.execute(sql`analyze patients`);
    await db.execute(sql`analyze opd_encounters`);

    const days = nameDays(new Date(), today);
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = Date.now();
      const index = await nameIndexFor(loadDayNames, db, days);
      maskForAsk("Name17 abhi tak andar gaye ya nahi", [], index);
      timings.push(Date.now() - t0);
      expect(index).not.toBeNull();
    }
    expect(Math.max(...timings)).toBeLessThan(NAME_LOAD_TIMEOUT_MS);

    /*
      With sequential scans priced out the planner still has other ways round a missing index (a full
      walk of the primary key, filtered), so "no Seq Scan" alone passed with the indexes dropped —
      measured. Each read must name the index the migration adds for its predicate.
    */
    const q = dayNameQueries(db, days);
    for (const [query, wanted] of [
      [q.visits, "opd_encounters_service_date_idx"],
      [q.appointments, "opd_appointments_service_date_idx"],
      [q.registered, "patients_created_at_idx"],
    ] as const) {
      const plan = await withTx(db, async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        const res = await tx.execute(sql`explain ${query}`);
        return (res as unknown as { rows: Record<string, string>[] }).rows.map((r) => Object.values(r)[0]).join("\n");
      });
      expect(plan).not.toMatch(/Seq Scan on (opd_encounters|opd_appointments|patients)\b/);
      expect(plan).toContain(wanted);
    }
  });
});
