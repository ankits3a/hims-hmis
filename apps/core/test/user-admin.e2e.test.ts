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
import { RequestMethod } from "@nestjs/common";
// The routing metadata keys are Nest's own, and they live on the `constants` subpath rather than
// the package root — this leg reads exactly what the framework routes from.
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PERMISSION_KEY } from "../src/kernel/auth/decorators";
import { USERS_MANAGE, UsersAdminController } from "../src/kernel/auth/users-admin.controller";
import { ROLES_MANAGE, RolesAdminController } from "../src/kernel/auth/roles-admin.controller";
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
const NO_SUCH_ASSIGNMENT = "01JYYYYYYYYYYYYYYYYYYYYYYY";

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
  // ── T4's two role routes. A DIFFERENT permission on the SAME base path, which is the whole
  // reason the two controllers are split: `auth.roles.manage` guards changing who holds what,
  // `auth.users.manage` guards the accounts themselves, and leg 4 can now tell them apart with a
  // real actor rather than a hypothetical one.
  ["post", `/admin/users/${NO_SUCH_USER}/roles`, ROLES_MANAGE],
  ["delete", `/admin/users/${NO_SUCH_USER}/roles/${NO_SUCH_ASSIGNMENT}`, ROLES_MANAGE],
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
    }).toEqual({ routes: 8, distinctPermissions: 2 });

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

  it("leg 3b (CLOSE M3) — THE TABLE IS CHECKED AGAINST THE ROUTER, so a route it omits cannot hide", () => {
    /**
     * WHY THIS LEG EXISTS. Legs 1, 2, 3 and 4 all iterate `ADMIN_ROUTES`, so all four are closed
     * over the TABLE. A route added to a controller and not to the table is invisible to every one
     * of them: the census still matches, the sweep still passes, closure still passes, and an
     * undecorated `@Post(":id/badge-rotate")` would be reachable by any authenticated user with
     * nothing in the suite going red. Found by the 11e independent reviewer (CLOSE, M3).
     *
     * The second source is the DECORATOR METADATA Nest itself routes from — not the table, and not
     * a hand-written list. It answers two questions the table cannot: which routes exist, and
     * whether each one carries a permission requirement at all.
     */
    const scan = (controller: new (...args: never[]) => object): {
      route: string; permission: string | undefined; scope: string | undefined;
    }[] => {
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
      const proto = controller.prototype as object;
      return Object.getOwnPropertyNames(proto)
        .filter((name) => name !== "constructor")
        .map((name) => (proto as Record<string, unknown>)[name])
        .filter((handler): handler is (...args: never[]) => unknown => typeof handler === "function")
        .filter((handler) => Reflect.getMetadata(METHOD_METADATA, handler) !== undefined)
        .map((handler) => {
          const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
          const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) || "";
          const requirement = Reflect.getMetadata(PERMISSION_KEY, handler) as
            | { permission: string; scope: string } | undefined;
          const path = `/${base}${sub === "" || sub === "/" ? "" : `/${sub}`}`;
          return { route: `${verb} ${path}`, permission: requirement?.permission, scope: requirement?.scope };
        });
    };

    const routed = [...scan(UsersAdminController), ...scan(RolesAdminController)];

    // CENSUS FIRST (§2.49): the scanner really did find handlers. A scanner that returned nothing
    // would satisfy every comparison below for ever.
    expect(routed).toHaveLength(ADMIN_ROUTES.length);

    // (a) EVERY routed handler carries a permission requirement. This is the leg that catches the
    // undecorated route — the one shape the table-driven sweep is blind to by construction.
    expect(routed.filter((r) => r.permission === undefined).map((r) => r.route)).toEqual([]);
    // (b) …at hospital scope, which is what the lockout invariant's holder count assumes (C2).
    expect(routed.filter((r) => r.scope !== "hospital").map((r) => r.route)).toEqual([]);

    // (c) The ROUTER's route→permission map equals the TABLE's, both directions. `ADMIN_ROUTES`
    // carries concrete ids in its paths, so both sides are normalised to Nest's parameter form.
    const normalise = (path: string): string =>
      path.replace(NO_SUCH_USER, ":id").replace(NO_SUCH_ASSIGNMENT, ":assignmentId");
    const fromTable = ADMIN_ROUTES
      .map(([method, path, permission]) => `${method.toUpperCase()} ${normalise(path)} ${permission}`)
      .sort();
    const fromRouter = routed.map((r) => `${r.route} ${r.permission ?? "NONE"}`).sort();
    expect(fromRouter).toEqual(fromTable);
  });

  it("leg 3 — manifest closure, BOTH directions", () => {
    const guarded = [...new Set(ADMIN_ROUTES.map(([, , permission]) => permission))].sort();
    const declared = [...authManifest.permissions].sort();

    expect(guarded).toHaveLength(2); // T4 made this 2 — users.manage and roles.manage

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
    ];
    expect(declared.filter((p) => !guarded.includes(p)).sort()).toEqual([...guardedElsewhere].sort());
  });

  it("leg 4 (R8/R12) — TWO REAL GRANT SETS, each refused on the OTHER's routes BY NAME", async () => {
    // THE LEG THE REPOINT MUTANT DIES ON, and the only one that can distinguish two real,
    // DECLARED permission strings from one another. A role-less sweep, a status-only assertion and
    // manifest closure all pass against a decorator repointed from `auth.users.manage` to
    // `auth.roles.manage` — both are real, both are declared, and both produce a bare 403.
    //
    // Each route is driven by the holder of the OTHER permission, which is what makes the refusal
    // attributable to the STRING rather than to the actor holding nothing.
    const holders: Record<string, string> = {
      [USERS_MANAGE]: (await mkUser("holds_roles_manage", [ROLES_MANAGE])).token,
      [ROLES_MANAGE]: adminToken, // holds USERS_MANAGE and nothing else
    };

    for (const [method, path, permission] of ADMIN_ROUTES) {
      const res = await drive(method, path, holders[permission]!);
      expect({ method, path, status: res.status, message: res.body.message }).toEqual({
        method, path, status: 403, message: `missing permission ${permission}`,
      });
    }

    // THE CONTROLS, both directions — without them the sweep above would pass against a controller
    // that refused everybody. Each permission's own holder is ADMITTED on a route it guards: 200
    // for the list, and a 404 for a role revoke means the guard let it through and the handler
    // could not find the assignment, which is admission just as surely.
    expect((await asAdmin("get", "/admin/users")).status).toBe(200);
    const roleAdmin = holders[USERS_MANAGE]!;
    const admitted = await drive(
      "delete", `/admin/users/${NO_SUCH_USER}/roles/${NO_SUCH_ASSIGNMENT}`, roleAdmin,
    );
    expect([admitted.status, admitted.body.code]).toEqual([404, "assignment_not_found"]);
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

  /**
   * PLAN 11f T2 / D2 — THE TWO-ADMIN DETECTOR, at the surface that can meet the mitigation.
   *
   * ROUTINE tier: tests required, mutants NOT required and fail-first NOT owed — stated rather
   * than inferred. What these two legs are FOR is the property §2.89 cost us to learn: the count
   * must agree with the takeover rule about who is a full administrator, and the two ways a
   * lookalike join gets it wrong are counting deactivated accounts and counting holdings at a
   * scope the guards refuse. Both are asserted, and both would pass under a naive
   * `select … join role_permissions` that ignores `users.active` and `scopeType`.
   */
  it("11f D2 — the list carries the full-administrator count, and it tracks reality", async () => {
    const ALL_AUTH = [...authManifest.permissions];

    // `root_admin` holds USERS_MANAGE ALONE, so at baseline NOBODY holds the whole set — which is
    // also what makes the increments below non-vacuous.
    expect((await asAdmin("get", "/admin/users").expect(200)).body.fullAdministrators).toBe(0);

    await mkUser("owner_one", ALL_AUTH);
    expect((await asAdmin("get", "/admin/users").expect(200)).body.fullAdministrators).toBe(1);

    const { id: ownerTwoId } = await mkUser("owner_two", ALL_AUTH);
    expect((await asAdmin("get", "/admin/users").expect(200)).body.fullAdministrators).toBe(2);

    // A DEACTIVATED holder cannot reset anybody, so they are not one of the two the mitigation
    // asks for. The count says so.
    await asAdmin("post", `/admin/users/${ownerTwoId}/deactivate`).expect(200);
    expect((await asAdmin("get", "/admin/users").expect(200)).body.fullAdministrators).toBe(1);
  });

  it("11f D2 — a DEPARTMENT-scoped holder of every auth.* permission is not a full administrator (C2's scope, one door over)", async () => {
    const { id } = await mkUser("dept_owner", null);
    const roleKey = "dept_owner_role";
    await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
    for (const permission of authManifest.permissions) {
      await grantPermissionToRole(db, registry, roleKey, permission);
    }
    await assignRole(db, { userId: id, roleKey, scopeType: "department", scopeId: "cardiology" });

    // They hold every auth.* string in `role_permissions` — a counter that forgot the scope
    // predicate would say 1 — but `hasPermission` refuses a department holding against the
    // hospital requirement every admin route carries, so they can administer NOBODY.
    expect((await asAdmin("get", "/admin/users").expect(200)).body.fullAdministrators).toBe(0);
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

    // CLOSE (minor 5) — AND THE TWO RESET ROUTES AGREE ON THE ORDER. `pinReset` used to judge the
    // PIN before looking the user up, so a bad PIN for a user who does not exist answered 400 here
    // and 404 one route over. Both legs asserted, because a fix that swapped the inconsistency
    // round would pass either one alone.
    for (const [path, body] of [
      [`/admin/users/${NO_SUCH_USER}/pin-reset`, { newPin: "12ab" }],
      [`/admin/users/${NO_SUCH_USER}/password-reset`, { newPassword: "short" }],
    ] as const) {
      const res = await asAdmin("post", path).send(body);
      expect([path, res.status, res.body.code]).toEqual([path, 404, "user_not_found"]);
    }
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

  // ═══════════════ T4 — role assign and revoke, under auth.roles.manage ═══════════════

  it("assigns a role over HTTP, and the target gains the permission on their NEXT request", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    const { token: staffToken, id: staffId } = await mkUser("staff", null);
    // The role this test hands out carries a REAL permission, so "gained authority" is observable
    // as a route that starts answering rather than as a row in a table.
    await db.insert(roles).values({ key: "user_manager", title: "User Manager" }).onConflictDoNothing();
    await grantPermissionToRole(db, registry, "user_manager", USERS_MANAGE);

    await request(server()).get("/admin/users").set("Authorization", `Bearer ${staffToken}`).expect(403);

    const before = await eventHighWater();
    const assigned = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "user_manager", scopeType: "hospital" });
    expect(assigned.status).toBe(201);

    // THE SAME TOKEN. No re-login, no new session — `hasPermission` reads the live rows.
    await request(server()).get("/admin/users").set("Authorization", `Bearer ${staffToken}`).expect(200);

    const appended = await eventsSince(before);
    expect(appended.map((e) => e.name)).toEqual(["role.assigned"]);
    expect(appended[0]!.payload).toEqual({
      assignmentId: assigned.body.assignmentId, userId: staffId, roleKey: "user_manager",
      scopeType: "hospital", scopeId: null,
    });
  });

  it("R11 — a REVOKED assignment is effective on the target's next request, with no session work", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    await db.insert(roles).values({ key: "user_manager", title: "User Manager" }).onConflictDoNothing();
    await grantPermissionToRole(db, registry, "user_manager", USERS_MANAGE);
    const { token: staffToken, id: staffId } = await mkUser("staff", null);
    const assigned = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "user_manager", scopeType: "hospital" }).expect(201);
    const assignmentId = assigned.body.assignmentId as string;

    // Non-vacuity: they really do hold it right now.
    await request(server()).get("/admin/users").set("Authorization", `Bearer ${staffToken}`).expect(200);
    const sessionsBefore = await liveSessions(staffId);

    const before = await eventHighWater();
    await request(server())
      .delete(`/admin/users/${staffId}/roles/${assignmentId}`)
      .set("Authorization", `Bearer ${roleAdminToken}`).expect(204);

    // THE DISCRIMINATING INPUT: the SAME token, replayed. Shipped 403; R11's mutant — a revoke
    // that deletes nothing and returns success — answers 200 here.
    const replay = await request(server()).get("/admin/users").set("Authorization", `Bearer ${staffToken}`);
    expect([replay.status, replay.body.message]).toEqual([403, `missing permission ${USERS_MANAGE}`]);

    // "WITH NO SESSION WORK" is the other half of the claim, and it is asserted rather than
    // implied: the session is untouched, so what changed is the authority and nothing else.
    expect(await liveSessions(staffId)).toBe(sessionsBefore);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${staffToken}`).expect(200);

    expect((await eventsSince(before)).map((e) => e.name)).toEqual(["role.revoked"]);
  });

  it("R10 at the OTHER route — revoking the last auth.users.manage assignment is refused 409", async () => {
    // The lockout invariant's second enforcement point. `root_admin` holds USERS_MANAGE through
    // exactly one assignment, and `assertNoAdminLockout` is the same function `deactivate` calls.
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    const list = await asAdmin("get", "/admin/users").expect(200);
    const rootAdmin = (list.body.users as AdminUserView[]).find((u) => u.id === adminId)!;
    expect(rootAdmin.roles).toHaveLength(1);
    const assignmentId = rootAdmin.roles[0]!.assignmentId;

    const refused = await request(server())
      .delete(`/admin/users/${adminId}/roles/${assignmentId}`)
      .set("Authorization", `Bearer ${roleAdminToken}`);
    expect([refused.status, refused.body.code]).toEqual([409, "admin_lockout"]);

    // NOTHING MOVED: the assignment is still there and still works.
    await asAdmin("get", "/admin/users").expect(200);

    // …and the control — a SECOND holder's assignment revokes cleanly through the same route, so
    // this row cannot pass by refusing everything.
    const { id: secondId } = await mkUser("second_admin", [USERS_MANAGE]);
    const list2 = await asAdmin("get", "/admin/users").expect(200);
    const second = (list2.body.users as AdminUserView[]).find((u) => u.id === secondId)!;
    await request(server())
      .delete(`/admin/users/${secondId}/roles/${second.roles[0]!.assignmentId}`)
      .set("Authorization", `Bearer ${roleAdminToken}`).expect(204);
  });

  it("an assignment revoked through the WRONG user's path is a 404, and nothing is removed", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    const { id: staffId } = await mkUser("staff", null);
    const { id: otherId } = await mkUser("other", null);
    await db.insert(roles).values({ key: "vitals_desk", title: "Vitals" }).onConflictDoNothing();
    const assigned = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "vitals_desk", scopeType: "hospital" }).expect(201);

    const wrong = await request(server())
      .delete(`/admin/users/${otherId}/roles/${assigned.body.assignmentId as string}`)
      .set("Authorization", `Bearer ${roleAdminToken}`);
    expect([wrong.status, wrong.body.code]).toEqual([404, "assignment_not_found"]);

    const list = await asAdmin("get", "/admin/users").expect(200);
    const staff = (list.body.users as AdminUserView[]).find((u) => u.id === staffId)!;
    expect(staff.roles.map((r) => r.roleKey)).toEqual(["vitals_desk"]); // still there
  });

  it("the scope rules are assignRole's, unchanged: a department scope without a scopeId is refused", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    const { id: staffId } = await mkUser("staff", null);
    await db.insert(roles).values({ key: "vitals_desk", title: "Vitals" }).onConflictDoNothing();

    const refused = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "vitals_desk", scopeType: "department" });
    expect([refused.status, refused.body.code]).toEqual([400, "scope_id_required"]);

    const scoped = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "vitals_desk", scopeType: "department", scopeId: "DEPT-GEN" });
    expect(scoped.status).toBe(201);

    // …and a role key this deployment has never seeded is a sentence, not a foreign-key crash.
    const unknown = await request(server())
      .post(`/admin/users/${staffId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: "no_such_role", scopeType: "hospital" });
    expect([unknown.status, unknown.body.code]).toEqual([404, "role_not_found"]);
  });

  // ═════════ CLOSE C2 — the scope hole the reviewer found, executed at BOTH enforcement points ═════════
  //
  // Every admin route is `@RequirePermission(…, "hospital")`, and `hasPermission` refuses a
  // department- or floor-scoped holding against a hospital requirement. The first version of the
  // invariant counted holders at ANY scope, so its holder set was a SUPERSET of the set that can
  // actually reach the routes — and two authorised requests turned that difference into a
  // permanent lockout. These two legs are that scenario, end to end.

  it("C2 — a DEPARTMENT-scoped admin assignment does not keep the hospital-scoped one revocable", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);

    // Step 1 — give the sole administrator a second assignment of the SAME role at department
    // scope. Entirely legal, and it is what made the old counter see two holdings.
    const listBefore = await asAdmin("get", "/admin/users").expect(200);
    const rootBefore = (listBefore.body.users as AdminUserView[]).find((u) => u.id === adminId)!;
    const hospitalAssignment = rootBefore.roles[0]!.assignmentId;
    await request(server())
      .post(`/admin/users/${adminId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: rootBefore.roles[0]!.roleKey, scopeType: "department", scopeId: "DEPT-GEN" })
      .expect(201);

    // NON-VACUITY: the department grant is real and it is NOT enough on its own. Asserted by
    // execution, because the whole defect was the counter believing otherwise.
    const listMid = await asAdmin("get", "/admin/users").expect(200);
    expect((listMid.body.users as AdminUserView[]).find((u) => u.id === adminId)!.roles).toHaveLength(2);

    // Step 2 — revoke the HOSPITAL-scoped assignment. The old code answered 204 here.
    const refused = await request(server())
      .delete(`/admin/users/${adminId}/roles/${hospitalAssignment}`)
      .set("Authorization", `Bearer ${roleAdminToken}`);
    expect([refused.status, refused.body.code]).toEqual([409, "admin_lockout"]);

    // …and the administrator can still administer. Without this the leg would pass against a
    // controller that refused the revoke and lost the grant anyway.
    await asAdmin("get", "/admin/users").expect(200);
  });

  it("C2 — deactivation is judged the same way: a department-scoped holder is not a holder", async () => {
    const { token: roleAdminToken } = await mkUser("role_admin", [ROLES_MANAGE]);
    const { id: deputyId } = await mkUser("deputy", null);
    const rootRole = ((await asAdmin("get", "/admin/users").expect(200)).body.users as AdminUserView[])
      .find((u) => u.id === adminId)!.roles[0]!.roleKey;

    // A second person holds the admin role — but only over one department.
    await request(server())
      .post(`/admin/users/${deputyId}/roles`).set("Authorization", `Bearer ${roleAdminToken}`)
      .send({ roleKey: rootRole, scopeType: "department", scopeId: "DEPT-GEN" })
      .expect(201);
    // NON-VACUITY: that grant does not let them through the door.
    const deputyLogin = await request(server())
      .post("/auth/login").send({ username: "deputy", password: "s3cret-pass" }).expect(201);
    await request(server()).get("/admin/users")
      .set("Authorization", `Bearer ${deputyLogin.body.token as string}`).expect(403);

    // So deactivating the only hospital-scoped holder must still be refused.
    const refused = await asAdmin("post", `/admin/users/${adminId}/deactivate`);
    expect([refused.status, refused.body.code]).toEqual([409, "admin_lockout"]);
  });

  // ═════════ CLOSE M2 — R4's two missing call sites: the admin reset routes ═════════
  //
  // R4's point is that EVERY path which sets a credential asks the policy. Five paths were named
  // and three were executed; these are the two that were not, and without them `checkPassword` and
  // `checkPin` could be deleted from both reset handlers with the suite still green.

  it("M2/R4 — password-reset applies the policy, and refuses without writing anything", async () => {
    const { token: victimToken, id: victimId } = await mkUser("forgetful", null);
    const short = await asAdmin("post", `/admin/users/${victimId}/password-reset`)
      .send({ newPassword: "abcdefghi" });
    expect([short.status, short.body.problems.map((p: { code: string }) => p.code)]).toEqual([
      400, ["password_too_short"],
    ]);
    // NOTHING MOVED: the old credential still works and the session was not revoked — a refusal
    // that had already reset the password would be worse than no policy at all.
    expect(await verifyPassword(db, "forgetful", "s3cret-pass")).not.toBeNull();
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${victimToken}`).expect(200);

    // …and the USERNAME clause reaches this path too, at length ≥ 10 — so the refusal cannot be
    // the length rule wearing another name. "receptionist" is twelve characters, which is the
    // whole point of choosing it: the floor cannot produce this refusal.
    const { id: recepId } = await mkUser("receptionist", null);
    const asUsername = await asAdmin("post", `/admin/users/${recepId}/password-reset`)
      .send({ newPassword: "RecePTionIST" });
    expect([asUsername.status, asUsername.body.problems.map((p: { code: string }) => p.code)])
      .toEqual([400, ["password_is_username"]]);
    // The accepting control, same length, same path: the route is not refusing everything.
    await asAdmin("post", `/admin/users/${recepId}/password-reset`)
      .send({ newPassword: "a-fine-choice" }).expect(200);
  });

  it("M2/R4 — pin-reset applies the PIN policy, and refuses without writing anything", async () => {
    const { id: victimId } = await mkUser("switcher", null);
    for (const [newPin, code] of [["12ab", "pin_not_digits"], ["123", "pin_wrong_length"], ["1234567", "pin_wrong_length"]]) {
      const res = await asAdmin("post", `/admin/users/${victimId}/pin-reset`).send({ newPin });
      expect([newPin, res.status, res.body.problems.map((p: { code: string }) => p.code)])
        .toEqual([newPin, 400, [code]]);
    }
    // Nothing was written by any of the three refusals…
    expect(await verifyPin(db, victimId, "1234567")).toBe(false);
    // …and the accepting control proves the route is not simply refusing everything.
    await asAdmin("post", `/admin/users/${victimId}/pin-reset`).send({ newPin: "417293" }).expect(204);
    expect(await verifyPin(db, victimId, "417293")).toBe(true);
  });

  // ═══════════ THE TAKEOVER RULE — owner ruling 2026-08-24, closing the reviewer's M6 ═══════════
  //
  // A credential reset is a TAKEOVER: the actor picks the password, so they can sign in as the
  // target. The rule is that an actor's `auth.*` set must be a SUPERSET of the target's. The five
  // legs below are the whole case matrix, and the first is the one a naive "refuse if the target
  // holds anything you lack" rule would have got wrong — it would have killed the feature.

  it("M6 — a delegate resets ordinary staff freely; the line is drawn at auth.*, not at 'anything I lack'", async () => {
    const { token: supervisor } = await mkUser("supervisor", [USERS_MANAGE]);

    // (a) THE FEATURE. A person holding NO auth.* permission is resettable by the delegate, even
    // though this is the whole case a naive "refuse if the target holds anything you lack" rule
    // would have broken — ordinary staff hold billing and OPD permissions the supervisor does not,
    // and authority over billing is not authority over access.
    const { id: plainId } = await mkUser("plain_staff", null);
    await request(server())
      .post(`/admin/users/${plainId}/password-reset`).set("Authorization", `Bearer ${supervisor}`)
      .send({ newPassword: "issued-at-the-desk" }).expect(200);
    expect(await verifyPassword(db, "plain_staff", "issued-at-the-desk")).not.toBeNull();

    // (b) THE LINE. The protected set is the whole `auth.*` manifest, not just the admin two: a
    // target holding `auth.break_glass.use` — real authority over ACCESS to patient data — is
    // refused to a supervisor who does not hold it. The pair (a)/(b) is what pins WHERE the line
    // sits; either leg alone would be satisfied by a rule drawn in the wrong place.
    const { id: breakGlassId } = await mkUser("nurse_on_call", ["auth.break_glass.use"]);
    const res = await request(server())
      .post(`/admin/users/${breakGlassId}/password-reset`).set("Authorization", `Bearer ${supervisor}`)
      .send({ newPassword: "issued-at-the-desk" });
    expect([res.status, res.body.code]).toEqual([409, "admin_target_protected"]);
    expect(await verifyPassword(db, "nurse_on_call", "s3cret-pass")).not.toBeNull(); // untouched
  });

  it("M6 — a delegate CANNOT take over an administrator: the escalation, closed", async () => {
    const { token: supervisor } = await mkUser("supervisor", [USERS_MANAGE]);
    // The owner holds both admin permissions. `adminId` from beforeEach holds USERS_MANAGE only,
    // so a distinct richer actor is minted here.
    const { id: ownerId } = await mkUser("the_owner", [USERS_MANAGE, ROLES_MANAGE]);

    const res = await request(server())
      .post(`/admin/users/${ownerId}/password-reset`).set("Authorization", `Bearer ${supervisor}`)
      .send({ newPassword: "i-would-become-the-owner" });
    expect([res.status, res.body.code]).toEqual([409, "admin_target_protected"]);
    expect(res.body.message).toContain(ROLES_MANAGE); // it NAMES what the actor lacks
    expect(res.body.message).toContain("keep TWO people"); // …and the recovery discipline

    // NOTHING MOVED — the owner's credential is untouched, so the takeover really failed.
    expect(await verifyPassword(db, "the_owner", "s3cret-pass")).not.toBeNull();
    expect(await verifyPassword(db, "the_owner", "i-would-become-the-owner")).toBeNull();

    // …and the PIN route is closed too, or the escalation just moves one door over.
    const pin = await request(server())
      .post(`/admin/users/${ownerId}/pin-reset`).set("Authorization", `Bearer ${supervisor}`)
      .send({ newPin: "417293" });
    expect([pin.status, pin.body.code]).toEqual([409, "admin_target_protected"]);
  });

  it("M6 — a full administrator CAN reset a delegate, and a PEER can reset a peer", async () => {
    // Direction matters: the rule is a subset test, not a "no admin may touch an admin" ban.
    const { token: ownerToken } = await mkUser("the_owner", [USERS_MANAGE, ROLES_MANAGE]);
    const { id: supervisorId } = await mkUser("supervisor", [USERS_MANAGE]);
    await request(server())
      .post(`/admin/users/${supervisorId}/password-reset`).set("Authorization", `Bearer ${ownerToken}`)
      .send({ newPassword: "issued-by-the-owner" }).expect(200);

    // EQUAL authority: nothing is gained by the takeover, so it is allowed. Without this leg the
    // rule could have shipped as "no admin may ever reset an admin", which locks the recovery path.
    const { token: peerA } = await mkUser("peer_a", [USERS_MANAGE]);
    const { id: peerBId } = await mkUser("peer_b", [USERS_MANAGE]);
    await request(server())
      .post(`/admin/users/${peerBId}/password-reset`).set("Authorization", `Bearer ${peerA}`)
      .send({ newPassword: "issued-by-a-peer" }).expect(200);
  });

  it("M6 — the recovery path: two full administrators can reset each other", async () => {
    // THE COST OF THE RULE, asserted rather than assumed. A deployment with ONE full admin has
    // nobody who may reset them; with TWO it is self-repairing, which is why the refusal message
    // names that discipline.
    const { token: ownerA } = await mkUser("owner_a", [USERS_MANAGE, ROLES_MANAGE]);
    const { id: ownerBId } = await mkUser("owner_b", [USERS_MANAGE, ROLES_MANAGE]);
    await request(server())
      .post(`/admin/users/${ownerBId}/password-reset`).set("Authorization", `Bearer ${ownerA}`)
      .send({ newPassword: "repaired-by-the-other" }).expect(200);
    expect(await verifyPassword(db, "owner_b", "repaired-by-the-other")).not.toBeNull();
  });

  it("M6 — the protected set is READ FROM THE MANIFEST, so a seventh auth.* is covered on arrival", () => {
    // §2.54: one copy of the fact. A hand-listed set would silently stop protecting the next
    // permission somebody declares.
    expect([...authManifest.permissions].sort()).toEqual([
      "auth.agents.manage", "auth.break_glass.review", "auth.break_glass.use",
      "auth.roles.manage", "auth.temp_role.grant", "auth.users.manage",
    ]);
  });
});
