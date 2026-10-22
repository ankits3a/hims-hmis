import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { grantLabResultPermissions, seedLabDeskBase } from "../../../../test/helpers/lab";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { loadConfig } from "../../../kernel/config";
import { withTx } from "../../../kernel/db/client";
import {
  events, labAnalytes, labCriticalCalls, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges,
  labResults, labSlipScans, patients, phiAccessLog, services,
} from "../../../kernel/db/schema";
import { DocumentStoreError } from "../../../kernel/documents/store";
import { quickReportHtml } from "../../../../../../packages/contracts/src/lab-report-html";
import { LAB_CATALOGUE_STANDARD_DATA } from "../../../../scripts/data/lab-catalogue-standard";
import { LAB_INSTRUMENTS_MANAGE, mapInstrumentCode, registerInstrument } from "../instruments";
import { getQuickReport, saveQuickResults } from "../quick";
import { SLIP_JSON_SCHEMA, slipReaderFromConfig } from "../slip-reader";
import {
  attachSlip, detachSlip, discardSlip, getSlipScan, readSlipImage, resolveSlipRow, scanSlip, setSlipIgnoredCode, SlipError,
  sweepLabSlips,
} from "../slips";
import { loadSlipEvalSet, productionGate, renderSlipPng, scoreSlipEval, SLIP_EVAL_DIR } from "../slip-eval";
import type { Actor } from "@hmis/contracts";
import type { LabDeskFixture } from "../../../../test/helpers/lab";
import type { Db } from "../../../kernel/db/client";
import type { DocumentStore } from "../../../kernel/documents/store";
import type { SlipReader } from "../slip-reader";

/**
 * SPEC #934 — SCAN THE ANALYSER'S PRINTED SLIP INTO THE QUICK LAB REPORT (docs/specs/934-lab-slip-scan.md).
 * One block per "Done means" id, D1–D11 and D13 (D12 is the phone's: apps/mobile/__tests__/acceptance).
 * The provider is a stub everywhere except D9, which drives the real request builder against a
 * recording `fetch`. Every slip here is synthetic and every name made up.
 */
jest.setTimeout(60_000);

const NOW = new Date("2026-10-21T06:00:00Z");
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

type Row = { code: string; value: string | null; unit: string | null; flag: "H" | "L" | null; legible: "clear" | "unsure" | "unreadable" };
const r = (code: string, value: string | null, unit: string | null, flag: "H" | "L" | null = null, legible: Row["legible"] = "clear"): Row =>
  ({ code, value, unit, flag, legible });

/** A 3-part haematology slip, internally consistent: indices agree, the differential sums to 100. */
const CBC3: Row[] = [
  r("WBC", "3.63", "10^9/L", "L"),
  r("Lym%", "30.1", "%"), r("Gran%", "60.2", "%"), r("Mid%", "9.7", "%"),
  r("Lym#", "1.09", "10^9/L"), r("Gran#", "2.19", "10^9/L"), r("Mid#", "0.35", "10^9/L"),
  r("RBC", "3.90", "10^12/L"), r("HGB", "10.6", "g/dL", "L"), r("HCT", "33.0", "%"),
  r("MCV", "84.6", "fL"), r("MCH", "27.2", "pg"), r("MCHC", "32.1", "g/dL"),
  r("RDW-CV", "13.5", "%"), r("RDW-SD", "42.1", "fL"),
  r("PLT", "127", "10^9/L", "L"), r("MPV", "9.8", "fL"),
  r("PDW", "16.1", null), r("PCT", "0.124", "%"), r("P-LCR", "28.3", "%"), r("P-LCC", "36", "10^9/L"),
];
const withRow = (rows: Row[], code: string, patch: Partial<Row>): Row[] => rows.map((x) => (x.code === code ? { ...x, ...patch } : x));

type Header = { name: string | null; patientId: string | null; sampleId: string | null; gender: string | null; age: string | null; printedAt: string | null };
const slip = (header: Partial<Header>, rows: Row[] = CBC3) => ({
  slipKind: "analyser_result" as const, analyserText: "HAEM-3 synthetic",
  header: { name: null, patientId: null, sampleId: null, gender: null, age: null, printedAt: null, ...header }, rows,
});

