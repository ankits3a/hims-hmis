import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAdmin, formatReport, formatRefusal, SeedAdminRefusal } from "../scripts/seed-admin";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { authManifest } from "../src/kernel/auth/manifest";
import { hasPermission } from "../src/kernel/auth/permissions";
import { verifyPassword } from "../src/kernel/auth/identity";
import { permissions, roleAssignments, rolePermissions, roles, users } from "../src/kernel/db/schema";
import { eq } from "drizzle-orm";
import type { ModuleManifest } from "../src/kernel/modules/manifest";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11e T5 — `seed:admin` reconciles, and MAJOR 1's residual is repaired.
 *
 * ═══ R13 IS THE DISCRIMINATING INPUT MAJOR 1's FIX COULD ONLY NAME ═══
 *
 * The defect: this script returned early on any deployment that already had an admin, AFTER
 * `syncPermissions` and BEFORE the grant loop. So a permission declared after first boot reached
 * the `permissions` CATALOG and was granted to nobody, and re-running the script — the documented
 * repair — printed "nothing to do". Plan 11d's addendum 5 made `seed:roles` DETECT that state.
 * Nothing in the tree could EXECUTE it, because `main()` read its registry from a hard-coded
 * import and there was no seam to hand a different one through.
 *
 * `seedAdmin(db, registry, input)` is that seam. Leg R13 below installs a SECOND manifest on the
 * second run — a permission that did not exist when the deployment was first seeded — and asserts
 * that the re-run grants it. That is the exact shape of what happened on production.
 */

/** A manifest that did not exist when the deployment was first seeded. */
const LATE_MANIFEST: ModuleManifest = {
  key: "late_module",
  title: "A module that shipped after go-live",
  menu: [],
  permissions: ["late_module.thing.do"],
  subscriptions: [],
};

const INPUT = { username: "admin", fullName: "The Administrator", password: "bootstrap-secret" };

describe("seed:admin — reconciles instead of returning early (11e T5, D4)", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const authOnly = (): ModuleRegistry => {
    const r = new ModuleRegistry();
    r.install(authManifest);
    return r;
  };
  const withLateModule = (): ModuleRegistry => {
    const r = authOnly();
    r.install(LATE_MANIFEST);
    return r;
  };
  const adminGrants = async (): Promise<string[]> => {
    const rows = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleKey, "admin"));
    return rows.map((r) => r.permission).sort();
  };

  it("a first run on an empty database creates everything and grants the whole manifest", async () => {
    const report = await seedAdmin(db, authOnly(), INPUT);
    expect({
      userCreated: report.userCreated, roleCreated: report.roleCreated,
      assignmentCreated: report.assignmentCreated, already: report.already,
    }).toEqual({ userCreated: true, roleCreated: true, assignmentCreated: true, already: [] });
    expect(report.granted).toEqual([...authManifest.permissions].sort());

    // The grants are REAL authority, not rows: asserted through `hasPermission`, the function the
    // guards actually call.
    expect(await hasPermission(db, report.userId, "auth.users.manage", "hospital")).toBe(true);
    expect(await verifyPassword(db, "admin", "bootstrap-secret")).toEqual({ userId: report.userId });
  });

  it("R13 — a permission declared AFTER first boot is granted by a re-run", async () => {
    // Run one: the deployment as it was seeded, before `late_module` existed.
    const first = await seedAdmin(db, authOnly(), INPUT);
    expect(first.userCreated).toBe(true);
    expect(await adminGrants()).toEqual([...authManifest.permissions].sort());
    // NON-VACUITY: the permission genuinely is not held yet, so the assertion below can fail.
    expect(await hasPermission(db, first.userId, "late_module.thing.do", "hospital")).toBe(false);

    // Run two: the SAME database, an admin that already exists, and one more declared permission.
    // This is the run that used to print "already exists — nothing to do".
    const second = await seedAdmin(db, withLateModule(), INPUT);

    expect(second.userCreated).toBe(false);          // the user is NOT recreated…
    expect(second.granted).toEqual(["late_module.thing.do"]); // …and the grant reconciles anyway
    expect(second.already).toEqual([...authManifest.permissions].sort());
    expect(await hasPermission(db, second.userId, "late_module.thing.do", "hospital")).toBe(true);
    expect(second.userId).toBe(first.userId);        // the same person, not a second admin
  });

  it("R14 — reconciliation grants; it never un-grants, and it never duplicates", async () => {
    const first = await seedAdmin(db, withLateModule(), INPUT);
    // A grant this script's registry does NOT declare, written by hand — standing in for
    // `seed:roles`, `seed:ops` or an owner's deliberate act.
    await db.insert(roles).values({ key: "cashier", title: "Cashier" });
    await db.insert(rolePermissions).values({ roleKey: "cashier", permission: "late_module.thing.do" });
    const before = await db.select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);

    // A SECOND run over exactly that state.
    const second = await seedAdmin(db, withLateModule(), INPUT);
    expect(second).toMatchObject({ userCreated: false, roleCreated: false, assignmentCreated: false, granted: [] });

    const after = await db.select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);
    // BY COUNT (§2.7), and by content: nothing added, nothing removed, the foreign grant intact.
    expect(after).toHaveLength(before.length);
    expect([...after].sort((a, b) => `${a.roleKey}${a.permission}`.localeCompare(`${b.roleKey}${b.permission}`)))
      .toEqual([...before].sort((a, b) => `${a.roleKey}${a.permission}`.localeCompare(`${b.roleKey}${b.permission}`)));
    expect(after.some((r) => r.roleKey === "cashier" && r.permission === "late_module.thing.do")).toBe(true);

    // …and no second role assignment, which `assignRole`'s fresh-id-per-call would otherwise stack
    // on every deploy for ever.
    const assignments = await db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, first.userId));
    expect(assignments).toHaveLength(1);
  });

  it("it never overwrites an existing admin's password — the silent-lockout rule seed:staff keeps", async () => {
    const first = await seedAdmin(db, authOnly(), INPUT);
    await seedAdmin(db, authOnly(), { ...INPUT, password: "somebody-typed-this-by-mistake" });
    // The ORIGINAL still works and the mistake does not. `createUser` is the one conditional left
    // in the script, and this is why.
    expect(await verifyPassword(db, "admin", "bootstrap-secret")).toEqual({ userId: first.userId });
    expect(await verifyPassword(db, "admin", "somebody-typed-this-by-mistake")).toBeNull();
  });

  it("the transcript states what it did, and says so when there was nothing new", async () => {
    await seedAdmin(db, authOnly(), INPUT);
    const second = await seedAdmin(db, authOnly(), INPUT);
    const lines = formatReport("admin", second).join("\n");
    expect(lines).toContain("already existed");
    expect(lines).toContain("nothing new to grant");
    expect(lines).toContain("no longer returns early");
    expect(lines).not.toContain("bootstrap-secret");
  });
});

