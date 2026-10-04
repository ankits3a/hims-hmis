import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import {
  opdDoctors, orgDepartments, rosterCycleEntries, rosterCycles, rosterPositions, users,
} from "../src/kernel/db/schema";
import {
  addIstDays, addMembership, confirmTeam, draftCycle, istDateOfInstant, istMidnightUtc, istWeekday,
  membershipsOf, publishCycle, teamByCode,
} from "../src/modules/roster";
import { publisher } from "./seed-roster-demo";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { RosterActivity } from "../src/kernel/db/schema/roster";

/**
 * `pnpm --filter @hmis/core setup:units` (dry run) · `… setup:units --apply` — **THE HOSPITAL'S REAL
 * UNITS, FROM ITS OPD DOCTOR LIST** (owner, 2026-10-04).
 *
 * *"We only have 1 unit per department right now which is active … some departments do not even have
 * any single doctor so we don't have units there."* `seed:roster` wrote the 27-unit establishment
 * inactive. This reads the OPD doctor list (`scripts/data/crkmch-units-2026-10.json` — every reading
 * of the handwritten sheet is noted there) and, for each department that has a unit:
 *
 *   1. confirms Unit I (`confirmTeam`) — Units II–V stay unconfirmed, because they do not exist yet;
 *   2. posts its faculty and senior residents (`addMembership`) — the only faculty, an Assistant
 *      Professor, as the unit in-charge (`unit_head`, DECIDED in the data file), an SR as `unit_sr`.
 *      **Guest faculty are never members** (owner), nor is the casualty medical officer;
 *   3. publishes a weekly take cycle (`draftCycle` + `publishCycle`): the unit on take every day, and
 *      in OPD 09:00–17:00 (the owner's default OPD time) on the weekdays its members sit (the union of their sheet days).
 *
 * ═══ DRY RUN BY DEFAULT ═══
 * Without `--apply` it writes nothing and prints the plan and every doctor it could not match. It
 * never creates a user, an OPD doctor or an OPD clinic: a name it cannot find is reported, and the
 * department is left as it is.
 *
 * ═══ IDEMPOTENT ═══
 * A confirmed unit is not re-confirmed; a person already in the unit is not re-posted (a person in a
 * DIFFERENT unit is reported and left alone); a department whose published cycle is already exactly
 * this one is not re-published. A second `--apply` changes nothing.
 *
 * ═══ PRECONDITIONS ═══
 * `seed:roster` (org departments, positions, the seeded units); a user holding `medical_superintendent`
 * (the acting publisher, as `seed:roster-demo` picks it); the doctors existing as users — and as OPD
 * doctors, for the OPD line to name them on the days they sit — with these names.
 */

export const DATA_FILE = join(__dirname, "data", "crkmch-units-2026-10.json");

export type Place = "unit_head" | "unit_sr" | "guest_faculty" | "casualty_mo" | "no_unit";
export interface ListedDoctor {
  sl: number; name: string; sheetName: string; aliases: string[]; department: string; sheetDepartment: string;
  days: string[]; hours: string; designation: string; place: Place; notes: string;
}
export interface UnitsData {
  opdWindow: { start: string; end: string };
  doctors: ListedDoctor[];
  omitted: { sl: number; name: string; department: string; reason: string }[];
}

export function loadUnitsData(path: string = DATA_FILE): UnitsData {
  return JSON.parse(readFileSync(path, "utf8")) as UnitsData;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNIT_PLACES: readonly Place[] = ["unit_head", "unit_sr"];
const MEMBER: Record<"unit_head" | "unit_sr", { positionKey: string; grade: "assistant_professor" | "senior_resident"; roleInTeam: "head" | "senior_resident" }> = {
  unit_head: { positionKey: "unit_head", grade: "assistant_professor", roleInTeam: "head" },
  unit_sr: { positionKey: "unit_sr", grade: "senior_resident", roleInTeam: "senior_resident" },
};
const TAKE_START = 8 * 60;
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** A name as the matcher compares it: no "Dr."/"Mam", no dots or spacing, Kumari folded into Kumar. */
export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/\./g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((t) => t !== "" && t !== "dr" && t !== "mam" && t !== "sir")
    .map((t) => (t === "kumari" ? "kumar" : t));
}
const nameKey = (name: string): string => nameTokens(name).join("");

