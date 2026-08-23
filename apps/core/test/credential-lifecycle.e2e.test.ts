import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq, isNull, and } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  createUser, deactivateUser, reactivateUser, setPassword, verifyPassword,
} from "../src/kernel/auth/identity";
import { revokeUserSessions } from "../src/kernel/auth/sessions";
import { authSessions } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 11e T1 — THE CHOKE POINT, OVER HTTP.
 *
 * Everything here is driven through the real `AuthGuard` on a real Nest app, because the whole of
 * D1 is a claim about what happens to a REQUEST — and the two facts it added (`active` and
 * `mustChangePassword`) were both, before this phase, invisible to every request the system
 * served. `sessions.test.ts` asserts the same two facts at the function's own contract, which is
 * where the WebSocket's coverage lives; this file asserts what a person with a token can DO.
 *
 * WHY THE FLAG IS SET BY A DIRECT CALL AND NOT BY A ROUTE. `POST /admin/users/:id/password-reset`
 * lands in T3; until it does, `setPassword` is the only honest way to put a session into the state
 * this file exists to test. `POST /auth/change-password` shipped with T2 and IS driven over HTTP
 * here — R4, R5 and R6's change-password legs are at the foot of this file.
 *
 * ═══ R3 HAS NO MUTANT, AND THAT IS RECORDED RATHER THAN GLOSSED ═══
 *
 * "Deactivation composed with revocation leaves zero live sessions" is asserted BY COUNT from
 * `auth_sessions` here, because in T1 nothing composes them — `deactivateUser` and
 * `revokeUserSessions` are two functions with no caller between them. The composing seam is T3's
 * deactivate endpoint, and the row re-runs there against a mutant that drops the revoke.
 */
