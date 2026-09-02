import { inspect } from "node:util";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { Db } from "../src/kernel/db/client";
import { deactivateUser, verifyPassword, verifyPin } from "../src/kernel/auth/identity";
import { createRole } from "../src/kernel/auth/permissions";
import { GRANTED_BY_OTHER_SEEDS, ROLE_MODEL, seedRoles } from "../scripts/seed-roles";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import {
  KNOWN_ROLE_KEYS,
  SeedStaffRefusal,
  formatReport,
  outcomeStatus,
  parseRoster,
  runSeedStaff,
  seedStaff,
} from "../scripts/seed-staff";
import { roleAssignments, users } from "../src/kernel/db/schema";

/**
 * Plan 11d / D4, Book rows V6, V7, V8 and V9 — a deployment can be given its humans, from stdin,
 * with no credential left on the box.
 *
 * WHAT EACH LEG BUYS, because a seed test that has never been watched to fail is §2.22's "not a
 * pre-flight":
 *   V6  a roster row yields a WORKING password AND a WORKING PIN. The password leg is the control
 *       that isolates the PIN leg: §B-MEASURED found production's only user has `has_pin = f`, so
 *       the sub-2-second fast-switch Plan 02 built and perf-tested is unusable by anybody alive.
 *   V7  an unknown role key is a hard refusal BEFORE any write, and the half that matters is ZERO
 *       USERS CREATED — a half-provisioned roster is worse than a refused one, because the half
 *       that landed looks exactly like success.
 *   V8  an existing username whose password differs is REFUSED, never overwritten, and the
 *       ORIGINAL password still works afterwards. There is no credential-reset flow in this
 *       system, so an overwrite is the one way to lock a real user out of a live hospital with
 *       nobody watching.
 *   V9  no password and no PIN reaches stdout or stderr — asserted on the CAPTURED STREAMS, never
 *       on a return value, because a leak happens on the way OUT. The repository is PUBLIC and
 *       GC3 forbids a credential in any commit, any log, any error message and this report.
 *
 * §2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT. A stream capture that captured NOTHING agrees
 * that no sentinel appeared, for ever. Three things prevent it here: `captureStreams` renders
 * non-string console arguments with `util.inspect` (so an object argument is rendered with its
 * VALUES, exactly as Node's console renders it — `String(obj)` would give `[object Object]` and a
 * leak would hide behind it); every V9 leg asserts a KNOWN line of the real transcript is present
 * BEFORE it asserts the sentinel is absent; and the census block below pins the role vocabulary
 * and the schema's refusals before anything is compared.
 */

/** A password no other string in this repository contains, so a grep for it cannot be ambiguous. */
const SENTINEL_PASSWORD = "zq7-tumbrel-quokka-sentinel-41";
/**
 * The PIN sentinel. PLAN 11e T2 MADE IT NUMERIC: the shared policy (`kernel/auth/password-policy.ts`,
 * owner ruling 2026-08-23) is 4-6 DIGITS exactly, so the old `zq7-tumbrel-pin-41` is now a roster
 * this script refuses — and the two V9 legs below need a roster that PARSES, because what they
 * assert is what the script PRINTS.
 *
 * SIX DIGITS RATHER THAN FOUR, for the reason the old comment gave: a four-digit run could appear
 * by coincidence and make an absence assertion ambiguous. This one cannot. `formatReport` prints
 * usernames, full names, role keys, single-digit counts and fixed prose — no id and no timestamp
 * — so there is nothing in the transcript a six-digit sequence could collide with.
 */
const SENTINEL_PIN = "417293";

type Captured = { out: string; err: string; code: number };

/**
 * Captures what the script actually EMITS. Both the raw streams and the four console methods are
 * intercepted: jest installs its own buffering `console` that does not write through
 * `process.stdout`, so intercepting only the streams would capture nothing at all and every
 * absence assertion below would pass vacuously (§2.49).
 *
 * Non-string arguments go through `util.inspect`, which is what Node's own console does. This is
 * load-bearing: V9's killing mutant logs the roster ROW, an object, and `String(row)` would render
 * it `[object Object]` — the leak would survive the very assertion written to catch it.
 */