describe("seed:admin — ADMIN_PASSWORD is judged by the shared policy (11f T1, D1)", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const authOnly = (): ModuleRegistry => {
    const r = new ModuleRegistry();
    r.install(authManifest);
    return r;
  };

  const rowCounts = async () => ({
    users: (await db.select({ id: users.id }).from(users)).length,
    roles: (await db.select({ key: roles.key }).from(roles)).length,
    grants: (await db.select({ permission: rolePermissions.permission }).from(rolePermissions)).length,
    catalog: (await db.select({ permission: permissions.permission }).from(permissions)).length,
  });

  const refusalOf = async (password: string): Promise<SeedAdminRefusal> => {
    const caught: unknown = await seedAdmin(db, authOnly(), { ...INPUT, password }).then(
      () => { throw new Error("seedAdmin RESOLVED — it did not refuse"); },
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(SeedAdminRefusal);
    return caught as SeedAdminRefusal;
  };

  it("R1 — a four-character ADMIN_PASSWORD is refused BEFORE ANY WRITE, naming the floor", async () => {
    const before = await rowCounts();
    expect(before).toEqual({ users: 0, roles: 0, grants: 0, catalog: 0 });

    const refusal = await refusalOf("abcd");
    expect(refusal.message).toMatch(/ADMIN_PASSWORD/);
    expect(refusal.reasons.join("\n")).toMatch(/at least 10 characters/);

    // BEFORE ANY WRITE, and this is the half a "refuse at step 4" implementation fails: the
    // catalog, the role and its grants would all be on disk by then.
    expect(await rowCounts()).toEqual(before);
  });

  it("R1 control — a compliant password seeds the admin, so the gate cannot pass by refusing everything", async () => {
    const report = await seedAdmin(db, authOnly(), { ...INPUT, password: "keel-haul-42" });
    expect(report.userCreated).toBe(true);
    expect(await verifyPassword(db, "admin", "keel-haul-42")).toEqual({ userId: report.userId });
  });

  it("R1 — the refusal is WHOLE, and no credential reaches any message", async () => {
    // "admin" breaks three clauses at once: too short, equal to the username, and on the top-20
    // list. A first-failure implementation reports one; the seed:staff pattern reports all three.
    const refusal = await refusalOf("admin");
    expect(refusal.reasons).toHaveLength(3);
    expect(refusal.reasons.join("\n")).toMatch(/at least 10 characters/);
    expect(refusal.reasons.join("\n")).toMatch(/must not be the username/);
    expect(refusal.reasons.join("\n")).toMatch(/twenty most-used passwords/);
    // GC3: the transcript the operator actually reads speaks about rules, never about the value.
    const transcript = formatRefusal(refusal).join("\n");
    expect(transcript).toMatch(/Nothing was written/);
    expect(transcript).not.toMatch(/"admin"/);
    expect(await rowCounts()).toEqual({ users: 0, roles: 0, grants: 0, catalog: 0 });
  });

  it("R2 — a reconcile-only re-run never evaluates the policy (Q2: the value is judged where it is USED)", async () => {
    const first = await seedAdmin(db, authOnly(), INPUT);
    expect(first.userCreated).toBe(true);

    // The same deployment, re-run with a stale, policy-violating ADMIN_PASSWORD in the environment.
    // An implementation that validated at env-read would refuse HERE — and would break exactly the
    // repair path 11e D4 built, on the deployment that needs it.
    const second = await seedAdmin(db, authOnly(), { ...INPUT, password: "abcd" });
    expect(second.userCreated).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.already).toEqual([...authManifest.permissions].sort());
    // …and the stale value did not become the admin's password either.
    expect(await verifyPassword(db, "admin", "bootstrap-secret")).toEqual({ userId: first.userId });
    expect(await verifyPassword(db, "admin", "abcd")).toBeNull();
  });
});