interface Candidate { userId: string; names: string[]; opdDepartmentId: string | null }
export interface DoctorMatch {
  sl: number; name: string; place: Place; department: string;
  userId: string | null; matchedAs: string | null; how: "exact" | "loose" | null;
  /** Why no user was taken: nobody, or more than one person, carries the name. */
  problem: "unmatched" | "ambiguous" | null;
  candidates: string[];
}

function matchOne(d: ListedDoctor, pool: readonly Candidate[]): DoctorMatch {
  const base = { sl: d.sl, name: d.name, place: d.place, department: d.department };
  const wanted = [d.name, d.sheetName, ...d.aliases];
  const keys = new Set(wanted.map(nameKey));
  const exact = pool.filter((c) => c.names.some((n) => keys.has(nameKey(n))));
  // Loose: every token of a listed spelling is in the candidate's name ("Dr. Chandan" ⊂ "Dr. Chandan Kumar").
  const loose = exact.length > 0 ? [] : pool.filter((c) => c.names.some((n) => {
    const have = new Set(nameTokens(n));
    return wanted.some((w) => { const t = nameTokens(w); return t.length > 0 && t.every((x) => have.has(x)); });
  }));
  const hits = exact.length > 0 ? exact : loose;
  if (hits.length === 1) {
    return { ...base, userId: hits[0]!.userId, matchedAs: hits[0]!.names[0]!, how: exact.length > 0 ? "exact" : "loose", problem: null, candidates: [] };
  }
  return {
    ...base, userId: null, matchedAs: null, how: null, problem: hits.length === 0 ? "unmatched" : "ambiguous",
    candidates: hits.map((h) => h.names[0]!),
  };
}

/** Every active user and active OPD doctor, by the names they go by. */
async function candidates(db: Db): Promise<Candidate[]> {
  const people = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.active, true));
  const doctors = await db.select({ userId: opdDoctors.userId, displayName: opdDoctors.displayName, departmentId: opdDoctors.departmentId })
    .from(opdDoctors).where(eq(opdDoctors.active, true));
  const byUser = new Map<string, Candidate>();
  for (const p of people) byUser.set(p.id, { userId: p.id, names: [p.fullName], opdDepartmentId: null });
  for (const d of doctors) {
    const c = byUser.get(d.userId);
    if (c === undefined) continue; // an OPD profile on an inactive user is nobody to post
    if (!c.names.includes(d.displayName)) c.names.unshift(d.displayName);
    c.opdDepartmentId = d.departmentId;
  }
  return [...byUser.values()];
}

export interface PlannedUnit {
  department: string; departmentName: string; teamCode: string; teamId: string | null; confirmed: boolean;
  members: { sl: number; name: string; userId: string | null; positionKey: string }[];
  opdWeekdays: number[];
}
export interface SetupReport {
  apply: boolean; from: string; actor: string | null;
  preconditions: string[];
  matches: DoctorMatch[];
  units: PlannedUnit[];
  noUnit: string[];
  actions: string[];
  warnings: string[];
  unitsConfirmed: number; membershipsAdded: number; cyclesPublished: string[];
}

/** A Monday-anchored seven-day cycle: take every day, OPD on the unit's weekdays. dayIndex 0 = Monday. */
export function weeklyEntries(teamId: string, opdWeekdays: readonly number[], opd: { start: string; end: string }) {
  const entries: { dayIndex: number; teamId: string; activity: RosterActivity; startMinute: number; durationMinutes: number }[] = [];
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const weekday = (dayIndex + 1) % 7;
    entries.push({ dayIndex, teamId, activity: "take", startMinute: TAKE_START, durationMinutes: 1440 });
    if (opdWeekdays.includes(weekday)) {
      entries.push({ dayIndex, teamId, activity: "opd", startMinute: minutesOf(opd.start), durationMinutes: minutesOf(opd.end) - minutesOf(opd.start) });
    }
  }
  return entries;
}

