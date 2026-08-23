import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq, isNull, and } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser, deactivateUser, reactivateUser, setPassword } from "../src/kernel/auth/identity";
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
 * and `POST /auth/change-password` do not exist yet — they land in T3 and T2. T1's acceptance says
 * so in as many words: the flag-clearing unit is exercised directly here and the routes re-run
 * these legs at their own seams (R9 in T3). Writing the flag with `setPassword` is not a
 * convenience, it is the only honest way to test a guard before the routes it guards exist.
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

    // LEG TWO — the exempt route is REACHED. 404 would mean the guard let it through and Nest
    // found no handler; before T2 lands there IS no handler, so what is asserted is precisely
    // "not 403": the guard admitted it. T2 turns this into a 204 and re-asserts it at its own seam.
    const exempt = await request(server())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "issued-by-the-admin", newPassword: "irrelevant-here" });
    expect(exempt.status).not.toBe(403);

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
});
