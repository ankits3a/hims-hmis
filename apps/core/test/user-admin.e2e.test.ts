import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { authSessions, events, roles, users } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { createUser, verifyPassword, verifyPin } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { USERS_MANAGE } from "../src/kernel/auth/users-admin.controller";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11e T3 (and T4, which extends this file — the one deliberate two-owner file, noted for the
 * per-commit stat audit).
 *
 * ═══ WHAT THIS FILE IS FOR ═══
 *
 * `auth.users.manage` and `auth.roles.manage` were DECLARED in Plan 02 and guarded nothing for six
 * weeks. This file is the executed proof that they now guard exactly what their names claim, and
 * it is built in the closed form 11d D9 shipped for ops (`test/ops-lifecycle.e2e.test.ts` legs
 * 8/8b/9/11) because that form is what caught 11c's MAJOR 2: a decorator repointed at a REAL but
 * WRONG permission survived six suites and seventy-one tests.
 *
 * ═══ FOUR LEGS, AND THE FIFTH IS DELIBERATELY NOT SHIPPED ═══
 *
 * Legs: the role-less sweep asserting each route refuses BY THE PERMISSION IT NAMES · the
 * no-token 401 sweep · manifest closure in both directions · the decorator-repoint mutant.
 *
 * 11d's leg 10 — "an actor holding EVERYTHING is refused for a missing permission on no route" —
 * is NOT here. 11d proved leg 10 ⊆ legs 8 ∧ 9, and a leg that cannot fail is §2.81's shape. What
 * replaces its value is leg 11's descendant: two REAL grant sets, each refused on the other's
 * routes BY NAME, which is the only leg that can distinguish `auth.users.manage` from
 * `auth.roles.manage` on a controller where both are real, declared strings.
 */

const NO_SUCH_USER = "01JZZZZZZZZZZZZZZZZZZZZZZZ";

/**
 * THE ROUTE → PERMISSION TABLE, TRANSCRIBED FROM THE DECORATORS. Every row is guarded: unlike
 * `ops`, this controller has no read a receptionist needs and no device posting to it, so there is
 * no `null` row to argue about. The transcription is a REGRESSION PIN on its own — it catches a
 * decorator that MOVES, never one that was wrong the day both were written — which is what the
 * closure leg and the repoint mutant are for.
 *
 * T4 APPENDS ITS TWO ROLE ROUTES TO THIS ARRAY. The census below then fails by number until it is
 * updated, which is the intended behaviour: a table that silently gained or lost a row would sweep
 * perfectly clean and prove nothing (§2.49).
 */
const ADMIN_ROUTES: [method: "get" | "post" | "delete", path: string, permission: string][] = [
  ["post", "/admin/users", USERS_MANAGE],
  ["get", "/admin/users", USERS_MANAGE],
  ["post", `/admin/users/${NO_SUCH_USER}/deactivate`, USERS_MANAGE],
  ["post", `/admin/users/${NO_SUCH_USER}/reactivate`, USERS_MANAGE],
  ["post", `/admin/users/${NO_SUCH_USER}/password-reset`, USERS_MANAGE],
  ["post", `/admin/users/${NO_SUCH_USER}/pin-reset`, USERS_MANAGE],
];

type AdminUserView = {
  id: string; username: string; fullName: string; active: boolean; hasPin: boolean;
  mustChangePassword: boolean; roles: { assignmentId: string; roleKey: string; scopeType: string; scopeId: string | null }[];
};