async function captureStreams(fn: () => Promise<number>): Promise<Captured> {
  let out = "";
  let err = "";
  const render = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: null }))).join(" ") + "\n";

  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const realLog = console.log;
  const realInfo = console.info;
  const realWarn = console.warn;
  const realError = console.error;

  process.stdout.write = ((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    out += render(args);
  };
  console.info = (...args: unknown[]) => {
    out += render(args);
  };
  console.warn = (...args: unknown[]) => {
    err += render(args);
  };
  console.error = (...args: unknown[]) => {
    err += render(args);
  };

  try {
    const code = await fn();
    return { out, err, code };
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    console.log = realLog;
    console.info = realInfo;
    console.warn = realWarn;
    console.error = realError;
  }
}

/** A roster row, built here so no test invents its own shape. */
function row(
  username: string,
  fullName: string,
  password: string,
  roles: string[],
  pin?: string,
): Record<string, unknown> {
  return pin === undefined
    ? { username, fullName, password, roles }
    : { username, fullName, password, pin, roles };
}

describe("seed:staff — the census, stated before anything is compared (§2.49)", () => {
  it("KNOWN_ROLE_KEYS is the thirty-seven keys some seed script in this tree can create", () => {
    expect(KNOWN_ROLE_KEYS).toEqual([
      "admin",
      // PLAN 15 / DD14, 2026-08-28 — the six OT roles arrive for FREE by the same derivation, and
      // the consequence is the same one the materials note below describes, one phase sharper:
      // `seed:staff` REFUSES a roster naming a key outside this list, so until it carried these
      // six, the roster that hires the day-care unit's first recovery nurse — the person the whole
      // escort-gated discharge depends on — would have been rejected as a typo, with the whole
      // roster refused rather than half-provisioned. THIS FILE IS NOT IN PLAN 15 T2's FILES LIST
      // (finding T2-f); the census is pinned here and the task that moves it must say so.
      "anaesthetist",
      "billing_manager",
      "biomedical_engineer",
      "cashier",
      "daycare_coordinator",
      "display",
      "doctor",
      "duty_manager",
      "front_office",
      "front_office_supervisor",
      // PLAN 17 T2 / DD16, 2026-08-29 — the LAB's four, arriving by the same DERIVATION as the six
      // OT roles above and landing in four different places in this sorted list rather than
      // together, which is precisely why the count at the foot is the assertion that catches a
      // miss. `seed:staff` REFUSES a roster naming a key outside this list, so until it carried
      // these four, the roster that hires the hospital's first phlebotomist — the person the whole
      // collection queue depends on — would have been rejected as a typo, with the WHOLE roster
      // refused rather than half-provisioned. THIS FILE IS NOT IN PLAN 17 T2's FILES LIST as the
      // phase document wrote it; the census is pinned here and the task that moves it says so.
      "lab_reception",
      "lab_technician",
      // PLAN 14 / DD11, 2026-08-27 — the two stores roles. They arrive here for FREE, because
      // `KNOWN_ROLE_KEYS` is DERIVED from `ROLE_MODEL ∪ GRANTED_BY_OTHER_SEEDS ∪ OPD_ROLE_KEYS`
      // rather than hand-listed; what this array pins is that somebody NOTICED the vocabulary grew.
      // The consequence is real and not bookkeeping: `seed:staff` refuses a roster naming a key
      // outside this list, so until it carried these two, a roster hiring the hospital's first
      // storekeeper would have been rejected as a typo.
      "materials_head",
      "medical_superintendent",
      "membership_admin",
      "modality_bridge", // PLAN 18b T1 — the machine account that pulls the modality worklist
      "mrd_officer",
      "nurse",
      "opd_admin",
      "ot_incharge",
      "ot_nurse",
      "owner",
      // PLAN 17 T2 / DD16 — see the lab note above; `pathologist` and `phlebotomist` sort here.
      "pathologist",
      // PLAN 18a T2, 2026-08-30 — the four radiology roles, and they arrive here for FREE because
      // `KNOWN_ROLE_KEYS` is DERIVED from `ROLE_MODEL ∪ GRANTED_BY_OTHER_SEEDS ∪ OPD_ROLE_KEYS`
      // rather than hand-listed. What this array pins is that somebody NOTICED the vocabulary grew.
      // The consequence is real: `seed:staff` REFUSES a roster naming a key outside this list, so
      // until it carried these four, the roster hiring the hospital's first radiographer — without
      // whom no scan is acquired at all — would have been rejected as a typo and the WHOLE roster
      // refused rather than half-provisioned. **THIS FILE IS NOT IN 18a T2's FILES LIST** (finding
      // F11, the fourth census file in that finding); the census is pinned here and the task that
      // moves it says so.
      "pcpndt_incharge",
      "pharmacy",
      "pharmacy_assistant", // PLAN 16c T1 — the dispensing aide
      "phlebotomist",
      "radiographer",
      "radiologist",
      "radiology_receptionist",
      "recovery_nurse",
      // OWNER RULING 2026-08-29 (Plan 07c T9 / DD14) — `staff_auditor` joins by DERIVATION: this
      // list is `ROLE_MODEL ∪ GRANTED_BY_OTHER_SEEDS ∪ OPD_ROLE_KEYS`, sorted, so a new model role
      // arrives here for free and this census is where it announces itself. It is the FIFTH place a
      // role registration has to be admitted, and the one a file-scoped grep missed.
      "staff_auditor",
      "storekeeper",
      "surgeon",
      // Group A, 2026-08-26 — three roles for permissions that had guarded live routes with no
      // holder at all. This list is DERIVED (ROLE_MODEL ∪ GRANTED_BY_OTHER_SEEDS ∪ OPD_ROLE_KEYS),
      // so it grew on its own; what is pinned here is that somebody noticed.
      "tariff_editor",
      "vitals_desk",
    ]);
    // Derived from the three shipped constants rather than re-listed: a fourth copy of "the role
    // keys" is exactly the drift D2 exists to close (§2.54).
    for (const r of ROLE_MODEL) expect(KNOWN_ROLE_KEYS).toContain(r.roleKey);
    for (const g of GRANTED_BY_OTHER_SEEDS) expect(KNOWN_ROLE_KEYS).toContain(g.roleKey);
    for (const o of OPD_ROLE_KEYS) expect(KNOWN_ROLE_KEYS).toContain(o.key);
    expect(KNOWN_ROLE_KEYS).toHaveLength(37); // 16c T1 — 36 -> 37 with `pharmacy_assistant`; 18b T1 — 35 -> 36 with `modality_bridge`; PLAN 18a T2 — 31 -> 35 with radiology's four
  });

  it("the vocabulary is WIDER than what seed:roles creates, which is what makes two refusals distinct", () => {
    // `nurse` is a real key (seed:opd creates it) that `seed:roles` does NOT create. A roster
    // naming it is refused for a DIFFERENT reason than a roster naming `cashierr`, and an
    // operator needs to be told which of the two happened.
    const seededByRoles = ROLE_MODEL.map((r) => r.roleKey);
    expect(seededByRoles).not.toContain("nurse");
    expect(KNOWN_ROLE_KEYS).toContain("nurse");
  });

  it("the roster schema refuses every shape it must, and NAMES the field without quoting it", () => {
    const good = row("asha", "Asha Verma", "a-good-password", ["front_office"], "4321");
    const cases: { label: string; input: unknown; expectPath: string }[] = [
      { label: "not an array", input: { staff: [good] }, expectPath: "roster" },
      { label: "empty array", input: [], expectPath: "roster" },
      {
        label: "an unrecognised key — a misspelt `pn` must never be dropped in silence",
        input: [{ ...good, pn: "4321" }],
        expectPath: "roster[0]",
      },
      { label: "no password", input: [row("asha", "Asha Verma", "", ["front_office"])], expectPath: "roster[0].password" },
      {
        label: "a password below the seed-time floor",
        input: [row("asha", "Asha Verma", "short", ["front_office"])],
        expectPath: "roster[0].password",
      },
      {
        // PLAN 11e T2 / R4 — the floor is the SHARED POLICY's now (owner ruling 2026-08-23), not
        // this script's own `min(8)`. NINE characters is the discriminating input: it cleared the
        // old floor and does not clear this one.
        label: "a nine-character password — one short of the shared policy's floor",
        input: [row("asha", "Asha Verma", "nine-char", ["front_office"])],
        expectPath: "roster[0].password",
      },
      {
        label: "a PIN the fast-switch surface would refuse",
        input: [row("asha", "Asha Verma", "a-good-password", ["front_office"], "12")],
        expectPath: "roster[0].pin",
      },
      {
        label: "an uppercase username, against a case-sensitive unique index",
        input: [row("Asha", "Asha Verma", "a-good-password", ["front_office"])],
        expectPath: "roster[0].username",
      },
      { label: "no roles", input: [row("asha", "Asha Verma", "a-good-password", [])], expectPath: "roster[0].roles" },
      {
        label: "a non-string password",
        input: [{ username: "asha", fullName: "Asha Verma", password: 12345678, roles: ["front_office"] }],
        expectPath: "roster[0].password",
      },
    ];
    for (const { label, input, expectPath } of cases) {
      let refusal: SeedStaffRefusal | undefined;
      try {
        parseRoster(JSON.stringify(input));
      } catch (e) {
        refusal = e instanceof SeedStaffRefusal ? e : undefined;
      }
      expect([label, refusal?.name]).toEqual([label, "SeedStaffRefusal"]);
      expect([label, refusal?.reasons.some((r) => r.startsWith(expectPath))]).toEqual([label, true]);
    }
  });

  it("R4 — the roster's floor is the SHARED policy: nine refused, ten accepted, username refused", () => {
    // The other half of R4's per-path coverage. `seed:staff` is the fifth path that sets a
    // credential, and before 11e T2 it was the only one with a floor at all — its own, at eight.
    const refusalFor = (input: unknown): readonly string[] => {
      try {
        parseRoster(JSON.stringify(input));
        return [];
      } catch (e) {
        return e instanceof SeedStaffRefusal ? e.reasons : ["not a SeedStaffRefusal"];
      }
    };

    // TEN IS ACCEPTED — the control. Without it a schema that refused every password would pass
    // the two refusal legs below and this test would prove nothing.
    expect(refusalFor([row("asha", "Asha Verma", "abcdefghij", ["front_office"], "4321")])).toEqual([]);

    expect(refusalFor([row("asha", "Asha Verma", "abcdefghi", ["front_office"])]).join("\n"))
      .toContain("roster[0].password");
    // The username clause needs the ROW, which is why the policy is applied at row level here.
    expect(refusalFor([row("receptionist", "Recep Tionist", "receptionist", ["front_office"])]).join("\n"))
      .toContain("roster[0].password");
    // …and the PIN clause: 4-6 DIGITS, so the old "any four characters" PIN is now refused.
    expect(refusalFor([row("asha", "Asha Verma", "abcdefghij", ["front_office"], "abcd")]).join("\n"))
      .toContain("roster[0].pin");
    expect(refusalFor([row("asha", "Asha Verma", "abcdefghij", ["front_office"], "1234567")]).join("\n"))
      .toContain("roster[0].pin");

    // NO CREDENTIAL IN ANY OF IT (GC3), asserted rather than assumed — these messages now come
    // from `password-policy.ts` rather than from this file, so the discipline had to travel.
    const leaked = refusalFor([row("asha", "Asha Verma", "abcdefghi", ["front_office"], "abcd")]);
    for (const reason of leaked) {
      expect(reason).not.toContain("abcdefghi");
      expect(reason).not.toContain("abcd");
    }
  });

  it("the same person named twice is refused — which row's password would win is not a guess", () => {
    const twice = [
      row("asha", "Asha Verma", "a-good-password", ["front_office"]),
      row("asha", "Asha V", "a-different-password", ["cashier"]),
    ];
    expect(() => parseRoster(JSON.stringify(twice))).toThrow(/names the same person twice/);
  });

  it("V9: a JSON syntax error withholds the parser's own message, which quotes the input", () => {
    // Node's `JSON.parse` message embeds a fragment of the offending text, and the offending text
    // here is a credential roster. The refusal reports the BYTE LENGTH and nothing else.
    const truncated = `[{"username":"asha","password":"${SENTINEL_PASSWORD}"`;
    let refusal: SeedStaffRefusal | undefined;
    try {
      parseRoster(truncated);
    } catch (e) {
      refusal = e instanceof SeedStaffRefusal ? e : undefined;
    }
    expect(refusal?.name).toBe("SeedStaffRefusal");
    // Non-vacuity first: the refusal really did fire and really does carry text.
    expect(refusal?.reasons.join("\n")).toContain("did not parse as JSON");
    expect(`${refusal?.message}\n${refusal?.reasons.join("\n")}`).not.toContain(SENTINEL_PASSWORD);
  });

  it("an empty stdin is a refusal that names the pipe, not a silent no-op", () => {
    expect(() => parseRoster("   \n ")).toThrow(/no roster on stdin/);
  });
});

