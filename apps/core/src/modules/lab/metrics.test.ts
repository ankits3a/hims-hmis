import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabCatalogue, serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import {
  labItems, labQuickReports, labReportDeliveries, labReports, labResults, labSpecimenItems, labSpecimens,
  orderItems, orders, patients,
} from "../../kernel/db/schema";
import { createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { mkUser } from "../../../test/helpers/opd";
import { analytesFor } from "./catalogue";
import { labManifest } from "./manifest";
import { labMetrics } from "./metrics";
import type { Db } from "../../kernel/db/client";

/**
 * LAB NUMBERS (#768) — every count and every time on one fixture day whose timestamps are written
 * by hand, so each figure below is arithmetic on this file rather than on the workflow. The range is
 * passed explicitly; nothing here reads the clock.
 *
 *   O1  OPD (V…)   CBC + LFT, report v1 11:00 printed 11:30, AMENDED v2 12:00 sent 12:30
 *   O2  OPD        CBC, the ORDER cancelled — counted nowhere
 *   O3  walk-in    CBC (charge reason lab_walkin), published 10:30, never delivered
 *   O4  IPD (D…)   LFT + a CANCELLED CBC item, published 13:00, handed over 14:00
 *   O0  OPD        CBC placed the evening before — outside the day
 *   Q   quick mode CBC, no order, no visit (walk-in), collected 09:30, reported 10:00, handed over 10:20
 */
jest.setTimeout(120_000);

const DAY = "2026-03-10";
const at = (hhmm: string, day = DAY): Date => new Date(`${day}T${hhmm}:00+05:30`);

describe("labMetrics — counts and turnaround times on a known day", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  let cbc: string;
  let lft: string;
  let hb: string;
  let wbc: string;
  let alt: string;

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(labManifest);
    await syncPermissions(db, registry);
    await createRole(db, "catalogue_curator", "Catalogue curator");
    await grantPermissionToRole(db, registry, "catalogue_curator", "lab.catalogue.manage");
    const curator = await mkUser(db, "metrics.curator", ["catalogue_curator"]);
    await seedLabCatalogue(db, curator.actor);
    cbc = serviceIdForLabCode("CBC");
    lft = serviceIdForLabCode("LFT");
    const cbcAnalytes = await analytesFor(db, cbc);
    const lftAnalytes = await analytesFor(db, lft);
    hb = cbcAnalytes[0]!.id;
    wbc = cbcAnalytes[1]!.id;
    alt = lftAnalytes[0]!.id;

    const patientId = newId();
    await db.insert(patients).values({
      id: patientId, uhid: "HMS-00000901-1", name: "Sita Devi", sex: "female", administrativeGender: "female",
      createdBy: "t", updatedBy: "t",
    });

    let seq = 0;
    const order = async (encounterNo: string, placed: Date, cancelled = false): Promise<string> => {
      const id = newId();
      seq += 1;
      await db.insert(orders).values({
        id, orderNo: `L26031000${String(seq).padStart(2, "0")}`, orderGroupId: id, kind: "lab", patientId, encounterNo,
        serviceDate: DAY, priority: "routine", authority: "clinician", orderedByType: "user", orderedById: "t",
        status: cancelled ? "cancelled" : "open", closedAt: cancelled ? placed : null, placedAt: placed, createdAt: placed,
      });
      return id;
    };
    const item = async (
      orderId: string, serviceId: string, placed: Date,
      opts: { walkIn?: boolean; cancelled?: boolean; completedAt?: Date; started?: boolean } = {},
    ): Promise<string> => {
      const id = newId();
      await db.insert(orderItems).values({
        id, orderId, serviceId, createdAt: placed,
        status: opts.cancelled ? "cancelled" : opts.completedAt ? "completed" : opts.started ? "in_progress" : "placed",
        cancelledFrom: opts.cancelled ? "placed" : null, cancelledAt: opts.cancelled ? placed : null,
        startedAt: opts.completedAt || opts.started ? placed : null, completedAt: opts.completedAt ?? null,
      });
      await db.insert(labItems).values({
        orderItemId: id, instanceId: newId(), serviceId, chargeReason: opts.walkIn ? "lab_walkin" : "lab_desk", createdAt: placed,
      });
      return id;
    };
    let tube = 0;
    const specimen = async (orderGroupId: string, itemIds: string[], collected: Date, received: Date): Promise<string> => {
      const id = newId();
      tube += 1;
      await db.insert(labSpecimens).values({
        id, specimenNo: `S26031000${String(tube).padStart(2, "0")}`, orderGroupId, patientId, specimenType: "blood",
        container: "edta", status: "received", collectedBy: "t", collectedAt: collected, receivedBy: "t", receivedAt: received,
        serviceDate: DAY,
      });
      for (const orderItemId of itemIds) await db.insert(labSpecimenItems).values({ specimenId: id, orderItemId });
      return id;
    };
    const result = async (
      orderItemId: string, analyteId: string, specimenId: string, entered: Date, verified: Date | null, machine = false,
    ): Promise<void> => {
      await db.insert(labResults).values({
        id: newId(), orderItemId, analyteId, specimenId, valueNumeric: "1.0",
        enteredByType: machine ? "agent" : "user", enteredById: "t", enteredAt: entered,
        entryMode: machine ? "interface" : "manual",
        verificationStatus: verified ? "verified" : "unverified", verifiedBy: verified ? "p" : null, verifiedAt: verified,
      });
    };
    const report = async (orderId: string, version: number, published: Date, prior: string | null, status = "published"): Promise<string> => {
      const id = newId();
      await db.insert(labReports).values({
        id, orderId, version, status, snapshot: {}, signedBy: "p", signedAt: published, publishedAt: published,
        priorVersionId: prior, createdAt: published,
      });
      return id;
    };
    const deliver = async (reportId: string, channel: "print" | "whatsapp" | "in_person", when: Date): Promise<void> => {
      await db.insert(labReportDeliveries).values({
        id: newId(), reportId, channel, deliveredBy: "t", collectorIdentity: channel === "whatsapp" ? null : "self", at: when,
      });
    };

    /* O1 — OPD, CBC + LFT, amended once, delivered twice. */
    const o1 = await order("V2603100001", at("09:00"));
    const o1Cbc = await item(o1, cbc, at("09:00"), { completedAt: at("10:30") });
    const o1Lft = await item(o1, lft, at("09:00"), { started: true });
    const s1 = await specimen(o1, [o1Cbc], at("09:20"), at("09:40"));
    const s2 = await specimen(o1, [o1Lft], at("09:30"), at("09:50"));
    await result(o1Cbc, hb, s1, at("10:00"), at("10:30"));
    await result(o1Cbc, wbc, s1, at("10:00"), at("10:30"), true);
    await result(o1Lft, alt, s2, at("10:10"), null);
    const r1 = await report(o1, 1, at("11:00"), null, "superseded");
    await deliver(r1, "print", at("11:30"));
    const r2 = await report(o1, 2, at("12:00"), r1, "amended");
    await deliver(r2, "whatsapp", at("12:30"));

    /* O2 — a cancelled order, with a cancelled item. Counted nowhere. */
    const o2 = await order("V2603100002", at("09:05"), true);
    await item(o2, cbc, at("09:05"), { cancelled: true });

    /* O3 — walk-in, CBC, published, never delivered. */
    const o3 = await order("V2603100003", at("09:10"));
    const o3Cbc = await item(o3, cbc, at("09:10"), { walkIn: true, completedAt: at("10:20") });
    const s3 = await specimen(o3, [o3Cbc], at("09:25"), at("09:45"));
    await result(o3Cbc, hb, s3, at("10:05"), at("10:20"));
    await report(o3, 1, at("10:30"), null);

    /* O4 — IPD (day care), LFT plus a cancelled CBC item; no result keyed. */
    const o4 = await order("D2603100001", at("09:20"));
    const o4Lft = await item(o4, lft, at("09:20"));
    await item(o4, cbc, at("09:20"), { cancelled: true });
    await specimen(o4, [o4Lft], at("09:40"), at("10:00"));
    const r4 = await report(o4, 1, at("13:00"), null);
    await deliver(r4, "in_person", at("14:00"));

    /* O0 — the evening before, at 23:00 IST: outside the day (and 17:30 UTC, still inside it in UTC). */
    const o0 = await order("V2603090009", at("23:00", "2026-03-09"));
    await item(o0, cbc, at("23:00", "2026-03-09"));

    /* Q — a quick-mode report with no order and no visit. */
    await db.insert(labQuickReports).values({
      id: newId(), patientId, encounterNo: null, tests: [{ serviceId: cbc, code: "CBC", nameEn: "CBC" }],
      status: "reported", collectedAt: at("09:30"), collectedBy: "t", reportedAt: at("10:00"), reportedBy: "t",
      handedOverAt: at("10:20"), handedOverBy: "t", updatedBy: "t",
    });
  });

  it("counts every order, test and report of the day exactly — the cancelled order nowhere, the amended report once", async () => {
    const m = await labMetrics(db, { from: DAY, to: DAY });
    expect(m.totals).toEqual({ orders: 3, tests: 4, published: 4, delivered: 3 });
    expect(m.bySource).toEqual([
      { source: "opd", orders: 1, tests: 2, published: 1, delivered: 1 },
      { source: "ipd", orders: 1, tests: 1, published: 1, delivered: 1 },
      { source: "walk_in", orders: 1, tests: 1, published: 2, delivered: 1 },
    ]);
    const byTest = Object.fromEntries(m.byTest.map((t) => [t.code, { orders: t.orders, tests: t.tests, published: t.published, delivered: t.delivered }]));
    expect(byTest).toEqual({
      CBC: { orders: 2, tests: 2, published: 3, delivered: 2 },
      LFT: { orders: 2, tests: 2, published: 2, delivered: 2 },
    });
  });

  it("the day before is a different day: O0 counts there and nothing of the fixture day does", async () => {
    const m = await labMetrics(db, { from: "2026-03-09", to: "2026-03-09" });
    expect(m.totals).toEqual({ orders: 1, tests: 1, published: 0, delivered: 0 });
  });

  it("report times: placed → published, received → published, published → first delivery (median, p90, n)", async () => {
    const m = await labMetrics(db, { from: DAY, to: DAY });
    expect(m.reportTimes).toEqual({
      placedToPublished: { n: 3, medianMin: 120, p90Min: 200 },
      receivedToPublished: { n: 4, medianMin: 57.5, p90Min: 147 },
      publishedToDelivered: { n: 3, medianMin: 30, p90Min: 54 },
    });
  });

  it("each test shows a time per step; a missing timestamp leaves only that step out", async () => {
    const m = await labMetrics(db, { from: DAY, to: DAY });
    const byCode = Object.fromEntries(m.testTimes.map((t) => [t.code, t]));
    expect(byCode["CBC"]).toMatchObject({
      placedToCollected: { n: 2, medianMin: 17.5, p90Min: 19.5 },
      collectedToReceived: { n: 2, medianMin: 20, p90Min: 20 },
      receivedToEntered: { n: 2, medianMin: 20, p90Min: 20 },
      enteredToVerified: { n: 2, medianMin: 22.5, p90Min: 28.5 },
      placedToVerified: { n: 2, medianMin: 80, p90Min: 88 },
    });
    expect(byCode["LFT"]).toMatchObject({
      placedToCollected: { n: 2, medianMin: 25, p90Min: 29 },
      collectedToReceived: { n: 2, medianMin: 20, p90Min: 20 },
      receivedToEntered: { n: 1, medianMin: 20, p90Min: 20 },
      enteredToVerified: { n: 0, medianMin: null, p90Min: null },
      placedToVerified: { n: 0, medianMin: null, p90Min: null },
    });
  });

  it("each parameter shows entered and verified times, machine apart from manual", async () => {
    const m = await labMetrics(db, { from: DAY, to: DAY });
    const by = Object.fromEntries(m.parameterTimes.map((p) => [`${p.analyteId}|${p.mode}`, p]));
    expect(by[`${hb}|manual`]).toMatchObject({
      receivedToEntered: { n: 2, medianMin: 20, p90Min: 20 },
      enteredToVerified: { n: 2, medianMin: 22.5, p90Min: 28.5 },
    });
    expect(by[`${wbc}|machine`]).toMatchObject({
      receivedToEntered: { n: 1, medianMin: 20, p90Min: 20 },
      enteredToVerified: { n: 1, medianMin: 30, p90Min: 30 },
    });
    expect(by[`${alt}|manual`]).toMatchObject({
      receivedToEntered: { n: 1, medianMin: 20, p90Min: 20 },
      enteredToVerified: { n: 0, medianMin: null, p90Min: null },
    });
    expect(m.parameterTimes).toHaveLength(3);
  });
});
