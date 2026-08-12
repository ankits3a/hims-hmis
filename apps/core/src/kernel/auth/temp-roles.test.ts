import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { createRole, grantPermissionToRole, hasPermission, syncPermissions } from "./permissions";
import { grantTempRole, emergencyElevate, sweepExpiredTempRoles } from "./temp-roles";
import { authManifest } from "./manifest";
import { ModuleRegistry } from "../modules/loader";
import { loadConfig } from "../config";
import { events, tempRoleGrants } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
const registry = new ModuleRegistry();
registry.install(authManifest);

describe("temp roles", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
  });
  afterAll(async () => { await teardown(); });

  it("grants a temp role, events it, and the permission takes effect", async () => {
    const { id: grantee } = await createUser(db, { username: "g", fullName: "G", password: "p1234567" });
    const grantor = { type: "user" as const, id: "01HGRANTOR000000000000000A" };
    const { grantId } = await grantTempRole(db, cfg, grantor, {
      userId: grantee, roleKey: "reviewer", reason: "night cover", ttlMinutes: 60,
    });
    expect(await hasPermission(db, grantee, "auth.break_glass.review", "hospital")).toBe(true);
    const evts = await db.select().from(events).where(eq(events.name, "temp_role.granted"));
    expect(evts).toHaveLength(1);
    expect((evts[0]!.payload as { grantId: string }).grantId).toBe(grantId);
  });

  it("caps TTL at the configured maximum", async () => {
    const { id: grantee } = await createUser(db, { username: "g2", fullName: "G", password: "p1234567" });
    const { expiresAt } = await grantTempRole(db, cfg, { type: "user", id: "x" }, {
      userId: grantee, roleKey: "reviewer", reason: "r", ttlMinutes: 999999,
    });
    const maxMs = cfg.tempRoleMaxTtlMinutes * 60_000;
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(maxMs + 1000);
  });

  it("self-grant must go through emergencyElevate", async () => {
    const { id } = await createUser(db, { username: "g3", fullName: "G", password: "p1234567" });
    await expect(
      grantTempRole(db, cfg, { type: "user", id }, { userId: id, roleKey: "reviewer", reason: "r", ttlMinutes: 10 }),
    ).rejects.toThrow(/emergencyElevate/);
  });

  it("emergency elevation emits both events and confers the role", async () => {
    const { id } = await createUser(db, { username: "g4", fullName: "G", password: "p1234567" });
    await emergencyElevate(db, cfg, { type: "user", id }, { roleKey: "reviewer", reason: "duty manager unreachable", ttlMinutes: 30 });
    expect(await hasPermission(db, id, "auth.break_glass.review", "hospital")).toBe(true);
    expect(await db.select().from(events).where(eq(events.name, "emergency_elevation.used"))).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.name, "temp_role.granted"))).toHaveLength(1);
  });

  it("sweep emits temp_role.expired exactly once per lapsed grant", async () => {
    const { id } = await createUser(db, { username: "g5", fullName: "G", password: "p1234567" });
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTEXPIRED0000000000A", userId: id, roleKey: "reviewer", grantedBy: "x",
      kind: "granted", reason: "r", expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await sweepExpiredTempRoles(db)).toBe(1);
    expect(await sweepExpiredTempRoles(db)).toBe(0); // idempotent
    expect(await db.select().from(events).where(eq(events.name, "temp_role.expired"))).toHaveLength(1);
    expect(await hasPermission(db, id, "auth.break_glass.review", "hospital")).toBe(false); // enforcement was already inline
  });
});
