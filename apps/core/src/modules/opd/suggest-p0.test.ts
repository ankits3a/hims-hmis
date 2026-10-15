import { eq } from "drizzle-orm";
import { bandOf, frequencyOf, newId, parseDose, snapFrequency, withoutDoseForChild, dxKeyOf, doseKey, RX_FREQUENCIES } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "../../../test/helpers/opd";
import { cdsRxLines, formularyMedicineSalts, formularyMedicines, formularySalts, opdEncounterDiagnoses, opdSuggestionEvents } from "../../kernel/db/schema";
import { normalizeDrugName } from "../formulary";
import { bandFor } from "../cds";
import { saveConsultNote, startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { issuePrescription } from "./prescriptions";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import { backfillCdsRxLines } from "./cds-rx-lines";
import { HIDE_AFTER, doctorSuggestionsOn, hiddenSuggestions, recordSignals, setDoctorSuggestions } from "./consult-guards";
import { rxLineBody } from "./opd-queue.controller";
import { FREQUENCIES } from "../../../../../packages/contracts/src/phone-consult";
import type { Db } from "../../kernel/db/client";
import type { EncounterRow } from "./encounters";

const MON = new Date("2026-08-17T04:00:00.000Z");
const adult = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 80, spo2: 98, tempC: 37 };
const line = (over: Record<string, unknown> = {}) => ({
  drug: "Paracetamol 500 mg Tablet", dose: "1 Tab", route: "oral", frequency: "1-0-1 after food", durationDays: 5, instructions: null, noSubstitution: false, ...over,
});

/**
 * DECISION 0050, PHASE P0 — the ground truth becomes countable, and a cross is counted.
 * Owner, 2026-10-07: "start the groundwork (P0) now. implement self-improving system plan."
 */
