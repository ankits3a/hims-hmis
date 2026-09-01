import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  imagingBillDecisions, imagingCriticalFindings, imagingDefinitions, imagingReports,
  imagingSafetyScreenings, imagingStudies, orderItems, orders, patients,
  pcpndtFormF, pcpndtFormFSerials, pcpndtRegisteredMachines, pcpndtRegisteredPersons,
  pcpndtRegistrations, resources, services, users,
} from "./index";
import type { Db } from "../client";

/**
 * PLAN 18a T1 — the PCPNDT register's structural guarantees, executed.
 *
 * Two of these carry a criminal statute rather than a data-quality preference, and they are the
 * two a reviewer should read first:
 *
 *   · **`pcpndt_form_f_machine_serial_ux`** — I6's gap-free register, per machine per year. The
 *     concurrency proof that twelve simultaneous opens mint 1..12 is T6 A1's and lives with the
 *     code; what is proved HERE is that the database refuses a duplicate at all, which is the
 *     property that makes the counter's correctness checkable by an inspector.
 *   · **`pcpndt_form_f_forbid_mutation`** — A4. A recorded form's sections, serial, person and
 *     patient cannot be edited and the row cannot be deleted; `verified_by`/`verified_at` are the
 *     two columns that may ever move, because the in-charge counter-signs what somebody else wrote.
 *
 * The LAST describe in this file is the one the author prompt made executable: **a table absent
 * from `truncateAll` is never emptied.** It inserts one row into all eleven tables this phase adds,
 * truncates, and counts zero — which is the only form of that claim that cannot go stale.
 */
