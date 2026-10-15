import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser } from "./helpers/opd";
import { requireEnv } from "../src/kernel/config";
import { withTx } from "../src/kernel/db/client";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { printJobs, rosterHolidays } from "../src/kernel/db/schema";
import { seedOrgDepartments, seedRosterPositions } from "../src/modules/roster/masters";
import { seedUnits, teamByCode } from "../src/modules/roster/teams";
import { addMembership } from "../src/modules/roster/memberships";
import { recordAbsence } from "../src/modules/roster/absences";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "../src/modules/roster/calendar";
import type { INestApplication } from "@nestjs/common";
import type { Db } from "../src/kernel/db/client";
import type { AebasTodo } from "../src/modules/roster/aebas";
import type { DutyEvidence, EvidencePickerDepartment } from "../src/modules/roster/evidence";

/**
 * 20-U U8 / U8b over HTTP — the doors, and what only a booted app proves: the OT module's
 * `onModuleInit` wires the theatre source and the roster's wires the print renderer, so the sheet the
 * screen previews names theatre among the records it read, and Print queues ONE job to the office's
 * A4. The rules themselves are `src/modules/roster/evidence.test.ts` and `aebas.test.ts`.
 */
describe("roster duty evidence + AEBAS e2e (20-U U8/U8b)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let ms: { id: string; token: string };
  let meena: { id: string; token: string };
  let reader: { id: string; token: string };
  let absenceId: string;
  const today = istDateOfInstant(new Date());
  const tomorrow = addIstDays(today, 1);

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
    await createRole(db, "roster_head", "Drafts and publishes rosters");
    for (const p of ["roster.read", "roster.periods.manage", "roster.periods.publish"]) await grantPermissionToRole(db, registry, "roster_head", p);
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await createRole(db, key, key);
    await grantPermissionToRole(db, registry, "doctor", "roster.read");
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    ms = await mkUser(db, "roster.head", ["roster_head"]);
    meena = await mkUser(db, "meena", ["doctor"]);
    reader = await mkUser(db, "ward.reader", ["doctor"]);
    const team = (await teamByCode(db, "MED-U2"))!.id;
    const actor = { type: "user" as const, id: ms.id };
    await withTx(db, (tx) => addMembership(tx, actor, {
      teamId: team, userId: meena.id, positionKey: "ward_jr", grade: "jr1", roleInTeam: "junior_resident", kind: "parent",
      startsAt: istMidnightUtc("2026-01-01"),
    }));
    absenceId = (await withTx(db, (tx) => recordAbsence(tx, actor, {
      userId: meena.id, kind: "CL", reason: "sister's wedding", startsAt: istMidnightUtc(tomorrow), endsAt: istMidnightUtc(addIstDays(tomorrow, 1)),
    }))).absenceId;
    await db.insert(rosterHolidays).values({ istDate: tomorrow, kind: "declared", declaredBy: ms.id, createdBy: ms.id, updatedBy: ms.id });
  });

  const http = () => request(app.getHttpServer());
  const as = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

  it("no session is refused at every new door", async () => {
    await http().get("/roster/evidence/people").expect(401);
    await http().get("/roster/evidence").expect(401);
    await http().post("/roster/evidence/print").send({}).expect(401);
    await http().get("/roster/aebas").expect(401);
    await http().post(`/roster/aebas/absences/${absenceId}/entered`).expect(401);
    await http().post(`/roster/aebas/holidays/${tomorrow}/entered`).expect(401);
  });

  it("the duty-evidence report: a reader is refused; the MS previews the sheet and prints one job to the office's A4", async () => {
    const q = `/roster/evidence?users=${meena.id}&from=${today}&to=${tomorrow}`;
    expect(((await http().get(q).set(as(reader)).expect(403)).body as { code: string }).code).toBe("not_permitted");
    expect(((await http().get("/roster/evidence/people").set(as(reader)).expect(200)).body as { departments: EvidencePickerDepartment[] }).departments).toEqual([]);

    const picker = ((await http().get("/roster/evidence/people").set(as(ms)).expect(200)).body as { departments: EvidencePickerDepartment[] }).departments;
    expect(picker.flatMap((d) => d.people.map((p) => p.userId))).toEqual([meena.id]);
    const got = (await http().get(q).set(as(ms)).expect(200)).body as { report: DutyEvidence; html: string };
    expect(got.report.sources).toEqual(["roster", "leave", "holidays", "theatre"]);
    expect(got.html).toContain("Approved leave or deputation on record");
    expect(got.html).not.toMatch(/wedding|sister/);

    const printed = (await http().post("/roster/evidence/print").set(as(ms)).send({ userIds: [meena.id], from: today, to: tomorrow }).expect(200)).body as { queued: boolean; ref: string; served: boolean };
    expect(printed).toEqual({ queued: true, ref: got.report.ref, served: false });
    expect((await db.select().from(printJobs)).map((j) => [j.document, j.destination])).toEqual([["roster_duty_evidence", "office_a4"]]);
    await http().post("/roster/evidence/print").set(as(reader)).send({ userIds: [meena.id], from: today, to: tomorrow }).expect(403);
  });

  it("the AEBAS list: due today, one tap each, and it leaves the list; a reader is refused", async () => {
    await http().get("/roster/aebas").set(as(reader)).expect(403);
    await http().post(`/roster/aebas/absences/${absenceId}/entered`).set(as(reader)).expect(403);
    const todo = (await http().get("/roster/aebas").set(as(ms)).expect(200)).body as AebasTodo;
    expect(todo.items.map((i) => [i.key, i.state])).toEqual([[`holiday:${tomorrow}`, "due_today"], [`absence:${absenceId}`, "due_today"]]);
    expect(JSON.stringify(todo)).not.toMatch(/wedding/);
    const after = (await http().post(`/roster/aebas/absences/${absenceId}/entered`).set(as(ms)).expect(200)).body as AebasTodo;
    expect(after.items.map((i) => i.key)).toEqual([`holiday:${tomorrow}`]);
    const done = (await http().post(`/roster/aebas/holidays/${tomorrow}/entered`).set(as(ms)).expect(200)).body as AebasTodo;
    expect(done.items).toEqual([]);
    expect(done.recentlyEntered.map((i) => i.key).sort()).toEqual([`absence:${absenceId}`, `holiday:${tomorrow}`].sort());
  });
});
