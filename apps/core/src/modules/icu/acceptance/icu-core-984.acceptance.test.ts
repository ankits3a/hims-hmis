import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { HOUR, MIN, SEC, codeOf, icuBase, mkIcuWorld, plus } from "../../../../test/helpers/icu";
import {
  alerts, icuAlarms, icuChartValues, icuDeviceLinks, icuFeedGaps, icuNumerics, icuRequestEvents, ipdAdmissions, ipdBedStays,
  ipdVitals, resources,
} from "../../../kernel/db/schema";
import { sweepInterfaceHeartbeats } from "../../../kernel/ops/interfaces";
import { backfillDowntime, issueFamilyLink, readFamilyView, recordVitals, sendFamilyOtp, takeDeposit, verifyFamilyOtp } from "../../ipd";
import {
  IcuError, acknowledgeAlarm, completeBundle, confirmLimitOnMonitor, correctValue, decideIcuRequest, deviceDays, enterManualHour,
  ensureBundles, ingestBatch, insertLine, linkDevice, logFamilyUpdate, logVisit, prefillHour, readBed, readChart, readIncharge,
  readStation, readTrends, reconcileLinks, requestIcu, setAlarmLimit, signHour, startSepsisBundle, sweepIcuAlarms, unlinkDevice,
} from "../index";
import type { IcuParam } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { IcuWorld } from "../../../../test/helpers/icu";
import type { FamilyOtpSender } from "../../ipd";

