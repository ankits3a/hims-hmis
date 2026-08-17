import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { activateOpdVisitDefinition, seedOpdBase } from "./helpers/opd";
import { openVisit } from "../src/modules/opd/encounters";
import { boardSnapshot, listQueue } from "../src/modules/opd/queue";
import { istDate } from "../src/modules/opd/time";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

const clerk: Actor = { type: "user", id: "perf-opd-user" };

const PATIENTS = 20_000;
const DEPARTMENTS = 12;
const DOCTORS = 300; // one doctor-day session each
const ENTRIES_PER_SESSION = 60; // 300 × 60 = 18,000 live queue entries and 18,000 live encounters
const HISTORY = 200_000; // completed encounters over the last 400 days — the visit-type anchor's haystack

const QUEUE_BUDGET_MS = 100; // §15 interactive: the consultation screen's hot read
const VISIT_TYPE_BUDGET_MS = 100; // §15 interactive: openVisit, anchor lookup included
const BOARD_BUDGET_MS = 300; // the display board refreshes on events — this is a ceiling, not a target

const patientId = (n: number): string => `OPDP${String(n).padStart(22, "0")}`;
const doctorId = (n: number): string => `PERFDOC${String(n).padStart(5, "0")}`;
const departmentId = (n: number): string => `PERFDEPT${String(n).padStart(4, "0")}`;
/** The department the seed gives doctor n (round-robin over the twelve). */
const departmentOfDoctor = (n: number): string => departmentId(((n - 1) % DEPARTMENTS) + 1);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Recursively collect every "Node Type" in an EXPLAIN (FORMAT JSON) plan tree. */
function nodeTypes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) nodeTypes(n, out);
  } else if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec["Node Type"] === "string") out.push(rec["Node Type"] as string);
    for (const v of Object.values(rec)) nodeTypes(v, out);
  }
  return out;
}

