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
import { events } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * THE OPD DAY REPORT OVER HTTP — owner request 2026-09-19. What only the route can show: who may pull
 * it, that a department's patient list is logged before it leaves, and that the file downloads are
 * files.
 */
describe("OPD day report e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let reader: Awaited<ReturnType<typeof mkUser>>;
  let outsider: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;

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
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    const dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });

    await ensureRole(db, "report_reader");
    await grantPermissionToRole(db, registry, "report_reader", "opd.reports.read");
    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.visits.open");
    reader = await mkUser(db, "reader", ["report_reader"]);
    outsider = await mkUser(db, "outsider", ["desk_clerk"]);

    const p = await mkPatient(db, outsider.actor, { name: "Ramesh Kale", phone: "9876540099" });
    await openOpdVisit(db, { clerk: outsider.actor, patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
  });

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  it("is refused to anyone without opd.reports.read — every one of the six routes", async () => {
    for (const path of [
      `/opd/reports/consultations?date=${DATE}`, `/opd/reports/consultations/csv?date=${DATE}`, `/opd/reports/consultations/document?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}/csv?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}/document?date=${DATE}`,
    ]) {
      await get(path, outsider.token).expect(403);
    }
    expect(await db.select().from(events).where(eq(events.name, "day_report.patients_listed"))).toHaveLength(0);
  });

  it("serves the hospital summary as data, a spreadsheet and a printable letterhead", async () => {
    const day = await get(`/opd/reports/consultations?date=${DATE}`, reader.token).expect(200);
    const med = (day.body.departments as { departmentId: string; stillOpen: number }[]).find((d) => d.departmentId === deptId)!;
    expect(med.stillOpen).toBe(1); // opened, not yet consulted
    expect(JSON.stringify(day.body)).not.toContain("Ramesh Kale");

    const csv = await get(`/opd/reports/consultations/csv?date=${DATE}`, reader.token).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="OPD-Day-Report-${DATE}.csv"`);
    expect(csv.text).toContain("General Medicine,0,1,0,0,0,0,1,0");
    expect(csv.text).toContain("Appointments,Visits opened,Consulted");

    const doc = await get(`/opd/reports/consultations/document?date=${DATE}`, reader.token).expect(200);
    expect(doc.body.title).toBe(`OPD-Day-Report-${DATE}`);
    expect(doc.body.html).toContain("OPD Day Report");
  });

  /**
   * Owner, 2026-10-07 — "Opened by: …" names what each clerk did. `opd.reports.read` is the
   * department's load; a person's output needs `staff.reports.read` as well, on all six routes.
   */
  it("names who opened the visits only to a reader who also holds staff.reports.read", async () => {
    const paths = [
      `/opd/reports/consultations?date=${DATE}`, `/opd/reports/consultations/csv?date=${DATE}`, `/opd/reports/consultations/document?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}/csv?date=${DATE}`,
      `/opd/reports/consultations/departments/${deptId}/document?date=${DATE}`,
    ];
    for (const path of paths) {
      const res = await get(path, reader.token).expect(200);
      expect(res.text).not.toContain("Opened by");
      expect(res.text).not.toContain("outsider");
    }
    expect((await get(paths[0]!, reader.token)).body.openedBy).toBeNull();

    await ensureRole(db, "staff_reader");
    await grantPermissionToRole(db, registry, "staff_reader", "opd.reports.read");
    await grantPermissionToRole(db, registry, "staff_reader", "staff.reports.read");
    const boss = await mkUser(db, "boss", ["staff_reader"]);
    expect((await get(paths[0]!, boss.token).expect(200)).body.openedBy).toEqual([{ name: expect.any(String), count: 1 }]);
    for (const path of paths.slice(1)) {
      const res = await get(path, boss.token).expect(200);
      // The department's JSON carries the list; the two sheets and the two spreadsheets carry the line.
      if (path.endsWith(`/departments/${deptId}?date=${DATE}`)) expect(res.body.openedBy).toEqual([{ name: expect.any(String), count: 1 }]);
      else expect(res.text).toContain("Opened by");
    }
  });

  it("logs a department's patient list BEFORE returning it, naming reader, day, department, format and rows", async () => {
    await get(`/opd/reports/consultations/departments/${deptId}?date=${DATE}`, reader.token).expect(200);
    const csv = await get(`/opd/reports/consultations/departments/${deptId}/csv?date=${DATE}`, reader.token).expect(200);
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="OPD-Day-Report-MED-${DATE}.csv"`);
    await get(`/opd/reports/consultations/departments/${deptId}/document?date=${DATE}`, reader.token).expect(200);

    const logged = await db.select().from(events).where(eq(events.name, "day_report.patients_listed"));
    expect(logged.map((e) => (e.payload as { format: string }).format).sort()).toEqual(["csv", "document", "screen"]);
    for (const e of logged) {
      expect(e.actorId).toBe(reader.id);
      expect(e.payload).toMatchObject({ date: DATE, period: "day", from: DATE, to: DATE, departmentId: deptId, rows: 0 });
    }
  });

  /**
   * THE PERIODS (owner, 2026-09-20). The server decides what a week is — Monday to Saturday — so the
   * route is asked for a NAME and answers with the days it counted, and the audit row records them.
   */
  it("serves this week and this month, and the audit row names the days that were listed", async () => {
    const week = await get(`/opd/reports/consultations?period=week&date=${DATE}`, reader.token).expect(200);
    // DATE is Monday 2026-08-17, so the week starts that day and ends on the anchor.
    expect(week.body).toMatchObject({ period: "week", from: DATE, to: DATE });

    const month = await get(`/opd/reports/consultations?period=month&date=${DATE}`, reader.token).expect(200);
    expect(month.body).toMatchObject({ period: "month", from: "2026-08-01", to: DATE });

    const csv = await get(`/opd/reports/consultations/csv?period=month&date=${DATE}`, reader.token).expect(200);
    expect(csv.headers["content-disposition"]).toBe(`attachment; filename="OPD-Month-Report-2026-08-01-to-${DATE}.csv"`);

    await get(`/opd/reports/consultations/departments/${deptId}/csv?period=month&date=${DATE}`, reader.token).expect(200);
    const logged = await db.select().from(events).where(eq(events.name, "day_report.patients_listed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.payload).toMatchObject({ period: "month", from: "2026-08-01", to: DATE, format: "csv" });

    await get(`/opd/reports/consultations?period=fortnight&date=${DATE}`, reader.token).expect(400);
  });

  it("answers 404 for an unknown department, and 400 for a date that is not one", async () => {
    await get(`/opd/reports/consultations/departments/nope?date=${DATE}`, reader.token).expect(404);
    await get(`/opd/reports/consultations?date=2026-13-45`, reader.token).expect(400);
    await get(`/opd/reports/consultations?date=yesterday`, reader.token).expect(400);
  });

  /** Owner 2026-10-07 — "show a daily count": the door is the login, and what comes back is decided inside. */
  it("recording count: refused without a login, integers for a reader and a desk, nothing for a stranger", async () => {
    await request(app.getHttpServer()).get(`/opd/reports/recording?date=${DATE}`).expect(401);
    const mine = await get(`/opd/reports/recording?date=${DATE}`, reader.token).expect(200);
    expect(mine.body).toMatchObject({ scope: "hospital", from: DATE, to: DATE, totals: { opened: 1, consulted: 0, stillOpen: 1, notRecorded: 0 } });
    expect(mine.body.doctors).toBeNull();
    // The desk that opens visits sees the same integers and no names; a login with no part in OPD sees nothing.
    const desk = await get(`/opd/reports/recording?date=${DATE}`, outsider.token).expect(200);
    expect(desk.body).toMatchObject({ scope: "hospital", doctors: null });
    const stranger = await mkUser(db, "stranger", []);
    const out = await get(`/opd/reports/recording?date=${DATE}`, stranger.token).expect(200);
    expect(out.body).toMatchObject({ scope: "none", totals: null });
  });
});
