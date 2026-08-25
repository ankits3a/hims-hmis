import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { createRole, grantPermissionToRole, hasPermission, syncPermissions } from "./permissions";
import {
  ELEVATION_FORBIDDEN_PERMISSIONS, RoleNotTemporarilyGrantableError, UnknownRoleError,
  emergencyElevate, grantTempRole, pendingElevationReviews, recordElevationReview,
  sweepExpiredTempRoles,
} from "./temp-roles";
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
    // `night_cover` holds `auth.break_glass.use` — the ONE `auth.*` string a temporary grant may
    // carry (`ELEVATABLE_AUTH_PERMISSIONS`). It used to be `auth.break_glass.review`, which the
    // elevation ceiling now refuses: nothing about reviewing is ever urgent at 2 a.m.
    await createRole(db, "night_cover", "Night cover");
    await grantPermissionToRole(db, registry, "night_cover", "auth.break_glass.use");
    // `escalating` is the shape the ceiling exists to refuse: a role carrying authority over
    // ACCESS, whose holder can mint a PERMANENT assignment that outlives any TTL.
    await createRole(db, "escalating", "Escalating");
    await grantPermissionToRole(db, registry, "escalating", "auth.roles.manage");
  });
  afterAll(async () => { await teardown(); });

  it("grants a temp role, events it, and the permission takes effect", async () => {
    const { id: grantee } = await createUser(db, { username: "g", fullName: "G", password: "p1234567" });
    const grantor = { type: "user" as const, id: "01HGRANTOR000000000000000A" };
    const { grantId } = await grantTempRole(db, cfg, grantor, {
      userId: grantee, roleKey: "night_cover", reason: "night cover", ttlMinutes: 60,
    });
    expect(await hasPermission(db, grantee, "auth.break_glass.use", "hospital")).toBe(true);
    const evts = await db.select().from(events).where(eq(events.name, "temp_role.granted"));
    expect(evts).toHaveLength(1);
    expect((evts[0]!.payload as { grantId: string }).grantId).toBe(grantId);
  });

  it("caps TTL at the configured maximum", async () => {
    const { id: grantee } = await createUser(db, { username: "g2", fullName: "G", password: "p1234567" });
    const { expiresAt } = await grantTempRole(db, cfg, { type: "user", id: "x" }, {
      userId: grantee, roleKey: "night_cover", reason: "r", ttlMinutes: 999999,
    });
    const maxMs = cfg.tempRoleMaxTtlMinutes * 60_000;
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(maxMs + 1000);
  });

  it("self-grant must go through emergencyElevate", async () => {
    const { id } = await createUser(db, { username: "g3", fullName: "G", password: "p1234567" });
    await expect(
      grantTempRole(db, cfg, { type: "user", id }, { userId: id, roleKey: "night_cover", reason: "r", ttlMinutes: 10 }),
    ).rejects.toThrow(/emergencyElevate/);
  });

  it("emergency elevation emits both events and confers the role", async () => {
    const { id } = await createUser(db, { username: "g4", fullName: "G", password: "p1234567" });
    await emergencyElevate(db, cfg, { type: "user", id }, { roleKey: "night_cover", reason: "duty manager unreachable", ttlMinutes: 30 });
    expect(await hasPermission(db, id, "auth.break_glass.use", "hospital")).toBe(true);
    expect(await db.select().from(events).where(eq(events.name, "emergency_elevation.used"))).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.name, "temp_role.granted"))).toHaveLength(1);
  });

  // ════════════════ THE ELEVATION CEILING (the escalation this closed was live) ════════════════

  it("the forbidden set is DERIVED, so a new auth.* string is refused the day it is declared", () => {
    // The property, not the contents: everything `authManifest` declares is forbidden unless it is
    // explicitly elevatable. A hand-written deny-list would fail OPEN on the next permission
    // somebody adds, which is the shape of every escalation bug.
    const elevatable = new Set(["auth.break_glass.use"]);
    expect([...ELEVATION_FORBIDDEN_PERMISSIONS].sort())
      .toEqual(authManifest.permissions.filter((p) => !elevatable.has(p)).sort());
    expect(ELEVATION_FORBIDDEN_PERMISSIONS).toContain("auth.roles.manage");
    expect(ELEVATION_FORBIDDEN_PERMISSIONS).toContain("auth.users.manage");
    // The one that makes reviewing your own elevation structurally impossible:
    expect(ELEVATION_FORBIDDEN_PERMISSIONS).toContain("auth.elevation.review");
    expect(ELEVATION_FORBIDDEN_PERMISSIONS).not.toContain("auth.break_glass.use");
  });

  it("REFUSES self-elevation into a role carrying authority over access, and writes NOTHING", async () => {
    const { id } = await createUser(db, { username: "clerk", fullName: "C", password: "p1234567" });
    await expect(
      emergencyElevate(db, cfg, { type: "user", id }, { roleKey: "escalating", reason: "it is late", ttlMinutes: 720 }),
    ).rejects.toBeInstanceOf(RoleNotTemporarilyGrantableError);

    // The permission never landed...
    expect(await hasPermission(db, id, "auth.roles.manage", "hospital")).toBe(false);
    // ...no grant row exists...
    expect(await db.select().from(tempRoleGrants)).toHaveLength(0);
    // ...and — the half that matters for the audit stream — NO event claims authority was taken.
    expect(await db.select().from(events).where(eq(events.name, "emergency_elevation.used"))).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, "temp_role.granted"))).toHaveLength(0);
  });

  it("REFUSES the admin-granted door too — one rule, both doors", async () => {
    const { id: grantee } = await createUser(db, { username: "colleague", fullName: "C", password: "p1234567" });
    await expect(
      grantTempRole(db, cfg, { type: "user", id: "01HGRANTOR000000000000000A" }, {
        userId: grantee, roleKey: "escalating", reason: "cover", ttlMinutes: 60,
      }),
    ).rejects.toBeInstanceOf(RoleNotTemporarilyGrantableError);
    expect(await db.select().from(tempRoleGrants)).toHaveLength(0);
  });

  it("an unknown role is a named refusal, not a foreign-key 500", async () => {
    const { id } = await createUser(db, { username: "typo", fullName: "T", password: "p1234567" });
    await expect(
      emergencyElevate(db, cfg, { type: "user", id }, { roleKey: "adminn", reason: "fat finger", ttlMinutes: 30 }),
    ).rejects.toBeInstanceOf(UnknownRoleError);
  });

  // ═══════════════════════ THE REVIEW QUEUE (mechanism 6's missing half) ═══════════════════════

  it("queues only emergency self-elevations, and an EXPIRED one stays queued", async () => {
    const { id: self } = await createUser(db, { username: "r1", fullName: "R", password: "p1234567" });
    const { id: other } = await createUser(db, { username: "r2", fullName: "R", password: "p1234567" });

    await emergencyElevate(db, cfg, { type: "user", id: self }, {
      roleKey: "night_cover", reason: "duty manager unreachable", ttlMinutes: 30,
    });
    // An admin-GRANTED temp role already had a second person in it; it is not this queue's business.
    await grantTempRole(db, cfg, { type: "user", id: "01HGRANTOR000000000000000A" }, {
      userId: other, roleKey: "night_cover", reason: "night cover", ttlMinutes: 30,
    });

    const queued = await pendingElevationReviews(db);
    expect(queued.map((q) => q.userId)).toEqual([self]);

    // Expire it. The authority is gone; the question of whether taking it was justified is not —
    // a queue that drained on a TTL would make the mandatory review a race the reviewer loses by
    // sleeping through it.
    await db.update(tempRoleGrants).set({ expiresAt: new Date(Date.now() - 60_000) });
    expect((await pendingElevationReviews(db)).map((q) => q.userId)).toEqual([self]);
  });

  it("records a review once, events it, and refuses the second reviewer", async () => {
    const { id } = await createUser(db, { username: "r3", fullName: "R", password: "p1234567" });
    const { grantId } = await emergencyElevate(db, cfg, { type: "user", id }, {
      roleKey: "night_cover", reason: "duty manager unreachable", ttlMinutes: 30,
    });
    const reviewer = { type: "user" as const, id: "01HREVIEWER00000000000000A" };

    await recordElevationReview(db, grantId, reviewer, "justified — ER, MS informed");
    expect(await pendingElevationReviews(db)).toHaveLength(0);

    const reviewed = await db.select().from(events).where(eq(events.name, "emergency_elevation.reviewed"));
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.payload).toMatchObject({ grantId, userId: id, roleKey: "night_cover" });

    // The conditional UPDATE is what makes this single-winner: a read-then-write would let two
    // reviewers both commit at READ COMMITTED and put two events behind one act.
    await expect(recordElevationReview(db, grantId, reviewer, "again")).rejects.toThrow(/already reviewed/);
    expect(await db.select().from(events).where(eq(events.name, "emergency_elevation.reviewed"))).toHaveLength(1);
  });

  it("reviewing something that is not an emergency elevation is a not-found, not a silent no-op", async () => {
    const { id: other } = await createUser(db, { username: "r4", fullName: "R", password: "p1234567" });
    const { grantId } = await grantTempRole(db, cfg, { type: "user", id: "01HGRANTOR000000000000000A" }, {
      userId: other, roleKey: "night_cover", reason: "cover", ttlMinutes: 30,
    });
    await expect(recordElevationReview(db, grantId, { type: "user", id: "x" }, "n")).rejects.toThrow(/no emergency elevation/);
    await expect(recordElevationReview(db, "01HNOSUCHGRANT0000000000A", { type: "user", id: "x" }, "n"))
      .rejects.toThrow(/no emergency elevation/);
  });

  it("sweep emits temp_role.expired exactly once per lapsed grant, honouring an explicit now", async () => {
    const { id } = await createUser(db, { username: "g5", fullName: "G", password: "p1234567" });
    // Plan 08.5 (Global Constraint 9): the sweep now takes `now` instead of reading the wall
    // clock inline. `expiresAt` stays in the REAL past (as shipped) so hasPermission's own
    // live expiry check below still refuses independently of the sweep ("enforcement was
    // already inline") — but `beforeExpiry`, passed as `now`, is EARLIER still than
    // `expiresAt`. A sweep that silently fell back to `new Date()` (the real, later, wall
    // clock) would find the grant due anyway and return 1; only a sweep that actually honours
    // the passed `now` correctly returns 0 here.
    const expiresAt = new Date(Date.now() - 60 * 60_000);
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTEXPIRED0000000000A", userId: id, roleKey: "night_cover", grantedBy: "x",
      kind: "granted", reason: "r", expiresAt,
    });
    const beforeExpiry = new Date(expiresAt.getTime() - 60_000);
    expect(await sweepExpiredTempRoles(db, beforeExpiry)).toBe(0); // not due yet, per the passed now
    const afterExpiry = new Date(expiresAt.getTime() + 60_000);
    expect(await sweepExpiredTempRoles(db, afterExpiry)).toBe(1);
    expect(await sweepExpiredTempRoles(db, afterExpiry)).toBe(0); // idempotent
    const expired = await db.select().from(events).where(eq(events.name, "temp_role.expired"));
    expect(expired).toHaveLength(1);
    expect(await hasPermission(db, id, "auth.break_glass.use", "hospital")).toBe(false); // enforcement was already inline
  });
});
