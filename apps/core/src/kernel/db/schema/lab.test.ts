import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { newId } from "@hmis/contracts";
import {
  labAnalytes, labCriticalCalls, labItems, labOrderableAnalytes, labOrderables, labReferenceRanges,
  labReflexRules, labReportDeliveries, labReports, labResults, labSlaBreaches, labSpecimenItems,
  labSpecimens, orderItems, orders, patients, registrationConfig, services,
} from "./index";
import type { Db } from "../client";

/**
 * PLAN 17 T1 — THE THIRTEEN LAB TABLES, ASSERTED BY EXECUTION.
 *
 * Every CHECK below is proved by inserting the row it forbids and reading the refusal, and both
 * immutability triggers are proved the same way — the `orders.test.ts` shape, which is the shape
 * because a CHECK asserted by reading `pg_constraint` proves the constraint EXISTS and says nothing
 * about what it admits.
 *
 * ROUTINE tier: no mutants are owed and none is built (AGENT-RULES §3). **No fail-first is owed
 * either, and none is manufactured** — the tables do not exist before this task, so a red run here
 * would be an unresolved-import error, which §2.5 says proves nothing.
 */
const ACTOR = "01USER0000000000000000001";
const PATIENT = "01PATIENT0000000000000001";
const CBC_SERVICE = "01SERVICE0000000000000001";
const LFT_SERVICE = "01SERVICE0000000000000002";
const DAY = "2026-08-29";

