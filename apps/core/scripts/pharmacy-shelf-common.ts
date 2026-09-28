import { eq } from "drizzle-orm";
import { hasPermission } from "../src/kernel/auth/permissions";
import { users } from "../src/kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE FIVE PHARMACY-READY SCRIPTS SHARE THESE, AND NOTHING ELSE ═══
 *
 * `set-schedule-flags`, `build-pharmacy-starter-list`, `load-pharmacy-shelf`, `load-trial-stock`,
 * `wipe-trial-stock` and `import-opening-stock` (owner rulings 2026-09-22: the pharmacy opens on a
 * ~300-drug starter shelf, with trial stock first and the real shelf's opening stock after it).
 *
 * Three things, each of which every one of those scripts would otherwise write its own copy of:
 *   - the named PERSON an act is attributed to, refused unless they hold the permission the screen
 *     for that act is gated on — seeds in this repo never mint users, and a script that took any
 *     username would be a way round the route guard;
 *   - a CSV reader and writer that understands quotes, because a formulary brand name carries
 *     commas ("… 500 mg + 125 mg oral tablet") and a split on "," silently shifts every column;
 *   - the flags, read the same way everywhere.
 */

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export type Person = Actor & { id: string; username: string; fullName: string };

/**
 * The person an act is recorded against. Refused — with the screen that fixes it — when the account
 * does not exist, is deactivated, or does not hold `permission` at hospital scope.
 */
export async function resolvePerson(db: Db, username: string | undefined, permission: string, flag: string): Promise<Person> {
  if (username === undefined || username.trim() === "") {
    throw new Error(`${flag} <username> is required: the person this act is recorded against (they must hold ${permission})`);
  }
  const [row] = await db.select({ id: users.id, username: users.username, fullName: users.fullName, active: users.active })
    .from(users).where(eq(users.username, username.trim()));
  if (row === undefined || !row.active) {
    throw new Error(`${flag} ${username}: no active account with that username. Accounts are created at /admin/users — scripts never mint one.`);
  }
  if (!(await hasPermission(db, row.id, permission, "hospital"))) {
    throw new Error(`${flag} ${username}: "${row.fullName}" does not hold ${permission}. Grant the role at /admin/users, or name someone who holds it.`);
  }
  return { type: "user", id: row.id, username: row.username, fullName: row.fullName };
}

// ═══════════════════════════════════ CSV ═══════════════════════════════════

export { parseCsv, splitCsvLine } from "../src/modules/pharmacy/csv";
export type { CsvFile, CsvRow } from "../src/modules/pharmacy/csv";

function csvField(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}

export function toCsvLine(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvField).join(",");
}

/** IST calendar day, `YYYY-MM-DD` — the day a challan is dated and a batch expires in. */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}
