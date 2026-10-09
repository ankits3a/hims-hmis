import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { istDayOf, newId } from "@hmis/contracts";
import { events, opdFlowFindings } from "../src/kernel/db/schema";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { insertVisits } from "./helpers/flow";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { requireEnv } from "../src/kernel/config";
import { ROLE_MODEL } from "../scripts/seed-roles";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * HOW LONG PATIENTS WAIT (owner 2026-10-09) — WHO reads the waits and WHO acts on a finding, with the
 * grants production's roles really hold (`ROLE_MODEL`). No permission was added: the read is the OPD
 * report's (`opd.reports.read`); × and "Tried it" also need the unbounded staff history, which only the
 * owner's and the Medical Superintendent's roles hold with it. And no patient or staff name in the JSON.
 */
describe("the waits — who reads, who acts, and no name in the payload", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  type Who = "owner" | "ms" | "doctor" | "desk" | "supervisor";
  let token: Record<Who, string>;
  let ids: Record<Who, string>;
  let deptId: string;
  let findingA: string; let findingB: string;

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
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    const roleOf: Record<Who, string> = { owner: "owner", ms: "medical_superintendent", doctor: "doctor", desk: "front_office", supervisor: "front_office_supervisor" };
    const tok = {} as Record<Who, string>; const id = {} as Record<Who, string>;
    for (const who of Object.keys(roleOf) as Who[]) {
      const grants = ROLE_MODEL.find((r) => r.roleKey === roleOf[who])!;
      await ensureRole(db, grants.roleKey);
      for (const p of grants.permissions) await grantPermissionToRole(db, registry, grants.roleKey, p);
      const u = await mkUser(db, `fw_${who}`, [grants.roleKey]);
      tok[who] = u.token; id[who] = u.id;
    }
    token = tok; ids = id;
    const dr = await mkDoctor(db, { username: "fw_dr", departmentId: deptId, roomId, displayName: "Dr. Sunita Waitcheck" });
    const p = await mkPatient(db, { type: "user", id: ids.desk }, { name: "Mohan Waitpatient", phone: "9811100022" });
    /* Today's visits, an hour ago and earlier — read through `period=today`, the server's own day. */
    const now = Date.now();
    const today = istDayOf(now);
    await insertVisits(db, { patientId: p.id, doctorId: dr.doctorId, by: ids.desk }, Array.from({ length: 6 }, (_, i) => ({
      departmentId: deptId, serviceDate: today, openedAt: new Date(Math.max(now - (60 + 5 * i) * 60_000, Date.parse(`${today}T00:01:00+05:30`))), a: 2, b: 3,
    })));
    findingA = newId(); findingB = newId();
    const row = (fid: string, hourFrom: number) => ({
      id: fid, findingKey: `bay_peak|${deptId}|desk_vitals|4|${String(hourFrom)}`, type: "bay_peak", scope: deptId, leg: "desk_vitals", weekday: 4, hourFrom, hourTo: hourFrom + 2,
      observedMin: 32, baselineMin: 18, patients: 10, minutesLost: 140, firstSeen: today, lastSeen: today,
    });
    await db.insert(opdFlowFindings).values([row(findingA, 10), row(findingB, 14)]);
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const get = (path: string, who: Who) => http().get(path).set("Authorization", `Bearer ${token[who]}`);
  const post = (path: string, who: Who) => http().post(path).set("Authorization", `Bearer ${token[who]}`);

  it("the owner, the Medical Superintendent and the front-office supervisor read; a doctor and the desk are refused", async () => {
    const want: Record<Who, number> = { owner: 200, ms: 200, supervisor: 200, doctor: 403, desk: 403 };
    for (const who of Object.keys(want) as Who[]) {
      const res = await get("/opd/reports/flow?period=today&groupBy=department", who);
      expect({ who, status: res.status }).toEqual({ who, status: want[who] });
    }
    const owner = (await get("/opd/reports/flow?period=today&groupBy=department", "owner")).body;
    expect(owner.hospital.deskToDoctor).toEqual({ n: 6, avg: 5, median: 5, p90: 5 });
    expect(owner.previous).toMatchObject({ deskToDoctor: { n: 0, avg: null } });
    expect(owner.groups).toHaveLength(1);
    expect(owner.findings.map((f: { id: string }) => f.id).sort()).toEqual([findingA, findingB].sort());
    expect([owner.mayAct, (await get("/opd/reports/flow?period=today", "ms")).body.mayAct, (await get("/opd/reports/flow?period=today", "supervisor")).body.mayAct]).toEqual([true, true, false]);
    /* No patient and no member of staff — in any field, at any depth, in any grouping. */
    for (const g of ["department", "day", "hour", "weekday"]) {
      const json = JSON.stringify((await get(`/opd/reports/flow?period=week&groupBy=${g}`, "owner")).body);
      for (const name of ["Mohan", "Waitpatient", "Sunita", "Waitcheck", "fw_", ...Object.values(ids)]) expect({ g, name, found: json.includes(name) }).toEqual({ g, name, found: false });
    }
    expect((await get("/opd/reports/flow?from=2026-01-01&to=2099-01-01", "owner")).status).toBe(400);
    expect((await get("/opd/reports/flow?period=today&groupBy=doctor", "owner")).status).toBe(400);
  });

  it("× and 'Tried it': the owner and the Medical Superintendent act, audited; the supervisor, a doctor and the desk are refused", async () => {
    for (const who of ["supervisor", "doctor", "desk"] as Who[]) {
      const res = await post(`/opd/reports/flow/findings/${findingA}/dismiss`, who);
      expect({ who, status: res.status }).toEqual({ who, status: 403 });
    }
    expect((await post(`/opd/reports/flow/findings/${findingA}/dismiss`, "ms")).status).toBe(200);
    expect((await post(`/opd/reports/flow/findings/${findingA}/dismiss`, "owner")).status).toBe(409);
    expect((await post(`/opd/reports/flow/findings/${findingB}/tried`, "owner")).status).toBe(200);
    expect((await post(`/opd/reports/flow/findings/${findingB}/tried`, "owner")).status).toBe(409);
    expect((await post(`/opd/reports/flow/findings/${newId()}/tried`, "owner")).status).toBe(404);
    const rows = await db.select().from(opdFlowFindings);
    expect(rows.find((r) => r.id === findingA)).toMatchObject({ state: "dismissed", dismissedBy: ids.ms });
    expect(rows.find((r) => r.id === findingB)).toMatchObject({ state: "open", triedBy: ids.owner, beforeMedianMin: 32 });
    const audit = [
      ...(await db.select().from(events).where(eq(events.name, "flow.finding_dismissed"))),
      ...(await db.select().from(events).where(eq(events.name, "flow.finding_tried"))),
    ].map((e) => [e.name, e.actorId, (e.payload as { findingId: string }).findingId]);
    expect(audit).toEqual([["flow.finding_dismissed", ids.ms, findingA], ["flow.finding_tried", ids.owner, findingB]]);
    /* The dismissed one leaves "To improve"; the tried one stays, with its day. */
    const after = (await get("/opd/reports/flow?period=today", "owner")).body;
    expect(after.findings.map((f: { id: string; triedOn: string | null }) => [f.id, f.triedOn !== null])).toEqual([[findingB, true]]);
  });
});
