import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import {
  syncPermissions, createRole, grantPermissionToRole, assignRole, hasPermission,
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
