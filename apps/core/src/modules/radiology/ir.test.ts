import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import {
  doseRegister, events, imagingDefinitions, imagingIrCases, imagingStudies, labAnalytes, labResults, orderItems,
  orders, services,
} from "../../kernel/db/schema";
import { recordAcquired, startAcquisition } from "./acquisition";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import {
  coagulationVerdicts, irCaseList, irCaseView, irSignIn, irSignOut, irTimeOut, overrideCoagulation, recordHandoff,
  recordProcedureNote, recordSedationVitals, recordSkinFollowUp, skinDoseLevels,
} from "./ir";
import { parseDoseSr } from "./pacs";
import { inrFromReported, plateletsPerUlFromReported } from "../lab";
import type { IrSignInInput, IrSignOutInput, IrTimeOutInput } from "./ir";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS12b — the IR suite's core: the WHO phases gate the machine (T1), the coagulation rule
 * and its override, the sedation chart / note / hand-off, and Ka,r with the 3 Gy / 5 Gy triggers (T2).
 *
 * The book below makes `XR-CHEST` an interventional HIGH-bleeding-risk procedure on the X-ray unit
 * (the fixture's services are keyed by those four codes) and `CT-HEAD` a LOW-risk one.
 */
describe("the IR suite (18-S RS12b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let nurse: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    ({ actor: nurse } = await mkUser(db, "rn.tirkey", ["radiographer"]));
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({
        code: "XR-CHEST", name: "Percutaneous nephrostomy", service_id: fx.services["XR-CHEST"]!, modality: "xray",
        ionising: true, interventional: true, bleeding_risk: "high",
      }),
      studyTypeRow({
        code: "CT-HEAD", name: "Diagnostic angiography", service_id: fx.services["CT-HEAD"]!, modality: "ct",
        ionising: true, interventional: true, bleeding_risk: "low",
      }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] } }).where(eq(imagingDefinitions.kind, "study_types"));
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  /** Booked, checked in, the check-in gates closed, readiness evaluated, STAT (so no invoice is owed). */
  const arrive = async (code: "XR-CHEST" | "CT-HEAD" | "USG-ABDO", deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, code, `ir${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
      laterality_confirm: { patientStated: "na" },
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    return study;
  };

  /** A signed lab number (INR or PLT) on the lab's own rows, drawn at `at`. */
  const labValue = async (code: "INR" | "PLT", value: string, unit: string | null, at: Date) => {
    const svc = newId();
    await db.insert(services).values({ id: svc, code: `LAB-${svc.slice(-6)}`, name: code, category: "investigation", createdBy: "t", updatedBy: "t" });
    const existing = await db.select().from(labAnalytes).where(eq(labAnalytes.code, code));
    const analyteId = existing[0]?.id ?? newId();
    if (!existing[0]) {
      await db.insert(labAnalytes).values({ id: analyteId, code, nameEn: code, resultType: "numeric", unit, createdBy: "t", updatedBy: "t" });
    }
    const orderId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `L${orderId.slice(-8)}`, orderGroupId: orderId, kind: "lab", patientId: fx.patientId,
      encounterNo: fx.visitNo, serviceDate: DAY, priority: "routine", authority: "clinician",
      orderedByType: "user", orderedById: fx.doctor.id, placedAt: at,
    });
    const itemId = newId();
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId: svc });
    await db.insert(labResults).values({
      id: newId(), orderItemId: itemId, analyteId, valueNumeric: value, unit,
      enteredByType: "user", enteredById: "t", entryMode: "manual",
      verificationStatus: "verified", verifiedBy: "path", verifiedAt: at,
    });
  };
  const goodLabs = async () => {
    await labValue("INR", "1.1", null, new Date(NOW.getTime() - 86_400_000));
    await labValue("PLT", "210", "10^3/uL", new Date(NOW.getTime() - 86_400_000));
  };

  const signInBody = (code: string, over: Partial<IrSignInInput> = {}): IrSignInInput => ({
    participants: ["Dr Rao (operator)", "Sr Tirkey (sedation nurse)"],
    identityConfirmed: true,
    consent: {
      procedureCode: code, templateVersion: "IR-CONSENT-v1", language: "hi", signer: "patient",
      witness: "Sunita Oraon (staff nurse)", thumbImpression: false, laterality: null, conversionCovered: false,
      signedAt: NOW.toISOString(),
    },
    siteMarked: true, allergiesReviewed: true, anticoagulants: "none", sedationPlan: "moderate",
    sedationBy: "Sr Tirkey", lastSolidsAt: new Date(NOW.getTime() - 8 * 3_600_000).toISOString(),
    lastClearFluidsAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), ivAccessAndResus: true,
    ...over,
  });
  const timeOutBody: IrTimeOutInput = {
    participants: ["Dr Rao", "Sr Tirkey", "Rt Singh"], teamIntroduced: true, patientProcedureSideConfirmed: true,
    imagesDisplayed: true, antibiotics: "given", criticalEventsDiscussed: true,
  };
  const signOutBody: IrSignOutInput = {
    participants: ["Dr Rao", "Sr Tirkey"], procedureDone: true, countsCorrect: true, specimens: "labelled",
    devices: "8 Fr locking pigtail, left lower-pole calyx", doseRecorded: true, recoveryPlanGiven: true,
  };
  const start = (studyId: string) => withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId, now: NOW }));
  const send = (studyId: string, dose: { doseDap?: number; fluoroSeconds?: number; doseKar?: number }) =>
    withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId, imageSource: "no_pacs_images", ...dose, now: NOW }));
  const through = async (studyId: string, code: string) => {
    await withTx(db, (tx) => irSignIn(tx, nurse, studyId, signInBody(code), NOW));
    await withTx(db, (tx) => irTimeOut(tx, nurse, studyId, timeOutBody, NOW));
    await start(studyId);
  };

  /* ═════════════════════ T1 — the WHO phases gate the machine ═════════════════════ */

  it("T1: an IR study does not start before Sign in and Time out (ir_checklist_incomplete); it does after both", async () => {
    await goodLabs();
    const s = await arrive("XR-CHEST", "xray");
    await expect(start(s.studyId)).rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["sign_in", "time_out"] } });
    await withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("XR-CHEST"), NOW));
    await expect(start(s.studyId)).rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["time_out"] } });
    await withTx(db, (tx) => irTimeOut(tx, nurse, s.studyId, timeOutBody, NOW));
    await expect(start(s.studyId)).resolves.toMatchObject({ status: "in_acquisition" });
  });

  it("T1: a plain (non-IR) study starts as before, and an IR act on it is refused not_interventional", async () => {
    const s = await arrive("USG-ABDO", "usg");
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("USG-ABDO"), NOW)))
      .rejects.toMatchObject({ code: "not_interventional" });
    await expect(start(s.studyId)).resolves.toMatchObject({ status: "in_acquisition" });
  });

  it("T1: Send refuses an IR study until Sign out; Sign out is only on the table; each phase is recorded once", async () => {
    const s = await arrive("CT-HEAD", "ct");
    await through(s.studyId, "CT-HEAD");
    await expect(send(s.studyId, { doseDap: 12, fluoroSeconds: 300, doseKar: 400 }))
      .rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["sign_out"] } });
    await withTx(db, (tx) => irSignOut(tx, nurse, s.studyId, signOutBody, NOW));
    await expect(withTx(db, (tx) => irSignOut(tx, nurse, s.studyId, signOutBody, NOW))).rejects.toMatchObject({ code: "ir_phase_recorded" });
    await expect(send(s.studyId, { doseDap: 12, fluoroSeconds: 300, doseKar: 400 })).resolves.toMatchObject({ studyId: s.studyId });
  });

  it("T1: the checklist refuses in plain words — unconfirmed items, one-person time out, time out before sign in, fasting", async () => {
    const s = await arrive("CT-HEAD", "ct");
    /** A routine (not STAT) procedure: the fasting hours apply. */
    await db.update(imagingStudies).set({ priority: "routine" }).where(eq(imagingStudies.id, s.studyId));
    await expect(withTx(db, (tx) => irTimeOut(tx, nurse, s.studyId, timeOutBody, NOW)))
      .rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["sign_in"] } });
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("CT-HEAD", {
      allergiesReviewed: false, lastSolidsAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
      consent: { ...signInBody("CT-HEAD").consent, witness: undefined },
    }), NOW))).rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["consent_witness", "allergies", "fasting"] } });
    await withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("CT-HEAD"), NOW));
    await expect(withTx(db, (tx) => irTimeOut(tx, nurse, s.studyId, { ...timeOutBody, participants: ["Dr Rao", " dr rao "] }, NOW)))
      .rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["participants"] } });
  });

  /* ═════════════════════ T1 — coagulation ═════════════════════ */

  it("T1: coagulation — pure rule: missing, stale (> 7 days), INR > 1.5, platelets < 50,000", () => {
    const fresh = new Date(NOW.getTime() - 86_400_000);
    expect(coagulationVerdicts(null, null, NOW)).toEqual(["missing"]);
    expect(coagulationVerdicts({ value: 1.2, sampledAt: fresh }, { perUl: 150_000, sampledAt: fresh }, NOW)).toEqual([]);
    expect(coagulationVerdicts({ value: 1.51, sampledAt: fresh }, { perUl: 49_999, sampledAt: fresh }, NOW)).toEqual(["inr_high", "platelets_low"]);
    expect(coagulationVerdicts({ value: 1.0, sampledAt: new Date(NOW.getTime() - 8 * 86_400_000) }, { perUl: 90_000, sampledAt: fresh }, NOW)).toEqual(["stale"]);
    expect(plateletsPerUlFromReported(210, "10^3/uL")).toBe(210_000);
    expect(plateletsPerUlFromReported(1.4, "lakh/cumm")).toBe(140_000);
    expect(plateletsPerUlFromReported(210, "mg/dL")).toBeNull();
    expect(inrFromReported(1.3, null)).toBe(1.3);
  });

  it("T1: a high-risk Sign in with INR 1.8 is refused coagulation_out_of_range; the radiologist's override (audited) lets it through", async () => {
    await labValue("INR", "1.8", null, new Date(NOW.getTime() - 86_400_000));
    await labValue("PLT", "88", "10^3/uL", new Date(NOW.getTime() - 86_400_000));
    const s = await arrive("XR-CHEST", "xray");
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("XR-CHEST"), NOW)))
      .rejects.toMatchObject({ code: "coagulation_out_of_range", detail: { verdicts: ["inr_high"], inr: 1.8, plateletsPerUl: 88_000 } });
    await expect(withTx(db, (tx) => overrideCoagulation(tx, fx.radiologist, s.studyId, "no", NOW))).rejects.toMatchObject({ code: "reason_required" });
    await withTx(db, (tx) => overrideCoagulation(tx, fx.radiologist, s.studyId, "Obstructed infected kidney — drainage outweighs the bleeding risk", NOW));
    const [kase] = await db.select().from(imagingIrCases).where(eq(imagingIrCases.studyId, s.studyId));
    expect(kase).toMatchObject({ coagOverrideVerdict: "inr_high", coagOverrideBy: fx.radiologist.id });
    const ev = await db.select().from(events).where(eq(events.name, "imaging.ir_coagulation_overridden"));
    expect(ev.map((e) => e.payload)).toEqual([{ studyId: s.studyId, verdicts: ["inr_high"] }]);
    await expect(withTx(db, (tx) => overrideCoagulation(tx, fx.radiologist, s.studyId, "again, a second time", NOW))).rejects.toMatchObject({ code: "ir_phase_recorded" });
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, s.studyId, signInBody("XR-CHEST"), NOW))).resolves.toMatchObject({ phase: "sign_in" });
  });

  it("T1: no labs on a high-risk procedure is `missing`; a low-risk procedure asks nothing; nothing to override in range", async () => {
    const hi = await arrive("XR-CHEST", "xray");
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, hi.studyId, signInBody("XR-CHEST"), NOW)))
      .rejects.toMatchObject({ code: "coagulation_out_of_range", detail: { verdicts: ["missing"] } });
    const lo = await arrive("CT-HEAD", "ct");
    await expect(withTx(db, (tx) => irSignIn(tx, nurse, lo.studyId, signInBody("CT-HEAD"), NOW))).resolves.toMatchObject({ phase: "sign_in" });
    await expect(withTx(db, (tx) => overrideCoagulation(tx, fx.radiologist, lo.studyId, "not needed at all", NOW))).rejects.toMatchObject({ code: "coagulation_in_range" });
  });

  /* ═════════════════════ T1 — the chart, the note, the hand-off, the reads ═════════════════════ */

  it("T1: sedation chart every 5 min, the note, then the hand-off (refused without a note); the view says the next act", async () => {
    await goodLabs();
    const s = await arrive("XR-CHEST", "xray");
    expect((await irCaseView(db, fx.radiographer, s.studyId, NOW)).next).toBe("sign_in");
    await expect(withTx(db, (tx) => recordSedationVitals(tx, nurse, s.studyId, { bpSystolic: 120, bpDiastolic: 80, heartRate: 88, spo2: 98, rass: 0 }, NOW)))
      .rejects.toMatchObject({ code: "ir_checklist_incomplete" });
    await through(s.studyId, "XR-CHEST");
    const t1 = new Date(NOW.getTime() + 60_000);
    await withTx(db, (tx) => recordSedationVitals(tx, nurse, s.studyId, { bpSystolic: 118, bpDiastolic: 74, heartRate: 92, spo2: 97, rass: -1, drug: "Midazolam 1 mg IV" }, t1));
    const mid = await irCaseView(db, fx.radiographer, s.studyId, t1);
    expect(mid).toMatchObject({ next: "sign_out", sedation: { plan: "moderate", nextDueAt: new Date(t1.getTime() + 5 * 60_000) } });
    expect(mid.sedation.vitals).toHaveLength(1);
    await withTx(db, (tx) => irSignOut(tx, nurse, s.studyId, signOutBody, NOW));
    await send(s.studyId, { doseDap: 40, fluoroSeconds: 600, doseKar: 900 });
    const handoff = {
      vitals: { bpSystolic: 116, bpDiastolic: 72, heartRate: 88, spo2: 98 }, bedRestHours: 4,
      drainCare: "Drain to bag; strict input-output", instructionsEn: "Lie flat for 4 hours. Tell the nurse about bleeding or pain.",
      instructionsHi: "4 घंटे सीधे लेटे रहें। खून या दर्द हो तो नर्स को बताएं।", receivedBy: "Sr Kujur, Ward 3",
    };
    await expect(withTx(db, (tx) => recordHandoff(tx, nurse, s.studyId, handoff, NOW))).rejects.toMatchObject({ code: "ir_checklist_incomplete", detail: { missing: ["procedure_note"] } });
    await withTx(db, (tx) => recordProcedureNote(tx, fx.radiologist, s.studyId, {
      procedure: "Left PCN, 8 Fr locking pigtail", approach: "Posterior, US + fluoroscopy", specimens: "Urine for culture", bloodLossMl: 10,
    }, NOW));
    expect((await irCaseList(db, fx.radiographer, NOW)).map((r) => [r.studyId, r.next])).toEqual([[s.studyId, "handoff"]]);
    await withTx(db, (tx) => recordHandoff(tx, nurse, s.studyId, handoff, NOW));
    await expect(withTx(db, (tx) => recordHandoff(tx, nurse, s.studyId, handoff, NOW))).rejects.toMatchObject({ code: "ir_handoff_recorded" });
    const done = await irCaseView(db, fx.radiographer, s.studyId, NOW);
    expect(done).toMatchObject({ next: "done", sedation: { nextDueAt: null }, dose: { karMgy: 900, levels: [] } });
    expect(await irCaseList(db, fx.radiographer, NOW)).toEqual([]);
  });

  /* ═════════════════════ T2 — Ka,r and the skin-dose triggers ═════════════════════ */

  it("T2: Ka,r goes to the study and the dose register through Send; under 3 Gy raises nothing", async () => {
    const s = await arrive("CT-HEAD", "ct");
    await through(s.studyId, "CT-HEAD");
    await withTx(db, (tx) => irSignOut(tx, nurse, s.studyId, signOutBody, NOW));
    await send(s.studyId, { doseDap: 55.5, fluoroSeconds: 840, doseKar: 2999 });
    const [st] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect(st!.doseKar).toBe("2999.000");
    const [reg] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, s.studyId));
    expect(reg).toMatchObject({ doseKar: "2999.000", doseDap: "55.500", fluoroSeconds: 840 });
    expect(await db.select().from(events).where(eq(events.name, "imaging.ir_skin_dose_alert"))).toHaveLength(0);
  });

  it("T2: Ka,r ≥ 3 Gy refuses Send until the skin follow-up is documented, then raises skin_followup; ≥ 5 Gy also the SRDL", async () => {
    const a = await arrive("CT-HEAD", "ct");
    await through(a.studyId, "CT-HEAD");
    await withTx(db, (tx) => irSignOut(tx, nurse, a.studyId, signOutBody, NOW));
    await expect(send(a.studyId, { doseDap: 180, fluoroSeconds: 2400, doseKar: 3200 })).rejects.toMatchObject({ code: "skin_followup_required" });
    await expect(withTx(db, (tx) => recordSkinFollowUp(tx, nurse, a.studyId, { patientInformed: true, followUpOn: "2026-09-03" }, NOW)))
      .rejects.toMatchObject({ code: "invalid_date" });
    await withTx(db, (tx) => recordSkinFollowUp(tx, nurse, a.studyId, { patientInformed: true, followUpOn: "2026-09-21", note: "Skin over the right flank" }, NOW));
    await send(a.studyId, { doseDap: 180, fluoroSeconds: 2400, doseKar: 3200 });
    const one = await db.select().from(events).where(eq(events.name, "imaging.ir_skin_dose_alert"));
    expect(one.map((e) => (e.payload as { level: string }).level)).toEqual(["skin_followup"]);

    const b = await arrive("CT-HEAD", "ct");
    await through(b.studyId, "CT-HEAD");
    await withTx(db, (tx) => irSignOut(tx, nurse, b.studyId, signOutBody, NOW));
    await withTx(db, (tx) => recordSkinFollowUp(tx, nurse, b.studyId, { patientInformed: true, followUpOn: "2026-09-28" }, NOW));
    await send(b.studyId, { doseDap: 320, fluoroSeconds: 3600, doseKar: 5500 });
    const all = await db.select().from(events).where(eq(events.name, "imaging.ir_skin_dose_alert"));
    expect(all.filter((e) => (e.payload as { studyId: string }).studyId === b.studyId).map((e) => e.payload))
      .toEqual([
        { studyId: b.studyId, accessionNo: b.accessionNo, deviceResourceId: fx.devices.ct, level: "skin_followup", thresholdMgy: 3000 },
        { studyId: b.studyId, accessionNo: b.accessionNo, deviceResourceId: fx.devices.ct, level: "substantial_radiation_dose_level", thresholdMgy: 5000 },
      ]);
    expect(skinDoseLevels(2999.9)).toEqual([]);
  });

  it("T2: the dose SR's 113725 Dose (RP) Total is read as Ka,r and converted Gy → mGy", () => {
    const item = (code: string, value: string, unit: string) => ({
      ValueType: "NUM", ConceptNameCodeSequence: [{ CodeValue: code }],
      MeasuredValueSequence: [{ NumericValue: value, MeasurementUnitsCodeSequence: [{ CodeValue: unit }] }],
    });
    const n = parseDoseSr({ tags: {
      SOPInstanceUID: "1.2.3.4.5", StudyInstanceUID: "1.2.3.4", AccessionNumber: "I1",
      ContentTemplateSequence: [{ TemplateIdentifier: "10001" }],
      ContentSequence: [{ ConceptNameCodeSequence: [{ CodeValue: "113702" }], ContentSequence: [
        item("113722", "0.0042", "Gy.m2"), item("113730", "900", "s"), item("113725", "3.25", "Gy"),
      ] }],
    } });
    expect(n).toMatchObject({ dap: 42, fluoroSeconds: 900, kar: 3250 });
  });
});
