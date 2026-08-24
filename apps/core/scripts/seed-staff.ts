import { inArray } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createUser, setPin, verifyPassword, verifyPin } from "../src/kernel/auth/identity";
import { checkPassword, checkPin } from "../src/kernel/auth/password-policy";
import { assignRole } from "../src/kernel/auth/permissions";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import { GRANTED_BY_OTHER_SEEDS, ROLE_MODEL } from "./seed-roles";
import { roleAssignments, rolePermissions, roles, users } from "../src/kernel/db/schema";

/**
 * `cat roster.json | pnpm --filter @hmis/core seed:staff` — the go-live step that gives a
 * deployment its HUMANS (Plan 11d, D4).
 *
 * WHY THIS EXISTS, because a script nobody understands is a script nobody runs.
 *
 *   - `createUser` had exactly ONE non-test caller in the whole tree, `scripts/seed-admin.ts`,
 *     and that script RETURNED EARLY on any deployment that already had an admin (Plan 11e T5
 *     deleted that early return). So after the
 *     first boot there was no way, anywhere in this repository, to create a second user.
 *   - `setPin` had ZERO non-test callers. Plan 02 built and perf-tested a sub-2-second PIN
 *     fast-switch precisely so a ward terminal would not end up sharing one session, and nothing
 *     in the tree could put a PIN on anybody.
 *   - `seed:ops` REFUSES a username that does not exist, by design. `seed:roles` mints authority
 *     and assigns nobody, by design. Both were waiting for a tool that did not exist.
 *   - There was no user-administration HTTP surface when this script was written:
 *     `auth.users.manage` was declared by a manifest and guarded no route anywhere in the tree.
 *     Plan 11e T3 shipped `kernel/auth/users-admin.controller.ts` and T6 the screen, so a
 *     forgotten password is now repaired over HTTP rather than by re-running this script.
 *
 * MEASURED AGAINST PRODUCTION ON 2026-08-24 (plan 11d §B-MEASURED, four read-only SELECTs):
 * `https://hmis.crkmch.com` had ONE user, `admin`, with `has_pin = f`. One person, no fast-switch,
 * and no second account possible. Separation of duties, the two-key activation ceremony and owner
 * UAT at the real counters were all unreachable on a box already serving a hospital. This is the
 * tool that closes that.
 *
 * WHY STDIN, AND WHAT THAT COSTS — stated rather than glossed (D4). The roster carries passwords
 * and PINs. Env vars were rejected: they land in shell history, in `ps` output and in any process
 * dump. A file under `/opt/hmis-prod` was rejected: rule 3 reserves that directory for
 * deploy-managed config, and a credential roster left on a box is an artefact nobody remembers to
 * delete. STDIN was chosen — nothing is written to the box, nothing enters shell history, and the
 * owner keeps the only copy.
 *
 * THE COST IS REAL AND IT IS THIS: stdin leaves NO ARTEFACT TO AUDIT LATER. There is no file to
 * re-read to see who was provisioned. So the report this script prints — username, full name,
 * roles, whether a PIN is set, and created-or-already — IS THE AUDIT RECORD. Keep the transcript.
 * It carries no password and no PIN: `test/seed-staff.test.ts` drives a failing row whose password
 * is a sentinel and asserts BY EXECUTION that the sentinel reaches neither stdout nor stderr.
 *
 * WHAT IT DOES, all of it idempotent, so it belongs in the re-deploy path forever:
 *   1. reads the whole roster from stdin and validates it WHOLE with zod BEFORE the first write —
 *      a half-provisioned roster is worse than a refused one;
 *   2. refuses, loudly and before any write, on (a) an unknown role key, (b) a role `seed:roles`
 *      has not created on this deployment, (c) a deactivated username, (d) an existing username
 *      whose password differs from the roster's, and (e) an existing username whose PIN differs;
 *   3. creates each absent user through the shipped `createUser`, WITH its PIN when the roster
 *      carries one, and fills in a missing PIN on a user who already exists;
 *   4. `assignRole`s every named role at HOSPITAL scope, skipping any already held;
 *   5. re-reads what it wrote, counts holders per role, and states a readiness verdict in its last
 *      line rather than implying one.
 *
 * (d) IS A REFUSAL AND NOT AN OVERWRITE, AND THAT IS THE DECISION WITH TEETH. There is no
 * credential-reset flow in this system yet (booked into 11e with the screen that needs it), so a
 * silent overwrite would be the only way to lock a real user out of a live hospital, and nobody
 * would see it happen. A roster that changes a credential is either a typo or a deliberate reset,
 * and both deserve to be explicit.
 *
 * IT NEVER CALLS `grantPermissionToRole`, DELIBERATELY. Roles are ASSIGNED here and GRANTED by
 * `seed:roles`. One script mints authority, the other hands it to humans; a script that did both
 * would make "give Asha the cashier role" and "change what a cashier may do" the same command.
 *
 * Usage:
 *   cat roster.json | pnpm --filter @hmis/core seed:staff
 *
 * The roster is a JSON ARRAY:
 *   [
 *     { "username": "asha", "fullName": "Asha Verma",
 *       "password": "<at least 10 characters — kernel/auth/password-policy.ts>", "pin": "1234",
 *       "roles": ["front_office", "vitals_desk"] }
 *   ]
 *
 * Run `seed:roles` FIRST: a role this deployment has not created is a refusal here, because
 * assigning a role that does not exist is a foreign-key error dressed up as a provisioning step.
 */

