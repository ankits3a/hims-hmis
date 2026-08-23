import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser, setPin, rotateBadge, deactivateUser, reactivateUser, setPassword } from "./identity";
import {
  createSession, findLiveSession, revokeSession, revokeUserSessions, revokeTerminalSessions,
  loginWithPassword, switchWithPin, switchWithBadge,
} from "./sessions";
import { loadConfig } from "../config";
import { authSessions } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("sessions", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  async function mkUser(username = "asha"): Promise<string> {
    const { id } = await createUser(db, { username, fullName: "U", password: "s3cret-pass" });
    return id;
  }

  it("creates and finds a live session by opaque token", async () => {
    const userId = await mkUser();
    const { token, sessionId } = await createSession(db, cfg, userId, "counter-1");
    const live = await findLiveSession(db, token);
    expect(live).toEqual({
      sessionId, userId, terminalId: "counter-1", secondFactorAt: null, mustChangePassword: false,
    });
    expect(await findLiveSession(db, "not-a-token")).toBeNull();
  });

  // ───────────────────── PLAN 11e D1 — what the choke point learned ─────────────────────
  //
  // THESE TWO ARE THE WEBSOCKET'S COVERAGE AS WELL AS HTTP's. `realtime/gateway.ts`'s auth handler
  // has exactly one decision to make about a token and it makes it from THIS function's return
  // value — null closes the socket 4001, `mustChangePassword` closes it 4001 — so the contract
  // asserted here is the whole of what the gateway can see. Driving a real socket to re-assert it
  // would test `ws`, not the rule.

  it("an INACTIVE user's still-valid session resolves to null — at the choke point, not at the caller", async () => {
    const userId = await mkUser("retiring");
    const { token } = await createSession(db, cfg, userId);
    expect(await findLiveSession(db, token)).not.toBeNull();

    await deactivateUser(db, userId);
    // The row is untouched — not revoked, not expired. Before 11e this token kept full authority
    // for the rest of SESSION_TTL_MINUTES on every HTTP route and on the socket (plan 11e §3 Q5).
    const [row] = await db
      .select({ revokedAt: authSessions.revokedAt })
      .from(authSessions)
      .where(eq(authSessions.userId, userId));
    expect(row!.revokedAt).toBeNull();
    expect(await findLiveSession(db, token)).toBeNull();

    // …and reactivation restores the SAME session, which is the proof that the refusal is a live
    // join and not a one-way write somewhere.
    await reactivateUser(db, userId);
    expect((await findLiveSession(db, token))!.userId).toBe(userId);
  });

  it("mustChangePassword is carried as DATA — the session still resolves, so the change can be made on it", async () => {
    const userId = await mkUser("resetting");
    const { token } = await createSession(db, cfg, userId);
    await setPassword(db, userId, "temp-issued-by-admin", { mustChangePassword: true });

    const live = await findLiveSession(db, token);
    expect(live).not.toBeNull(); // NOT null: the flag is a route-level refusal, never a dead session
    expect(live!.mustChangePassword).toBe(true);

    await setPassword(db, userId, "the-one-they-chose", { mustChangePassword: false });
    expect((await findLiveSession(db, token))!.mustChangePassword).toBe(false);
  });

  it("revoked and expired sessions are not live", async () => {
    const userId = await mkUser();
    const { token, sessionId } = await createSession(db, cfg, userId);
    await revokeSession(db, sessionId);
    expect(await findLiveSession(db, token)).toBeNull();

    const s2 = await createSession(db, cfg, userId);
    await db.update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.id, s2.sessionId));
    expect(await findLiveSession(db, s2.token)).toBeNull(); // past expiry ⇒ not live
  });

  it("revokeUserSessions kills every session of that user", async () => {
    const userId = await mkUser();
    const a = await createSession(db, cfg, userId);
    const b = await createSession(db, cfg, userId);
    expect(await revokeUserSessions(db, userId)).toBe(2);
    expect(await findLiveSession(db, a.token)).toBeNull();
    expect(await findLiveSession(db, b.token)).toBeNull();

    const c = await createSession(db, cfg, userId, "counter-9");
    const d = await createSession(db, cfg, userId, "counter-9");
    expect(await revokeTerminalSessions(db, "counter-9")).toBe(2);
    expect(await findLiveSession(db, c.token)).toBeNull();
    expect(await findLiveSession(db, d.token)).toBeNull();
  });

  it("loginWithPassword returns a token only on valid credentials", async () => {
    await mkUser("ravi");
    expect(await loginWithPassword(db, cfg, { username: "ravi", password: "wrong" })).toBeNull();
    const ok = await loginWithPassword(db, cfg, { username: "ravi", password: "s3cret-pass" });
    expect(ok).not.toBeNull();
    expect(await findLiveSession(db, ok!.token)).not.toBeNull();
  });

  it("fast-switch is an identity change: prior terminal sessions die", async () => {
    const u1 = await mkUser("first");
    const u2 = await mkUser("second");
    await setPin(db, u2, "482913");
    const s1 = await loginWithPassword(db, cfg, { username: "first", password: "s3cret-pass", terminalId: "ward-3" });
    const switched = await switchWithPin(db, cfg, { username: "second", pin: "482913", terminalId: "ward-3" });
    expect(switched).not.toBeNull();
    expect(await findLiveSession(db, s1!.token)).toBeNull(); // outgoing user is gone
    expect((await findLiveSession(db, switched!.token))!.userId).toBe(u2);
    expect(u1).not.toBe(u2);
  });

  it("badge switch resolves the badge and switches identity", async () => {
    const u1 = await mkUser("first");
    await mkUser("second");
    const badge = await rotateBadge(db, cfg, u1);
    const outgoing = await loginWithPassword(db, cfg, { username: "second", password: "s3cret-pass", terminalId: "ward-3" });
    const s = await switchWithBadge(db, cfg, { badgeToken: badge.badgeToken, terminalId: "ward-3" });
    expect((await findLiveSession(db, s!.token))!.userId).toBe(u1);
    expect(await findLiveSession(db, outgoing!.token)).toBeNull(); // outgoing user is gone
    expect(await switchWithBadge(db, cfg, { badgeToken: "b1.fake.1.sig", terminalId: "ward-3" })).toBeNull();
  });
});