const entryKey = (e: { dayIndex: number; teamId: string; activity: string; startMinute: number; durationMinutes: number }): string =>
  `${e.dayIndex}|${e.teamId}|${e.activity}|${e.startMinute}|${e.durationMinutes}`;

/** The department's live cycle is already this one (same week, same anchor weekday, same entries). */
async function liveCycleIs(db: Db, departmentId: string, want: ReturnType<typeof weeklyEntries>): Promise<boolean> {
  const live = (await db.select().from(rosterCycles)
    .where(and(eq(rosterCycles.departmentId, departmentId), eq(rosterCycles.status, "published"))))[0];
  if (live === undefined || live.cycleDays !== 7 || istWeekday(live.anchorIstDate) !== 1) return false;
  const have = (await db.select().from(rosterCycleEntries).where(eq(rosterCycleEntries.cycleId, live.id))).map(entryKey).sort();
  return JSON.stringify(have) === JSON.stringify(want.map(entryKey).sort());
}

export async function setupUnits(
  db: Db, opts: { apply: boolean; from?: string; data?: UnitsData; now?: Date },
): Promise<SetupReport> {
  const now = opts.now ?? new Date();
  const from = opts.from ?? istDateOfInstant(now);
  const data = opts.data ?? loadUnitsData();
  const report: SetupReport = {
    apply: opts.apply, from, actor: null, preconditions: [], matches: [], units: [], noUnit: [], actions: [], warnings: [],
    unitsConfirmed: 0, membershipsAdded: 0, cyclesPublished: [],
  };

  /* ── preconditions ── */
  const depts = await db.select().from(orgDepartments);
  const deptByCode = new Map(depts.map((d) => [d.code, d]));
  const positions = new Set((await db.select({ key: rosterPositions.key }).from(rosterPositions)).map((p) => p.key));
  if (depts.length === 0 || !positions.has("unit_head") || !positions.has("unit_sr")) {
    report.preconditions.push("the roster masters are not loaded — run `pnpm --filter @hmis/core seed:roster` first");
  }
  let actor: (Actor & { id: string }) | null = null;
  try {
    actor = await publisher(db);
    report.actor = actor.id;
  } catch (e) {
    report.preconditions.push(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  /* ── who is who ── */
  const pool = await candidates(db);
  report.matches = data.doctors.map((d) => matchOne(d, pool));
  const matchOf = new Map(report.matches.map((m) => [m.sl, m]));
  for (const m of report.matches) {
    if (m.problem === "ambiguous") report.warnings.push(`#${m.sl} ${m.name}: more than one person carries this name (${m.candidates.join(", ")}) — not posted`);
    if (m.how === "loose") report.warnings.push(`#${m.sl} ${m.name}: matched loosely to "${m.matchedAs}" — check it is the same doctor`);
  }

  /* ── the units ── */
  const unitDepts = [...new Set(data.doctors.filter((d) => UNIT_PLACES.includes(d.place)).map((d) => d.department))];
  for (const code of unitDepts) {
    const dept = deptByCode.get(code);
    const team = dept === undefined ? undefined : await teamByCode(db, `${code}-U1`);
    const listed = data.doctors.filter((d) => d.department === code && UNIT_PLACES.includes(d.place));
    const opdWeekdays = [...new Set(listed.flatMap((d) => d.days.map((x) => WEEKDAY[x]!)))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    report.units.push({
      department: code, departmentName: dept?.name ?? code, teamCode: `${code}-U1`, teamId: team?.id ?? null, confirmed: team?.active ?? false,
      members: listed.map((d) => ({ sl: d.sl, name: d.name, userId: matchOf.get(d.sl)!.userId, positionKey: MEMBER[d.place as "unit_head" | "unit_sr"].positionKey })),
      opdWeekdays,
    });
    if (dept !== undefined && team === undefined) report.preconditions.push(`${code}: no seeded unit ${code}-U1 — run seed:roster first`);
  }
  for (const d of data.doctors.filter((x) => !UNIT_PLACES.includes(x.place))) {
    const who = `#${d.sl} ${d.name} (${d.designation})`;
    if (d.place === "guest_faculty") report.noUnit.push(`${who}: guest faculty — sits in the ${d.sheetDepartment} OPD, in no unit`);
    if (d.place === "casualty_mo") report.noUnit.push(`${who}: casualty medical officer (position casualty_mo) — rostered through a Casualty duty roster, not a unit`);
    if (d.place === "no_unit") {
      const dept = deptByCode.get(d.department);
      report.noUnit.push(`${who}: ${dept?.name ?? d.department} has no clinical unit (NMC gives it none)${dept !== undefined && dept.opdDepartmentId === null
        ? "; its OPD clinic is MISSING (org department not linked to an opd_departments clinic) — not created here"
        : "; sits in its OPD, no unit line"}`);
    }
  }
  const unitCodes = new Set(unitDepts);
  const guestOnly = [...new Set(data.doctors.filter((d) => d.place === "guest_faculty" && !unitCodes.has(d.department)).map((d) => d.department))];
  for (const code of guestOnly) report.noUnit.push(`${deptByCode.get(code)?.name ?? code}: guest faculty only — NO unit; its seeded units stay unconfirmed`);

  /* ── the plan, and (with --apply) the writes ── */
  const membersAt = istMidnightUtc(from);
  const anchor = addIstDays(from, -((istWeekday(from) + 6) % 7)); // the Monday on or before `from`
  for (const u of report.units) {
    const say = (s: string): void => { report.actions.push(`${opts.apply ? "" : "WOULD "}${s}`); };
    if (u.teamId === null) { report.warnings.push(`${u.department}: no unit to set up`); continue; }
    const deptId = deptByCode.get(u.department)!.id;
    const posted = u.members.filter((m) => m.userId !== null);
    for (const m of u.members.filter((x) => x.userId === null)) report.warnings.push(`${u.teamCode}: #${m.sl} ${m.name} not matched — not posted`);
    if (posted.length === 0) { report.warnings.push(`${u.teamCode}: nobody matched — unit left as it is`); continue; }

    const steps: { text: string; run: (tx: Parameters<typeof confirmTeam>[0]) => Promise<void> }[] = [];
    if (!u.confirmed) {
      steps.push({ text: `confirm ${u.teamCode} (${u.departmentName} Unit I)`, run: async (tx) => { await confirmTeam(tx, actor!, u.teamId!); report.unitsConfirmed += 1; } });
    }
    for (const m of posted) {
      const held = await membershipsOf(db, m.userId!, membersAt);
      if (held.some((h) => h.teamId === u.teamId)) continue;
      if (held.length > 0) { report.warnings.push(`${u.teamCode}: #${m.sl} ${m.name} is already in another team — left as is`); continue; }
      const place = MEMBER[m.positionKey as "unit_head" | "unit_sr"];
      steps.push({
        text: `post ${m.name} to ${u.teamCode} as ${m.positionKey}`,
        run: async (tx) => { await addMembership(tx, actor!, { teamId: u.teamId!, userId: m.userId!, ...place, startsAt: membersAt }); report.membershipsAdded += 1; },
      });
    }
    const entries = weeklyEntries(u.teamId, u.opdWeekdays, data.opdWindow);
    if (!(await liveCycleIs(db, deptId, entries))) {
      const days = u.opdWeekdays.map((d) => DAY_NAME[d]).join(", ");
      steps.push({
        text: `publish ${u.department}'s weekly cycle from ${from}: ${u.teamCode} on take every day, OPD ${data.opdWindow.start}–${data.opdWindow.end} on ${days}`,
        run: async (tx) => {
          const { cycleId } = await draftCycle(tx, actor!, { departmentId: deptId, cycleDays: 7, anchorIstDate: anchor, entries });
          await publishCycle(tx, actor!, cycleId, from);
          report.cyclesPublished.push(u.department);
        },
      });
    }
    for (const s of steps) say(s.text);
    if (opts.apply && report.preconditions.length === 0 && steps.length > 0) {
      await withTx(db, async (tx) => { for (const s of steps) await s.run(tx); });
    }
  }
  // Guest faculty and the casualty MO must not be unit members; say so if somebody already made them one.
  for (const m of report.matches.filter((x) => !UNIT_PLACES.includes(x.place) && x.userId !== null)) {
    const held = await membershipsOf(db, m.userId!, membersAt);
    if (held.length > 0) report.warnings.push(`#${m.sl} ${m.name} is ${m.place.replace("_", " ")} but is a member of a team — end that membership by hand`);
  }
  if (opts.apply && report.preconditions.length > 0) report.actions = report.actions.map((a) => `NOT DONE (preconditions) — ${a}`);
  return report;
}

export function printReport(r: SetupReport, out: (s: string) => void): void {
  out(`setup:units — ${r.apply ? "APPLY" : "DRY RUN (nothing written; add --apply)"} · effective from ${r.from}\n`);
  if (r.preconditions.length > 0) out(`\nPRECONDITIONS NOT MET:\n${r.preconditions.map((p) => `  ✗ ${p}\n`).join("")}`);
  out("\nDoctors on the list:\n");
  for (const m of r.matches) {
    const found = m.userId === null ? `${m.problem!.toUpperCase()}${m.candidates.length > 0 ? ` (${m.candidates.join(", ")})` : ""}` : `→ ${m.matchedAs}${m.how === "loose" ? " (loose match — check)" : ""}`;
    out(`  #${String(m.sl).padStart(2)} ${m.name.padEnd(22)} ${m.department.padEnd(5)} ${m.place.padEnd(14)} ${found}\n`);
  }
  out("\nUnits:\n");
  for (const u of r.units) {
    out(`  ${u.teamCode.padEnd(7)} ${u.departmentName} Unit I${u.confirmed ? " (already confirmed)" : ""} · OPD ${u.opdWeekdays.map((d) => DAY_NAME[d]).join(", ")} · ${u.members.map((m) => `${m.name} [${m.positionKey}]${m.userId === null ? " (unmatched)" : ""}`).join(", ")}\n`);
  }
  out(`\nNo unit:\n${r.noUnit.map((s) => `  · ${s}\n`).join("")}`);
  out(`\n${r.apply ? "Done" : "Plan"}:\n${r.actions.length === 0 ? "  nothing to do — already set up\n" : r.actions.map((a) => `  ${a}\n`).join("")}`);
  if (r.warnings.length > 0) out(`\nWarnings:\n${r.warnings.map((w) => `  ! ${w}\n`).join("")}`);
  out(`\nunitsConfirmed ${r.unitsConfirmed} · membershipsAdded ${r.membershipsAdded} · cyclesPublished ${r.cyclesPublished.length === 0 ? "—" : r.cyclesPublished.join(", ")}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fromArg = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  if (fromArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) throw new Error("--from= takes an IST date, YYYY-MM-DD");
  const url = requireEnv("DATABASE_URL");
  process.stdout.write(`database "${new URL(url).pathname.replace(/^\//, "")}"\n`);
  const { db, pool } = createDb(url);
  try {
    const report = await setupUnits(db, { apply, ...(fromArg === undefined ? {} : { from: fromArg }) });
    printReport(report, (s) => process.stdout.write(s));
    if (apply && report.preconditions.length > 0) process.exitCode = 1;
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
