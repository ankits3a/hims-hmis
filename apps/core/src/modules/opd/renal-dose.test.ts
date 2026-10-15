import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { cdsRxLines, formularyGenerics, formularyMedicines, opdPrescriptions } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { signedCreatinine } from "../../../test/helpers/lab-creatinine";
import { addMedicine, addSalt, reviewMonograph, saveMonograph } from "../formulary";
import { registerLabKidneyFunctionReader } from "../lab";
import { backfillCdsRxLines } from "./cds-rx-lines";
import { startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { issuePrescription, precheckPrescription } from "./prescriptions";
import { callNext } from "./queue";
import { checkRenal, EGFR_FRESH_DAYS } from "./rx-checks";
import { recordVitals } from "./vitals";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "./fhir";
import type { RenalRule } from "./rx-checks";
import type { RxCheckLine } from "./rx-checks";

/**
 * #621 — THE RENAL DOSE CHECK, PURE. A line whose drug has a REVIEWED monograph with renal bands is
 * checked against the patient's latest eGFR within 90 days (DECIDED 2026-10-15), and the hit says how
 * old that eGFR is. With no recent eGFR a drug that has a rule raises "no recent kidney function".
 * Every hit is a hard warning: the doctor may prescribe through it with a reason, and never silently.
 */
const NOW = new Date("2030-03-01T06:00:00.000Z");
const at = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);
const line = (medicineId: string | null, lineIndex = 0): RxCheckLine => ({
  lineIndex, drug: "Tab Glycomet 500",
  resolution: medicineId === null ? null : {
    medicineId, brandName: "Glycomet 500", routeClass: "systemic",
    salts: [{ saltId: "salt-metformin", moiety: "metformin", drugClass: null }],
  },
});
const METFORMIN: RenalRule = {
  genericId: "gen-metformin", genericName: "Metformin 500 mg oral tablet",
  bands: [
    { id: "b1", position: 0, crclMin: null, crclMax: 30, dose: "Do not use", severity: "avoid" },
    { id: "b2", position: 1, crclMin: 30, crclMax: 45, dose: "Max 1 g a day; do not start", severity: "reduce" },
    { id: "b3", position: 2, crclMin: 45, crclMax: null, dose: "Usual dose", severity: "normal" },
  ],
};
const rules = new Map([["med-metformin", METFORMIN]]);
const known = (egfr: number, ageDays: number) => ({ computed: true as const, egfr, sampledAt: at(ageDays), ageDays });

describe("#621 checkRenal — a reviewed renal band against the latest eGFR", () => {
  it("raises the band the eGFR falls in, with its dose and how old the eGFR is", () => {
    expect(checkRenal([line("med-metformin")], rules, known(38, 12))).toEqual([{
      lineIndex: 0, genericId: "gen-metformin", genericName: "Metformin 500 mg oral tablet",
      kind: "band", severity: "reduce", dose: "Max 1 g a day; do not start",
      egfr: 38, sampledAt: at(12).toISOString(), ageDays: 12, reason: null,
    }]);
    expect(checkRenal([line("med-metformin")], rules, known(22, 0))[0]).toMatchObject({ severity: "avoid", dose: "Do not use" });
  });

  it("is silent on a normal band, a drug with no reviewed rule, and an unresolved line", () => {
    expect(checkRenal([line("med-metformin")], rules, known(80, 5))).toEqual([]);
    expect(checkRenal([line("med-other")], rules, known(20, 5))).toEqual([]);
    expect(checkRenal([line(null)], rules, known(20, 5))).toEqual([]);
  });

  it("an eGFR older than 90 days is not recent: the drug raises 'no recent kidney function', and says how old the last one is", () => {
    expect(EGFR_FRESH_DAYS).toBe(90);
    expect(checkRenal([line("med-metformin")], rules, known(38, 90))[0]).toMatchObject({ kind: "band", ageDays: 90 });
    expect(checkRenal([line("med-metformin")], rules, known(38, 91))).toEqual([{
      lineIndex: 0, genericId: "gen-metformin", genericName: "Metformin 500 mg oral tablet",
      kind: "no_recent_kidney_function", severity: null, dose: null,
      egfr: null, sampledAt: at(91).toISOString(), ageDays: 91, reason: "stale",
    }]);
  });

  it("with no eGFR at all, or none that can be computed, a drug with a rule says so; a drug without one says nothing", () => {
    expect(checkRenal([line("med-metformin"), line("med-other", 1)], rules, null)).toEqual([expect.objectContaining({
      lineIndex: 0, kind: "no_recent_kidney_function", egfr: null, sampledAt: null, ageDays: null, reason: "no_result",
    })]);
    const child = { computed: false as const, reason: "under_18" as const, sampledAt: at(3), ageDays: 3 };
    expect(checkRenal([line("med-metformin")], rules, child)[0]).toMatchObject({ kind: "no_recent_kidney_function", reason: "under_18", ageDays: 3 });
  });
});