describe("seed:staff — executed against a database (V6, V7, V8, V9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll(db);
    // `seed:staff` ASSIGNS roles; `seed:roles` GRANTS them. Running the real thing rather than
    // inserting rows by hand also proves the two scripts compose in the order the runbook states.
    await seedRoles(db);
  });
  afterAll(async () => {
    await teardown();
  });

  async function usernamesInDb(): Promise<string[]> {
    const rows = await db.select({ username: users.username }).from(users);
    return rows.map((r) => r.username).sort();
  }

  it("V6: a roster row yields a WORKING password and a WORKING PIN", async () => {
    const roster = parseRoster(
      JSON.stringify([
        row("asha", "Asha Verma", "asha-good-password", ["front_office", "vitals_desk"], "4321"),
      ]),
    );
    const report = await seedStaff(db, roster);
    expect(report.rows.map((r) => outcomeStatus(r))).toEqual(["CREATED"]);

    // The password leg is the CONTROL: it isolates the PIN leg rather than the row. A mutant that
    // drops the pin from `createUser` leaves this green and the next assertion red.
    const ok = await verifyPassword(db, "asha", "asha-good-password");
    expect(ok).not.toBeNull();
    const userId = ok?.userId ?? "";
    expect(await verifyPin(db, userId, "4321")).toBe(true);

    // And the roles landed at hospital scope, which is the only scope this script writes.
    const assignments = await db
      .select({ roleKey: roleAssignments.roleKey, scopeType: roleAssignments.scopeType })
      .from(roleAssignments);
    expect(assignments.map((a) => `${a.roleKey}@${a.scopeType}`).sort()).toEqual([
      "front_office@hospital",
      "vitals_desk@hospital",
    ]);
    expect(report.withPin).toBe(1);
  });

  it("V6: a row WITHOUT a pin creates a user who simply cannot fast-switch, and the report says so", async () => {
    const roster = parseRoster(
      JSON.stringify([row("ravi", "Ravi Kumar", "ravi-good-password", ["cashier"])]),
    );
    const report = await seedStaff(db, roster);
    const ok = await verifyPassword(db, "ravi", "ravi-good-password");
    expect(ok).not.toBeNull();
    expect(await verifyPin(db, ok?.userId ?? "", "4321")).toBe(false);
    expect(report.withPin).toBe(0);
    expect(formatReport(report).join("\n")).toContain("0 of 1 can use the <2 s PIN fast-switch");
  });

  it("V7: an unknown role key refuses the WHOLE roster before any write — zero users created", async () => {
    const roster = [
      row("asha", "Asha Verma", "asha-good-password", ["front_office"], "4321"),
      row("ravi", "Ravi Kumar", "ravi-good-password", ["cashierr"]),
    ];
    const { err, code } = await captureStreams(() => runSeedStaff(db, JSON.stringify(roster)));

    // THE HALF THAT MATTERS. One row was perfectly good and it was still not written: a
    // half-provisioned roster is worse than a refused one, because the half that landed looks
    // exactly like success.
    expect(await usernamesInDb()).toEqual([]);
    expect(code).toBe(1);
    expect(err).toContain("unknown role key(s): cashierr");
    expect(err).toContain("NOTHING was written");
  });

  it("a role seed:roles has not created is a DIFFERENT refusal, and it names the fix", async () => {
    // `nurse` is a real key that `seed:opd` creates. On a deployment where it has not been
    // created, assigning it is a foreign-key error dressed up as a provisioning step.
    const roster = [row("nita", "Nita Rao", "nita-good-password", ["nurse"])];
    const { err, code } = await captureStreams(() => runSeedStaff(db, JSON.stringify(roster)));
    expect(await usernamesInDb()).toEqual([]);
    expect(code).toBe(1);
    expect(err).toContain("role(s) this deployment has not created: nurse");
    expect(err).toContain("seed:roles");
  });

  it("V8: an existing username with a DIFFERENT password is refused, and the ORIGINAL still works", async () => {
    const original = "asha-original-password";
    const replacement = "asha-replacement-password";
    await seedStaff(
      db,
      parseRoster(JSON.stringify([row("asha", "Asha Verma", original, ["front_office"], "4321")])),
    );

    const { err, code } = await captureStreams(() =>
      runSeedStaff(db, JSON.stringify([row("asha", "Asha Verma", replacement, ["front_office"])])),
    );

    // THE ASSERTION WITH TEETH. A mutant that makes the update unconditional locks a live user out
    // of a running hospital, and this is the line that sees it happen.
    expect(await verifyPassword(db, "asha", original)).not.toBeNull();
    expect(await verifyPassword(db, "asha", replacement)).toBeNull();
    expect(code).toBe(1);
    expect(err).toContain("is NOT the one on file");
    expect(err).toContain("REFUSED, not");
  });

  it("V8: an existing PIN that differs is refused for the same reason; an ABSENT one is filled in", async () => {
    await seedStaff(
      db,
      parseRoster(JSON.stringify([row("asha", "Asha Verma", "asha-good-password", ["front_office"])])),
    );
    const before = await verifyPassword(db, "asha", "asha-good-password");
    expect(await verifyPin(db, before?.userId ?? "", "4321")).toBe(false);

    // Filling a GAP: `admin` on the live box is exactly this case (§B-MEASURED, `has_pin = f`).
    const filled = await seedStaff(
      db,
      parseRoster(
        JSON.stringify([row("asha", "Asha Verma", "asha-good-password", ["front_office"], "4321")]),
      ),
    );
    expect(filled.rows.map((r) => outcomeStatus(r))).toEqual(["updated"]);
    expect(await verifyPin(db, before?.userId ?? "", "4321")).toBe(true);

    // Changing one: refused, and the PIN on file is untouched.
    const { err, code } = await captureStreams(() =>
      runSeedStaff(
        db,
        JSON.stringify([row("asha", "Asha Verma", "asha-good-password", ["front_office"], "9876")]),
      ),
    );
    expect(await verifyPin(db, before?.userId ?? "", "4321")).toBe(true);
    expect(await verifyPin(db, before?.userId ?? "", "9876")).toBe(false);
    expect(code).toBe(1);
    expect(err).toContain("already has a PIN and the roster's differs");
  });

  it("a DEACTIVATED username is refused rather than quietly revived by a password write", async () => {
    await seedStaff(
      db,
      parseRoster(JSON.stringify([row("asha", "Asha Verma", "asha-good-password", ["front_office"])])),
    );
    const ok = await verifyPassword(db, "asha", "asha-good-password");
    await deactivateUser(db, ok?.userId ?? "");

    const { err, code } = await captureStreams(() =>
      runSeedStaff(db, JSON.stringify([row("asha", "Asha Verma", "asha-good-password", ["front_office"])])),
    );
    expect(code).toBe(1);
    expect(err).toContain("is DEACTIVATED");
  });

  it("V9: no password and no PIN reaches stdout or stderr — asserted on the CAPTURED STREAMS", async () => {
    const roster = [
      row("asha", "Asha Verma", "asha-good-password", ["front_office"], "4321"),
      row("ravi", "Ravi Kumar", SENTINEL_PASSWORD, ["cashierr"], SENTINEL_PIN),
    ];
    const { out, err, code } = await captureStreams(() => runSeedStaff(db, JSON.stringify(roster)));

    // NON-VACUITY FIRST. A capture that captured nothing agrees no sentinel appeared, for ever —
    // and this leg is not hypothetical: against the naive first draft that produced this task's
    // fail-first red, `err` came back "" and THIS assertion is the one that caught it.
    // `cashierr` is a value carried in by THIS roster, so its presence proves the capture reflects
    // this run rather than some earlier one. (The refusal names the role KEY and not the row's
    // username, because the unknown-key check is taken over the whole roster at once.)
    expect(code).toBe(1);
    expect(err).toContain("!! REFUSED");
    expect(err).toContain("cashierr");
    expect(err.length).toBeGreaterThan(200);

    expect(out).not.toContain(SENTINEL_PASSWORD);
    expect(err).not.toContain(SENTINEL_PASSWORD);
    expect(out).not.toContain(SENTINEL_PIN);
    expect(err).not.toContain(SENTINEL_PIN);
  });

  it("V9: the SUCCESSFUL transcript is the audit record, and it carries no credential either", async () => {
    const roster = [
      row("asha", "Asha Verma", SENTINEL_PASSWORD, ["front_office", "vitals_desk"], SENTINEL_PIN),
      row("ravi", "Ravi Kumar", "ravi-good-password", ["cashier"]),
    ];
    const { out, err, code } = await captureStreams(() => runSeedStaff(db, JSON.stringify(roster)));

    expect(code).toBe(0);
    // Non-vacuity: the report really was printed, with every field D4 requires of it.
    expect(out).toContain("asha");
    expect(out).toContain("Asha Verma");
    expect(out).toContain("front_office, vitals_desk");
    expect(out).toContain("pin: yes");
    expect(out).toContain("pin: no");
    expect(out).toContain("CREATED");
    expect(out).toContain("THIS TRANSCRIPT IS THE AUDIT RECORD");
    expect(out).toContain("READY:");

    expect(out).not.toContain(SENTINEL_PASSWORD);
    expect(err).not.toContain(SENTINEL_PASSWORD);
    expect(out).not.toContain(SENTINEL_PIN);
    expect(err).not.toContain(SENTINEL_PIN);
  });

  it("is idempotent — the second run reports `already`, assigns nothing, and exits 0", async () => {
    const roster = JSON.stringify([
      row("asha", "Asha Verma", "asha-good-password", ["front_office", "vitals_desk"], "4321"),
      row("ravi", "Ravi Kumar", "ravi-good-password", ["cashier"], "8765"),
      row("meera", "Meera Iyer", "meera-good-password", ["billing_manager"]),
    ]);

    const first = await captureStreams(() => runSeedStaff(db, roster));
    expect(first.code).toBe(0);
    expect(first.out).toContain("3 created · 0 already present · 2 of 3 can use the <2 s PIN fast-switch");

    const second = await captureStreams(() => runSeedStaff(db, roster));
    expect(second.code).toBe(0);
    expect(second.out).toContain("0 created · 3 already present");

    const report = await seedStaff(db, parseRoster(roster));
    expect(report.rows.map((r) => outcomeStatus(r))).toEqual(["already", "already", "already"]);
    expect(report.rows.every((r) => r.assigned.length === 0)).toBe(true);
    expect(report.ready).toBe(true);

    // Three runs, four assignments — the roles were assigned once, not once per run.
    const assignments = await db.select({ roleKey: roleAssignments.roleKey }).from(roleAssignments);
    expect(assignments.map((a) => a.roleKey).sort()).toEqual([
      "billing_manager",
      "cashier",
      "front_office",
      "vitals_desk",
    ]);
    expect(await usernamesInDb()).toEqual(["asha", "meera", "ravi"]);
  });

  it("a role that exists but GRANTS NOTHING is MAJOR 4's shape, and the verdict names it", async () => {
    // `seed:opd` creates role KEYS and grants nothing — the exact drift that produced MAJOR 4.
    // The accounts are still created (this is a post-write verdict, not a refusal), but the last
    // line must say the key opens nothing rather than implying readiness.
    await createRole(db, "nurse", "Nurse");
    const { out, code } = await captureStreams(() =>
      runSeedStaff(db, JSON.stringify([row("nita", "Nita Rao", "nita-good-password", ["nurse"])])),
    );
    expect(await usernamesInDb()).toEqual(["nita"]);
    expect(code).toBe(1);
    expect(out).toContain("!! NOT READY");
    expect(out).toContain("role(s) holding ZERO permissions: nurse");
  });
});