describe("user administration e2e (HTTP) — auth.users.manage finally guards routes", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

  /** The auth manifest's own registry — `grantPermissionToRole` REFUSES any string it lacks, so
   *  every grant below is also a proof that the permission is DECLARED and not merely decorated. */
  const registry = new ModuleRegistry();
  registry.install(authManifest);

  /** Holds `auth.users.manage`. The only actor that may drive this controller's routes. */
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  /**
   * A FULL RESET BEFORE EVERY TEST, unlike `ops-lifecycle`'s accumulating story. This file is a
   * permission map and a set of invariants, not a day in a hospital — and the lockout invariant in
   * particular is a claim about the WHOLE database's holder set, so a test that inherited another
   * test's administrators would be measuring the fixture rather than the rule.
   */
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    ({ token: adminToken, id: adminId } = await mkUser("root_admin", [USERS_MANAGE]));
  });

  const server = (): ReturnType<INestApplication["getHttpServer"]> => app.getHttpServer();

  /**
   * Mints a user, gives them a role carrying exactly `permissions`, and logs them in over the REAL
   * login route. `permissions: null` mints a user holding NO ROLES AT ALL — the actor the role-less
   * sweep needs, for which "refused" can mean nothing except "this route demands a permission".
   */
  async function mkUser(
    username: string,
    permissions: string[] | null,
  ): Promise<{ token: string; id: string }> {
    const { id } = await createUser(db, { username, fullName: username, password: "s3cret-pass" });
    if (permissions !== null) {
      const roleKey = `role_${username}`;
      await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
      for (const permission of permissions) await grantPermissionToRole(db, registry, roleKey, permission);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    const res = await request(server())
      .post("/auth/login").send({ username, password: "s3cret-pass" }).expect(201);
    return { token: res.body.token as string, id };
  }

  /** One route, one actor, one request. `.send({})` so a POST is REACHED with a body its schema
   *  refuses rather than one it acts on — the sweep must never create or deactivate anybody. */
  function drive(method: "get" | "post" | "delete", path: string, token: string | null) {
    const req = method === "get"
      ? request(server()).get(path)
      : method === "delete"
        ? request(server()).delete(path)
        : request(server()).post(path).send({});
    return token === null ? req : req.set("Authorization", `Bearer ${token}`);
  }

  const asAdmin = (method: "get" | "post" | "delete", path: string) => drive(method, path, adminToken);

  const liveSessions = async (userId: string): Promise<number> => {
    const rows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
    return rows.length;
  };

  const eventHighWater = async (): Promise<number> => {
    const rows = await db.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events);
    return Number(rows[0]?.seq ?? 0);
  };
  const eventsSince = async (seq: number): Promise<{ name: string; payload: unknown; actorId: string }[]> => {
    const rows = await db
      .select({ name: events.name, payload: events.payload, actorId: events.actorId })
      .from(events)
      .where(gt(events.seq, seq))
      .orderBy(asc(events.seq));
    return rows.map((r) => ({ name: r.name, payload: r.payload, actorId: r.actorId }));
  };

  // ═══════════════════ THE FOUR LEGS — §3.42, from day one ═══════════════════

  it("leg 1 (R7) — the census, then the role-less sweep: every route refuses BY THE PERMISSION IT NAMES", async () => {
    // THE CENSUS FIRST (§2.49). A table that silently lost a row sweeps perfectly clean.
    expect({
      routes: ADMIN_ROUTES.length,
      distinctPermissions: new Set(ADMIN_ROUTES.map(([, , p]) => p)).size,
    }).toEqual({ routes: 6, distinctPermissions: 1 });

    const { token: roleLess } = await mkUser("holds_nothing", null);
    for (const [method, path, permission] of ADMIN_ROUTES) {
      const res = await drive(method, path, roleLess);
      // THE MESSAGE, not merely the status: a bare 403 is what ANY permission string produces,
      // including a wrong one. This is the assertion 11c's MAJOR 2 did not have.
      expect({ method, path, status: res.status, message: res.body.message }).toEqual({
        method, path, status: 403, message: `missing permission ${permission}`,
      });
    }
  });

  it("leg 2 (R7) — and every route is AUTHENTICATED: no token is a 401, never a 200", async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await drive(method, path, null);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
  });

  it("leg 3 — manifest closure, BOTH directions", () => {
    const guarded = [...new Set(ADMIN_ROUTES.map(([, , permission]) => permission))].sort();
    const declared = [...authManifest.permissions].sort();

    expect(guarded).toHaveLength(1); // T4 makes this 2, and this line is where it says so

    // A route demanding a permission NO manifest declares is a route `syncPermissions` leaves
    // ungrantable forever — and leg 1 answers 403 for it exactly as it does for a correct route.
    expect(guarded.filter((p) => !declared.includes(p))).toEqual([]);

    // THE OTHER DIRECTION carries an EXPLICIT exception list, unlike ops's `toEqual([])`. The auth
    // manifest declares six permissions and this phase guards two of them; the other four are
    // guarded elsewhere in the tree and are NAMED here rather than filtered away, so a fifth name
    // appearing in this list is a route that lost its decorator rather than a known gap.
    const guardedElsewhere = [
      "auth.agents.manage",      // no HTTP surface yet — agents are minted by `scripts/create-agent.ts`
      "auth.break_glass.use",    // auth.controller.ts POST /auth/break-glass
      "auth.break_glass.review", // auth.controller.ts GET/POST /auth/break-glass*
      "auth.temp_role.grant",    // auth.controller.ts POST /auth/temp-roles
      // STILL GUARDING NOTHING AT T3, and named here rather than hidden so that the state is
      // VISIBLE for exactly one commit. T4 ships `roles-admin.controller.ts` and DELETES this line;
      // if it is ever deleted without the routes arriving, this leg fails.
      "auth.roles.manage",
    ];
    expect(declared.filter((p) => !guarded.includes(p)).sort()).toEqual([...guardedElsewhere].sort());
  });

  it("leg 4 (R8) — THE REPOINT MUTANT'S TARGET: the 403 names auth.users.manage and not some other real string", async () => {
    // R8's mutant repoints ONE route's decorator at `auth.roles.manage` — a REAL, DECLARED
    // permission. It cannot be caught by a status code, by a role-less sweep that reads only the
    // status, or by manifest closure. It is caught HERE, and only here, by the string.
    const { token: wrongPermission } = await mkUser("holds_roles_manage", ["auth.roles.manage"]);
    for (const [method, path, permission] of ADMIN_ROUTES) {
      const res = await drive(method, path, wrongPermission);
      expect({ method, path, status: res.status, message: res.body.message }).toEqual({
        method, path, status: 403, message: `missing permission ${permission}`,
      });
    }
    // …and the control: the RIGHT permission is admitted on the same routes. Without this the leg
    // above would pass against a controller that refused everybody.
    const list = await asAdmin("get", "/admin/users");
    expect(list.status).toBe(200);
  });

  // ═══════════════════════════ THE SURFACE ITSELF ═══════════════════════════

  it("creates a user who must change their password, and the event says so without a credential in it", async () => {
    const before = await eventHighWater();
    const res = await asAdmin("post", "/admin/users").send({
      username: "asha", fullName: "Asha Verma", password: "provisional-one", pin: "482913",
    });
    expect(res.status).toBe(201);

    const list = await asAdmin("get", "/admin/users");
    const asha = (list.body.users as AdminUserView[]).find((u) => u.username === "asha");
    expect(asha).toMatchObject({
      username: "asha", fullName: "Asha Verma", active: true, hasPin: true, mustChangePassword: true,
    });

    // The credential works, and the forced change bites over HTTP.
    const login = await request(server())
      .post("/auth/login").send({ username: "asha", password: "provisional-one" }).expect(201);
    const me = await request(server())
      .get("/auth/me").set("Authorization", `Bearer ${login.body.token as string}`);
    expect([me.status, me.body.message]).toEqual([403, "password_change_required"]);

    const appended = await eventsSince(before);
    expect(appended.map((e) => e.name)).toEqual(["user.created"]);
    expect(appended[0]!.payload).toEqual({
      userId: res.body.id, username: "asha", fullName: "Asha Verma", hasPin: true, mustChangePassword: true,
    });
    expect(appended[0]!.actorId).toBe(adminId); // the ACTING ADMIN, not the person created
    expect(JSON.stringify(appended)).not.toContain("provisional-one");
    expect(JSON.stringify(appended)).not.toContain("482913");
  });

  it("R4 at THIS path — the policy is applied to both credentials at creation", async () => {
    const short = await asAdmin("post", "/admin/users")
      .send({ username: "ravi", fullName: "Ravi", password: "abcdefghi" });
    expect([short.status, short.body.problems.map((p: { code: string }) => p.code)]).toEqual([
      400, ["password_too_short"],
    ]);
    const badPin = await asAdmin("post", "/admin/users")
      .send({ username: "ravi", fullName: "Ravi", password: "abcdefghij", pin: "12ab" });
    expect([badPin.status, badPin.body.problems.map((p: { code: string }) => p.code)]).toEqual([
      400, ["pin_not_digits"],
    ]);
    // The refusals really refused: no `ravi` exists.
    const list = await asAdmin("get", "/admin/users");
    expect((list.body.users as AdminUserView[]).map((u) => u.username)).not.toContain("ravi");
  });

  it("R9 — password-reset revokes: the target's prior token replays to 401 and must-change is set", async () => {
    const { token: victimToken, id: victimId } = await mkUser("forgetful", null);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${victimToken}`).expect(200);
    expect(await liveSessions(victimId)).toBe(1);

    const before = await eventHighWater();
    const res = await asAdmin("post", `/admin/users/${victimId}/password-reset`)
      .send({ newPassword: "issued-at-the-desk" });
    expect([res.status, res.body]).toEqual([200, { sessionsRevoked: 1 }]);

    // THE REPLAY — R9's discriminating input, and the one a handler that forgot the revoke passes.
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${victimToken}`).expect(401);
    expect(await liveSessions(victimId)).toBe(0);

    // …and the new credential works, lands the person in the forced-change state, and they can
    // walk out of it under their own power. This is the whole point of the phase, end to end.
    const fresh = await request(server())
      .post("/auth/login").send({ username: "forgetful", password: "issued-at-the-desk" }).expect(201);
    const token = fresh.body.token as string;
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(403);
    await request(server())
      .post("/auth/change-password").set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "issued-at-the-desk", newPassword: "one-they-chose-themselves" })
      .expect(204);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);

    const names = (await eventsSince(before)).map((e) => e.name);
    expect(names).toEqual(["user.credential_reset", "user.password_changed"]);
  });

  it("PIN reset does NOT revoke and does NOT force a password change (Q3's two flows, one core)", async () => {
    const { token: victimToken, id: victimId } = await mkUser("switcher", null);
    const before = await eventHighWater();
    await asAdmin("post", `/admin/users/${victimId}/pin-reset`).send({ newPin: "417293" }).expect(204);

    // The session SURVIVES — the assertion that separates this flow from the one above.
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${victimToken}`).expect(200);
    expect(await liveSessions(victimId)).toBe(1);
    expect(await verifyPin(db, victimId, "417293")).toBe(true);

    const appended = await eventsSince(before);
    expect(appended.map((e) => e.name)).toEqual(["user.credential_reset"]);
    expect(appended[0]!.payload).toMatchObject({ kind: "pin", sessionsRevoked: 0, mustChangePassword: false });
    expect(JSON.stringify(appended)).not.toContain("417293");
  });

  it("deactivate kills the sessions in the same flow, and reactivate does not bring them back", async () => {
    const { token: goneToken, id: goneId } = await mkUser("leaving", null);
    const before = await eventHighWater();

    const res = await asAdmin("post", `/admin/users/${goneId}/deactivate`);
    expect([res.status, res.body]).toEqual([200, { sessionsRevoked: 1 }]);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${goneToken}`).expect(401);
    expect(await verifyPassword(db, "leaving", "s3cret-pass")).toBeNull();

    await asAdmin("post", `/admin/users/${goneId}/reactivate`).expect(204);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${goneToken}`).expect(401); // still dead
    expect(await verifyPassword(db, "leaving", "s3cret-pass")).not.toBeNull(); // …but they can log in
    const again = await request(server())
      .post("/auth/login").send({ username: "leaving", password: "s3cret-pass" }).expect(201);
    await request(server())
      .get("/auth/me").set("Authorization", `Bearer ${again.body.token as string}`).expect(200);

    expect((await eventsSince(before)).map((e) => e.name)).toEqual(["user.deactivated", "user.reactivated"]);
  });

  it("a route that names a user who does not exist is a 404, never a silent success", async () => {
    for (const path of [
      `/admin/users/${NO_SUCH_USER}/deactivate`, `/admin/users/${NO_SUCH_USER}/reactivate`,
    ]) {
      const res = await asAdmin("post", path);
      expect([path, res.status, res.body.code]).toEqual([path, 404, "user_not_found"]);
    }
    const reset = await asAdmin("post", `/admin/users/${NO_SUCH_USER}/password-reset`)
      .send({ newPassword: "a-fine-password" });
    expect([reset.status, reset.body.code]).toEqual([404, "user_not_found"]);
  });

  it("a duplicate username is a 409, not a 500 from the unique index", async () => {
    await asAdmin("post", "/admin/users")
      .send({ username: "asha", fullName: "Asha", password: "a-fine-password" }).expect(201);
    const again = await asAdmin("post", "/admin/users")
      .send({ username: "asha", fullName: "Asha Two", password: "a-fine-password" });
    expect([again.status, again.body.code]).toEqual([409, "username_taken"]);
  });

  // ══════════════════════════ R10 — THE LOCKOUT INVARIANT ══════════════════════════

  it("R10 — deactivating the SOLE holder of auth.users.manage is refused 409 admin_lockout", async () => {
    // The control comes FIRST and it is what stops this row passing by refusing everything: a
    // NON-last holder is deactivated successfully, in the same database, through the same route.
    const { id: secondAdminId } = await mkUser("second_admin", [USERS_MANAGE]);
    await asAdmin("post", `/admin/users/${secondAdminId}/deactivate`).expect(200);

    // Now `root_admin` is the only active holder left — and it may not remove itself.
    const refused = await asAdmin("post", `/admin/users/${adminId}/deactivate`);
    expect([refused.status, refused.body.code]).toEqual([409, "admin_lockout"]);

    // AND NOTHING MOVED. A refusal that had already deactivated the account would be worse than
    // no invariant at all, and `withTx` is what makes this assertion meaningful.
    const rows = await db.select({ active: users.active }).from(users).where(eq(users.id, adminId));
    expect(rows[0]!.active).toBe(true);
    await asAdmin("get", "/admin/users").expect(200);
  });

  it("R10 — an INACTIVE holder does not count, so the last ACTIVE one is still protected", async () => {
    // The subtle case: two holders exist in `role_assignments`, but one is already deactivated.
    // A count that read assignments without joining `users.active` would see two and allow the
    // last active administrator to be removed.
    const { id: dormant } = await mkUser("dormant_admin", [USERS_MANAGE]);
    await asAdmin("post", `/admin/users/${dormant}/deactivate`).expect(200);

    const refused = await asAdmin("post", `/admin/users/${adminId}/deactivate`);
    expect([refused.status, refused.body.code]).toEqual([409, "admin_lockout"]);
  });
});