/** The slip's JPEG: a real SOI marker and a tag, so every test's bytes (and sha256) differ. */
const jpeg = (tag: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic-slip:${tag}`)]);

function memoryStore(): DocumentStore & { bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  return {
    bytes,
    put: async (k, b) => { bytes.set(k, b); },
    get: async (k) => { const b = bytes.get(k); if (b === undefined) throw new DocumentStoreError("not_found", k); return b; },
    remove: async (k) => { bytes.delete(k); },
  };
}

function stubReader(reply: unknown): { reader: SlipReader; calls: { analyserName: string }[] } {
  const calls: { analyserName: string }[] = [];
  return {
    calls,
    reader: {
      provider: "gemini", model: "gemini-stub-001",
      async read(input) { calls.push({ analyserName: input.analyserName }); return { text: JSON.stringify(reply), raw: { stub: true }, tokensIn: 900, tokensOut: 300 }; },
    },
  };
}

/** Our analytes, as the 3-part analyser's report needs them (the 0x… units of the standard catalogue). */
const ANALYTES: { code: string; nameEn: string; unit: string | null; resultType?: string; formula?: string; absurdLow?: string; absurdHigh?: string; criticalLow?: string }[] = [
  { code: "HB", nameEn: "Haemoglobin", unit: "g/dL", absurdLow: "1", absurdHigh: "25", criticalLow: "11" },
  { code: "RBC", nameEn: "RBC count", unit: "10^6/uL" }, { code: "HCT", nameEn: "Haematocrit", unit: "%" },
  { code: "MCV", nameEn: "MCV", unit: "fL" }, { code: "MCH", nameEn: "MCH", unit: "pg" }, { code: "MCHC", nameEn: "MCHC", unit: "g/dL" },
  { code: "RDW", nameEn: "RDW-CV", unit: "%" }, { code: "RDW_SD", nameEn: "RDW-SD", unit: "fL" },
  { code: "WBC", nameEn: "Total leucocyte count", unit: "10^3/uL", absurdLow: "0.1", absurdHigh: "200" },
  { code: "NEUT", nameEn: "Neutrophils", unit: "%" }, { code: "LYMPH", nameEn: "Lymphocytes", unit: "%" },
  { code: "MONO", nameEn: "Monocytes", unit: "%" }, { code: "EOS", nameEn: "Eosinophils", unit: "%" }, { code: "BASO", nameEn: "Basophils", unit: "%" },
  { code: "GRAN", nameEn: "Granulocytes %", unit: "%" }, { code: "MID", nameEn: "Mid cells %", unit: "%" },
  { code: "ANC", nameEn: "Absolute neutrophil count", unit: "10^3/uL", resultType: "formula", formula: "WBC * NEUT / 100" },
  { code: "LYMPH_ABS", nameEn: "Absolute lymphocyte count", unit: "10^3/uL", resultType: "formula", formula: "WBC * LYMPH / 100" },
  { code: "GRAN_ABS", nameEn: "Granulocytes, absolute", unit: "10^3/uL", resultType: "formula", formula: "WBC * GRAN / 100" },
  { code: "MID_ABS", nameEn: "Mid cells, absolute", unit: "10^3/uL", resultType: "formula", formula: "WBC * MID / 100" },
  { code: "PLT", nameEn: "Platelet count", unit: "10^3/uL", absurdLow: "1", absurdHigh: "3000" }, { code: "MPV", nameEn: "MPV", unit: "fL" },
  { code: "PCT", nameEn: "Procalcitonin", unit: "ng/mL" },
];
const HAEM3_CODES = ["HB", "RBC", "HCT", "MCV", "MCH", "MCHC", "RDW", "RDW_SD", "WBC", "NEUT", "LYMPH", "MONO", "EOS", "BASO", "GRAN", "MID",
  "ANC", "LYMPH_ABS", "GRAN_ABS", "MID_ABS", "PLT", "MPV"];
/** The 3-part map the spec seeds (slip code, our analyte, slip unit). */
const MAP3: [string, string, string][] = [
  ["WBC", "WBC", "10^9/L"], ["Lym%", "LYMPH", "%"], ["Lym#", "LYMPH_ABS", "10^9/L"], ["Gran%", "GRAN", "%"], ["Gran#", "GRAN_ABS", "10^9/L"],
  ["Mid%", "MID", "%"], ["Mid#", "MID_ABS", "10^9/L"], ["RBC", "RBC", "10^12/L"], ["HGB", "HB", "g/dL"], ["HCT", "HCT", "%"],
  ["MCV", "MCV", "fL"], ["MCH", "MCH", "pg"], ["MCHC", "MCHC", "g/dL"], ["RDW-CV", "RDW", "%"], ["RDW-SD", "RDW_SD", "fL"],
  ["PLT", "PLT", "10^9/L"], ["MPV", "MPV", "fL"],
];
const IGNORED = ["PDW", "PCT", "P-LCR", "P-LCC"];

describe("spec #934 — lab slip scan", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let store: ReturnType<typeof memoryStore>;
  let bench: Actor;
  let instrumentId: string;
  let haem3: string;
  let procal: string;
  const analyteId = new Map<string, string>();
  let sunita: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  afterEach(() => { fx.unregister(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", LAB_INSTRUMENTS_MANAGE);
    bench = fx.bench.actor;
    store = memoryStore();

    // Made-up people: Ram Kumar (male, 36 on NOW), Ram Kumar Yadav (male, 66), Sunita Sharma (female, 42).
    await db.update(patients).set({ dob: new Date("1990-03-01T00:00:00Z") }).where(eq(patients.id, fx.patientId));
    await db.update(patients).set({ dob: new Date("1960-05-05T00:00:00Z") }).where(eq(patients.id, fx.otherPatientId));
    sunita = newId();
    await db.insert(patients).values({
      id: sunita, uhid: "HMS-00000104-1", name: "Sunita Sharma", sex: "female", administrativeGender: "female",
      dob: new Date("1984-02-02T00:00:00Z"), createdBy: "t", updatedBy: "t",
    });

    for (const a of ANALYTES) {
      const [had] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, a.code));
      const fields = {
        nameEn: a.nameEn, unit: a.unit, resultType: a.resultType ?? "numeric", decimals: 2, formula: a.formula ?? null, formulaGuard: null,
        absurdLow: a.absurdLow ?? null, absurdHigh: a.absurdHigh ?? null, criticalLow: a.criticalLow ?? null, criticalHigh: null,
      };
      if (had) { await db.update(labAnalytes).set(fields).where(eq(labAnalytes.id, had.id)); analyteId.set(a.code, had.id); continue; }
      const id = newId();
      await db.insert(labAnalytes).values({ id, code: a.code, ...fields, createdBy: "t", updatedBy: "t" });
      analyteId.set(a.code, id);
    }
    const ids = [...analyteId.values()];
    for (const id of ids) await db.delete(labReferenceRanges).where(eq(labReferenceRanges.analyteId, id));
    const band = { ageMinDays: 0, ageMaxDays: 40000, source: "test", effectiveFrom: "2026-01-01", createdBy: "t" };
    await db.insert(labReferenceRanges).values([
      { id: newId(), analyteId: analyteId.get("HB")!, sex: "male", low: "13", high: "17", ...band },
      { id: newId(), analyteId: analyteId.get("HB")!, sex: "female", low: "12", high: "15", ...band },
      { id: newId(), analyteId: analyteId.get("WBC")!, sex: "any", low: "4", high: "11", ...band },
      { id: newId(), analyteId: analyteId.get("PLT")!, sex: "any", low: "150", high: "410", ...band },
    ]);

    haem3 = newId();
    procal = newId();
    await db.insert(services).values([
      { id: haem3, code: "HAEM3", name: "Complete blood count (3-part)", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: procal, code: "PROCAL", name: "Procalcitonin", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(labOrderables).values([
      { serviceId: haem3, code: "HAEM3", nameEn: "Complete blood count (3-part)", discipline: "haematology", specimenType: "whole_blood", container: "edta", tatMinutesRoutine: 240, createdBy: "t", updatedBy: "t" },
      { serviceId: procal, code: "PROCAL", nameEn: "Procalcitonin", discipline: "biochemistry", specimenType: "serum", container: "sst", tatMinutesRoutine: 240, createdBy: "t", updatedBy: "t" },
    ]);
    await db.insert(labOrderableAnalytes).values([
      ...HAEM3_CODES.map((c, i) => ({ serviceId: haem3, analyteId: analyteId.get(c)!, position: i + 1 })),
      { serviceId: procal, analyteId: analyteId.get("PCT")!, position: 1 },
    ]);

    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, { code: "ANL-HAEM-3", name: "Haematology 3-part", sampleIdMode: "typed_id" }));
    for (const [code, ours, unit] of MAP3) {
      await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId, instrumentCode: code, analyteId: analyteId.get(ours)!, unit });
    }
    for (const code of IGNORED) {
      await setSlipIgnoredCode(db, fx.pathologist.actor, { instrumentId, code, reason: "platelet index the report does not carry (owner 2026-10-21)" });
    }
  });

  const TESTS = () => [{ serviceId: haem3, code: "HAEM3", nameEn: "Complete blood count (3-part)" }];
  async function openReport(patientId: string, o: { sampleNo?: string | null; status?: "waiting" | "draft" | "reported"; collectedAt?: Date; handedOver?: boolean } = {}): Promise<string> {
    const id = newId();
    const status = o.status ?? (o.handedOver === true ? "reported" : "waiting");
    await db.insert(labQuickReports).values({
      id, patientId, encounterNo: null, sampleNo: o.sampleNo ?? null, tests: TESTS(), status,
      collectedAt: o.collectedAt ?? minutesAgo(60), collectedBy: fx.desk.id, updatedBy: fx.desk.id, createdAt: o.collectedAt ?? minutesAgo(60),
      ...(status === "reported" ? { reportedAt: minutesAgo(30), reportedBy: fx.bench.id } : {}),
      ...(o.handedOver === true ? { handedOverAt: minutesAgo(10), handedOverBy: fx.desk.id } : {}),
    });
    return id;
  }

  const scan = (reply: unknown, o: { tag?: string; quickReportId?: string; reader?: SlipReader | null; instrument?: string; source?: "camera" | "gallery" } = {}) =>
    scanSlip(db, { store, reader: o.reader === undefined ? stubReader(reply).reader : o.reader }, bench, {
      image: jpeg(o.tag ?? JSON.stringify(reply)), mimeType: "image/jpeg", source: o.source ?? "camera",
      instrumentId: o.instrument ?? instrumentId, quickReportId: o.quickReportId ?? null,
    }, NOW);

  const lineOf = async (reportId: string, code: string) => (await getQuickReport(db, bench, reportId)).lines.find((l) => l.code === code);
  const formLines = async (reportId: string) => (await getQuickReport(db, bench, reportId)).lines
    .filter((l) => ANALYTES.find((a) => a.code === l.code)?.resultType !== "formula").map((l) => ({ analyteId: l.analyteId, value: l.value }));
  const RAM = { name: "RAM KUMAR", gender: "Male", age: "36Y" };

  /* ─────────────────────────────────────────── D1 ─────────────────────────────────────────── */
  describe("spec #934 D1 — a slip naming an open report's sample number fills it as a draft", () => {
    it("attaches by sample number, resolves ranges and flags, never reports, writes no lab_results and opens no critical call", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210007" });
      const bystander = await openReport(fx.otherPatientId, { sampleNo: "S2610210008" });
      const v = await scan(slip({ ...RAM, patientId: "S2610210007", sampleId: "0023" }));
      expect(v.status).toBe("attached");
      expect(v.attached).toMatchObject({ quickReportId: target, matchKind: "sample_no" });

      const rep = await getQuickReport(db, bench, target);
      expect(rep.status).toBe("draft");
      expect(rep.reportedAt).toBeNull();
      const by = new Map(rep.lines.map((l) => [l.code, l]));
      expect(by.get("HB")).toMatchObject({ value: "10.6", flag: "LL", low: expect.any(String), high: expect.any(String) });
      expect(by.get("WBC")).toMatchObject({ value: "3.63", flag: "L" });
      expect(by.get("PLT")).toMatchObject({ value: "127", flag: "L" });
      expect(by.get("GRAN")).toMatchObject({ value: "60.2" });

      expect((await getQuickReport(db, bench, bystander)).status).toBe("waiting");
      expect(await db.select().from(labResults)).toEqual([]);
      expect(await db.select().from(labCriticalCalls)).toEqual([]);
      const [row] = await db.select().from(labQuickReports).where(eq(labQuickReports.id, target));
      expect(row!.status).toBe("draft");
    });
  });

  /* ─────────────────────────────────────────── D2 ─────────────────────────────────────────── */
  describe("spec #934 D2 — a slip naming a UHID", () => {
    it("fills the patient's single open quick CBC", async () => {
      const only = await openReport(fx.patientId, { sampleNo: "S2610210011" });
      const v = await scan(slip({ ...RAM, patientId: "HMS 00000101 7" }));
      expect(v.status).toBe("attached");
      expect(v.attached).toMatchObject({ quickReportId: only, matchKind: "uhid" });
      expect((await getQuickReport(db, bench, only)).status).toBe("draft");
    });

    it("a merged record's UHID resolves to the surviving patient", async () => {
      const only = await openReport(fx.patientId);
      const v = await scan(slip({ ...RAM, patientId: "HMS-00000102-5" }));
      expect(v.attached).toMatchObject({ quickReportId: only, matchKind: "uhid" });
    });

    it("with two open reports nothing is attached and staff pick between them", async () => {
      const a = await openReport(fx.patientId, { collectedAt: minutesAgo(90) });
      const b = await openReport(fx.patientId, { collectedAt: minutesAgo(30) });
      const v = await scan(slip({ ...RAM, patientId: "HMS-00000101-7" }));
      expect(v.status).toBe("waiting");
      expect(v.attached).toBeNull();
      expect(v.candidates.map((c) => c.quickReportId).sort()).toEqual([a, b].sort());
      for (const id of [a, b]) {
        const rep = await getQuickReport(db, bench, id);
        expect([rep.status, rep.lines]).toEqual(["waiting", []]);
      }
    });
  });

  /* ─────────────────────────────────────────── D3 ─────────────────────────────────────────── */
  describe("spec #934 D3 — no usable ID: candidates, and only a person attaches", () => {
    it("lists the window's open reports with chips, never a reported or handed-over one; a counter 0023 matches nothing", async () => {
      const ram = await openReport(fx.patientId, { sampleNo: "S2610210031" });
      const yadav = await openReport(fx.otherPatientId, { sampleNo: "0023" });
      const sun = await openReport(sunita, { status: "draft" });
      const reported = await openReport(fx.patientId, { status: "reported" });
      const handed = await openReport(sunita, { handedOver: true });
      const old = await openReport(fx.patientId, { collectedAt: daysAgo(3) });

      const v = await scan(slip({ ...RAM, patientId: null, sampleId: "0023" }));
      expect(v.status).toBe("waiting");
      expect(v.attached).toBeNull();
      const ids = v.candidates.map((c) => c.quickReportId);
      expect(ids.sort()).toEqual([ram, yadav, sun].sort());
      for (const gone of [reported, handed, old]) expect(ids).not.toContain(gone);
      for (const c of v.candidates) expect(Object.keys(c.chips).sort()).toEqual(expect.arrayContaining(["age", "gender", "name"]));
      const chip = (id: string) => v.candidates.find((c) => c.quickReportId === id)!.chips;
      expect(chip(ram)).toMatchObject({ name: "same", age: "same", gender: "same" });
      expect(chip(yadav)).toMatchObject({ name: "close", age: "differs", gender: "same" });
      expect(chip(sun)).toMatchObject({ name: "differs", gender: "differs" });
      // Yadav has two of three (name close, gender same), so nobody is pre-selected.
      expect(v.candidates.filter((c) => c.preselected)).toEqual([]);
      expect((await getQuickReport(db, bench, yadav)).status).toBe("waiting");
    });

    it("attach is refused to a person without lab.results.enter and done by one who holds it", async () => {
      const ram = await openReport(fx.patientId);
      const v = await scan(slip({ ...RAM, sampleId: "0023" }));
      await expect(attachSlip(db, fx.desk.actor, v.id, { quickReportId: ram }, NOW)).rejects.toMatchObject({ code: "not_permitted" });
      expect((await getQuickReport(db, bench, ram)).status).toBe("waiting");
      const done = await attachSlip(db, bench, v.id, { quickReportId: ram }, NOW);
      expect(done.attached).toMatchObject({ quickReportId: ram, matchKind: "staff_pick" });
      expect((await getQuickReport(db, bench, ram)).status).toBe("draft");
    });
  });

  /* ─────────────────────────────────────────── D4 ─────────────────────────────────────────── */
  describe("spec #934 D4 — an exact ID whose printed name, gender or age disagrees waits for a person", () => {
    it.each([
      ["gender", { ...RAM, gender: "F" }, { gender: "differs" }],
      ["age", { ...RAM, age: "60Y" }, { age: "differs" }],
      ["name", { ...RAM, name: "SUNITA SHARMA" }, { name: "differs" }],
    ])("%s differs: not attached; the differing chip is shown", async (what, header, chips) => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210041" });
      const v = await scan(slip({ ...header, patientId: "S2610210041" }), { tag: `d4-${what}` });
      expect(v.status).toBe("waiting");
      expect(v.attached).toBeNull();
      expect(v.differences).toContain(what);
      const c = v.candidates.find((x) => x.quickReportId === target);
      expect(c?.chips).toMatchObject(chips);
      expect((await getQuickReport(db, bench, target)).status).toBe("waiting");
    });
  });

  /* ─────────────────────────────────────────── D5 ─────────────────────────────────────────── */
  describe("spec #934 D5 — checks and the not-placed panel hold Save & Complete", () => {
    it("an unsure HGB and an unmapped row block completion until checked and resolved; then the rows add up", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210051" });
      const rows = [...withRow(CBC3, "HGB", { legible: "unsure" }), r("XYZ", "1.2", "%")];
      const v = await scan(slip({ ...RAM, patientId: "S2610210051" }, rows));
      expect(v.status).toBe("attached");

      const rep = await getQuickReport(db, bench, target);
      expect(rep.lines.find((l) => l.code === "HB")?.slip?.checks).toContain("unsure_read");
      expect(rep.slips).toHaveLength(1);
      expect(rep.slips[0]!.notPlaced.map((x) => [x.code, x.reason])).toEqual([["XYZ", "unmapped"]]);

      const tryComplete = async () => {
        const lines = await formLines(target);
        return withTx(db, (tx) => saveQuickResults(tx, bench, { id: target, lines, summary: "CBC", complete: true }, NOW));
      };
      await expect(tryComplete()).rejects.toMatchObject({ code: "slip_checks_open" });

      const hgb = v.rows.find((x) => x.code === "HGB")!;
      await resolveSlipRow(db, bench, v.id, hgb.position, { action: "checked" }, NOW);
      await expect(tryComplete()).rejects.toMatchObject({ code: "slip_checks_open" });

      const xyz = v.rows.find((x) => x.code === "XYZ")!;
      await expect(resolveSlipRow(db, bench, v.id, xyz.position, { action: "ignore", reason: "" }, NOW)).rejects.toMatchObject({ code: "slip_reason_required" });
      await resolveSlipRow(db, bench, v.id, xyz.position, { action: "ignore", reason: "QC channel, not a result" }, NOW);

      const done = await tryComplete();
      expect(done.status).toBe("reported");
      const after = await getSlipScan(db, bench, v.id, NOW);
      const c = after.counts;
      expect(c.placed + c.crossCheck + c.ignoredBySetting + c.ignored).toBe(rows.length);
      expect(c.notPlaced).toBe(0);
      expect(c.openChecks).toBe(0);
    });
  });

  /* ─────────────────────────────────────────── D6 ─────────────────────────────────────────── */
  describe("spec #934 D6 — the code map is per analyser", () => {
    it("another analyser without the map leaves HGB unmapped; Lym# and Lym% map to different analytes", async () => {
      const other = await registerInstrument(db, fx.pathologist.actor, { code: "ANL-HAEM-B", name: "Haematology B", sampleIdMode: "typed_id" });
      const onB = await scan(slip({ name: "TEST" }), { instrument: other.instrumentId, tag: "d6-b" });
      expect(onB.rows.find((x) => x.code === "HGB")).toMatchObject({ placement: "not_placed", reason: "unmapped" });

      const onA = await scan(slip({ name: "TEST" }), { tag: "d6-a" });
      const lymAbs = onA.rows.find((x) => x.code === "Lym#")!;
      const lymPct = onA.rows.find((x) => x.code === "Lym%")!;
      expect(lymAbs.analyteId).toBe(analyteId.get("LYMPH_ABS"));
      expect(lymPct.analyteId).toBe(analyteId.get("LYMPH"));
      expect(lymAbs.analyteId).not.toBe(lymPct.analyteId);
    });

    it("an HGB printed in g/L against a g/dL mapping is not placed: unit differs", async () => {
      const v = await scan(slip({ name: "TEST" }, withRow(CBC3, "HGB", { value: "106", unit: "g/L" })), { tag: "d6-gl" });
      expect(v.rows.find((x) => x.code === "HGB")).toMatchObject({ placement: "not_placed", reason: "unit_differs" });
    });

    it("two stored codes with the same slip key leave the row ambiguous", async () => {
      const c = await registerInstrument(db, fx.pathologist.actor, { code: "ANL-HAEM-C", name: "Haematology C", sampleIdMode: "typed_id" });
      await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId: c.instrumentId, instrumentCode: "Rdw-cv", analyteId: analyteId.get("RDW")!, unit: "%" });
      await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId: c.instrumentId, instrumentCode: "RDW–CV", analyteId: analyteId.get("RDW_SD")!, unit: "%" });
      const v = await scan(slip({ name: "TEST" }), { instrument: c.instrumentId, tag: "d6-amb" });
      expect(v.rows.find((x) => x.code === "RDW-CV")).toMatchObject({ placement: "not_placed", reason: "ambiguous_code", analyteId: null });
    });
  });

  /* ─────────────────────────────────────────── D7 ─────────────────────────────────────────── */
  describe("spec #934 D7 — the 3-part differential and the ignored platelet indices", () => {
    it("the catalogue carries Granulocytes and Mid cells, %/#, in the CBC", () => {
      const S = LAB_CATALOGUE_STANDARD_DATA;
      const by = new Map(S.analytes.map((a) => [a.code, a]));
      expect(by.get("GRAN")).toMatchObject({ resultType: "numeric", unit: "%" });
      expect(by.get("MID")).toMatchObject({ resultType: "numeric", unit: "%" });
      expect(by.get("GRAN_ABS")).toMatchObject({ resultType: "formula", formula: "WBC * GRAN / 100" });
      expect(by.get("MID_ABS")).toMatchObject({ resultType: "formula", formula: "WBC * MID / 100" });
      const cbc = S.orderables.find((o) => o.code === "CBC")!;
      expect(cbc.analyteCodes).toEqual(expect.arrayContaining(["GRAN", "GRAN_ABS", "MID", "MID_ABS"]));
    });

    it("prints Gran/Mid %/#, no empty 5-part rows; #s are cross-checks only; PDW/PCT/P-LCR/P-LCC are ignored and counted", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210071" });
      const v = await scan(slip({ ...RAM, patientId: "S2610210071" }, withRow(CBC3, "Gran#", { value: "2.50" })));
      expect(v.status).toBe("attached");

      for (const code of ["Lym#", "Gran#", "Mid#"]) expect(v.rows.find((x) => x.code === code)?.placement).toBe("cross_check");
      for (const code of IGNORED) expect(v.rows.find((x) => x.code === code)?.placement).toBe("ignored_setting");
      expect(v.counts.ignoredBySetting).toBe(4);
      expect(v.rows.some((x) => x.analyteId === analyteId.get("PCT"))).toBe(false);

      const rep = await getQuickReport(db, bench, target);
      const codes = rep.lines.map((l) => l.code);
      expect(codes).toEqual(expect.arrayContaining(["GRAN", "MID", "GRAN_ABS", "MID_ABS", "LYMPH_ABS"]));
      for (const empty of ["NEUT", "MONO", "EOS", "BASO", "ANC", "PCT"]) expect(codes).not.toContain(empty);
      const granAbs = rep.lines.find((l) => l.code === "GRAN_ABS")!;
      expect(granAbs.value).toBe("2.19");
      expect(granAbs.slip).toMatchObject({ slipValue: "2.50" });
      expect(granAbs.slip?.checks).toContain("cross_check_differs");
      expect(rep.lines.find((l) => l.code === "LYMPH_ABS")?.slip?.checks ?? []).not.toContain("cross_check_differs");

      const html = quickReportHtml({ ...rep, reportedAt: NOW.toISOString() }, { printedBy: null, logoUrl: "https://example.invalid/logo.png", now: NOW });
      for (const name of ["Granulocytes %", "Granulocytes, absolute", "Mid cells %", "Mid cells, absolute"]) expect(html).toContain(name);
      for (const name of ["Neutrophils", "Monocytes", "Eosinophils", "Basophils", "Procalcitonin", "PDW", "P-LCR"]) expect(html).not.toContain(name);
    });
  });

  /* ─────────────────────────────────────────── D8 ─────────────────────────────────────────── */
  describe("spec #934 D8 — a slip never replaces a person's value", () => {
    it("a typed value stays and typed_differs is open", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210081" });
      await withTx(db, (tx) => saveQuickResults(tx, bench, { id: target, lines: [{ analyteId: analyteId.get("HB")!, value: "11.2" }], summary: "", complete: false }, NOW));
      const v = await scan(slip({ ...RAM, patientId: "S2610210081" }));
      expect(v.status).toBe("attached");
      const hb = await lineOf(target, "HB");
      expect(hb?.value).toBe("11.2");
      expect(hb?.slip?.checks).toContain("typed_differs");
      expect((await lineOf(target, "WBC"))?.value).toBe("3.63");
    });

    it("cannot attach to a reported or a handed-over report", async () => {
      const reported = await openReport(fx.patientId, { status: "reported" });
      const handed = await openReport(fx.patientId, { handedOver: true });
      const v = await scan(slip({ name: "RAM KUMAR" }));
      await expect(attachSlip(db, bench, v.id, { quickReportId: reported, confirmed: true }, NOW)).rejects.toMatchObject({ code: "report_closed" });
      await expect(attachSlip(db, bench, v.id, { quickReportId: handed, confirmed: true }, NOW)).rejects.toMatchObject({ code: "report_closed" });
    });

    it("detach on a draft removes only the slip values nobody edited", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210082" });
      await withTx(db, (tx) => saveQuickResults(tx, bench, { id: target, lines: [{ analyteId: analyteId.get("HB")!, value: "11.2" }], summary: "", complete: false }, NOW));
      const v = await scan(slip({ ...RAM, patientId: "S2610210082" }));
      const edited = (await formLines(target)).map((l) => (l.analyteId === analyteId.get("WBC") ? { ...l, value: "3.70" } : l));
      await withTx(db, (tx) => saveQuickResults(tx, bench, { id: target, lines: edited, summary: "", complete: false }, NOW));

      const back = await detachSlip(db, bench, v.id, NOW);
      expect(back.status).toBe("waiting");
      const rep = await getQuickReport(db, bench, target);
      const by = new Map(rep.lines.map((l) => [l.code, l.value]));
      expect(by.get("HB")).toBe("11.2");
      expect(by.get("WBC")).toBe("3.70");
      expect(by.has("PLT")).toBe(false);
      expect(by.has("GRAN")).toBe(false);
      expect(rep.lines.every((l) => l.slip === undefined)).toBe(true);
    });
  });

  /* ─────────────────────────────────────────── D9 ─────────────────────────────────────────── */
  describe("spec #934 D9 — provider choice", () => {
    const keyDir = mkdtempSync(join(tmpdir(), "slip-keys-"));
    const geminiKey = join(keyDir, "gemini.txt");
    const openrouterKey = join(keyDir, "openrouter.txt");
    writeFileSync(geminiKey, `AIzaFAKE${"x".repeat(31)}\n`);
    writeFileSync(openrouterKey, `sk-or-v1-FAKE${"y".repeat(40)}\n`);
    const reply = () => slip({ ...RAM, patientId: "S2610210091" });
    const seen: { url: string; init: RequestInit }[] = [];
    const everyUrl: string[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      everyUrl.push(url);
      const text = JSON.stringify(reply());
      const body = url.includes("generativelanguage")
        ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 400 } }
        : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1200, completion_tokens: 400 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const cfg = (o: { gemini?: string | null; openrouter?: string | null }) => ({
      geminiKeyFile: o.gemini ?? null, openrouterKeyFile: o.openrouter ?? null,
      geminiModel: "gemini-2.5-flash", openrouterModel: "google/gemini-2.5-flash", timeoutMs: 5000,
    });

    it("with the Gemini key file present the Gemini endpoint is called, with the image and the analyser name only", async () => {
      await openReport(fx.patientId, { sampleNo: "S2610210091" });
      const reader = slipReaderFromConfig(cfg({ gemini: geminiKey, openrouter: openrouterKey }), fetchStub);
      expect(reader?.provider).toBe("gemini");
      seen.length = 0;
      const image = jpeg("d9-gemini");
      const v = await scan(null, { reader, tag: "d9-gemini" });
      expect(v.status).toBe("attached");
      expect(seen).toHaveLength(1);
      const call = seen[0]!;
      expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
      expect((call.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(`AIzaFAKE${"x".repeat(31)}`);
      const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["contents", "generationConfig", "systemInstruction"]);
      expect(body.contents).toEqual([{ role: "user", parts: [
        { inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } },
        { text: "Analyser: Haematology 3-part. Return the JSON." },
      ] }]);
      expect(body.generationConfig).toEqual({ temperature: 0, responseMimeType: "application/json", responseJsonSchema: SLIP_JSON_SCHEMA });
      const raw = String(call.init.body);
      for (const leak of ["Kumar", "KUMAR", "HMS-", "S2610210091", fx.patientId]) expect(raw).not.toContain(leak);
    });

    it("with only the OpenRouter key file, OpenRouter is called with data_collection deny", async () => {
      await openReport(fx.patientId, { sampleNo: "S2610210091" });
      const reader = slipReaderFromConfig(cfg({ openrouter: openrouterKey }), fetchStub);
      expect(reader?.provider).toBe("openrouter");
      seen.length = 0;
      await scan(null, { reader, tag: "d9-openrouter" });
      expect(seen).toHaveLength(1);
      const call = seen[0]!;
      expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer sk-or-v1-FAKE${"y".repeat(40)}`);
      const body = JSON.parse(String(call.init.body)) as { model: string; provider: unknown; response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } }; messages: { content: unknown }[] };
      expect(body.model).toBe("google/gemini-2.5-flash");
      expect(body.provider).toEqual({ data_collection: "deny", require_parameters: true });
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "lab_slip", strict: true, schema: SLIP_JSON_SCHEMA } });
      expect(JSON.stringify(body.messages)).toContain("data:image/jpeg;base64,");
      for (const leak of ["Kumar", "KUMAR", "HMS-", fx.patientId]) expect(String(call.init.body)).not.toContain(leak);
    });

    it("with neither, POST answers slip_reading_off and quick entry still works", async () => {
      expect(slipReaderFromConfig(cfg({}), fetchStub)).toBeNull();
      expect(slipReaderFromConfig(cfg({ gemini: join(keyDir, "absent.txt") }), fetchStub)).toBeNull();
      const target = await openReport(fx.patientId);
      await expect(scan(slip({}), { reader: null })).rejects.toBeInstanceOf(SlipError);
      await expect(scan(slip({}), { reader: null, tag: "off-2" })).rejects.toMatchObject({ code: "slip_reading_off" });
      const done = await withTx(db, (tx) => saveQuickResults(tx, bench, { id: target, lines: [{ analyteId: analyteId.get("HB")!, value: "13.4" }], summary: "ok" }, NOW));
      expect(done.status).toBe("reported");
    });

    it("a model id starting with anthropic/ fails boot; the configuration names are read", () => {
      const base = { DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! };
      expect(() => loadConfig({ ...base, LAB_SLIP_OPENROUTER_MODEL: "anthropic/claude-sonnet-4" } as NodeJS.ProcessEnv)).toThrow(/anthropic/);
      const c = loadConfig({
        ...base, HMIS_GEMINI_KEY_FILE: "/run/hmis/gemini/key.txt", HMIS_OPENROUTER_KEY_FILE: "/run/hmis/openrouter/key.txt",
        LAB_SLIP_GEMINI_MODEL: "gemini-2.5-flash", LAB_SLIP_OPENROUTER_MODEL: "google/gemini-2.5-flash", LAB_SLIP_TIMEOUT_MS: "25000",
      } as NodeJS.ProcessEnv);
      expect(c.labSlip).toEqual({
        geminiKeyFile: "/run/hmis/gemini/key.txt", openrouterKeyFile: "/run/hmis/openrouter/key.txt",
        geminiModel: "gemini-2.5-flash", openrouterModel: "google/gemini-2.5-flash", timeoutMs: 25000,
      });
      expect(loadConfig(base as NodeJS.ProcessEnv).labSlip.timeoutMs).toBe(30000);
    });

    it("no request ever goes to an Anthropic host", () => {
      expect(everyUrl.length).toBeGreaterThanOrEqual(2);
      for (const url of everyUrl) expect(new URL(url).host).not.toMatch(/anthropic/i);
    });
  });

  /* ─────────────────────────────────────────── D10 ─────────────────────────────────────────── */
  describe("spec #934 D10 — the image is stored once, viewed with a PHI row, and the events carry no name or value", () => {
    it("the same bytes twice return the same scan; the model is asked once", async () => {
      const stub = stubReader(slip({ name: "TEST" }));
      const input = { image: jpeg("d10-same"), mimeType: "image/jpeg", source: "gallery" as const, instrumentId, quickReportId: null };
      const a = await scanSlip(db, { store, reader: stub.reader }, bench, input, NOW);
      const b = await scanSlip(db, { store, reader: stub.reader }, bench, input, NOW);
      expect(b.id).toBe(a.id);
      expect(stub.calls).toHaveLength(1);
      expect(store.bytes.size).toBe(1);
    });

    it("View slip works from the quick report and each view writes a PHI access row", async () => {
      const target = await openReport(fx.patientId, { sampleNo: "S2610210101" });
      const v = await scan(slip({ ...RAM, patientId: "S2610210101" }), { tag: "d10-view" });
      const rep = await getQuickReport(db, bench, target);
      expect(rep.slips.map((s) => s.scanId)).toEqual([v.id]);
      const count = async () => (await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, fx.patientId))).length;
      const before = await count();
      const img = await readSlipImage(db, store, bench, rep.slips[0]!.scanId, NOW);
      expect(img.bytes.equals(jpeg("d10-view"))).toBe(true);
      await readSlipImage(db, store, bench, v.id, NOW);
      expect(await count()).toBe(before + 2);
    });

    it("lab.slip_* events carry no name and no result value; a discard needs a reason and keeps the row", async () => {
      await openReport(fx.patientId, { sampleNo: "S2610210102" });
      await scan(slip({ ...RAM, patientId: "S2610210102" }), { tag: "d10-events" });
      const waiting = await scan(slip({ name: "RAM KUMAR" }), { tag: "d10-discard" });
      await expect(discardSlip(db, bench, waiting.id, "  ", NOW)).rejects.toMatchObject({ code: "slip_reason_required" });
      const gone = await discardSlip(db, bench, waiting.id, "duplicate print of an earlier slip", NOW);
      expect(gone.status).toBe("discarded");
      expect((await getSlipScan(db, bench, waiting.id, NOW)).discard).toMatchObject({ reason: "duplicate print of an earlier slip" });

      const slipEvents = await db.select().from(events).where(like(events.name, "lab.slip_%"));
      expect(slipEvents.map((e) => e.name)).toEqual(expect.arrayContaining(["lab.slip_scanned", "lab.slip_attached", "lab.slip_discarded"]));
      for (const e of slipEvents) {
        const text = JSON.stringify(e.payload);
        for (const leak of ["Kumar", "KUMAR", "10.6", "3.63", "HMS-", "S2610210102"]) expect(text).not.toContain(leak);
      }
    });
  });

  /* ─────────────────────────────────────────── D11 ─────────────────────────────────────────── */
  describe("spec #934 D11 — retention", () => {
    it("purges a discarded or never-attached scan's image at 90 days; keeps an attached one; fails a stuck read", async () => {
      const discarded = await scan(slip({ name: "A" }), { tag: "d11-discarded" });
      await discardSlip(db, bench, discarded.id, "not our slip", NOW);
      const neverAttached = await scan(slip({ name: "B" }), { tag: "d11-waiting" });
      const young = await scan(slip({ name: "C" }), { tag: "d11-young" });
      await openReport(fx.patientId, { sampleNo: "S2610210111" });
      const attached = await scan(slip({ ...RAM, patientId: "S2610210111" }), { tag: "d11-attached" });
      expect(attached.status).toBe("attached");
      for (const id of [discarded.id, neverAttached.id, attached.id]) await db.update(labSlipScans).set({ capturedAt: daysAgo(91) }).where(eq(labSlipScans.id, id));
      await db.update(labSlipScans).set({ capturedAt: daysAgo(89) }).where(eq(labSlipScans.id, young.id));
      const stuck = await scan(slip({ name: "D" }), { tag: "d11-stuck" });
      await db.update(labSlipScans).set({ status: "reading", capturedAt: minutesAgo(3), readStartedAt: minutesAgo(3) }).where(eq(labSlipScans.id, stuck.id));
      const eventsBefore = (await db.select().from(events).where(like(events.name, "lab.slip_%"))).length;

      const report = await sweepLabSlips(db, store, NOW);
      expect(report).toMatchObject({ purged: 2, failed: 1 });

      for (const id of [discarded.id, neverAttached.id]) {
        const [row] = await db.select().from(labSlipScans).where(eq(labSlipScans.id, id));
        expect(row!.imagePurgedAt).not.toBeNull();
        expect(store.bytes.has(row!.storageKey)).toBe(false);
        await expect(readSlipImage(db, store, bench, id, NOW)).rejects.toMatchObject({ code: "slip_image_purged" });
      }
      const [young2] = await db.select().from(labSlipScans).where(eq(labSlipScans.id, young.id));
      expect(young2!.imagePurgedAt).toBeNull();
      expect((await readSlipImage(db, store, bench, attached.id, NOW)).bytes.length).toBeGreaterThan(0);
      const [stuck2] = await db.select().from(labSlipScans).where(eq(labSlipScans.id, stuck.id));
      expect([stuck2!.status, stuck2!.error]).toEqual(["failed", "timeout"]);
      expect((await db.select().from(events).where(like(events.name, "lab.slip_%"))).length).toBeGreaterThanOrEqual(eventsBefore);
      expect(await db.select().from(labSlipScans).where(and(eq(labSlipScans.id, discarded.id), eq(labSlipScans.status, "discarded")))).toHaveLength(1);
    });
  });

  /* ─────────────────────────────────────────── D13 ─────────────────────────────────────────── */
  describe("spec #934 D13 — the eval over the synthetic slip set", () => {
    it("the set is synthetic, renders to images, and the eval prints value, code and check-coverage accuracy", async () => {
      expect(existsSync(join(__dirname, "..", "..", "..", "..", "scripts", "lab-slip-eval.ts"))).toBe(true);
      const set = loadSlipEvalSet(SLIP_EVAL_DIR);
      expect(set.length).toBeGreaterThanOrEqual(6);
      for (const s of set) {
        expect(s.synthetic).toBe(true);
        const png = renderSlipPng(s);
        expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
        expect(png.length).toBeLessThan(1_500_000);
      }

      // The eval reads the set in order, one call per slip, so the stub answers slip i on call i.
      const echo = (mutate?: (truth: (typeof set)[number]) => unknown): SlipReader => {
        let i = 0;
        return {
          provider: "gemini", model: "eval-stub",
          async read() {
            const s = set[i % set.length]!;
            i += 1;
            return { text: JSON.stringify(mutate ? mutate(s) : s.reply), raw: null, tokensIn: 1, tokensOut: 1 };
          },
        };
      };
      const perfect = await scoreSlipEval(set, echo());
      expect(perfect).toMatchObject({ valueAccuracy: 1, codeAccuracy: 1, wrongValues: 0 });
      expect(productionGate(perfect).ok).toBe(true);

      const target = set[0]!.reply.rows.findIndex((x) => x.code === "RDW-SD");
      const corrupt = (legible: "clear" | "unsure") => (s: (typeof set)[number]) => (s.id !== set[0]!.id ? s.reply : {
        ...s.reply, rows: s.reply.rows.map((x, i) => (i === target ? { ...x, value: "47.1", legible } : x)),
      });
      const caught = await scoreSlipEval(set, echo(corrupt("unsure")));
      expect(caught.wrongValues).toBe(1);
      expect(caught.wrongWithCheckShare).toBe(1);
      const missed = await scoreSlipEval(set, echo(corrupt("clear")));
      expect(missed.wrongWithCheckShare).toBe(0);
      expect(productionGate(missed).ok).toBe(false);
    });
  });
});
