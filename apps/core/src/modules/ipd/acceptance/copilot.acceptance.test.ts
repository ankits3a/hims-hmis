import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  copilotAsks, copilotHalts, ipdAdmissions, ipdCopilotDrafts, ipdDischargeSummaries, ipdEmarActs, ipdEmarLabels, ipdIntakeOutput, ipdNursingNotes, ipdOrders,
  ipdShiftHandovers, ipdVitals, patients, users,
} from "../../../kernel/db/schema";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { InferenceUnavailable } from "../../../kernel/inference/types";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkEmarWorld } from "../../../../test/helpers/ipd";
import { patientsManifest } from "../../patients";
import {
  DISCHARGE_PROMPT_VERSION, DRAFT_BUDGET_MS, IpdError, IpdRefusal, SBAR_PROMPT_VERSION, SINCE_BUDGET_MS, SINCE_PROMPT_VERSION, administerDose,
  buildDischargeDraft, buildSbarDraft, giveShiftHandover, holdDose, ipdManifest, issueMed, listShiftHandovers, placeIpOrder, polishSinceYesterday,
  quantitiesIn, readHandoverDraft, readSinceYesterday, readSummary, saveSummaryDraft, signRound, signSummary, stopIpOrder, verifyOrder,
} from "../index";
import type { CompleteInput } from "../../../kernel/inference/types";
import type { Db } from "../../../kernel/db/client";
import type { EmarWorld } from "../../../../test/helpers/ipd";
import type { IpdModel } from "../index";
import type { Actor, IpdSinceYesterday } from "@hmis/contracts";

/**
 * E5.3 (#740) "SINCE YESTERDAY" AND E5.4 (#741) THE SBAR AND DISCHARGE DRAFTERS — "DONE MEANS" (plan E5.3 / E5.4; spec
 * SPEC-ipd-core §0A principle 6, §4.8, §4.9 E, §4.10 edge 13, §4.11; decisions 0058, 0064, 0069). Every act and read is
 * given an EXPLICIT instant in IST; nothing reads or pins the real clock. THE MODEL IS A STUB: an object in this file
 * that answers a string. No test contacts a provider.
 *
 *   E5.3 (i)    every line has a source and names rows that exist; its numbers are the rows' numbers
 *        (ii)   a model reply with a wrong or an invented number is dropped for the record's own line
 *        (iii)  a kept rewording is dropped when its record changes after drafting
 *        (iv)   model down, slow or absent → the plain timeline, inside the 1 s budget; the read never calls a model
 *        (v)    a sealed patient gets no model call at all; a halted copilot gets none either
 *   E5.4 (vi)   the SBAR draft: every line has a source; stamped Draft · model id · prompt version · built at; building
 *               one hands nothing over; the signed copy names the nurse and keeps the draft's provenance
 *        (vii)  the SBAR model sentence: masked on the way out; a wrong number → the note quoted instead; model down → template
 *        (viii) the discharge draft: medicines only from active orders; structured parts from the record; nothing saved or signed
 *        (ix)   a model reply that invents a medicine is flagged and its text dropped
 *        (x)    the signed summary names the doctor and keeps the draft's model id and prompt version
 *        (xi)   a typed medicine with no active order is flagged; a drafted row whose order was stopped refuses the signature
 *        (xii)  model down → a template draft inside the budget; a sealed patient → template only, no call; no money anywhere
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const MONEY_WORDS = /paise|rupee|amount|fee|charge|dues|payable|price|deposit|bill/i;

function moneyKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) moneyKeys(v, out);
  else if (value !== null && typeof value === "object") {
    // `conditionAtDischarge` is the summary's own clinical field ("charge" is inside "discharge").
    for (const [k, v] of Object.entries(value)) { if (MONEY_WORDS.test(k.replace(/discharge/gi, ""))) out.push(k); moneyKeys(v, out); }
  }
  return out;
}

type Reply = string | ((input: CompleteInput) => string | Promise<string>);
/** THE STUB MODEL: records what it was sent and answers what the test wrote. */
function stubModel(reply: Reply): { model: IpdModel; calls: CompleteInput[] } {
  const calls: CompleteInput[] = [];
  return {
    calls,
    model: {
      modelId: "stub-model-1", dailyCapInr: 5000, prices: {},
      clientFor: () => ({ complete: async (input) => { calls.push(input); return { text: typeof reply === "function" ? await reply(input) : reply }; } }),
    },
  };
}
const down = (): Reply => () => { throw new InferenceUnavailable("provider_failed"); };
const slow = (ms: number): Reply => () => new Promise<string>((resolve) => { setTimeout(() => resolve('{"lines":[]}'), ms).unref(); });