describe("the lab core schema (Plan 17 T1, migration 0046)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  let hbId: string;
  let orderId: string;
  let itemId: string;

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", createdBy: ACTOR, updatedBy: ACTOR,
    });
    await db.insert(services).values([
      { id: CBC_SERVICE, code: "CBC", name: "Complete blood count", category: "investigation", createdBy: ACTOR, updatedBy: ACTOR },
      { id: LFT_SERVICE, code: "LFT", name: "Liver function", category: "investigation", createdBy: ACTOR, updatedBy: ACTOR },
    ]);
    await db.insert(labOrderables).values({
      serviceId: CBC_SERVICE, code: "CBC", nameEn: "Complete blood count", discipline: "haematology",
      specimenType: "whole_blood", container: "edta", tatMinutesRoutine: 240,
      createdBy: ACTOR, updatedBy: ACTOR,
    });
    hbId = newId();
    await db.insert(labAnalytes).values({
      id: hbId, code: "HB", nameEn: "Haemoglobin", resultType: "numeric", unit: "g/dL",
      createdBy: ACTOR, updatedBy: ACTOR,
    });
    await db.insert(labOrderableAnalytes).values({ serviceId: CBC_SERVICE, analyteId: hbId, position: 1 });

    orderId = newId();
    itemId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `L${DAY.slice(2).replace(/-/g, "")}0001`, orderGroupId: orderId, kind: "lab",
      patientId: PATIENT, encounterNo: "V2608290001", serviceDate: DAY, priority: "routine",
      authority: "clinician", orderedByType: "user", orderedById: ACTOR, placedAt: new Date(),
    });
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId: CBC_SERVICE });
  });

  /**
   * ═══ THE `S` NUMBER IS A COUNTER, NOT A DIE ROLL ═══
   *
   * It used to be `Math.floor(Math.random() * 90) + 10` — 90 possible values for a UNIQUE column,
   * so a test minting two specimens collided with ITSELF about once in ninety runs. It did, on the
   * radiology lane's doc-only commit (CI run 33617478294, 2026-09-02): "refuses a second ACTIVE
   * tube" failed on `lab_specimens_specimen_no_unique` at the fixture's own insert, and the diff
   * under test had touched no code at all. A random first-of-sequence number is not unique by
   * construction; a counter is.
   */
  let specimenSeq = 0;
  async function specimen(overrides: Partial<typeof labSpecimens.$inferInsert> = {}): Promise<string> {
    const id = newId();
    specimenSeq += 1;
    await db.insert(labSpecimens).values({
      id, specimenNo: `S26082900${String(specimenSeq).padStart(4, "0")}`, orderGroupId: orderId,
      patientId: PATIENT, specimenType: "whole_blood", container: "edta", serviceDate: DAY, ...overrides,
    });
    return id;
  }

  async function result(overrides: Partial<typeof labResults.$inferInsert> = {}): Promise<string> {
    const id = newId();
    await db.insert(labResults).values({
      id, orderItemId: itemId, analyteId: hbId, valueNumeric: "12.4", unit: "g/dL",
      enteredByType: "user", enteredById: ACTOR, entryMode: "manual", ...overrides,
    });
    return id;
  }

  describe("the catalogue", () => {
    it("refuses a discipline outside the closed list", async () => {
      await expect(db.insert(labOrderables).values({
        serviceId: LFT_SERVICE, code: "LFT", nameEn: "Liver function", discipline: "astrology",
        specimenType: "serum", container: "sst", tatMinutesRoutine: 240, createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_orderables_discipline_ck/);
    });

    it("refuses a non-positive routine TAT — a test with no turnaround has no SLA", async () => {
      await expect(db.insert(labOrderables).values({
        serviceId: LFT_SERVICE, code: "LFT", nameEn: "Liver function", discipline: "biochemistry",
        specimenType: "serum", container: "sst", tatMinutesRoutine: 0, createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_orderables_tat_ck/);
    });

    /** E33 / 02 E6 — PCPNDT. The refusal is in the database so a direct insert cannot route round it. */
    it("refuses an orderable that reports foetal sex, in the database", async () => {
      await expect(db.insert(labOrderables).values({
        serviceId: LFT_SERVICE, code: "FSEX", nameEn: "Foetal sex", discipline: "clinical_pathology",
        specimenType: "serum", container: "sst", tatMinutesRoutine: 60, reportsFoetalSex: true,
        createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_orderables_no_foetal_sex_ck/);
    });

    /**
     * 17d T1 — applicability is refused IN THE DATABASE, like the PCPNDT rule above and for the same
     * reason: `upsertAnalyte` also refuses these, and a curator with a psql prompt is not a curator
     * with a different rule book.
     */
    it("refuses an applicable-sex outside male/female — `unknown` is a patient's state, not a test's", async () => {
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "BHCG", nameEn: "Beta hCG", resultType: "numeric", appliesToSex: "unknown",
        createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_applies_sex_ck/);
    });

    it("refuses an inverted applicable-age band, and accepts an open-ended one", async () => {
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "NEO", nameEn: "Neonatal something", resultType: "numeric",
        appliesMinAgeDays: 29, appliesMaxAgeDays: 0, createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_applies_age_ck/);
      /** One end null is a half-open band and legal: "from 18 years, no upper limit". */
      await db.insert(labAnalytes).values({
        id: newId(), code: "ADULTONLY", nameEn: "Adults only", resultType: "numeric",
        appliesMinAgeDays: 6570, createdBy: ACTOR, updatedBy: ACTOR,
      });
    });

    it("refuses a result type outside the four, and a formula analyte with no formula", async () => {
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "X1", nameEn: "X", resultType: "guess", createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_result_type_ck/);
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "LDL", nameEn: "LDL", resultType: "formula", createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_formula_ck/);
      // And the converse leg: a non-formula analyte carrying a formula is refused too.
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "X2", nameEn: "X2", resultType: "numeric", formula: "TC - HDL",
        createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_formula_ck/);
    });

    it("refuses an inverted absurd envelope", async () => {
      await expect(db.insert(labAnalytes).values({
        id: newId(), code: "GLU", nameEn: "Glucose", resultType: "numeric",
        absurdLow: "1200", absurdHigh: "10", createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_analytes_absurd_ck/);
    });

    it("refuses an inverted age band, an unknown sex, and a range with neither number nor text", async () => {
      const base = { analyteId: hbId, sex: "any", source: "kit insert", effectiveFrom: DAY, createdBy: ACTOR };
      await expect(db.insert(labReferenceRanges).values({
        id: newId(), ...base, ageMinDays: 400, ageMaxDays: 30, low: "11", high: "15",
      })).rejects.toThrow(/lab_reference_ranges_age_ck/);
      await expect(db.insert(labReferenceRanges).values({
        id: newId(), ...base, sex: "unknown", ageMinDays: 0, ageMaxDays: 40000, low: "11", high: "15",
      })).rejects.toThrow(/lab_reference_ranges_sex_ck/);
      await expect(db.insert(labReferenceRanges).values({
        id: newId(), ...base, ageMinDays: 0, ageMaxDays: 40000,
      })).rejects.toThrow(/lab_reference_ranges_value_ck/);
    });

    it("refuses a reflex comparator outside the four", async () => {
      await expect(db.insert(labReflexRules).values({
        id: newId(), analyteId: hbId, comparator: "roughly", threshold: "6",
        addsServiceId: CBC_SERVICE, createdBy: ACTOR, updatedBy: ACTOR,
      })).rejects.toThrow(/lab_reflex_rules_comparator_ck/);
    });
  });

  describe("the pipeline tables", () => {
    it("refuses an unknown charge reason, priority and collection site", async () => {
      const base = { orderItemId: itemId, instanceId: newId(), serviceId: CBC_SERVICE };
      await expect(db.insert(labItems).values({ ...base, chargeReason: "goodwill" }))
        .rejects.toThrow(/lab_items_charge_reason_ck/);
      await expect(db.insert(labItems).values({ ...base, chargeReason: "lab_desk", priority: "whenever" }))
        .rejects.toThrow(/lab_items_priority_ck/);
      await expect(db.insert(labItems).values({ ...base, chargeReason: "lab_desk", collectionSite: "mars" }))
        .rejects.toThrow(/lab_items_collection_site_ck/);
    });

    it("refuses a half-recorded consent and an invoice line with no invoice", async () => {
      const base = { orderItemId: itemId, instanceId: newId(), serviceId: CBC_SERVICE, chargeReason: "lab_desk" };
      await expect(db.insert(labItems).values({ ...base, consentRecordedAt: new Date() }))
        .rejects.toThrow(/lab_items_consent_ck/);
      await expect(db.insert(labItems).values({ ...base, invoiceLineId: newId() }))
        .rejects.toThrow(/lab_items_invoice_pair_ck|lab_items_invoice_line_id/);
    });

    it("refuses a rejection reason outside the closed list, and a rejected tube with none", async () => {
      await expect(specimen({ status: "rejected", rejectionReason: "looked wrong" }))
        .rejects.toThrow(/lab_specimens_rejection_reason_ck/);
      await expect(specimen({ status: "rejected" }))
        .rejects.toThrow(/lab_specimens_rejected_ck/);
      // And the converse: a reason on a tube that is not rejected.
      await expect(specimen({ status: "received", rejectionReason: "haemolysed" }))
        .rejects.toThrow(/lab_specimens_rejected_ck/);
    });

    it("refuses a downtime-kit serial on a printer label", async () => {
      await expect(specimen({ labelSource: "printer", downtimeKitSerial: "KIT-004" }))
        .rejects.toThrow(/lab_specimens_downtime_ck/);
      await expect(specimen({ labelSource: "downtime_kit", downtimeKitSerial: "KIT-004" })).resolves.toBeTruthy();
    });

    /**
     * DD5 — AN ITEM HAS AT MOST ONE LIVE TUBE. The partial UNIQUE is the invariant a rejection
     * depends on: the old link is flipped `active = false` and the replacement is inserted, and the
     * index is what makes a second LIVE link impossible rather than merely unlikely.
     */
    it("refuses a second ACTIVE tube for one item and admits the inactive history", async () => {
      const first = await specimen();
      const second = await specimen();
      await db.insert(labSpecimenItems).values({ specimenId: first, orderItemId: itemId });
      await expect(db.insert(labSpecimenItems).values({ specimenId: second, orderItemId: itemId }))
        .rejects.toThrow(/lab_specimen_items_active_ux/);
      await db.update(labSpecimenItems).set({ active: false }).where(sql`specimen_id = ${first}`);
      await expect(db.insert(labSpecimenItems).values({ specimenId: second, orderItemId: itemId }))
        .resolves.toBeTruthy();
      expect(await db.select().from(labSpecimenItems)).toHaveLength(2);
    });
  });

  describe("results", () => {
    it("refuses two value columns and refuses none", async () => {
      await expect(result({ valueText: "normal" })).rejects.toThrow(/lab_results_one_value_ck/);
      await expect(result({ valueNumeric: null })).rejects.toThrow(/lab_results_one_value_ck/);
    });

    it("refuses an unknown flag, entry mode and verification status", async () => {
      await expect(result({ flag: "VERY_HIGH" })).rejects.toThrow(/lab_results_flag_ck/);
      await expect(result({ entryMode: "telepathy" })).rejects.toThrow(/lab_results_entry_mode_ck/);
      await expect(result({ verificationStatus: "probably", verifiedBy: ACTOR, verifiedAt: new Date() }))
        .rejects.toThrow(/lab_results_verification_status_ck/);
    });

    it("refuses a verification instant with no verifier, and a verified row with no verifier", async () => {
      await expect(result({ verifiedAt: new Date() })).rejects.toThrow(/lab_results_verified_pair_ck/);
      await expect(result({ verificationStatus: "verified" })).rejects.toThrow(/lab_results_verified_/);
      await expect(result({ verifiedBy: ACTOR, verifiedAt: new Date() }))
        .rejects.toThrow(/lab_results_verified_status_ck/);
    });
  });

  /**
   * THE TWO TRIGGERS. Each is proved by the UPDATE it must refuse AND by the update it must admit —
   * a trigger that refuses everything would pass the first half alone, and it would make the
   * `unverified → verified` transition (the one move this table exists for) impossible.
   */
  describe("immutability", () => {
    it("admits unverified → verified, then freezes the clinical content and refuses the delete", async () => {
      const id = await result();
      await db.update(labResults)
        .set({ verificationStatus: "verified", verifiedBy: "01USER0000000000000000002", verifiedAt: new Date() })
        .where(sql`id = ${id}`);

      await expect(db.update(labResults).set({ valueNumeric: "10.2" }).where(sql`id = ${id}`))
        .rejects.toThrow(/lab_result_immutable/);
      await expect(db.update(labResults).set({ refHigh: "99" }).where(sql`id = ${id}`))
        .rejects.toThrow(/lab_result_immutable/);
      await expect(db.delete(labResults).where(sql`id = ${id}`)).rejects.toThrow(/lab_result_immutable/);

      // DD11 — and the ONE column the morning review must be able to close.
      await expect(db.update(labResults).set({ pathologistReviewPending: false }).where(sql`id = ${id}`))
        .resolves.toBeTruthy();
      const [row] = await db.select().from(labResults).where(sql`id = ${id}`);
      expect([row!.valueNumeric, row!.verificationStatus]).toEqual(["12.4000", "verified"]);
    });

    it("freezes a published report's snapshot but admits print_count and the superseding status", async () => {
      const id = newId();
      await db.insert(labReports).values({
        id, orderId, version: 1, status: "published", snapshot: { results: [] },
        signedBy: ACTOR, signedAt: new Date(), publishedAt: new Date(), publishChannels: ["print"],
      });

      await expect(db.update(labReports).set({ snapshot: { results: ["edited"] } }).where(sql`id = ${id}`))
        .rejects.toThrow(/lab_report_immutable/);
      await expect(db.update(labReports).set({ signedBy: "01USER0000000000000000009" }).where(sql`id = ${id}`))
        .rejects.toThrow(/lab_report_immutable/);
      await expect(db.delete(labReports).where(sql`id = ${id}`)).rejects.toThrow(/lab_report_immutable/);

      await expect(db.update(labReports).set({ printCount: 1 }).where(sql`id = ${id}`)).resolves.toBeTruthy();
      await expect(db.update(labReports).set({ status: "superseded" }).where(sql`id = ${id}`)).resolves.toBeTruthy();
    });

    it("leaves a DRAFT report editable — the trigger fires on the OLD row's status", async () => {
      const id = newId();
      await db.insert(labReports).values({ id, orderId, version: 1, snapshot: { results: [] } });
      await expect(db.update(labReports).set({ snapshot: { results: ["draft edit"] } }).where(sql`id = ${id}`))
        .resolves.toBeTruthy();
    });
  });

  describe("reports, deliveries, criticals and SLA rows", () => {
    it("refuses a published report with no instant and version 1 with a prior version", async () => {
      await expect(db.insert(labReports).values({
        id: newId(), orderId, version: 1, status: "published", snapshot: {},
      })).rejects.toThrow(/lab_reports_published_ck/);
      await expect(db.insert(labReports).values({
        id: newId(), orderId, version: 1, snapshot: {}, priorVersionId: newId(),
      })).rejects.toThrow(/lab_reports_prior_ck/);
      await expect(db.insert(labReports).values({
        id: newId(), orderId, version: 2, snapshot: {},
      })).rejects.toThrow(/lab_reports_prior_ck/);
    });

    it("refuses a second report of the same version for one order", async () => {
      await db.insert(labReports).values({ id: newId(), orderId, version: 1, snapshot: {} });
      await expect(db.insert(labReports).values({ id: newId(), orderId, version: 1, snapshot: {} }))
        .rejects.toThrow(/lab_reports_order_version_ux/);
    });

    /** 02 J2 — a physical hand-over names its collector; a screen read does not. */
    it("refuses a print delivery with no collector and admits a doctor_screen one", async () => {
      const reportId = newId();
      await db.insert(labReports).values({ id: reportId, orderId, version: 1, snapshot: {} });
      await expect(db.insert(labReportDeliveries).values({
        id: newId(), reportId, channel: "print", deliveredBy: ACTOR,
      })).rejects.toThrow(/lab_report_deliveries_collector_ck/);
      await expect(db.insert(labReportDeliveries).values({
        id: newId(), reportId, channel: "doctor_screen", deliveredBy: ACTOR,
      })).resolves.toBeTruthy();
    });

    it("refuses a critical call closed without a read-back", async () => {
      const resultId = await result();
      await expect(db.insert(labCriticalCalls).values({
        id: newId(), resultId, openedBy: ACTOR, closedAt: new Date(), closedBy: ACTOR,
      })).rejects.toThrow(/lab_critical_calls_closed_ck/);
      await expect(db.insert(labCriticalCalls).values({
        id: newId(), resultId, openedBy: ACTOR, closedAt: new Date(), closedBy: ACTOR, readbackText: "K 6.8, repeat sent",
      })).resolves.toBeTruthy();
    });

    /** T5 A8's mechanism: the sweep keeps no state because the index refuses the second row. */
    it("refuses a second SLA breach row for the same item and stage", async () => {
      await db.insert(labSlaBreaches).values({ id: newId(), orderItemId: itemId, stage: "analysis", dueAt: new Date() });
      await expect(db.insert(labSlaBreaches).values({
        id: newId(), orderItemId: itemId, stage: "analysis", dueAt: new Date(),
      })).rejects.toThrow(/lab_sla_breaches_item_stage_ux/);
      await expect(db.insert(labSlaBreaches).values({
        id: newId(), orderItemId: itemId, stage: "collection", dueAt: new Date(),
      })).resolves.toBeTruthy();
    });
  });

  /**
   * `truncateAll` IS PART OF THIS TASK'S DELIVERABLE (T1's Files list), and the only honest way to
   * assert it is to fill every one of the thirteen tables and watch them all empty — a grep over
   * `db.ts` would assert the NAMES are present, which is what a reviewer can already see.
   */
  it("truncateAll empties all thirteen lab tables", async () => {
    const specimenId = await specimen();
    await db.insert(labSpecimenItems).values({ specimenId, orderItemId: itemId });
    await db.insert(labItems).values({
      orderItemId: itemId, instanceId: newId(), serviceId: CBC_SERVICE, chargeReason: "lab_desk",
    });
    const resultId = await result({ specimenId });
    await db.insert(labCriticalCalls).values({ id: newId(), resultId, openedBy: ACTOR });
    await db.insert(labSlaBreaches).values({ id: newId(), orderItemId: itemId, stage: "analysis", dueAt: new Date() });
    const reportId = newId();
    await db.insert(labReports).values({ id: reportId, orderId, version: 1, snapshot: {} });
    await db.insert(labReportDeliveries).values({ id: newId(), reportId, channel: "doctor_screen", deliveredBy: ACTOR });
    await db.insert(labReferenceRanges).values({
      id: newId(), analyteId: hbId, sex: "any", ageMinDays: 0, ageMaxDays: 40000, low: "11", high: "15",
      source: "kit insert", effectiveFrom: DAY, createdBy: ACTOR,
    });
    await db.insert(labReflexRules).values({
      id: newId(), analyteId: hbId, comparator: "gt", threshold: "6", addsServiceId: CBC_SERVICE,
      createdBy: ACTOR, updatedBy: ACTOR,
    });

    await truncateAll(db);

    for (const [name, table] of [
      ["lab_orderables", labOrderables], ["lab_analytes", labAnalytes],
      ["lab_orderable_analytes", labOrderableAnalytes], ["lab_reference_ranges", labReferenceRanges],
      ["lab_reflex_rules", labReflexRules], ["lab_items", labItems],
      ["lab_specimens", labSpecimens], ["lab_specimen_items", labSpecimenItems],
      ["lab_results", labResults], ["lab_reports", labReports],
      ["lab_report_deliveries", labReportDeliveries], ["lab_critical_calls", labCriticalCalls],
      ["lab_sla_breaches", labSlaBreaches],
    ] as const) {
      expect([name, await db.select().from(table)]).toEqual([name, []]);
    }
  });
});
