import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  alerts, approvalTypes, approvals, authSessions, events, roles, rosterTeamMemberships, rosterTeams, users,
  workflowDefinitions, workflowInstances,
} from "../src/kernel/db/schema";
import { sweepOverdueApprovals } from "../src/kernel/approvals/overdue";
import { orgDepartmentByCode, ROSTER_POSITIONS, seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { teamOf } from "../src/kernel/desk/home.controller";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * APP HOME (owner 2026-10-07, decision 0042) — the server's share of the staff app's first screen.
 *
 * What is proved: an approval carries the deadline of its KIND; a money approval decided from a
 * PHONE needs a step-up on that same session inside two minutes, and a browser is untouched; the
 * step-up is evented and a wrong password is refused; a supervisor's team card holds their own
 * people only; and the month's brief carries the day-by-day line.
 */
describe("app home — deadlines, the step-up before a money approval, the team card", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(approvalsManifest);
  const PW = "s3cret-pass-xyz";
  const PHONE_A = { deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", model: "Redmi Note 12", os: "Android 14", appVersion: "0.9.0 (12)" };
  const PHONE_B = { deviceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", model: "Samsung A15", os: "Android 15", appVersion: "0.9.0 (12)" };
  const DEF_JSON = {
    key: "approval_billing_refund", title: "Refund", changeClass: "C", initialState: "pending",
    states: [{ name: "pending", sla: { minutes: 45, alerting: "active" } }, { name: "granted", terminal: true }, { name: "rejected", terminal: true }],
    transitions: [{ from: "pending", to: "granted", roles: ["billing_head"] }, { from: "pending", to: "rejected", roles: ["billing_head"] }],
  };
  let headId: string; let askerId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    ({ id: headId } = await createUser(db, { username: "head", fullName: "Billing Head", password: PW }));
    ({ id: askerId } = await createUser(db, { username: "asker", fullName: "Asha Devi", password: PW }));
    await db.insert(roles).values({ key: "billing_head", title: "billing_head" }).onConflictDoNothing();
    await grantPermissionToRole(db, registry, "billing_head", "approvals.requests.read");
    await grantPermissionToRole(db, registry, "billing_head", "approvals.requests.decide");
    await assignRole(db, { userId: headId, roleKey: "billing_head", scopeType: "hospital" });
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const login = (username: string, device?: Record<string, unknown>) =>
    http().post("/auth/login").send({ username, password: PW, ...(device === undefined ? {} : { device }) });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const stepUp = (token: string, body: Record<string, unknown>) => http().post("/auth/step-up").set(bearer(token)).send(body);
  const approve = (token: string, id: string) => http().post(`/approvals/${id}/approve`).set(bearer(token)).send({ note: "checked with billing" });
  const reject = (token: string, id: string) => http().post(`/approvals/${id}/reject`).set(bearer(token)).send({ note: "not this one" });

  let seq = 0;
  /** A pending request of a kind, asked `minutesAgo`. The workflow rows exist; the instance is in `pending`. */
  async function ask(typeKey: string, amountPaise: number | null, minutesAgo = 5): Promise<string> {
    seq += 1;
    const instanceId = `01HINST${String(seq).padStart(19, "0")}`;
    const id = `01HAP${String(seq).padStart(21, "0")}`;
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "approval_billing_refund", version: 1,
      title: "Refund", changeClass: "C", definition: DEF_JSON, draftedBy: askerId,
    }).onConflictDoNothing();
    await db.insert(approvalTypes).values({ typeKey, title: typeKey, defKey: `approval_${typeKey}`, approverRole: "billing_head", createdBy: askerId }).onConflictDoNothing();
    await db.insert(workflowInstances).values({
      id: instanceId, definitionId: "01HDEF000000000000000000A", defKey: "approval_billing_refund", currentState: "pending",
      subjectType: "invoice", subjectId: `inv${String(seq)}`, stateEnteredAt: new Date(),
    });
    await db.insert(approvals).values({
      id, typeKey, instanceId, requesterId: askerId, approverRole: "billing_head", urgencyClass: "routine",
      subjectType: "invoice", subjectId: `inv${String(seq)}`, amountPaise, status: "pending",
      requestedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    return id;
  }
  const isStepUpRefusal = (r: { status: number; body: { code?: string } }): boolean => r.status === 403 && r.body.code === "step_up_required";

  it("an approval carries the deadline of its kind: a refund is due 2 h after it was asked, a price change 24 h, an unknown kind never", async () => {
    await ask("billing_refund", 120_000, 30);
    await ask("tariff_revision", null, 30);
    await ask("some_new_kind", null, 30);
    const token = (await login("head")).body.token as string;
    const list = await http().get("/approvals").set(bearer(token));
    expect(list.status).toBe(200);
    const byKind = new Map((list.body.items as { typeKey: string; requestedAt: string; dueAt: string | null }[]).map((i) => [i.typeKey, i] as const));
    const due = (k: string): number | null => { const i = byKind.get(k)!; return i.dueAt === null ? null : new Date(i.dueAt).getTime() - new Date(i.requestedAt).getTime(); };
    expect(due("billing_refund")).toBe(2 * 60 * 60_000);
    expect(due("tariff_revision")).toBe(24 * 60 * 60_000);
    expect(due("some_new_kind")).toBeNull();
  });

  it("a money approval from a PHONE is refused until that session steps up; a browser decides as before", async () => {
    const id = await ask("billing_refund", 120_000);
    const phone = (await login("head", PHONE_A)).body.token as string;
    const refused = await approve(phone, id);
    expect(isStepUpRefusal(refused)).toBe(true);
    expect(isStepUpRefusal(await reject(phone, id))).toBe(true);
    expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.status).toBe("pending");

    // The web inbox: no phone on the session, so this door is not in its way and the decision lands.
    const browser = (await login("head")).body.token as string;
    const web = await approve(browser, id);
    expect(isStepUpRefusal(web)).toBe(false);
    expect(web.status).not.toBe(403);
  });

  it("after a step-up the phone's decision goes through; it is good for two minutes, on that session only, and it is evented", async () => {
    const id = await ask("billing_refund", 120_000);
    const phoneA = (await login("head", PHONE_A)).body.token as string;
    const phoneB = (await login("head", PHONE_B)).body.token as string;

    const up = await stepUp(phoneA, { method: "biometric" });
    expect(up.status).toBe(200);
    expect(new Date(up.body.goodUntil as string).getTime()).toBeGreaterThan(Date.now() + 60_000);

    // The OTHER phone did not step up: the proof is the session's, not the person's.
    expect(isStepUpRefusal(await approve(phoneB, id))).toBe(true);

    // Stale: three minutes old is too old.
    await db.update(authSessions).set({ stepUpAt: new Date(Date.now() - 3 * 60_000) });
    expect(isStepUpRefusal(await approve(phoneA, id))).toBe(true);

    expect((await stepUp(phoneA, { method: "biometric" })).status).toBe(200);
    const done = await approve(phoneA, id);
    expect(isStepUpRefusal(done)).toBe(false);
    expect(done.status).not.toBe(403);

    const stepped = (await db.select().from(events)).filter((e) => e.name === "auth.step_up");
    expect(stepped.length).toBe(2);
    expect(stepped[0]!.payload).toMatchObject({ userId: headId, method: "biometric", ok: true });
  });

  it("a request that moves no money is not gated on a phone", async () => {
    const id = await ask("patient_merge", null);
    const phone = (await login("head", PHONE_A)).body.token as string;
    expect(isStepUpRefusal(await approve(phone, id))).toBe(false);
  });

  it("the password road: a wrong one is refused and evented, the right one steps up; a browser has no step-up", async () => {
    const phone = (await login("head", PHONE_A)).body.token as string;
    const wrong = await stepUp(phone, { method: "password", password: "not-it" });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ code: "step_up_refused" });
    expect((await db.select({ at: authSessions.stepUpAt }).from(authSessions)).every((s) => s.at === null)).toBe(true);
    expect((await stepUp(phone, { method: "password", password: PW })).status).toBe(200);
    const stepped = (await db.select().from(events)).filter((e) => e.name === "auth.step_up").map((e) => (e.payload as { ok: boolean; method: string }));
    expect(stepped.map((e) => [e.method, e.ok]).sort()).toEqual([["password", false], ["password", true]]);
    expect(JSON.stringify(stepped)).not.toContain(PW);

    const browser = (await login("head")).body.token as string;
    const none = await stepUp(browser, { method: "biometric" });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: "not_a_phone" });
  });

  it("the team card: a supervisor's own people only — never themselves, never the inactive, never another supervisor's", async () => {
    for (const key of ["billing_manager", "cashier", "front_office_supervisor", "front_office"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
    const { id: mgr } = await createUser(db, { username: "mgr", fullName: "Billing Manager", password: PW });
    const { id: c1 } = await createUser(db, { username: "c1", fullName: "Cashier One", password: PW });
    const { id: c2 } = await createUser(db, { username: "c2", fullName: "Cashier Gone", password: PW });
    const { id: sup } = await createUser(db, { username: "sup", fullName: "Floor Supervisor", password: PW });
    const { id: fo } = await createUser(db, { username: "fo", fullName: "Front Office", password: PW });
    await assignRole(db, { userId: mgr, roleKey: "billing_manager", scopeType: "hospital" });
    await assignRole(db, { userId: mgr, roleKey: "cashier", scopeType: "hospital" }); // a manager who also works a counter
    await assignRole(db, { userId: c1, roleKey: "cashier", scopeType: "hospital" });
    await assignRole(db, { userId: c2, roleKey: "cashier", scopeType: "hospital" });
    await assignRole(db, { userId: sup, roleKey: "front_office_supervisor", scopeType: "hospital" });
    await assignRole(db, { userId: fo, roleKey: "front_office", scopeType: "hospital" });
    await db.update(users).set({ active: false }).where(eq(users.id, c2));

    const now = new Date();
    expect(await teamOf(db, mgr, now)).toEqual({ userIds: [c1], why: ["role"] });
    expect(await teamOf(db, sup, now)).toEqual({ userIds: [fo], why: ["role"] });
    expect(await teamOf(db, c1, now)).toEqual({ userIds: [], why: [] });

    const card = await http().get("/me/team").set(bearer((await login("mgr")).body.token as string));
    expect(card.status).toBe(200);
    expect((card.body.members as { userId: string; name: string }[]).map((m) => [m.userId, m.name])).toEqual([[c1, "Cashier One"]]);
    // There is nowhere to put somebody else's id: a query string changes nothing.
    const other = await http().get(`/me/team?userId=${sup}`).set(bearer((await login("mgr")).body.token as string));
    expect((other.body.members as { userId: string }[]).map((m) => m.userId)).toEqual([c1]);
    const nobody = await http().get("/me/team").set(bearer((await login("c1")).body.token as string));
    expect(nobody.body.members).toEqual([]);
  });

  /* ═══ round 2 (decision 0043) ═══ */

  it("a UNIT HEAD's card is the members of the units they head — not another unit's, and not a member's own view", async () => {
    const { id: hod } = await createUser(db, { username: "hod", fullName: "Dr. Unit Head", password: PW });
    const { id: sr } = await createUser(db, { username: "sr", fullName: "Dr. Senior Resident", password: PW });
    const { id: other } = await createUser(db, { username: "oth", fullName: "Dr. Other Unit", password: PW });
    const by = { createdBy: hod, updatedBy: hod };
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
    await seedOrgDepartments(db); await seedRosterPositions(db);
    const dep = (await orgDepartmentByCode(db, "MED"))!.id;
    await db.insert(rosterTeams).values([
      { id: "t-u1", kind: "clinical_unit", departmentId: dep, code: "MED-U1", name: "Unit I", ...by },
      { id: "t-u2", kind: "clinical_unit", departmentId: dep, code: "MED-U2", name: "Unit II", ...by },
    ] as never);
    const started = new Date(Date.now() - 86_400_000);
    const member = (id: string, teamId: string, userId: string, roleInTeam: string) =>
      ({ id, teamId, userId, positionKey: ROSTER_POSITIONS[0]!.key, grade: "assistant_professor", roleInTeam, startsAt: started, ...by });
    await db.insert(rosterTeamMemberships).values([
      member("m1", "t-u1", hod, "head"), member("m2", "t-u1", sr, "senior_resident"), member("m3", "t-u2", other, "senior_resident"),
    ] as never);
    const now = new Date();
    expect(await teamOf(db, hod, now)).toEqual({ userIds: [sr], why: ["unit_head"] });
    expect(await teamOf(db, sr, now)).toEqual({ userIds: [], why: [] });
    const card = await http().get("/me/team").set(bearer((await login("hod")).body.token as string));
    expect((card.body.members as { name: string }[]).map((m) => m.name)).toEqual(["Dr. Senior Resident"]);
  });

  it("the header's facts: /auth/me names the person and the roles they hold — their own, nobody else's", async () => {
    const me = await http().get("/auth/me").set(bearer((await login("head")).body.token as string));
    expect(me.status).toBe(200);
    expect(me.body.profile).toEqual({ username: "head", fullName: "Billing Head", roles: ["billing_head"] });
  });

  it("what I asked for: the requester sees their own pending and today's decided requests — a status and an amount, no patient", async () => {
    await db.insert(roles).values({ key: "clerk", title: "clerk" }).onConflictDoNothing();
    await grantPermissionToRole(db, registry, "clerk", "approvals.requests.create");
    await assignRole(db, { userId: askerId, roleKey: "clerk", scopeType: "hospital" });
    const pendingId = await ask("billing_refund", 120_000, 30);
    const decidedId = await ask("billing_discount", 15_000, 50);
    await db.update(approvals).set({ status: "granted", decidedBy: headId, decidedAt: new Date() }).where(eq(approvals.id, decidedId));
    const oldId = await ask("billing_discount", 9_000, 60 * 24 * 3);
    await db.update(approvals).set({ status: "rejected", decidedBy: headId, decidedAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(approvals.id, oldId));

    const mine = await http().get("/approvals/mine").set(bearer((await login("asker")).body.token as string));
    expect(mine.status).toBe(200);
    const items = mine.body.items as Record<string, unknown>[];
    expect(items.map((i) => [i.id, i.status]).sort()).toEqual([[decidedId, "granted"], [pendingId, "pending"]].sort());
    expect(Object.keys(items[0]!).sort()).toEqual(["amountPaise", "decidedAt", "dueAt", "id", "requestedAt", "status", "typeKey"]);
    /* The approver asked nothing: an empty list, and a person without the grant is stopped at the door. */
    const heads = await http().get("/approvals/mine").set(bearer((await login("head")).body.token as string));
    expect(heads.status).toBe(403);
  });

  it("an approval past its time tells its deciders ONCE — not the asker, not for an old one, not before it is due", async () => {
    const overdue = await ask("billing_refund", 120_000, 125);       // due at 120 min: 5 minutes over
    await ask("billing_refund", 50_000, 30);                         // not due yet
    await ask("billing_refund", 70_000, 60 * 24 * 4);                // over for days: never announced by a first run
    await assignRole(db, { userId: askerId, roleKey: "billing_head", scopeType: "hospital" }); // the asker could decide — and is still not told
    const now = new Date();
    expect(await sweepOverdueApprovals(db, now)).toBe(1);
    const rows = await db.select().from(alerts);
    expect(rows.map((r) => [r.userId, r.kind, r.refId])).toEqual([[headId, "approval_overdue", overdue]]);
    expect(`${rows[0]!.title} ${rows[0]!.body}`).not.toMatch(/₹|\d{3,}|Asha|refund/i); // GC6: the kind of thing and nothing else
    expect(await sweepOverdueApprovals(db, new Date(now.getTime() + 60_000))).toBe(0); // the second tick
    expect((await db.select().from(alerts)).length).toBe(1);
  });

  it("the Approvals notification switch is offered to a phone that says it knows it, and to no other", async () => {
    const token = (await login("head", PHONE_A)).body.token as string;
    const old = await http().get("/auth/phone/notifications").set(bearer(token));
    expect(old.body.categories).not.toContain("approvals");
    const knows = await http().get("/auth/phone/notifications?knows=alert,roster,queue,reminder,approvals,madeup").set(bearer(token));
    expect(knows.body.categories).toEqual(["alert", "roster", "queue", "reminder", "approvals"]);
  });

  it("the month's brief carries the day-by-day line; the long periods carry none", async () => {
    const token = (await login("head")).body.token as string;
    const month = await http().get("/me/brief?period=month").set(bearer(token));
    expect(month.status).toBe(200);
    expect(Array.isArray(month.body.series)).toBe(true);
    const quarter = await http().get("/me/brief?period=quarter").set(bearer(token));
    expect(quarter.body.series).toBeUndefined();
  });
});