/** Every role key some seed script in this tree can create. Imported, never re-listed (§2.54). */
export const KNOWN_ROLE_KEYS: readonly string[] = [
  ...new Set([
    ...ROLE_MODEL.map((r) => r.roleKey),
    ...GRANTED_BY_OTHER_SEEDS.map((g) => g.roleKey),
    ...OPD_ROLE_KEYS.map((r) => r.key),
  ]),
].sort();

/**
 * THE ROSTER SCHEMA. Every message below is a LITERAL WRITTEN HERE OR IN `password-policy.ts`,
 * never an interpolation of the offending value: GC3 forbids a password or a PIN reaching any log,
 * any error message or the report, and an error message is the easiest place in a program to leak
 * one by accident.
 *
 * `strictObject` is load-bearing rather than tidy. A misspelt `"pn"` under a permissive object
 * would be dropped in silence and the account would ship without the fast-switch PIN its operator
 * believed they had asked for — which is precisely the state §B-MEASURED found on the live box.
 */
export const ROSTER_ROW_SCHEMA = z.strictObject({
  // Lowercase by convention, and the convention is worth stating: `users_username_ux` is a
  // CASE-SENSITIVE unique index, so `Asha` and `asha` are two accounts, and the login failure that
  // produces is one nobody can debug from the screen.
  username: z
    .string({ error: "must be a string" })
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
      error:
        "must be 1-64 characters of a-z, 0-9, dot, underscore or hyphen, not starting with punctuation",
    }),
  fullName: z
    .string({ error: "must be a string" })
    .min(1, { error: "must not be empty — it is what the whole hospital sees beside the action" })
    .max(120, { error: "must be at most 120 characters" }),
  // PLAN 11e T2/D3 — THE APOLOGY IS GONE, AND SO IS THE PRIVATE FLOOR.
  //
  // What stood here was `min(8)` under a comment admitting it was "a seed-time floor, not an auth
  // policy", because in August 2026 this script was the ONLY thing in the system with an opinion
  // about password length. `kernel/auth/password-policy.ts` is now that opinion, owner-ruled, and
  // the FIVE other paths that set a credential apply the same one — four from 11e D3, plus
  // `seed:admin`'s `ADMIN_PASSWORD`, which 11f D1 added on 2026-08-24. The clauses that need the ROW
  // rather than the field — the username comparison, and the PIN's shape — are applied in the
  // row-level refinement below, which is also why these two are plain strings here: ONE place
  // decides, and it is not this file.
  password: z.string({ error: "must be a string" }),
  pin: z.string({ error: "must be a string" }).optional(),
  roles: z
    .array(z.string({ error: "must be a string" }).min(1, { error: "must not be empty" }), {
      error: "must be an array of role keys",
    })
    .min(1, {
      error:
        "must name at least one role — a user holding none can reach nothing, which is the defect this script exists to fix",
    }),
})
  /**
   * PLAN 11e T2 — the shared policy, applied to the ROW because two of its clauses need one.
   *
   * `path` is stated explicitly so the refusal still names `roster[0].password` rather than the
   * row: `formatPath` below turns zod's `[0].password` into that, and a refusal that named only
   * the row would tell the owner a roster is bad without saying which field of which person.
   *
   * NO VALUE IS EVER QUOTED (GC3). Every message comes from `password-policy.ts`, which speaks
   * about rules and never about credentials — the same discipline the refusal transcript keeps.
   */
  .superRefine((row, ctx) => {
    for (const problem of checkPassword(row.password, { username: row.username })) {
      ctx.addIssue({ code: "custom", path: ["password"], message: problem.message });
    }
    if (row.pin !== undefined) {
      for (const problem of checkPin(row.pin)) {
        ctx.addIssue({ code: "custom", path: ["pin"], message: problem.message });
      }
    }
  });