describe("#621 the renal dose gate, end to end", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let roomId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let patientId: string;
  let glycometId: string;
  let plainId: string;
  // A REAL clock: the consult's own routes stamp `now`, and the creatinine is dated against it.
  const now = (): Date => new Date();
  const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
  const WRITER: Actor = { type: "user", id: "01HPHARMWRITER00000000001" };
  const REVIEWER: Actor = { type: "user", id: "01HPHYSREVIEW000000000001" };
  const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
  const SCTID = "325278008";

  let unregister: () => void;
  // The production wire is `LabModule.onModuleInit`; a suite installs the same reader directly.
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unregister = registerLabKidneyFunctionReader(); });
  afterAll(async () => { unregister(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor, { ageYears: undefined, dob: new Date(Date.UTC(1960, 5, 1)) })).id;

    const { saltId: metformin } = await withTx(db, (tx) => addSalt(tx, WRITER, { name: "metformin" }));
    const { saltId: para } = await withTx(db, (tx) => addSalt(tx, WRITER, { name: "paracetamol" }));
    glycometId = (await withTx(db, (tx) => addMedicine(tx, WRITER, {
      brandName: "Glycomet 500", form: "tablet", routeClass: "systemic", salts: [{ saltId: metformin }],
    }))).medicineId;
    plainId = (await withTx(db, (tx) => addMedicine(tx, WRITER, {
      brandName: "Crocin 500", form: "tablet", routeClass: "systemic", salts: [{ saltId: para }],
    }))).medicineId;
    await db.insert(formularyGenerics).values({
      id: newId(), sctid: SCTID, name: "Metformin 500 mg oral tablet", nameNormalized: "metformin 500 mg oral tablet",
      doseForm: "oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09", createdBy: WRITER.id, updatedBy: WRITER.id,
    });
    await db.update(formularyMedicines).set({ genericSctid: SCTID }).where(eq(formularyMedicines.id, glycometId));
  });

  /** A reviewed monograph: written by one person and signed by another — the only kind the check reads. */
  const reviewedBands = async (review = true): Promise<void> => {
    const { monographId } = await withTx(db, (tx) => saveMonograph(tx, WRITER, {
      genericSctid: SCTID, sourceVersion: "1.25",
      renalDoses: [
        { crclMin: null, crclMax: 30, dose: "Do not use", severity: "avoid" },
        { crclMin: 30, crclMax: 45, dose: "Max 1 g a day; do not start", severity: "reduce" },
        { crclMin: 45, crclMax: null, dose: "Usual dose", severity: "normal" },
      ],
    }));
    if (review) await withTx(db, (tx) => reviewMonograph(tx, REVIEWER, monographId));
  };

  const inConsult = async () => {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, now());
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, now());
    await callNext(db, dra.actor, opened.sessionId, now());
    return (await startConsultation(db, dra.actor, opened.encounter.id, now())).encounter;
  };
  const rx = (medicineId: string, drug: string): RxLine[] => [{
    drug, dose: "1 tab", route: "oral", frequency: "BD", durationDays: 30, instructions: null, noSubstitution: false, medicineId,
  }];
  const REASON = "Nephrology reviewed: eGFR stable for 2 years, metformin at 500 mg BD with monthly creatinine.";

  it("REFUSES a drug whose reviewed band the patient's eGFR reaches, shows it on the pre-check, and lets a reasoned override through", async () => {
    await reviewedBands();
    await signedCreatinine(db, patientId, "1.6", daysAgo(12)); // a 66-year-old woman: eGFR in the 30s
    const enc = await inConsult();

    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rx(glycometId, "Glycomet 500") }, now()))
      .rejects.toMatchObject({ code: "renal_conflict" });
    const pre = await precheckPrescription(db, dra.actor, enc.id, rx(glycometId, "Glycomet 500"), now());
    expect(pre.renal).toHaveLength(1);
    expect(pre.renal[0]).toMatchObject({ kind: "band", severity: "reduce", dose: "Max 1 g a day; do not start", ageDays: 12 });
    expect(pre.renal[0]!.egfr).toBeGreaterThanOrEqual(30);

    // A reason too short to be one is refused; one that names the generic and says why is kept.
    const genericId = pre.renal[0]!.genericId;
    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: rx(glycometId, "Glycomet 500"), renalOverrides: [{ lineIndex: 0, genericId, reason: "ok" }],
    }, now())).rejects.toMatchObject({ code: "override_reason_required" });
    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: rx(glycometId, "Glycomet 500"), renalOverrides: [{ lineIndex: 0, genericId, reason: REASON }],
    }, now());
    const row = (await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.id, issued.prescriptionId)))[0]!;
    expect(row.renalOverrides).toEqual([{ lineIndex: 0, genericId, reason: REASON }]);
  });

  it("a renal override counts as an override in the learning copy, at issue and after a backfill re-run alike", async () => {
    await reviewedBands();
    const enc = await inConsult();
    const pre = await precheckPrescription(db, dra.actor, enc.id, rx(glycometId, "Glycomet 500"), now());
    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, {
      lines: rx(glycometId, "Glycomet 500"), renalOverrides: [{ lineIndex: 0, genericId: pre.renal[0]!.genericId, reason: REASON }],
    }, now());
    const flags = async () => (await db.select({ hadOverride: cdsRxLines.hadOverride }).from(cdsRxLines)
      .where(eq(cdsRxLines.prescriptionId, issued.prescriptionId))).map((r) => r.hadOverride);
    expect(await flags()).toEqual([true]);
    await backfillCdsRxLines(db);
    expect(await flags()).toEqual([true]);
  });

  it("with no recent eGFR (none, or over 90 days old) the drug says 'no recent kidney function' and asks for a reason", async () => {
    await reviewedBands();
    const enc = await inConsult();
    const none = await precheckPrescription(db, dra.actor, enc.id, rx(glycometId, "Glycomet 500"), now());
    expect(none.renal).toEqual([expect.objectContaining({ kind: "no_recent_kidney_function", reason: "no_result", ageDays: null })]);
    await expect(issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rx(glycometId, "Glycomet 500") }, now()))
      .rejects.toMatchObject({ code: "renal_conflict" });

    await signedCreatinine(db, patientId, "1.6", daysAgo(120));
    const stale = await precheckPrescription(db, dra.actor, enc.id, rx(glycometId, "Glycomet 500"), now());
    expect(stale.renal).toEqual([expect.objectContaining({ kind: "no_recent_kidney_function", reason: "stale", ageDays: 120 })]);
  });

  it("says nothing for a normal band, an UNREVIEWED monograph, or a drug with no renal rule", async () => {
    await reviewedBands(false); // a draft: nobody has signed it
    await signedCreatinine(db, patientId, "1.6", daysAgo(5));
    const enc = await inConsult();
    expect((await precheckPrescription(db, dra.actor, enc.id, rx(glycometId, "Glycomet 500"), now())).renal).toEqual([]);
    expect((await precheckPrescription(db, dra.actor, enc.id, rx(plainId, "Crocin 500"), now())).renal).toEqual([]);
    await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: rx(plainId, "Crocin 500") }, now());
  });
});
