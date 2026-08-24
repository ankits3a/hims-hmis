import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import {
  syncPermissions, createRole, grantPermissionToRole, assignRole, hasPermission, effectivePermissions,
} from "./permissions";
import { authManifest } from "./manifest";
import { ModuleRegistry } from "../modules/loader";
import { tempRoleGrants } from "../db/schema";
import { newId } from "@hmis/contracts";
import type { Db } from "../db/client";

function freshRegistry(): ModuleRegistry {
  const r = new ModuleRegistry();
  r.install(authManifest);
  return r;
}

describe("permissions", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("syncPermissions mirrors the registry and is idempotent", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await syncPermissions(db, registry); // second run must not throw
  });

  it("rejects granting a permission the registry does not declare", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await createRole(db, "admin", "Administrator");
    await expect(
      grantPermissionToRole(db, registry, "admin", "billing.refund.approve"),
    ).rejects.toThrow(/module manifests/);
  });

  it("hospital scope satisfies every required scope", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "a", fullName: "A", password: "p1234567" });
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "admin", scopeType: "hospital" });
    expect(await hasPermission(db, userId, "auth.users.manage", "hospital")).toBe(true);
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "cardio" })).toBe(true);
    expect(await hasPermission(db, userId, "auth.roles.manage", "hospital")).toBe(false); // not granted
  });

  it("department scope satisfies only its own department", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "b", fullName: "B", password: "p1234567" });
    await createRole(db, "dept-admin", "Dept Admin");
    await grantPermissionToRole(db, registry, "dept-admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "dept-admin", scopeType: "department", scopeId: "cardio" });
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "cardio" })).toBe(true);
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "ortho" })).toBe(false);
    expect(await hasPermission(db, userId, "auth.users.manage", "hospital")).toBe(false); // no upward inference
    expect(await hasPermission(db, userId, "auth.users.manage", "department")).toBe(false); // no ctx id
  });

  it("active temp grants confer the role at hospital scope; expired ones do not", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "c", fullName: "C", password: "p1234567" });
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
    await db.insert(tempRoleGrants).values({
      id: newId(), userId, roleKey: "reviewer", grantedBy: "seed", kind: "granted",
      reason: "test", expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await hasPermission(db, userId, "auth.break_glass.review", "hospital")).toBe(true);
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
    const { id: u2 } = await createUser(db, { username: "d", fullName: "D", password: "p1234567" });
    await db.insert(tempRoleGrants).values({
      id: newId(), userId: u2, roleKey: "reviewer", grantedBy: "seed", kind: "granted",
      reason: "test", expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await hasPermission(db, u2, "auth.break_glass.review", "hospital")).toBe(false);
  });
});

describe("effectivePermissions (Plan 11h T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const DEPT = "dept-paeds";

  async function seedRole(registry: ModuleRegistry, roleKey: string, permissions: string[]): Promise<void> {
    await createRole(db, roleKey, roleKey);
    for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
  }

  it("a hospital-scoped role puts every one of its permissions in `hospital`", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await seedRole(registry, "admin", ["auth.users.manage", "auth.roles.manage"]);
    const { id: userId } = await createUser(db, { username: "a", fullName: "A", password: "p1234567" });
    await assignRole(db, { userId, roleKey: "admin", scopeType: "hospital" });

    const eff = await effectivePermissions(db, userId);

    expect(eff.hospital).toEqual(["auth.roles.manage", "auth.users.manage"]);
    expect(eff.scoped).toEqual({ department: {}, floor: {} });
  });

  it("A DEPARTMENT-SCOPED ROLE GRANTS NOTHING AT HOSPITAL SCOPE — the projection is not a flat role join", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await seedRole(registry, "ward", ["auth.break_glass.use"]);
    const { id: userId } = await createUser(db, { username: "b", fullName: "B", password: "p1234567" });
    await assignRole(db, { userId, roleKey: "ward", scopeType: "department", scopeId: DEPT });

    const eff = await effectivePermissions(db, userId);

    // The whole assertion: the permission EXISTS for this user, and it is NOT a hospital-scope
    // permission. A flat `role_permissions` join would have put it in `hospital` and the shell
    // would render a control the server refuses.
    expect(eff.hospital).toEqual([]);
    expect(eff.scoped.department[DEPT]).toEqual(["auth.break_glass.use"]);
    expect(await hasPermission(db, userId, "auth.break_glass.use", "hospital")).toBe(false);
    expect(await hasPermission(db, userId, "auth.break_glass.use", "department", { departmentId: DEPT })).toBe(true);
  });

  it("AGREES WITH hasPermission FOR EVERY DECLARED PERMISSION — the only thing keeping the two reads from drifting", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await seedRole(registry, "mixed_hospital", ["auth.users.manage", "auth.agents.manage"]);
    await seedRole(registry, "mixed_dept", ["auth.break_glass.use", "auth.temp_role.grant"]);
    const { id: userId } = await createUser(db, { username: "c", fullName: "C", password: "p1234567" });
    await assignRole(db, { userId, roleKey: "mixed_hospital", scopeType: "hospital" });
    await assignRole(db, { userId, roleKey: "mixed_dept", scopeType: "department", scopeId: DEPT });

    const eff = await effectivePermissions(db, userId);

    for (const permission of registry.allPermissions()) {
      expect({ permission, held: eff.hospital.includes(permission) }).toEqual({
        permission,
        held: await hasPermission(db, userId, permission, "hospital"),
      });
    }
  });

  it("a live temp grant acts at hospital scope; an expired one is invisible", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await seedRole(registry, "reviewer", ["auth.break_glass.review"]);
    const { id: live } = await createUser(db, { username: "d", fullName: "D", password: "p1234567" });
    const { id: dead } = await createUser(db, { username: "e", fullName: "E", password: "p1234567" });
    await db.insert(tempRoleGrants).values([
      { id: newId(), userId: live, roleKey: "reviewer", grantedBy: "seed", kind: "granted", reason: "t", expiresAt: new Date(Date.now() + 60_000) },
      { id: newId(), userId: dead, roleKey: "reviewer", grantedBy: "seed", kind: "granted", reason: "t", expiresAt: new Date(Date.now() - 60_000) },
    ]);

    expect((await effectivePermissions(db, live)).hospital).toEqual(["auth.break_glass.review"]);
    expect((await effectivePermissions(db, dead)).hospital).toEqual([]);
  });

  it("a user holding no role at all gets an empty projection, not an error", async () => {
    await syncPermissions(db, freshRegistry());
    const { id: userId } = await createUser(db, { username: "f", fullName: "F", password: "p1234567" });
    expect(await effectivePermissions(db, userId)).toEqual({ hospital: [], scoped: { department: {}, floor: {} } });
  });
});
