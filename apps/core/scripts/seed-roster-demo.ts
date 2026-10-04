import { and, asc, eq, inArray, lt, gt } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { assertSyntheticDataAllowed } from "./synthetic-door";
import {
  opdDoctors, orgDepartments, roleAssignments, rosterPeriods, rosterTeams, users,
} from "../src/kernel/db/schema";
import {
  addIstDays, addMembership, assign, confirmTeam, cycleTemplate, departmentsWithoutPublishedCycle,
  draftCycleFromTemplate, draftPeriod, istDateOfInstant, istMidnightUtc, istWeekday, membershipsOf,
  publishCycle, publishPeriod,
} from "../src/modules/roster";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";
import type { AssignInput, RosterTeamRow } from "../src/modules/roster";

/**
 * `ALLOW_DEMO_DATA=yes pnpm --filter @hmis/core seed:roster-demo` — a DEMO ROSTER, so the "who is
 * on now" board (20-U U5a, `/roster/on-now`) can be seen showing a hospital rather than 24 empty
 * rows. **20-U U5a.**
 *
 * ═══ IT IS NOT IN `deploy.sh`, AND THAT IS THE POINT ═══
 *
 * `seed:roster` seeds the MASTERS (departments, positions, draft units) and every environment needs
 * them. This seeds DUTIES: it says Dr X is the senior resident in the building tonight. On a live
 * hospital that is a lie casualty would act on — a resident paged who is not on, a hole that looks
 * covered. So it is an operator command, absent from `deploy.sh`'s seed list and from
 * `SEED_STEP_SCRIPTS`, behind the synthetic-data door (`HMIS_SYNTHETIC_DATA_OK=1`, which only
 * `/opt/hmis-uat/.env` carries) AND the word an operator types (`ALLOW_DEMO_DATA=yes`), exactly as
 * `seed:lab-demo` is.
 *
 * ═══ IT MINTS NOBODY, AND ACTS AS A REAL PUBLISHER ═══
 *
 * No user is created. The people placed are the hospital's existing OPD doctors (`opd_doctors`,
 * mapped to an org department through `org_departments.opd_department_id`), and the hospital-wide
 * services go to whoever already holds `duty_manager` / `pharmacy`. Every write is the roster
 * module's own domain function — `confirmTeam`, `addMembership`, `draftCycleFromTemplate` +
 * `publishCycle`, `draftPeriod` + `assign` + `publishPeriod` — called as a user who holds the
 * roster publish grant (the medical superintendent), so the permission check, the RBAC eligibility
 * check, the presence-clash check and the validator at the publish gate all run exactly as they do
 * for a head of department. Nothing is hand-inserted, and no finding is accepted on anyone's behalf.
 *
 * ═══ THE SHAPE, AND WHY IT IS RULE-CLEAN ═══
 *
 * A demo box has about two doctors per department, so per department, for today −7 … today +7 (IST):
 *   · the first doctor (an MS first, then by username) is the unit head and **faculty on call**,
 *     24 h by CALL from 08:00 — on-call is not presence, so no presence cap or rest rule applies;
 *   · the second is the **unit senior resident**, in the building 08:00–20:00, six days a week
 *     (72 h — under the 74 h warning), 12 h rest between every duty;
 *   · a third, where there is one, is a **ward junior resident** on nights 20:00–08:00, six a week.
 * The take cycle is the gallery template written for the department's unit count, anchored seven
 * days back, so a unit is on take NOW. The weekly off is placed three (SR) / four (JR) days ahead of
 * the run date, so it is never today.
 *
 * ═══ THE DELIBERATE HOLE ═══
 *
 * General Surgery's senior-resident NIGHTS from tonight on are declared VACANT (a slot with no
 * person — V16), so "Holes in the next 24 hours" always has one honest row. A department with no
 * doctor to place (Respiratory Medicine on the demo box) is left untouched and unpublished, and the
 * board shows it as such: its missing take cycle is itself a hole, which is the truth.
 *
 * ═══ IDEMPOTENT ═══
 *
 * Each department is one transaction. Re-running skips a unit already confirmed, a person already
 * in a team, a department that already has a published take cycle, and a department (or the
 * hospital scope) that already has any draft or published roster touching the window.
 */

const VACANT_NIGHTS_DEPARTMENT = "SUR";
const DAY_START = 8 * 60;
const NIGHT_START = 20 * 60;
const SPAN_DAYS = 7;

