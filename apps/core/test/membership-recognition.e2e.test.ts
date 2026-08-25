import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import {
  events, membershipInstances, membershipPlans, registrationConfig, roles, searchAudit,
} from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { approveRequest } from "../src/kernel/approvals/decisions";
import { requestApproval } from "../src/kernel/approvals/requests";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { registerPatient } from "../src/modules/patients";
import {
  GRACE_HONOR_APPROVAL_TYPE, GRACE_HONOR_SUBJECT_TYPE, registerMembershipApprovalTypes,
} from "../src/modules/membership";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 09 T3 — THE HTTP SURFACE A BROWSER ACTUALLY CALLS.
 *
 * 11h's close review (MAJOR 5) found that a whole feature's assertions were against FUNCTIONS and
 * that the route itself — its zod schema, its guard, its status codes, its headers — had no test of
 * any kind. Every one of those is a way a green unit suite sits behind a broken endpoint, and the
 * FIRST test below is the one that lesson names: an unauthenticated call.
 *
 * ═══ THE RATE LIMIT IS EXERCISED AT A LOW LIMIT, AND THAT IS NOT A SHORTCUT ═══
 *
 * `SEARCH_RATE_LIMIT` is set to 5 for this suite's app, so the C2/C3 legs make 6 and 10 requests
 * rather than 121 and 125. The MECHANISM is identical — `checkSearchRate` counts `search_audit`
 * over `(actor_id, at)` and knows nothing about the number — and a suite that took forty seconds to
 * assert one refusal is a suite somebody eventually deletes.
 *
 * Every card code, plan code and person below is INVENTED HERE (DD3 / owner ruling O-9).
 */
