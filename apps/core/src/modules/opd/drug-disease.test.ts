import { withTx } from "../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdPrescriptions } from "../../kernel/db/schema";
import { addMedicine, addSalt, adoptDrugDisease } from "../formulary";
import { saveConsultNote, startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { listCodedDiagnoses } from "./diagnosis-history";
import { issuePrescription, precheckPrescription } from "./prescriptions";
import { callNext } from "./queue";
import { checkDrugDisease } from "./rx-checks";
import { recordVitals } from "./vitals";
import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DrugDiseaseRow } from "../formulary";
import type { EncounterRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { CodedDiagnosis } from "./diagnosis-history";
import type { RxCheckLine } from "./rx-checks";

/**
 * ═══ FORMULARY P24 — WHAT THE PATIENT'S DIAGNOSIS FORBIDS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p24-drug-disease.md`.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST000000000001" };
const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB = new Date(Date.UTC(1996, 0, 15));
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("checkDrugDisease — the rule, the code and the calendar (P24)", () => {
  const line = (over: Partial<RxCheckLine> = {}): RxCheckLine => ({
    lineIndex: 0,
    drug: "Tab Ciplar 40",
    resolution: {
      medicineId: "med-1", brandName: "Ciplar 40", routeClass: "systemic",
      salts: [{ saltId: "salt-propranolol", moiety: "propranolol", drugClass: "beta_blocker" }],
    },
    ...over,
  });
  const dx = (code: string, codedOn = "2026-08-01"): CodedDiagnosis =>
    ({ code, text: "Asthma", codedOn, encounterId: "enc-1" });
  const rule = (over: Partial<DrugDiseaseRow> = {}): DrugDiseaseRow => ({
    saltId: "salt-propranolol", icd10Prefix: "J45", icd10Title: "Asthma", severity: "severe",
    note: "Bronchospasm — avoid.", alternatives: [{ moiety: "amlodipine", label: "Amlodipine 5 mg" }],
    routeScope: null, ...over,
  });

  it("fires on a code the prefix reaches, and is silent on one it does not", () => {
    expect(checkDrugDisease([line()], [dx("J45.909")], [rule()], MON)).toHaveLength(1);
    expect(checkDrugDisease([line()], [dx("J44.9")], [rule()], MON)).toEqual([]);
    // The split that matters: an open-angle code must not reach an angle-closure rule.
    const glaucoma = rule({ icd10Prefix: "H40.2", icd10Title: "Primary angle-closure glaucoma" });
    expect(checkDrugDisease([line()], [dx("H40.11")], [glaucoma], MON)).toEqual([]);
    expect(checkDrugDisease([line()], [dx("H40.21")], [glaucoma], MON)).toHaveLength(1);
  });

  it("carries the rule, the diagnosis and its date into the hit", () => {
    const [hit] = checkDrugDisease([line()], [dx("J45.909", "2026-07-02")], [rule()], MON);
    expect(hit).toMatchObject({
      severity: "severe", lineIndex: 0, moiety: "propranolol",
      icd10Prefix: "J45", icd10Title: "Asthma",
      diagnosis: { code: "J45.909", text: "Asthma", codedOn: "2026-07-02" },
      note: "Bronchospasm — avoid.", stale: false,
    });
    expect(hit?.alternatives).toEqual([{ moiety: "amlodipine", label: "Amlodipine 5 mg" }]);
  });

  /**
   * D2. Nothing retires a diagnosis in this system, so a code typed once is on the record for good.
   * A severe rule resting on a code from two years ago becomes a NOTICE — it may inform, it may not
   * refuse — because otherwise one mistyped diagnosis gates that patient's prescriptions for life.
   */
  it("downgrades a rule resting on a diagnosis over a year old, and says why", () => {
    const old = checkDrugDisease([line()], [dx("J45.909", "2025-01-01")], [rule()], MON);
    expect(old[0]).toMatchObject({ severity: "moderate", stale: true });
    const justInside = checkDrugDisease([line()], [dx("J45.909", "2025-09-01")], [rule()], MON);
    expect(justInside[0]).toMatchObject({ severity: "severe", stale: false });
  });

  it("does not apply a systemic_only rule to a topical line, and still applies it when the route is unknown", () => {
    const systemicOnly = rule({ routeScope: "systemic_only" });
    const topical = line({
      resolution: {
        medicineId: "med-2", brandName: "Gel", routeClass: "topical",
        salts: [{ saltId: "salt-propranolol", moiety: "propranolol", drugClass: null }],
      },
    });
    expect(checkDrugDisease([topical], [dx("J45.909")], [systemicOnly], MON)).toEqual([]);
    const unknownRoute = line({
      resolution: {
        medicineId: null, brandName: null, routeClass: null,
        salts: [{ saltId: "salt-propranolol", moiety: "propranolol", drugClass: null }],
      },
    });
    // Suppressing a severe warning on a guess is the wrong direction to guess in.
    expect(checkDrugDisease([unknownRoute], [dx("J45.909")], [systemicOnly], MON)).toHaveLength(1);
  });

  it("says one thing once, however many visits recorded the same disease", () => {
    const threeVisits = [dx("J45.909", "2026-08-01"), dx("J45.0", "2026-05-01"), dx("J45.909", "2026-01-01")];
    expect(checkDrugDisease([line()], threeVisits, [rule()], MON)).toHaveLength(1);
  });

  it("has nothing to say without a diagnosis, a rule, or a resolved line", () => {
    expect(checkDrugDisease([line()], [], [rule()], MON)).toEqual([]);
    expect(checkDrugDisease([line()], [dx("J45.909")], [], MON)).toEqual([]);
    expect(checkDrugDisease([line({ resolution: null })], [dx("J45.909")], [rule()], MON)).toEqual([]);
  });
});

