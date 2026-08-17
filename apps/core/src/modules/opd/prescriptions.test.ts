import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "../../../test/helpers/opd";
import { hmacSign } from "../../kernel/crypto";
import { events, patientAllergies } from "../../kernel/db/schema";
import { completeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { toFhirBundle } from "./fhir";
import {
  buildRxQrPayload, getPrescriptionPrint, issuePrescription, listPrescriptions, matchAllergies, verifyPrescriptionQr,
} from "./prescriptions";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import type { EncounterRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST — every doctor's default template covers Mon–Sat 09:00–13:00. */
const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 20 * 60_000);
const MON3 = new Date(MON.getTime() + 40 * 60_000);
/** Fixed DOB so the printed age is a constant, never a function of the day the suite runs. */
const DOB = new Date(Date.UTC(1996, 0, 15));
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

const TWO_LINES: RxLine[] = [
  { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false },
  { drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS", durationDays: null, instructions: null, noSubstitution: true },
];
const PENICILLIN_LINES: RxLine[] = [
  { drug: "Tab Penicillin V", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 5, instructions: null, noSubstitution: false },
  { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 3, instructions: null, noSubstitution: false },
];

describe("opd prescriptions (allergy hard-warning, versions, the signed e-Rx QR and the print payload)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let patient: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });
  });

  /** open → vitals (registered→waiting) → call → start, the production path the desk actually walks. */
  async function inConsult(doc: Awaited<ReturnType<typeof mkDoctor>> = dra, at: Date = MON): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doc.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    await callNext(db, doc.actor, opened.sessionId, at);
    return (await startConsultation(db, doc.actor, opened.encounter.id, at)).encounter;
  }

  /**
   * Disclosed test shaping (§3.10 derived-fixture check): the patients module exports no allergy WRITER, so the
   * row is inserted in exactly the storage shape listAllergies — the helper under test here — reads back. The
   * HTTP path (POST /patients/:id/allergies) is covered by T10's e2e.
   */
  async function addActiveAllergy(substance: string): Promise<void> {
    await db.insert(patientAllergies).values({ id: newId(), patientId: patient.id, substance, source: "registration", recordedBy: "t" });
  }

  const eventsNamed = (name: string): Promise<{ payload: unknown; patientId: string | null; module: string }[]> =>
    db.select({ payload: events.payload, patientId: events.patientId, module: events.module }).from(events).where(eq(events.name, name));

  it("issues v1 with the FHIR document, a signed QR payload and one prescription.issued; empty and blank lines refuse", async () => {
    const enc = await inConsult();
    await saveConsultNote(db, dra.actor, enc.id, { diagnosis: "Acute pharyngitis", icd10Code: "J02.9" });

    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2);
    expect(issued.version).toBe(1);
    expect(issued.allergyOverrideCount).toBe(0);
    expect(issued.qrPayload).toMatch(/^rx1\.[0-9A-Z]{26}\.[0-9A-Z]{26}\.1\.[A-Za-z0-9_-]{43}$/);
    expect(issued.qrPayload).toBe(buildRxQrPayload(testCfg, { id: issued.prescriptionId, encounterId: enc.id, version: 1 }));

    const rows = await listPrescriptions(db, enc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: issued.prescriptionId, status: "active", version: 1, patientId: patient.id, doctorId: dra.doctorId, issuedBy: dra.userId,
    });
    expect(rows[0]!.allergyOverrides).toEqual([]);
    expect(rows[0]!.lines).toEqual(TWO_LINES);
    expect(rows[0]!.issuedAt).toEqual(MON2);
    expect(rows[0]!.document).toEqual(toFhirBundle({
      prescriptionId: issued.prescriptionId, version: 1, encounterId: enc.id, patientId: patient.id, doctorId: dra.doctorId,
      issuedAt: MON2, diagnosis: "Acute pharyngitis", icd10Code: "J02.9", lines: TWO_LINES,
    }));

    const evs = await eventsNamed("prescription.issued");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({
      prescriptionId: issued.prescriptionId, encounterId: enc.id, patientId: patient.id, doctorId: dra.doctorId,
      version: 1, lineCount: 2, allergyOverrideCount: 0,
    });

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [] }, MON3))
      .rejects.toMatchObject({ code: "empty_prescription" });
    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [{ ...TWO_LINES[0]!, drug: "   " }] }, MON3))
      .rejects.toMatchObject({ code: "empty_prescription" });
    expect(await listPrescriptions(db, enc.id)).toHaveLength(1);
  });

  it("the allergy hard-warning blocks, a reasoned override releases it, and matching is bidirectional and case-insensitive", async () => {
    const enc = await inConsult();
    await addActiveAllergy("Penicillin");

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: PENICILLIN_LINES }, MON2)).rejects.toMatchObject({
      code: "allergy_conflict", detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] },
    });
    expect(await listPrescriptions(db, enc.id)).toHaveLength(0);
    expect(await eventsNamed("prescription.issued")).toHaveLength(0);

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: PENICILLIN_LINES, overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "  " }],
    }, MON2)).rejects.toMatchObject({ code: "override_reason_required" });

    const ok = await issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: PENICILLIN_LINES,
      overrides: [
        { lineIndex: 0, substance: "Penicillin", reason: "tolerated previously, benefit outweighs" },
        { lineIndex: 1, substance: "Penicillin", reason: "line 1 never matched — ignored" },
      ],
    }, MON2);
    expect(ok.allergyOverrideCount).toBe(1); // only overrides that resolve a real match are stored and counted
    expect((await listPrescriptions(db, enc.id))[0]!.allergyOverrides)
      .toEqual([{ lineIndex: 0, substance: "Penicillin", reason: "tolerated previously, benefit outweighs" }]);
    expect((await eventsNamed("prescription.issued"))[0]!.payload).toMatchObject({ allergyOverrideCount: 1 });

    // Pure matching: substring in EITHER direction, case-insensitively — and never across different molecules.
    expect(matchAllergies([{ drug: "Sulfamethoxazole" }], ["sulfa"])).toEqual([{ lineIndex: 0, substance: "sulfa" }]);
    expect(matchAllergies([{ drug: "penicillin" }], ["Penicillin G"])).toEqual([{ lineIndex: 0, substance: "Penicillin G" }]);
    expect(matchAllergies([{ drug: "Tab Amoxicillin 500 mg" }], ["Penicillin"])).toEqual([]);

    // A corrected (entered_in_error) allergy is not an allergy any more.
    const second = await inConsult();
    await db.update(patientAllergies).set({ status: "entered_in_error" }).where(eq(patientAllergies.patientId, patient.id));
    expect((await issuePrescription(db, dra.actor, testCfg, second.id, { lines: PENICILLIN_LINES }, MON3)).allergyOverrideCount).toBe(0);
  });

  it("a re-issue supersedes the previous version; both are listed by version ascending", async () => {
    const enc = await inConsult();
    const v1 = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2);
    const v2 = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [TWO_LINES[0]!] }, MON3);
    expect(v2.version).toBe(2);

    const rows = await listPrescriptions(db, enc.id);
    expect(rows.map((r) => [r.version, r.status])).toEqual([[1, "superseded"], [2, "active"]]);
    expect(rows[0]!.id).toBe(v1.prescriptionId);
    expect(rows[1]!.id).toBe(v2.prescriptionId);
    expect(await eventsNamed("prescription.issued")).toHaveLength(2);
  });

  it("two concurrent issues allocate versions 1 and 2, leaving exactly one active row and two events", async () => {
    const enc = await inConsult();
    const both = await Promise.all([
      issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2),
      issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2),
    ]);
    expect(both.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2]);

    const rows = await listPrescriptions(db, enc.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.filter((r) => r.status === "active").map((r) => r.version)).toEqual([2]);
    expect(await eventsNamed("prescription.issued")).toHaveLength(2);
  });

  it("only the treating doctor prescribes, and only while the encounter is in consultation", async () => {
    const enc = await inConsult();
    await expect(issuePrescription(db, drb.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2))
      .rejects.toMatchObject({ code: "not_your_patient" });

    const waiting = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, waiting.encounter.id, adultOk, MON);
    await expect(issuePrescription(db, dra.actor, testCfg, waiting.encounter.id, { lines: TWO_LINES }, MON2))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });

    await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: true }, MON2);
    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON3))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("verification returns a reason and never throws on failure: forged, malformed, stale and unknown each event once", async () => {
    const enc = await inConsult();
    const v1 = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2);

    const good = await verifyPrescriptionQr(db, testCfg, clerk.actor, v1.qrPayload);
    expect(good).toEqual({
      ok: true,
      prescription: { id: v1.prescriptionId, version: 1, issuedAt: MON2, lines: TWO_LINES },
      patient: { uhid: patient.uhid, name: "Asha Devi", alias: null, restricted: false },
      doctor: { displayName: "Dr dra", registrationNo: "BMC/12345" },
    });
    expect(await eventsNamed("qr.signature_failed")).toHaveLength(0);

    // Deterministic tamper: flipping the LAST character of a base64url signature ALWAYS changes it
    // (Plan 05's slice(0,-2)+"xx" has a 1-in-4096 chance of not changing it — not reproduced here).
    const last = v1.qrPayload.slice(-1);
    const tampered = `${v1.qrPayload.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(tampered).not.toBe(v1.qrPayload);
    expect(await verifyPrescriptionQr(db, testCfg, clerk.actor, tampered)).toEqual({ ok: false, reason: "invalid_signature" });
    const forged = await eventsNamed("qr.signature_failed");
    expect(forged).toHaveLength(1);
    expect(forged[0]!.module).toBe("opd");
    expect(forged[0]!.patientId).toBeNull(); // a forged payload's embedded id is not trusted, so nothing is attributed
    expect(forged[0]!.payload).toEqual({ reason: "invalid_signature", payloadPrefix: tampered.slice(0, 32) });

    expect(await verifyPrescriptionQr(db, testCfg, clerk.actor, "garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(await eventsNamed("qr.signature_failed")).toHaveLength(2);

    // v2 supersedes v1, so the printed v1 card stops verifying from that commit on.
    const v2 = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON3);
    expect(await verifyPrescriptionQr(db, testCfg, clerk.actor, v1.qrPayload)).toEqual({ ok: false, reason: "stale_version" });
    const stale = await db.select().from(events).where(and(eq(events.name, "qr.signature_failed"), eq(events.patientId, patient.id)));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.payload).toEqual({ reason: "stale_version", payloadPrefix: v1.qrPayload.slice(0, 32), patientId: patient.id });
    expect(await verifyPrescriptionQr(db, testCfg, clerk.actor, v2.qrPayload)).toMatchObject({ ok: true, prescription: { version: 2 } });

    // A signature WE minted over an id that was never issued — only the key holder can produce this shape.
    const body = `rx1.${"0".repeat(26)}.${enc.id}.1`;
    expect(await verifyPrescriptionQr(db, testCfg, clerk.actor, `${body}.${hmacSign(testCfg.secretKey, body)}`))
      .toEqual({ ok: false, reason: "unknown_prescription" });

    await expect(verifyPrescriptionQr(db, testCfg, { type: "system", id: "sweep" }, v2.qrPayload))
      .rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("the print payload carries the letterhead, the patient, the doctor, the encounter, the latest vitals and the QR", async () => {
    const enc = await inConsult();
    await saveConsultNote(db, dra.actor, enc.id, {
      chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis", icd10Code: "J02.9", advice: "fluids",
    });
    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: TWO_LINES }, MON2);
    const print = await getPrescriptionPrint(db, testCfg, dra.actor, issued.prescriptionId);

    expect(print.letterhead).toEqual({ name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] });
    expect(print.patient).toEqual({ uhid: patient.uhid, name: "Asha Devi", alias: null, restricted: false, ageYears: 30, sex: "female" });
    expect(print.doctor).toEqual({ displayName: "Dr dra", registrationNo: "BMC/12345", departmentName: "General Medicine" });
    expect(print.encounter).toEqual({
      id: enc.id, serviceDate: "2026-08-17", diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
      advice: "fluids", followUpDays: null, chiefComplaint: "fever 3d",
    });
    expect(print.vitals).toMatchObject({ sbp: 120, band: "adult", dangerFlags: [] });
    expect(print.lines).toEqual(TWO_LINES);
    expect(print.qrPayload).toBe(issued.qrPayload);
    expect(print.version).toBe(1);
    expect(print.issuedAt).toEqual(MON2);
  });
});
