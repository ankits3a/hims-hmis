import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { events, users } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 07c T9 / DD14 — **WHAT, NOT WHOM**, over real HTTP.
 *
 * Owner ruling O-2 (2026-08-28) is YES: a supervisor may read a named staff member's day. DD14 is
 * what keeps that lawful as well as useful, and all three of its halves are only observable at the
 * route: that the figures carry no patient, that the rows need a second permission and a stated
 * reason, and that opening them writes a row naming the SUPERVISOR — the audit trail covering the
 * auditor.
 */
describe("staff reports e2e — 07c T9 (DD14: what, not whom)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let viewer: Awaited<ReturnType<typeof mkUser>>;   // reads figures only
  let auditor: Awaited<ReturnType<typeof mkUser>>;  // may also drill
  let outsider: Awaited<ReturnType<typeof mkUser>>; // holds neither

  const T0 = new Date("2026-08-17T04:00:00.000Z");
  const DATE = "2026-08-17";

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
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });

    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.queue.read");
    await ensureRole(db, "supervisor");
    await grantPermissionToRole(db, registry, "supervisor", "staff.reports.read");
    await ensureRole(db, "supervisor_auditor");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.read");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.drill");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "opd.queue.read");

    clerk = await mkUser(db, "clerk_a", ["desk_clerk"]);
    viewer = await mkUser(db, "viewer", ["supervisor"]);
    auditor = await mkUser(db, "auditor", ["supervisor_auditor"]);
    outsider = await mkUser(db, "outsider", []);

    const p = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540099" });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
  });

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
  const post = (path: string, token: string, body: object) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body);

  /**
   * A1 — AND IT IS STRUCTURAL RATHER THAN CAREFUL. The brief is built from `facts`, which is
   * `Record<string, number>`: there is no field in the response that COULD hold a name, so no
   * future edit to a provider can start leaking one through this route.
   */
  it("A1: a named staff brief carries the numbers and no patient identity at all", async () => {
    const res = await get(`/staff/${clerk.id}/brief?period=day&date=${DATE}`, viewer.token).expect(200);

    expect(res.body.subjectUserId).toBe(clerk.id);
    expect(res.body.totalsToday["opd.visitsOpened"]).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain("Ramesh Kale");
    // Every value in the response's fact bags is a number. That is the property, stated.
    for (const v of Object.values(res.body.totals as Record<string, unknown>)) {
      expect(typeof v).toBe("number");
    }
  });

  /** A3 — permission-gated, not self-scoped. `/me/*` is the self-scoped pair; this is the other. */
  it("A3: a person holding neither permission cannot read a colleague's figures", async () => {
    await get(`/staff/${clerk.id}/brief?date=${DATE}`, outsider.token).expect(403);
    await get("/staff", outsider.token).expect(403);
  });

  /**
   * THE SPLIT DD14 RESTS ON. `staff.reports.read` buys the counts; the ROWS need a second grant. A
   * hospital that handed both out together would have decided, without noticing, that every shift
   * supervisor may read every patient list in the building.
   */
  it("A1/A3: reading the figures does NOT buy the rows — the drill is a separate grant", async () => {
    await get(`/staff/${clerk.id}/brief?date=${DATE}`, viewer.token).expect(200);
    await post(`/staff/${clerk.id}/drill`, viewer.token, { date: DATE, reason: "checking the credit lane" })
      .expect(403);
  });

  /** A reason box that can be satisfied by pressing Enter is a control nobody has thought about. */
  it("A2: a drill without a real stated reason is refused", async () => {
    await post(`/staff/${clerk.id}/drill`, auditor.token, { date: DATE, reason: "" }).expect(400);
    await post(`/staff/${clerk.id}/drill`, auditor.token, { date: DATE, reason: "   ok   " }).expect(400);
    expect(await db.select().from(events).where(eq(events.name, "staff_report.drilled"))).toHaveLength(0);
  });

  it("A2: a drill returns the rows AND records the supervisor, the reason and how many rows", async () => {
    const res = await post(`/staff/${clerk.id}/drill`, auditor.token, {
      date: DATE, reason: "variance review for the 17th",
    }).expect(201);

    expect(JSON.stringify(res.body)).toContain("Ramesh Kale");

    const rows = await db.select().from(events).where(eq(events.name, "staff_report.drilled"));
    expect(rows).toHaveLength(1);
    // The AUDITOR is the event's actor and the clerk is its subject — the trail covers the auditor.
    expect(rows[0]!.actorId).toBe(auditor.id);
    expect(rows[0]!.payload).toMatchObject({
      subjectUserId: clerk.id, date: DATE, reason: "variance review for the 17th", rows: 1,
    });
  });

  /**
   * A typo'd id must not answer "this person did nothing" — that reading is indistinguishable from
   * a real person who did nothing, and it is the one answer a supervisor must never be given by
   * accident.
   */
  it("an unknown or inactive subject is refused rather than answered with an empty day", async () => {
    // 404, matching `PatientError`'s `patient_not_found` in the same position — an id that names
    // nobody is a not-found, and an ACTIVE account that has been closed is a refusal.
    await get(`/staff/01NOSUCHUSER00000000000A/brief?date=${DATE}`, viewer.token).expect(404);

    await db.update(users).set({ active: false }).where(eq(users.id, clerk.id));
    await get(`/staff/${clerk.id}/brief?date=${DATE}`, viewer.token).expect(400);
  });

  it("the staff picker lists active users and drops the ones who have left", async () => {
    const before = await get("/staff", viewer.token).expect(200);
    expect(before.body.items.map((i: { id: string }) => i.id)).toContain(clerk.id);

    await db.update(users).set({ active: false }).where(eq(users.id, clerk.id));
    const after = await get("/staff", viewer.token).expect(200);
    expect(after.body.items.map((i: { id: string }) => i.id)).not.toContain(clerk.id);
    expect(outsider.id).toBeTruthy();
  });

  /**
   * ═══ THE ONE THAT MATTERS MOST, AND THE LEAK IT PINS IS SUBTLE ═══
   *
   * A drill selects the CLERK's rows and must alias them to the SUPERVISOR's clearance. The
   * tempting implementation passes one actor into the provider and uses it for both — and it looks
   * right in every test where one person plays both roles.
   *
   * It is a leak. `getPatientSummaries` decides `restricted` from `patients.confidential.read` on
   * the actor it is HANDED. Hand it the clerk and a supervisor who may not open a sealed record
   * reads that patient's real name off the drill, because the clerk who registered them could.
   *
   * So the seam has two fields: `ctx.actor` selects (whose work) and `ctx.reader` aliases (who is
   * looking). This test is the only place the two are different people AND the patient is sealed,
   * which is the only configuration in which the mistake is visible at all.
   */
  it("A1/DD14: a drill aliases to the SUPERVISOR's clearance, never the subject's", async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const dra = await mkDoctor(db, { username: "dra2", departmentId: deptId, roomId });

    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.queue.read");
    // THE CLERK MAY SEE SEALED RECORDS. The supervisor below deliberately may not.
    await grantPermissionToRole(db, registry, "desk_clerk", "patients.confidential.read");
    await ensureRole(db, "supervisor_auditor");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.read");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.drill");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "opd.queue.read");

    const sealedClerk = await mkUser(db, "clerk_sealed", ["desk_clerk"]);
    const plainAuditor = await mkUser(db, "auditor_plain", ["supervisor_auditor"]);

    const sealed = await mkPatient(db, sealedClerk.actor, {
      name: "Priya Confidential", phone: "9111111112", isConfidential: true, alias: "Guest Two",
    });
    await openOpdVisit(
      db, { clerk: sealedClerk.actor, patientId: sealed.id, departmentId: deptId, doctorId: dra.doctorId }, T0,
    );

    // The clerk's OWN report shows the real name — they hold `patients.confidential.read`.
    const own = await get(`/me/report?date=${DATE}`, sealedClerk.token).expect(200);
    expect(JSON.stringify(own.body)).toContain("Priya Confidential");

    // The supervisor drills the same day and gets the ALIAS, because they do not.
    const drill = await post(`/staff/${sealedClerk.id}/drill`, plainAuditor.token, {
      date: DATE, reason: "confidentiality check on the sealed lane",
    }).expect(201);
    const body = JSON.stringify(drill.body);
    expect(body).not.toContain("Priya Confidential");
    expect(body).toContain("Guest Two");
  });
});
