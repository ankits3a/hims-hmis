import { eq } from "drizzle-orm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import {
  events, formularyMedicineSalts, formularyMedicines, formularySalts, opdRxSets, opdVoiceUsage, orgDepartments,
  roles, rosterTeamMemberships, rosterTeams,
} from "../../kernel/db/schema";
import { forgetOpenAiKeyCache } from "../../kernel/inference/openai-speech";
import { normalizeDrugName } from "../formulary";
import { ROSTER_POSITIONS, seedRosterPositions } from "../roster/masters";
import { startConsultation } from "./consultation";
import { getEncounter, openVisit } from "./encounters";
import { callNext, listQueue } from "./queue";
import { recordVitals } from "./vitals";
import { listRxSets, retireRxSet, saveRxSet, signRxSet } from "./rx-sets";
import {
  VOICE_MAX_SECONDS, ageBandOf, hintFor, recordVoiceKept, saveVoiceSettings, suggestFromTranscript, transcribeConsultNote,
  voiceMeter, voiceStatus,
} from "./consult-voice";
import type { Db } from "../../kernel/db/client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 150, dbp: 90, pulse: 88, spo2: 97, tempC: 38.4 };
const PARA = { drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food" };
const CBC = { serviceId: "svc-cbc", code: "CBC", name: "Complete blood count" };

/**
 * PHONE CONSULT (decision 0048, owner 2026-10-07).
 *
 * Two promises are tested here against the real tables: a SET can never carry a controlled
 * medicine and a starter set is shown to nobody until its unit head signs it; and the SPOKEN NOTE
 * sends no name, keeps no audio and no words, and stops at the day's cap.
 */
describe("phone consult — sets and the spoken note", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let keyFile: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    keyFile = join(mkdtempSync(join(tmpdir(), "hmis-oai-")), "key.txt");
    writeFileSync(keyFile, "sk-test_0123456789abcdefghijklmnop\n");
  });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    forgetOpenAiKeyCache();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
  });

  async function medicine(brand: string, over: { scheduleFlag?: "H" | "H1" | "X"; ndps?: "narcotic" | "psychotropic" } = {}): Promise<string> {
    const id = newId();
    await db.insert(formularyMedicines).values({
      id, brandName: brand, nameNormalized: normalizeDrugName(brand), form: "tablet", strengthLabel: null,
      scheduleFlag: over.scheduleFlag ?? null, createdBy: "t", updatedBy: "t",
    });
    // Every catalogue medicine has a composition; the typeahead offers nothing that lacks one.
    const saltId = newId();
    await db.insert(formularySalts).values({ id: saltId, name: `salt-${saltId}`, nameNormalized: `salt-${saltId}`, ndpsClass: over.ndps ?? null, createdBy: "t", updatedBy: "t" } as never);
    await db.insert(formularyMedicineSalts).values({ medicineId: id, saltId, source: "curated" } as never);
    return id;
  }

  /** `dra` becomes the unit head of the OPD department's unit. */
  async function makeHead(userId: string): Promise<void> {
    const org = newId();
    await db.insert(orgDepartments).values({ id: org, code: "MED", name: "General Medicine", kind: "clinical", admitting: true, opdDepartmentId: deptId, createdBy: "t", updatedBy: "t" });
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]) await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
    await seedRosterPositions(db);
    await db.insert(rosterTeams).values({ id: "t-u1", kind: "clinical_unit", departmentId: org, code: "MED-U1", name: "Unit I", active: true, createdBy: "t", updatedBy: "t" } as never);
    await db.insert(rosterTeamMemberships).values({
      id: newId(), teamId: "t-u1", userId, positionKey: ROSTER_POSITIONS[0]!.key, grade: "assistant_professor", roleInTeam: "head",
      startsAt: new Date(Date.now() - 86_400_000), createdBy: "t", updatedBy: "t",
    } as never);
  }

  const body = (lines: unknown[] = [PARA]) => ({ lines, tests: [CBC], advice: "Plenty of fluids, rest.", reviewDays: 5 });

  describe("sets", () => {
    it("a doctor's own set is theirs alone, live at once, and comes back exactly as saved", async () => {
      const { setId } = await withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: " Viral fever ", body: body() }));
      const mine = await listRxSets(db, dra.actor);
      expect(mine.items.map((s) => [s.id, s.name, s.mine, s.scope])).toEqual([[setId, "Viral fever", true, "doctor"]]);
      expect(mine.items[0]!.body).toEqual(body());
      expect((await listRxSets(db, drb.actor)).items).toEqual([]);
      // Not-yours answers not-found: another doctor can neither edit nor retire it.
      await expect(withTx(db, (tx) => saveRxSet(tx, drb.actor, { id: setId, scope: "doctor", name: "x", body: body() }))).rejects.toMatchObject({ code: "unknown_rx_set" });
      await expect(withTx(db, (tx) => retireRxSet(tx, drb.actor, setId))).rejects.toMatchObject({ code: "unknown_rx_set" });
      await withTx(db, (tx) => retireRxSet(tx, dra.actor, setId));
      expect((await listRxSets(db, dra.actor)).items).toEqual([]);
    });

    it("a CONTROLLED medicine is never stored in a set — by catalogue id (H1, X, NDPS) and by catalogue name", async () => {
      const h1 = await medicine("Tramadol 50 mg Tablet", { scheduleFlag: "H1" });
      const x = await medicine("Ketamine 50 mg Injection", { scheduleFlag: "X" });
      const ndps = await medicine("Alprazolam 0.25 mg Tablet", { ndps: "psychotropic" });
      const abx = await medicine("Azithromycin 500 mg Tablet", { scheduleFlag: "H" });
      for (const medicineId of [h1, x, ndps]) {
        await expect(withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: "bad", body: body([{ ...PARA, drug: "anything", medicineId }]) })))
          .rejects.toMatchObject({ code: "rx_set_controlled" });
      }
      // No id on the line: the exact catalogue name still names it.
      await expect(withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: "bad", body: body([{ ...PARA, drug: "Tramadol 50 mg Tablet" }]) })))
        .rejects.toMatchObject({ code: "rx_set_controlled" });
      expect(await db.select().from(opdRxSets)).toHaveLength(0);
      // An antibiotic (Schedule H) is allowed — decided 2026-10-07.
      await withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: "URTI", body: body([{ ...PARA, drug: "Azithromycin 500 mg Tablet", medicineId: abx }]) }));
      expect(await db.select().from(opdRxSets)).toHaveLength(1);
    });

    it("a hospital STARTER set is shown to nobody until the department's unit head signs it — and an edit un-signs it", async () => {
      await makeHead(dra.userId);
      // Any doctor of the department may draft one; only its author and the unit head see the draft.
      const { setId } = await withTx(db, (tx) => saveRxSet(tx, drb.actor, { scope: "department", name: "URTI — adult", body: body() }));
      expect((await listRxSets(db, drb.actor)).items.map((s) => [s.name, s.signed, s.maySign])).toEqual([["URTI — adult", false, false]]);
      expect((await listRxSets(db, dra.actor)).items.map((s) => [s.name, s.signed, s.maySign])).toEqual([["URTI — adult", false, true]]);
      const drc = await mkDoctor(db, { username: "drc", departmentId: deptId, roomId });
      expect((await listRxSets(db, drc.actor)).items).toEqual([]);

      await expect(withTx(db, (tx) => signRxSet(tx, drb.actor, setId))).rejects.toMatchObject({ code: "rx_set_not_permitted" });
      await withTx(db, (tx) => signRxSet(tx, dra.actor, setId));
      const seen = (await listRxSets(db, drc.actor)).items;
      expect(seen.map((s) => [s.name, s.signed, s.scope, s.mine])).toEqual([["URTI — adult", true, "department", false]]);
      expect(seen[0]!.signedByName).not.toBeNull();

      // What was signed is what is shown: an edit clears the signature and hides it again.
      await withTx(db, (tx) => saveRxSet(tx, drb.actor, { id: setId, scope: "department", name: "URTI — adult", body: body([PARA, { ...PARA, drug: "Cetirizine 10 mg Tablet", frequency: "HS" }]) }));
      expect((await listRxSets(db, drc.actor)).items).toEqual([]);
    });

    it("a starter set for ANOTHER department is refused, and an empty or over-long set is not a set", async () => {
      const other = await mkUser(db, "noone", ["doctor"]);
      await expect(withTx(db, (tx) => saveRxSet(tx, other.actor, { scope: "department", departmentId: deptId, name: "x", body: body() }))).rejects.toMatchObject({ code: "rx_set_not_permitted" });
      await expect(withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: "x", body: { lines: [], tests: [], advice: null, reviewDays: null } }))).rejects.toMatchObject({ code: "invalid_rx_set" });
      await expect(withTx(db, (tx) => saveRxSet(tx, dra.actor, { scope: "doctor", name: "x", body: body(Array.from({ length: 13 }, () => PARA)) }))).rejects.toMatchObject({ code: "invalid_rx_set" });
    });
  });

  describe("the spoken note", () => {
    const AUDIO = Buffer.from("not really audio, and it does not matter here");

    async function inConsult(): Promise<{ encounterId: string; patientName: string; uhid: string }> {
      const patientName = "Rameshwar Prasad Yadav";
      const patient = await mkPatient(db, clerk.actor, { name: patientName, sex: "male", phone: "9812345678", ageYears: 56, address: "Ward 12, Hajipur" } as never);
      const enc = (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter;
      await recordVitals(db, vd.actor, enc.id, adultOk, MON);
      const q = await listQueue(db, dra.actor, dra.doctorId, enc.serviceDate, MON);
      await callNext(db, dra.actor, q!.session.id, MON);
      await startConsultation(db, dra.actor, enc.id, MON);
      return { encounterId: enc.id, patientName, uhid: patient.uhid };
    }

    /** A provider that answers, and remembers exactly what it was sent. */
    function provider(text: string, status = 200): { fetcher: typeof fetch; sent: { url: string; fields: Record<string, string>; fileBytes: number; headers: Record<string, string> }[] } {
      const sent: { url: string; fields: Record<string, string>; fileBytes: number; headers: Record<string, string> }[] = [];
      const fetcher = (async (url: unknown, init?: RequestInit) => {
        const form = init!.body as FormData;
        const fields: Record<string, string> = {};
        let fileBytes = 0;
        for (const [k, v] of form.entries()) {
          if (typeof v === "string") fields[k] = v;
          else { fileBytes = (v as Blob).size; fields[k] = `<file ${(v as File).name}>`; }
        }
        sent.push({ url: String(url), fields, fileBytes, headers: init!.headers as Record<string, string> });
        return new Response(JSON.stringify({ text }), { status });
      }) as unknown as typeof fetch;
      return { fetcher, sent };
    }

    it("sends the clip and a hint — age band, sex, vitals, department, vocabulary — and NOTHING that names the patient", async () => {
      const v = await inConsult();
      const p = provider("teen din se bukhar, khansi");
      const out = await transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 14 }, { fetcher: p.fetcher, now: MON });
      expect(out.text).toBe("teen din se bukhar, khansi");
      expect(p.sent).toHaveLength(1);
      const s = p.sent[0]!;
      expect(s.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      // Exactly four parts. A fifth part would be a fifth thing leaving the building.
      expect(Object.keys(s.fields).sort()).toEqual(["file", "model", "prompt", "response_format"]);
      expect(s.fields.model).toBe("gpt-4o-transcribe");
      expect(s.fileBytes).toBe(AUDIO.length);
      expect(Object.keys(s.headers)).toEqual(["authorization"]);
      const everything = JSON.stringify(s.fields).toLowerCase();
      for (const secret of [v.patientName, "rameshwar", "yadav", v.uhid, "9812345678", "hajipur", "ward 12", v.encounterId]) {
        expect(everything).not.toContain(secret.toLowerCase());
      }
      // …and what MAY go did go.
      expect(s.fields.prompt).toContain("50-59 years");
      expect(s.fields.prompt).toContain("male");
      expect(s.fields.prompt).toContain("BP 150/90");
      expect(s.fields.prompt).toContain("bukhar");
    });

    it("keeps no audio and no words — the meter holds seconds and counts, the event names the doctor only", async () => {
      const v = await inConsult();
      const p = provider("Pan 40 subah khali pet, CBC karwa lijiye");
      const out = await transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 9.4 }, { fetcher: p.fetcher, now: MON });
      const usage = await db.select().from(opdVoiceUsage);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ id: out.voiceId, userId: dra.userId, seconds: 9, transcriptChars: out.text.length, changedChars: null, ok: true, model: "gpt-4o-transcribe" });
      const ev = (await db.select().from(events)).filter((e) => e.name === "consultation.voice_transcribed");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toEqual({ doctorId: dra.doctorId, seconds: 9, model: "gpt-4o-transcribe", ok: true });
      // Nothing that was said is anywhere in the database: not in the meter, not in any event, not on the visit.
      const dump = JSON.stringify([usage, await db.select().from(events), await getEncounter(db, v.encounterId)]).toLowerCase();
      expect(dump).not.toContain("khali pet");
      expect(dump).not.toContain("pan 40");

      await recordVoiceKept(db, dra.actor, out.voiceId, { changedChars: 6, keptChars: 40 });
      expect((await db.select().from(opdVoiceUsage))[0]).toMatchObject({ changedChars: 6, keptChars: 40 });
      // Another doctor cannot write on this doctor's meter.
      await expect(recordVoiceKept(db, drb.actor, out.voiceId, { changedChars: 1, keptChars: 1 })).rejects.toMatchObject({ code: "unknown_voice_note" });
      const meter = await voiceMeter(db, keyFile, MON);
      expect(meter.doctors).toEqual([expect.objectContaining({ userId: dra.userId, notes: 1, changedShare: expect.any(Number) })]);
      expect(meter.days[0]).toMatchObject({ notes: 1 });
    });

    it("medicine and test words are OFFERED from the hospital's own lists, never added", async () => {
      const pan = await medicine("Pan 40 Tablet");
      await medicine("Paracetamol 500 mg Tablet");
      const tests = [{ serviceId: "svc-cbc", code: "CBC", name: "Complete blood count", pricePaise: 25000 }];
      const s = await suggestFromTranscript(db, "Teen din se bukhar. Pan 40 subah khali pet. CBC karwa lijiye.", tests);
      expect(s).toEqual([
        { kind: "medicine", heard: "Pan 40", medicineId: pan, name: "Pan 40 Tablet", form: "tablet", strength: null },
        { kind: "test", heard: "CBC", serviceId: "svc-cbc", code: "CBC", name: "Complete blood count", pricePaise: 25000 },
      ]);
      const v = await inConsult();
      const before = await getEncounter(db, v.encounterId);
      await transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 5 }, { fetcher: provider("Pan 40 subah").fetcher, now: MON });
      const after = await getEncounter(db, v.encounterId);
      expect(after!.rxDraft).toEqual(before!.rxDraft);
      expect(after!.doctorNote).toEqual(before!.doctorNote);
    });

    it("is OFF without the key file, when switched off, and past the day's cap — and says which", async () => {
      const v = await inConsult();
      const p = provider("x");
      await expect(transcribeConsultNote(db, null, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 5 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ code: "voice_unavailable_state_conflict", detail: { why: "not_configured" } });
      expect((await voiceStatus(db, join(tmpdir(), "no-such-key-file"), MON)).why).toBe("not_configured");

      await saveVoiceSettings(db, dra.actor, { enabled: false }, MON);
      await expect(transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 5 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ detail: { why: "switched_off" } });

      await saveVoiceSettings(db, dra.actor, { enabled: true, dailyMinutesCap: 1 }, MON);
      await transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 60 }, { fetcher: p.fetcher, now: MON });
      await expect(transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 5 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ detail: { why: "cap_reached" } });
      expect(p.sent).toHaveLength(1); // the three refusals sent nothing
    });

    it("takes at most sixty seconds, only the treating doctor's own open consultation, and a provider failure costs no minutes", async () => {
      const v = await inConsult();
      const p = provider("x");
      await expect(transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: VOICE_MAX_SECONDS + 10 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ code: "invalid_voice_clip" });
      await expect(transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: Buffer.alloc(0), mimeType: "audio/mp4", seconds: 5 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ code: "invalid_voice_clip" });
      await expect(transcribeConsultNote(db, keyFile, drb.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 5 }, { fetcher: p.fetcher, now: MON }))
        .rejects.toMatchObject({ code: "not_your_patient" });
      expect(p.sent).toHaveLength(0);
      const down = provider("", 500);
      await expect(transcribeConsultNote(db, keyFile, dra.actor, v.encounterId, { audio: AUDIO, mimeType: "audio/mp4", seconds: 20 }, { fetcher: down.fetcher, now: MON }))
        .rejects.toMatchObject({ code: "voice_provider_failed" });
      expect((await db.select().from(opdVoiceUsage).where(eq(opdVoiceUsage.ok, false)))[0]).toMatchObject({ seconds: 0 });
      expect((await voiceStatus(db, keyFile, MON)).usedSecondsToday).toBe(0);
    });

    it("the hint is built from four facts and has no way to carry a fifth", () => {
      expect(ageBandOf(new Date("1970-06-01"), MON)).toBe("50-59 years");
      expect(ageBandOf(new Date("2025-01-01"), MON)).toBe("child under 5");
      expect(ageBandOf(null, MON)).toBeNull();
      const hint = hintFor({ ageBand: "50-59 years", sex: "male", vitals: "BP 150/90", department: "General Medicine" }, ["Pan 40"], ["CBC"]);
      expect(hint).toContain("Patient: 50-59 years, male, General Medicine OPD.");
      expect(hint).toContain("Pan 40");
      expect(hintFor.length).toBe(3);
    });
  });
});