describe("the drug-disease gate, end to end (P24)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let roomId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let patient: Awaited<ReturnType<typeof mkPatient>>;
  let ciplarId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });

    const { saltId: propranolol } = await withTx(db, (tx) =>
      addSalt(tx, PHARMACIST, { name: "propranolol", drugClass: "beta_blocker" }));
    await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "amlodipine" }));
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Ciplar 40", form: "tablet", routeClass: "systemic", salts: [{ saltId: propranolol }],
    }));
    ciplarId = medicineId;
  });

  const adopt = (severity: "severe" | "moderate", prefix = "J45") =>
    withTx(db, (tx) => adoptDrugDisease(tx, PHARMACIST, "owner-resolution-test", [{
      rule: "icd10_contraindications#0", prefix, title: "Asthma", moieties: ["propranolol"],
      severity, note: "A non-selective beta-blocker can trigger severe bronchospasm in asthma.",
      alternatives: [{ moiety: "amlodipine", label: "Amlodipine 5 mg" }],
    }]));

  async function inConsultWith(diagnoses: { text: string; icd10Code: string }[]): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    const { encounter } = await startConsultation(db, dra.actor, opened.encounter.id, MON);
    await saveConsultNote(db, dra.actor, encounter.id, { diagnoses });
    return encounter;
  }

  async function inConsultWithAsthma(): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    const { encounter } = await startConsultation(db, dra.actor, opened.encounter.id, MON);
    await saveConsultNote(db, dra.actor, encounter.id, {
      diagnoses: [{ text: "Bronchial asthma", icd10Code: "J45.909" }],
    });
    return encounter;
  }

  /** The id is passed as the consult screen passes it: a PICKED line, not free text. */
  const rxLines = (): RxLine[] => [{
    drug: "Ciplar 40", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 5,
    instructions: null, noSubstitution: false, medicineId: ciplarId,
  }];

  it("reads back the coded diagnosis the consult recorded, and not an uncoded one", async () => {
    const enc = await inConsultWithAsthma();
    await saveConsultNote(db, dra.actor, enc.id, {
      diagnoses: [{ text: "Bronchial asthma", icd10Code: "J45.909" }, { text: "Backache", icd10Code: null }],
    });
    const coded = await listCodedDiagnoses(db, patient.id);
    expect(coded.map((d) => d.code)).toEqual(["J45.909"]);
    expect(coded[0]).toMatchObject({ text: "Bronchial asthma", encounterId: enc.id });
  });

  it("REFUSES a drug the patient's own diagnosis forbids, and the refusal carries its hits", async () => {
    const enc = await inConsultWithAsthma();
    await adopt("severe");

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rxLines() }, MON))
      .rejects.toMatchObject({ code: "drug_disease_conflict" });

    const pre = await precheckPrescription(db, dra.actor, enc.id, rxLines(), MON);
    expect(pre.drugDisease).toHaveLength(1);
    expect(pre.drugDisease[0]).toMatchObject({
      severity: "severe", moiety: "propranolol", icd10Prefix: "J45",
      diagnosis: { code: "J45.909" },
    });
    expect(pre.drugDisease[0]?.alternatives).toEqual([{ moiety: "amlodipine", label: "Amlodipine 5 mg" }]);
  });

  it("lets a reasoned override through, and KEEPS the reason on the prescription", async () => {
    const enc = await inConsultWithAsthma();
    await adopt("severe");
    const override = {
      lineIndex: 0, moiety: "propranolol", icd10Prefix: "J45",
      reason: "Cardiology advice: essential tremor, asthma quiescent for 6 years, salbutamol to hand.",
    };

    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rxLines(), drugDiseaseOverrides: [override] }, MON);

    const rows = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, issued.prescriptionId));
    expect(rows[0]?.drugDiseaseOverrides).toEqual([override]);
  });

  it("refuses an override that names another ruling, and one with no reason worth the name", async () => {
    const enc = await inConsultWithAsthma();
    await adopt("severe");
    const reason = "Cardiology advice: essential tremor, asthma quiescent for 6 years, salbutamol to hand.";

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: rxLines(), drugDiseaseOverrides: [{ lineIndex: 0, moiety: "propranolol", icd10Prefix: "N18", reason }],
    }, MON)).rejects.toMatchObject({ code: "drug_disease_conflict" });

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: rxLines(), drugDiseaseOverrides: [{ lineIndex: 0, moiety: "propranolol", icd10Prefix: "J45", reason: "ok" }],
    }, MON)).rejects.toMatchObject({ code: "override_reason_required" });
  });

  it("a moderate rule gates nothing and still reaches the screen", async () => {
    const enc = await inConsultWithAsthma();
    await adopt("moderate");

    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rxLines() }, MON);
    expect(issued.prescriptionId).toBeTruthy();

    const pre = await precheckPrescription(db, dra.actor, enc.id, rxLines(), MON);
    expect(pre.drugDisease).toHaveLength(1);
    expect(pre.drugDisease[0]?.severity).toBe("moderate");
  });

  /**
   * ═══ D6, THE WHOLE REASON THE OFFER IS NOT A STRING ═══
   *
   * A patient with heart failure AND asthma. The book's `I50` rule offers carvedilol; its own `J45`
   * rule forbids it. Rendered verbatim, the one-tap switch would hand this patient a critical
   * contraindication in one tap. The offer is re-run against this patient, and only amlodipine
   * survives.
   */
  it("withholds an offer that this patient's OTHER diagnosis forbids", async () => {
    const { saltId: verapamil } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "verapamil" }));
    await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "carvedilol" }));
    const { medicineId: calaptin } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Calaptin 40", form: "tablet", routeClass: "systemic", salts: [{ saltId: verapamil }],
    }));
    await withTx(db, (tx) => adoptDrugDisease(tx, PHARMACIST, "owner-resolution-test", [
      {
        rule: "icd10_contraindications#2", prefix: "I50", title: "Heart failure", moieties: ["verapamil"],
        severity: "severe", note: "Verapamil depresses the failing ventricle.",
        alternatives: [
          { moiety: "carvedilol", label: "Carvedilol 6.25 mg" },
          { moiety: "amlodipine", label: "Amlodipine 5 mg" },
        ],
      },
      {
        rule: "icd10_contraindications#0", prefix: "J45", title: "Asthma", moieties: ["carvedilol"],
        severity: "severe", note: "A non-selective beta-blocker can trigger bronchospasm in asthma.",
      },
    ]));
    const enc = await inConsultWith([
      { text: "Heart failure", icd10Code: "I50.9" },
      { text: "Bronchial asthma", icd10Code: "J45.909" },
    ]);

    const pre = await precheckPrescription(db, dra.actor, enc.id, [{
      drug: "Calaptin 40", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 5,
      instructions: null, noSubstitution: false, medicineId: calaptin,
    }], MON);

    expect(pre.drugDisease).toHaveLength(1);
    expect(pre.drugDisease[0]?.icd10Prefix).toBe("I50");
    // Carvedilol is gone. The alert still says what to do; it just does not offer the danger.
    expect(pre.drugDisease[0]?.alternatives).toEqual([{ moiety: "amlodipine", label: "Amlodipine 5 mg" }]);
  });

  it("says nothing about a diagnosis no rule reaches", async () => {
    const enc = await inConsultWithAsthma();
    await adopt("severe", "N18.4");

    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rxLines() }, MON);
    expect(issued.prescriptionId).toBeTruthy();
    const pre = await precheckPrescription(db, dra.actor, enc.id, rxLines(), MON);
    expect(pre.drugDisease).toEqual([]);
  });
});