describe("credential lifecycle e2e (HTTP) — deactivation, forced reset, and the two exempt routes", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await app.close(); await teardown(); });

  const server = (): ReturnType<INestApplication["getHttpServer"]> => app.getHttpServer();

  /** Mints a user and logs them in over the REAL login route — never `createSession` directly. */
  async function login(username: string, password: string): Promise<string> {
    const res = await request(server()).post("/auth/login").send({ username, password }).expect(201);
    return res.body.token as string;
  }

  const liveSessionCount = async (userId: string): Promise<number> => {
    const rows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
    return rows.length;
  };

  // ═════════════════════════════════ R1 — deactivation bites ══════════════════════════════════

  it("R1 — a deactivated user's still-valid token is refused on its NEXT request", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    const token = await login("asha", "s3cret-pass");
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);

    await deactivateUser(db, id);

    // THE SESSION ROW IS UNTOUCHED — this is the discriminating input, and it is the one the
    // pre-11e code passed: nothing revoked it, nothing expired it, and it still answered 200.
    expect(await liveSessionCount(id)).toBe(1);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(401);

    // Reactivation brings the same token back, which pins the refusal to the live join rather than
    // to some destructive side effect of `deactivateUser`.
    await reactivateUser(db, id);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
  });

  // ══════════ R2 — must-change refuses guarded work AND admits the exempt routes ══════════
  //
  // TWO-SIDED ON PURPOSE. A one-legged version of this row is vacuous: a guard that refuses
  // EVERYTHING passes the refusal leg, and a guard that refuses NOTHING passes the admission leg.
  // Mutant A (no refusal) dies below; mutant B (no exemption) dies below. Both legs, one `it`, so
  // neither can be deleted without the other going with it.

  it("R2 — must-change 403s guarded work by NAME, and the two exempt routes still answer", async () => {
    const { id } = await createUser(db, { username: "ravi", fullName: "Ravi", password: "s3cret-pass" });
    const token = await login("ravi", "s3cret-pass");
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);

    await setPassword(db, id, "issued-by-the-admin", { mustChangePassword: true });

    // LEG ONE — a guarded route, refused, and the MESSAGE is asserted rather than the bare status:
    // a 403 is also what a missing permission produces, and the screen (T6) routes on this string.
    const refused = await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect([refused.status, refused.body.message]).toEqual([403, "password_change_required"]);

    // LEG TWO — the exempt route is REACHED, AND IT WORKS. Written in T1 as "not 403" because the
    // handler did not exist yet; T2 shipped it, so this is now the real thing: the person locked
    // out of every other route can still perform the one act that unlocks them.
    await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "issued-by-the-admin", newPassword: "the-one-they-chose" })
      .expect(204);
    // …and the whole surface came back, on the SAME token, with no re-login.
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);

    // Put it back for the logout leg below: this test's remaining assertions are about a
    // must-change session, and the change above cleared the flag.
    await setPassword(db, id, "issued-by-the-admin", { mustChangePassword: true });
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(403);

    // …and logout, the other exemption, which must WORK rather than merely be reached: a person
    // handed a temporary password has to be able to put the terminal down.
    await request(server()).post("/auth/logout").set("Authorization", `Bearer ${token}`).expect(204);
    expect(await liveSessionCount(id)).toBe(0);
  });

  it("R2b — clearing the flag restores the whole surface, on the SAME session", async () => {
    const { id } = await createUser(db, { username: "meena", fullName: "Meena", password: "s3cret-pass" });
    const token = await login("meena", "s3cret-pass");
    await setPassword(db, id, "issued-by-the-admin", { mustChangePassword: true });
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(403);

    // The clearing act, exercised directly (T2 ships the route). The SESSION IS NOT REPLACED —
    // this is D1's claim that completing the change needs no re-login, and it is why the flag is
    // data on the session rather than a reason to refuse resolving it.
    await setPassword(db, id, "the-one-they-chose", { mustChangePassword: false });
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
  });

  // ═══════════════ R3 — deactivation composed with revocation leaves nothing live ═══════════════

  it("R3 — deactivate + revokeUserSessions leaves ZERO live sessions for the target (by count)", async () => {
    const { id } = await createUser(db, { username: "leaving", fullName: "Leaving", password: "s3cret-pass" });
    const a = await login("leaving", "s3cret-pass");
    const b = await login("leaving", "s3cret-pass");
    const c = await login("leaving", "s3cret-pass");
    expect(await liveSessionCount(id)).toBe(3);

    // The two halves T3's endpoint composes into one flow. Here they are two calls, because in T1
    // that is all they are — nothing in the shipped tree calls both.
    await deactivateUser(db, id);
    expect(await revokeUserSessions(db, id)).toBe(3);

    expect(await liveSessionCount(id)).toBe(0);
    for (const token of [a, b, c]) {
      await request(server()).get("/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
    }

    // BOTH BELTS, SEPARATELY OBSERVABLE (D1/Q5): reactivating WITHOUT unrevoking leaves every
    // token dead — so the revocation is doing its own work and the join is not covering for it.
    await reactivateUser(db, id);
    expect(await liveSessionCount(id)).toBe(0);
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${a}`).expect(401);
  });

  // ═══════════════ T2 — POST /auth/change-password: R4, R5 and R6 at THIS path ═══════════════
  //
  // R4's point is per-PATH coverage: the policy unit (`password-policy.test.ts`) proves the RULE,
  // and these legs prove this route actually asks. A policy module nobody calls is the defect 11e
  // exists to close, restated one level up.

  it("R4 — the change-password route applies the policy: nine refused, ten accepted", async () => {
    await createUser(db, { username: "priya", fullName: "Priya", password: "s3cret-pass" });
    const token = await login("priya", "s3cret-pass");

    const nine = await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "s3cret-pass", newPassword: "abcdefghi" });
    expect(nine.status).toBe(400);
    expect(nine.body.code).toBe("password_policy");
    expect(nine.body.problems.map((p: { code: string }) => p.code)).toEqual(["password_too_short"]);

    await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "s3cret-pass", newPassword: "abcdefghij" })
      .expect(204);
    // The refusal really did refuse: the OLD password is what still works after the 400 above,
    // and the NEW one works after the 204. Without this pair a route that ignored the policy and
    // a route that ignored the request entirely would look identical.
    await request(server()).post("/auth/login").send({ username: "priya", password: "abcdefghij" }).expect(201);
    await request(server()).post("/auth/login").send({ username: "priya", password: "abcdefghi" }).expect(401);
  });

  it("R6 — the username is refused at this path too, even at length ≥ 10", async () => {
    await createUser(db, { username: "receptionist", fullName: "Recep", password: "s3cret-pass" });
    const token = await login("receptionist", "s3cret-pass");
    const res = await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "s3cret-pass", newPassword: "RecePTionIST" });
    expect([res.status, res.body.problems.map((p: { code: string }) => p.code)]).toEqual([
      400, ["password_is_username"],
    ]);
    // …and a top-20 entry, which the ten-character floor cannot catch.
    const common = await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "s3cret-pass", newPassword: "1234567890" });
    expect(common.body.problems.map((p: { code: string }) => p.code)).toEqual(["password_is_common"]);
  });

  it("R5 — a WRONG current password is refused, clears nothing, and revokes nothing", async () => {
    const { id } = await createUser(db, { username: "vikram", fullName: "Vikram", password: "s3cret-pass" });
    const here = await login("vikram", "s3cret-pass");
    const elsewhere = await login("vikram", "s3cret-pass");
    await setPassword(db, id, "issued-by-the-admin", { mustChangePassword: true });
    expect(await liveSessionCount(id)).toBe(2);

    const res = await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${here}`)
      .send({ currentPassword: "not-the-current-one", newPassword: "a-perfectly-fine-one" });
    expect([res.status, res.body.message]).toEqual([403, "current_password_incorrect"]);

    // NOTHING MOVED — three separate reads, because R5's mutant (a handler that validates the new
    // password and skips the current-password check) would have moved all three.
    expect(await liveSessionCount(id)).toBe(2);                                  // revoked nothing
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${here}`).expect(403); // flag intact
    expect(await verifyPassword(db, "vikram", "issued-by-the-admin")).not.toBeNull(); // wrote nothing
    expect(await verifyPassword(db, "vikram", "a-perfectly-fine-one")).toBeNull();
    expect(elsewhere).not.toBe(here);
  });

  it("a successful change kills every OTHER session of that user and keeps THIS one", async () => {
    const { id } = await createUser(db, { username: "sunita", fullName: "Sunita", password: "s3cret-pass" });
    const here = await login("sunita", "s3cret-pass");
    const elsewhere = await login("sunita", "s3cret-pass");
    const alsoElsewhere = await login("sunita", "s3cret-pass");

    await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${here}`)
      .send({ currentPassword: "s3cret-pass", newPassword: "a-brand-new-one" })
      .expect(204);

    // BOTH DIRECTIONS IN ONE LEG. Only the refusal legs would pass against a handler that revoked
    // everything including the caller — which is the shape a person mid-repair cannot survive.
    await request(server()).get("/auth/me").set("Authorization", `Bearer ${here}`).expect(200);
    for (const dead of [elsewhere, alsoElsewhere]) {
      await request(server()).get("/auth/me").set("Authorization", `Bearer ${dead}`).expect(401);
    }
    expect(await liveSessionCount(id)).toBe(1);
  });
});
