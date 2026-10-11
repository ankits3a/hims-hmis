import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testCfg } from "./helpers/opd";
import { createSession } from "../src/kernel/auth/sessions";
import { createUser } from "../src/kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { collectDeskProviders } from "../src/kernel/desk/registry";
import { loadWaiting } from "../src/kernel/desk/waiting";
import { requireEnv } from "../src/kernel/config";
import { alerts, events, orgDepartments, staffAbsences } from "../src/kernel/db/schema";
import { alertsConsumer } from "../src/kernel/alerts/consumer";
import { seedOrgDepartments } from "../src/modules/roster/masters";
import type { Actor } from "@hmis/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Db } from "../src/kernel/db/client";

/**
 * E2.2 (decision 0069) — MY LEAVE AND THE DECIDER'S LIST, over real HTTP
 * (spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md, PR a):
 *
 *   1. a junior resident holding no roster string files their own leave, and it waits in THEIR department's list;
 *   2. a refusal needs a reason, the reason comes back on My leave, and NO bell row carries it;
 *   3. the requester cannot approve their own, on the screen's route (fail-first: before E2.2 no route existed);
 *   4. Waiting for me counts the leave waiting for a decider and the leave refused to the person.
 *
 * Days are built from the real clock (the route reads it to refuse a past day), never pinned.
 */
