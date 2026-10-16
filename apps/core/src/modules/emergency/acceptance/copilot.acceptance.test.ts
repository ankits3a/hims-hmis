import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { erEpisodes, erTriageEntries } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, buildErSummaryDraft, buildMlcNarrativeDraft, giveErDose, issueErMed, openMlc, readEsiProposal, readSinceArrival,
  recordErNote, recordErVitals, registerArrival, triage, verifyErSinceLine,
} from "../index";
import { renderSinceLine } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";
import type { ErModel } from "../index";

/**
 * ER lane 9 (#816, decision 0076) — "DONE MEANS" FOR er-copilot (spec SPEC-emergency-2026-10-15 §7):
 *  (a) an ESI proposal is never applied without a person's tap; an MLC patient triggers no model call;
 *  (b) a "since arrival" line whose number differs from its source fails the suite.
 * Every check calls the intent and read functions, never a screen.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 9 er-copilot — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
  });

  /** A model that answers a fixed sentence and counts its calls. */
  const stubModel = (reply: string): { model: ErModel; calls: { system: string; user: string }[] } => {
    const calls: { system: string; user: string }[] = [];
    return {
      calls,
      model: { modelId: "stub-er-1", dailyCapInr: 5000, prices: {}, clientFor: () => ({ complete: async (input) => { calls.push(input); return { text: reply }; } }) },
    };
  };

  const arrive = async (name: string, complaint: string, now: Date) => {
    const p = await w.patient("male", 52, name);
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", complaint }, { now });
  };

  it("(a-1) the ESI proposal writes nothing and sets no level; the nurse's tap does, and a different pick is logged as an override", async () => {
    const t0 = new Date(Date.now() - 20 * MIN);
    const a = await arrive("Ramesh Prasad", "chest pain since 1 hour, sweating", t0);
    const proposal = await readEsiProposal(db, w.erNurse, a.episodeId);
    expect(proposal.source).toBe("rules");
    expect(proposal.level).toBe(2);
    expect(proposal.decision.highRisk).toBe(true);
    expect(proposal.reasons.join(" ")).toContain("chest pain");
    // Read twice: still nothing recorded, the episode still waits for triage with no level.
    await readEsiProposal(db, w.erNurse, a.episodeId);
    expect(await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, a.episodeId))).toEqual([]);
    const before = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, a.episodeId)))[0]!;
    expect([before.state, before.esi, before.triagedAt]).toEqual(["arrived", null, null]);

    // The nurse picks ESI 1 (more urgent than the proposal's 2): no reason asked; the SERVER recomputes the proposal at the
    // tap and keeps it on the entry and the event as an override.
    const r = await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, level: 1,
      decision: { lifeSaving: true, highRisk: true, resources: "many", dangerVitals: true },
    }, { now: new Date() });
    expect(r.level).toBe(1);
    const entry = (await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, a.episodeId)))[0]!;
    expect([entry.level, entry.copilotLevel, entry.provenance]).toEqual([1, 2, "person"]);
  });

  it("(a-2) an MLC patient triggers no model call — the summary keeps its template, the MLC narrative never asks", async () => {
    const now = new Date();
    const plain = await arrive("Mohan Singh", "fever and vomiting", new Date(now.getTime() - 60 * MIN));
    await recordErNote(db, w.erDoctor, { idempotencyKey: key(), episodeId: plain.episodeId, kind: "assessment", text: "Fever 3 days, vomiting twice. Tolerated oral fluids." });
    const ok = stubModel("Fever for 3 days with vomiting; tolerated oral fluids in the ER.");
    const d1 = await buildErSummaryDraft(db, w.erDoctor, plain.episodeId, { model: ok.model, now });
    expect(ok.calls).toHaveLength(1);
    expect([d1.label, d1.source, d1.fallback]).toEqual(["Draft", "model", null]);

    const mlcCase = await arrive("Suresh Yadav", "assault, hit with a stick", new Date(now.getTime() - 50 * MIN));
    await recordErNote(db, w.erDoctor, { idempotencyKey: key(), episodeId: mlcCase.episodeId, kind: "assessment", text: "Contusion left forearm 4 x 3 cm." });
    await openMlc(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: mlcCase.episodeId, category: "assault",
      informant: { name: "Brother", relation: "brother", words: "He was hit with a stick near the market." },
      injuries: [{ site: "left forearm", kind: "contusion", sizeCm: "4 x 3" }],
    }, { now });
    const barred = stubModel("should never be asked");
    const d2 = await buildErSummaryDraft(db, w.erDoctor, mlcCase.episodeId, { model: barred.model, now });
    const d3 = await buildMlcNarrativeDraft(db, w.erDoctor, mlcCase.episodeId, { model: barred.model, now });
    expect(barred.calls).toEqual([]);
    expect([d2.label, d2.source, d2.fallback]).toEqual(["Draft", "template", "barred"]);
    expect([d3.label, d3.source]).toEqual(["Draft", "template"]);
    expect(d3.fields.text).toContain('"He was hit with a stick near the market."');
    expect(d3.fields.text).toContain("left forearm: contusion, 4 x 3 cm");

    // No model configured: the template, said so — never an error.
    const d4 = await buildErSummaryDraft(db, w.erDoctor, plain.episodeId, { model: null, now });
    expect([d4.source, d4.fallback]).toEqual(["template", "model_off"]);
  });

  it("(b) every 'since arrival' line's numbers are in its source records, and a line with a changed number fails the check", async () => {
    const t0 = new Date(Date.now() - 90 * MIN);
    const a = await arrive("Ramesh Prasad", "breathless since morning", t0);
    await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false },
      vitals: { pulse: 112, systolic: 138, diastolic: 84, respRate: 24, spo2: 93, temperatureC: 37.4 },
    }, { now: new Date(t0.getTime() + 4 * MIN) });
    await recordErVitals(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, vitals: { pulse: 128, systolic: 96, diastolic: 58, respRate: 30, spo2: 88, onOxygen: true },
    }, { now: new Date(t0.getTime() + 20 * MIN) });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: new Date(t0.getTime() + 26 * MIN) });
    const issued = await issueErMed(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, ownMedicine: "Salbutamol nebules", doseWords: "2.5 mg", route: "inhaled", units: 1, orderedBy: w.erDoctor.id,
    }, { now: new Date(t0.getTime() + 30 * MIN) });
    await giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given" }, { now: new Date(t0.getTime() + 32 * MIN) });
    await recordErNote(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: a.episodeId, kind: "progress", text: "Wheeze better after 2 nebs, SpO2 94% on 4 L oxygen.",
    }, { now: new Date(t0.getTime() + 60 * MIN) });

    const now = new Date();
    const since = await readSinceArrival(db, w.erDoctor, a.episodeId, { now });
    const ctx = { now, episodeNo: a.episodeNo, viewer: w.erDoctor };
    expect(since.lines.length).toBeGreaterThanOrEqual(4);
    expect(since.lines.length).toBeLessThanOrEqual(6);
    const sources = since.lines.map((l) => l.source);
    expect(sources).toEqual(expect.arrayContaining(["vitals", "triage", "doctor", "meds", "note"]));
    // The abnormal vital set leads (NEWS2 high), with its own numbers.
    expect(since.lines[0]!.source).toBe("vitals");
    expect(since.lines[0]!.text).toContain("P 128 · BP 96/58 · RR 30 · SpO2 88% on O2");
    for (const line of since.lines) {
      expect(line.records.length).toBeGreaterThan(0);
      expect({ key: line.key, verdict: await verifyErSinceLine(db, line, ctx) }).toEqual({ key: line.key, verdict: { ok: true } });
      expect(line.text).toBe(renderSinceLine(line.template, line.facts));
      // Change ONE number in the line's text: the check refuses it.
      const changed = line.text.replace(/\d+/, (n) => String(Number(n) + 7));
      if (changed !== line.text) expect((await verifyErSinceLine(db, { ...line, text: changed }, ctx)).ok).toBe(false);
    }

    // Pulse and systolic swapped — in the facts (and so the text), or in the text alone: both refused.
    const vit = since.lines.find((l) => l.source === "vitals")!;
    const swapped = vit.facts.map((f) => (f.field === "pulse" ? { ...f, value: 96 } : f.field === "systolic" ? { ...f, value: 128 } : f));
    const swappedLine = { ...vit, facts: swapped, text: renderSinceLine(vit.template, swapped) };
    expect(swappedLine.text).toContain("P 96 · BP 128/58");
    expect(await verifyErSinceLine(db, swappedLine, ctx)).toEqual({ ok: false, reason: "value_differs:pulse" });
    expect(await verifyErSinceLine(db, { ...vit, text: vit.text.replace("P 128 · BP 96/", "P 96 · BP 128/") }, ctx))
      .toEqual({ ok: false, reason: "text_not_from_facts" });

    // A wrong subtraction: "26 min after arrival" stated as 27 is recomputed from the stored instants and refused.
    const doc = since.lines.find((l) => l.source === "doctor")!;
    expect(doc.text).toContain("26 min after arrival");
    const off = doc.facts.map((f) => (f.kind === "minutes" ? { ...f, value: Number(f.value) + 1 } : f));
    expect(await verifyErSinceLine(db, { ...doc, facts: off, text: renderSinceLine(doc.template, off) }, ctx)).toEqual({ ok: false, reason: "minutes_differ:doorToDoctor" });
  });

  it("(b-2) a long complaint is cut at a word boundary and the arrival line still stands", async () => {
    const now = new Date();
    // The 80-character cut falls inside "180/110": a character cut would leave "18", a number the record does not hold.
    const complaint = "Severe headache since morning with vomiting twice and neck pain, BP at home 180/110 with blurred vision";
    const a = await arrive("Kamla Devi", complaint, new Date(now.getTime() - 10 * MIN));
    const since = await readSinceArrival(db, w.erDoctor, a.episodeId, { now });
    const arrival = since.lines.find((l) => l.source === "arrival")!;
    expect(arrival).toBeDefined();
    expect(arrival.text).toMatch(/neck pain, BP at home…$/);
    expect(await verifyErSinceLine(db, arrival, { now, episodeNo: a.episodeNo, viewer: w.erDoctor })).toEqual({ ok: true });
  });
});
