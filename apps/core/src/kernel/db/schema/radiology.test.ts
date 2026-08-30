import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  imagingBillDecisions, imagingCriticalFindings, imagingDefinitions, imagingReports,
  imagingSafetyScreenings, imagingStudies, orderItems, orders, patients, resources, services,
} from "./index";
import { withTx } from "../client";
import type { Db } from "../client";

/**
 * PLAN 18a T1 — the radiology migration's structural guarantees, each one EXECUTED rather than read
 * out of `information_schema`. `orders.test.ts` states the standard this file follows: *"the
 * constraint exists in `pg_constraint`" proves nothing about what Postgres will do with a row.*
 * Every assertion below issues the real statement and reads the real refusal.
 *
 * Three of these are the ones a reviewer should look at first, because each is a clinical fact
 * rather than a shape:
 *
 *   · **the slot unique** — B1's two receptionists and the last MRI slot, with BOTH halves of the
 *     `WHERE` clause proved: a second live booking is refused, and the slot is released by a cancel;
 *   · **the dose CHECK** — M4, an ionising study that was acquired and carries no number at all;
 *   · **the report trigger** — E11 / §11.6, a signed report whose body cannot be edited or deleted.
 */
describe("radiology — 0047 structure", () => {
  const PATIENT = "01PATIENT0000000000000001";
  const SERVICE = "01SERVICE0000000000000001";
  const ORDER = "01ORDER00000000000000001";
  const ITEM = "01ITEM000000000000000001";
  const ITEM2 = "01ITEM000000000000000002";
  const DEVICE = "01DEVICE00000000000000001";
  const SLOT = new Date("2026-08-29T09:00:00.000Z");

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi",
      sex: "female", administrativeGender: "female", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(services).values({
      id: SERVICE, code: "CT-ABDO", name: "CT abdomen", category: "investigation",
      createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(resources).values({
      id: DEVICE, kind: "device", code: "CT-1", name: "CT scanner 1", status: "available",
      createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(orders).values({
      id: ORDER, orderNo: "R2608290001", orderGroupId: "01GROUP00000000000000001",
      kind: "imaging", patientId: PATIENT, encounterNo: "V2608290001", serviceDate: "2026-08-29",
      priority: "routine", authority: "clinician", orderedByType: "user", orderedById: "u1",
      orderingClinicianId: "u1", indication: "abdominal pain, rule out obstruction",
      placedAt: new Date("2026-08-29T04:00:00.000Z"),
    });
    await db.insert(orderItems).values([
      { id: ITEM, orderId: ORDER, serviceId: SERVICE },
      { id: ITEM2, orderId: ORDER, serviceId: SERVICE },
    ]);
  });

  const study = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "01STUDY00000000000000001",
    orderItemId: ITEM,
    orderId: ORDER,
    patientId: PATIENT,
    encounterNo: "V2608290001",
    studyTypeCode: "CT-ABDO",
    serviceId: SERVICE,
    accessionNo: "X2608290001",
    priority: "routine",
    workflowInstanceId: "01WFI0000000000000000001",
    ...over,
  });

  /** Inserts the valid study every negative assertion below is the negative OF. */
  async function withStudy(over: Record<string, unknown> = {}): Promise<string> {
    const row = study(over);
    await db.insert(imagingStudies).values(row as never);
    return row["id"] as string;
  }

  describe("imaging_studies — the CHECKs, each refused by Postgres", () => {
    it("accepts the valid study the rest of this file is the negative of, with its defaults", async () => {
      await withStudy();
      const [row] = await db.select().from(imagingStudies);
      expect(row!.status).toBe("scheduled");        // the column default
      expect(row!.laterality).toBe("na");           // "no side" is a statement, not a null
      expect(row!.ionising).toBe(false);
      expect(row!.formFRequired).toBe(false);
      expect(row!.doseManual).toBe(false);
      expect(row!.contrastGiven).toBe(false);
      expect(row!.lateEntry).toBe(false);
      expect(row!.deviceResourceId).toBeNull();     // "awaiting slot" — the consumer's state
      expect(row!.scheduledAt).toBeNull();
    });

    it("refuses a status outside the ten", async () => {
      await expect(db.insert(imagingStudies).values(study({ status: "reading" }) as never))
        .rejects.toThrow(/imaging_studies_status_ck/);
    });

    it("refuses a laterality outside left/right/bilateral/na", async () => {
      await expect(db.insert(imagingStudies).values(study({ laterality: "both" }) as never))
        .rejects.toThrow(/imaging_studies_laterality_ck/);
    });

    it("refuses a priority outside routine/urgent/stat", async () => {
      await expect(db.insert(imagingStudies).values(study({ priority: "asap" }) as never))
        .rejects.toThrow(/imaging_studies_priority_ck/);
    });

    it("refuses an image_source outside pacs/no_pacs_images/outside, and admits null before acquisition", async () => {
      await expect(db.insert(imagingStudies).values(study({ imageSource: "cd" }) as never))
        .rejects.toThrow(/imaging_studies_image_source_ck/);
      await withStudy({ imageSource: null });       // a scheduled study has no images yet
    });

    it("refuses an authorised_by outside the four, and admits null", async () => {
      await expect(db.insert(imagingStudies).values(study({ authorisedBy: "waived" }) as never))
        .rejects.toThrow(/imaging_studies_authorised_by_ck/);
      await withStudy({ authorisedBy: null });
    });

    /**
     * M4, and the mutant T7 A3 names is exactly this row. `dose_manual = true` is tested on its own
     * line because the plan's wording ("or `dose_manual` is set with a value") admits a reading in
     * which the flag EXCUSES the number — it does not, and this assertion is where that reading
     * dies. A machine with no dose SR is the case M4 exists for: the technologist reads the console
     * and types the number, and `dose_manual` records that they did.
     */
    it("refuses an ACQUIRED ionising study carrying no dose number at all — even with dose_manual set", async () => {
      const acquired = { acquiredAt: new Date(), imageSource: "pacs" as const, ionising: true };
      await expect(db.insert(imagingStudies).values(study(acquired) as never))
        .rejects.toThrow(/imaging_studies_dose_ck/);
      await expect(db.insert(imagingStudies).values(study({ ...acquired, doseManual: true }) as never))
        .rejects.toThrow(/imaging_studies_dose_ck/);
    });

    it("accepts an acquired ionising study with ANY ONE dose number, and a non-ionising one with none", async () => {
      const acquired = { acquiredAt: new Date(), imageSource: "pacs" as const, ionising: true };
      await withStudy({ ...acquired, doseDlp: "412.500" });
      await db.delete(imagingStudies);
      await withStudy({ ...acquired, fluoroSeconds: 42 });
      await db.delete(imagingStudies);
      // A USG is not ionising: it acquires with no dose and that is not a hole (M1/M4).
      await withStudy({ acquiredAt: new Date(), imageSource: "no_pacs_images", ionising: false });
    });

    it("refuses a SCHEDULED study nothing else — the dose CHECK is gated on acquisition", async () => {
      await withStudy({ ionising: true });          // no acquiredAt, no dose: legal
    });

    it("refuses an acquired study with no image_source — 'from somewhere' includes 'this USG made none'", async () => {
      await expect(db.insert(imagingStudies).values(study({ acquiredAt: new Date() }) as never))
        .rejects.toThrow(/imaging_studies_image_source_required_ck/);
    });

    it("refuses a repeat pointer with no reason, and a reason with no pointer", async () => {
      await expect(db.insert(imagingStudies).values(study({ repeatOfStudyId: "01X" }) as never))
        .rejects.toThrow(/imaging_studies_repeat_ck/);
      await expect(db.insert(imagingStudies).values(study({ repeatReason: "motion artefact" }) as never))
        .rejects.toThrow(/imaging_studies_repeat_ck/);
      await withStudy({ repeatOfStudyId: "01X", repeatReason: "motion artefact" });
    });

    it("refuses a contrast agent or volume on a study where no contrast was given", async () => {
      await expect(db.insert(imagingStudies).values(study({ contrastAgent: "iohexol" }) as never))
        .rejects.toThrow(/imaging_studies_contrast_ck/);
      await expect(db.insert(imagingStudies).values(study({ contrastVolumeMl: "80.00" }) as never))
        .rejects.toThrow(/imaging_studies_contrast_ck/);
      await withStudy({ contrastGiven: true, contrastAgent: "iohexol", contrastVolumeMl: "80.00" });
    });

    it("refuses a second study on the same order item — one item, one study (DD3)", async () => {
      await withStudy();
      await expect(db.insert(imagingStudies).values(
        study({ id: "01STUDY00000000000000002", accessionNo: "X2608290002" }) as never,
      )).rejects.toThrow(/imaging_studies_order_item_id_unique|order_item_id/);
    });

    it("refuses a duplicate accession number across studies", async () => {
      await withStudy();
      await expect(db.insert(imagingStudies).values(
        study({ id: "01STUDY00000000000000002", orderItemId: ITEM2 }) as never,
      )).rejects.toThrow(/accession_no/);
    });
  });

  /**
   * ═══ B1 — THE SLOT, AND BOTH HALVES OF THE PARTIAL PREDICATE ═══
   *
   * T4 A1's mutants are (a) drop the `WHERE` clause, which makes a cancelled booking hold its slot
   * for ever, and (b) drop the index, which lets both receptionists win. The two assertions below
   * are the ones those mutants have to survive, so they are written as one describe rather than
   * spread through the file.
   */
  describe("the slot is a partial UNIQUE — the lock B1 needs, and the release a cancel owes", () => {
    it("refuses a second LIVE study on the same device at the same instant", async () => {
      await withStudy({ deviceResourceId: DEVICE, scheduledAt: SLOT });
      await expect(db.insert(imagingStudies).values(study({
        id: "01STUDY00000000000000002", orderItemId: ITEM2, accessionNo: "X2608290002",
        deviceResourceId: DEVICE, scheduledAt: SLOT,
      }) as never)).rejects.toThrow(/imaging_studies_slot_ux/);
    });

    it.each(["cancelled", "rescheduled", "no_show"] as const)(
      "RELEASES the slot once the first study is %s — the machine is idle either way",
      async (freeing) => {
        const first = await withStudy({ deviceResourceId: DEVICE, scheduledAt: SLOT });
        await db.update(imagingStudies).set({ status: freeing }).where(sql`id = ${first}`);
        await db.insert(imagingStudies).values(study({
          id: "01STUDY00000000000000002", orderItemId: ITEM2, accessionNo: "X2608290002",
          deviceResourceId: DEVICE, scheduledAt: SLOT,
        }) as never);
        const rows = await db.select().from(imagingStudies);
        expect(rows).toHaveLength(2);
      },
    );

    it("does NOT constrain unslotted studies — any number await a slot together", async () => {
      await withStudy();
      await db.insert(imagingStudies).values(study({
        id: "01STUDY00000000000000002", orderItemId: ITEM2, accessionNo: "X2608290002",
      }) as never);
      expect(await db.select().from(imagingStudies)).toHaveLength(2);
    });
  });

  describe("imaging_safety_screenings", () => {
    it("refuses a gate kind outside the ten", async () => {
      const studyId = await withStudy();
      await expect(db.insert(imagingSafetyScreenings).values({
        id: "01GATE00000000000000001", studyId, kind: "vibes_check",
        workflowInstanceId: "01WFI0000000000000000002",
      } as never)).rejects.toThrow(/imaging_safety_screenings_kind_ck/);
    });

    it("refuses the same gate kind twice on one study", async () => {
      const studyId = await withStudy();
      const row = {
        id: "01GATE00000000000000001", studyId, kind: "form_f",
        workflowInstanceId: "01WFI0000000000000000002",
      };
      await db.insert(imagingSafetyScreenings).values(row as never);
      await expect(db.insert(imagingSafetyScreenings).values(
        { ...row, id: "01GATE00000000000000002" } as never,
      )).rejects.toThrow(/imaging_safety_screenings_study_kind_ux/);
    });
  });

  describe("imaging_definitions", () => {
    const def = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "01DEF0000000000000000001", kind: "study_types", version: 1,
      body: { types: [] }, draftedBy: "u1", ...over,
    });

    it("refuses a kind outside the three, a version of zero, and a published row with no publisher", async () => {
      await expect(db.insert(imagingDefinitions).values(def({ kind: "tariff" }) as never))
        .rejects.toThrow(/imaging_definitions_kind_ck/);
      await expect(db.insert(imagingDefinitions).values(def({ version: 0 }) as never))
        .rejects.toThrow(/imaging_definitions_version_ck/);
      await expect(db.insert(imagingDefinitions).values(def({ status: "active" }) as never))
        .rejects.toThrow(/imaging_definitions_published_ck/);
    });

    /** T4 A5 at the database layer: `activeDefinition` cannot be handed two answers. */
    it("refuses a SECOND active version of one kind — one active definition, as an index", async () => {
      const published = { status: "active", publishedBy: "u2", publishedAt: new Date() };
      await db.insert(imagingDefinitions).values(def(published) as never);
      await expect(db.insert(imagingDefinitions).values(
        def({ ...published, id: "01DEF0000000000000000002", version: 2 }) as never,
      )).rejects.toThrow(/imaging_definitions_one_active_ux/);
    });

    it("allows many DRAFTS of one kind, and one active beside them", async () => {
      await db.insert(imagingDefinitions).values(def() as never);
      await db.insert(imagingDefinitions).values(def({ id: "01DEF0000000000000000002", version: 2 }) as never);
      await db.insert(imagingDefinitions).values(def({
        id: "01DEF0000000000000000003", version: 3,
        status: "active", publishedBy: "u2", publishedAt: new Date(),
      }) as never);
      expect(await db.select().from(imagingDefinitions)).toHaveLength(3);
    });
  });

  describe("imaging_reports — the version chain, and the trigger a courtroom depends on", () => {
    const signed = {
      status: "signed", signerId: "u9", signedAt: new Date(), secondFactorAt: new Date(),
    };
    const report = (studyId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "01REPORT0000000000000001", studyId, version: 1, templateKey: "ct_abdomen",
      body: { findings: "unremarkable" }, ...over,
    });

    it("refuses a signed report with no signer, no instant, or no second factor", async () => {
      const studyId = await withStudy();
      for (const missing of ["signerId", "signedAt", "secondFactorAt"] as const) {
        const partial: Record<string, unknown> = { ...signed };
        delete partial[missing];
        await expect(db.insert(imagingReports).values(report(studyId, partial) as never))
          .rejects.toThrow(/imaging_reports_signed_shape_ck/);
      }
    });

    it("refuses a SECOND signed version of one study — B10, as an index", async () => {
      const studyId = await withStudy();
      await db.insert(imagingReports).values(report(studyId, signed) as never);
      await expect(db.insert(imagingReports).values(
        report(studyId, { ...signed, id: "01REPORT0000000000000002", version: 2 }) as never,
      )).rejects.toThrow(/imaging_reports_one_signed_ux/);
    });

    it("admits v2 signed once v1 is superseded — which is what `amend` does in one transaction", async () => {
      const studyId = await withStudy();
      await db.insert(imagingReports).values(report(studyId, signed) as never);
      await withTx(db, async (tx) => {
        await tx.update(imagingReports).set({ status: "superseded" }).where(sql`id = '01REPORT0000000000000001'`);
        await tx.insert(imagingReports).values(report(studyId, {
          ...signed, id: "01REPORT0000000000000002", version: 2,
          supersedesId: "01REPORT0000000000000001", amendmentReason: "left/right corrected",
        }) as never);
      });
      const rows = await db.select().from(imagingReports).orderBy(imagingReports.version);
      expect(rows.map((r) => r.status)).toEqual(["superseded", "signed"]);
    });

    it("refuses an amendment with no reason, and a published prelim", async () => {
      const studyId = await withStudy();
      await expect(db.insert(imagingReports).values(report(studyId, {
        ...signed, supersedesId: "01REPORT0000000000000009",
      }) as never)).rejects.toThrow(/imaging_reports_amendment_ck/);
      await expect(db.insert(imagingReports).values(report(studyId, {
        status: "prelim", publishedAt: new Date(),
      }) as never)).rejects.toThrow(/imaging_reports_prelim_unpublished_ck/);
    });

    /**
     * §11.6 / E11. The trigger is hand-carried SQL in the migration — drizzle emits no trigger — so
     * this is the only place it is proved, and it is proved by issuing the UPDATE.
     */
    it("FORBIDS updating a report's body, impression, signer or laterality, and forbids DELETE", async () => {
      const studyId = await withStudy();
      await db.insert(imagingReports).values(report(studyId, signed) as never);
      for (const [column, value] of [
        ["body", `'{"findings":"mass"}'::jsonb`], ["impression", `'rewritten'`],
        ["signer_id", `'u_other'`], ["laterality", `'left'`], ["version", `9`],
      ] as const) {
        await expect(db.execute(sql.raw(
          `update imaging_reports set ${column} = ${value} where id = '01REPORT0000000000000001'`,
        ))).rejects.toThrow(/imaging_report_immutable/);
      }
      await expect(db.execute(sql`delete from imaging_reports where id = '01REPORT0000000000000001'`))
        .rejects.toThrow(/imaging_report_immutable/);
    });

    it("PERMITS the two columns publication moves — status and published_at", async () => {
      const studyId = await withStudy();
      await db.insert(imagingReports).values(report(studyId, signed) as never);
      await db.update(imagingReports)
        .set({ status: "superseded", publishedAt: new Date() })
        .where(sql`id = '01REPORT0000000000000001'`);
      const [row] = await db.select().from(imagingReports);
      expect(row!.status).toBe("superseded");
      expect(row!.publishedAt).not.toBeNull();
    });
  });

  describe("imaging_critical_findings and imaging_bill_decisions", () => {
    it("refuses a critical category outside red/orange/yellow and a half-acknowledgement", async () => {
      const studyId = await withStudy();
      await db.insert(imagingReports).values({
        id: "01REPORT0000000000000001", studyId, version: 1, templateKey: "ct_abdomen",
        body: {}, status: "signed", signerId: "u9", signedAt: new Date(), secondFactorAt: new Date(),
      } as never);
      const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: "01CRIT00000000000000001", reportId: "01REPORT0000000000000001", category: "red", ...over,
      });
      await expect(db.insert(imagingCriticalFindings).values(finding({ category: "black" }) as never))
        .rejects.toThrow(/imaging_critical_findings_category_ck/);
      await expect(db.insert(imagingCriticalFindings).values(finding({ acknowledgedBy: "u3" }) as never))
        .rejects.toThrow(/imaging_critical_findings_ack_ck/);
      await db.insert(imagingCriticalFindings).values(finding({
        acknowledgedBy: "u3", acknowledgedAt: new Date(),
      }) as never);
    });

    it("refuses a bill-decision kind outside the four and a half-resolution", async () => {
      const studyId = await withStudy();
      const decision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: "01BILL00000000000000001", studyId, kind: "contrast_not_given", ...over,
      });
      await expect(db.insert(imagingBillDecisions).values(decision({ kind: "goodwill" }) as never))
        .rejects.toThrow(/imaging_bill_decisions_kind_ck/);
      await expect(db.insert(imagingBillDecisions).values(decision({ resolvedBy: "u4" }) as never))
        .rejects.toThrow(/imaging_bill_decisions_resolved_ck/);
      await expect(db.insert(imagingBillDecisions).values(decision({
        resolvedBy: "u4", resolvedAt: new Date(),
      }) as never)).rejects.toThrow(/imaging_bill_decisions_resolution_ck/);
      await db.insert(imagingBillDecisions).values(decision({
        resolvedBy: "u4", resolvedAt: new Date(), resolution: "credit note raised",
      }) as never);
    });
  });
});
