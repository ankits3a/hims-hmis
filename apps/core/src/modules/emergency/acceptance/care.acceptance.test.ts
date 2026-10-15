import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { alerts, erChargeLines, invoices, labAnalytes, orderItems, orders, patients } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { collect, enterResult, printLabels, receive } from "../../lab";
import { seedOrgDepartments } from "../../roster";
import { serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ER_LAB_PRICE, mkErCareWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, callSpecialty, declareStabilised, giveErDose, issueErMed, placeErOrder, placeInBay, readErBoard, recordConsent,
  recordErNote, recordErVitals, recordProcedure, registerErChargeSink, registerErEncounterResolver, registerUnidentified,
  sweepErCareClocks, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErCareWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 3 (#810, decision 0076) — "DONE MEANS" FOR er-care (spec SPEC-emergency-2026-10-15 §7). Every check calls the
 * INTENT functions, never a screen; every clock instant is passed in.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 3 er-care — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErCareWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const unknown = (now = new Date()) => registerUnidentified(db, w.erDesk, {
    idempotencyKey: key(), sex: "male", ageBand: "young_adult", arrivalMode: "ambulance_108",
  }, { now });
  const order = (episodeId: string, codes: string[], now = new Date()) => placeErOrder(db, w.erDoctor, {
    idempotencyKey: key(), episodeId, serviceIds: codes.map(serviceIdForLabCode), indication: "Chest pain, sweating",
  }, { now, orderKinds: w.decls });

  it("(a) an ER test order goes through orderTests with STAT priority and lands on the ER charge sink — no invoice, no held report", async () => {
    const u = await unknown();
    const r = await order(u.episodeId, ["CBC", "RFT", "ESR"]);
    expect(r.labOrderId).not.toBeNull();
    expect(r.skipped).toEqual([]);
    const placed = await db.select().from(orders).where(eq(orders.encounterNo, u.episodeNo));
    expect(placed.map((o) => [o.kind, o.priority])).toEqual([["lab", "stat"]]);
    const lines = await db.select().from(erChargeLines).where(eq(erChargeLines.episodeId, u.episodeId));
    const byService = Object.fromEntries(lines.map((l) => [l.serviceId, [l.source, l.status, l.amountPaise]]));
    expect(byService).toEqual({
      [serviceIdForLabCode("CBC")]: ["er.order", "posted", ER_LAB_PRICE],
      [serviceIdForLabCode("RFT")]: ["er.order", "posted", ER_LAB_PRICE],
      // ESR has no rate on the tariff: recorded for the bill desk, never a block on the order.
      [serviceIdForLabCode("ESR")]: ["er.order", "rate_missing", null],
    });
    expect(await db.select().from(invoices).where(eq(invoices.patientId, u.patientId))).toEqual([]);
    // The same STAT test again within 6 hours: a warning, and the order still goes.
    const again = await order(u.episodeId, ["CBC"]);
    expect(again.duplicates).toEqual([serviceIdForLabCode("CBC")]);
    expect(again.labOrderId).not.toBeNull();
  });

  it("(b) a critical result reaches the ER doctor of record; unacknowledged, it climbs", async () => {
    await ensureRole(db, "duty_manager");
    const dm = (await mkUser(db, "er.dm", ["duty_manager"])).actor;
    const t0 = new Date();
    const u = await unknown(t0);
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, doctorId: w.erDoctor.id }, { now: t0 });
    await order(u.episodeId, ["RFT"], t0);
    const [o] = await db.select().from(orders).where(eq(orders.encounterNo, u.episodeNo));
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, o!.id));
    const uhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, u.patientId)))[0]!.uhid;
    const { specimens } = await printLabels(db, w.bench, { orderGroupId: o!.orderGroupId, scannedUhid: uhid }, t0);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, w.bench, { specimenId: s.specimenId, wristbandScanned: true }, t0));
      await withTx(db, (tx) => receive(tx, w.bench, w.decls, { specimenNo: s.specimenNo }, t0));
    }
    const k = (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "K")))[0]!;
    const entered = await enterResult(db, w.bench, { orderItemId: item!.id, analyteId: k.id, value: "6.8", entryMode: "manual" }, t0);
    expect(entered.criticalCallId).toBeTruthy();

    const told = (userId: string, kind: string) => db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, kind), eq(alerts.refId, u.episodeId)));
    const t1 = new Date(t0.getTime() + MIN);
    expect(await sweepErCareClocks(db, t1)).toMatchObject({ criticals: 1, climbs: 0 });
    expect(await told(w.erDoctor.id, "er.critical_result")).toHaveLength(1);
    expect((await told(w.erDoctor.id, "er.critical_result"))[0]!.body).toContain("K 6.8");
    expect((await readErBoard(db, w.erDesk, { now: t1 })).inTreatment[0]!.chips).toContain("critical");
    // Not acknowledged (the lab's read-back has not closed the call): 15 minutes later it climbs, once.
    expect(await sweepErCareClocks(db, new Date(t1.getTime() + 14 * MIN))).toMatchObject({ criticals: 0, climbs: 0 });
    expect(await sweepErCareClocks(db, new Date(t1.getTime() + 15 * MIN))).toMatchObject({ climbs: 1 });
    expect(await sweepErCareClocks(db, new Date(t1.getTime() + 16 * MIN))).toMatchObject({ criticals: 0, climbs: 0 });
    expect(await told(dm.id, "er.critical_unacknowledged")).toHaveLength(1);
    expect(await told(w.erDoctor.id, "er.critical_result")).toHaveLength(1);
  });

  it("(c) no clinical intent refuses on money or identity — every one, on an unidentified patient who has paid nothing", async () => {
    await seedOrgDepartments(db);
    const bay = await w.bed("ER-R9", { class: "emergency" });
    const u = await unknown();
    const e = u.episodeId;
    const acts: [string, () => Promise<unknown>][] = [
      ["triage", () => triage(db, w.erNurse, { idempotencyKey: key(), episodeId: e, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } })],
      ["record_er_vitals", () => recordErVitals(db, w.erNurse, { idempotencyKey: key(), episodeId: e, vitals: { pulse: 120, spo2: 93 } })],
      ["place_in_bay", () => placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: e, bedId: bay })],
      ["assign_er_doctor", () => assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: e, doctorId: w.erDoctor.id })],
      ["record_er_note", () => recordErNote(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, kind: "assessment", text: "Unknown male, RTA, GCS 13" })],
      ["place_er_order", () => order(e, ["CBC"])],
      ["issue_er_med", () => issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: e, ownMedicine: "Family's inhaler", doseWords: "2 puffs", route: "inhaled", units: 1, orderedBy: w.erDoctor.id })],
      ["record_consent", () => recordConsent(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, kind: "procedure", about: "Chest drain", signedBy: "emergency", method: "paper", secondDoctorId: w.doctor.id })],
      ["record_procedure", () => recordProcedure(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, name: "Chest drain", performedBy: w.erDoctor.id })],
      ["call_specialty", () => callSpecialty(db, w.erDoctor, { idempotencyKey: key(), episodeId: e, departmentCode: "SUR", urgency: "immediate", reason: "Haemothorax" })],
      ["declare_stabilised", () => declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: e })],
    ];
    for (const [name, act] of acts) {
      await expect([name, await act().then(() => "ok", (err: unknown) => (err as { code?: string }).code ?? String(err))]).toEqual([name, "ok"]);
    }
    const issued = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: e, ownMedicine: "Family's paracetamol", doseWords: "1 g", route: "oral", units: 1, orderedBy: w.erDoctor.id });
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: issued.issueId, outcome: "given" })).resolves.toMatchObject({ outcome: "given" });
  });

  it.todo("(c-2) no clinical intent refuses on MLC state — lane 4 er-mlc adds the MLC and runs (c) again with an MLC patient");

  it("(c-3) the clinical intents' source reads no money: no invoice, receipt, deposit or ER charge line is consulted to decide", () => {
    for (const file of ["care.ts", "triage.ts"]) {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      expect([file, src.match(/\b(invoices|receipts|deposit|takeDeposit|erChargeLines|advanceOf|paise)\b/g) ?? []]).toEqual([file, []]);
    }
  });
});
