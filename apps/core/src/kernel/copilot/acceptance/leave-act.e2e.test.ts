import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../auth/permissions";
import { createUser } from "../../auth/identity";
import { createSession } from "../../auth/sessions";
import { ModuleRegistry } from "../../modules/loader";
import { ALL_MANIFESTS } from "../../modules/manifests";
import { copilotActs, copilotAsks, orgDepartments, staffAbsences } from "../../db/schema";
import { requireEnv } from "../../config";
import { routeQuestion } from "../router";
import { maskQuestion } from "../mask";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { testCfg } from "../../../../test/helpers/opd";
import { seedOrgDepartments } from "../../../modules/roster/masters";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { CopilotLeavePick } from "@hmis/contracts";
import type { Proposal } from "../act";
import type { ChoiceClient, InferenceClient } from "../../inference/types";
import type { Db } from "../../db/client";

/**
 * ═══ E2.2 — LEAVE FROM THE COPILOT CHAT: THE OWNER'S "DONE MEANS" ═══
 *
 * Spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md, approved by the owner 2026-10-11. LOCKED
 * once merged: add new checks, never edit one. Done-means 5 (a chat cover/swap equals a My-duties request,
 * and a rule break is refused at confirm) needs a published roster and lives beside the roster's tool
 * tests (`modules/roster/copilot-tools.test.ts`); done-means 6 (the phone says the web's words) is the
 * clients' parity tests.
 *
 * Every day is relative to the real clock ("parso" = the day after tomorrow, IST).
 */
