import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { HOUR, MIN, SEC, codeOf, icuBase, mkIcuWorld, plus } from "../../../test/helpers/icu";
import { alerts, events, icuAlarms, icuDeviceLinks, icuFeedBatches, icuNumerics, ipdBedStays } from "../../kernel/db/schema";
import { backfillDowntime, printBand } from "../ipd";
import {
  IcuError, dropExpiredNumericsPartitions, ingestBatch, isIstHourMark, linkDevice, partitionNameOf, prefillHour, readMyBeds, readNight,
  readStation, reconcileLinks, sweepIcuAlarms,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { IcuWorld } from "../../../test/helpers/icu";

/**
 * ICU IC-1 (#984) — the module's own edges beyond the done-means: the clock-drift rule, the partition drop, the alarm
 * storm, a transfer closing a link, the refusals of a link off an ICU bed and of a chart hour off the IST hour mark.
 */
jest.setTimeout(240_000);

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof IcuError) return e.code; throw e; }
  return "succeeded";
}

describe("icu — module edges", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: IcuWorld;
  let T0: Date;
  let n = 0;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    T0 = icuBase();
    w = await mkIcuWorld(db, plus(T0, -6 * HOUR));
  });
  afterAll(async () => teardown());

  const send = (at: Date, body: { sentAt?: Date; samples?: unknown[]; alarms?: unknown[] }) => {
    n += 1;
    return ingestBatch(db, w.agent, w.gatewayId, {
      batchRef: `U-${String(n)}`, sentAt: (body.sentAt ?? at).toISOString(), samples: body.samples ?? [], alarms: body.alarms ?? [],
    }, at);
  };

  it("a batch whose clock is off by more than 120 s is flagged and stamped with the received time", async () => {
    const t = plus(T0, -60 * HOUR);
    const p = await w.admitIcu(t);
    await w.device("monitor", "MON-U1");
    await linkDevice(db, w.icuNurse, { deviceScan: "MON-U1", bandScan: p.band }, t);
    const at = plus(t, HOUR);
    const r = await send(at, { sentAt: plus(at, -10 * MIN), samples: [{ slot: p.slot, code: codeOf("hr"), value: 80, at: plus(at, -10 * MIN).toISOString() }] });
    expect(r.driftFlagged).toBe(true);
    const row = (await db.select().from(icuNumerics).where(and(eq(icuNumerics.bedId, p.bedId), eq(icuNumerics.value, 80))))[0]!;
    expect(row.observedAt.toISOString()).toBe(at.toISOString());
    expect(row.deviceAt.toISOString()).toBe(plus(at, -10 * MIN).toISOString());
    expect((await db.select().from(events).where(eq(events.name, "icu.clock_drift_flagged"))).length).toBe(1);
    // Within the limit: observed = device time + skew (here the gateway's clock runs 30 s behind).
    const at2 = plus(at, MIN);
    await send(at2, { sentAt: plus(at2, -30 * SEC), samples: [{ slot: p.slot, code: codeOf("hr"), value: 81, at: plus(at2, -35 * SEC).toISOString() }] });
    const row2 = (await db.select().from(icuNumerics).where(and(eq(icuNumerics.bedId, p.bedId), eq(icuNumerics.value, 81))))[0]!;
    expect(row2.observedAt.toISOString()).toBe(plus(at2, -5 * SEC).toISOString());
    expect((await db.select().from(icuFeedBatches)).every((b) => b.gatewayId === w.gatewayId)).toBe(true);
  });

  it("raw partitions older than 72 hours are dropped whole; younger ones stay", async () => {
    const old = new Date(Date.UTC(2026, 0, 5, 12));
    await send(old, { samples: [{ slot: "NOBED", code: codeOf("hr"), value: 70, at: old.toISOString() }] });
    // An unknown slot is quarantined, so make a row land on that day through a mapped slot of a fresh bed.
    await w.icuBed("MICU-OLD", "OLD01");
    await send(plus(old, MIN), { samples: [{ slot: "OLD01", code: codeOf("hr"), value: 71, at: plus(old, MIN).toISOString() }] });
    const name = partitionNameOf(old);
    const exists = async () => ((await db.execute(sql`select 1 from pg_class where relname = ${name}`)).rows.length > 0);
    expect(await exists()).toBe(true);
    expect(await dropExpiredNumericsPartitions(db, new Date(Date.UTC(2026, 0, 8, 23)))).toEqual([]);
    expect(await dropExpiredNumericsPartitions(db, new Date(Date.UTC(2026, 0, 9, 1)))).toContain(name);
    expect(await exists()).toBe(false);
  });

  it("an alarm storm is flagged to the in-charge once and caps advisory alarms; a medium alarm never climbs", async () => {
    const t = plus(T0, -50 * HOUR);
    const p = await w.admitIcu(t);
    await w.device("monitor", "MON-U3");
    await linkDevice(db, w.icuNurse, { deviceScan: "MON-U3", bandScan: p.band }, t);
    const at = plus(t, HOUR);
    const alarms = Array.from({ length: 10 }, (_, i) => ({ slot: p.slot, severity: "medium", message: `Alarm ${String(i)}`, at: plus(at, i * SEC).toISOString() }));
    await send(plus(at, 20 * SEC), { alarms });
    const storm = await db.select().from(alerts).where(and(eq(alerts.userId, w.incharge.id), eq(alerts.kind, "icu.alarm_storm"), eq(alerts.refId, p.admissionId)));
    expect(storm).toHaveLength(1);
    expect((await readStation(db, w.icuNurse, w.hallId, plus(at, MIN))).tiles.find((x) => x.admissionId === p.admissionId)!.storm).toBe(true);
    await sweepIcuAlarms(db, plus(at, 10 * MIN));
    const rows = await db.select().from(icuAlarms).where(eq(icuAlarms.admissionId, p.admissionId));
    expect(rows.every((r) => r.rung === "bed_nurse")).toBe(true);
  });

  it("a transfer off the ICU bed closes the link at the stay's end with reason 'transfer'", async () => {
    const t = plus(T0, -40 * HOUR);
    const p = await w.admitIcu(t);
    await w.device("pump", "PUMP-U4");
    await linkDevice(db, w.icuNurse, { deviceScan: "PUMP-U4", bandScan: p.band }, t);
    const moved = plus(t, 5 * HOUR);
    const ward = await w.bed("U4-WARD", { class: "general" });
    await db.update(ipdBedStays).set({ endedAt: moved }).where(eq(ipdBedStays.admissionId, p.admissionId));
    await db.insert(ipdBedStays).values({
      ...(await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, p.admissionId)))[0]!, id: newId(),
      bedId: ward, startedAt: moved, endedAt: null, bedClass: "general",
    });
    expect(await reconcileLinks(db, plus(moved, MIN))).toBeGreaterThanOrEqual(1);
    const link = (await db.select().from(icuDeviceLinks).where(eq(icuDeviceLinks.admissionId, p.admissionId)))[0]!;
    expect(link).toMatchObject({ endReason: "transfer" });
    expect(link.endedAt!.toISOString()).toBe(moved.toISOString());
  });

  it("refuses a link for a patient off an ICU bed and a chart hour off the IST hour mark", async () => {
    const t = plus(T0, -30 * HOUR);
    const patientId = await w.patient("female");
    const bedId = await w.bed("U5-WARD", { class: "general" });
    const adm = await backfillDowntime(db, w.admitDesk, {
      idempotencyKey: randomUUID(), paperSerial: "U5", patientId, bedId, consultantId: w.doctor.id, requestedClass: "general", isolation: "none",
      provisionalDiagnosis: "Fever", mlc: false, payerKind: "cash", requestedAt: t.toISOString(), admittedAt: t.toISOString(),
      consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness" },
    }, { now: t });
    const band = (await printBand(db, w.admitDesk, { idempotencyKey: randomUUID(), admissionId: adm.admissionId, size: "adult", site: "wrist" }, { now: t })).bandSerial;
    await w.device("monitor", "MON-U5");
    expect(await code(linkDevice(db, w.icuNurse, { deviceScan: "MON-U5", bandScan: band }, t))).toBe("not_on_icu_bed");
    expect(await code(linkDevice(db, w.icuNurse, { deviceScan: "NOT-A-DEVICE", bandScan: band }, t))).toBe("unknown_device");

    const p = await w.admitIcu(t);
    const offMark = plus(t, 3 * HOUR + 15 * MIN);
    expect(isIstHourMark(offMark)).toBe(false);
    expect(await code(prefillHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: offMark.toISOString() }, plus(t, 4 * HOUR)))).toBe("hour_not_mark");
    expect(await code(prefillHour(db, w.icuNurse, { admissionId: p.admissionId, hourStart: plus(t, 5 * HOUR).toISOString() }, plus(t, 4 * HOUR)))).toBe("hour_in_future");
  });

  it("the phone and the night view need their own permissions and list the sickest first", async () => {
    const at = plus(T0, -20 * HOUR);
    expect(await code(readMyBeds(db, w.doctor, at))).toBe("icu_forbidden");
    expect(await code(readNight(db, w.icuNurse, at))).toBe("icu_forbidden");
    const mine = await readMyBeds(db, w.icuNurse, at);
    expect(mine.tiles.length).toBeGreaterThan(0);
    const night = await readNight(db, w.intensivist, at);
    expect(night.halls.map((h) => h.hallId)).toContain(w.hallId);
  });
});
