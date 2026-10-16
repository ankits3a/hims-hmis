import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { authManifest } from "../../kernel/auth/manifest";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { daycareEncounters, ipdAdmissions, ipdCopilotDrafts, ipdOrders, otCases, resources } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import { patientsManifest } from "../patients";
import { procedureText } from "./copilot";
import { buildFactSet, labValueFacts, LAB_VALUE_FACTS } from "./copilot-facts";
import { chooseLines, quantitiesIn, renderLine, verifyReworded } from "./copilot-lines";
import { dischargeRecordsUnchanged } from "./copilot-drafts";
import { buildDischargeDraft, ipdManifest, saveSummaryDraft } from "./index";
import type { ResultedValue } from "../lab";
import type { ProcedureDone } from "../ot";
import type { Fact } from "./copilot-lines";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * E5.3 (#740) lab VALUES in "Since yesterday", E5.4 (#741) PROCEDURES in the discharge draft (both owed by 1f7cc591).
 * Lab rows are written by the lab's real writers (`runLabOrder`); the admission, its order row and the theatre case
 * are inserted as rows (this file tests the READS of them). Instants are explicit; nothing pins the real clock.
 */

const ist = (s: string): Date => new Date(`${s}+05:30`);
const value = (v: Partial<ResultedValue> & Pick<ResultedValue, "analyteName" | "value" | "flag" | "resultedAt">): ResultedValue => ({
  resultId: newId(), orderItemId: newId(), testName: "Serum electrolytes", kind: "numeric", unit: "mmol/L",
  abnormal: ["L", "H", "LL", "HH", "A"].includes(v.flag ?? ""), critical: v.flag === "LL" || v.flag === "HH", ...v,
});
const lineOf = (f: Fact) => ({ key: f.key, text: renderLine(f), source: f.source, abnormal: false, weight: 0, fact: f });

describe("lab values as fact lines (pure)", () => {
  it("one line per analyte: critical first, then out of range, then in range; capped; the worse earlier value is named", () => {
    const facts = labValueFacts([
      value({ analyteName: "Sodium", value: "138", flag: "N", resultedAt: ist("2026-03-11T14:00:00") }),
      value({ analyteName: "Potassium", value: "5.0", flag: "N", resultedAt: ist("2026-03-11T13:00:00") }),
      value({ analyteName: "Haemoglobin", value: "7.9", unit: "g/dL", flag: "L", resultedAt: ist("2026-03-11T12:00:00"), testName: "CBC" }),
      value({ analyteName: "Potassium", value: "6.8", flag: "HH", resultedAt: ist("2026-03-11T06:05:00") }),
      value({ analyteName: "Total leucocyte count", value: "14.20", unit: "10^3/uL", flag: "H", resultedAt: ist("2026-03-11T11:00:00"), testName: "CBC" }),
      value({ analyteName: "Chloride", value: "101", flag: null, resultedAt: ist("2026-03-11T10:00:00") }),
    ]);
    expect(facts).toHaveLength(LAB_VALUE_FACTS);
    expect(facts.map(renderLine)).toEqual([
      "Critical lab: Potassium 5.0 mmol/L at 13:00; 6.8 mmol/L (critical high) at 06:05",
      "Lab: Haemoglobin 7.9 g/dL (low) at 12:00",
      "Lab: Total leucocyte count 14.20 10^3/uL (high) at 11:00",
      "Lab: Sodium 138 mmol/L at 14:00",
    ]);
    // Every number and clock time a template prints is one its fact carries, read from the rows.
    for (const f of facts) {
      const said = quantitiesIn(renderLine(f));
      for (const n of said.numbers) expect(f.numbers).toContain(n);
      for (const t of said.times) expect(f.times).toContain(t);
    }
    expect(facts[0]!.records.map((r) => r.label)).toEqual([
      "Serum electrolytes: Potassium 5.0 mmol/L at 13:00", "Serum electrolytes: Potassium 6.8 mmol/L (HH) at 06:05",
    ]);
    // Critical and abnormal lines sort ahead of the doctor's other lines; a changed value in a rewording is refused.
    const chosen = chooseLines(facts);
    expect(chosen.map((l) => l.abnormal)).toEqual([true, true, true, false]);
    expect(verifyReworded("Critical lab: Potassium 5.0 mmol/L at 13:00; 6.8 mmol/L (critical high) at 06:05", lineOf(facts[0]!)).ok).toBe(true);
    expect(verifyReworded("Critical lab: Potassium 5.0 mmol/L at 13:00; 6.3 mmol/L (critical high) at 06:05", lineOf(facts[0]!)).ok).toBe(false);
    expect(verifyReworded("Critical lab: Potassium 5.0 mmol/L at 13:00; 6.8 mmol/L (high) at 06:05", lineOf(facts[0]!)).ok).toBe(false);
  });

  it("a free-text result is named, never quoted", () => {
    const [f] = labValueFacts([value({ analyteName: "Peripheral smear", kind: "text", value: null, unit: null, flag: "A", resultedAt: ist("2026-03-11T09:30:00") })]);
    expect(renderLine(f!)).toBe("Lab: Peripheral smear text result (abnormal) at 09:30");
  });
});

describe("procedures as the discharge draft's text (pure)", () => {
  it("date, code, class and side, anaesthesia, and the conversion — no money", () => {
    const p: ProcedureDone = {
      caseId: "c1", encounterId: "e1", procedureCode: "GYN-HYST-OP", convertedFrom: "GYN-DNC-01", procedureClass: "gynae_hysteroscopy_operative",
      laterality: null, anaesthesiaType: "spinal", surgeonId: "u1", incisionAt: ist("2026-03-10T10:15:00"), closureAt: null,
    };
    expect(procedureText([p, { ...p, caseId: "c2", procedureCode: "ORT-IMPREM", convertedFrom: null, procedureClass: "ortho_implant_removal", laterality: "left", anaesthesiaType: null, incisionAt: ist("2026-03-12T09:00:00") }]))
      .toBe("10 Mar 2026 — GYN-HYST-OP (gynae hysteroscopy operative), spinal anaesthesia; converted from GYN-DNC-01\n12 Mar 2026 — ORT-IMPREM (ortho implant removal, left)");
    expect(procedureText([])).toBe("");
  });
});

describe("the reads, against rows", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let doctor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    const registry = new ModuleRegistry();
    registry.install(authManifest); registry.install(patientsManifest); registry.install(ipdManifest);
    await syncPermissions(db, registry);
    doctor = (await mkUser(db, "ipd.discharger", ["ipd_discharger"])).actor;
    await grantPermissionToRole(db, registry, "ipd_discharger", "ipd.discharge.declare");
  });
  afterEach(() => { fx.unregister(); });

  const ADMITTED = ist("2026-03-10T10:00:00");
  async function admission(opts: { source?: string; sourceRef?: string | null } = {}): Promise<{ id: string; patientId: string }> {
    const id = newId();
    await db.insert(ipdAdmissions).values({
      id, patientId: fx.patientId, workflowInstanceId: newId(), state: "admitted", source: opts.source ?? "direct", sourceRef: opts.sourceRef ?? null,
      consultantId: doctor.id, requestedClass: "general", isolation: "none", icu: false, requestedAt: ADMITTED, expiresAt: ist("2026-03-11T10:00:00"),
      requestedBy: doctor.id, updatedAt: ADMITTED, admittedAt: ADMITTED,
    } as never);
    return { id, patientId: fx.patientId };
  }
  const labOrderRow = (admissionId: string, departmentOrderId: string, code: string, at: Date) => db.insert(ipdOrders).values({
    id: newId(), admissionId, patientId: fx.patientId, kind: "lab", status: "active", serviceIds: [serviceIdForLabCode(code)], department: "lab",
    departmentOrderId, orderedBy: doctor.id, orderedByKind: "consultant", orderedAt: at, provenance: "direct",
  } as never);

  it("since yesterday: the stay's own signed values become lines with their records; another order's value never does", async () => {
    const a = await admission();
    const glu = await runLabOrder(db, fx, ["GLUF"], { at: ist("2026-03-11T08:10:00"), values: { GLUF: "500" } });
    const tsh = await runLabOrder(db, fx, ["TSH"], { at: ist("2026-03-11T09:20:00"), values: { TSH: "2.5" }, encounterNo: fx.newVisit() });
    await runLabOrder(db, fx, ["TSH"], { at: ist("2026-03-11T09:30:00"), values: { TSH: "9.9" }, encounterNo: fx.newVisit() }); // not the stay's order
    await labOrderRow(a.id, glu.orderId, "GLUF", ist("2026-03-11T07:00:00"));
    await labOrderRow(a.id, tsh.orderId, "TSH", ist("2026-03-11T07:05:00"));

    const { facts, truncated } = await buildFactSet(db, a, { since: ist("2026-03-11T07:00:00"), until: ist("2026-03-11T18:00:00") });
    expect(truncated).toEqual([]);
    const lab = facts.filter((f) => f.kind === "lab_value");
    expect(lab.map(renderLine)).toEqual([
      "Critical lab: Glucose, fasting 500 mg/dL (critical high) at 08:10",
      "Lab: TSH 2.50 uIU/mL at 09:20",
    ]);
    expect(lab.flatMap((f) => f.records.map((r) => r.id)).sort()).toEqual([...glu.resultIds, ...tsh.resultIds].sort());
    // The critical value is the first line the doctor reads (ahead of the "results reported" count).
    expect(chooseLines(facts)[0]!.key).toBe("lab:glucose, fasting");

    // Outside the window: no value line.
    const earlier = await buildFactSet(db, a, { since: ist("2026-03-11T09:30:00"), until: ist("2026-03-11T18:00:00") });
    expect(earlier.facts.filter((f) => f.kind === "lab_value")).toEqual([]);
  });

  async function theatreCase(incision: Date, opts: { converted?: boolean } = {}): Promise<{ caseId: string; encounterId: string }> {
    const by = doctor.id;
    const theatreId = newId();
    await db.insert(resources).values({ id: theatreId, kind: "theatre", code: `OT-${theatreId.slice(-4)}`, name: "Theatre 1", status: "available", createdBy: by, updatedBy: by } as never);
    const encounterId = newId();
    await db.insert(daycareEncounters).values({
      id: encounterId, encounterNo: `D${theatreId.slice(-8)}`, patientId: fx.patientId, payerClass: "self_pay", status: opts.converted === true ? "converted" : "discharged",
      createdBy: by, updatedBy: by,
    } as never);
    const caseId = newId();
    await db.insert(otCases).values({
      id: caseId, encounterId, patientId: fx.patientId, theatreResourceId: theatreId, listDate: "2026-03-10", seq: 1, procedureCode: "GYN-DNC-01",
      procedureClass: "gynae_dnc", surgeonId: by, anaesthesiaType: "spinal", packageServiceCode: "DC-GYN-DNC", quotePaise: 1_000_000, tariffVersionId: newId(),
      payerClass: "self_pay", workflowInstanceId: newId(), wheelIn: incision, incision, createdBy: by, updatedBy: by,
    } as never);
    return { caseId, encounterId };
  }

  it("the discharge draft: a procedure done during the stay fills `procedures` with its theatre source; none → empty and no source", async () => {
    const quiet = await admission();
    const none = await buildDischargeDraft(db, doctor, quiet.id, { now: ist("2026-03-12T10:00:00") });
    expect(none.content.procedures).toBe("");
    expect(none.sources.map((s) => s.field)).not.toContain("procedures");

    const before = await theatreCase(ist("2026-03-09T10:00:00")); // a day-care case before the stay, not converted to it
    const during = await theatreCase(ist("2026-03-11T11:30:00"));
    const d = await buildDischargeDraft(db, doctor, quiet.id, { now: ist("2026-03-12T10:00:00") });
    expect(d.content.procedures).toBe("11 Mar 2026 — GYN-DNC-01 (gynae dnc), spinal anaesthesia");
    expect(d.sources.find((s) => s.field === "procedures")).toEqual({
      field: "procedures", source: "ot", records: [{ id: during.caseId, at: ist("2026-03-11T11:30:00").toISOString(), label: "GYN-DNC-01 — incision 11 Mar 2026 11:30" }],
    });
    expect(d.sources.flatMap((s) => s.records.map((r) => r.id))).not.toContain(before.caseId);
    expect(JSON.stringify(d)).not.toMatch(/quote|paise|DC-GYN-DNC/i);

    // An admission converted from a day-care case names that case's procedure, though it came before the admission.
    await db.update(ipdAdmissions).set({ state: "discharged" } as never).where(eq(ipdAdmissions.id, quiet.id));
    const converted = await admission({ source: "ot_daycare_conversion", sourceRef: before.encounterId });
    const c = await buildDischargeDraft(db, doctor, converted.id, { now: ist("2026-03-12T10:00:00") });
    expect(c.content.procedures.split("\n")).toEqual(["9 Mar 2026 — GYN-DNC-01 (gynae dnc), spinal anaesthesia", "11 Mar 2026 — GYN-DNC-01 (gynae dnc), spinal anaesthesia"]);
  });

  // #794 — the fingerprint of the discharge draft counts the theatre's cases, under a versioned stamp.
  const saveFrom = (admissionId: string, draftId: string) => saveSummaryDraft(db, doctor, {
    idempotencyKey: randomUUID(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Synthetic fever" } }, draftId,
  }, { now: ist("2026-03-12T11:00:00") });
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { return (e as { code?: string }).code ?? String(e); }
    return "saved";
  };

  it("#794: a procedure recorded in theatre after the discharge draft makes the draft out of date", async () => {
    const a = await admission();
    const d = await buildDischargeDraft(db, doctor, a.id, { now: ist("2026-03-12T10:00:00") });
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, a.id)))[0]!;
    const stamped = (await db.select().from(ipdCopilotDrafts).where(eq(ipdCopilotDrafts.id, d.draftId)))[0]!.factsHash;
    expect(stamped).toMatch(/^v2:[0-9a-f]{32}$/);
    expect(await dischargeRecordsUnchanged(db, row, stamped)).toBe(true);
    await theatreCase(ist("2026-03-12T10:30:00"));
    expect(await dischargeRecordsUnchanged(db, row, stamped)).toBe(false);
    expect(await codeOf(saveFrom(a.id, d.draftId))).toBe("summary_draft_stale");
  });

  it("#794: a draft stamped under the old fingerprint (v1) stays current while nothing changed, and goes stale on a new order", async () => {
    const a = await admission();
    const d = await buildDischargeDraft(db, doctor, a.id, { now: ist("2026-03-12T10:00:00") });
    // The row as the pre-#794 code stamped it: 32 hex, no version, the orders / rounds / notes / items only.
    const v1 = createHash("sha256").update(JSON.stringify([[], [], [], []])).digest("hex").slice(0, 32);
    await db.update(ipdCopilotDrafts).set({ factsHash: v1 }).where(eq(ipdCopilotDrafts.id, d.draftId));
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, a.id)))[0]!;
    expect(await dischargeRecordsUnchanged(db, row, v1)).toBe(true);
    expect(await codeOf(saveFrom(a.id, d.draftId))).toBe("saved");
    // An unknown version is never current.
    expect(await dischargeRecordsUnchanged(db, row, `v9:${v1}`)).toBe(false);
    // Under v1 a new order still makes it stale (v1 is compared, not skipped).
    await labOrderRow(a.id, newId(), "GLUF", ist("2026-03-12T10:10:00"));
    expect(await dischargeRecordsUnchanged(db, row, v1)).toBe(false);
  });

  it("#794 review: a v1 stamp cannot vouch for the theatre — a stay with a theatre case never accepts it", async () => {
    const a = await admission();
    const d = await buildDischargeDraft(db, doctor, a.id, { now: ist("2026-03-12T10:00:00") });
    const v1 = createHash("sha256").update(JSON.stringify([[], [], [], []])).digest("hex").slice(0, 32);
    await db.update(ipdCopilotDrafts).set({ factsHash: v1 }).where(eq(ipdCopilotDrafts.id, d.draftId));
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, a.id)))[0]!;
    // A procedure recorded after the v1 stamp: v1's parts did not move, but the records did.
    await theatreCase(ist("2026-03-12T10:30:00"));
    expect(await dischargeRecordsUnchanged(db, row, v1)).toBe(false);
    expect(await codeOf(saveFrom(a.id, d.draftId))).toBe("summary_draft_stale");
  });
});
