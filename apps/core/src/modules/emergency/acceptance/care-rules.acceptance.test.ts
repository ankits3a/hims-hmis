import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { alerts, erChargeLines, rosterDutyWindows, rosterTeams, stockLedger } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { newId } from "@hmis/contracts";
import { addAllergy } from "../../patients";
import { orgDepartmentByCode, seedOrgDepartments } from "../../roster";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErCareWorld } from "../../../../test/helpers/emergency";
import {
  answerCall, callSpecialty, cosignErNote, declareStabilised, giveErDose, issueErMed, readErCare, recordConsent, recordErNote,
  registerArrival, registerErChargeSink, registerErEncounterResolver, registerUnidentified, signErVerbalOrder, sweepErCareClocks,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErCareWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 3 (#810) — the lane section's rules (spec §3.11, §4.3), through the intents: the resident's draft note, the
 * ER issue (stock, labels, charge line, own medicine), the allergy override, the high-alert second check, the verbal
 * order, emergency consent, specialty calls to the take unit and their climb, "stabilised", and the screen's read.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 3 er-care — the care rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErCareWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const unknown = (now = new Date()) => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "female", ageBand: "adult", arrivalMode: "walk_in" }, { now });

  it("a resident's note is a draft until a senior co-signs it; the author and another resident cannot", async () => {
    const u = await unknown();
    const note = await recordErNote(db, w.resident, { idempotencyKey: key(), episodeId: u.episodeId, kind: "assessment", text: "Pain abdomen, guarding" });
    expect(note.status).toBe("draft");
    await expect(cosignErNote(db, w.resident, { idempotencyKey: key(), noteId: note.noteId })).rejects.toMatchObject({ code: "cosign_own_note" });
    const other = (await mkUser(db, "er.resident2", ["doctor", "resident"])).actor;
    await expect(cosignErNote(db, other, { idempotencyKey: key(), noteId: note.noteId })).rejects.toMatchObject({ code: "cosigner_not_senior" });
    await expect(cosignErNote(db, w.erDoctor, { idempotencyKey: key(), noteId: note.noteId, addendum: "Agree; surgical opinion" })).resolves.toMatchObject({ status: "signed" });
    expect((await recordErNote(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, kind: "progress", text: "Better" })).status).toBe("signed");
    expect((await readErCare(db, w.erDoctor, u.episodeId)).notes.map((n) => n.status).sort()).toEqual(["signed", "signed"]);
  });

  it("the ER issue takes stock FEFO, prints patient labels, posts an ER line for the bill desk; own medicine takes nothing", async () => {
    const ceftriaxone = await w.stocked("Ceftriaxone 1 g", { qty: 10 });
    const u = await unknown();
    const out = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: ceftriaxone, doseWords: "1 g", route: "iv", units: 2, orderedBy: w.erDoctor.id });
    expect(out.labelLines[0]).toBe("Ceftriaxone 1 g · 1 g · IV");
    expect(out.labelLines).toContain("Allergy: unknown");
    const moved = await db.select().from(stockLedger).where(eq(stockLedger.refId, out.issueId));
    expect(moved.map((m) => m.qtyDelta)).toEqual([-2]);
    const lines = await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, out.issueId));
    expect(lines.map((l) => [l.source, l.status, l.qty, l.amountPaise])).toEqual([["er.issue", "rate_pending", 2, null]]);
    await expect(issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: ceftriaxone, doseWords: "1 g", route: "iv", units: 50, orderedBy: w.erDoctor.id }))
      .rejects.toMatchObject({ code: "stock_short" });
    await expect(issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: ceftriaxone, doseWords: "1 g", route: "iv", units: 1, orderedBy: w.erNurse.id }))
      .rejects.toMatchObject({ code: "not_a_doctor" });
    const own = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, ownMedicine: "Own insulin pen", doseWords: "8 units", route: "sc", units: 1, orderedBy: w.erDoctor.id });
    expect(await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, own.issueId))).toEqual([]);
  });

  it("a recorded allergy that matches needs the override reason — never a hard block", async () => {
    const amox = await w.stocked("Amoxiclav 1.2 g", { moiety: "Amoxicillin" });
    const p = await w.patient("female", 40, "Rekha Singh");
    await withTx(db, (tx) => addAllergy(tx, w.erDesk, p, { substance: "Amoxicillin", severity: "severe", source: "registration" }));
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" });
    const body = { episodeId: a.episodeId, itemId: amox, doseWords: "1.2 g", route: "iv" as const, units: 1, orderedBy: w.erDoctor.id };
    await expect(issueErMed(db, w.erNurse, { idempotencyKey: key(), ...body })).rejects.toMatchObject({ code: "allergy_override_needed", detail: { allergies: ["Amoxicillin"] } });
    await expect(issueErMed(db, w.erNurse, { idempotencyKey: key(), ...body, allergyOverride: "Consultant aware; no alternative in resus" })).resolves.toMatchObject({ highAlert: false });
  });

  it("a high-alert dose is given only with a second person's PIN — not the giver's, not a wrong one", async () => {
    const kcl = await w.stocked("Potassium chloride 15%", { highAlert: true });
    const u = await unknown();
    const issued = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: kcl, doseWords: "20 mmol in 500 ml", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    expect(issued.highAlert).toBe(true);
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given" })).rejects.toMatchObject({ code: "second_check_needed" });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given", secondCheck: w.pins.erNurse })).rejects.toMatchObject({ code: "second_checker_same" });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given", secondCheck: { username: "er.nurse2", pin: "0000" } })).rejects.toMatchObject({ code: "second_check_failed" });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given", secondCheck: w.pins.nurse2 }))
      .resolves.toMatchObject({ outcome: "given", secondCheckedBy: w.nurse2.id });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "held", reason: "x" })).rejects.toMatchObject({ code: "dose_already_recorded" });
  });

  it("a verbal order is signed by its doctor; unsigned 2 hours, the doctor's bell rings once", async () => {
    const adr = await w.stocked("Adrenaline 1 mg/ml");
    const t0 = new Date();
    const u = await unknown(t0);
    const issued = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: adr, doseWords: "1 mg", route: "iv", units: 1, orderedBy: w.erDoctor.id, verbal: { readBack: true } }, { now: t0 });
    expect(issued.verbal).toBe(true);
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 119 * MIN))).toMatchObject({ verbal: 0 });
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 121 * MIN))).toMatchObject({ verbal: 1 });
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 122 * MIN))).toMatchObject({ verbal: 0 });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.erDoctor.id), eq(alerts.kind, "er.verbal_unsigned")))).toHaveLength(1);
    await expect(signErVerbalOrder(db, w.doctor, { idempotencyKey: key(), issueId: issued.issueId })).rejects.toMatchObject({ code: "not_ordering_doctor" });
    await expect(signErVerbalOrder(db, w.erDoctor, { idempotencyKey: key(), issueId: issued.issueId })).resolves.toMatchObject({ issueId: issued.issueId });
    await expect(signErVerbalOrder(db, w.erDoctor, { idempotencyKey: key(), issueId: issued.issueId })).rejects.toMatchObject({ code: "verbal_not_pending" });
  });

  it("emergency treatment without consent needs a second, different doctor; a paper consent names its witness", async () => {
    const u = await unknown();
    const base = { episodeId: u.episodeId, kind: "procedure" as const, about: "Intubation", method: "paper" as const };
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, signedBy: "emergency" })).rejects.toMatchObject({ code: "emergency_needs_second_doctor" });
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, signedBy: "emergency", secondDoctorId: w.erDoctor.id })).rejects.toMatchObject({ code: "emergency_needs_second_doctor" });
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, signedBy: "emergency", secondDoctorId: w.erNurse.id })).rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, signedBy: "emergency", secondDoctorId: w.doctor.id })).resolves.toHaveProperty("consentId");
    await expect(recordConsent(db, w.erNurse, { idempotencyKey: key(), ...base, signedBy: "guardian", signerName: "Ramesh", relation: "husband" }))
      .rejects.toMatchObject({ code: "consent_witness_needed" });
  });

  it("a specialty call goes to the unit on take at the GATE; unanswered 15 minutes it climbs once; answered and seen are stamped", async () => {
    await seedOrgDepartments(db);
    await ensureRole(db, "duty_manager");
    const dm = (await mkUser(db, "er.dm2", ["duty_manager"])).actor;
    const sur = (await orgDepartmentByCode(db, "SUR"))!.id;
    const team = newId();
    const by = { createdBy: w.doctor.id, updatedBy: w.doctor.id };
    await db.insert(rosterTeams).values({ id: team, kind: "clinical_unit", departmentId: sur, code: "T-SUR-U2", name: "Surgery Unit II", active: true, validFrom: new Date("2026-01-01T00:00:00Z"), ...by } as never);
    const t0 = new Date();
    await db.insert(rosterDutyWindows).values({ id: newId(), departmentId: sur, teamId: team, activity: "take", startsAt: new Date(t0.getTime() - 60 * MIN), endsAt: new Date(t0.getTime() + 60 * MIN), source: "cycle", ...by } as never);
    const u = await unknown(t0);
    const call = await callSpecialty(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, departmentCode: "sur", urgency: "urgent", reason: "Acute abdomen" }, { now: t0 });
    expect(call).toMatchObject({ takeTeamId: team, takeSource: "published" });
    await expect(callSpecialty(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, departmentCode: "SUR", urgency: "urgent", reason: "again" }, { now: t0 }))
      .rejects.toMatchObject({ code: "call_already_open" });
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 14 * MIN))).toMatchObject({ calls: 0 });
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 15 * MIN))).toMatchObject({ calls: 1 });
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 16 * MIN))).toMatchObject({ calls: 0 });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, dm.id), eq(alerts.kind, "er.call_unanswered")))).toHaveLength(1);
    await answerCall(db, w.doctor, { idempotencyKey: key(), callId: call.callId, step: "answered" }, { now: new Date(t0.getTime() + 17 * MIN) });
    const seen = await answerCall(db, w.doctor, { idempotencyKey: key(), callId: call.callId, step: "seen" }, { now: new Date(t0.getTime() + 25 * MIN) });
    expect(seen.answeredAt).toBe(new Date(t0.getTime() + 17 * MIN).toISOString());
    await expect(answerCall(db, w.doctor, { idempotencyKey: key(), callId: call.callId, step: "seen" })).rejects.toMatchObject({ code: "call_closed" });
  });

  it("'stabilised' is a doctor's word, said once", async () => {
    const u = await unknown();
    await expect(declareStabilised(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId })).rejects.toMatchObject({ code: "not_a_doctor" });
    const s = await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, note: "Airway secure, BP 110/70" });
    await expect(declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId })).rejects.toMatchObject({ code: "already_stabilised" });
    const care = await readErCare(db, w.erDoctor, u.episodeId);
    expect(care.stabilisedAt).toBe(s.stabilisedAt);
    expect(JSON.stringify(care)).not.toMatch(/paise|amount|price|deposit|paid/i);
  });
});