export const ROSTER_SCHEMA = z
  .array(ROSTER_ROW_SCHEMA, { error: "the roster must be a JSON array of staff rows" })
  .min(1, { error: "the roster must carry at least one row" });

export type StaffRow = z.infer<typeof ROSTER_ROW_SCHEMA>;
export type StaffRoster = z.infer<typeof ROSTER_SCHEMA>;

/**
 * A loud, structured refusal. Every reason is a string this file composed; no roster value other
 * than a username or a role key is ever placed in one.
 */
export class SeedStaffRefusal extends Error {
  readonly reasons: readonly string[];
  constructor(headline: string, reasons: readonly string[]) {
    super(headline);
    this.name = "SeedStaffRefusal";
    this.reasons = reasons;
  }
}

/** `[0].password` -> `roster[0].password`. Path segments are indices and key names, never values. */
function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "roster";
  return `roster${path
    .map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`))
    .join("")}`;
}

/**
 * Parses and validates the WHOLE roster before anything else happens. Throws `SeedStaffRefusal`
 * carrying every problem at once, so an operator fixes one file rather than running the script
 * five times.
 *
 * A JSON syntax error reports the BYTE LENGTH and nothing else. Node's own `JSON.parse` message
 * quotes a fragment of the offending input, and the offending input here is a credential roster.
 */
export function parseRoster(text: string): StaffRoster {
  if (text.trim() === "") {
    throw new SeedStaffRefusal("no roster on stdin", [
      "stdin was empty. The roster is piped in, never passed as an argument and never left on the box:",
      "  cat roster.json | pnpm --filter @hmis/core seed:staff",
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SeedStaffRefusal("stdin is not valid JSON", [
      `${Buffer.byteLength(text, "utf8")} byte(s) arrived on stdin and did not parse as JSON.`,
      "The parser's own message is withheld on purpose: it quotes a fragment of the input, and the input is a credential roster (GC3).",
    ]);
  }
  const parsed = ROSTER_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new SeedStaffRefusal(
      "the roster does not validate — NOTHING was written",
      parsed.error.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`),
    );
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of parsed.data) {
    if (seen.has(row.username)) duplicates.add(row.username);
    seen.add(row.username);
  }
  if (duplicates.size > 0) {
    throw new SeedStaffRefusal("the roster names the same person twice", [
      `duplicate username(s): ${[...duplicates].sort().join(", ")}. Which row's password would win ` +
        `is not a question this script will answer by guessing.`,
    ]);
  }
  return parsed.data;
}

export type StaffOutcome = {
  username: string;
  fullName: string;
  roles: string[];
  created: boolean;
  /** This run WROTE a PIN — at creation, or onto a user who had none. */
  pinSet: boolean;
  /** The user has a usable PIN after this run: the <2 s fast-switch is reachable for them. */
  hasPin: boolean;
  assigned: string[];
  already: string[];
};

export type SeedStaffReport = {
  rows: StaffOutcome[];
  created: number;
  withPin: number;
  roleHolders: { roleKey: string; holders: number }[];
  problems: string[];
  ready: boolean;
};

/** CREATED · updated (an existing user gained a role or a PIN) · already (nothing to do). */
export function outcomeStatus(outcome: StaffOutcome): "CREATED" | "updated" | "already" {
  if (outcome.created) return "CREATED";
  if (outcome.pinSet || outcome.assigned.length > 0) return "updated";
  return "already";
}