describe("pcpndt — 0047 structure", () => {
  const PATIENT = "01PATIENT0000000000000001";
  const SERVICE = "01SERVICE0000000000000001";
  const ORDER = "01ORDER00000000000000001";
  const ITEM = "01ITEM000000000000000001";
  const DEVICE = "01DEVICE00000000000000001";
  const DEVICE2 = "01DEVICE00000000000000002";
  const USER = "01USER0000000000000000001";
  const USER2 = "01USER0000000000000000002";
  const REG = "01REG00000000000000000001";
  const REG2 = "01REG00000000000000000002";
  const MACHINE = "01MACHINE000000000000001";
  const PERSON = "01PERSON0000000000000001";
  const STUDY = "01STUDY00000000000000001";

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER, username: "dr.sonologist", passwordHash: "x", fullName: "Dr S Rao", createdBy: "u1", updatedBy: "u1" },
      { id: USER2, username: "dr.incharge", passwordHash: "x", fullName: "Dr M Iyer", createdBy: "u1", updatedBy: "u1" },
    ] as never);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi",
      sex: "female", administrativeGender: "female", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(resources).values([
      { id: DEVICE, kind: "device", code: "USG-1", name: "Ultrasound 1", status: "available", createdBy: "u1", updatedBy: "u1" },
      { id: DEVICE2, kind: "device", code: "USG-2", name: "Ultrasound 2", status: "available", createdBy: "u1", updatedBy: "u1" },
    ]);
    await db.insert(pcpndtRegistrations).values({
      id: REG, site: "main", registrationNo: "PCPNDT/MH/2026/0001",
      validFrom: "2026-01-01", validTo: "2028-12-31", inchargeUserId: USER2, createdBy: "u1",
    });
    await db.insert(pcpndtRegisteredMachines).values({
      id: MACHINE, registrationId: REG, deviceResourceId: DEVICE,
      make: "GE", model: "Voluson S8", serial: "SN-77421", formBRef: "FORM-B/2026/11", createdBy: "u1",
    });
    await db.insert(pcpndtRegisteredPersons).values({
      id: PERSON, registrationId: REG, userId: USER, qualification: "MD Radiodiagnosis",
      councilRegNo: "MMC/2011/44821", createdBy: "u1",
    });
  });

  describe("pcpndt_registrations", () => {
    it("refuses a status outside the three and a window that ends before it begins", async () => {
      const reg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: REG2, site: "annexe", registrationNo: "PCPNDT/MH/2026/0002",
        validFrom: "2026-01-01", validTo: "2027-12-31", createdBy: "u1", ...over,
      });
      await expect(db.insert(pcpndtRegistrations).values(reg({ status: "lapsed" }) as never))
        .rejects.toThrow(/pcpndt_registrations_status_ck/);
      await expect(db.insert(pcpndtRegistrations).values(reg({ validTo: "2025-12-31" }) as never))
        .rejects.toThrow(/pcpndt_registrations_validity_ck/);
      await db.insert(pcpndtRegistrations).values(reg() as never);
    });

    it("refuses a duplicate registration number", async () => {
      await expect(db.insert(pcpndtRegistrations).values({
        id: REG2, site: "annexe", registrationNo: "PCPNDT/MH/2026/0001",
        validFrom: "2026-01-01", validTo: "2027-12-31", createdBy: "u1",
      } as never)).rejects.toThrow(/registration_no/);
    });
  });

  describe("pcpndt_registered_machines and _persons", () => {
    /**
     * The index is what stops `activeRegistrationFor` having two answers for one machine — which,
     * with a criminal statute on the other end, is §2.54's mechanism at its most expensive.
     */
    it("refuses a SECOND ACTIVE registration of one device, and permits a deactivated one beside it", async () => {
      await db.insert(pcpndtRegistrations).values({
        id: REG2, site: "annexe", registrationNo: "PCPNDT/MH/2026/0002",
        validFrom: "2026-01-01", validTo: "2027-12-31", createdBy: "u1",
      } as never);
      await expect(db.insert(pcpndtRegisteredMachines).values({
        id: "01MACHINE000000000000002", registrationId: REG2, deviceResourceId: DEVICE,
        make: "GE", model: "Voluson S8", serial: "SN-77421", createdBy: "u1",
      } as never)).rejects.toThrow(/pcpndt_registered_machines_device_active_ux/);

      await db.update(pcpndtRegisteredMachines).set({ active: false }).where(sql`id = ${MACHINE}`);
      await db.insert(pcpndtRegisteredMachines).values({
        id: "01MACHINE000000000000002", registrationId: REG2, deviceResourceId: DEVICE,
        make: "GE", model: "Voluson S8", serial: "SN-77421", createdBy: "u1",
      } as never);
      expect(await db.select().from(pcpndtRegisteredMachines)).toHaveLength(2);
    });

    it("refuses the same person twice on one registration, and PERMITS them on a second", async () => {
      await expect(db.insert(pcpndtRegisteredPersons).values({
        id: "01PERSON0000000000000002", registrationId: REG, userId: USER,
        qualification: "MD Radiodiagnosis", createdBy: "u1",
      } as never)).rejects.toThrow(/pcpndt_registered_persons_registration_user_ux/);

      await db.insert(pcpndtRegistrations).values({
        id: REG2, site: "annexe", registrationNo: "PCPNDT/MH/2026/0002",
        validFrom: "2026-01-01", validTo: "2027-12-31", createdBy: "u1",
      } as never);
      await db.insert(pcpndtRegisteredPersons).values({
        id: "01PERSON0000000000000002", registrationId: REG2, userId: USER,
        qualification: "MD Radiodiagnosis", createdBy: "u1",
      } as never);
      expect(await db.select().from(pcpndtRegisteredPersons)).toHaveLength(2);
    });
  });

  describe("pcpndt_form_f", () => {
    const form = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "01FORMF00000000000000001",
      serialNo: 1, serialYear: 2026, machineId: MACHINE, personId: PERSON,
      /**
       * F61 — `device_resource_id` is NOT NULL on this table now: the serial counter is keyed on
       * the PHYSICAL machine rather than on a registration-scoped row, because a renewal mints a
       * new machine row for the same scanner and restarted the year's book at 1.
       *
       * It belongs in this HELPER and not in the individual cases, for the reason F2 recorded about
       * this very table: **the row must otherwise be VALID for a constraint assertion to be about
       * that constraint.** Without it every case below stopped asserting its own CHECK and started
       * asserting a NOT NULL violation instead — which is how the full pass reported nine failures
       * that were all one missing column.
       */
      deviceResourceId: DEVICE,
      studyId: STUDY, patientId: PATIENT, indicationCode: "obstetric_dating",
      sections: { A: {}, B: {}, C: {}, D: {}, E: {}, F: {}, G: {} },
      declaration: { signature_kind: "signature" },
      referral: { self_referral: false },
      applicability: "pregnant",
      ...over,
    });

    it("refuses an applicability, a status and a serial outside their vocabularies", async () => {
      await expect(db.insert(pcpndtFormF).values(form({ applicability: "maybe" }) as never))
        .rejects.toThrow(/pcpndt_form_f_applicability_ck/);
      // The row must otherwise be VALID or a different constraint answers first: any status that is
      // not `open` also trips `pcpndt_form_f_recorded_shape_ck` unless the form is signed, and
      // Postgres does not promise which of two violated CHECKs it reports. Signing it isolates the
      // vocabulary claim, which is what this assertion is actually about.
      await expect(db.insert(pcpndtFormF).values(form({
        status: "draft", signedBy: USER, signedAt: new Date(),
      }) as never)).rejects.toThrow(/pcpndt_form_f_status_ck/);
      await expect(db.insert(pcpndtFormF).values(form({ serialNo: 0 }) as never))
        .rejects.toThrow(/pcpndt_form_f_serial_ck/);
    });

    it("refuses a RECORDED form with no signer or no instant — the shape a declaration must have", async () => {
      await expect(db.insert(pcpndtFormF).values(form({ status: "recorded" }) as never))
        .rejects.toThrow(/pcpndt_form_f_recorded_shape_ck/);
      await expect(db.insert(pcpndtFormF).values(form({ status: "recorded", signedBy: USER }) as never))
        .rejects.toThrow(/pcpndt_form_f_recorded_shape_ck/);
      await db.insert(pcpndtFormF).values(form({
        status: "recorded", signedBy: USER, signedAt: new Date(),
      }) as never);
    });

    it("refuses verification of a form that is not yet recorded — a counter-signature on a blank", async () => {
      await expect(db.insert(pcpndtFormF).values(form({
        verifiedBy: USER2, verifiedAt: new Date(),
      }) as never)).rejects.toThrow(/pcpndt_form_f_verify_after_record_ck/);
      await expect(db.insert(pcpndtFormF).values(form({ verifiedBy: USER2 }) as never))
        .rejects.toThrow(/pcpndt_form_f_verified_ck/);
    });

    /** I6, at the layer an inspector can check without reading any code. */
    it("refuses a DUPLICATE serial on one machine in one year, and permits the same number next year", async () => {
      await db.insert(pcpndtFormF).values(form() as never);
      await expect(db.insert(pcpndtFormF).values(form({
        id: "01FORMF00000000000000002", studyId: "01STUDY00000000000000002",
      }) as never)).rejects.toThrow(/pcpndt_form_f_machine_serial_ux/);
      await db.insert(pcpndtFormF).values(form({
        id: "01FORMF00000000000000002", studyId: "01STUDY00000000000000002", serialYear: 2027,
      }) as never);
    });

    /** N1 — the third growth scan is a third STUDY and a third form, never a second form on one scan. */
    it("refuses a second form for one study", async () => {
      await db.insert(pcpndtFormF).values(form() as never);
      await expect(db.insert(pcpndtFormF).values(form({
        id: "01FORMF00000000000000002", serialNo: 2,
      }) as never)).rejects.toThrow(/pcpndt_form_f_study_ux/);
    });

    /**
     * A4. The trigger is hand-carried SQL — drizzle emits no trigger — so this is the only place it
     * is proved, and it is proved by issuing each UPDATE. `sections` is listed first because it
     * carries Part F, the indication for the scan, which is the field an inspection turns on.
     */
    it("FORBIDS updating a form's sections, serial, person, patient or declaration, and forbids DELETE", async () => {
      await db.insert(pcpndtFormF).values(form({
        status: "recorded", signedBy: USER, signedAt: new Date(),
      }) as never);
      /**
       * EVERY VALUE BELOW MUST DIFFER FROM THE ROW'S OWN, and that is a property of the trigger
       * rather than a detail of the fixture. It compares WHOLE ROWS with the two verification keys
       * removed, so `set person_id = <the id it already has>` mutates nothing and is correctly
       * PERMITTED — proved by execution against this database, not reasoned about. An earlier draft
       * of this test asserted exactly that no-op and failed, which is the assertion catching the
       * test rather than the code.
       *
       * The two FK columns are pointed at ids that exist nowhere on purpose: a BEFORE ROW trigger
       * runs ahead of constraint checking, so the freeze is what answers, not the foreign key —
       * also confirmed by execution rather than assumed.
       */
      for (const [column, value] of [
        ["sections", `'{"F":{"indication":"rewritten"}}'::jsonb`],
        ["serial_no", `9`],
        ["serial_year", `2027`],
        ["person_id", `'01PERSON00000000000NOPE1'`],
        ["patient_id", `'01PATIENT0000000000NOPE1'`],
        ["declaration", `'{"signature_kind":"thumb"}'::jsonb`],
        ["indication_code", `'other'`],
        ["study_id", `'01STUDY00000000000000009'`],
        ["status", `'open'`],
      ] as const) {
        await expect(db.execute(sql.raw(
          `update pcpndt_form_f set ${column} = ${value} where id = '01FORMF00000000000000001'`,
        ))).rejects.toThrow(/pcpndt_form_f_immutable/);
      }
      await expect(db.execute(sql`delete from pcpndt_form_f where id = '01FORMF00000000000000001'`))
        .rejects.toThrow(/pcpndt_form_f_immutable/);
    });

    /**
     * The other half of the whole-row comparison, and it is worth its own assertion: the trigger
     * freezes CHANGE, not the statement. A writer that re-sends a row's own values has mutated
     * nothing and is not refused — which is why the freeze test above must use different values.
     */
    it("PERMITS an UPDATE that changes nothing — the trigger freezes change, not statements", async () => {
      await db.insert(pcpndtFormF).values(form({
        status: "recorded", signedBy: USER, signedAt: new Date(),
      }) as never);
      await db.execute(sql.raw(
        `update pcpndt_form_f set person_id = '${PERSON}', serial_no = 1 where id = '01FORMF00000000000000001'`,
      ));
      const [row] = await db.select().from(pcpndtFormF);
      expect(row!.personId).toBe(PERSON);
    });

    it("PERMITS the two columns the in-charge may set — verified_by and verified_at, together", async () => {
      await db.insert(pcpndtFormF).values(form({
        status: "recorded", signedBy: USER, signedAt: new Date(),
      }) as never);
      await db.update(pcpndtFormF)
        .set({ verifiedBy: USER2, verifiedAt: new Date() })
        .where(sql`id = '01FORMF00000000000000001'`);
      const [row] = await db.select().from(pcpndtFormF);
      expect(row!.verifiedBy).toBe(USER2);
      expect(row!.verifiedAt).not.toBeNull();
    });
  });

  /**
   * ═══ THE AUTHOR PROMPT'S RULE, MADE EXECUTABLE ═══
   *
   * *"A table absent from `truncateAll` is NEVER EMPTIED"* — and a table whose parent is truncated
   * must be named in the parent's OWN statement, or Postgres refuses the whole statement outright
   * with `cannot truncate a table referenced in a foreign key constraint`. Both failure modes are
   * silent in exactly the way a comment cannot catch: the first leaks rows into the next suite, the
   * second breaks every suite in the workspace from the first `truncateAll`.
   *
   * So: one row in each of the eleven tables this phase adds, `truncateAll`, count zero.
   */
  describe("truncateAll empties every one of the eleven tables this phase adds", () => {
    it("inserts one row in each, truncates, and counts zero", async () => {
      await db.insert(services).values({
        id: SERVICE, code: "USG-OBS", name: "Obstetric ultrasound", category: "investigation",
        createdBy: "u1", updatedBy: "u1",
      });
      await db.insert(orders).values({
        id: ORDER, orderNo: "R2608290001", orderGroupId: "01GROUP00000000000000001",
        kind: "imaging", patientId: PATIENT, encounterNo: "V2608290001", serviceDate: "2026-08-29",
        priority: "routine", authority: "clinician", orderedByType: "user", orderedById: "u1",
        orderingClinicianId: "u1", indication: "dating scan",
        placedAt: new Date("2026-08-29T04:00:00.000Z"),
      });
      await db.insert(orderItems).values({ id: ITEM, orderId: ORDER, serviceId: SERVICE });
      await db.insert(imagingStudies).values({
        id: STUDY, orderItemId: ITEM, orderId: ORDER, patientId: PATIENT,
        encounterNo: "V2608290001", studyTypeCode: "USG-OBS", serviceId: SERVICE,
        accessionNo: "X2608290001", priority: "routine", workflowInstanceId: "01WFI0000000000000000001",
        deviceResourceId: DEVICE,
      } as never);
      await db.insert(imagingSafetyScreenings).values({
        id: "01GATE00000000000000001", studyId: STUDY, kind: "form_f",
        workflowInstanceId: "01WFI0000000000000000002",
      } as never);
      await db.insert(imagingDefinitions).values({
        id: "01DEF0000000000000000001", kind: "study_types", version: 1, body: {}, draftedBy: "u1",
      } as never);
      await db.insert(imagingReports).values({
        id: "01REPORT0000000000000001", studyId: STUDY, version: 1,
        templateKey: "usg_obstetric", body: {},
      } as never);
      await db.insert(imagingCriticalFindings).values({
        id: "01CRIT00000000000000001", reportId: "01REPORT0000000000000001", category: "red",
      } as never);
      await db.insert(imagingBillDecisions).values({
        id: "01BILL00000000000000001", studyId: STUDY, kind: "acquired_unbilled",
      } as never);
      /** F61 — the counter is keyed on the physical device; `machineId` rides along as provenance. */
      await db.insert(pcpndtFormFSerials).values({
        deviceResourceId: DEVICE, machineId: MACHINE, year: 2026, nextNo: 2,
      } as never);
      await db.insert(pcpndtFormF).values({
        id: "01FORMF00000000000000001", serialNo: 1, serialYear: 2026, machineId: MACHINE,
        deviceResourceId: DEVICE,
        personId: PERSON, studyId: STUDY, patientId: PATIENT, indicationCode: "obstetric_dating",
        sections: {}, declaration: { signature_kind: "signature" }, referral: { self_referral: false },
        applicability: "pregnant",
      } as never);

      const tables = {
        imaging_studies: imagingStudies,
        imaging_safety_screenings: imagingSafetyScreenings,
        imaging_definitions: imagingDefinitions,
        imaging_reports: imagingReports,
        imaging_critical_findings: imagingCriticalFindings,
        imaging_bill_decisions: imagingBillDecisions,
        pcpndt_registrations: pcpndtRegistrations,
        pcpndt_registered_machines: pcpndtRegisteredMachines,
        pcpndt_registered_persons: pcpndtRegisteredPersons,
        pcpndt_form_f_serials: pcpndtFormFSerials,
        pcpndt_form_f: pcpndtFormF,
      };

      // Every one of the eleven holds a row BEFORE — otherwise "empty afterwards" proves nothing.
      const before: Record<string, number> = {};
      for (const [name, table] of Object.entries(tables)) {
        before[name] = (await db.select().from(table as never)).length;
      }
      expect(before).toEqual(Object.fromEntries(Object.keys(tables).map((k) => [k, 1])));

      await truncateAll(db);

      const after: Record<string, number> = {};
      for (const [name, table] of Object.entries(tables)) {
        after[name] = (await db.select().from(table as never)).length;
      }
      expect(after).toEqual(Object.fromEntries(Object.keys(tables).map((k) => [k, 0])));
    });
  });
});
