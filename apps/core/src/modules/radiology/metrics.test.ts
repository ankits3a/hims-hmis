import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedActiveStudyTypes, studyTypeRow } from "../../../test/helpers/radiology";
import {
  imagingReportHandovers, imagingReports, imagingStudies, orderItems, orders, patients, services,
} from "../../kernel/db/schema";
import { radiologyMetrics } from "./metrics";
import type { Db } from "../../kernel/db/client";

/**
 * IMAGING NUMBERS (#777) — every count and every time on one fixture day whose timestamps are written
 * by hand, so each figure below is arithmetic on this file rather than on the workflow. The range is
 * passed explicitly; nothing here reads the clock.
 *
 *   R1  OPD        USG + X-ray placed 09:00
 *       S1a USG    acquired 09:30, v1 signed 10:00 handed over 10:30, AMENDED v2 11:00 handed over 11:30
 *       S1b X-ray  acquired 10:00, signed 10:40, never handed over
 *   R2  IPD (D…)   CT placed 08:00, acquired 09:00; a RESIDENT signed 09:30 (co-signed), the consultant 10:00;
 *                  handed over 12:00
 *   R3  walk-in    USG on an outside slip, placed 10:00, acquired 10:20, signed 10:50, handed over 11:10
 *   R4  OPD        USG, the ORDER cancelled — counted nowhere
 *   R5  OPD        X-ray, its only ITEM cancelled — counted nowhere
 *   R7  IPD        CT placed 12:00, acquired 12:30, only a resident's signature waiting (13:00): not signed
 *   R0  OPD        USG placed the evening before (23:00), acquired 08:30, signed 09:00, handed over 09:15
 *   R6  OPD        X-ray all done the day before; handed over 08:00 on the day — delivered, not signed
 */
jest.setTimeout(120_000);

const DAY = "2026-03-10";
const PREV = "2026-03-09";
const at = (hhmm: string, day = DAY): Date => new Date(`${day}T${hhmm}:00+05:30`);