/**
 * SPEC #984 — ICU IC-1 CORE (docs/specs/984-icu-core.md, decision 0090). One block per "Done means" id, D1–D9. Every
 * act takes an explicit instant derived from `icuBase()` (an hour mark three days before the real clock); nothing here
 * asserts a decision the code takes from the wall clock. Every name is made up.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();

async function refusal(p: Promise<unknown>): Promise<{ code: string }> {
  try { await p; } catch (e) { if (e instanceof IcuError) return e; throw e; }
  throw new Error("expected a refusal, the act succeeded");
}

describe("spec #984 — ICU IC-1 core", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: IcuWorld;
  let T0: Date;
  let batchNo = 0;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    T0 = icuBase();
    w = await mkIcuWorld(db, plus(T0, -6 * HOUR));
  });
  afterAll(async () => teardown());

  /** `count` samples every 5 s ending at `end`, on `slot`, one per parameter given. */
  const samples = (slot: string, end: Date, count: number, values: Partial<Record<IcuParam, number | "probe_off">>, serial?: string) => {
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const at = plus(end, -i * 5 * SEC).toISOString();
      for (const [p, v] of Object.entries(values)) {
        out.push({
          slot, code: codeOf(p as IcuParam), at, value: v === "probe_off" ? null : v,
          ...(v === "probe_off" ? { technical: "probe_off" as const } : {}), ...(serial === undefined ? {} : { deviceSerial: serial }),
        });
      }
    }
    return out;
  };
  const send = (receivedAt: Date, s: ReturnType<typeof samples>, alarms: unknown[] = []) => {
    batchNo += 1;
    return ingestBatch(db, w.agent, w.gatewayId, { batchRef: `B-${String(batchNo)}`, sentAt: receivedAt.toISOString(), samples: s, alarms }, receivedAt);
  };

  // ═══ D1 ═══
  describe("spec #984 D1 — an ICU request carries a priority class and triage scores; admission only after the intensivist approves; refusal and hold are logged with a reason and a name", () => {
    it("ER, ward and OT requests carry priority and scores; ward scores are pre-filled from the latest vitals", async () => {
      const t = plus(T0, -2 * HOUR);
      const er = await requestIcu(db, w.doctor, { patientId: await w.patient("male", 61), source: "er", priorityClass: 1, reason: "Shock", triage: { sofa: 8, gcs: 12 } }, t);
      expect(er).toMatchObject({ source: "er", priorityClass: 1, state: "pending", triage: { sofa: 8, gcs: 12 } });
      const ot = await requestIcu(db, w.doctor, { patientId: await w.patient("female", 44), source: "ot", priorityClass: 2, reason: "Post-op ventilation" }, t);
      expect(ot).toMatchObject({ source: "ot", priorityClass: 2 });

      // A ward patient with a recorded set: NEWS2 and qSOFA arrive filled.
      const wardBed = await w.bed("ICU-D1-W1", { class: "general" });
      const wardPatient = await w.patient("male", 70);
      const adm = await backfillDowntime(db, w.admitDesk, {
        idempotencyKey: key(), paperSerial: "ICU-D1-W", patientId: wardPatient, bedId: wardBed, consultantId: w.doctor.id, requestedClass: "general",
        isolation: "none", provisionalDiagnosis: "Pneumonia", mlc: false, payerKind: "cash", requestedAt: plus(t, -HOUR).toISOString(),
        admittedAt: plus(t, -HOUR).toISOString(), consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness" },
      }, { now: plus(t, -HOUR) });
      await recordVitals(db, w.icuNurse, {
        idempotencyKey: key(), admissionId: adm.admissionId, observedAt: plus(t, -5 * MIN).toISOString(), source: "person", confirmedOutOfRange: true,
        values: { pulse: 128, respRate: 30, systolic: 88, diastolic: 50, spo2: 88, temperatureC: 39.1, onOxygen: true, consciousness: "confused" },
      }, { now: t });
      const ward = await requestIcu(db, w.doctor, { patientId: wardPatient, admissionId: adm.admissionId, source: "ward", priorityClass: 1, reason: "Worsening sepsis" }, t);
      expect(ward.triage.qsofa).toBe(3);
      expect(ward.triage.news2).toBeGreaterThanOrEqual(7);

      expect((await refusal(requestIcu(db, w.doctor, { patientId: await w.patient("male"), source: "er", priorityClass: 5, reason: "x" }, t))).code).toBe("bad_input");
      expect((await refusal(requestIcu(db, w.doctor, { patientId: wardPatient, source: "ward", priorityClass: 2, reason: "again" }, t))).code).toBe("request_open");
    });

    it("the ICU bed is refused until the intensivist approves; a doctor cannot decide; the requester cannot decide their own", async () => {
      const t = plus(T0, -90 * MIN);
      const patientId = await w.patient("female", 52);
      const bedId = await w.icuBed("MICU-D1-A");
      const req = await requestIcu(db, w.doctor, { patientId, source: "er", priorityClass: 1, reason: "Respiratory failure", triage: { sofa: 7 } }, t);
      const admitIcu = (approvalId?: string) => backfillDowntime(db, w.admitDesk, {
        idempotencyKey: key(), paperSerial: `D1-${randomUUID().slice(0, 6)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "icu",
        isolation: "none", provisionalDiagnosis: "ARDS", mlc: false, payerKind: "cash", requestedAt: t.toISOString(), admittedAt: plus(t, 5 * MIN).toISOString(),
        consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness" }, ...(approvalId === undefined ? {} : { intensivistApprovalId: approvalId }),
      }, { now: plus(t, 10 * MIN) });
      await expect(admitIcu()).rejects.toMatchObject({ code: "icu_needs_intensivist" });
      await expect(admitIcu(req.approvalId!)).rejects.toMatchObject({ code: "icu_needs_intensivist" });

      expect((await refusal(decideIcuRequest(db, w.doctor, { requestId: req.id, decision: "approve", reason: "fine" }, t))).code).toBe("intensivist_only");
      const own = await requestIcu(db, w.intensivist2, { patientId: await w.patient("male"), source: "ot", priorityClass: 3, reason: "Observation" }, t);
      expect((await refusal(decideIcuRequest(db, w.intensivist2, { requestId: own.id, decision: "approve", reason: "mine" }, t))).code).toBe("own_request");

      const ok = await decideIcuRequest(db, w.intensivist, { requestId: req.id, decision: "approve", reason: "Needs ventilation" }, plus(t, MIN));
      expect(ok).toMatchObject({ state: "approved", decidedBy: w.intensivist.id, decisionReason: "Needs ventilation" });
      await expect(admitIcu(ok.approvalId!)).resolves.toMatchObject({ state: "admitted" });
    });

    it("a refusal and a hold with monitoring need a reason, and are logged with the reason and the name", async () => {
      const t = plus(T0, -80 * MIN);
      const a = await requestIcu(db, w.doctor, { patientId: await w.patient("male"), source: "ward", priorityClass: 4, reason: "Comfort care" }, t);
      expect((await refusal(decideIcuRequest(db, w.intensivist, { requestId: a.id, decision: "refuse", reason: "" }, t))).code).toBe("bad_input");
      const refused = await decideIcuRequest(db, w.intensivist, { requestId: a.id, decision: "refuse", reason: "Priority 4, ward care is right" }, plus(t, MIN));
      expect(refused).toMatchObject({ state: "refused", decidedBy: w.intensivist.id, decisionReason: "Priority 4, ward care is right" });

      const b = await requestIcu(db, w.doctor, { patientId: await w.patient("female"), source: "er", priorityClass: 2, reason: "Borderline" }, t);
      const held = await decideIcuRequest(db, w.intensivist, {
        requestId: b.id, decision: "hold", reason: "No bed; watch in ER", monitoring: "Hourly vitals, call if MAP < 65",
      }, plus(t, 2 * MIN));
      expect(held).toMatchObject({ state: "on_hold", monitoring: "Hourly vitals, call if MAP < 65", decidedBy: w.intensivist.id });
      expect(held.reviewAt).toBe(plus(t, 62 * MIN).toISOString());
      const log = await db.select().from(icuRequestEvents).where(eq(icuRequestEvents.requestId, b.id));
      expect(log.map((e) => [e.act, e.actorId, e.reason])).toEqual([["raised", w.doctor.id, "Borderline"], ["held", w.intensivist.id, "No bed; watch in ER"]]);
      // A held request can still be approved later.
      await expect(decideIcuRequest(db, w.intensivist, { requestId: b.id, decision: "approve", reason: "Bed free" }, plus(t, 30 * MIN))).resolves.toMatchObject({ state: "approved" });
    });
  });

  // ═══ D2 ═══
  describe("spec #984 D2 — a device links to a bed and a patient only by scanning both; one of a kind per bed; the device-day runs link to unlink or discharge", () => {
    it("scans both, refuses a second monitor and a busy device, counts device-days, and stops them at discharge", async () => {
      const t = plus(T0, -60 * HOUR);
      const p1 = await w.admitIcu(t);
      const p2 = await w.admitIcu(t);
      const mon = await w.device("monitor", "MON-D2-1");
      const mon2 = await w.device("monitor", "MON-D2-2");
      const vent = await w.device("ventilator", "VENT-D2-1");

      expect((await refusal(linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-1" }, t))).code).toBe("bad_input");
      expect((await refusal(linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-1", bandScan: "NO-SUCH-BAND" }, t))).code).toBe("unknown_band");
      const link = await linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-1", bandScan: p1.band }, plus(t, MIN));
      expect(link).toMatchObject({ deviceType: "monitor", bedId: p1.bedId, admissionId: p1.admissionId });
      expect((await db.select().from(resources).where(eq(resources.id, mon)))[0]).toMatchObject({ status: "in_use", occupantRef: p1.admissionId });

      expect((await refusal(linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-2", bandScan: p1.band }, plus(t, 2 * MIN)))).code).toBe("bed_has_type");
      expect((await refusal(linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-1", bandScan: p2.band }, plus(t, 2 * MIN)))).code).toBe("device_busy");
      await expect(linkDevice(db, w.icuNurse, { deviceScan: "VENT-D2-1", bandScan: p1.band }, plus(t, 3 * MIN))).resolves.toMatchObject({ deviceType: "ventilator" });
      await expect(linkDevice(db, w.icuNurse, { deviceScan: "MON-D2-2", bandScan: p2.band }, plus(t, 3 * MIN))).resolves.toMatchObject({ bedId: p2.bedId });

      // Unlink the monitor 30 hours later: it was in place on two IST calendar days at least.
      await unlinkDevice(db, w.icuNurse, { deviceScan: "MON-D2-1" }, plus(t, 30 * HOUR));
      expect((await db.select().from(resources).where(eq(resources.id, mon)))[0]!.status).toBe("available");
      const days = await deviceDays(db, p1.admissionId, plus(t, 40 * HOUR));
      expect(days.monitorDays).toBeGreaterThanOrEqual(2);
      expect(days.monitorDays).toBeLessThanOrEqual(3);

      // The patient leaves (the stay ends): the ventilator's link stops at the stay's end, not at the sweep.
      const left = plus(t, 36 * HOUR);
      await db.update(ipdBedStays).set({ endedAt: left }).where(and(eq(ipdBedStays.admissionId, p1.admissionId)));
      await db.update(ipdAdmissions).set({ state: "discharged", endedAt: left }).where(eq(ipdAdmissions.id, p1.admissionId));
      await reconcileLinks(db, plus(t, 37 * HOUR));
      const ventLink = (await db.select().from(icuDeviceLinks).where(eq(icuDeviceLinks.deviceId, vent)))[0]!;
      expect(ventLink).toMatchObject({ endReason: "discharge" });
      expect(ventLink.endedAt!.toISOString()).toBe(left.toISOString());
      expect((await db.select().from(resources).where(eq(resources.id, vent)))[0]!.status).toBe("available");
      expect(mon2).toBeDefined();
    });
  });

  // ═══ D3 ═══
  describe("spec #984 D3 — numbers from an unlinked or unconfirmed device never reach a chart", () => {
    it("unlinked samples, a mismatched device serial and samples from before the link stay off every chart and trend", async () => {
      const t = plus(T0, -50 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D3-1", "SN-D3-1");
      const hour = plus(t, 2 * HOUR);

      // Before any link: stored, never attributed.
      const r1 = await send(plus(hour, -2 * MIN), samples(p.slot, plus(hour, -2 * MIN), 6, { hr: 111 }));
      expect(r1).toMatchObject({ accepted: 6, duplicate: false, quarantined: 0 });
      // A non-agent cannot send; a replay is a duplicate and writes nothing.
      expect((await refusal(ingestBatch(db, w.icuNurse, w.gatewayId, { batchRef: "X", sentAt: hour.toISOString(), samples: [] }, hour))).code).toBe("gateway_agent_only");
      await expect(ingestBatch(db, w.agent, w.gatewayId, { batchRef: `B-${String(batchNo)}`, sentAt: hour.toISOString(), samples: [] }, hour))
        .resolves.toMatchObject({ duplicate: true });

      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D3-1", bandScan: p.band }, plus(hour, -90 * SEC));
      // Linked, but the station reports another device on the slot: unconfirmed, not charted.
      await send(plus(hour, -40 * SEC), samples(p.slot, plus(hour, -40 * SEC), 4, { hr: 122 }, "SN-OTHER"));
      // An unmapped code is quarantined, never dropped.
      const q = await ingestBatch(db, w.agent, w.gatewayId, {
        batchRef: `B-Q-${String(batchNo)}`, sentAt: hour.toISOString(), samples: [{ slot: p.slot, code: "999^UNKNOWN", value: 5, at: hour.toISOString() }],
      }, hour);
      expect(q.quarantined).toBe(1);

      const rows = await db.select().from(icuNumerics).where(eq(icuNumerics.bedId, p.bedId));
      expect(rows.filter((r) => r.value === 111).every((r) => r.linkId === null)).toBe(true);
      expect(rows.filter((r) => r.value === 122).every((r) => r.linkId === null)).toBe(true);
      expect(await refusal(prefillHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: hour.toISOString() }, plus(hour, MIN)))).toMatchObject({ code: "hour_empty" });
      const trends = await readTrends(db, w.icuNurse, p.admissionId, plus(hour, MIN));
      expect(Object.values(trends.series).flat()).toEqual([]);

      // The confirmed device's own numbers do reach the chart.
      await send(plus(hour, 5 * SEC), samples(p.slot, hour, 12, { hr: 96 }, "SN-D3-1"));
      const filled = await prefillHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: hour.toISOString() }, plus(hour, 2 * MIN));
      expect(filled.values.find((v) => v.param === "hr")).toMatchObject({ value: 96, source: "device" });
    });
  });

  // ═══ D4 ═══
  describe("spec #984 D4 — the device pre-fill is not the record until a nurse signs it; corrections keep the original with a reason; technical readings are marked", () => {
    it("pre-fills, marks probe-off, signs into the vitals record, and corrects with a reason", async () => {
      const t = plus(T0, -45 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D4-1");
      const hour = plus(t, 3 * HOUR);
      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D4-1", bandScan: p.band }, plus(hour, -10 * MIN));
      await send(plus(hour, 2 * SEC), [
        ...samples(p.slot, hour, 12, { hr: 100, nibp_sys: 110, spo2: "probe_off" }),
        ...samples(p.slot, plus(hour, -25 * SEC), 1, { hr: 140 }),
      ]);
      const draft = await prefillHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: hour.toISOString() }, plus(hour, MIN));
      expect(draft.state).toBe("draft");
      expect(draft.values.find((v) => v.param === "hr")).toMatchObject({ value: 100, source: "device", technical: null });
      expect(draft.values.find((v) => v.param === "spo2")).toMatchObject({ value: null, technical: "probe_off" });
      // Not the record yet.
      expect(await db.select().from(ipdVitals).where(and(eq(ipdVitals.admissionId, p.admissionId), eq(ipdVitals.source, "icu_chart")))).toHaveLength(0);

      const signed = await signHour(db, w.icuNurse, { hourId: draft.id }, plus(hour, 5 * MIN));
      expect(signed).toMatchObject({ state: "signed", signedBy: w.icuNurse.id });
      const vit = await db.select().from(ipdVitals).where(and(eq(ipdVitals.admissionId, p.admissionId), eq(ipdVitals.source, "icu_chart")));
      expect(vit).toHaveLength(1);
      expect(vit[0]).toMatchObject({ pulse: 100, systolic: 110, spo2: null, recordedBy: w.icuNurse.id });
      expect(vit[0]!.observedAt.toISOString()).toBe(hour.toISOString());
      expect((await refusal(signHour(db, w.icuNurse, { hourId: draft.id }, plus(hour, 6 * MIN)))).code).toBe("hour_signed");

      expect((await refusal(correctValue(db, w.icuNurse, { hourId: draft.id, param: "hr", value: 92, reason: "" }, plus(hour, 7 * MIN)))).code).toBe("reason_required");
      await correctValue(db, w.icuNurse, { hourId: draft.id, param: "hr", value: 92, reason: "Artefact from shivering" }, plus(hour, 8 * MIN));
      const chart = await readChart(db, w.icuNurse, p.admissionId, plus(hour, 9 * MIN));
      const hr = chart.hours.find((h) => h.id === draft.id)!.values.filter((v) => v.param === "hr");
      expect(hr.find((v) => v.current)).toMatchObject({ value: 92, source: "correction", reason: "Artefact from shivering" });
      expect(hr.find((v) => !v.current)).toMatchObject({ value: 100, source: "device" });
      expect(await db.select().from(icuChartValues).where(eq(icuChartValues.hourId, draft.id))).toHaveLength(4);
    });
  });

  // ═══ D5 ═══
  describe("spec #984 D5 — a life-threatening alarm climbs bed nurse → station → duty doctor → intensivist on a clock until acknowledged; HMIS never silences a device", () => {
    it("escalates on the clock, stops at acknowledgement, and has no way to silence", async () => {
      const t = plus(T0, -40 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D5-1");
      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D5-1", bandScan: p.band }, t);
      const a0 = plus(t, HOUR);
      const reply = await send(a0, [], [{ slot: p.slot, severity: "life_threatening", message: "VF", at: a0.toISOString() }]);
      expect(Object.keys(reply).sort()).toEqual(["accepted", "driftFlagged", "duplicate", "quarantined", "serverTime"]);
      const [alarm] = await db.select().from(icuAlarms).where(eq(icuAlarms.admissionId, p.admissionId));
      expect(alarm).toMatchObject({ rung: "bed_nurse", state: "open", severity: "life_threatening", source: "device" });
      expect(Object.keys(alarm!).some((k) => /silen|mute|pause/i.test(k))).toBe(false);

      const rungAt = async (at: Date) => { await sweepIcuAlarms(db, at); return (await db.select().from(icuAlarms).where(eq(icuAlarms.id, alarm!.id)))[0]!.rung; };
      expect(await rungAt(plus(a0, 59 * SEC))).toBe("bed_nurse");
      expect(await rungAt(plus(a0, 61 * SEC))).toBe("station");
      expect(await rungAt(plus(a0, 125 * SEC))).toBe("duty_doctor");
      expect(await rungAt(plus(a0, 250 * SEC))).toBe("intensivist");
      expect(await rungAt(plus(a0, 900 * SEC))).toBe("intensivist");
      const told = async (userId: string) => (await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.refId, alarm!.id))));
      expect(await told(w.incharge.id)).toHaveLength(1);
      expect(await told(w.doctor.id)).toHaveLength(1);
      expect((await told(w.intensivist.id)).length).toBeGreaterThanOrEqual(1);

      // Acknowledged at 30 s: it never climbs.
      const a1 = plus(t, 2 * HOUR);
      await send(a1, [], [{ slot: p.slot, severity: "life_threatening", message: "Asystole", at: a1.toISOString() }]);
      const second = (await db.select().from(icuAlarms).where(and(eq(icuAlarms.admissionId, p.admissionId), eq(icuAlarms.message, "Asystole"))))[0]!;
      const acked = await acknowledgeAlarm(db, w.icuNurse, { alarmId: second.id }, plus(a1, 30 * SEC));
      expect(acked).toMatchObject({ state: "acknowledged", ackBy: w.icuNurse.id, deviceSilenced: false });
      await sweepIcuAlarms(db, plus(a1, 600 * SEC));
      expect((await db.select().from(icuAlarms).where(eq(icuAlarms.id, second.id)))[0]).toMatchObject({ rung: "bed_nurse", state: "acknowledged" });
      expect((await refusal(acknowledgeAlarm(db, w.icuNurse, { alarmId: second.id }, plus(a1, 601 * SEC)))).code).toBe("alarm_closed");
    });
  });

  // ═══ D6 ═══
  describe("spec #984 D6 — doctor-set alarm limits expire after 24 hours", () => {
    it("a limit drives advisory alarms for 24 hours, then lapses; the nurse ticks 'set on monitor'", async () => {
      const t = plus(T0, -36 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D6-1");
      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D6-1", bandScan: p.band }, t);
      expect((await refusal(setAlarmLimit(db, w.icuNurse, { admissionId: p.admissionId, param: "hr", high: 120 }, t))).code).toBe("icu_forbidden");
      const limit = await setAlarmLimit(db, w.intensivist, { admissionId: p.admissionId, param: "hr", low: 50, high: 120 }, plus(t, MIN));
      expect(limit.expiresAt).toBe(plus(t, MIN + 24 * HOUR).toISOString());
      expect((await readIncharge(db, w.incharge, plus(t, 2 * MIN))).monitorTasks.map((m) => m.limitId)).toContain(limit.limitId);
      await confirmLimitOnMonitor(db, w.icuNurse, limit.limitId, plus(t, 3 * MIN));
      expect((await readIncharge(db, w.incharge, plus(t, 4 * MIN))).monitorTasks.map((m) => m.limitId)).not.toContain(limit.limitId);

      const advisories = async () => (await db.select().from(icuAlarms).where(and(eq(icuAlarms.admissionId, p.admissionId), eq(icuAlarms.source, "advisory"))));
      const inBreach = plus(t, 2 * HOUR);
      await send(inBreach, samples(p.slot, inBreach, 6, { hr: 145 }));
      expect(await advisories()).toHaveLength(1);
      const lapsed = plus(t, 25 * HOUR);
      await send(lapsed, samples(p.slot, lapsed, 6, { hr: 145 }));
      expect(await advisories()).toHaveLength(1);
      expect((await readBed(db, w.icuNurse, p.admissionId, lapsed)).tile.limits).toEqual([]);
    });
  });

  // ═══ D7 ═══
  describe("spec #984 D7 — a feed lost for more than 5 minutes greys the station and switches charting to manual; back-filled hours carry both times", () => {
    it("greys after 5 minutes, opens and closes a gap, and keeps the happened-at and entered-at of a manual hour", async () => {
      const t = plus(T0, -30 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D7-1");
      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D7-1", bandScan: p.band }, t);
      const last = plus(t, 2 * HOUR);
      await send(last, samples(p.slot, last, 2, { hr: 90 }));
      expect(await readStation(db, w.icuNurse, w.hallId, plus(last, 4 * MIN))).toMatchObject({ grey: false, mode: "live" });
      expect((await refusal(enterManualHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: plus(t, 3 * HOUR).toISOString(), values: { hr: 88 } }, plus(last, 4 * MIN)))).code)
        .toBe("feed_live");

      const station = await readStation(db, w.icuNurse, w.hallId, plus(last, 6 * MIN));
      expect(station).toMatchObject({ grey: true, mode: "manual" });
      await sweepInterfaceHeartbeats(db, plus(last, 6 * MIN));
      await sweepIcuAlarms(db, plus(last, 6 * MIN));
      const gap = (await db.select().from(icuFeedGaps).where(eq(icuFeedGaps.gatewayId, w.gatewayId)))[0]!;
      expect(gap.startedAt.toISOString()).toBe(last.toISOString());
      expect(gap.endedAt).toBeNull();

      // The 03:00 hour charted by hand at 03:40, observed at 03:05.
      const hour = plus(t, 3 * HOUR);
      const manual = await enterManualHour(db, w.icuNurse, {
        admissionId: p.admissionId, hourStart: hour.toISOString(), values: { hr: 88, nibp_sys: 104 }, happenedAt: plus(hour, 5 * MIN).toISOString(),
      }, plus(hour, 40 * MIN));
      expect(manual).toMatchObject({ mode: "manual", state: "draft" });
      for (const v of manual.values) {
        expect(v).toMatchObject({ source: "manual", happenedAt: plus(hour, 5 * MIN).toISOString(), enteredAt: plus(hour, 40 * MIN).toISOString() });
      }

      const back = plus(t, 4 * HOUR);
      await send(back, samples(p.slot, back, 2, { hr: 91 }));
      expect(await readStation(db, w.icuNurse, w.hallId, plus(back, MIN))).toMatchObject({ grey: false, mode: "live" });
      await sweepIcuAlarms(db, plus(back, MIN));
      expect((await db.select().from(icuFeedGaps).where(eq(icuFeedGaps.id, gap.id)))[0]!.endedAt).not.toBeNull();
    });
  });

  // ═══ D8 ═══
  describe("spec #984 D8 — bundles fall due per bed on a clock; a missed one shows on the in-charge view; line-days and ventilator-days are counted", () => {
    it("raises the bundles, flags the missed one, re-arms after it is done, and counts the days", async () => {
      const t = plus(T0, -26 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("ventilator", "VENT-D8-1");
      await linkDevice(db, w.icuNurse, { deviceScan: "VENT-D8-1", bandScan: p.band }, plus(t, 10 * MIN));
      await insertLine(db, w.intensivist, { admissionId: p.admissionId, kind: "central_line", site: "Right IJ", insertedAt: plus(t, 15 * MIN).toISOString() }, plus(t, 15 * MIN));
      await insertLine(db, w.icuNurse, { admissionId: p.admissionId, kind: "urinary_catheter", site: "Urethral", insertedAt: plus(t, 20 * MIN).toISOString() }, plus(t, 20 * MIN));
      await startSepsisBundle(db, w.intensivist, { admissionId: p.admissionId, suspectedAt: plus(t, 25 * MIN).toISOString() }, plus(t, 25 * MIN));
      await ensureBundles(db, plus(t, 30 * MIN));
      const bed = await readBed(db, w.icuNurse, p.admissionId, plus(t, 30 * MIN));
      expect(bed.bundles.map((b) => b.kind).sort()).toEqual(["catheter", "central_line", "dvt", "pressure", "sepsis_hour1", "ventilator"]);
      const sepsis = bed.bundles.find((b) => b.kind === "sepsis_hour1")!;
      expect(sepsis.dueAt).toBe(plus(t, 85 * MIN).toISOString());

      const pressure = bed.bundles.find((b) => b.kind === "pressure")!;
      const late = plus(new Date(pressure.dueAt), MIN);
      const view = await readIncharge(db, w.incharge, late);
      expect(view.missedBundles.find((m) => m.bundleId === pressure.id)).toMatchObject({ admissionId: p.admissionId, kind: "pressure" });
      await completeBundle(db, w.icuNurse, { bundleId: pressure.id, checks: ["turned", "skin checked"] }, plus(late, MIN));
      await ensureBundles(db, plus(late, 2 * MIN));
      const after = await readIncharge(db, w.incharge, plus(late, 2 * MIN));
      expect(after.missedBundles.find((m) => m.bundleId === pressure.id)).toBeUndefined();
      const next = (await readBed(db, w.icuNurse, p.admissionId, plus(late, 2 * MIN))).bundles.find((b) => b.kind === "pressure" && b.doneAt === null)!;
      expect(next.dueAt).toBe(plus(late, MIN + 2 * HOUR).toISOString());

      const days = await deviceDays(db, p.admissionId, plus(t, 25 * HOUR));
      expect(days.ventilatorDays).toBeGreaterThanOrEqual(2);
      expect(days.centralLineDays).toBeGreaterThanOrEqual(2);
      expect(days.catheterDays).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══ D9 ═══
  describe("spec #984 D9 — visiting slots and a daily family update are logged; the family link shows the day's summary, never live numbers", () => {
    it("logs the visit and the update, and the family page shows today's words and no number from the monitor", async () => {
      const t = plus(T0, -20 * HOUR);
      const p = await w.admitIcu(t);
      await w.device("monitor", "MON-D9-1");
      await linkDevice(db, w.icuNurse, { deviceScan: "MON-D9-1", bandScan: p.band }, t);
      const at = plus(t, 3 * HOUR);
      await send(at, samples(p.slot, at, 4, { hr: 137, spo2: 91 }));

      await logVisit(db, w.icuNurse, { admissionId: p.admissionId, startsAt: plus(at, HOUR).toISOString(), endsAt: plus(at, 90 * MIN).toISOString(), visitorName: "Ramesh Kumar", relation: "son" }, at);
      await logFamilyUpdate(db, w.intensivist, {
        admissionId: p.admissionId, summary: "Stable on the ventilator; antibiotics continue; we will review tomorrow.", givenTo: "Ramesh Kumar", relation: "son", mode: "in_person",
      }, plus(at, 30 * MIN));
      const bed = await readBed(db, w.icuNurse, p.admissionId, plus(at, 31 * MIN));
      expect(bed.visits).toEqual([expect.objectContaining({ visitorName: "Ramesh Kumar", relation: "son" })]);
      expect(bed.familyUpdates).toEqual([expect.objectContaining({ givenTo: "Ramesh Kumar", by: w.intensivist.id })]);

      // The attendant's page.
      await takeDeposit(db, w.admitDesk, {
        idempotencyKey: key(), admissionId: p.admissionId, amountPaise: 2_000_000, tender: "cash",
        payer: { name: "Ramesh Kumar", relation: "relative", phone: "9811122233" },
      }, { now: plus(at, 32 * MIN) });
      const SECRET = Buffer.from(process.env.SECRET_KEY ?? "0".repeat(64), "hex");
      const sent: { to: string; otp: string }[] = [];
      const sender: FamilyOtpSender = { name: "fake", send: async (to: string, otp: string) => { sent.push({ to, otp }); await Promise.resolve(); } };
      const issued = await issueFamilyLink(db, w.admitDesk, p.admissionId, { consent: { consentedBy: "Ramesh Kumar", relation: "child", method: "verbal" } }, { now: plus(at, 33 * MIN), secretKey: SECRET });
      const token = issued.path.replace("/family#", "");
      const dev = "device-icuicuicuicuicuicuicu";
      await sendFamilyOtp(db, token, dev, sender, { at: plus(at, 34 * MIN), secretKey: SECRET });
      const s = await verifyFamilyOtp(db, token, dev, sent.at(-1)!.otp, plus(at, 35 * MIN));
      const view = await readFamilyView(db, token, { device: dev, session: s.sessionToken }, plus(at, 36 * MIN));
      expect(view.todayUpdate).toMatchObject({ summary: "Stable on the ventilator; antibiotics continue; we will review tomorrow." });
      const text = JSON.stringify(view);
      expect(text).not.toMatch(/"(hr|spo2|rr|nibp_sys|latest|numerics|spark)"/);
      expect(text).not.toContain("137");
    });
  });
});

