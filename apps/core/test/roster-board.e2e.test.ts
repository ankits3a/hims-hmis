import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { seedUnits } from "../src/modules/roster/teams";
import type { INestApplication } from "@nestjs/common";
import type { Db } from "../src/kernel/db/client";

/**
 * 20-U U5a — `GET /roster/on-now` over HTTP: who may read the board, and what a bad clock says.
 * The board's CONTENT is `src/modules/roster/board.test.ts`'s; this suite is the door.
 */
describe("roster board e2e (20-U U5a)", () => {
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
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await createRole(db, "board_reader", "Reads the roster");
    await grantPermissionToRole(db, registry, "board_reader", "roster.read");
    await createRole(db, "no_roster", "Holds nothing on the roster");
    await grantPermissionToRole(db, registry, "no_roster", "opd.visits.open");
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) {
      await createRole(db, key, key);
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
  });

  it("a holder of roster.read gets the board, one row per unit-running department", async () => {
    const reader = await mkUser(db, "board.reader", ["board_reader"]);
    const res = await request(app.getHttpServer())
      .get("/roster/on-now?at=2026-10-06T02:40:00%2B05:30")
      .set("authorization", `Bearer ${reader.token}`)
      .expect(200);
    const body = res.body as { at: string; departments: { code: string; source: string; inTheBuilding: unknown[] }[]; holes: { kind: string }[] };
    expect(body.at).toBe("2026-10-05T21:10:00.000Z");
    expect(body.departments.map((d) => d.code).sort()).toEqual(["DER", "ENT", "MED", "OBG", "OPH", "ORT", "PED", "PSY", "RESP", "SUR"]);
    // Nothing is published: every row says so and lists nobody.
    expect(body.departments.every((d) => d.source !== "published" && d.inTheBuilding.length === 0)).toBe(true);
    expect(body.holes.filter((h) => h.kind === "no_take_cycle")).toHaveLength(10);
    // 20-U U5 — the reader, named for the Doctor Desk header; posted nowhere, so no grade.
    expect((res.body as { you: unknown }).you).toEqual({ name: expect.any(String), grade: null, positionKey: null, unitName: null, departmentName: null });
  });

  it("a role WITHOUT roster.read is refused", async () => {
    const clerk = await mkUser(db, "no.roster", ["no_roster"]);
    await request(app.getHttpServer())
      .get("/roster/on-now")
      .set("authorization", `Bearer ${clerk.token}`)
      .expect(403);
  });

  it("no session is refused", async () => {
    await request(app.getHttpServer()).get("/roster/on-now").expect(401);
  });

  it("an `at` that is not an instant is a 422 with the roster's own code, not a 500", async () => {
    const reader = await mkUser(db, "board.reader2", ["board_reader"]);
    const res = await request(app.getHttpServer())
      .get("/roster/on-now?at=yesterday-ish")
      .set("authorization", `Bearer ${reader.token}`)
      .expect(422);
    expect((res.body as { code: string }).code).toBe("invalid_window");
  });

  /* 20-U U7 — `GET /roster/opd-units`: the same door as the board's. Its content is `opd-units.test.ts`'s. */
  it("opd-units: a reader gets the day's clinics (none run on units yet), a non-reader is refused, a bad day is a 422", async () => {
    const reader = await mkUser(db, "board.reader3", ["board_reader"]);
    const clerk = await mkUser(db, "no.roster2", ["no_roster"]);
    const ok = await request(app.getHttpServer()).get("/roster/opd-units?date=2026-10-06")
      .set("authorization", `Bearer ${reader.token}`).expect(200);
    expect(ok.body).toEqual([]);
    await request(app.getHttpServer()).get("/roster/opd-units").set("authorization", `Bearer ${clerk.token}`).expect(403);
    const bad = await request(app.getHttpServer()).get("/roster/opd-units?date=06-10-2026")
      .set("authorization", `Bearer ${reader.token}`).expect(422);
    expect((bad.body as { code: string }).code).toBe("invalid_window");
  });

  /* 20-U U9 — the copilot's roster tools over HTTP: the phrasebook routes, the tool answers as the person. */
  it("copilot: 'ortho mein abhi on call kaun hai?' is answered by roster.who_is_on for a reader, and refused without roster.read", async () => {
    const reader = await mkUser(db, "board.reader4", ["board_reader"]);
    const clerk = await mkUser(db, "no.roster3", ["no_roster"]);
    const ok = await request(app.getHttpServer()).post("/copilot/ask")
      .set("authorization", `Bearer ${reader.token}`).send({ question: "ortho mein abhi on call kaun hai?" }).expect(200);
    expect(ok.body).toMatchObject({ source: "phrasebook", intent: "roster.who_is_on", answer: { key: "copilot.answer.rosterWhoUnpublished", params: { dept: "Orthopaedics" } } });
    const no = await request(app.getHttpServer()).post("/copilot/ask")
      .set("authorization", `Bearer ${clerk.token}`).send({ question: "Saturday night koi le sakta hai kya?" }).expect(200);
    expect(no.body).toMatchObject({ intent: "roster.ask_cover", answer: { key: "copilot.answer.notPermitted" } });
  });
});
