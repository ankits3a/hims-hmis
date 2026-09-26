import { Test } from "@nestjs/testing";
import { Controller, INestApplication, Post } from "@nestjs/common";
import request from "supertest";
import { authenticator } from "otplib";
import { asc, eq, gt } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser, rotateBadge, setPin } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { confirmTotp, enrollTotp } from "../src/kernel/auth/totp";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { AUTH_AUDIT_EVENTS } from "../src/kernel/auth/events";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { authSessions, events } from "../src/kernel/db/schema";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

@Controller("audit-stepup-probe")
class StepupProbeController {
  @RequirePermission("auth.roles.manage", "hospital", { secondFactor: true })
  @Post("act")
  act(): { ok: boolean } { return { ok: true }; }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-05 — EVERY AUTHENTICATION ACT LEAVES A ROW, AND THE ROW SAYS WHERE IT CAME FROM
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Before this, `kernel/auth/events.ts` carried break-glass, SoD, elevation, temp-role and user
 * admin events and NOT ONE for a login, a logout, a terminal switch or a TOTP act. Failures lived
 * only in `auth_throttle`, which is deleted on success and pruned after an hour, and no request in
 * the whole app knew its client's address: every one looked as if it came from the Caddy container.
 *
 * The app is built through `configureApp`, because that is where `trust proxy` is set — the same
 * place production takes it from. Supertest connects over loopback, which stands in for the Caddy
 * hop (`DEFAULT_TRUSTED_PROXY_CIDRS` trusts loopback and the Docker bridge ranges, ONE hop only).
 *
 * THE TWO THINGS A FAILURE ROW MUST NOT SAY are asserted by value, not by eye: the password that
 * was tried, and whether the username that was tried belongs to anybody.
 */
describe("WASA M-05 — authentication events", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
  const CLIENT_IP = "203.0.113.7";
  const UA = "Mozilla/5.0 (WASA probe) Desk-One";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [StepupProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  type Row = { name: string; actorType: string; actorId: string; payload: Record<string, unknown> };
  async function authEventsSince(seq: number): Promise<Row[]> {
    const rows = await db
      .select({ name: events.name, actorType: events.actorType, actorId: events.actorId, payload: events.payload, module: events.module })
      .from(events).where(gt(events.seq, seq)).orderBy(asc(events.seq));
    return rows
      .filter((r) => r.name.startsWith("auth."))
      .map((r) => {
        expect(r.module).toBe("auth");
        return { name: r.name, actorType: r.actorType, actorId: r.actorId, payload: r.payload as Record<string, unknown> };
      });
  }
  async function highWater(): Promise<number> {
    const rows = await db.select({ seq: events.seq }).from(events).orderBy(asc(events.seq));
    return rows.length === 0 ? 0 : Number(rows[rows.length - 1]!.seq);
  }

  it("declares the catalogue — every name `auth.*`, module `auth`, version 1", () => {
    expect(AUTH_AUDIT_EVENTS.map((e) => e.name).sort()).toEqual([
      "auth.badge_switched",
      "auth.logged_out",
      "auth.login_failed",
      "auth.login_succeeded",
      "auth.pin_switched",
      "auth.session_revoked",
      "auth.totp_confirmed",
      "auth.totp_enrolled",
      "auth.totp_failed",
      "auth.totp_verified",
    ]);
    for (const e of AUTH_AUDIT_EVENTS) expect([e.name, e.module, e.version]).toEqual([e.name, "auth", 1]);
  });

  it("a password login records the session's client, and the event names the user, the IP and the agent", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass-xyz" });
    const before = await highWater();
    const login = await http().post("/auth/login")
      .set("x-forwarded-for", CLIENT_IP).set("user-agent", UA)
      .send({ username: "asha", password: "s3cret-pass-xyz", terminalId: "counter-3" }).expect(201);
    expect(typeof login.body.token).toBe("string");

    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, id));
    expect(sessions).toHaveLength(1);
    expect([sessions[0]!.clientIp, sessions[0]!.userAgent]).toEqual([CLIENT_IP, UA]);

    const rows = await authEventsSince(before);
    expect(rows).toEqual([{
      name: "auth.login_succeeded", actorType: "user", actorId: id,
      payload: { userId: id, sessionId: sessions[0]!.id, method: "password", terminalId: "counter-3", ip: CLIENT_IP, userAgent: UA },
    }]);
  });

  it("ONE proxy hop is trusted, never the client's own X-Forwarded-For entries", async () => {
    await createUser(db, { username: "ravi", fullName: "Ravi", password: "s3cret-pass-xyz" });
    // A client forging "I am 10.0.0.1" puts it LEFT of what the edge appends. Only the entry the
    // trusted hop wrote — the rightmost — may become the address.
    await http().post("/auth/login")
      .set("x-forwarded-for", `10.0.0.1, 198.51.100.4, ${CLIENT_IP}`)
      .send({ username: "ravi", password: "s3cret-pass-xyz" }).expect(201);
    const [session] = await db.select().from(authSessions);
    expect(session!.clientIp).toBe(CLIENT_IP);
  });

  it("a failed login names the method, the submitted username, the terminal and the client — never the password", async () => {
    await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass-xyz" });
    const before = await highWater();
    await http().post("/auth/login").set("x-forwarded-for", CLIENT_IP).set("user-agent", UA)
      .send({ username: "asha", password: "WRONG-guess-4471", terminalId: "counter-3" }).expect(401);
    const rows = await authEventsSince(before);
    expect(rows).toEqual([{
      name: "auth.login_failed", actorType: "system", actorId: "auth",
      payload: { method: "password", username: "asha", terminalId: "counter-3", ip: CLIENT_IP, userAgent: UA },
    }]);
    expect(JSON.stringify(rows)).not.toContain("WRONG-guess-4471");
  });

  it("an unknown username fails with a row IDENTICAL in shape to a known one — the log is no membership oracle", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass-xyz" });
    const before = await highWater();
    await http().post("/auth/login").send({ username: "asha", password: "nope-nope-nope" }).expect(401);
    await http().post("/auth/login").send({ username: "nobody-here", password: "nope-nope-nope" }).expect(401);
    const [known, unknown] = await authEventsSince(before);
    expect(Object.keys(known!.payload).sort()).toEqual(Object.keys(unknown!.payload).sort());
    expect([known!.actorType, known!.actorId]).toEqual([unknown!.actorType, unknown!.actorId]);
    expect(JSON.stringify(known)).not.toContain(id);
  });

  it("a hostile username is bounded before it reaches a 120-month table", async () => {
    const before = await highWater();
    await http().post("/auth/login").send({ username: "u".repeat(5000), password: "x" }).expect(401);
    const [row] = await authEventsSince(before);
    expect((row!.payload.username as string).length).toBe(128);
  });

  it("logout is evented with the session it ended", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass-xyz" });
    const login = await http().post("/auth/login").send({ username: "asha", password: "s3cret-pass-xyz" }).expect(201);
    const [session] = await db.select().from(authSessions);
    const before = await highWater();
    await http().post("/auth/logout").set("authorization", `Bearer ${login.body.token as string}`)
      .set("x-forwarded-for", CLIENT_IP).set("user-agent", UA).expect(204);
    expect(await authEventsSince(before)).toEqual([{
      name: "auth.logged_out", actorType: "user", actorId: id,
      payload: { userId: id, sessionId: session!.id, ip: CLIENT_IP, userAgent: UA },
    }]);
  });

  // WASA L-07: a switch ends only the session whose bearer token is PRESENTED — no longer every
  // session on the terminal — so the outgoing user's token is sent, and that one session is evented.
  it("a PIN switch records who came in, and the session it replaced — the one whose token was presented", async () => {
    const { id: first } = await createUser(db, { username: "first", fullName: "F", password: "s3cret-pass-xyz" });
    const { id: second } = await createUser(db, { username: "second", fullName: "S", password: "s3cret-pass-xyz" });
    await setPin(db, second, "482913");
    const login = await http().post("/auth/login").send({ username: "first", password: "s3cret-pass-xyz", terminalId: "counter-1" }).expect(201);
    const [outgoing] = await db.select().from(authSessions).where(eq(authSessions.userId, first));

    const before = await highWater();
    await http().post("/auth/switch/pin").set("x-forwarded-for", CLIENT_IP).set("user-agent", UA)
      .set("authorization", `Bearer ${login.body.token as string}`)
      .send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
    const [incoming] = await db.select().from(authSessions).where(eq(authSessions.userId, second));
    expect([incoming!.clientIp, incoming!.userAgent]).toEqual([CLIENT_IP, UA]);

    expect(await authEventsSince(before)).toEqual([
      {
        name: "auth.pin_switched", actorType: "user", actorId: second,
        payload: { userId: second, sessionId: incoming!.id, terminalId: "counter-1", terminalSessionsRevoked: 1, ip: CLIENT_IP, userAgent: UA },
      },
      {
        name: "auth.session_revoked", actorType: "user", actorId: second,
        payload: { sessionId: outgoing!.id, userId: first, reason: "terminal_switch", terminalId: "counter-1" },
      },
    ]);
  });

  it("a wrong PIN is a login_failed with method pin, and names no user id", async () => {
    const { id } = await createUser(db, { username: "second", fullName: "S", password: "s3cret-pass-xyz" });
    await setPin(db, id, "482913");
    const before = await highWater();
    await http().post("/auth/switch/pin").send({ username: "second", pin: "000111", terminalId: "counter-1" }).expect(401);
    const rows = await authEventsSince(before);
    expect(rows.map((r) => [r.name, r.payload.method, r.payload.username, r.payload.terminalId]))
      .toEqual([["auth.login_failed", "pin", "second", "counter-1"]]);
    expect(JSON.stringify(rows)).not.toContain("000111");
    expect(JSON.stringify(rows)).not.toContain(id);
  });

  it("a badge switch is evented; a forged badge is a login_failed that does not repeat the token", async () => {
    const { id } = await createUser(db, { username: "badger", fullName: "B", password: "s3cret-pass-xyz" });
    const { badgeToken } = await rotateBadge(db, cfg, id);
    const before = await highWater();
    await http().post("/auth/switch/badge").set("x-forwarded-for", CLIENT_IP)
      .send({ badgeToken, terminalId: "ward-2" }).expect(201);
    const forged = `${badgeToken.slice(0, -4)}AAAA`;
    await http().post("/auth/switch/badge").send({ badgeToken: forged, terminalId: "ward-2" }).expect(401);
    const rows = await authEventsSince(before);
    expect(rows.map((r) => [r.name, r.actorType])).toEqual([["auth.badge_switched", "user"], ["auth.login_failed", "system"]]);
    expect(rows[0]!.payload).toMatchObject({ userId: id, terminalId: "ward-2", terminalSessionsRevoked: 0, ip: CLIENT_IP });
    expect(rows[1]!.payload).toMatchObject({ method: "badge", username: null, terminalId: "ward-2" });
    expect(JSON.stringify(rows)).not.toContain(badgeToken);
    expect(JSON.stringify(rows)).not.toContain(forged);
  });

  /** WASA M-02 — a first factor is enrolled with the account password as proof; the secret comes back on success. */
  async function enrolWithPassword(userId: string, password: string): Promise<string> {
    const r = await enrollTotp(db, cfg, userId, { password });
    if (!r.ok) throw new Error(`enrolment refused: ${r.reason}`);
    return r.secret;
  }

  it("TOTP enrolment is evented, and the secret it minted is nowhere in the row", async () => {
    const { id } = await createUser(db, { username: "enrol", fullName: "E", password: "s3cret-pass-xyz" });
    const { token } = await createSession(db, cfg, id);
    const before = await highWater();
    // WASA M-02: enrolling a first factor needs the account password as proof.
    const res = await http().post("/auth/totp/enroll").set("authorization", `Bearer ${token}`)
      .set("x-forwarded-for", CLIENT_IP).send({ password: "s3cret-pass-xyz" }).expect(201);
    const secret = new URL(res.body.otpauthUrl as string).searchParams.get("secret")!;
    expect(secret.length).toBeGreaterThan(10);
    const rows = await authEventsSince(before);
    expect(rows.map((r) => [r.name, r.actorId, r.payload.userId, r.payload.ip])).toEqual([["auth.totp_enrolled", id, id, CLIENT_IP]]);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("TOTP confirm and verify: a wrong code is totp_failed at its stage, a right one is its success", async () => {
    const { id } = await createUser(db, { username: "totp", fullName: "T", password: "s3cret-pass-xyz" });
    const { token } = await createSession(db, cfg, id);
    const secret = await enrolWithPassword(id, "s3cret-pass-xyz");
    const auth = `Bearer ${token}`;
    const now = Date.now();
    const before = await highWater();

    await http().post("/auth/totp/confirm").set("authorization", auth).send({ code: "12345x" }).expect(403);
    await http().post("/auth/totp/confirm").set("authorization", auth)
      .send({ code: authenticator.clone({ epoch: now }).generate(secret) }).expect(204);
    await http().post("/auth/totp/verify").set("authorization", auth).send({ code: "12345x" }).expect(403);
    await http().post("/auth/totp/verify").set("authorization", auth)
      .send({ code: authenticator.clone({ epoch: now + 30_000 }).generate(secret) }).expect(204);

    const rows = await authEventsSince(before);
    expect(rows.map((r) => [r.name, r.payload.stage ?? r.payload.via ?? null])).toEqual([
      ["auth.totp_failed", "confirm"],
      ["auth.totp_confirmed", null],
      ["auth.totp_failed", "verify_route"],
      ["auth.totp_verified", "verify_route"],
    ]);
    for (const r of rows) expect([r.actorType, r.actorId, r.payload.userId]).toEqual(["user", id, id]);
  });

  it("the X-Totp-Code step-up on a guarded route is evented too — the brute-force path M-02 names", async () => {
    const { id } = await createUser(db, { username: "signer", fullName: "S", password: "s3cret-pass-xyz" });
    await createRole(db, "signer", "Signer");
    await grantPermissionToRole(db, registry, "signer", "auth.roles.manage");
    await assignRole(db, { userId: id, roleKey: "signer", scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    const secret = await enrolWithPassword(id, "s3cret-pass-xyz");
    const now = Date.now();
    await confirmTotp(db, cfg, id, authenticator.clone({ epoch: now }).generate(secret));
    const before = await highWater();

    // No code at all is the ordinary "please step up" prompt, not an attempt — no row.
    await http().post("/audit-stepup-probe/act").set("authorization", `Bearer ${token}`).expect(403);
    await http().post("/audit-stepup-probe/act").set("authorization", `Bearer ${token}`)
      .set("x-totp-code", "12345x").set("x-forwarded-for", CLIENT_IP).expect(403);
    await http().post("/audit-stepup-probe/act").set("authorization", `Bearer ${token}`)
      .set("x-totp-code", authenticator.clone({ epoch: now + 30_000 }).generate(secret)).expect(201);

    const rows = await authEventsSince(before);
    expect(rows.map((r) => [r.name, r.payload.stage ?? r.payload.via, r.payload.ip])).toEqual([
      ["auth.totp_failed", "step_up_header", CLIENT_IP],
      ["auth.totp_verified", "step_up_header", "127.0.0.1"],
    ]);
  });
});