describe("E2.2 — my leave, the decider's list, and the answer back", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let MED: string;
  let SUR: string;
  const who: Record<"jr" | "medHod" | "surHod" | "ms" | "nurse", { id: string; token: string; actor: Actor }> = {} as never;

  const istDay = (plusDays: number): string =>
    new Date(Date.now() + 330 * 60_000 + plusDays * 86_400_000).toISOString().slice(0, 10);

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

  const person = async (username: string, roles: { key: string; dept?: string }[]) => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    for (const r of roles) {
      await assignRole(db, r.dept === undefined
        ? { userId: id, roleKey: r.key, scopeType: "hospital" }
        : { userId: id, roleKey: r.key, scopeType: "department", scopeId: r.dept });
    }
    const { token } = await createSession(db, testCfg, id);
    return { id, token, actor: { type: "user" as const, id } };
  };

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOrgDepartments(db);
    const depts = await db.select().from(orgDepartments);
    MED = depts.find((d) => d.code === "MED")!.id;
    SUR = depts.find((d) => d.code === "SUR")!.id;
    for (const key of ["hod", "ms", "resident", "nurse"]) await createRole(db, key, key);
    for (const p of ["roster.read", "roster.periods.publish"]) {
      await grantPermissionToRole(db, registry, "hod", p);
      await grantPermissionToRole(db, registry, "ms", p);
    }
    who.jr = await person("jr.med", [{ key: "resident", dept: MED }]);
    who.medHod = await person("hod.med", [{ key: "hod", dept: MED }]);
    who.surHod = await person("hod.sur", [{ key: "hod", dept: SUR }]);
    who.ms = await person("ms", [{ key: "ms" }]);
    who.nurse = await person("nurse", [{ key: "nurse" }]);
  });

  const as = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string, body: unknown = {}) => request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body as object),
  });

  /** Run the alerts consumer over every stored event, as the worker would. */
  const deliver = async () => {
    const handle = alertsConsumer(db);
    for (const row of await db.select().from(events)) {
      if (!row.name.startsWith("roster.absence_")) continue;
      await handle({ seq: Number(row.seq), eventId: row.eventId, name: row.name, payload: row.payload, patientId: row.patientId, correlationId: row.correlationId, occurredAt: row.occurredAt });
    }
  };

  const file = (token: string, over: Record<string, unknown> = {}) =>
    as(token).post("/roster/leave", { kind: "CL", from: istDay(3), to: istDay(4), reason: "my father is in ICU at Patna", ...over });

  it("a junior resident files their own leave; it waits in MEDICINE's list, not surgery's, with the reason for its decider", async () => {
    const res = await file(who.jr.token).expect(200);
    const id = (res.body as { absenceId: string }).absenceId;
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, id));
    expect(row).toMatchObject({ userId: who.jr.id, status: "requested", departmentId: MED, kind: "CL" });

    const mine = (await as(who.jr.token).get("/roster/leave/mine").expect(200)).body as { id: string; status: string; days: number; canCancel: boolean }[];
    expect(mine).toEqual([expect.objectContaining({ id, status: "requested", days: 2, canCancel: true })]);

    const med = (await as(who.medHod.token).get("/roster/leave/to-decide").expect(200)).body as { id: string; reason: string | null }[];
    expect(med).toEqual([expect.objectContaining({ id, reason: "my father is in ICU at Patna" })]);
    expect((await as(who.surHod.token).get("/roster/leave/to-decide").expect(200)).body).toEqual([]);
    expect((await as(who.nurse.token).get("/roster/leave/to-decide").expect(200)).body).toEqual([]);
    // Hospital-wide still decides.
    expect(((await as(who.ms.token).get("/roster/leave/to-decide").expect(200)).body as unknown[]).length).toBe(1);

    // The deciders are told a leave waits — a name and days, never the reason; the person is not told.
    await deliver();
    const bell = await db.select().from(alerts).where(eq(alerts.kind, "roster_leave_requested"));
    expect(bell.map((a) => a.userId).sort()).toEqual([who.medHod.id, who.ms.id].sort());
    expect(bell.every((a) => !`${a.title} ${a.body}`.includes("ICU"))).toBe(true);
  });

  it("the requester cannot approve their own leave on the screen's route, even holding the department's publish", async () => {
    const hodOwn = (await file(who.medHod.token).expect(200)).body as { absenceId: string };
    const res = await as(who.medHod.token).post(`/roster/leave/${hodOwn.absenceId}/decide`, { approve: true }).expect(409);
    expect((res.body as { code: string }).code).toBe("absence_self_approval");
    // Nor does it appear in their own list to decide.
    expect((await as(who.medHod.token).get("/roster/leave/to-decide").expect(200)).body).toEqual([]);
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, hodOwn.absenceId));
    expect(row!.status).toBe("requested");
  });

  it("another department's head cannot decide it; its own head refuses it only with a reason, and the reason comes back on My leave only", async () => {
    const { absenceId } = (await file(who.jr.token).expect(200)).body as { absenceId: string };
    expect(((await as(who.surHod.token).post(`/roster/leave/${absenceId}/decide`, { approve: false, note: "x" }).expect(403)).body as { code: string }).code).toBe("not_permitted");
    expect(((await as(who.medHod.token).post(`/roster/leave/${absenceId}/decide`, { approve: false }).expect(422)).body as { code: string }).code).toBe("invalid_window");
    await as(who.medHod.token).post(`/roster/leave/${absenceId}/decide`, { approve: false, note: "Two residents already away that week" }).expect(200);

    const mine = (await as(who.jr.token).get("/roster/leave/mine").expect(200)).body as { status: string; refusal: string | null; decidedBy: string | null }[];
    expect(mine[0]).toMatchObject({ status: "rejected", refusal: "Two residents already away that week", decidedBy: "hod.med" });

    await deliver();
    const told = await db.select().from(alerts).where(and(eq(alerts.kind, "roster_leave_decided"), eq(alerts.userId, who.jr.id)));
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe("Your leave was not approved");
    expect(`${told[0]!.title} ${told[0]!.body}`).not.toContain("residents");
    // The refused event says THAT, never why.
    const ev = (await db.select().from(events)).find((e) => e.name === "roster.absence_refused")!;
    expect(JSON.stringify(ev.payload)).not.toContain("residents");

    const waiting = await loadWaiting(collectDeskProviders(registry), { db, actor: who.jr.actor, reader: who.jr.actor, date: istDay(0), now: new Date() });
    expect(waiting.items.find((i) => i.kind === "roster.leaveRefused")?.count).toBe(1);
  });

  it("Waiting for me counts the leave waiting for its decider; approving clears it and tells the person", async () => {
    const { absenceId } = (await file(who.jr.token).expect(200)).body as { absenceId: string };
    const before = await loadWaiting(collectDeskProviders(registry), { db, actor: who.medHod.actor, reader: who.medHod.actor, date: istDay(0), now: new Date() });
    expect(before.items.find((i) => i.kind === "roster.leaveToDecide")?.count).toBe(1);
    await as(who.medHod.token).post(`/roster/leave/${absenceId}/decide`, { approve: true }).expect(200);
    const after = await loadWaiting(collectDeskProviders(registry), { db, actor: who.medHod.actor, reader: who.medHod.actor, date: istDay(0), now: new Date() });
    expect(after.items.find((i) => i.kind === "roster.leaveToDecide")).toBeUndefined();
    await deliver();
    const told = await db.select().from(alerts).where(and(eq(alerts.kind, "roster_leave_decided"), eq(alerts.userId, who.jr.id)));
    expect(told.map((a) => a.title)).toEqual(["Your leave is approved"]);
  });

  it("refuses a past day, an overlap, a manager-only kind, and somebody else's cancel", async () => {
    expect(((await file(who.jr.token, { from: istDay(-1), to: istDay(0) }).expect(422)).body as { code: string }).code).toBe("leave_in_past");
    const { absenceId } = (await file(who.jr.token).expect(200)).body as { absenceId: string };
    expect(((await file(who.jr.token, { from: istDay(4), to: istDay(6) }).expect(409)).body as { code: string }).code).toBe("leave_overlaps");
    expect(((await file(who.jr.token, { kind: "maternity", from: istDay(20), to: istDay(21) }).expect(422)).body as { code: string }).code).toBe("unknown_absence_kind");
    await as(who.nurse.token).post(`/roster/leave/${absenceId}/cancel`).expect(404);
    await as(who.jr.token).post(`/roster/leave/${absenceId}/cancel`).expect(200);
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.status).toBe("cancelled");
  });
});
