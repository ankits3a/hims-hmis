import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { IPD_INTENTS, IpdAdviceSchema } from "@hmis/contracts";
import { PERMISSION_KEY } from "../../../kernel/auth/decorators";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { IpdAdmissionsController } from "../admissions.controller";
import { IpdBedsController } from "../beds.controller";
import { withTx } from "../../../kernel/db/client";
import { events, ipdAdmissions, ipdChargeExceptions, ipdChargeLines } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { CHARGE_RATES, mkChargesWorld } from "../../../../test/helpers/ipd";
import {
  IPD_GOAL_EVENTS, ipdChargeableDays, postAdmissionCharges, postConsultantVisit, postNightlyIpdCharges, readInterimBill,
  reverseChargeLine,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ChargesWorld } from "../../../../test/helpers/ipd";

/**
 * E2.1 (#725) — "DONE MEANS" FOR THE RUNNING BILL (spec SPEC-ipd-core §6 "Bill", §4.3; decision 0072). Every check
 * calls the function or intent with EXPLICIT instants — the job, the poster and the visit seam read no clock, so the
 * dates below are inputs, not a pin on the real clock. All instants are written in IST (`+05:30`).
 */

jest.setTimeout(180_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("E2.1 running bill — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkChargesWorld(db); });

  const lines = async (admissionId: string) =>
    db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId))
      .orderBy(ipdChargeLines.serviceDate, ipdChargeLines.component);
  const rent = async (admissionId: string) =>
    (await lines(admissionId)).filter((l) => l.component === "room").map((l) => ({ date: l.serviceDate, cls: l.billedClass, unit: l.unitPaise }));

  it("(i) admitted 23:00 general, moved to private 10:00 next day, discharged 13:30 the day after: day 1 general, day 2 private, discharge day free", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T23:00:00"));
    await w.move(admissionId, "private", ist("2026-03-11T10:00:00"));
    await w.discharge(admissionId, ist("2026-03-12T13:30:00"));
    // The pure day rule says so …
    const stays = [
      { bedClass: "general" as const, billedClass: "general" as const, startedAt: ist("2026-03-10T23:00:00"), endedAt: ist("2026-03-11T10:00:00") },
      { bedClass: "private" as const, billedClass: "private" as const, startedAt: ist("2026-03-11T10:00:00"), endedAt: ist("2026-03-12T13:30:00") },
    ];
    expect(ipdChargeableDays(stays, ist("2026-03-10T23:00:00"), ist("2026-03-12T13:30:00"), "2026-03-20")).toEqual([
      { date: "2026-03-10", billedClass: "general" },
      { date: "2026-03-11", billedClass: "private" },
    ]);
    // … and the nightly job posts exactly that, at the locked tariff's rates.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect(await rent(admissionId)).toEqual([
      { date: "2026-03-10", cls: "general", unit: CHARGE_RATES.general.room },
      { date: "2026-03-11", cls: "private", unit: CHARGE_RATES.private.room },
    ]);
    const all = await lines(admissionId);
    expect(all.map((l) => `${l.serviceDate}:${l.component}`)).toEqual([
      "2026-03-10:nursing", "2026-03-10:rmo", "2026-03-10:room",
      // private has no RMO rate: the optional component is skipped, never guessed.
      "2026-03-11:nursing", "2026-03-11:room",
    ]);
    expect(all.every((l) => l.tariffVersionId === w.versionId)).toBe(true);
    const [lock] = await db.select({ v: ipdAdmissions.tariffVersionId }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId));
    expect(lock!.v).toBe(w.versionId);
  });

  it("(ii) discharged at 14:30, past noon + 2 h grace: the discharge day is billed", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T23:00:00"));
    await w.move(admissionId, "private", ist("2026-03-11T10:00:00"));
    await w.discharge(admissionId, ist("2026-03-12T14:30:00"));
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await rent(admissionId)).map((r) => `${r.date}:${r.cls}`)).toEqual(["2026-03-10:general", "2026-03-11:private", "2026-03-12:private"]);
  });

  it("(iii) a 40-minute transit bed is not billed", async () => {
    // 23:00 general → 23:10 private (40 minutes, transit) → 23:50 general. Without the transit rule the private bed is
    // the longest hold of that short admission day and would bill it.
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T23:00:00"));
    await w.move(admissionId, "private", ist("2026-03-10T23:10:00"));
    await w.move(admissionId, "general", ist("2026-03-10T23:50:00"));
    await postAdmissionCharges(db, admissionId, { upToIstDate: "2026-03-11", now: ist("2026-03-12T00:05:00") });
    expect((await rent(admissionId)).map((r) => `${r.date}:${r.cls}`)).toEqual(["2026-03-10:general", "2026-03-11:general"]);
  });

  it("(iv) the nightly job run twice posts once; a skipped night is caught up with the right service dates", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const once = await lines(admissionId);
    expect(once.map((l) => `${l.serviceDate}:${l.component}`)).toEqual(["2026-03-10:nursing", "2026-03-10:rmo", "2026-03-10:room"]);
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-11T03:00:00"));
    expect((await lines(admissionId)).map((l) => l.id)).toEqual(once.map((l) => l.id));
    // The night of the 11th → 12th is missed (server down). The run after the 13th catches up both days, dated right.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await rent(admissionId)).map((r) => r.date)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    // G5b's producer: exactly one rent_posted per admission and night.
    const posted = await db.select({ d: sql<string>`${events.payload}->>'rentDate'`, n: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.name, IPD_GOAL_EVENTS.rentPosted), sql`${events.payload}->>'admissionId' = ${admissionId}`))
      .groupBy(sql`1`).orderBy(sql`1`);
    expect(posted).toEqual([{ d: "2026-03-10", n: 1 }, { d: "2026-03-11", n: 1 }, { d: "2026-03-12", n: 1 }]);
    // A reversal is a new line, never an edit — and a rerun does not re-post the reversed night.
    const roomLine = (await lines(admissionId)).find((l) => l.serviceDate === "2026-03-11" && l.component === "room")!;
    const { reversalLineId } = await reverseChargeLine(db, w.billDesk, { chargeLineId: roomLine.id, reason: "Posted to the wrong bed class" });
    const rev = (await lines(admissionId)).find((l) => l.id === reversalLineId)!;
    expect(rev).toMatchObject({ reversalOf: roomLine.id, netPaise: -roomLine.netPaise, source: "ipd.reversal" });
    await expect(db.execute(sql`update ipd_charge_lines set net_paise = 0 where id = ${roomLine.id}`)).rejects.toThrow();
    await postNightlyIpdCharges(db, ist("2026-03-13T00:10:00"));
    expect((await lines(admissionId)).filter((l) => l.serviceDate === "2026-03-11" && l.component === "room")).toHaveLength(2);
  });

  it("(v) a missing nursing rate is an exception listed on the bill — no line, no guessed price", async () => {
    const { admissionId } = await w.admitAt("semi_private", ist("2026-03-10T10:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const all = await lines(admissionId);
    expect(all.map((l) => `${l.component}:${l.unitPaise}`)).toEqual([`room:${String(CHARGE_RATES.semi_private.room)}`]);
    const ex = await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId));
    expect(ex).toEqual([expect.objectContaining({
      serviceDate: "2026-03-10", component: "nursing", reason: "rate_missing", serviceCode: "IPD_NURSING_SEMI_PRIVATE", resolvedAt: null,
    })]);
    // A rerun re-sees the same exception: one row, one event.
    await postNightlyIpdCharges(db, ist("2026-03-11T00:30:00"));
    expect(await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId))).toHaveLength(1);
    const bill = await readInterimBill(db, w.billDesk, admissionId);
    expect(bill.exceptions).toEqual([expect.objectContaining({ serviceDate: "2026-03-10", component: "nursing", reason: "rate_missing" })]);
    expect(bill.totals.netPaise).toBe(CHARGE_RATES.semi_private.room);
  });

  it("(vi) a consultant seen twice in a day is charged once; a resident's visit is not charged; a cross-consultant bills cross_visit", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const tap = (userId: string, at: string) => withTx(db, (tx) => postConsultantVisit(tx, {
      admissionId, consultantUserId: userId, seenAt: ist(at), source: "rounds_tap",
    }));
    await expect(tap(w.consultantUserId, "2026-03-10T11:00:00")).resolves.toMatchObject({ outcome: "charged" });
    await expect(tap(w.consultantUserId, "2026-03-10T18:00:00")).resolves.toEqual({ outcome: "repeat", chargeLineId: null });
    await expect(tap(w.resident.id, "2026-03-10T12:00:00")).resolves.toEqual({ outcome: "not_chargeable", chargeLineId: null });
    await expect(tap(w.crossUserId, "2026-03-10T15:00:00")).resolves.toMatchObject({ outcome: "charged" });
    // The next IST day is a new chargeable visit.
    await expect(tap(w.consultantUserId, "2026-03-11T09:00:00")).resolves.toMatchObject({ outcome: "charged" });
    const visits = (await lines(admissionId)).filter((l) => l.source === "ipd.visit");
    expect(visits.map((v) => `${v.serviceDate}:${v.component}:${v.unitPaise}`).sort()).toEqual([
      `2026-03-10:cross_visit:${String(CHARGE_RATES.general.cross_visit)}`,
      `2026-03-10:visit:${String(CHARGE_RATES.general.visit)}`,
      `2026-03-11:visit:${String(CHARGE_RATES.general.visit)}`,
    ]);
    // Every tap is recorded, charged or not.
    const taps = await db.select().from(events).where(and(eq(events.name, "ipd.charge.visit_recorded"), eq(events.correlationId, admissionId)));
    expect(taps).toHaveLength(5);
  });

  it("(vii) the interim bill refuses a doctor-only user; the bill desk reads lines, totals, deposit and balance", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    await expect(readInterimBill(db, w.doctor, admissionId)).rejects.toMatchObject({ code: "ipd_forbidden" });
    await expect(readInterimBill(db, w.resident, admissionId)).rejects.toMatchObject({ code: "ipd_forbidden" });
    const bill = await readInterimBill(db, w.billDesk, admissionId);
    const perDay = CHARGE_RATES.general.room + CHARGE_RATES.general.nursing + CHARGE_RATES.general.rmo;
    expect(bill.days.map((d) => [d.date, d.billedClass, d.totalPaise])).toEqual([["2026-03-10", "general", perDay], ["2026-03-11", "general", perDay]]);
    expect(bill.totals.netPaise).toBe(2 * perDay);
    expect(bill.depositPaidPaise).toBe(0);
    expect(bill.balancePaise).toBe(-bill.totals.roundedPaise);
    expect(bill.postedThrough).toBe("2026-03-11");
    expect(bill.stays).toHaveLength(1);
  });

  it("(viii) no IPD route a doctor may reach returns a money field (decision 0058)", async () => {
    const doctorPerms = new Set(ROLE_MODEL.find((r) => r.roleKey === "doctor")!.permissions);
    const reachable: string[] = [];
    for (const ctrl of [IpdAdmissionsController, IpdBedsController]) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const req = Reflect.getMetadata(PERMISSION_KEY, (ctrl.prototype as unknown as Record<string, object>)[name]!) as { permission: string } | undefined;
        if (req !== undefined && doctorPerms.has(req.permission)) reachable.push(name);
      }
    }
    // The census: a new doctor-reachable route must be added here and pass the scan below.
    expect(reachable.sort()).toEqual(["advice", "cancel", "consultants", "request", "stabilised"]);
    const MONEY = /paise|price|amount|deposit|balance|tariff|rate|bill|charge|payer|receipt/i;
    const keysOf = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) for (const x of v) keysOf(x, out);
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
      return out;
    };
    const schemaKeys = (schema: z.ZodType): string[] => {
      const out: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node === null || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        if (o.properties !== null && typeof o.properties === "object") out.push(...Object.keys(o.properties));
        Object.values(o).forEach(walk);
      };
      walk(z.toJSONSchema(schema, { unrepresentable: "any" }));
      return out;
    };
    // The intent answers the doctor's routes return, by their contracts.
    for (const intent of ["request_admission", "cancel_admission", "record_stabilised"] as const) {
      expect(schemaKeys(IPD_INTENTS[intent].output).filter((k) => MONEY.test(k))).toEqual([]);
    }
    expect(schemaKeys(IpdAdviceSchema).filter((k) => MONEY.test(k))).toEqual([]);
    // The two reads, live, as the doctor.
    const ctrl = new IpdAdmissionsController(db);
    const consultants = await ctrl.consultants(w.doctor);
    expect(keysOf(consultants).length).toBeGreaterThan(1);
    expect(keysOf(consultants).filter((k) => MONEY.test(k))).toEqual([]);
    expect(keysOf(await ctrl.advice(w.doctor)).filter((k) => MONEY.test(k))).toEqual([]);
  });
});