describe("radiologyMetrics — counts and turnaround times on a known day", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const svc: Record<string, string> = {};
    for (const code of ["USG-ABDO", "XR-CHEST", "CT-HEAD"]) {
      svc[code] = newId();
      await db.insert(services).values({ id: svc[code]!, code: `RAD-${code}`, name: `Imaging ${code}`, category: "investigation", createdBy: "t", updatedBy: "t" });
    }
    await seedActiveStudyTypes(db, [
      studyTypeRow({ code: "USG-ABDO", service_id: svc["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: svc["XR-CHEST"]!, modality: "xray" }),
      studyTypeRow({ code: "CT-HEAD", service_id: svc["CT-HEAD"]!, modality: "ct" }),
    ], at("00:00", PREV));

    const patientId = newId();
    await db.insert(patients).values({
      id: patientId, uhid: "HMS-00000902-1", name: "Test Patient", sex: "female", administrativeGender: "female",
      createdBy: "t", updatedBy: "t",
    });

    let seq = 0;
    const order = async (encounterNo: string, placed: Date, opts: { cancelled?: boolean; walkIn?: boolean } = {}): Promise<string> => {
      const id = newId();
      seq += 1;
      await db.insert(orders).values({
        id, orderNo: `R26031000${String(seq).padStart(2, "0")}`, orderGroupId: id, kind: "imaging", patientId, encounterNo,
        serviceDate: DAY, priority: "routine", authority: opts.walkIn ? "external_prescription" : "clinician",
        externalReferrerId: opts.walkIn ? "referrer-1" : null, orderedByType: "user", orderedById: "t",
        status: opts.cancelled ? "cancelled" : "open", closedAt: opts.cancelled ? placed : null, placedAt: placed, createdAt: placed,
      });
      return id;
    };
    /** One item and its study. `acquired` null leaves it unacquired; `cancelled` cancels both. */
    const study = async (
      orderId: string, encounterNo: string, code: "USG-ABDO" | "XR-CHEST" | "CT-HEAD", placed: Date,
      opts: { acquired?: Date; cancelled?: boolean } = {},
    ): Promise<string> => {
      const itemId = newId();
      await db.insert(orderItems).values({
        id: itemId, orderId, serviceId: svc[code]!, createdAt: placed,
        status: opts.cancelled ? "cancelled" : "placed",
        cancelledFrom: opts.cancelled ? "placed" : null, cancelledAt: opts.cancelled ? placed : null,
      });
      const id = newId();
      await db.insert(imagingStudies).values({
        id, orderItemId: itemId, orderId, patientId, encounterNo, studyTypeCode: code, serviceId: svc[code]!,
        accessionNo: `X${String(seq)}${id.slice(-6)}`, priority: "routine",
        status: opts.cancelled ? "cancelled" : opts.acquired ? "acquired" : "scheduled",
        workflowInstanceId: newId(), acquiredAt: opts.acquired ?? null, imageSource: opts.acquired ? "no_pacs_images" : null,
        createdAt: placed,
      });
      return id;
    };
    const report = async (
      studyId: string, version: number, status: string, signed: Date, supersedes: string | null = null,
    ): Promise<string> => {
      const id = newId();
      await db.insert(imagingReports).values({
        id, studyId, version, status, templateKey: "default", body: {}, signerId: "rad", signedAt: signed, secondFactorAt: signed,
        supersedesId: supersedes, amendmentReason: supersedes === null ? null : "typo in impression", createdAt: signed,
      });
      return id;
    };
    const handOver = async (reportId: string, studyId: string, when: Date): Promise<void> => {
      await db.insert(imagingReportHandovers).values({
        id: newId(), reportId, studyId, collectorKind: "patient", handedBy: "t", handedAt: when,
      });
    };

    /* R1 — OPD, two studies; the USG amended and handed over twice, the X-ray never handed over. */
    const r1 = await order("V2603100001", at("09:00"));
    const s1a = await study(r1, "V2603100001", "USG-ABDO", at("09:00"), { acquired: at("09:30") });
    const s1b = await study(r1, "V2603100001", "XR-CHEST", at("09:00"), { acquired: at("10:00") });
    const v1 = await report(s1a, 1, "superseded", at("10:00"));
    await handOver(v1, s1a, at("10:30"));
    const v2 = await report(s1a, 2, "signed", at("11:00"), v1);
    await handOver(v2, s1a, at("11:30"));
    await report(s1b, 1, "signed", at("10:40"));

    /* R2 — IPD CT: the resident's row was co-signed; the consultant's signature is the report. */
    const r2 = await order("D2603100001", at("08:00"));
    const s2 = await study(r2, "D2603100001", "CT-HEAD", at("08:00"), { acquired: at("09:00") });
    await report(s2, 1, "cosigned", at("09:30"));
    const s2v2 = await report(s2, 2, "signed", at("10:00"));
    await handOver(s2v2, s2, at("12:00"));

    /* R3 — walk-in on an outside slip. */
    const r3 = await order("V2603100003", at("10:00"), { walkIn: true });
    const s3 = await study(r3, "V2603100003", "USG-ABDO", at("10:00"), { acquired: at("10:20") });
    const s3v = await report(s3, 1, "signed", at("10:50"));
    await handOver(s3v, s3, at("11:10"));

    /* R4 — a cancelled order; R5 — an order whose only item is cancelled. Counted nowhere. */
    const r4 = await order("V2603100004", at("09:00"), { cancelled: true });
    await study(r4, "V2603100004", "USG-ABDO", at("09:00"), { cancelled: true });
    const r5 = await order("V2603100005", at("11:00"));
    await study(r5, "V2603100005", "XR-CHEST", at("11:00"), { cancelled: true });

    /* R7 — a resident's signature waiting for a consultant is not a signed report. */
    const r7 = await order("D2603100007", at("12:00"));
    const s7 = await study(r7, "D2603100007", "CT-HEAD", at("12:00"), { acquired: at("12:30") });
    await report(s7, 1, "awaiting_cosign", at("13:00"));

    /* R0 — placed the evening before; everything else on the day. */
    const r0 = await order("V2603090009", at("23:00", PREV));
    const s0 = await study(r0, "V2603090009", "USG-ABDO", at("23:00", PREV), { acquired: at("08:30") });
    const s0v = await report(s0, 1, "signed", at("09:00"));
    await handOver(s0v, s0, at("09:15"));

    /* R6 — done and signed the day before, handed over on the day. */
    const r6 = await order("V2603090006", at("10:00", PREV));
    const s6 = await study(r6, "V2603090006", "XR-CHEST", at("10:00", PREV), { acquired: at("10:30", PREV) });
    const s6v = await report(s6, 1, "signed", at("11:00", PREV));
    await handOver(s6v, s6, at("08:00"));
  });

  it("counts orders, studies done, reports signed and delivered — cancelled nowhere, an amended report once, a resident's signature not at all", async () => {
    const m = await radiologyMetrics(db, { from: DAY, to: DAY });
    expect(m.totals).toEqual({ orders: 4, studies: 6, signed: 5, delivered: 5 });
    expect(m.bySource).toEqual([
      { source: "opd", orders: 1, studies: 3, signed: 3, delivered: 3 },
      { source: "ipd", orders: 2, studies: 2, signed: 1, delivered: 1 },
      { source: "walk_in", orders: 1, studies: 1, signed: 1, delivered: 1 },
    ]);
    expect(m.byModality).toEqual([
      { modality: "xray", orders: 1, studies: 1, signed: 1, delivered: 1 },
      { modality: "usg", orders: 2, studies: 3, signed: 3, delivered: 3 },
      { modality: "ct", orders: 2, studies: 2, signed: 1, delivered: 1 },
      { modality: "mri", orders: 0, studies: 0, signed: 0, delivered: 0 },
      { modality: "mammography", orders: 0, studies: 0, signed: 0, delivered: 0 },
    ]);
  });

  it("the day before is a different day: R0's order and R6's whole study count there, nothing of the fixture day does", async () => {
    const m = await radiologyMetrics(db, { from: PREV, to: PREV });
    expect(m.totals).toEqual({ orders: 2, studies: 1, signed: 1, delivered: 0 });
  });

  it("times: placed → done, done → signed, signed → first hand-over, placed → signed (median, p90, n)", async () => {
    const m = await radiologyMetrics(db, { from: DAY, to: DAY });
    expect(m.times).toEqual({
      placedToDone: { n: 6, medianMin: 45, p90Min: 315 },
      doneToSigned: { n: 5, medianMin: 30, p90Min: 52 },
      signedToDelivered: { n: 4, medianMin: 25, p90Min: 93 },
      placedToSigned: { n: 5, medianMin: 100, p90Min: 408 },
    });
  });

  it("an empty day is zeros and no times — a dash, never a zero minute", async () => {
    const m = await radiologyMetrics(db, { from: "2026-03-20", to: "2026-03-20" });
    expect(m.totals).toEqual({ orders: 0, studies: 0, signed: 0, delivered: 0 });
    const none = { n: 0, medianMin: null, p90Min: null };
    expect(m.times).toEqual({ placedToDone: none, doneToSigned: none, signedToDelivered: none, placedToSigned: none });
  });
});
