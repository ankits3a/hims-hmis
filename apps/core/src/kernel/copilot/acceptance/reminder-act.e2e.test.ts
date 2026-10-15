import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.bootstrap";
import { syncPermissions } from "../../auth/permissions";
import { createUser } from "../../auth/identity";
import { createSession } from "../../auth/sessions";
import { ModuleRegistry } from "../../modules/loader";
import { ALL_MANIFESTS } from "../../modules/manifests";
import { alerts, copilotActs, copilotAsks, userReminders } from "../../db/schema";
import { requireEnv } from "../../config";
import { routeQuestion } from "../router";
import { maskQuestion } from "../mask";
import { PERSONAL_REMINDER_KIND, runDueReminders } from "../../reminders";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { testCfg } from "../../../../test/helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { CopilotReminderPick } from "@hmis/contracts";
import type { Proposal } from "../act";
import type { ChoiceClient, InferenceClient } from "../../inference/types";
import type { Db } from "../../db/client";

/**
 * ═══ E2.3 — A REMINDER FROM THE COPILOT CHAT: THE OWNER'S "DONE MEANS" ═══
 *
 * Spec /opt/hmis-context/SPEC-copilot-reminders-2026-10-12.md, approved by the owner 2026-10-12. LOCKED
 * once merged: add new checks, never edit one. The bare-hour rule ("at 4" asked at 10:00 and at 17:00)
 * needs a fixed "now" and is pinned in `kernel/reminders/copilot-words.test.ts`; here every day is named
 * relative to the real clock ("kal" = tomorrow, IST), so nothing goes stale.
 */
