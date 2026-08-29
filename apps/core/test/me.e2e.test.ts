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
import { events } from "../src/kernel/db/schema/events";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 07c T1/T2/T3 — `/me/desk`, `/me/report` AND `/me/report.csv` OVER REAL HTTP.
 *
 * The unit suites cover the registry and the provider. What only an e2e can cover is the thing this
 * phase's authority model actually rests on: **there is no way to ask for somebody else's day.**
 * `GET /me/report` declares a `date` and nothing else, so a `userId` on the query string is not
 * refused — it is IGNORED, which is stronger, because there is no parameter for a later edit to
 * start honouring. This suite proves it with two clerks whose days genuinely differ: if the route
 * grew a `userId`, clerk B asking for clerk A's id would see A's patient here, and the assertion
 * would name the row.
 *
 * It also covers the export END TO END — the headers a browser needs, the BOM Excel needs, and the
 * `report.exported` row the DPDP register needs — because those are three things that can each be
 * correct in a unit test and wrong in a controller.
 */
describe("me (desk / report / export) e2e — 07c", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerkA: Awaited<ReturnType<typeof mkUser>>;
  let clerkB: Awaited<ReturnType<typeof mkUser>>;
  let stranger: Awaited<ReturnType<typeof mkUser>>;

  const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
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

    // The role must exist before a permission can be granted to it (FK), which is the order this
    // repo has had to learn twice.
    await ensureRole(db, "desk_clerk");
    await grantPermissionToRole(db, registry, "desk_clerk", "opd.queue.read");

    clerkA = await mkUser(db, "clerk_a", ["desk_clerk"]);
    clerkB = await mkUser(db, "clerk_b", ["desk_clerk"]);
    // Holds NO desk permission at all — E-1's case, from the server's side.
    stranger = await mkUser(db, "stranger", []);

    const p = await mkPatient(db, clerkA.actor, { name: "Ramesh Kale", phone: "9876540009" });
    await openOpdVisit(db, { clerk: clerkA.actor, patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
  });

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  it("T1: the desk composes the cards the caller's permissions unlock", async () => {
    const res = await get(`/me/desk?date=${DATE}`, clerkA.token).expect(200);
    expect(res.body.date).toBe(DATE);
    expect(res.body.cards.map((c: { key: string }) => c.key).sort()).toEqual(["opd.hall", "opd.myVisits"]);
  });

  /** E-1 from the server's side: an empty desk is INFORMATION, and it is not a refusal. */
  it("T1: a person who holds nothing gets an empty desk with a 200, not a 403", async () => {
    const res = await get(`/me/desk?date=${DATE}`, stranger.token).expect(200);
    expect(res.body.cards).toEqual([]);
  });

  /**
   * T2 A1 — THE ASSERTION THE WHOLE AUTHORITY MODEL RESTS ON.
   *
   * Clerk A opened a visit for Ramesh Kale; clerk B opened nothing. B asks for A's day by id. The
   * answer must be B's day — empty — and it must be empty because the parameter does not exist,
   * not because a check refused it.
   */
  it("T2 A1: `?userId=` cannot make one clerk read another clerk's day", async () => {
    const mine = await get(`/me/report?date=${DATE}`, clerkA.token).expect(200);
    expect(JSON.stringify(mine.body)).toContain("Ramesh Kale");

    const theirs = await get(`/me/report?date=${DATE}&userId=${clerkA.id}`, clerkB.token).expect(200);
    expect(JSON.stringify(theirs.body)).not.toContain("Ramesh Kale");
    expect(theirs.body.sections.flatMap((s: { rows: string[][] }) => s.rows)).toEqual([]);
  });

  /** T2 A4 / E-5 — a day still happening is not the close, and the model says which it is. */
  it("T2 A4: today is provisional and a finished day is not", async () => {
    const past = await get(`/me/report?date=${DATE}`, clerkA.token).expect(200);
    expect(past.body.provisional).toBe(false);

    const today = await get("/me/report", clerkA.token).expect(200);
    expect(today.body.provisional).toBe(true);
  });

  /** T2 A3 — a day with nothing on it is zeroed sections, never an error. */
  it("T2 A3: a day before this person existed returns empty sections, not a failure", async () => {
    const res = await get("/me/report?date=2020-01-01", clerkA.token).expect(200);
    expect(res.body.sections.flatMap((s: { rows: string[][] }) => s.rows)).toEqual([]);
  });

  /**
   * T3 — THE EXPORT, END TO END. Three things a unit test cannot see: the headers a browser needs
   * to save a file at all, the BOM Excel needs to read a Devanagari name, and the audit row.
   */
  it("T3: the CSV carries the download headers, the BOM, and the same rows the screen shows", async () => {
    const res = await get(`/me/report.csv?date=${DATE}`, clerkA.token).expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="my-day-2026-08-17.csv"');
    expect(res.text.startsWith("﻿")).toBe(true);
    expect(res.text).toContain("Ramesh Kale");
    // T2 A4 travels into the FILE too — a CSV outlives the screen it was pulled from.
    expect(res.text).toContain("report.status,final");
  });

  /** T3 A3 — "who took the patient list home" is a question asked after an incident. */
  it("T3 A3: every export appends `report.exported` naming the actor, the date and the row count", async () => {
    await get(`/me/report.csv?date=${DATE}`, clerkA.token).expect(200);

    const rows = await db.select().from(events).where(eq(events.name, "report.exported"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(clerkA.id);
    expect(rows[0]!.payload).toMatchObject({ date: DATE, scope: "self", rows: 1 });
  });
});