describe("membership recognition over HTTP", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);
  const clerk: Actor = { type: "user", id: "seed-clerk" };

  const RATE_LIMIT = 5;
  const PLAN_ID = "01HTESTPLAN00000000000001";
  let previousLimit: string | undefined;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    previousLimit = process.env.SEARCH_RATE_LIMIT;
    process.env.SEARCH_RATE_LIMIT = String(RATE_LIMIT);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardown();
    if (previousLimit === undefined) delete process.env.SEARCH_RATE_LIMIT;
    else process.env.SEARCH_RATE_LIMIT = previousLimit;
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-PLAN-A", title: "Invented Card", kind: "card",
      benefits: [{ benefitKey: "consult-off", title: "Consultation discount", kind: "percent_bps", value: 1_000, capPaise: 50_000, scope: { serviceCategories: null, serviceIds: null } }],
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
  });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  async function deskUser(permissions: string[], roleKeys: string[] = []): Promise<{ token: string; actor: Actor }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Desk");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    for (const key of roleKeys) {
      await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
      await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
    }
    const { token } = await createSession(db, cfg, id);
    return { token, actor: { type: "user", id } };
  }

  async function issueCard(args: { id: string; cardCode: string; holderName: string; patientId?: string }): Promise<void> {
    await db.insert(membershipInstances).values({
      id: args.id, planId: PLAN_ID, cardCode: args.cardCode, holderName: args.holderName,
      patientId: args.patientId,
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2036-12-31T00:00:00Z"),
      status: "active", origin: "import",
    });
  }

  // ── 11h MAJOR 5 — the guard, first ────────────────────────────────────────────────────────

  it("401 WITHOUT A TOKEN on every route — they are guarded like every other", async () => {
    await request(server()).get("/membership/instruments/lookup?q=AZ").expect(401);
    await request(server()).get("/membership/recognition?patientId=x").expect(401);
    await request(server()).post("/membership/grace-honor").send({}).expect(401);
  });

  it("403 with a token but WITHOUT the permission the route declares", async () => {
    const { token } = await deskUser([]);
    await request(server()).get("/membership/instruments/lookup?q=AZ").set("Authorization", `Bearer ${token}`).expect(403);
    await request(server()).get("/membership/recognition").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("a malformed limit is a 400 in the module's own error shape, never a 500", async () => {
    const { token } = await deskUser(["membership.instrument.read"]);
    const res = await request(server())
      .get("/membership/instruments/lookup?q=AZ&limit=999").set("Authorization", `Bearer ${token}`).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: "invalid_request" });
  });

  // ── the lookup lane ───────────────────────────────────────────────────────────────────────

  it("finds a card and WRITES exactly one search_audit row — the access log and the limiter's counter", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const { token } = await deskUser(["membership.instrument.read"]);

    const res = await request(server())
      .get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.hits.map((h: { title: string }) => h.title)).toEqual(["AZ-4471"]);
    expect(res.body.total).toBe(1);
    expect(typeof res.body.auditId).toBe("string");
    const rows = await db.select().from(searchAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.body.auditId, rawQuery: "AZ-44", source: "text" });
  });

  /** ═══ BOOK ROW C2 — THE LIMIT IS PER ACTOR, INSIDE A WINDOW ═══ */
  it("C2 — the (limit+1)th lookup by ONE actor is refused with Retry-After", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const { token } = await deskUser(["membership.instrument.read"]);

    for (let i = 0; i < RATE_LIMIT; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(200);
    }
    const refused = await request(server())
      .get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(429);

    expect(refused.body).toMatchObject({ statusCode: 429, code: "lookup_rate_limited" });
    // The HEADER, not only the body: it is what an HTTP client already knows how to obey.
    expect(refused.headers["retry-after"]).toBeDefined();
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.body.detail).toMatchObject({ limit: RATE_LIMIT });
  });

  it("C2 — the limit is PER ACTOR: a second desk is unaffected by the first one's block", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const first = await deskUser(["membership.instrument.read"]);
    const second = await deskUser(["membership.instrument.read"]);

    for (let i = 0; i < RATE_LIMIT + 1; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${first.token}`);
    }
    await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${first.token}`).expect(429);
    // One busy counter must never slow another — there is no global limit and no IP dimension.
    await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${second.token}`).expect(200);
  });

  /** ═══ BOOK ROW C3 — A REFUSAL IS AN EVENT AND DOES NOT EXTEND THE BLOCK ═══ */
  it("C3 — five refusals write ZERO audit rows and five events; the counted table does not grow", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const { token, actor } = await deskUser(["membership.instrument.read"]);

    for (let i = 0; i < RATE_LIMIT; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(200);
    }
    const auditAfterExecuted = await db.select().from(searchAudit);
    expect(auditAfterExecuted).toHaveLength(RATE_LIMIT);

    for (let i = 0; i < 5; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(429);
    }

    // THE ASSERTION THAT IS THE RULE: the table the limiter COUNTS did not grow by a single row.
    // Writing refusals there would make every retry extend the block — the limiter would fail
    // closed on the busiest counter in the building.
    expect(await db.select().from(searchAudit)).toHaveLength(RATE_LIMIT);

    const refusals = await db.select().from(events).where(eq(events.name, "instrument.lookup_refused"));
    expect(refusals).toHaveLength(5);
    expect(refusals[0]!.payload).toMatchObject({ actorId: actor.id, reason: "rate_limited", limit: RATE_LIMIT });
  });

  it("C3 — the block clears on the ORIGINAL rows falling out of the window, not on the refusals", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const { token, actor } = await deskUser(["membership.instrument.read"]);

    for (let i = 0; i < RATE_LIMIT; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(200);
    }
    for (let i = 0; i < 5; i += 1) {
      await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(429);
    }

    // The window is walked by BACK-DATING the executed rows rather than by sleeping for it: the
    // limiter's expiry is arithmetic on `at`, so moving the rows past the window is the same
    // observation a minute of wall clock would make, and a suite that sleeps is a suite that flakes.
    await db.update(searchAudit)
      .set({ at: sql`now() - interval '1 hour'` })
      .where(eq(searchAudit.actorId, actor.id));

    await request(server()).get("/membership/instruments/lookup?q=AZ-44").set("Authorization", `Bearer ${token}`).expect(200);
  });

  // ── the honouring lane ────────────────────────────────────────────────────────────────────

  it("E-32 — the honouring response carries the disclosure line, and no money at all", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Barua", sex: "female", phone: "9700000001" }));
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua", patientId: patient.id });
    const { token } = await deskUser(["membership.instrument.recognise"]);

    const res = await request(server())
      .get(`/membership/recognition?patientId=${patient.id}`).set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.disclosure).toMatch(/not insurance/i);
    expect(res.body.memberships.map((m: { cardCode: string }) => m.cardCode)).toEqual(["AZ-4471"]);
    expect(JSON.stringify(res.body)).not.toMatch(/paise|amount|price|commission|rupee/i);
  });

  it("C1 — a SEALED patient answers empty over HTTP, with no hint that a card exists", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Sealed", sex: "female", phone: "9700000009", isConfidential: true, alias: "Guest N" }));
    await issueCard({ id: "01HCARD0000000000000002", cardCode: "CX-9002", holderName: "Nilima Sealed", patientId: patient.id });
    const { token } = await deskUser(["membership.instrument.recognise", "membership.instrument.read"]);

    const recognition = await request(server())
      .get(`/membership/recognition?patientId=${patient.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(recognition.body).toMatchObject({ patientId: null, memberships: [], coupons: [] });

    const lookup = await request(server())
      .get("/membership/instruments/lookup?q=CX-90").set("Authorization", `Bearer ${token}`).expect(200);
    expect(lookup.body).toMatchObject({ hits: [], total: 0 });
  });

  it("C4 — grace-honor over HTTP: refused without an approval, honoured with one", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Barua", sex: "female", phone: "9700000001" }));
    const desk = await deskUser(["membership.grace_honor.request"]);
    const approver = await deskUser([], ["billing_manager"]);
    await registerMembershipApprovalTypes(db, approver.actor);

    // A body with no approvalId at all is refused by the zod schema, in the ratified shape.
    const noField = await request(server())
      .post("/membership/grace-honor").set("Authorization", `Bearer ${desk.token}`)
      .send({ cardCode: "ZZ-0009", patientId: patient.id, planId: PLAN_ID, reason: "feed lag" })
      .expect(400);
    expect(noField.body).toMatchObject({ code: "invalid_request" });

    // An id that names no granted approval is refused by the SERVICE, on execute.
    const notGranted = await request(server())
      .post("/membership/grace-honor").set("Authorization", `Bearer ${desk.token}`)
      .send({ cardCode: "ZZ-0009", patientId: patient.id, planId: PLAN_ID, approvalId: "01NOSUCHAPPROVAL00000000", reason: "feed lag" })
      .expect(409);
    expect(notGranted.body).toMatchObject({ code: "grace_honor_approval_required" });
    expect(await db.select().from(membershipInstances)).toEqual([]);

    const filed = await withTx(db, (tx) =>
      requestApproval(tx, desk.actor, {
        typeKey: GRACE_HONOR_APPROVAL_TYPE,
        subject: { type: GRACE_HONOR_SUBJECT_TYPE, id: "ZZ-0009" },
        patientId: patient.id,
        requestNote: "member insists the card is live",
      }));
    await approveRequest(db, approver.actor, { approvalId: filed.approvalId, note: "honour it" });

    const honoured = await request(server())
      .post("/membership/grace-honor").set("Authorization", `Bearer ${desk.token}`)
      .send({ cardCode: "ZZ-0009", patientId: patient.id, planId: PLAN_ID, approvalId: filed.approvalId, reason: "partner feed lag" })
      .expect(201);
    expect(honoured.body).toMatchObject({ cardCode: "ZZ-0009", origin: "grace", verified: false });

    const rows = await db.select().from(membershipInstances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "grace", verified: false });
    expect(await db.select().from(events).where(eq(events.name, "instrument.grace_honored"))).toHaveLength(1);
  });
});
