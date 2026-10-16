import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ER_NOW_CARD_KEYS, ER_STAGE_WORDS, proposeEsi } from "@hmis/contracts";
import { patients } from "../../kernel/db/schema";
import { collectCopilotIntents } from "../../kernel/copilot/catalog";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { matchIntent } from "../../kernel/copilot/phrasebook";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErMlcWorld } from "../../../test/helpers/emergency";
import {
  casualtyNowCard, doctorOverdueCard, emergencyCopilotTools, emergencyManifest, lwbsRiskCard, mlcCountersignDueCard, mlcIntimationDueCard,
  openMlc, preAlert, preAlertCard, readErWaitingDisplay, registerArrival, registerUnidentified, retriageDueCard, triage,
} from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { ErMlcWorld } from "../../../test/helpers/emergency";

/**
 * ER lane 9 (#816) — the copilot's rules beyond the locked done-means: the ESI proposal's decision points, the Now cards
 * (each appears only while something is owed; names as the reader may see them; no money), the waiting display (stage
 * words only; MLC and sealed patients absent) and the two floor-only copilot questions.
 */

jest.setTimeout(240_000);
const key = (): string => randomUUID();
const MIN = 60_000;
const MONEY = /₹|\brs\b|rupee|paise|\bpaid\b|unpaid|deposit|\bbill\b|amount/i;

describe("proposeEsi (pure)", () => {
  it("answers each decision point from the record and says why", () => {
    expect(proposeEsi({ complaint: "found behosh on the road", ageYears: 40, ageBand: null, vitals: null })).toMatchObject({ level: 1, decision: { lifeSaving: true } });
    expect(proposeEsi({ complaint: null, ageYears: 40, ageBand: null, vitals: { spo2: 86 } }).level).toBe(1);
    // A child of 5: pulse 150 is in the danger zone (above 140); with many resources the algorithm says ESI 2.
    const child = proposeEsi({ complaint: "fever and vomiting", ageYears: 5, ageBand: null, vitals: { pulse: 150, respRate: 26 } });
    expect(child).toMatchObject({ level: 2, decision: { dangerVitals: true, resources: "many" } });
    expect(child.reasons.join(" ")).toContain("pulse 150 (above 140)");
    expect(proposeEsi({ complaint: "prescription refill", ageYears: 60, ageBand: null, vitals: { pulse: 80 } })).toMatchObject({ level: 5, resourcesGuessed: false });
    // "rta" is a word, not a substring of "portal"; an unknown complaint guesses one resource and says so.
    const plain = proposeEsi({ complaint: "came from the portal", ageYears: 30, ageBand: null, vitals: null });
    expect(plain).toMatchObject({ level: 4, resourcesGuessed: true, decision: { highRisk: false } });
    expect(proposeEsi({ complaint: "RTA, bike skid", ageYears: 30, ageBand: null, vitals: null }).decision.highRisk).toBe(true);
  });
});