const TEMPLATE_FOR_UNITS: Record<number, string> = {
  1: "single_unit_call", 2: "two_unit_alternate", 3: "three_unit_fixed", 4: "four_unit_obg", 5: "five_unit_rolling",
};

export interface RosterDemoReport {
  actor: string;
  unitsConfirmed: number;
  membershipsAdded: number;
  cyclesPublished: string[];
  periodsPublished: string[];
  slotsAssigned: number;
  vacantSlots: number;
  skipped: string[];
}

/** An IST wall-clock instant: `istDate` at `minute` past midnight. */
const istAt = (istDate: string, minute: number): Date => new Date(istMidnightUtc(istDate).getTime() + minute * 60_000);

/** A user holding the roster publish grant, as an actor — the MS, never the system admin account if anyone else holds it. */
export async function publisher(db: Db): Promise<Actor & { id: string }> {
  const rows = await db.select({ id: users.id, username: users.username }).from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(and(eq(roleAssignments.roleKey, "medical_superintendent"), eq(users.active, true)))
    .orderBy(asc(users.username));
  const row = rows.find((r) => r.username !== "admin") ?? rows[0];
  if (row === undefined) {
    throw new Error(
      "no active user holds \"medical_superintendent\", which publishes rosters.\n"
        + "  This seed creates no accounts by design. Grant the role at /admin/users and run it again.",
    );
  }
  return { type: "user", id: row.id };
}

