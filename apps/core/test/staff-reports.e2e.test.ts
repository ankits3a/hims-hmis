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
  let floorViewer: Awaited<ReturnType<typeof mkUser>>; // reads figures, three-month floor
  let yearViewer: Awaited<ReturnType<typeof mkUser>>;  // reads figures, one-year tier

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
    /*
     * ═══ STAFF-REPORTS T0 — WHY THESE TWO HOLD `history.full` ═══
     *
     * Every DD14 assertion below reads `date=2026-08-17`, a fixed day. The history horizon is
     * measured from the REAL today, so a 91-day window anchored 28 days in the past reaches 119 days
     * back — and these tests would have started failing about a week after they were written, for a
     * reason nobody would have connected to this commit.
     *
     * The fix is not to loosen the horizon but to say which question each test asks. DD14's tests
     * are about WHAT a supervisor may see, so their fixtures are unbounded and time-independent. The
     * horizon's own tests are the block at the end of this file, and they use RELATIVE dates.
     */
    await ensureRole(db, "supervisor");
    await grantPermissionToRole(db, registry, "supervisor", "staff.reports.read");
    await grantPermissionToRole(db, registry, "supervisor", "staff.reports.history.full");
    await ensureRole(db, "supervisor_auditor");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.read");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.drill");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "staff.reports.history.full");
    await grantPermissionToRole(db, registry, "supervisor_auditor", "opd.queue.read");

    // The three horizon tiers, as roles, so a test can name the one it is about.
    await ensureRole(db, "sup_floor");
    await grantPermissionToRole(db, registry, "sup_floor", "staff.reports.read");
    await ensureRole(db, "sup_year");
    await grantPermissionToRole(db, registry, "sup_year", "staff.reports.read");
    await grantPermissionToRole(db, registry, "sup_year", "staff.reports.history.year");
    await ensureRole(db, "clerk_unbounded");
    await grantPermissionToRole(db, registry, "clerk_unbounded", "staff.reports.history.full");

    clerk = await mkUser(db, "clerk_a", ["desk_clerk"]);
    viewer = await mkUser(db, "viewer", ["supervisor"]);
    auditor = await mkUser(db, "auditor", ["supervisor_auditor"]);
    outsider = await mkUser(db, "outsider", []);
    floorViewer = await mkUser(db, "sup_floor_u", ["sup_floor"]);
    yearViewer = await mkUser(db, "sup_year_u", ["sup_year"]);

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

  /**
   * ═══ STAFF-REPORTS T3 — THE BREAKDOWN, OVER HTTP ═══
   *
   * The second instrument: live, across people, sliced by the dimensions the caller picked. The
   * arithmetic agreeing with the pulse is `range-parity.test.ts`'s job; what only shows up at the
   * route is the gate, the horizon, and the refusals.
   */
  describe("T3 — GET /staff/range", () => {
    const RANGE = `from=${DATE}&to=${DATE}`;

    it("returns the day's visits, keyed by the person who opened them", async () => {
      const res = await get(`/staff/range?${RANGE}&groupBy=userId`, viewer.token).expect(200);
      const mine = res.body.rows.find((r: { key: { userId: string } }) => r.key.userId === clerk.id);
      expect(mine.measures["opd.visitsOpened"]).toBe(1);
      expect(res.body.totals["opd.visitsOpened"]).toBe(1);
    });

    /** Ids are for machines. A report of raw uuids is one nobody can read. */
    it("names the people it mentions, and only those", async () => {
      const res = await get(`/staff/range?${RANGE}&groupBy=userId`, viewer.token).expect(200);
      expect(res.body.users[clerk.id]).toBeDefined();
      expect(Object.keys(res.body.users)).toHaveLength(res.body.rows.length);
    });

    it("is gated: holding neither reporting string is a refusal, not an empty table", async () => {
      await get(`/staff/range?${RANGE}`, outsider.token).expect(403);
    });

    /**
     * THE WIDEST HOLE THE HORIZON COULD HAVE HAD. Every other door is capped by a PERIOD; this one
     * lets the caller name any date they like, so `from` is what must be bound.
     */
    it("the horizon binds `from`", async () => {
      const old = new Date(Date.now() + 330 * 60_000 - 200 * 86_400_000).toISOString().slice(0, 10);
      const res = await get(`/staff/range?from=${old}&to=${DATE}&groupBy=userId`, floorViewer.token).expect(400);
      expect(JSON.stringify(res.body)).toContain("history_horizon_exceeded");
    });

    /** An inverted range returns nothing, and nothing reads as a quiet year. So it refuses. */
    it("REFUSES an inverted range rather than reporting an empty one", async () => {
      const res = await get(`/staff/range?from=${DATE}&to=2026-01-01&groupBy=userId`, viewer.token).expect(400);
      expect(JSON.stringify(res.body)).toContain("bad_range");
    });

    it("refuses a groupBy that is not a dimension", async () => {
      await get(`/staff/range?${RANGE}&groupBy=salary`, viewer.token).expect(400);
    });

    /** The totals row is summed from the rows shown, so a table cannot disagree with its footer. */
    it("the totals equal the rows on screen, whatever the grouping", async () => {
      for (const groupBy of ["userId", "departmentId", "doctorId", "visitType", "userId,visitType"]) {
        const res = await get(`/staff/range?${RANGE}&groupBy=${groupBy}`, viewer.token).expect(200);
        const summed = res.body.rows.reduce(
          (n: number, r: { measures: Record<string, number> }) => n + (r.measures["opd.visitsOpened"] ?? 0), 0,
        );
        expect([groupBy, summed]).toEqual([groupBy, res.body.totals["opd.visitsOpened"]]);
      }
    });
  });

  /**
   * ═══ STAFF-REPORTS T0 — THE HISTORY HORIZON, owner ruling 2026-09-14 ═══
   *
   * Three tiers: the floor is three months and is the ABSENCE of a grant,
   * `staff.reports.history.year` lifts it to a year, `staff.reports.history.full` removes it.
   *
   * EVERY DATE HERE IS RELATIVE — these assertions are about a window measured from the real today,
   * so a fixed anchor would give them an expiry date. That is the trap the fixture comment above
   * records, met once already while writing this file.
   */
  describe("T0 — the history horizon", () => {
    it("the floor reaches a quarter", async () => {
      await get(`/staff/${clerk.id}/brief?period=quarter`, floorViewer.token).expect(200);
    });

    it("and refuses six months, naming the cap rather than returning an empty brief", async () => {
      const res = await get(`/staff/${clerk.id}/brief?period=half`, floorViewer.token).expect(400);
      const body = JSON.stringify(res.body);
      expect(body).toContain("history_horizon_exceeded");
      expect(body).toContain("91");
    });

    it("the year tier reaches a year", async () => {
      await get(`/staff/${clerk.id}/brief?period=year`, yearViewer.token).expect(200);
    });

    /**
     * ═══ THE LEAK THIS DESIGN EXISTS TO PREVENT ═══
     *
     * The horizon is read off the CALLER and never off the SUBJECT. Collapse the two — the obvious
     * shortcut, since the brief already has the subject's id in hand — and a capped supervisor
     * reaches two years back merely because the clerk they are reading holds the unbounded string
     * themselves. It is the same trap `DeskProviderCtx` documents for `actor` versus `reader`, and
     * it is invisible in every test where one person plays both roles.
     */
    it("the SUBJECT's own unbounded history does not widen what the CALLER may read", async () => {
      // A SUBJECT who holds the unbounded string themselves.
      const subject = await mkUser(db, "clerk_unbounded_u", ["desk_clerk", "clerk_unbounded"]);

      const res = await get(`/staff/${subject.id}/brief?period=half`, floorViewer.token).expect(400);
      expect(JSON.stringify(res.body)).toContain("history_horizon_exceeded");
    });

    /**
     * A ROUTE THAT READS ONE DAY LOOKS BOUNDED AND IS NOT. `date` is a free parameter, so an
     * unguarded drill walks back a year at a rate of one request per day.
     */
    it("the drill's date is bound by the horizon too", async () => {
      const old = new Date(Date.now() + 330 * 60_000 - 200 * 86_400_000).toISOString().slice(0, 10);
      const res = await post(`/staff/${clerk.id}/drill`, auditor.token, { date: old, reason: "a stated reason" })
        .expect(201); // a POST that appends an audit row — 201, like every other drill test here
      expect(res.body.date).toBe(old); // the auditor is unbounded

      await ensureRole(db, "drill_floor");
      await grantPermissionToRole(db, registry, "drill_floor", "staff.reports.read");
      await grantPermissionToRole(db, registry, "drill_floor", "staff.reports.drill");
      const capped = await mkUser(db, "drill_floor_u", ["drill_floor"]);
      const refused = await post(`/staff/${clerk.id}/drill`, capped.token, { date: old, reason: "a stated reason" })
        .expect(400);
      expect(JSON.stringify(refused.body)).toContain("history_horizon_exceeded");
    });
  });

});
