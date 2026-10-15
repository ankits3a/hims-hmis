import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alerts, erCodes } from "../../../kernel/db/schema";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErCareWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, callCode, endCode, placeInBay, readErCode, recordCodeDebrief, recordCodeEvent, registerArrival, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErCareWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 7 (#814) — THE CODES' RULES (spec §4.7): Code Grey pages security alone with the place and drafts the incident;
 * Code Blue anywhere; the record by tap (scribe, paper back-fill flagged, append-only); one running code of a kind per
 * patient, two codes at once are two records; the end by a doctor with an outcome; the debrief by that leader, once.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 7 er-codes — the rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErCareWorld(db);
  });

  const inBay = async (gate: Date) => {
    const p = await w.patient("female", 47, "Code Patient");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } }, { now: gate });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: await w.bed("ER-R4", { class: "emergency" }) }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };

  it("Code Grey: security alone is paged, with the place; no patient needed; an incident report is drafted", async () => {
    await ensureRole(db, "security_guard");
    const guard = (await mkUser(db, "er.guard", ["security_guard"])).actor;
    const r = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_grey", place: "Triage desk", note: "Relative threatening staff" });
    const pages = await db.select().from(alerts).where(eq(alerts.refId, r.codeId));
    expect(pages.map((p) => [p.userId, p.kind, p.body])).toEqual([[guard.id, "er.code_grey", "Security to Triage desk"]]);
    // On a patient with an ER doctor: still security ALONE (the clinical team is not paged to violence).
    const a = await inBay(new Date(Date.now() - 10 * MIN));
    const onPatient = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_grey", episodeId: a.episodeId });
    expect((await db.select().from(alerts).where(eq(alerts.refId, onPatient.codeId))).map((p) => [p.userId, p.body])).toEqual([[guard.id, "Security to ER-R4"]]);
    const [row] = await db.select().from(erCodes).where(eq(erCodes.id, r.codeId));
    expect(row!.incidentDraft).toMatch(/^Code Grey at Triage desk, called by .*Relative threatening staff/);
    await expect(callCode(db, w.erNurse, { idempotencyKey: key(), kind: "stemi", place: "OPD" })).rejects.toMatchObject({ code: "code_needs_patient" });
  });

  it("the record: the first tapper is the scribe, a paper sheet is back-filled and flagged, nothing is edited; one STEMI per patient, two codes at once", async () => {
    const gate = new Date(Date.now() - 30 * MIN);
    const a = await inBay(gate);
    const blue = await callCode(db, w.erNurse, { idempotencyKey: key(), kind: "code_blue", episodeId: a.episodeId }, { now: new Date(gate.getTime() + 10 * MIN) });
    const stemi = await callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "stemi", episodeId: a.episodeId }, { now: new Date(gate.getTime() + 11 * MIN) });
    expect(stemi.codeId).not.toBe(blue.codeId);
    await expect(callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "stemi", episodeId: a.episodeId })).rejects.toMatchObject({ code: "code_open" });
    const ev = (body: Record<string, unknown>, at: Date) => recordCodeEvent(db, w.erNurse, { idempotencyKey: key(), codeId: blue.codeId, ...body }, { now: at });
    const t = (m: number) => new Date(gate.getTime() + m * MIN);
    const first = await ev({ kind: "cpr_start" }, t(11));
    expect(first.scribeId).toBe(w.erNurse.id);
    await ev({ kind: "rhythm", rhythm: "vf" }, t(12));
    await ev({ kind: "shock", joules: 200 }, t(13));
    await ev({ kind: "drug", drug: "Adrenaline", dose: "1 mg IV" }, t(14));
    await ev({ kind: "rosc" }, t(20));
    await ev({ kind: "note", note: "Paper sheet: amiodarone given", at: t(15).toISOString(), fromPaper: true }, t(22));
    await expect(ev({ kind: "milestone", milestone: "ecg" }, t(22))).rejects.toMatchObject({ code: "milestone_unknown" });
    await expect(db.execute(sql`update er_code_events set kind = 'note' where code_id = ${blue.codeId}`)).rejects.toThrow(/er_code_events_append_only/);
    await expect(endCode(db, w.erNurse, { idempotencyKey: key(), codeId: blue.codeId, outcome: "rosc" })).rejects.toMatchObject({ code: "not_a_doctor" });
    const ended = await endCode(db, w.erDoctor, { idempotencyKey: key(), codeId: blue.codeId, outcome: "rosc" }, { now: t(25) });
    expect(ended.durationSec).toBe(15 * 60);
    await expect(ev({ kind: "note", note: "late" }, t(26))).rejects.toMatchObject({ code: "code_ended" });
    const view = await readErCode(db, w.erDoctor, blue.codeId);
    expect(view.events.map((e) => [e.kind, e.words])).toEqual([
      ["cpr_start", ""], ["rhythm", "vf"], ["shock", "200 J"], ["drug", "Adrenaline 1 mg IV"], ["note", "Paper sheet: amiodarone given"], ["rosc", ""],
    ]);
    expect(view).toMatchObject({ backfilled: true, outcome: "rosc", where: "ER-R4" });
    // The debrief: the team leader, once, after the end.
    await expect(recordCodeDebrief(db, w.doctor, { idempotencyKey: key(), codeId: blue.codeId, wentWell: "x", improve: "y" })).rejects.toMatchObject({ code: "not_code_leader" });
    await recordCodeDebrief(db, w.erDoctor, { idempotencyKey: key(), codeId: blue.codeId, wentWell: "Shock within 2 min", improve: "Earlier airway", actions: ["Restock airway trolley"] });
    await expect(recordCodeDebrief(db, w.erDoctor, { idempotencyKey: key(), codeId: blue.codeId, wentWell: "x", improve: "y" })).rejects.toMatchObject({ code: "debrief_recorded" });
    await expect(recordCodeDebrief(db, w.erDoctor, { idempotencyKey: key(), codeId: stemi.codeId, wentWell: "x", improve: "y" })).rejects.toMatchObject({ code: "code_not_ended" });
    expect((await db.select().from(erCodes).where(and(eq(erCodes.id, blue.codeId))))[0]!.debrief).toMatchObject({ actions: ["Restock airway trolley"] });
  });

  it("snakebite's ASV runs from the decision; Code Blue anywhere (no patient), the place corrected by an event, never a new code", async () => {
    const gate = new Date(Date.now() - 60 * MIN);
    const a = await inBay(gate);
    const decided = new Date(gate.getTime() + 20 * MIN);
    const sb = await callCode(db, w.erDoctor, { idempotencyKey: key(), kind: "snakebite", episodeId: a.episodeId }, { now: decided });
    expect(sb.clocks).toEqual([{ milestone: "asv", dueAt: new Date(decided.getTime() + 30 * MIN).toISOString() }]);
    const anywhere = await callCode(db, w.erDesk, { idempotencyKey: key(), kind: "code_blue", place: "OPD 2 waiting" });
    await recordCodeEvent(db, w.erNurse, { idempotencyKey: key(), codeId: anywhere.codeId, kind: "location", place: "OPD 3 waiting" });
    expect((await readErCode(db, w.erDoctor, anywhere.codeId)).where).toBe("OPD 3 waiting");
    expect(await db.select().from(erCodes).where(eq(erCodes.kind, "code_blue"))).toHaveLength(1);
  });
});