/** Users holding a role, excluding the system accounts (anyone holding `admin` or `owner`). */
async function holdersOf(db: Db, roleKey: string): Promise<{ id: string; username: string }[]> {
  const holders = await db.selectDistinct({ id: users.id, username: users.username }).from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(and(eq(roleAssignments.roleKey, roleKey), eq(users.active, true)))
    .orderBy(asc(users.username));
  if (holders.length === 0) return [];
  const system = new Set((await db.select({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(and(inArray(roleAssignments.userId, holders.map((h) => h.id)), inArray(roleAssignments.roleKey, ["admin", "owner"]))))
    .map((r) => r.userId));
  return holders.filter((h) => !system.has(h.id));
}

/** Any draft or published roster of this scope already touching the window. */
async function hasRosterIn(exec: Db | Tx, scope: { departmentId: string | null }, from: Date, to: Date): Promise<boolean> {
  const rows = await (exec as Db).select({ id: rosterPeriods.id, departmentId: rosterPeriods.departmentId, scopeType: rosterPeriods.scopeType })
    .from(rosterPeriods)
    .where(and(lt(rosterPeriods.startsAt, to), gt(rosterPeriods.endsAt, from), inArray(rosterPeriods.status, ["draft", "published"])));
  return rows.some((r) => (scope.departmentId === null ? r.scopeType === "hospital" : r.departmentId === scope.departmentId));
}

export async function seedRosterDemo(db: Db, now: Date = new Date()): Promise<RosterDemoReport> {
  const actor = await publisher(db);
  const report: RosterDemoReport = {
    actor: actor.id, unitsConfirmed: 0, membershipsAdded: 0, cyclesPublished: [], periodsPublished: [],
    slotsAssigned: 0, vacantSlots: 0, skipped: [],
  };

  const today = istDateOfInstant(now);
  const first = addIstDays(today, -SPAN_DAYS);
  const days = Array.from({ length: SPAN_DAYS * 2 + 1 }, (_, i) => addIstDays(first, i));
  const windowFrom = istMidnightUtc(first);
  const windowTo = istMidnightUtc(addIstDays(today, SPAN_DAYS + 1));
  const srOff = istWeekday(addIstDays(today, 3));
  const jrOff = istWeekday(addIstDays(today, 4));
  const doctorUserIds = new Set((await holdersOf(db, "doctor")).map((h) => h.id));
  const msUserIds = new Set((await db.select({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(eq(roleAssignments.roleKey, "medical_superintendent"))).map((r) => r.userId));

  const departments = await db.select().from(orgDepartments).orderBy(asc(orgDepartments.code));
  const allUnits = await db.select().from(rosterTeams).where(eq(rosterTeams.kind, "clinical_unit"));

  for (const dept of departments) {
    const units = allUnits.filter((t) => t.departmentId === dept.id && t.validTo === null)
      .sort((a, b) => (a.unitNumber ?? 0) - (b.unitNumber ?? 0));
    if (units.length === 0) continue;

    const doctors = dept.opdDepartmentId === null ? [] : (await db
      .select({ userId: opdDoctors.userId, username: users.username })
      .from(opdDoctors).innerJoin(users, eq(users.id, opdDoctors.userId))
      .where(and(eq(opdDoctors.departmentId, dept.opdDepartmentId), eq(opdDoctors.active, true), eq(users.active, true))))
      // Only somebody who holds `doctor` can answer as a unit's SR / JR / faculty (the RBAC check in `assign`).
      .filter((d) => doctorUserIds.has(d.userId))
      .sort((a, b) => Number(msUserIds.has(b.userId)) - Number(msUserIds.has(a.userId)) || a.username.localeCompare(b.username));
    if (doctors.length === 0) {
      report.skipped.push(`${dept.code}: no doctor to place — left unpublished`);
      continue;
    }
    const templateKey = TEMPLATE_FOR_UNITS[units.length];
    if (templateKey === undefined) {
      report.skipped.push(`${dept.code}: no gallery template for ${units.length} units — left unpublished`);
      continue;
    }

    await withTx(db, async (tx) => {
      // 1. The head of department ratifies the seeded units.
      for (const unit of units) {
        if (unit.active) continue;
        await confirmTeam(tx, actor, unit.id);
        report.unitsConfirmed += 1;
      }

      // 2. People into Unit I: faculty (head), then SR, then JR.
      const [faculty, sr, jr] = doctors;
      const unitOne: RosterTeamRow = units[0]!;
      const places = [
        faculty && { userId: faculty.userId, positionKey: "unit_head", grade: "associate_professor" as const, roleInTeam: "head" as const },
        sr && { userId: sr.userId, positionKey: "unit_sr", grade: "senior_resident" as const, roleInTeam: "senior_resident" as const },
        jr && { userId: jr.userId, positionKey: "ward_jr", grade: "jr2" as const, roleInTeam: "junior_resident" as const },
      ].filter((p) => p !== undefined);
      for (const p of places) {
        if ((await membershipsOf(tx, p.userId, now)).length > 0) continue;
        await addMembership(tx, actor, { teamId: unitOne.id, ...p, startsAt: windowFrom });
        report.membershipsAdded += 1;
      }

      // 3. The take cycle, from the template written for this many units.
      if ((await departmentsWithoutPublishedCycle(tx)).includes(dept.id)) {
        const { cycleId } = await draftCycleFromTemplate(tx, actor, { departmentId: dept.id, templateKey, anchorIstDate: first });
        await publishCycle(tx, actor, cycleId, first);
        report.cyclesPublished.push(`${dept.code} (${cycleTemplate(templateKey).label})`);
      } else {
        report.skipped.push(`${dept.code}: take cycle already published`);
      }

      // 4. The duty roster for the fortnight around today.
      if (await hasRosterIn(tx, { departmentId: dept.id }, windowFrom, windowTo)) {
        report.skipped.push(`${dept.code}: a roster already covers the window`);
        return;
      }
      const vacantNights = dept.code === VACANT_NIGHTS_DEPARTMENT;
      const covers = ["faculty_on_call", ...(sr ? ["unit_sr"] : []), ...(jr ? ["ward_jr"] : [])];
      if (vacantNights && !covers.includes("unit_sr")) covers.push("unit_sr");
      const { periodId } = await draftPeriod(tx, actor, {
        scopeType: "department", scopeId: dept.id, departmentId: dept.id, teamId: null,
        title: `${dept.name} — demo roster`, coversPositions: covers, startsAt: windowFrom, endsAt: windowTo,
      });
      const slots: AssignInput[] = [];
      for (const d of days) {
        const next = addIstDays(d, 1);
        if (faculty) {
          slots.push({ userId: faculty.userId, positionKey: "faculty_on_call", departmentId: dept.id, coverScope: "department",
            mode: "call", callTier: 1, startsAt: istAt(d, DAY_START), endsAt: istAt(next, DAY_START) });
        }
        if (sr && istWeekday(d) !== srOff) {
          slots.push({ userId: sr.userId, positionKey: "unit_sr", departmentId: dept.id, coverScope: "department",
            startsAt: istAt(d, DAY_START), endsAt: istAt(d, NIGHT_START) });
        }
        if (jr && istWeekday(d) !== jrOff) {
          slots.push({ userId: jr.userId, positionKey: "ward_jr", departmentId: dept.id, coverScope: "department",
            startsAt: istAt(d, NIGHT_START), endsAt: istAt(next, DAY_START) });
        }
        if (vacantNights && d >= today) {
          slots.push({ userId: null, positionKey: "unit_sr", departmentId: dept.id, coverScope: "department",
            startsAt: istAt(d, NIGHT_START), endsAt: istAt(next, DAY_START), note: "Night SR not yet named (demo hole)" });
        }
      }
      for (const s of slots) await assign(tx, actor, periodId, s);
      report.slotsAssigned += slots.length;
      report.vacantSlots += slots.filter((s) => s.userId === null).length;
      await publishPeriod(tx, actor, periodId);
      report.periodsPublished.push(dept.code);
    });
  }

  // 5. The hospital-wide services: duty manager (Administration) and the pharmacy counter (Pharmacy).
  const deptByCode = new Map(departments.map((d) => [d.code, d.id]));
  const services = [
    { positionKey: "duty_manager", roleKey: "duty_manager", deptCode: "ADMN" },
    { positionKey: "pharmacist_counter", roleKey: "pharmacy", deptCode: "PHAR" },
  ];
  const staffed: { positionKey: string; departmentId: string; people: string[] }[] = [];
  for (const s of services) {
    const departmentId = deptByCode.get(s.deptCode);
    const people = (await holdersOf(db, s.roleKey)).slice(0, 2).map((h) => h.id);
    if (departmentId === undefined || people.length === 0) {
      report.skipped.push(`hospital ${s.positionKey}: nobody holds "${s.roleKey}" — not rostered`);
      continue;
    }
    staffed.push({ positionKey: s.positionKey, departmentId, people });
  }
  if (staffed.length > 0) {
    await withTx(db, async (tx) => {
      if (await hasRosterIn(tx, { departmentId: null }, windowFrom, windowTo)) {
        report.skipped.push("hospital: a roster already covers the window");
        return;
      }
      const { periodId } = await draftPeriod(tx, actor, {
        scopeType: "hospital", scopeId: null, departmentId: null, teamId: null,
        title: "Hospital services — demo roster", coversPositions: staffed.map((s) => s.positionKey),
        startsAt: windowFrom, endsAt: windowTo,
      });
      let n = 0;
      for (const d of days) {
        const next = addIstDays(d, 1);
        for (const s of staffed) {
          // Day 08:00–20:00 to the first holder, night 20:00–08:00 to the second where there is one.
          const shifts = [
            { userId: s.people[0]!, startsAt: istAt(d, DAY_START), endsAt: istAt(d, NIGHT_START) },
            ...(s.people[1] === undefined ? [] : [{ userId: s.people[1], startsAt: istAt(d, NIGHT_START), endsAt: istAt(next, DAY_START) }]),
          ];
          for (const shift of shifts) {
            await assign(tx, actor, periodId, { ...shift, positionKey: s.positionKey, departmentId: s.departmentId, coverScope: "hospital" });
            n += 1;
          }
        }
      }
      report.slotsAssigned += n;
      await publishPeriod(tx, actor, periodId);
      report.periodsPublished.push("hospital services");
    });
  }
  return report;
}

/** The same two doors as `seed:lab-demo`: the environment fact, then the word an operator types. */
export function assertRosterDemoAllowed(
  env: { ALLOW_DEMO_DATA?: string | undefined; HMIS_SYNTHETIC_DATA_OK?: string | undefined },
  dbName: string,
): void {
  assertSyntheticDataAllowed("seed:roster-demo", env);
  if (env.ALLOW_DEMO_DATA !== "yes") {
    throw new Error(
      `seed:roster-demo would publish a DEMO duty roster to the database "${dbName}".\n`
        + "  On a live hospital that names people on duty who are not. If this is a demo or test\n"
        + "  database, re-run with ALLOW_DEMO_DATA=yes.",
    );
  }
}

async function main(): Promise<void> {
  const url = requireEnv("DATABASE_URL");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  assertRosterDemoAllowed(process.env, dbName);
  process.stdout.write(`seed:roster-demo -> publishing a demo roster to "${dbName}"\n`);
  const { db, pool } = createDb(url);
  try {
    const report = await seedRosterDemo(db);
    for (const [k, v] of Object.entries(report)) {
      process.stdout.write(`  ${k}: ${Array.isArray(v) ? (v.length === 0 ? "—" : `\n    ${v.join("\n    ")}`) : String(v)}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof Error && "detail" in e) process.stderr.write(`${JSON.stringify((e as { detail: unknown }).detail, null, 2)}\n`);
    process.exit(1);
  });
}