describe("OPD queue and visit-type performance budgets (CI-gated — §15)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let today: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    await seedOpdBase(db); // opd_config: every OPD read hard-fails without it
    await activateOpdVisitDefinition(db); // openVisit starts a workflow instance — the definition must be ACTIVE
    today = istDate(new Date());

    // Synthetic but index-realistic: ONE statement per table, no per-row round trips. The ids are
    // deterministic strings so the measurements below can address any seeded row without a lookup.
    await db.execute(sql`
      insert into patients (id, uhid, name, phone, sex, language, status, created_by, updated_by)
      select
        'OPDP' || lpad(gs::text, 22, '0'),
        'OPD-' || lpad(gs::text, 8, '0') || '-0',
        'Queue Patient ' || gs::text,
        '9' || lpad((200000000 + gs)::text, 9, '0'),
        'other', 'hi', 'active', 'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(PATIENTS))}) gs
    `);
    await db.execute(sql`
      insert into opd_departments (id, code, name, created_by, updated_by)
      select 'PERFDEPT' || lpad(gs::text, 4, '0'), 'D' || lpad(gs::text, 3, '0'), 'Perf Department ' || gs::text, 'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(DEPARTMENTS))}) gs
    `);
    await db.execute(sql`
      insert into opd_rooms (id, code, name, created_by, updated_by)
      select 'PERFROOM' || lpad(gs::text, 4, '0'), 'R' || lpad(gs::text, 3, '0'), 'Perf Room ' || gs::text, 'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(DEPARTMENTS))}) gs
    `);
    await db.execute(sql`
      insert into opd_doctors (id, user_id, display_name, registration_no, department_id, created_by, updated_by)
      select
        'PERFDOC' || lpad(gs::text, 5, '0'),
        'PERFUSER' || lpad(gs::text, 5, '0'),
        'Dr Perf ' || lpad(gs::text, 5, '0'),
        'BMC/' || gs::text,
        'PERFDEPT' || lpad((((gs - 1) % ${sql.raw(String(DEPARTMENTS))}) + 1)::text, 4, '0'),
        'perf-seed', 'perf-seed'
      from generate_series(1, ${sql.raw(String(DOCTORS))}) gs
    `);
    await db.execute(sql`
      insert into opd_queue_sessions (id, doctor_id, service_date, room_id, status, next_token, calls_made, opened_at)
      select
        'PERFSESS' || lpad(gs::text, 5, '0'),
        'PERFDOC' || lpad(gs::text, 5, '0'),
        ${today}::date,
        'PERFROOM' || lpad((((gs - 1) % ${sql.raw(String(DEPARTMENTS))}) + 1)::text, 4, '0'),
        'in', ${sql.raw(String(ENTRIES_PER_SESSION + 1))}, 0, now()
      from generate_series(1, ${sql.raw(String(DOCTORS))}) gs
    `);
    // Today's live encounters: 60 per doctor-day, all waiting for their doctor.
    await db.execute(sql`
      insert into opd_encounters (
        id, patient_id, status, workflow_instance_id, department_id, doctor_id, service_date, visit_type,
        opened_by, opened_at, updated_by
      )
      select
        'PERFENC' || lpad(d::text, 5, '0') || lpad(k::text, 3, '0'),
        'OPDP' || lpad(((((d - 1) * ${sql.raw(String(ENTRIES_PER_SESSION))} + k - 1) % ${sql.raw(String(PATIENTS))}) + 1)::text, 22, '0'),
        'waiting',
        'PERFWFI' || lpad(d::text, 5, '0') || lpad(k::text, 3, '0'),
        'PERFDEPT' || lpad((((d - 1) % ${sql.raw(String(DEPARTMENTS))}) + 1)::text, 4, '0'),
        'PERFDOC' || lpad(d::text, 5, '0'),
        ${today}::date, 'new', 'perf-seed', now(), 'perf-seed'
      from generate_series(1, ${sql.raw(String(DOCTORS))}) d, generate_series(1, ${sql.raw(String(ENTRIES_PER_SESSION))}) k
    `);
    // …and their queue rows: every entry waiting, eligible k minutes ago, one in three an appointment.
    await db.execute(sql`
      insert into opd_queue_entries (id, session_id, encounter_id, token_no, kind, appointment_at, status, eligible_at)
      select
        'PERFQE' || lpad(d::text, 5, '0') || lpad(k::text, 3, '0'),
        'PERFSESS' || lpad(d::text, 5, '0'),
        'PERFENC' || lpad(d::text, 5, '0') || lpad(k::text, 3, '0'),
        k,
        case when k % 3 = 0 then 'appointment' else 'walk_in' end,
        case when k % 3 = 0 then now() - (k || ' minutes')::interval else null end,
        'waiting',
        now() - (k || ' minutes')::interval
      from generate_series(1, ${sql.raw(String(DOCTORS))}) d, generate_series(1, ${sql.raw(String(ENTRIES_PER_SESSION))}) k
    `);
    // The history the visit-type anchor searches: completed consultations spread over the last 400 days.
    await db.execute(sql`
      insert into opd_encounters (
        id, patient_id, status, workflow_instance_id, department_id, doctor_id, service_date, visit_type,
        consult_completed_at, follow_up_days, opened_by, opened_at, updated_by
      )
      select
        'PERFHIS' || lpad(gs::text, 18, '0'),
        'OPDP' || lpad(((gs % ${sql.raw(String(PATIENTS))}) + 1)::text, 22, '0'),
        'completed',
        'PERFHWI' || lpad(gs::text, 18, '0'),
        'PERFDEPT' || lpad(((gs % ${sql.raw(String(DEPARTMENTS))}) + 1)::text, 4, '0'),
        'PERFDOC' || lpad(((gs % ${sql.raw(String(DOCTORS))}) + 1)::text, 5, '0'),
        (now() - ((gs % 400) || ' days')::interval)::date,
        'new',
        now() - ((gs % 400) || ' days')::interval,
        7, 'perf-seed', now() - ((gs % 400) || ' days')::interval, 'perf-seed'
      from generate_series(1, ${sql.raw(String(HISTORY))}) gs
    `);
    await db.execute(sql`analyze patients, opd_encounters, opd_queue_entries, opd_queue_sessions, opd_doctors, opd_departments, opd_rooms`);
  }, 120_000);

  afterAll(async () => {
    await truncateAll(db); // do not leave 238k rows for the next suite's truncate to pay for
    await teardown();
  });

  it(`listQueue median over 5 runs is under ${QUEUE_BUDGET_MS} ms on a ${ENTRIES_PER_SESSION}-entry session`, async () => {
    await listQueue(db, clerk, doctorId(1), today); // warm the path once before timing
    const times: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const t0 = performance.now();
      const view = await listQueue(db, clerk, doctorId(n), today);
      times.push(performance.now() - t0);
      expect(view!.ordered).toHaveLength(ENTRIES_PER_SESSION); // the budget is measured on a FULL session
    }
    console.log(`listQueue timings ms: ${times.map((t) => t.toFixed(1)).join(", ")} (median ${median(times).toFixed(1)})`);
    expect(median(times)).toBeLessThan(QUEUE_BUDGET_MS);
  });

  it(`openVisit (visit-type anchor included) median over 5 runs is under ${VISIT_TYPE_BUDGET_MS} ms over ${HISTORY} completed encounters`, async () => {
    const doctor = doctorId(DOCTORS); // a different doctor-day from the listQueue measurement above
    const department = departmentOfDoctor(DOCTORS);
    await openVisit(db, clerk, { patientId: patientId(1), departmentId: department, doctorId: doctor }); // warm-up
    const times: number[] = [];
    for (let n = 2; n <= 6; n++) {
      const t0 = performance.now();
      const opened = await openVisit(db, clerk, { patientId: patientId(n), departmentId: department, doctorId: doctor });
      times.push(performance.now() - t0);
      expect(["new", "revisit", "renewal"]).toContain(opened.visitType);
    }
    console.log(`openVisit timings ms: ${times.map((t) => t.toFixed(1)).join(", ")} (median ${median(times).toFixed(1)})`);
    expect(median(times)).toBeLessThan(VISIT_TYPE_BUDGET_MS);
  });

  it(`boardSnapshot median over 5 runs is under ${BOARD_BUDGET_MS} ms over ${DOCTORS} sessions`, async () => {
    await boardSnapshot(db, today); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const items = await boardSnapshot(db, today);
      times.push(performance.now() - t0);
      expect(items).toHaveLength(DOCTORS);
    }
    console.log(`boardSnapshot timings ms: ${times.map((t) => t.toFixed(1)).join(", ")} (median ${median(times).toFixed(1)})`);
    expect(median(times)).toBeLessThan(BOARD_BUDGET_MS);
  });

  it("the doctor-day queue read is served by an index — no Seq Scan on opd_queue_entries", async () => {
    const res = await db.execute(sql`
      explain (format json)
      select * from opd_queue_entries
      where session_id = 'PERFSESS00001' and status in ('waiting_vitals', 'waiting', 'called', 'in_consult')
    `);
    const raw = res.rows[0]!["QUERY PLAN"];
    const plan: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const types = nodeTypes(plan);
    expect(types.length).toBeGreaterThan(0); // an empty walk must never pass vacuously
    expect(types).not.toContain("Seq Scan");
  });

  it("the visit-type anchor lookup is served by an index — no Seq Scan on opd_encounters", async () => {
    const res = await db.execute(sql`
      explain (format json)
      select consult_completed_at, follow_up_days from opd_encounters
      where patient_id in (${sql.raw(`'${patientId(7)}'`)}) and department_id = 'PERFDEPT0001' and status = 'completed'
      order by consult_completed_at desc
      limit 1
    `);
    const raw = res.rows[0]!["QUERY PLAN"];
    const plan: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const types = nodeTypes(plan);
    expect(types.length).toBeGreaterThan(0);
    expect(types).not.toContain("Seq Scan");
  });
});