describe("E2.3 — a reminder from the copilot chat (acceptance)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  type Who = { id: string; token: string };
  let me: Who;

  const istDay = (plus: number): string => new Date(Date.now() + 330 * 60_000 + plus * 86_400_000).toISOString().slice(0, 10);
  const istAt = (plus: number, hhmm: string): string => new Date(`${istDay(plus)}T${hhmm}:00+05:30`).toISOString();
  const http = () => request(app.getHttpServer());
  const ask = (question: string) => http().post("/copilot/ask").set("Authorization", `Bearer ${me.token}`).send({ question }).expect(200);
  const confirm = (proposal: Proposal) => http().post("/copilot/confirm").set("Authorization", `Bearer ${me.token}`).send({ proposal }).expect(200);
  const setOnScreen = (body: object) => http().post("/reminders").set("Authorization", `Bearer ${me.token}`).send(body);
  const mine = () => db.select().from(userReminders).where(eq(userReminders.userId, me.id));

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
    const { id } = await createUser(db, { username: "sister.ward", fullName: "sister.ward", password: "p1234567" });
    me = { id, token: (await createSession(db, testCfg, id)).token };
  });

  it("done means 1 + 2: one card, nothing written by the ask; Confirm writes the row the Reminders screen writes", async () => {
    const asked = await ask("kal 4 baje remind me to see bed 12");
    expect(asked.body).toMatchObject({ source: "phrasebook", intent: "reminders.create", answer: { key: "copilot.answer.reminderPick", params: { when: istAt(1, "16:00") } } });
    expect(asked.body.answer.payload as CopilotReminderPick).toEqual({ kind: "reminderPick", text: "see bed 12", at: istAt(1, "16:00"), repeat: "none", proposal: 0 });
    expect(asked.body.proposals).toHaveLength(1);
    expect(await mine()).toHaveLength(0); // the ask wrote nothing

    const done = await confirm(asked.body.proposals[0]);
    expect(done.body).toEqual({ outcome: "done", answer: { key: "copilot.answer.reminderSet", params: { when: istAt(1, "16:00") } } });

    await setOnScreen({ text: "see bed 12", at: istAt(1, "16:00"), repeat: "none" }).expect(201);
    const rows = await mine();
    expect(rows).toHaveLength(2);
    const same = (r: (typeof rows)[number]) => ({ userId: r.userId, text: r.text, dueAt: r.dueAt.toISOString(), repeat: r.repeat, firedAt: r.firedAt, cancelledAt: r.cancelledAt });
    expect(same(rows[0]!)).toEqual(same(rows[1]!));
    const [act] = await db.select().from(copilotActs);
    expect(act).toMatchObject({ tool: "reminders.create", resultModule: "reminders", actorId: me.id, subjectPatientId: null });
    expect(rows.map((r) => r.id)).toContain(act!.resultRowId);
  });

  it("done means 3: Hindi days and a daily repeat", async () => {
    const hindi = await ask("kal subah 9 baje yaad dilana BP check");
    expect(hindi.body.answer.payload).toMatchObject({ text: "BP check", at: istAt(1, "09:00"), repeat: "none" });
    const daily = await ask("roz 8 baje medicine round yaad karana");
    const pick = daily.body.answer.payload as CopilotReminderPick;
    expect(pick).toMatchObject({ text: "medicine round", repeat: "daily" });
    expect([istAt(0, "08:00"), istAt(1, "08:00")]).toContain(pick.at);
    await confirm(daily.body.proposals[0]);
    expect((await mine())[0]).toMatchObject({ text: "medicine round", repeat: "daily" });
  });

  it("done means 4: no model is called, and neither ledger table holds the reminder's words", async () => {
    let calls = 0;
    const model: InferenceClient = { complete: () => { calls += 1; return Promise.reject(new Error("must not be called")); } } as unknown as InferenceClient;
    const chooser: ChoiceClient = { choose: () => { calls += 1; return Promise.reject(new Error("must not be called")); } };
    for (const typed of ["remind me at 4 to see bed 12", "kal subah 9 baje yaad dilana BP check", "remind me at 5 to apply leave", "yaad dilana kal 10 baje stock check"]) {
      const { masked, slots } = maskQuestion(typed, []);
      expect(await routeQuestion(masked, slots, model, chooser)).toMatchObject({ intent: "reminders.create", via: "phrasebook" });
    }
    expect(calls).toBe(0);

    const asked = await ask("kal 4 baje remind me to see bed 12 Ramesh");
    await confirm(asked.body.proposals[0]);
    const ledger = await db.select().from(copilotAsks);
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((r) => r.maskedQuestion === null)).toBe(true);
    const kept = JSON.stringify(ledger) + JSON.stringify(await db.select().from(copilotActs));
    expect(kept).not.toContain("bed 12");
    expect(kept).not.toContain("Ramesh");
  });

  it("done means 5: the 21st reminder is refused at the ask and at Confirm", async () => {
    for (let i = 0; i < 19; i += 1) await setOnScreen({ text: `r${String(i)}`, at: istAt(2, "10:00"), repeat: "none" }).expect(201);
    const asked = await ask("kal 4 baje remind me to see bed 12");
    expect(asked.body.answer.key).toBe("copilot.answer.reminderPick");
    await setOnScreen({ text: "r19", at: istAt(2, "10:00"), repeat: "none" }).expect(201);
    const late = await confirm(asked.body.proposals[0]);
    expect(late.body).toEqual({ outcome: "stateChanged", answer: { key: "copilot.answer.reminderLimit", params: {} } });
    expect(await mine()).toHaveLength(20);
    expect((await ask("kal 5 baje remind me to call home")).body.answer.key).toBe("copilot.answer.reminderLimit");
  });

  it("done means 6: the confirmed reminder rings through the bell, as one set on the screen does", async () => {
    const asked = await ask("kal 4 baje remind me to see bed 12");
    await confirm(asked.body.proposals[0]);
    expect(await runDueReminders(db, new Date(Date.parse(istAt(1, "16:00")) + 1000))).toBe(1);
    const bell = await db.select().from(alerts).where(and(eq(alerts.userId, me.id), eq(alerts.kind, PERSONAL_REMINDER_KIND)));
    expect(bell).toHaveLength(1);
    expect(bell[0]!.body).toBe("see bed 12");
  });

  it("refuses in one line what it cannot set, and writes nothing", async () => {
    expect((await ask("remind me to see bed 12")).body.answer.key).toBe("copilot.answer.reminderWhatTime");
    expect((await ask("kal 4 baje yaad dilana")).body.answer.key).toBe("copilot.answer.reminderWhat");
    expect((await ask(`kal 4 baje remind me to ${"x".repeat(81)}`)).body.answer.key).toBe("copilot.answer.reminderTooLong");
    expect(await mine()).toHaveLength(0);
  });
});