describe("E2.2 — leave from the copilot chat (acceptance)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  type Who = { id: string; token: string };
  let jr: Who;
  let hod: Who;
  let MED: string;

  const istDay = (plus: number): string => new Date(Date.now() + 330 * 60_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const http = () => request(app.getHttpServer());
  const ask = (w: Who, question: string) => http().post("/copilot/ask").set("Authorization", `Bearer ${w.token}`).send({ question }).expect(200);
  const confirm = (w: Who, proposal: Proposal) => http().post("/copilot/confirm").set("Authorization", `Bearer ${w.token}`).send({ proposal }).expect(200);
  const leaves = () => db.select().from(staffAbsences);

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

  const person = async (username: string, role: string, dept: string): Promise<Who> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await assignRole(db, { userId: id, roleKey: role, scopeType: "department", scopeId: dept });
    return { id, token: (await createSession(db, testCfg, id)).token };
  };

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOrgDepartments(db);
    MED = (await db.select().from(orgDepartments)).find((d) => d.code === "MED")!.id;
    await createRole(db, "resident", "Resident");
    await createRole(db, "hod", "HOD");
    for (const p of ["roster.read", "roster.periods.publish"]) await grantPermissionToRole(db, registry, "hod", p);
    jr = await person("jr.med", "resident", MED);
    hod = await person("hod.med", "hod", MED);
  });

  it("done means 1: a chat leave and a screen leave show alike in the head's list, and approving either writes the same row", async () => {
    const screen = (await http().post("/roster/leave").set("Authorization", `Bearer ${jr.token}`)
      .send({ kind: "CL", from: istDay(10), to: istDay(10) }).expect(200)).body as { absenceId: string };

    const asked = await ask(jr, "parso CL chahiye");
    expect(asked.body).toMatchObject({ source: "phrasebook", intent: "roster.leave_apply", answer: { key: "copilot.answer.leavePickDay", params: { kind: "CL", from: istDay(2), to: istDay(2), count: 1 } } });
    const pick = asked.body.answer.payload as CopilotLeavePick;
    expect(pick).toEqual({ kind: "leavePick", from: istDay(2), to: istDay(2), days: 1, options: [{ leave: "CL", proposal: 0 }] });
    expect(await leaves()).toHaveLength(1); // the ask wrote nothing

    const done = await confirm(jr, asked.body.proposals[0]);
    expect(done.body).toEqual({ outcome: "done", answer: { key: "copilot.answer.leaveFiled", params: { kind: "CL", from: istDay(2), to: istDay(2) } } });

    const list = (await http().get("/roster/leave/to-decide").set("Authorization", `Bearer ${hod.token}`).expect(200)).body as { id: string; name: string; department: string | null; kind: string; days: number }[];
    expect(list).toHaveLength(2);
    const chat = list.find((l) => l.id !== screen.absenceId)!;
    const viaScreen = list.find((l) => l.id === screen.absenceId)!;
    const shape = (l: typeof chat) => ({ name: l.name, department: l.department, kind: l.kind, days: l.days });
    expect(shape(chat)).toEqual(shape(viaScreen));

    for (const l of list) await http().post(`/roster/leave/${l.id}/decide`).set("Authorization", `Bearer ${hod.token}`).send({ approve: true }).expect(200);
    const rows = await leaves();
    const same = (r: (typeof rows)[number]) => ({
      userId: r.userId, kind: r.kind, status: r.status, requestedBy: r.requestedBy, approvedBy: r.approvedBy, reason: r.reason,
      source: r.source, departmentId: r.departmentId, decisionNote: r.decisionNote,
    });
    expect(same(rows.find((r) => r.id === chat.id)!)).toEqual(same(rows.find((r) => r.id === screen.absenceId)!));
    const [act] = await db.select().from(copilotActs);
    expect(act).toMatchObject({ tool: "roster.leave_apply", resultModule: "roster", resultRowId: chat.id, actorId: jr.id, subjectPatientId: null });
  });

  it("done means 2: a refusal's reason comes back in chat to its person", async () => {
    const asked = await ask(jr, "parso CL chahiye");
    await confirm(jr, asked.body.proposals[0]);
    const [row] = await leaves();
    await http().post(`/roster/leave/${row!.id}/decide`).set("Authorization", `Bearer ${hod.token}`).send({ approve: false, note: "OPD short that week" }).expect(200);
    const status = await ask(jr, "meri leave ka kya hua?");
    expect(status.body).toMatchObject({ intent: "roster.leave_status", answer: { key: "copilot.answer.leaveStatusRefused", params: { kind: "CL", who: "hod.med", why: "OPD short that week" } } });
  });

  it("done means 3: the person who filed it from chat cannot approve it", async () => {
    // The head files their own leave from chat; the decide route refuses them, and their list never shows it.
    const asked = await ask(hod, "parso CL chahiye");
    await confirm(hod, asked.body.proposals[0]);
    const [row] = await leaves();
    const res = await http().post(`/roster/leave/${row!.id}/decide`).set("Authorization", `Bearer ${hod.token}`).send({ approve: true }).expect(409);
    expect((res.body as { code: string }).code).toBe("absence_self_approval");
    expect((await http().get("/roster/leave/to-decide").set("Authorization", `Bearer ${hod.token}`).expect(200)).body).toEqual([]);
    expect((await leaves())[0]!.status).toBe("requested");
  });

  it("done means 4: no leave reason reaches the ledger, a model or the proposal", async () => {
    let calls = 0;
    const model: InferenceClient = { complete: () => { calls += 1; return Promise.reject(new Error("must not be called")); } } as unknown as InferenceClient;
    const chooser: ChoiceClient = { choose: () => { calls += 1; return Promise.reject(new Error("must not be called")); } };
    const typed = "parso se 2 din ki chhutti chahiye, papa ICU mein hain";
    const { masked, slots } = maskQuestion(typed, []);
    expect(await routeQuestion(masked, slots, model, chooser)).toMatchObject({ intent: "roster.leave_apply", via: "phrasebook" });
    const status = maskQuestion("meri chhutti ka kya hua", []);
    expect(await routeQuestion(status.masked, status.slots, model, chooser)).toMatchObject({ intent: "roster.leave_status", via: "phrasebook" });
    expect(calls).toBe(0);

    const asked = await ask(jr, typed);
    expect(asked.body.answer.key).toBe("copilot.answer.leavePickKind");
    expect(JSON.stringify(asked.body)).not.toContain("ICU");
    const done = await confirm(jr, asked.body.proposals[0]);
    expect(done.body.outcome).toBe("done");
    const ledger = await db.select().from(copilotAsks);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((r) => r.maskedQuestion === null)).toBe(true);
    expect(JSON.stringify(ledger)).not.toContain("ICU");
    expect(JSON.stringify(await db.select().from(copilotActs))).not.toContain("ICU");
    const [row] = await leaves();
    expect(row!.reason).toBeNull();
  });

  it("refuses at confirm what became impossible, and a past day at ask", async () => {
    const asked = await ask(jr, "parso CL chahiye");
    await http().post("/roster/leave").set("Authorization", `Bearer ${jr.token}`).send({ kind: "EL", from: istDay(2), to: istDay(3) }).expect(200);
    const late = await confirm(jr, asked.body.proposals[0]);
    expect(late.body).toEqual({ outcome: "stateChanged", answer: { key: "copilot.answer.leaveOverlaps", params: {} } });
    expect(await leaves()).toHaveLength(1);
    expect((await ask(jr, "leave chahiye")).body.answer.key).toBe("copilot.answer.leaveWhichDays");
  });
});