describe("E5.3 since yesterday, E5.4 SBAR and discharge drafter — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkEmarWorld(db);
    bands.clear();
    const registry = new ModuleRegistry();
    registry.install(authManifest); registry.install(patientsManifest); registry.install(ipdManifest);
    await syncPermissions(db, registry);
    for (const p of ["ipd.handover.shift", "ipd.nursing.view"]) await grantPermissionToRole(db, registry, "ward_nurse", p);
  });

  const D1 = "2026-03-11";
  const at = (hhmm: string, day = D1): Date => ist(`${day}T${hhmm}:00`);
  const nameOf = async (userId: string): Promise<string> => (await db.select({ n: users.fullName }).from(users).where(eq(users.id, userId)))[0]!.n;

  const vitals = async (p: { admissionId: string; patientId: string }, when: Date, v: { t: number; pulse?: number; score?: [number, "low" | "low_medium" | "medium" | "high"] }) => {
    const id = newId();
    await db.insert(ipdVitals).values({
      id, admissionId: p.admissionId, patientId: p.patientId, observedAt: when, recordedAt: when, recordedBy: w.nurse.id, source: "person", clientKey: key(),
      lateEntry: false, temperatureC: v.t, pulse: v.pulse ?? 84, respRate: 16, systolic: 122, diastolic: 78, spo2: 98, onOxygen: false, consciousness: "alert",
      ...(v.score ? { scoreKind: "news2", scoreValue: v.score[0], scoreBand: v.score[1], scoreComplete: true } : {}),
    });
    return id;
  };
  const note = async (p: { admissionId: string; patientId: string }, when: Date, text: string, category = "general") => {
    const id = newId();
    await db.insert(ipdNursingNotes).values({ id, admissionId: p.admissionId, patientId: p.patientId, observedAt: when, recordedAt: when, recordedBy: w.nurse.id, source: "person", lateEntry: false, category, text });
    return id;
  };
  const io = (p: { admissionId: string; patientId: string }, when: Date, direction: "in" | "out", volumeMl: number) =>
    db.insert(ipdIntakeOutput).values({ id: newId(), admissionId: p.admissionId, patientId: p.patientId, observedAt: when, recordedAt: when, recordedBy: w.nurse.id, source: "person", direction, kind: direction === "in" ? "oral" : "urine", volumeMl });
  const round = (by: Actor, admissionId: string, when: Date, soap: Record<string, string> = { assessment: "Improving", plan: "Continue" }) =>
    signRound(db, by, { idempotencyKey: key(), admissionId, seenAt: when.toISOString(), mode: "bedside", soap }, { now: when });

  const bands = new Map<string, string>();
  const bandOf = async (admissionId: string): Promise<string> => {
    if (!bands.has(admissionId)) bands.set(admissionId, await w.band(admissionId));
    return bands.get(admissionId)!;
  };
  /** A verified, issued TDS drug order from 07:00 on day 1 (doses due 08:00, 14:00, 20:00). */
  async function drug(admissionId: string, name: string, moiety?: string) {
    const med = await w.stocked(name, moiety === undefined ? {} : { moiety });
    const T0 = at("07:00");
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: T0 });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: { allergy: true, interaction: true, dose: true, duplicate: true }, note: "checked" }, { now: at("07:30") });
    const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 6, ownMedicine: false }, { now: at("07:40") });
    const labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    const medicineName = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, placed.orderId)))[0]!.medicineName!;
    return { orderId: placed.orderId, labelCode, band: await bandOf(admissionId), medicineName };
  }
  const give = (o: { orderId: string; labelCode: string; band: string }, when: Date, due: Date) => administerDose(db, w.nurse, {
    idempotencyKey: key(), orderId: o.orderId, doseDueAt: due.toISOString(), givenAt: when.toISOString(), patientCheck: { kind: "scan", wristbandCode: o.band }, labelCode: o.labelCode,
  }, { now: when });

  /** One admitted patient with a day of records after the consultant's 07:00 round: a fever, a held dose, notes, I/O. */
  async function busyPatient() {
    const p = await w.admitMed(at("10:00", "2026-03-10"));
    await db.update(ipdAdmissions).set({ provisionalDiagnosis: "Community-acquired pneumonia" }).where(eq(ipdAdmissions.id, p.admissionId));
    await round(w.consultant, p.admissionId, at("06:50"));
    const o = await drug(p.admissionId, "Zemox 500");
    const v1 = await vitals(p, at("08:10"), { t: 37.1, score: [1, "low"] });
    const v2 = await vitals(p, at("12:30"), { t: 38.9, pulse: 104, score: [5, "medium"] });
    const v3 = await vitals(p, at("16:05"), { t: 37.2, score: [2, "low"] });
    await give(o, at("08:05"), at("08:00"));
    await holdDose(db, w.nurse, { idempotencyKey: key(), orderId: o.orderId, doseDueAt: at("14:00").toISOString(), reason: "parameter_out_of_range" }, { now: at("14:10") });
    await note(p, at("09:00"), "Slept well. Ate breakfast.");
    await note(p, at("12:40"), "Shivering at 12:30, temperature 38.9; doctor told.", "escalation");
    await io(p, at("09:30"), "in", 600);
    await io(p, at("11:00"), "out", 350);
    return { ...p, o, v: [v1, v2, v3], now: at("18:00") };
  }
  const lineOf = (s: IpdSinceYesterday, k: string) => s.lines.find((l) => l.key === k)!;

  // ═══════════════════════════════════════════ E5.3 ═══════════════════════════════════════════

  it("(i) every line has a source and names rows that exist; its numbers are the rows' numbers; abnormal lines come first", async () => {
    const p = await busyPatient();
    const s = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now });
    expect(s).toMatchObject({ sinceBasis: "last_round", since: at("06:50").toISOString(), mode: "timeline", stamp: null, polishable: false });
    expect(s.lines.length).toBeGreaterThanOrEqual(4);
    expect(s.lines.length).toBeLessThanOrEqual(6);
    // Abnormal first: every abnormal line precedes every line that is not.
    expect(s.lines.map((l) => l.abnormal).join(",")).toMatch(/^(true,)*true(,false)*$/);
    for (const l of s.lines) {
      expect(l.by).toBe("template");
      expect(l.records.length).toBeGreaterThan(0);
      expect(["vitals", "ews", "emar", "note", "io", "order"]).toContain(l.source);
    }
    // The numbers are the rows': read the rows again, here, and compare.
    const rows = await db.select().from(ipdVitals).where(eq(ipdVitals.admissionId, p.admissionId));
    const temps = rows.map((r) => r.temperatureC!);
    const temp = lineOf(s, "vital:temperatureC");
    expect(temp.text).toBe(`Temperature max ${String(Math.max(...temps))} °C, min ${String(Math.min(...temps))} °C, latest 37.2 °C over ${String(rows.length)} readings`);
    expect(temp.records.map((r) => r.id).sort()).toEqual([...p.v].sort());
    expect(lineOf(s, "ews").text).toBe("NEWS2 reached medium (5 at 12:30), now low — latest 2 at 16:05");
    const acts = await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.admissionId, p.admissionId));
    const count = (kind: string) => acts.filter((a) => a.kind === kind).length;
    expect(lineOf(s, "emar:exceptions").text).toBe(`Doses: ${String(count("held"))} held; ${String(count("given"))} given: ${p.o.medicineName}`);
    expect(lineOf(s, "emar:exceptions").records.map((r) => r.id)).toEqual(acts.filter((a) => a.kind === "held").map((a) => a.id));
    expect(lineOf(s, "notes").text).toBe("2 nursing notes, 1 flagged");
    // Every number on every line is a value or a count of the rows, worked out here from the tables.
    const notes = await db.select().from(ipdNursingNotes).where(eq(ipdNursingNotes.admissionId, p.admissionId));
    const ios = await db.select().from(ipdIntakeOutput).where(eq(ipdIntakeOutput.admissionId, p.admissionId));
    const sum = (dir: string) => ios.filter((e) => e.direction === dir).reduce((n, e) => n + e.volumeMl, 0);
    const fromRows: Record<string, number[]> = {
      "vital:temperatureC": [...temps, rows.length],
      ews: rows.flatMap((r) => (r.scoreValue === null ? [] : [r.scoreValue])),
      "emar:exceptions": [count("held"), count("given"), ...quantitiesIn(p.o.medicineName).numbers],
      notes: [notes.length, notes.filter((n) => n.category !== "general").length],
      "orders:new": [1, ...quantitiesIn(p.o.medicineName).numbers],
      io: [sum("in"), sum("out"), sum("in") - sum("out")],
    };
    expect(s.lines.map((l) => l.key).sort()).toEqual(Object.keys(fromRows).sort());
    for (const l of s.lines) {
      for (const n of quantitiesIn(l.text).numbers) expect({ line: l.text, n, ok: fromRows[l.key]!.some((x) => Math.abs(x - n) < 1e-9) }).toEqual({ line: l.text, n, ok: true });
    }
    // The doctor with no round of their own reads the last 24 hours; a doctor off the team is refused. No money anywhere.
    expect((await readSinceYesterday(db, w.head, p.admissionId, { now: p.now })).sinceBasis).toBe("24h");
    await expect(readSinceYesterday(db, w.outsider, p.admissionId, { now: p.now })).rejects.toMatchObject({ code: "not_treating_team" });
    expect(moneyKeys(s)).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/₹|rupee|paise/i);
  });

  it("(ii) a model reply with a wrong or an invented number is dropped for the record's own line; a faithful one is stamped", async () => {
    const p = await busyPatient();
    const before = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: stubModel("{}").model });
    expect(before.polishable).toBe(true);
    const { model, calls } = stubModel(JSON.stringify({ lines: [
      // WRONG: the record says 38.9.
      { key: "vital:temperatureC", text: "Fever: max 39.8 °C, min 37.1 °C, latest 37.2 °C over 3 readings" },
      // INVENTED: nothing recorded a potassium.
      { key: "notes", text: "2 nursing notes, 1 flagged; potassium 6.1" },
      // FAITHFUL.
      { key: "ews", text: "NEWS2 reached medium (5 at 12:30), now low; latest 2 at 16:05" },
    ] }));
    const s = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model });
    expect(calls).toHaveLength(1);
    expect(lineOf(s, "vital:temperatureC")).toMatchObject({ by: "template", text: lineOf(before, "vital:temperatureC").text });
    expect(lineOf(s, "notes")).toMatchObject({ by: "template", text: "2 nursing notes, 1 flagged" });
    expect(lineOf(s, "ews")).toMatchObject({ by: "model", text: "NEWS2 reached medium (5 at 12:30), now low; latest 2 at 16:05" });
    expect(JSON.stringify(s)).not.toMatch(/39\.8|6\.1/);
    expect(s).toMatchObject({ mode: "model", stamp: { label: "Draft", source: "model", modelId: "stub-model-1", promptVersion: SINCE_PROMPT_VERSION, builtAt: p.now.toISOString() } });
    // What went to the model: the lines, and nothing that names the patient.
    const person = (await db.select().from(patients).where(eq(patients.id, p.patientId)))[0]!;
    expect(calls[0]!.user).not.toContain(person.uhid);
    expect(calls[0]!.user).toContain("Temperature max 38.9");
    // Kept: the page shows the same on reload without asking again, and the same records never cost a second call.
    const again = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model });
    expect(again).toMatchObject({ mode: "model", polishable: false });
    await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model });
    expect(calls).toHaveLength(1);
    // The call is on the copilot's ledger (the ₹ cap counts it) with no question text.
    const asks = await db.select().from(copilotAsks).where(eq(copilotAsks.intent, "ipd.since_yesterday"));
    expect(asks.map((a) => [a.route, a.outcome, a.maskedQuestion, a.modelCalls])).toEqual([["model", "answered", null, 1]]);
  });

  it("(iii) a kept rewording is dropped when its record changes after drafting", async () => {
    const p = await busyPatient();
    const { model } = stubModel(JSON.stringify({ lines: [{ key: "vital:temperatureC", text: "Fever: max 38.9 °C, min 37.1 °C, latest 37.2 °C over 3 readings" }] }));
    const first = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model });
    expect(lineOf(first, "vital:temperatureC").by).toBe("model");
    // A new set arrives: the kept sentence now says a number the record no longer says.
    await vitals(p, at("17:30"), { t: 39.4, score: [5, "medium"] });
    const after = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model });
    expect(lineOf(after, "vital:temperatureC")).toMatchObject({ by: "template", text: "Temperature max 39.4 °C, min 37.1 °C, latest 39.4 °C over 4 readings" });
    expect(after).toMatchObject({ mode: "timeline", stamp: null, polishable: true });
  });

  it("(iv) model down, slow or absent → the plain timeline inside the 1 s budget; the read never calls a model", async () => {
    const p = await busyPatient();
    const broken = stubModel(down());
    const read = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: broken.model });
    expect(broken.calls).toHaveLength(0);
    const a = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: broken.model });
    expect(a).toMatchObject({ mode: "timeline", stamp: null });
    expect(a.lines).toEqual(read.lines);

    const lazy = stubModel(slow(SINCE_BUDGET_MS * 4));
    const t1 = Date.now();
    const b = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: lazy.model });
    const waited = Date.now() - t1;
    expect(lazy.calls).toHaveLength(1);
    expect(b).toMatchObject({ mode: "timeline", stamp: null });
    expect(b.lines).toEqual(read.lines);
    // The budget is the model's whole share: the answer is back when it runs out, not when the model answers (4 × later).
    expect(waited).toBeGreaterThanOrEqual(SINCE_BUDGET_MS - 50);
    expect(waited).toBeLessThan(SINCE_BUDGET_MS * 3);

    const none = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: null });
    expect(none).toMatchObject({ mode: "timeline", polishable: false });
    expect(none.lines).toEqual(read.lines);
    // A failed or late call is still counted against the cap; nothing was kept as a draft.
    const asks = (await db.select().from(copilotAsks).where(eq(copilotAsks.intent, "ipd.since_yesterday"))).sort((x, y) => x.ms - y.ms);
    expect(asks.map((r) => r.outcome)).toEqual(["failed", "failed"]);
    // What the model was waited for, as the ledger measured it: nothing for a dead one, the budget and no more for a slow one.
    expect(asks[0]!.ms).toBeLessThan(SINCE_BUDGET_MS / 2);
    expect(asks[1]!.ms).toBeGreaterThanOrEqual(SINCE_BUDGET_MS - 50);
    expect(asks[1]!.ms).toBeLessThan(SINCE_BUDGET_MS * 2);
    expect(await db.select().from(ipdCopilotDrafts)).toEqual([]);
  });

  it("(v) a sealed patient gets no model call at all; a halted copilot gets none either", async () => {
    const p = await busyPatient();
    const faithful = JSON.stringify({ lines: [{ key: "ews", text: "NEWS2 reached medium (5 at 12:30), now low; latest 2 at 16:05" }] });
    const halted = stubModel(faithful);
    await db.insert(copilotHalts).values({ scope: "global", haltedBy: w.owner.id, reason: "test" });
    expect(await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: halted.model })).toMatchObject({ mode: "timeline" });
    expect(halted.calls).toHaveLength(0);
    await db.delete(copilotHalts);

    await db.update(patients).set({ sensitiveContext: true, alias: "Patient K" }).where(eq(patients.id, p.patientId));
    const sealed = stubModel(faithful);
    const read = await readSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: sealed.model });
    expect(read.polishable).toBe(false);
    const s = await polishSinceYesterday(db, w.consultant, p.admissionId, { now: p.now, model: sealed.model });
    expect(sealed.calls).toHaveLength(0);
    expect(s).toMatchObject({ mode: "timeline", stamp: null });
    expect(await buildSbarDraft(db, w.nurse, p.admissionId, { now: p.now, model: sealed.model })).toMatchObject({ stamp: { source: "template", modelId: null } });
    expect(await buildDischargeDraft(db, w.consultant, p.admissionId, { now: p.now, model: sealed.model })).toMatchObject({ stamp: { source: "template", modelId: null } });
    expect(sealed.calls).toHaveLength(0);
    expect(await db.select().from(copilotAsks)).toEqual([]);
  });

  // ═══════════════════════════════════════════ E5.4 — SBAR ═══════════════════════════════════════════

  it("(vi) the SBAR draft: sourced lines, the stamp, nothing handed over; the signed copy names the nurse and keeps the provenance", async () => {
    const p = await busyPatient();
    await note(p, at("15:20"), "Slept in the afternoon. Shivering at 12:30 with temperature 38.9 earlier; doctor told.");
    const { model, calls } = stubModel('{"assessment":"Shivering at 12:30 with temperature 38.9 earlier; doctor told. Slept in the afternoon."}');
    const now = at("19:30");
    const draft = await buildSbarDraft(db, w.nurse, p.admissionId, { now, model });
    expect(calls).toHaveLength(1);
    expect(draft.stamp).toEqual({ label: "Draft", source: "model", modelId: "stub-model-1", promptVersion: SBAR_PROMPT_VERSION, builtAt: now.toISOString() });
    const all = [...draft.situation, ...draft.background, ...draft.assessment, ...draft.recommendation];
    expect(draft.situation.length * draft.background.length * draft.assessment.length).toBeGreaterThan(0);
    for (const l of all) expect(typeof l.source).toBe("string");
    // Structured parts are the record's (the evening shift, 14:00–20:00): the held dose and the 16:05 score.
    expect(draft.situation.map((l) => l.text)).toEqual(expect.arrayContaining(["NEWS2 fell from medium to low — latest 2 at 16:05", `Doses: 1 held; 0 given: ${p.o.medicineName}`]));
    expect(all.filter((l) => l.by === "model").map((l) => l.text)).toEqual(["Shivering at 12:30 with temperature 38.9 earlier; doctor told. Slept in the afternoon."]);
    expect(moneyKeys(draft)).toEqual([]);
    // Building a draft is not a handover: nothing is given, nothing is accepted.
    expect(await db.select().from(ipdShiftHandovers)).toEqual([]);

    // The nurse edits and signs. The signed copy names her and keeps the draft's model id and prompt version.
    const sbar = { situation: "NEWS2 2 at 16:05; one dose held.", background: "Pneumonia, day 2.", assessment: "Fever at noon, settled.", recommendation: "Vitals at 20:00." };
    const given = await giveShiftHandover(db, w.nurse, { idempotencyKey: key(), admissionId: p.admissionId, sbar, draftId: draft.draftId! }, { now: at("19:40") });
    const card = (await listShiftHandovers(db, w.nurse2, { now: at("19:45") })).handovers.find((h) => h.handoverId === given.handoverId)!;
    expect(card.givenBy).toEqual({ id: w.nurse.id, name: await nameOf(w.nurse.id) });
    expect(card.sbar).toEqual(sbar);
    expect(card.draft).toEqual({ draftId: draft.draftId, source: "model", modelId: "stub-model-1", promptVersion: SBAR_PROMPT_VERSION, builtAt: now.toISOString() });
    expect((await db.select().from(ipdShiftHandovers))[0]).toMatchObject({ status: "given", acceptedBy: null, givenBy: w.nurse.id });
    // A draft of another patient cannot be signed onto this one; a typed handover carries no draft.
    const other = await w.admitMed(at("11:00", "2026-03-10"));
    await expect(giveShiftHandover(db, w.nurse, { idempotencyKey: key(), admissionId: other.admissionId, sbar, draftId: draft.draftId! }, { now: at("19:50") }))
      .rejects.toMatchObject({ code: "shift_handover_draft_not_found" });
    const typed = await giveShiftHandover(db, w.nurse, { idempotencyKey: key(), admissionId: other.admissionId, sbar }, { now: at("19:51") });
    expect((await listShiftHandovers(db, w.nurse2, { now: at("19:55") })).handovers.find((h) => h.handoverId === typed.handoverId)!.draft).toBeNull();
  });

  it("(vii) the SBAR model sentence: masked on the way out; a wrong number or a proposal → the note quoted; model down → template in budget", async () => {
    const p = await w.admitMed(at("10:00", "2026-03-10"));
    const person = (await db.select().from(patients).where(eq(patients.id, p.patientId)))[0]!;
    const fullName = person.name;
    await vitals(p, at("15:00"), { t: 37.0, score: [0, "low"] });
    await note(p, at("15:10"), `${fullName} (${person.uhid}) complained of pain 4 on movement; eased with rest.`, "pain");
    const now = at("19:30");

    const wrong = stubModel('{"assessment":"Pain 7 on movement, eased with rest."}');
    const a = await buildSbarDraft(db, w.nurse, p.admissionId, { now, model: wrong.model });
    // On the way out: no name, no UHID — placeholders.
    expect(wrong.calls).toHaveLength(1);
    expect(wrong.calls[0]!.user).not.toContain(person.uhid);
    for (const part of fullName.split(/\s+/).filter((x) => x.length >= 3)) expect(wrong.calls[0]!.user).not.toContain(part);
    expect(wrong.calls[0]!.user).toContain("<<P1>>");
    expect(wrong.calls[0]!.user).toContain("pain 4 on movement");
    // Dropped: the draft says what the note says.
    expect(a.stamp).toMatchObject({ source: "template", modelId: null });
    expect(JSON.stringify(a)).not.toContain("Pain 7");
    expect(a.assessment.filter((l) => l.by === "model")).toEqual([]);
    expect(a.assessment.map((l) => l.text).join(" | ")).toContain("pain 4 on movement");
    expect((await db.select().from(ipdCopilotDrafts).where(eq(ipdCopilotDrafts.id, a.draftId!)))[0]).toMatchObject({ source: "template", modelId: null, fallbackReason: "rejected" });

    const proposing = stubModel('{"assessment":"Pain 4 on movement; consider tramadol."}');
    expect((await buildSbarDraft(db, w.nurse, p.admissionId, { now, model: proposing.model })).stamp).toMatchObject({ source: "template" });

    const broken = stubModel(down());
    const t0 = Date.now();
    const c = await buildSbarDraft(db, w.nurse, p.admissionId, { now, model: broken.model });
    expect(Date.now() - t0).toBeLessThan(DRAFT_BUDGET_MS);
    expect(c.stamp).toMatchObject({ label: "Draft", source: "template", modelId: null, promptVersion: SBAR_PROMPT_VERSION });
    const downRow = (await db.select().from(ipdCopilotDrafts).where(eq(ipdCopilotDrafts.id, c.draftId!)))[0]!;
    expect(downRow.fallbackReason).toBe("model_down");
    expect(downRow.modelMs).toBeLessThan(DRAFT_BUDGET_MS / 2);
    // The plain read is the same structured draft, kept nowhere.
    const plain = await readHandoverDraft(db, w.nurse, p.admissionId, { now });
    expect(plain.draftId).toBeNull();
    expect(plain.situation).toEqual(c.situation);
  });

  // ═══════════════════════════════════════════ E5.4 — discharge ═══════════════════════════════════════════

  it("(viii) the discharge draft: medicines only from active orders, structured parts from the record, nothing saved or signed", async () => {
    const p = await busyPatient();
    const stopped = await drug(p.admissionId, "Oldacin 250");
    await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: stopped.orderId, reason: "Course complete" }, { now: at("17:00") });
    await round(w.consultant, p.admissionId, at("09:00", "2026-03-12"), { assessment: "Afebrile since last evening", plan: "Home tomorrow" });
    const now = at("10:00", "2026-03-12");
    const d = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model: null });
    expect(d.stamp).toEqual({ label: "Draft", source: "template", modelId: null, promptVersion: DISCHARGE_PROMPT_VERSION, builtAt: now.toISOString() });
    expect(d.content.medicines).toHaveLength(1);
    expect(d.content.medicines[0]).toMatchObject({ name: p.o.medicineName, dose: "500 mg", frequency: "TDS", source: "order", orderId: p.o.orderId });
    expect(d.content.diagnosis.text).toBe("Community-acquired pneumonia");
    expect(d.content.course).toContain("Admitted 10 Mar 2026; day 3 of stay.");
    expect(d.content.course).toContain("12 Mar 2026 — Afebrile since last evening; plan: Home tomorrow.");
    expect(d.sources.map((s) => [s.field, s.source])).toEqual([["diagnosis", "admission"], ["course", "round"], ["medicines", "order"], ["pendingResults", "lab"]]);
    expect(d.sources.find((s) => s.field === "medicines")!.records.map((r) => r.id)).toEqual([p.o.orderId]);
    expect(d.flags).toEqual([]);
    expect(moneyKeys(d)).toEqual([]);
    expect(await db.select().from(ipdDischargeSummaries)).toEqual([]);
    // A ward nurse cannot ask for one.
    await expect(buildDischargeDraft(db, w.nurse, p.admissionId, { now, model: null })).rejects.toBeInstanceOf(IpdError);
  });

  it("(ix) a model reply that invents a medicine is flagged and its text dropped", async () => {
    const p = await busyPatient();
    await w.stocked("Warf 5", { moiety: "Warfarin" });
    await round(w.consultant, p.admissionId, at("09:00", "2026-03-12"), { assessment: "Afebrile since last evening", plan: "Home tomorrow" });
    const now = at("10:00", "2026-03-12");
    const template = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model: null });
    const { model, calls } = stubModel('{"course":"Admitted with fever which settled. Started on warfarin and discharged afebrile."}');
    const d = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model });
    expect(calls).toHaveLength(1);
    expect(d.flags).toEqual([{ name: "warfarin", where: "course", index: null, reason: "model_invented" }]);
    expect(d.content.course).toBe(template.content.course);
    expect(d.content.course).not.toMatch(/warfarin/i);
    expect(d.content.medicines.map((m) => m.name)).toEqual([p.o.medicineName]);
    expect(d.stamp).toMatchObject({ source: "template", modelId: null });
  });

  it("(x) the signed summary names the doctor and keeps the draft's model id and prompt version", async () => {
    const p = await busyPatient();
    await round(w.consultant, p.admissionId, at("09:00", "2026-03-12"), { assessment: "Afebrile since last evening", plan: "Home tomorrow" });
    const now = at("10:00", "2026-03-12");
    const { model } = stubModel('{"course":"Fever settled; afebrile since last evening. Plan was home the next day."}');
    const d = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model });
    expect(d).toMatchObject({ stamp: { label: "Draft", source: "model", modelId: "stub-model-1", promptVersion: DISCHARGE_PROMPT_VERSION }, flags: [] });
    expect(d.content.course).toBe("Fever settled; afebrile since last evening. Plan was home the next day.");

    // The doctor edits and saves through the existing act, naming the draft; the server stamps the provenance.
    const saved = await saveSummaryDraft(db, w.consultant, {
      idempotencyKey: key(), admissionId: p.admissionId, expectedVersion: 0, draftId: d.draftId,
      content: { ...d.content, conditionAtDischarge: "Stable, afebrile" },
    }, { now: at("10:05", "2026-03-12") });
    expect(saved).toMatchObject({ status: "draft", label: "Draft", signedBy: null, medicineFlags: [] });
    expect(saved.provenance).toMatchObject({ source: "copilot_draft", draftModelId: "stub-model-1", draftPromptVersion: DISCHARGE_PROMPT_VERSION });
    // Nothing signs itself: the draft is still a draft until the consultant signs.
    expect((await db.select().from(ipdDischargeSummaries))[0]).toMatchObject({ status: "draft", signedBy: null });
    await signSummary(db, w.consultant, { idempotencyKey: key(), admissionId: p.admissionId, draftId: saved.summaryId, draftVersion: saved.version }, { now: at("10:10", "2026-03-12") });
    const signed = await readSummary(db, w.consultant, p.admissionId);
    expect(signed).toMatchObject({ status: "signed", label: "Signed", signedBy: { id: w.consultant.id, name: await nameOf(w.consultant.id) } });
    expect(signed.provenance).toMatchObject({
      source: "copilot_draft", draftModelId: "stub-model-1", draftPromptVersion: DISCHARGE_PROMPT_VERSION,
      draft: { draftId: d.draftId, source: "model", modelId: "stub-model-1", promptVersion: DISCHARGE_PROMPT_VERSION, builtAt: now.toISOString() },
    });
    // A draft of another admission cannot lend its stamp.
    const other = await w.admitMed(at("11:00", "2026-03-10"));
    await expect(saveSummaryDraft(db, w.consultant, { idempotencyKey: key(), admissionId: other.admissionId, expectedVersion: 0, draftId: d.draftId, content: d.content }, { now }))
      .rejects.toMatchObject({ code: "summary_draft_not_found" });
  });

  it("(xi) a typed medicine with no active order is flagged; a drafted row whose order was stopped refuses the signature", async () => {
    const p = await busyPatient();
    const now = at("10:00", "2026-03-12");
    const d = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model: null });
    const saved = await saveSummaryDraft(db, w.consultant, {
      idempotencyKey: key(), admissionId: p.admissionId, expectedVersion: 0, draftId: d.draftId,
      content: { ...d.content, medicines: [...d.content.medicines, { name: "Vitamin C 500 mg", frequency: "OD", duration: "10 days" }] },
    }, { now });
    expect(saved.medicineFlags).toEqual([{ name: "Vitamin C 500 mg", where: "medicines", index: 1, reason: "no_active_order" }]);
    // The order behind the drafted row is stopped after the draft: the machine's row is stale, and the signature waits.
    await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: p.o.orderId, reason: "Switched" }, { now: at("10:20", "2026-03-12") });
    expect((await readSummary(db, w.consultant, p.admissionId)).medicineFlags.map((f) => [f.index, f.reason])).toEqual([[0, "order_stopped"], [1, "no_active_order"]]);
    const refused = await signSummary(db, w.consultant, { idempotencyKey: key(), admissionId: p.admissionId, draftId: saved.summaryId, draftVersion: saved.version }, { now: at("10:25", "2026-03-12") })
      .then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(IpdRefusal);
    expect(refused).toMatchObject({ code: "medicine_not_on_active_order", detail: { medicines: [p.o.medicineName] } });
    // The doctor fixes the medicines (types what the patient goes home on): flagged, and signable under their own name.
    const fixed = await saveSummaryDraft(db, w.consultant, {
      idempotencyKey: key(), admissionId: p.admissionId, expectedVersion: saved.version,
      content: { ...d.content, medicines: [{ name: "Vitamin C 500 mg", frequency: "OD", duration: "10 days" }] },
    }, { now: at("10:30", "2026-03-12") });
    expect(fixed.provenance.source).toBe("copilot_draft");
    const done = await signSummary(db, w.consultant, { idempotencyKey: key(), admissionId: p.admissionId, draftId: fixed.summaryId, draftVersion: fixed.version }, { now: at("10:35", "2026-03-12") });
    expect(done).toMatchObject({ status: "signed", signedBy: w.consultant.id });
  });

  it("(xii) model down → a template draft inside the budget; nothing in a draft carries money", async () => {
    const p = await busyPatient();
    const now = at("10:00", "2026-03-12");
    const broken = stubModel(down());
    const t0 = Date.now();
    const d = await buildDischargeDraft(db, w.consultant, p.admissionId, { now, model: broken.model });
    expect(Date.now() - t0).toBeLessThan(DRAFT_BUDGET_MS);
    expect(broken.calls).toHaveLength(1);
    expect(d.stamp).toEqual({ label: "Draft", source: "template", modelId: null, promptVersion: DISCHARGE_PROMPT_VERSION, builtAt: now.toISOString() });
    expect(d.content.medicines.map((m) => m.orderId)).toEqual([p.o.orderId]);
    const row = (await db.select().from(ipdCopilotDrafts).where(and(eq(ipdCopilotDrafts.id, d.draftId), eq(ipdCopilotDrafts.kind, "discharge"))))[0]!;
    expect(row).toMatchObject({ source: "template", modelId: null, fallbackReason: "model_down", builtBy: w.consultant.id });
    expect(row.modelMs).toBeLessThan(DRAFT_BUDGET_MS / 2);
    expect(JSON.stringify(d)).not.toMatch(/₹|rupee|paise/i);
    expect(moneyKeys(d)).toEqual([]);
  });
});
