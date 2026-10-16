import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ER_NOW_CARD_KEYS, ER_STAGE_WORDS, proposeEsi, renderSinceLine } from "@hmis/contracts";
import { alerts, erTriageEntries, events, labAnalytes, orderItems, orders, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { collect, enterResult, openCriticalsForEncounters, printLabels, receive } from "../lab";
import { serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import { collectCopilotIntents } from "../../kernel/copilot/catalog";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { matchIntent } from "../../kernel/copilot/phrasebook";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErMlcWorld } from "../../../test/helpers/emergency";
import { mkUser } from "../../../test/helpers/opd";
import {
  casualtyNowCard, doctorOverdueCard, emergencyCopilotTools, emergencyManifest, lwbsRiskCard, mlcCountersignDueCard, mlcIntimationDueCard,
  assignErDoctor, criticalResultCard, openMlc, placeErOrder, preAlert, preAlertCard, readErBoard, readErCare, readErWaitingDisplay, readSinceArrival,
  reTriage, recordErVitals, verifyErSinceLine, registerErChargeSink, registerErEncounterResolver, sweepErCareClocks, registerArrival, registerUnidentified, retriageDueCard, triage,
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
    expect(re!.rows![0]!.subtitle).toBe("ESI 4 · 27 min over");
    const [doc] = await doctorOverdueCard(ctx(w.erDoctor, late));
    expect(doc!.rows![0]!.subtitle).toBe("ESI 4 · 90 min (target 60)");
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
    const tv = (await mkUser(db, "er.waiting.tv", ["waiting_display"])).actor;
    const d = await readErWaitingDisplay(db, tv, { now });
    expect(d.rows).toEqual([{ token: plain.episodeNo.slice(-4), stage: "Waiting", stageHi: "प्रतीक्षा में" }]);
    const text = JSON.stringify(d);
    for (const n of ["Asha", "Geeta", "Meena", "abdominal", plain.uhid]) expect(text).not.toContain(n);
    for (const r of d.rows) expect(ER_STAGE_WORDS).toContain(r.stage);
  });

  it("the waiting-area TV's seat opens the waiting display and nothing else: not the wall board, not the staff board", async () => {
    const tv = (await mkUser(db, "er.waiting.tv", ["waiting_display"])).actor;
    await expect(readErWaitingDisplay(db, tv)).resolves.toMatchObject({ rows: [] });
    await expect(readErBoard(db, tv, { wall: true })).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(readErBoard(db, tv)).rejects.toMatchObject({ code: "er_forbidden" });
    // ...and the wall board's seat does not open the waiting display (each screen its own string).
    const wall = (await mkUser(db, "er.wall.tv", ["display"])).actor;
    await expect(readErWaitingDisplay(db, wall)).rejects.toMatchObject({ code: "er_forbidden" });
  });

  it("a critical on a RESTRICTED test keeps its urgency but shows its analyte and value only to the doctor who ordered it", async () => {
    const off = [registerErEncounterResolver(), registerErChargeSink()];
    try {
      const t0 = new Date(Date.now() - 30 * MIN);
      const a = await arrive("Pooja Kumari", t0);
      await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: t0 });
      await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, serviceIds: [serviceIdForLabCode("RFT")], indication: "Weakness" }, { now: t0, orderKinds: w.decls });
      const [o] = await db.select().from(orders).where(eq(orders.encounterNo, a.episodeNo));
      const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, o!.id));
      // The lab's sensitive class (consent-required): the restricted flag the lab itself keys DD11 on.
      await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, item!.id));
      const uhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, a.patientId)))[0]!.uhid;
      const { specimens } = await printLabels(db, w.bench, { orderGroupId: o!.orderGroupId, scannedUhid: uhid }, t0);
      for (const sp of specimens) {
        await withTx(db, (tx) => collect(tx, w.bench, { specimenId: sp.specimenId, wristbandScanned: true }, t0));
        await withTx(db, (tx) => receive(tx, w.bench, w.decls, { specimenNo: sp.specimenNo }, t0));
      }
      const k = (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "K")))[0]!;
      expect((await enterResult(db, w.bench, { orderItemId: item!.id, analyteId: k.id, value: "6.8", entryMode: "manual" }, t0)).criticalCallId).toBeTruthy();
      const now = new Date();
      // The doctor who ordered it reads the value everywhere.
      const [mine] = await criticalResultCard(ctx(w.erDoctor, now));
      expect(mine!.rows![0]!.subtitle).toContain("K 6.8");
      expect((await readSinceArrival(db, w.erDoctor, a.episodeId, { now })).lines.find((l) => l.source === "critical")!.text).toContain("K 6.8");
      // The casualty nurse (er.care, not the orderer, no `orders.read.restricted`) sees the urgency, never the content.
      const [theirs] = await criticalResultCard(ctx(w.erNurse, now));
      expect(theirs!.rows![0]).toMatchObject({ severity: "hot", subtitle: "Critical result (restricted test)" });
      const line = (await readSinceArrival(db, w.erNurse, a.episodeId, { now })).lines.find((l) => l.source === "critical")!;
      expect(line.text).toMatch(/^Critical result \(restricted test\) at \d\d:\d\d · not yet read back$/);
      const care = await readErCare(db, w.erNurse, a.episodeId);
      expect(JSON.stringify([theirs, line, care.criticals])).not.toMatch(/6\.8|"K"/);
      expect(care.criticals).toHaveLength(1);
      // The system sweep's bell (no reader) still rings at once and climbs on time, in the restricted wording only.
      const t1 = new Date(t0.getTime() + MIN);
      expect(await sweepErCareClocks(db, t1)).toMatchObject({ criticals: 1 });
      expect(await sweepErCareClocks(db, new Date(t1.getTime() + 15 * MIN))).toMatchObject({ climbs: 1 });
      const bells = await db.select().from(alerts).where(eq(alerts.refId, a.episodeId));
      const crit = bells.filter((b) => b.kind === "er.critical_result" || b.kind === "er.critical_unacknowledged");
      expect(crit.map((b) => b.kind)).toEqual(expect.arrayContaining(["er.critical_result", "er.critical_unacknowledged"]));
      for (const b of crit) expect(b.body).toBe("Critical result (restricted test)");
    } finally { off.forEach((f) => f()); }
  });

  it("triage recomputes the copilot's proposal itself: a client cannot send one, and the event says when the pick differs", async () => {
    const t0 = new Date(Date.now() - 20 * MIN);
    const p = await w.patient("male", 52, "Ramesh Prasad");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", complaint: "chest pain since 1 hour" }, { now: t0 });
    const decision = { lifeSaving: false, highRisk: true, resources: "many" as const, dangerVitals: false };
    // A level smuggled in by a client is not part of the contract: refused before anything is written.
    await expect(triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision, copilotLevel: 5 })).rejects.toThrow();
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision }, { now: new Date(t0.getTime() + 2 * MIN) });
    // A re-triage to ESI 4 (with its reason): the re-triage screen shows no copilot card, so nothing is logged as one.
    await reTriage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 4, reason: "pain settled" }, { now: new Date(t0.getTime() + 9 * MIN) });
    const entries = await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, a.episodeId));
    expect(entries.map((x) => [x.kind, x.level, x.copilotLevel]).sort()).toEqual([["re_triage", 4, null], ["triage", 2, 2]]);
    const evs = await db.select().from(events).where(eq(events.correlationId, a.episodeId));
    const payload = (name: string) => evs.find((x) => x.name === name)!.payload as Record<string, unknown>;
    expect(payload("er.triaged")).toMatchObject({ copilotLevel: 2, override: false });
    expect(payload("er.retriaged")).toMatchObject({ copilotLevel: null, override: false });
  });

  it("a since-line's template holds no number of its own, every slot has its fact, every fact its own column, every minute count its pinned instants", async () => {
    const t0 = new Date(Date.now() - 60 * MIN);
    const a = await arrive("Sita Devi", t0);
    await tri(a.episodeId, 3, new Date(t0.getTime() + 2 * MIN));
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: new Date(t0.getTime() + 20 * MIN) });
    await recordErVitals(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, vitals: { pulse: 118, systolic: 102 } }, { now: new Date(t0.getTime() + 25 * MIN) });
    const now = new Date();
    const since = await readSinceArrival(db, w.erDoctor, a.episodeId, { now });
    const ctx = { now, episodeNo: a.episodeNo, viewer: w.erDoctor };
    const vit = since.lines.find((l) => l.source === "vitals")!;
    const doc = since.lines.find((l) => l.source === "doctor")!;
    const check = (l: typeof vit) => verifyErSinceLine(db, l, ctx);
    expect(await check(vit)).toEqual({ ok: true });
    // A number, a number word, a Devanagari digit or a clock time written into the template itself.
    for (const extra of [" (was 140)", " twice", " ४", " at 09:15"]) {
      const t = `${vit.template}${extra}`;
      expect(await check({ ...vit, template: t, text: renderSinceLine(t, vit.facts) })).toEqual({ ok: false, reason: "template_states_a_number" });
    }
    // A slot with no fact behind it.
    const holed = `${vit.template} {${String(vit.facts.length)}}`;
    expect(await check({ ...vit, template: holed, text: renderSinceLine(holed, vit.facts) })).toEqual({ ok: false, reason: "slot_without_fact" });
    // A fact labelled as another column: the pulse's value presented as the systolic.
    const relabelled = vit.facts.map((f) => (f.field === "pulse" ? { ...f, field: "systolic" } : f));
    expect(await check({ ...vit, facts: relabelled })).toEqual({ ok: false, reason: "field_not_column:systolic" });
    // A minute count between instants its field does not name (arrival to arrival is 0, and 0 is "right" — but not allowed).
    const wrongPair = doc.facts.map((f) => (f.kind === "minutes" ? { ...f, value: 0, to: { ...f.ref } } : f));
    expect(await check({ ...doc, facts: wrongPair, text: renderSinceLine(doc.template, wrongPair) })).toEqual({ ok: false, reason: "minutes_pair_not_allowed:doorToDoctor" });
  });

  it("the lab's critical reader refuses to answer without a viewer; a system caller says so explicitly", async () => {
    await expect(openCriticalsForEncounters(db, ["ER26-000001"], undefined as never)).rejects.toThrow(/viewer/);
    await expect(openCriticalsForEncounters(db, ["ER26-000001"], { system: true })).resolves.toEqual([]);
    await expect(openCriticalsForEncounters(db, ["ER26-000001"], w.erDoctor)).resolves.toEqual([]);
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