describe("self-improving suggestions — P0", () => {
  describe("the shared reading rules (pure)", () => {
    it("reads a dose into an amount and a unit, and refuses what is not one dose", () => {
      expect(parseDose("1 tab")).toEqual({ amount: 1, unit: "tab" });
      expect(parseDose("1 Tab")).toEqual({ amount: 1, unit: "tab" });
      expect(parseDose("one tablet")).toEqual({ amount: 1, unit: "tab" });
      expect(parseDose("½ tab")).toEqual({ amount: 0.5, unit: "tab" });
      expect(parseDose("1/2 tab")).toEqual({ amount: 0.5, unit: "tab" });
      expect(parseDose("5ml")).toEqual({ amount: 5, unit: "ml" });
      expect(parseDose("2.5 ml")).toEqual({ amount: 2.5, unit: "ml" });
      expect(parseDose("2 puffs")).toEqual({ amount: 2, unit: "puff" });
      expect(parseDose("10 units")).toEqual({ amount: 10, unit: "unit" });
      expect(parseDose("500 mg")).toEqual({ amount: 500, unit: "mg" });
      // A range, a compound, a bare number, an instruction and a refusal are NOT parsed.
      for (const raw of ["1-2 tab", "5 ml (250 mg)", "1", "apply thin layer", "— dose needs review", "", "0 tab"]) expect(parseDose(raw)).toBeNull();
      expect(doseKey("One Tablet")).toBe("1 tab");
      expect(doseKey("1 tab")).toBe(doseKey("1 Tab"));
    });

    it("keeps one closed frequency set: the desk's typing snaps to it, anything else stays as typed", () => {
      expect(RX_FREQUENCIES).toEqual(["OD", "BD", "TDS", "QID", "HS", "SOS", "STAT"]);
      for (const [typed, code] of [["1-0-1", "BD"], ["bd", "BD"], ["twice daily", "BD"], ["1-1-1", "TDS"], ["thrice daily", "TDS"], ["0-0-1", "HS"], ["sos", "SOS"], ["Stat", "STAT"], ["1-1-1-1", "QID"]] as const) {
        expect(snapFrequency(typed)).toBe(code);
      }
      // The doctor's own sentence is not rewritten, and is counted as `other`.
      expect(snapFrequency("BD for 3 days then OD")).toBe("BD for 3 days then OD");
      expect(snapFrequency("alternate days")).toBe("alternate days");
      expect(frequencyOf("alternate days")).toBe("other");
      expect(frequencyOf("1-0-1 after food")).toBe("BD");
    });

    it("the phone's chips are the same closed set", () => {
      expect([...FREQUENCIES]).toEqual([...RX_FREQUENCIES]);
    });

    it("the screens' band is the server's band", () => {
      for (const p of [{ ageYears: 8, weightKg: null }, { ageYears: 30, weightKg: null }, { ageYears: 30, weightKg: 35 }, { ageYears: 8, weightKg: 45 }, { ageYears: null, weightKg: null }, { ageYears: 12, weightKg: null }]) {
        expect(bandOf(p)).toBe(bandFor({ ...p, allergies: [], allergenClasses: [], pregnant: false }));
      }
    });

    it("NO DOSE FOR A CHILD: a line the system puts forward for a child keeps its medicine and loses dose, frequency and days", () => {
      const lines = [{ drug: "Paracetamol 250 mg/5 ml Syrup", dose: "5 ml", frequency: "TDS", durationDays: 3, medicineId: "m1" }];
      expect(withoutDoseForChild(lines, "pediatric")).toEqual([{ drug: "Paracetamol 250 mg/5 ml Syrup", dose: "", frequency: "", durationDays: null, medicineId: "m1" }]);
      expect(withoutDoseForChild(lines, "adult")).toEqual(lines);
    });

    it("a diagnosis is keyed by its ICD-10 category when coded, by its words when typed", () => {
      expect(dxKeyOf("J06.9", "Acute URTI")).toBe("dx:J06");
      expect(dxKeyOf(null, "  Viral   Fever ")).toBe("tx:viral fever");
      expect(dxKeyOf(null, "")).toBeNull();
    });

    it("the issue route's line names every source the screens write — zod would strip an unnamed one", () => {
      for (const source of ["typed", "search", "suggested", "voice", "set", "repeat", "paper"]) {
        expect(rxLineBody.parse(line({ source })).source).toBe(source);
      }
      expect(() => rxLineBody.parse(line({ source: "guessed" }))).toThrow();
    });
  });

  describe("against the tables", () => {
    let db: Db;
    let teardown: () => Promise<void>;
    let deptId: string;
    let dra: Awaited<ReturnType<typeof mkDoctor>>;
    let drb: Awaited<ReturnType<typeof mkDoctor>>;
    let clerk: Awaited<ReturnType<typeof mkUser>>;
    let vd: Awaited<ReturnType<typeof mkUser>>;

    beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
    afterAll(async () => { await teardown(); });
    beforeEach(async () => {
      await truncateAll(db);
      await seedOpdBase(db);
      await activateOpdVisitDefinition(db);
      let roomId: string; let room2Id: string;
      ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
      dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
      drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
      clerk = await mkUser(db, "clerk", ["front_office"]);
      vd = await mkUser(db, "vd", ["vitals_desk"]);
    });

    async function inConsult(over: { ageYears?: number; weightKg?: number; phone?: string } = {}): Promise<EncounterRow> {
      const ageYears = over.ageYears ?? 30;
      const patient = await mkPatient(db, clerk.actor, {
        ageYears, phone: over.phone ?? "9876543210",
        ...(ageYears < 18 ? { guardian: { name: "Sunita Devi", relationship: "mother" as const } } : {}),
      });
      const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
      await recordVitals(db, vd.actor, opened.encounter.id, { ...adult, weightKg: over.weightKg ?? 60, ...(ageYears < 12 ? { heightCm: 115, muacCm: 15 } : {}) }, MON);
      await callNext(db, dra.actor, opened.sessionId, MON);
      return (await startConsultation(db, dra.actor, opened.encounter.id, MON)).encounter;
    }

    async function medicine(brand: string, over: { aware?: "Access" | "Watch" | "Reserve"; scheduleFlag?: "H" | "H1" | "X" } = {}): Promise<{ id: string; saltId: string }> {
      const id = newId(); const saltId = newId();
      await db.insert(formularyMedicines).values({
        id, brandName: brand, nameNormalized: normalizeDrugName(brand), form: "tablet", strengthLabel: null,
        scheduleFlag: over.scheduleFlag ?? null, awareCategory: over.aware ?? null, createdBy: "t", updatedBy: "t",
      } as never);
      await db.insert(formularySalts).values({ id: saltId, name: `salt-${saltId}`, nameNormalized: `salt-${saltId}`, createdBy: "t", updatedBy: "t" } as never);
      await db.insert(formularyMedicineSalts).values({ medicineId: id, saltId, source: "curated" } as never);
      return { id, saltId };
    }

    it("an issued line is written, in the issue itself, in the shape counting needs — and the prescription keeps the doctor's words", async () => {
      const enc = await inConsult();
      const azi = await medicine("Azithromycin 500 mg Tablet", { aware: "Watch", scheduleFlag: "H" });
      await saveConsultNote(db, dra.actor, enc.id, { chiefComplaint: "fever", diagnoses: [{ text: "Acute upper respiratory infection", icd10Code: "J06.9", source: "suggested" }] }, MON);
      const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [
        line({ source: "set" }),
        line({ drug: "Azithromycin 500 mg Tablet", medicineId: azi.id, dose: "one tablet", frequency: "once daily", durationDays: 3, source: "search" }),
        line({ drug: "Cough linctus", dose: "1-2 tsp", frequency: "alternate nights", durationDays: null }),
      ] }, MON);

      const rows = await db.select().from(cdsRxLines).where(eq(cdsRxLines.prescriptionId, issued.prescriptionId)).orderBy(cdsRxLines.lineIndex);
      expect(rows.map((r) => [r.lineIndex, r.doseRaw, r.doseAmount, r.doseUnit, r.frequencyRaw, r.frequency, r.durationDays])).toEqual([
        [0, "1 Tab", 1, "tab", "1-0-1 after food", "BD", 5],
        [1, "one tablet", 1, "tab", "once daily", "OD", 3],
        [2, "1-2 tsp", null, null, "alternate nights", "other", null],
      ]);
      expect(rows.map((r) => [r.source, r.fromSuggestion])).toEqual([["set", true], ["search", false], [null, false]]);
      expect(rows[0]).toMatchObject({ doctorId: dra.doctorId, departmentId: deptId, encounterId: enc.id, dxKey: "dx:J06", band: "adult", transcribed: false, hadOverride: false, drugKey: "paracetamol 500 mg tablet" });
      expect(rows[1]).toMatchObject({ medicineId: azi.id, moietySet: azi.saltId, awareCategory: "Watch", scheduleFlag: "H" });
      // The table carries a visit, never a person.
      expect(Object.keys(rows[0]!)).not.toContain("patientId");
      // The diagnosis says where it came from, and a later save that does not say keeps it.
      const dx = () => db.select({ source: opdEncounterDiagnoses.source }).from(opdEncounterDiagnoses).where(eq(opdEncounterDiagnoses.encounterId, enc.id));
      expect(await dx()).toEqual([{ source: "suggested" }]);
      await saveConsultNote(db, dra.actor, enc.id, { diagnoses: [{ text: "Acute upper respiratory infection", icd10Code: "J06.9" }] }, MON);
      expect(await dx()).toEqual([{ source: "suggested" }]);
      // …and neither can a screen that, after a reload, only knows the tag has a code.
      await saveConsultNote(db, dra.actor, enc.id, { diagnoses: [{ text: "Acute upper respiratory infection", icd10Code: "J06.9", source: "search" }, { text: "Anaemia", icd10Code: null, source: "typed" }] }, MON);
      expect((await dx()).map((d) => d.source).sort()).toEqual(["suggested", "typed"]);
    });

    it("a re-issue REPLACES the visit's rows (a superseded version is not counted twice), and the backfill is idempotent and reports what did not parse", async () => {
      const enc = await inConsult();
      await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [line(), line({ drug: "B" })] }, MON);
      const second = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [line({ dose: "apply thin layer", frequency: "at night" })] }, new Date(MON.getTime() + 60_000));
      const now = await db.select().from(cdsRxLines);
      expect(now.map((r) => r.prescriptionId)).toEqual([second.prescriptionId]);

      await db.delete(cdsRxLines);
      const first = await backfillCdsRxLines(db);
      expect(first).toMatchObject({ prescriptions: 1, lines: 1, doseParsed: 0, doseUnparsed: 1, frequencyOther: 0, unparsedDoses: [{ dose: "apply thin layer", times: 1 }] });
      const again = await backfillCdsRxLines(db);
      expect(again).toEqual(first);
      expect(await db.select().from(cdsRxLines)).toHaveLength(1);
    });

    it("a child's line is banded paediatric from the charted weight", async () => {
      const enc = await inConsult({ ageYears: 6, weightKg: 18, phone: "9876500011" });
      await issuePrescription(db, dra.actor, testCfg, enc.id, { lines: [line({ dose: "5 ml" })] }, MON);
      expect((await db.select({ band: cdsRxLines.band }).from(cdsRxLines))[0]).toEqual({ band: "pediatric" });
    });

    it("a suggestion event carries WHICH suggestion, on WHICH visit — doctor and department read from the visit, and no patient", async () => {
      const enc = await inConsult();
      await recordSignals(db, dra.actor, { misses: [], suggestions: [
        { kind: "diagnosis", source: "suggested", outcome: "shown", surface: "consult_web", encounterId: enc.id, contextKey: "cc:fever", items: ["J06", "B34"], batchId: "b1" },
        { kind: "diagnosis", source: "suggested", outcome: "dismissed", surface: "consult_web", encounterId: enc.id, contextKey: "cc:fever", itemKey: "B34", rankShown: 1, batchId: "b1" },
        { kind: "medicine", source: "voice", outcome: "accepted" }, // the 0.12.0 phone's three fields are still a whole event
      ] }, MON);
      const rows = await db.select().from(opdSuggestionEvents).orderBy(opdSuggestionEvents.outcome);
      expect(rows).toHaveLength(3);
      const cross = rows.find((r) => r.outcome === "dismissed")!;
      expect(cross).toMatchObject({ userId: dra.actor.id, doctorId: dra.doctorId, departmentId: deptId, encounterId: enc.id, contextKey: "cc:fever", itemKey: "b34", rankShown: 1, batchId: "b1", surface: "consult_web" });
      expect(rows.find((r) => r.outcome === "shown")!.items).toEqual(["j06", "b34"]);
      expect(Object.keys(cross)).not.toContain("patientId");
    });

    it("HIDE AFTER THREE CROSSES: two do not hide, the third does, a tap or typing it brings it back, age lets it return, and it is this doctor's alone", async () => {
      const cross = { kind: "test" as const, source: "suggested" as const, outcome: "dismissed" as const, surface: "consult_web" as const, contextKey: "dx:J06", itemKey: "CRP" };
      const at = (days: number) => new Date(MON.getTime() - days * 24 * 3600 * 1000);
      expect(HIDE_AFTER).toBe(3);
      await recordSignals(db, dra.actor, { misses: [], suggestions: [cross, cross] }, at(1));
      expect(await hiddenSuggestions(db, dra.actor.id, MON)).toEqual([]);
      // Chips shown and not tapped are NOT crosses.
      await recordSignals(db, dra.actor, { misses: [], suggestions: [{ ...cross, outcome: "shown", items: ["CRP"] }, { ...cross, outcome: "shown", items: ["CRP"] }] }, at(1));
      expect(await hiddenSuggestions(db, dra.actor.id, MON)).toEqual([]);
      await recordSignals(db, dra.actor, { misses: [], suggestions: [cross] }, at(0));
      expect(await hiddenSuggestions(db, dra.actor.id, MON)).toEqual([{ kind: "test", contextKey: "dx:j06", itemKey: "crp" }]);
      expect(await hiddenSuggestions(db, drb.actor.id, MON)).toEqual([]);
      // A cross counts for ninety days: once the oldest has aged out, the item returns by itself.
      expect(await hiddenSuggestions(db, dra.actor.id, new Date(MON.getTime() + 60 * 24 * 3600 * 1000))).toHaveLength(1);
      expect(await hiddenSuggestions(db, dra.actor.id, new Date(MON.getTime() + 89.5 * 24 * 3600 * 1000))).toEqual([]);
      // Typing it by hand un-hides it at once.
      await recordSignals(db, dra.actor, { misses: [], suggestions: [{ ...cross, source: "typed", outcome: "manual" }] }, new Date(MON.getTime() + 1000));
      expect(await hiddenSuggestions(db, dra.actor.id, new Date(MON.getTime() + 2000))).toEqual([]);
    });

    it("each doctor's own switch is ON until that doctor turns it off, and is theirs alone", async () => {
      expect(await doctorSuggestionsOn(db, dra.actor.id)).toBe(true);
      await setDoctorSuggestions(db, dra.actor, false, MON);
      expect(await doctorSuggestionsOn(db, dra.actor.id)).toBe(false);
      expect(await doctorSuggestionsOn(db, drb.actor.id)).toBe(true);
      await setDoctorSuggestions(db, dra.actor, true, MON);
      expect(await doctorSuggestionsOn(db, dra.actor.id)).toBe(true);
    });
  });
});