describe("ER copilot — Now cards, waiting display, copilot questions", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
  });

  const ctx = (actor: Actor, now: Date): DeskProviderCtx => ({ db, actor, reader: actor, date: now.toISOString().slice(0, 10), now });
  const arrive = async (name: string, now: Date) => {
    const p = await w.patient("female", 45, name);
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", complaint: "abdominal pain" }, { now });
  };
  const tri = (episodeId: string, level: 1 | 2 | 3 | 4 | 5, now: Date) => triage(db, w.erNurse, {
    idempotencyKey: key(), episodeId, level, reason: "test", decision: { lifeSaving: false, highRisk: level <= 2, resources: level <= 3 ? "many" : "one", dangerVitals: false },
  }, { now });

  it("declares exactly the spec's Now cards, each behind a declared permission", () => {
    expect((emergencyManifest.desk ?? []).map((d) => d.key).sort()).toEqual([...ER_NOW_CARD_KEYS].sort());
    for (const d of emergencyManifest.desk ?? []) expect(emergencyManifest.permissions).toContain(d.permission);
  });

  it("re-triage due, door-to-doctor overdue and LWBS risk appear only when owed, with the patient's name and no money", async () => {
    const t0 = new Date(Date.now() - 3 * 60 * MIN);
    const a = await arrive("Sunita Devi", t0);
    await tri(a.episodeId, 4, new Date(t0.getTime() + 3 * MIN));
    // 30 minutes after the gate: ESI 4 re-triage (60 min) is not due, the doctor (60 min) not overdue, no LWBS risk.
    const early = new Date(t0.getTime() + 30 * MIN);
    expect(await retriageDueCard(ctx(w.erNurse, early))).toEqual([]);
    expect(await doctorOverdueCard(ctx(w.erDoctor, early))).toEqual([]);
    expect(await lwbsRiskCard(ctx(w.erNurse, early))).toEqual([]);
    // 90 minutes after the gate: all three.
    const late = new Date(t0.getTime() + 90 * MIN);
    const [re] = await retriageDueCard(ctx(w.erNurse, late));
    expect(re!.rows!.map((r) => [r.title, r.href])).toEqual([["Sunita Devi", `/er/triage?episode=${a.episodeId}`]]);
    expect(re!.rows![0]!.subtitle).toContain("ESI 4 Less urgent");
    const [doc] = await doctorOverdueCard(ctx(w.erDoctor, late));
    expect(doc!.rows![0]!.subtitle).toContain("waiting 90 min (target 60)");
    const [lwbs] = await lwbsRiskCard(ctx(w.erNurse, late));
    expect(lwbs!.rows!.map((r) => r.id)).toEqual([a.episodeId]);
    expect(JSON.stringify([re, doc, lwbs])).not.toMatch(MONEY);
  });

  it("MLC intimation and countersign cards follow the obligations' clocks; an unknown shows by alias", async () => {
    const now = new Date();
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108" }, { now });
    // Opened by rule at arrival: the intimation is due in 1 h — inside the card's 15-minute lead only near the end.
    expect(await mlcIntimationDueCard(ctx(w.erDesk, now))).toEqual([]);
    const [due] = await mlcIntimationDueCard(ctx(w.erDesk, new Date(now.getTime() + 70 * MIN)));
    expect(due!.rows![0]).toMatchObject({ title: u.alias, severity: "hot", badge: "MLC" });
    const [cs] = await mlcCountersignDueCard(ctx(w.erDoctor, new Date(now.getTime() + 23 * 60 * MIN)));
    expect(cs!.rows).toHaveLength(1);
  });

  it("pre-alert and casualty-now cards: the expected ambulance and the department's pulse", async () => {
    const now = new Date();
    await preAlert(db, w.erDesk, { idempotencyKey: key(), mode: "ambulance_108", etaMinutes: 10, count: 2, complaint: "RTA, two injured" }, { now });
    const [pa] = await preAlertCard(ctx(w.erDesk, now));
    expect(pa!.rows![0]).toMatchObject({ badge: "2", title: "108 ambulance · RTA, two injured" });
    await arrive("Kamla Devi", now);
    const [pulse] = await casualtyNowCard(ctx(w.erDesk, now));
    expect(Object.fromEntries(pulse!.stats!.map((s) => [s.key, s.value]))).toMatchObject({
      "desk.erCasualtyNow.inDepartment": "1", "desk.erCasualtyNow.waitingTriage": "1", "desk.erCasualtyNow.expected": "1",
    });
  });

  it("a sealed patient's Now row carries no name and no bay", async () => {
    const t0 = new Date(Date.now() - 2 * 60 * MIN);
    const a = await arrive("Rekha Kumari", t0);
    await tri(a.episodeId, 4, new Date(t0.getTime() + 2 * MIN));
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, a.patientId));
    const [re] = await retriageDueCard(ctx(w.erNurse, new Date()));
    expect(JSON.stringify(re)).not.toContain("Rekha");
  });

  it("the waiting display shows a token and a stage word only; MLC and sealed patients are absent", async () => {
    const now = new Date();
    const plain = await arrive("Asha Rani", now);
    const mlcCase = await arrive("Geeta Devi", now);
    await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: mlcCase.episodeId, category: "assault" }, { now });
    const sealed = await arrive("Meena Kumari", now);
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, sealed.patientId));
    const d = await readErWaitingDisplay(db, w.erDesk, { now });
    expect(d.rows).toEqual([{ token: plain.episodeNo.slice(-4), stage: "Waiting", stageHi: "प्रतीक्षा में" }]);
    const text = JSON.stringify(d);
    for (const n of ["Asha", "Geeta", "Meena", "abdominal", plain.uhid]) expect(text).not.toContain(n);
    for (const r of d.rows) expect(ER_STAGE_WORDS).toContain(r.stage);
  });

  it("the two copilot questions route by the floor and answer counts only", async () => {
    const reg = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) reg.install(m);
    expect(collectCopilotIntents(reg).map((c) => c.intent)).toEqual(expect.arrayContaining(["emergency.casualty_now", "emergency.mlc_due"]));
    expect(matchIntent("casualty mein abhi kitne patient hain")?.intent).toBe("emergency.casualty_now");
    expect(matchIntent("MLC intimation kitne baaki hain")?.intent).toBe("emergency.mlc_due");
    // "counter mein" is not the ER.
    expect(matchIntent("counter mein kitne log hain")?.intent).not.toBe("emergency.casualty_now");

    const now = new Date();
    await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "ambulance_108" }, { now });
    const tool = (i: string) => emergencyCopilotTools.find((t) => t.intent === i)!;
    const base = { db, actor: w.erDesk, subject: null, serviceDate: now.toISOString().slice(0, 10), question: "" };
    expect(await tool("emergency.casualty_now").run(base)).toMatchObject({ key: "copilot.answer.erCasualtyNow", params: { inDepartment: 1, waitingTriage: 1 } });
    expect(await tool("emergency.mlc_due").run(base)).toEqual({ key: "copilot.answer.erMlcDue", params: { intimations: 1, countersigns: 1, overdue: 0 } });
  });
});