/**
 * Provisions the roster. Every refusal is raised in the PRE-FLIGHT below, before the first write,
 * and all of them are collected rather than thrown one at a time.
 *
 * Exported so the suite can drive it against a real database — Book rows V6, V7 and V8 are
 * assertions about what this function does to Postgres, not about what it returns.
 */
export async function seedStaff(db: Db, roster: StaffRoster): Promise<SeedStaffReport> {
  const wanted = [...new Set(roster.flatMap((r) => r.roles))].sort();
  const usernames = roster.map((r) => r.username);
  const problems: string[] = [];

  // ───────────────────────── PRE-FLIGHT — every refusal, before any write ─────────────────────
  const unknownRoles = wanted.filter((r) => !KNOWN_ROLE_KEYS.includes(r));
  if (unknownRoles.length > 0) {
    problems.push(
      `unknown role key(s): ${unknownRoles.join(", ")}. No seed script in this repository creates ` +
        `them, so nothing would ever grant them a permission and the holder would be provisioned ` +
        `into silence. The keys that exist are: ${KNOWN_ROLE_KEYS.join(", ")}.`,
    );
  }
  const existingRoleRows = await db.select({ key: roles.key }).from(roles);
  const existingRoles = new Set(existingRoleRows.map((r) => r.key));
  const uncreated = wanted.filter((r) => !unknownRoles.includes(r) && !existingRoles.has(r));
  if (uncreated.length > 0) {
    problems.push(
      `role(s) this deployment has not created: ${uncreated.join(", ")}. Run ` +
        `\`pnpm --filter @hmis/core seed:roles\` first — assigning a role that does not exist is a ` +
        `foreign-key error dressed up as a provisioning step.`,
    );
  }

  const existingUsers = await db
    .select({
      id: users.id,
      username: users.username,
      active: users.active,
      pinHash: users.pinHash,
    })
    .from(users)
    .where(inArray(users.username, usernames));
  const byUsername = new Map(existingUsers.map((u) => [u.username, u]));

  for (const row of roster) {
    const existing = byUsername.get(row.username);
    if (existing === undefined) continue;
    if (!existing.active) {
      problems.push(
        `"${row.username}" exists but is DEACTIVATED. Reactivating a retired account is a decision ` +
          `somebody has to take on purpose; this script will not take it by writing a password over it.`,
      );
      continue;
    }
    const ok = await verifyPassword(db, row.username, row.password);
    if (ok === null) {
      problems.push(
        `"${row.username}" exists and the roster's password is NOT the one on file. REFUSED, not ` +
          `overwritten: there is no credential-reset flow in this system yet, so an overwrite here ` +
          `is the one way to lock a real user out of a live hospital with nobody watching. If this ` +
          `is a typo, fix the roster; if it is a deliberate reset, it needs a decision and a record ` +
          `of who took it, not a silent seed.`,
      );
      continue;
    }
    if (
      row.pin !== undefined &&
      existing.pinHash !== null &&
      !(await verifyPin(db, existing.id, row.pin))
    ) {
      problems.push(
        `"${row.username}" already has a PIN and the roster's differs. REFUSED for the same reason ` +
          `as the password: a PIN is a credential, and this system has no reset flow to undo an ` +
          `overwrite with. Drop the \`pin\` field to leave the existing one alone.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new SeedStaffRefusal(
      `the roster was REFUSED — ${problems.length} problem(s), and NOTHING was written`,
      problems,
    );
  }

  // ───────────────────────── WRITES — the roster is known-good from here ──────────────────────
  const userIds = existingUsers.map((u) => u.id);
  const heldPairs = new Set<string>();
  if (userIds.length > 0) {
    const held = await db
      .select({
        userId: roleAssignments.userId,
        roleKey: roleAssignments.roleKey,
        scopeType: roleAssignments.scopeType,
      })
      .from(roleAssignments)
      .where(inArray(roleAssignments.userId, userIds));
    for (const h of held) {
      if (h.scopeType === "hospital") heldPairs.add(`${h.userId}|${h.roleKey}`);
    }
  }

  const outcomes: StaffOutcome[] = [];
  for (const row of roster) {
    const existing = byUsername.get(row.username);
    let userId: string;
    let created = false;
    let pinSet = false;
    let hasPin: boolean;
    if (existing === undefined) {
      // The PIN rides `createUser` rather than a follow-up `setPin`, so an account created from a
      // row that carried one can never end up without it because a second statement failed.
      ({ id: userId } = await createUser(db, {
        username: row.username,
        fullName: row.fullName,
        password: row.password,
        pin: row.pin,
      }));
      created = true;
      pinSet = row.pin !== undefined;
      hasPin = row.pin !== undefined;
    } else {
      userId = existing.id;
      if (row.pin !== undefined && existing.pinHash === null) {
        // Filling a GAP, never changing a credential: a differing PIN was refused in pre-flight.
        // `admin` on the live box is exactly this case — it has no PIN and cannot fast-switch.
        await setPin(db, userId, row.pin);
        pinSet = true;
      }
      hasPin = existing.pinHash !== null || pinSet;
    }

    const assigned: string[] = [];
    const already: string[] = [];
    for (const roleKey of [...new Set(row.roles)].sort()) {
      if (heldPairs.has(`${userId}|${roleKey}`)) {
        already.push(roleKey);
        continue;
      }
      await assignRole(db, { userId, roleKey, scopeType: "hospital" });
      heldPairs.add(`${userId}|${roleKey}`);
      assigned.push(roleKey);
    }

    outcomes.push({
      username: row.username,
      fullName: row.fullName,
      roles: [...new Set(row.roles)].sort(),
      created,
      pinSet,
      hasPin,
      assigned,
      already,
    });
  }

  // ───────────────────────── VERIFY — re-read what was written, then judge ────────────────────
  const verdictProblems: string[] = [];
  const finalUsers = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.username, usernames));
  const finalIds = new Map(finalUsers.map((u) => [u.username, u.id]));
  const absent = usernames.filter((u) => !finalIds.has(u));
  if (absent.length > 0) {
    verdictProblems.push(
      `user(s) absent after the run: ${absent.join(", ")} — the write did not land.`,
    );
  }

  const finalAssignments =
    finalUsers.length === 0
      ? []
      : await db
          .select({
            userId: roleAssignments.userId,
            roleKey: roleAssignments.roleKey,
            scopeType: roleAssignments.scopeType,
          })
          .from(roleAssignments)
          .where(inArray(roleAssignments.userId, [...finalIds.values()]));
  const finalPairs = new Set(
    finalAssignments
      .filter((a) => a.scopeType === "hospital")
      .map((a) => `${a.userId}|${a.roleKey}`),
  );
  const unheld: string[] = [];
  for (const outcome of outcomes) {
    const id = finalIds.get(outcome.username);
    if (id === undefined) continue;
    for (const roleKey of outcome.roles) {
      if (!finalPairs.has(`${id}|${roleKey}`)) unheld.push(`${outcome.username}/${roleKey}`);
    }
  }
  if (unheld.length > 0) {
    verdictProblems.push(`assignment(s) absent after the run: ${unheld.join(", ")}.`);
  }

  // A role whose key exists and whose permission set is EMPTY is MAJOR 4's exact shape: the
  // account looks provisioned, every route it needs answers 403, and nothing anywhere says so.
  const grantRows =
    wanted.length === 0
      ? []
      : await db
          .select({ roleKey: rolePermissions.roleKey })
          .from(rolePermissions)
          .where(inArray(rolePermissions.roleKey, wanted));
  const grantCounts = new Map<string, number>();
  for (const g of grantRows) grantCounts.set(g.roleKey, (grantCounts.get(g.roleKey) ?? 0) + 1);
  const empty = wanted.filter((r) => (grantCounts.get(r) ?? 0) === 0);
  if (empty.length > 0) {
    verdictProblems.push(
      `role(s) holding ZERO permissions: ${empty.join(", ")} — the people above hold a key that ` +
        `opens nothing, and every route it guards still answers 403 to them. Run ` +
        `\`pnpm --filter @hmis/core seed:roles\`.`,
    );
  }

  const roleHolders = wanted.map((roleKey) => ({
    roleKey,
    holders: new Set(
      finalAssignments
        .filter((a) => a.roleKey === roleKey && a.scopeType === "hospital")
        .map((a) => a.userId),
    ).size,
  }));

  return {
    rows: outcomes,
    created: outcomes.filter((o) => o.created).length,
    withPin: outcomes.filter((o) => o.hasPin).length,
    roleHolders,
    problems: verdictProblems,
    ready: verdictProblems.length === 0,
  };
}

/**
 * The transcript, and — because the roster arrived on stdin and was never written to this box —
 * THE AUDIT RECORD (D4). Returned as lines so its shape is testable and `main` prints it verbatim.
 * It carries no password and no PIN, and Book V9 asserts that by execution rather than by reading.
 */
export function formatReport(report: SeedStaffReport): string[] {
  const lines: string[] = [];
  const nameWidth = Math.max(8, ...report.rows.map((r) => r.username.length));
  const fullWidth = Math.max(9, ...report.rows.map((r) => r.fullName.length));
  lines.push(`roster: ${report.rows.length} row(s), validated WHOLE before the first write`);
  lines.push("");
  for (const row of report.rows) {
    lines.push(
      `  ${row.username.padEnd(nameWidth)}  ${row.fullName.padEnd(fullWidth)}  ` +
        `pin: ${row.hasPin ? "yes" : "no "}  ${outcomeStatus(row).padEnd(7)}  ${row.roles.join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    `${report.created} created · ${report.rows.length - report.created} already present · ` +
      `${report.withPin} of ${report.rows.length} can use the <2 s PIN fast-switch`,
  );
  lines.push(
    `role holders: ${report.roleHolders.map((r) => `${r.roleKey} ${r.holders}`).join(" · ")}`,
  );
  lines.push("");
  lines.push(
    "THIS TRANSCRIPT IS THE AUDIT RECORD. The roster arrived on stdin and nothing was written to " +
      "this box, so there is no file to re-read later to see who was provisioned (D4's stated cost).",
  );
  lines.push("");
  if (report.problems.length > 0) {
    lines.push("!! NOT READY".padEnd(72, " "));
    for (const problem of report.problems) lines.push(`!! ${problem}`);
    lines.push("");
    lines.push("The accounts above exist; what is named above is not done.");
  } else {
    lines.push(
      `READY: ${report.rows.length} account(s) exist, each holding every role the roster named at ` +
        `hospital scope, and every one of those roles carries permissions. They can log in now.`,
    );
  }
  return lines;
}

/** The refusal transcript. Loud, ordered, and carrying no credential. */
export function formatRefusal(refusal: SeedStaffRefusal): string[] {
  const lines: string[] = ["!! REFUSED".padEnd(72, " "), `!! ${refusal.message}`];
  for (const reason of refusal.reasons) lines.push(`!! ${reason}`);
  lines.push("");
  lines.push("Nothing was written. Fix the roster and pipe it in again.");
  return lines;
}

/**
 * Reads the roster text, prints, and returns the process exit code. `main` is a thin shell around
 * this so the suite can capture the REAL streams (`process.stdout` / `process.stderr`) rather than
 * assert on a return value — Book V9's requirement, and the only way to catch a leak that happens
 * on the way out.
 */
export async function runSeedStaff(db: Db, stdinText: string): Promise<number> {
  try {
    const roster = parseRoster(stdinText);
    const report = await seedStaff(db, roster);
    for (const line of formatReport(report)) console.log(line);
    return report.ready ? 0 : 1;
  } catch (error) {
    if (error instanceof SeedStaffRefusal) {
      for (const line of formatRefusal(error)) console.error(line);
      return 1;
    }
    throw error;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const text = await readStdin();
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    process.exitCode = await runSeedStaff(db, text);
  } finally {
    await pool.end();
  }
}

// Guarded so `test/seed-staff.test.ts` can import the schema and `seedStaff` without the script
// running itself on import. `tsx scripts/seed-staff.ts` still runs it: apps/core declares no
// `"type": "module"`, so this file is CommonJS and `require.main` is this module.
if (require.main === module) {
  main().catch((e) => {
    // Deliberately NOT the roster, and deliberately no value from it: an error path is the easiest
    // place in a program to leak a credential — Book V9's mutant is exactly this line printing the
    // row it was working on.
    console.error(e);
    process.exit(1);
  });
}
