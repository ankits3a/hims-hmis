import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { alerts, events, ipdDailyTotals, ipdDepositAlerts, notifications, patients } from "../../../kernel/db/schema";
import { issueRefundVoucher, requestRefund } from "../../billing";
import { openSession } from "../../billing/sessions";
import { runNotifyPump } from "../../../kernel/notify/pump";
import { templateByKey } from "../../../kernel/notify/templates";
import { patientsManifest } from "../../patients";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { CHARGE_RATES, mkChargesWorld } from "../../../../test/helpers/ipd";
import {
  SEALED_LABEL, backfillDowntime, evaluateDepositLadder, ipdManifest, postConsultantVisit, postNightlyIpdCharges, queueDailyTotals,
  readBillDesk, registerIpdAdvanceRefundListener, reverseChargeLine, runIpdBillDeskNightly, takeDeposit,
} from "../index";
import { withTx } from "../../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { ChargesWorld } from "../../../../test/helpers/ipd";

/**
 * E2.3 (#727) — "DONE MEANS" FOR THE DEPOSIT LADDER, THE DAILY TOTALS AND THE BILL DESK (spec SPEC-ipd-core §2 answer 3,
 * §4.3, §4.9 H, §6 Bill: "Deposit alerts at 75 % and 90 % fire once each, never to a doctor"; decision 0072 answer 3).
 * Every call takes an EXPLICIT instant (IST, `+05:30`); nothing here reads the clock. The fixture's general day is
 * room + nursing + RMO from `CHARGE_RATES` (₹2,200); deposits are chosen against it.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const DAY = CHARGE_RATES.general.room + CHARGE_RATES.general.nursing + CHARGE_RATES.general.rmo;
const DIAGNOSIS = "Dengue haemorrhagic fever";

describe("E2.3 deposit ladder and bill desk — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;
  let people: Record<"cashier" | "foSupervisor" | "dutyManager" | "doctorCashier", Actor>;
  let desk: Actor;
  let serial = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkChargesWorld(db);
    people = {
      cashier: (await mkUser(db, "bd.cashier", ["cashier"])).actor,
      foSupervisor: (await mkUser(db, "bd.fosup", ["front_office_supervisor"])).actor,
      dutyManager: (await mkUser(db, "bd.duty", ["duty_manager"])).actor,
      // A doctor who also sits a cashier seat: still a doctor, never told about money (decision 0058).
      doctorCashier: (await mkUser(db, "bd.doccash", ["doctor", "cashier"])).actor,
    };
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "t_billdesk");
    for (const p of ["ipd.billdesk.view", "ipd.bill.view"]) await grantPermissionToRole(db, registry, "t_billdesk", p);
    desk = (await mkUser(db, "bd.desk", ["t_billdesk"])).actor;
  });

  /** A cash patient admitted (downtime back-fill, explicit instants) onto a fresh general bed. */
  const admitCash = async (at: string): Promise<{ admissionId: string; patientId: string }> => {
    serial += 1;
    const patientId = await w.patient("male", 45, `Ramesh Kumar Test${String(serial)}`);
    const bedId = await w.bed(`BD-G-${String(serial)}`, { class: "general" });
    const done = await backfillDowntime(db, w.admitDesk, {
      idempotencyKey: key(), paperSerial: `BD-${String(serial)}`, patientId, bedId, consultantId: w.doctor.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: DIAGNOSIS, mlc: false, payerKind: "cash",
      requestedAt: ist(at).toISOString(), admittedAt: ist(at).toISOString(), consent: PAPER,
    }, { now: ist(at) });
    return { admissionId: done.admissionId, patientId };
  };
  const deposit = (admissionId: string, amountPaise: number, at: string, payer: Record<string, unknown> = { name: "Sita Devi", relation: "relative", phone: "9812345678" }) =>
    takeDeposit(db, w.admitDesk, { idempotencyKey: key(), admissionId, amountPaise, tender: "cash", payer }, { now: ist(at) });
  const notices = async (admissionId: string) => db.select({ userId: alerts.userId, title: alerts.title })
    .from(alerts).where(and(eq(alerts.kind, "ipd.deposit_low"), eq(alerts.refId, admissionId)));
  const alertRows = async (admissionId: string) => db.select().from(ipdDepositAlerts).where(eq(ipdDepositAlerts.admissionId, admissionId));

  it("(i) deposit alerts at 75 % and 90 % fire once each, never to a doctor", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    // Night 1: ₹2,200 of ₹2,900 = 75.8 % — the top-up level only.
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const n1 = await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
    expect(n1.ladder.find((o) => o.admissionId === admissionId)).toMatchObject({ usedBp: 7586, fired: ["top_up"] });
    const afterNight1 = await notices(admissionId);
    const told = new Set(afterNight1.map((n) => n.userId));
    expect(told.has(people.cashier.id) && told.has(people.foSupervisor.id) && told.has(w.billingManager.id)).toBe(true);
    expect(told.has(people.dutyManager.id) || told.has(w.ms.id) || told.has(w.owner.id)).toBe(false);
    // Rerun the same night: nothing new.
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:30:00"));
    await evaluateDepositLadder(db, admissionId, ist("2026-03-11T09:00:00"));
    expect(await notices(admissionId)).toHaveLength(afterNight1.length);
    // Night 2: ₹4,400 of ₹2,900 — the escalation, to management as well; the top-up does not fire again.
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    const n2 = await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    expect(n2.ladder.find((o) => o.admissionId === admissionId)).toMatchObject({ fired: ["escalate"], rearmed: [] });
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:40:00"));
    const rows = await alertRows(admissionId);
    expect(rows.map((r) => r.level).sort()).toEqual(["escalate", "top_up"]);
    const all = await notices(admissionId);
    const escalated = new Set(all.filter((n) => n.title.includes("90")).map((n) => n.userId));
    // Review 3 (decision 0058): the escalation is the billing manager, the duty manager and the owner — never the MS.
    expect([...escalated].sort()).toEqual([w.billingManager.id, people.dutyManager.id, w.owner.id].sort());
    expect(all.filter((n) => n.userId === w.ms.id)).toEqual([]);
    // Once each: one notice per person per level.
    expect(all.filter((n) => n.userId === people.cashier.id)).toHaveLength(1);
    expect(all.filter((n) => n.userId === w.billingManager.id)).toHaveLength(2);
    // Never a doctor: neither the doctor nor the doctor in a cashier seat.
    const doctors = [w.doctor.id, w.resident.id, w.crossUserId, people.doctorCashier.id];
    expect(all.filter((n) => doctors.includes(n.userId))).toEqual([]);
    expect(await db.select().from(alerts).where(eq(alerts.userId, people.doctorCashier.id))).toEqual([]);
  });

  it("(ii) a top-up re-arms a level only below 70 % (top-up) / 85 % (escalation) — hysteresis", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    expect((await alertRows(admissionId)).filter((r) => r.rearmedAt === null)).toHaveLength(2);
    const live = async () => (await alertRows(admissionId)).filter((r) => r.rearmedAt === null).map((r) => r.level).sort();
    // Top-up to ₹4,400 of ₹6,111.12 = 71.99 %: under 85 % re-arms the escalation; not under 70 %, the top-up stays live.
    await deposit(admissionId, 321_112, "2026-03-12T11:00:00");
    expect(await live()).toEqual(["top_up"]);
    // Another ₹800: 63.7 % — the top-up re-arms too.
    await deposit(admissionId, 80_000, "2026-03-12T11:30:00");
    expect(await live()).toEqual([]);
    // Night 3: ₹6,600 of ₹6,911.12 = 95.5 % — both fire again, a new row each.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    const n3 = await runIpdBillDeskNightly(db, ist("2026-03-13T00:06:00"));
    expect(n3.ladder.find((o) => o.admissionId === admissionId)?.fired).toEqual(["top_up", "escalate"]);
    const rows = await alertRows(admissionId);
    expect(rows.filter((r) => r.level === "top_up")).toHaveLength(2);
    expect(rows.filter((r) => r.level === "escalate")).toHaveLength(2);
    expect((await notices(admissionId)).filter((n) => n.userId === people.cashier.id)).toHaveLength(2);
  });

  it("(iii) the daily totals message carries totals only — no line, no diagnosis; a sealed admission sends none", async () => {
    const { admissionId, patientId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 500_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    const run = await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    expect(run.dailyTotals).toMatchObject({ billDate: "2026-03-11", queued: 1 });
    const [row] = await db.select().from(notifications).where(eq(notifications.refId, admissionId));
    expect(row).toMatchObject({ templateKey: "ipd.daily_totals", refType: "admission", audience: "patient", patientId });
    // Totals only, as references and numbers: no phone, no line, no class, no bed, no diagnosis in the params.
    expect(Object.keys(row!.params).sort()).toEqual(
      ["attendant", "attendantRef", "balancePaise", "billDate", "dayOfStay", "depositPaise", "name", "totalPaise"]);
    expect(row!.params).toMatchObject({ name: "Ramesh", dayOfStay: 2, totalPaise: 2 * DAY, depositPaise: 500_000, balancePaise: 500_000 - 2 * DAY, attendant: "deposit_payer" });
    for (const lang of ["en", "hi"] as const) {
      const text = templateByKey("ipd.daily_totals").render[lang](row!.params);
      expect(text).toContain("4,400");
      for (const word of [DIAGNOSIS, "Dengue", "room", "Room", "nursing", "Nursing", "RMO", "visit", "general", "BD-G", "Kumar", "9812345678"]) {
        expect(text).not.toContain(word);
      }
    }
    // A rerun queues nothing new (one message per admission per day).
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:30:00"));
    expect(await db.select().from(notifications).where(eq(notifications.refId, admissionId))).toHaveLength(1);
    // No provider may carry it yet: the pump records it suppressed `template_pending`, it is never sent.
    await runNotifyPump(db, { now: ist("2026-03-12T09:00:00") });
    const [held] = await db.select().from(notifications).where(eq(notifications.refId, admissionId));
    expect(held).toMatchObject({ status: "suppressed", lastError: "template_pending", sentAt: null });

    // Sealed (sensitive context): no message at all, the reason recorded.
    const sealed = await admitCash("2026-03-10T11:00:00");
    await deposit(sealed.admissionId, 500_000, "2026-03-10T11:30:00");
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, sealed.patientId));
    expect(await queueDailyTotals(db, sealed.admissionId, "2026-03-11", ist("2026-03-12T00:06:00"))).toBe("sealed");
    expect(await db.select().from(notifications).where(eq(notifications.refId, sealed.admissionId))).toEqual([]);
    // No attendant phone (the patient paid himself, no guardian): skipped with the reason.
    const alone = await admitCash("2026-03-10T12:00:00");
    await deposit(alone.admissionId, 500_000, "2026-03-10T12:30:00", { name: "Self", relation: "self" });
    // Review 9: two runs at once record ONE day and ONE skip (advisory lock + unique (admission, IST date)).
    const twice = await Promise.all([1, 2].map(() => queueDailyTotals(db, alone.admissionId, "2026-03-11", ist("2026-03-12T00:06:00"))));
    expect(twice.sort()).toEqual(["already", "no_attendant_phone"]);
    expect(await db.select().from(notifications).where(eq(notifications.refId, alone.admissionId))).toEqual([]);
    expect((await db.select().from(ipdDailyTotals).where(eq(ipdDailyTotals.admissionId, alone.admissionId))).map((r) => r.outcome)).toEqual(["no_attendant_phone"]);
    const skips = await db.select({ seq: events.seq }).from(events)
      .where(and(eq(events.name, "ipd.daily_totals.skipped"), sql`${events.payload}->>'admissionId' = ${alone.admissionId}`));
    expect(skips).toHaveLength(1);
  });

  it("(iv) the bill desk lists only exceptions: an admission under 75 % does not appear", async () => {
    const over = await admitCash("2026-03-10T10:00:00");
    await deposit(over.admissionId, 290_000, "2026-03-10T10:30:00");
    const normal = await admitCash("2026-03-10T10:10:00");
    await deposit(normal.admissionId, 2_000_000, "2026-03-10T10:40:00");
    const unchecked = await admitCash("2026-03-10T10:20:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
    const view = await readBillDesk(db, desk, ist("2026-03-11T09:00:00"));
    const ids = view.rows.map((r) => r.admissionId);
    expect(ids).toContain(over.admissionId);
    expect(ids).toContain(unchecked.admissionId);
    expect(ids).not.toContain(normal.admissionId);
    expect(view.rows.find((r) => r.admissionId === over.admissionId)).toMatchObject({ reasons: ["deposit_75"], usedBp: 7586, depositHeldPaise: 290_000 });
    // The unchecked downtime admission holds no deposit at all: payable over nothing counts as over 90 % (DECIDED).
    expect(view.rows.find((r) => r.admissionId === unchecked.admissionId)!.reasons).toEqual(["deposit_90", "deposit_check_pending"]);
    expect(view.counts).toMatchObject({ deposit_75: 1, deposit_90: 1, deposit_check_pending: 1, rate_missing: 0 });
    expect(view.canRetry).toBe(false);
    // A doctor has no door to it (decision 0058).
    await expect(readBillDesk(db, w.doctor, ist("2026-03-11T09:00:00"))).rejects.toMatchObject({ code: "ipd_forbidden" });
  });

  it("(v) the ladder never refuses a clinical act: it only notifies", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 100_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    expect((await alertRows(admissionId)).map((r) => r.level).sort()).toEqual(["escalate", "top_up"]);
    // Over 90 % used: the consultant's round still records and posts; the next night still posts.
    const seen = await withTx(db, (tx) => postConsultantVisit(tx, { admissionId, consultantUserId: w.doctor.id, seenAt: ist("2026-03-12T10:00:00"), source: "rounds_tap" }));
    expect(seen.outcome).toBe("charged");
    const night = await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect(night.failed).toBe(0);
    // Structurally: no IPD file but the ladder's own and the bill desk's reads the ladder's rows.
    const dir = join(__dirname, "..");
    const readers = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("ipdDepositAlerts"));
    expect(readers.sort()).toEqual(["bill-desk.ts", "deposit-ladder.ts"]);
  });
  it("RED 1: one admission's failure never skips the others — ladder and daily totals each in their own try", async () => {
    const bad = await admitCash("2026-03-10T10:00:00");
    await deposit(bad.admissionId, 290_000, "2026-03-10T10:30:00");
    const good = await admitCash("2026-03-10T10:10:00");
    await deposit(good.admissionId, 290_000, "2026-03-10T10:40:00");
    // The bad admission's ladder write fails in the database (a trigger stands for any domain or data fault).
    await db.execute(sql.raw(`create or replace function t_ladder_fail() returns trigger language plpgsql as $$ begin
      if new.admission_id = '${bad.admissionId}' then raise exception 'synthetic ladder fault'; end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger t_ladder_fail before insert or update on ipd_deposit_alerts for each row execute function t_ladder_fail()`));
    try {
      await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
      const run = await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
      expect(run.ladderFailed).toEqual([bad.admissionId]);
      expect(run.ladder.find((o) => o.admissionId === good.admissionId)?.fired).toEqual(["top_up"]);
      expect(run.dailyTotals).toMatchObject({ queued: 2, failed: [] });
    } finally {
      await db.execute(sql.raw("drop trigger if exists t_ladder_fail on ipd_deposit_alerts; drop function if exists t_ladder_fail()"));
    }
  });

  it("2: a sealed patient is on the bill desk by alias or a neutral label — no name, UHID or bed", async () => {
    const s1 = await admitCash("2026-03-10T10:00:00");
    await deposit(s1.admissionId, 290_000, "2026-03-10T10:30:00");
    await db.update(patients).set({ sensitiveContext: true, alias: null }).where(eq(patients.id, s1.patientId));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
    const row = (await readBillDesk(db, desk, ist("2026-03-11T09:00:00"))).rows.find((r) => r.admissionId === s1.admissionId)!;
    expect(row).toMatchObject({ patient: { uhid: "", name: SEALED_LABEL }, bedCode: null });
    expect(JSON.stringify(row)).not.toContain("Ramesh");
  });

  it("4: no deposit owed (an emergency before stabilisation) → the ladder does not run", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
    expect(await alertRows(admissionId)).toEqual([]);
    expect((await readBillDesk(db, desk, ist("2026-03-11T09:00:00"))).rows.map((r) => r.admissionId)).not.toContain(admissionId);
  });

  it("5: the notices are raised in the alert row's transaction — a failed notice leaves no fired level behind", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await db.execute(sql.raw(`create or replace function t_notice_fail() returns trigger language plpgsql as $$ begin
      if new.kind = 'ipd.deposit_low' then raise exception 'synthetic notice fault'; end if; return new; end $$`));
    await db.execute(sql.raw("create trigger t_notice_fail before insert on alerts for each row execute function t_notice_fail()"));
    try {
      await expect(evaluateDepositLadder(db, admissionId, ist("2026-03-11T00:06:00"))).rejects.toThrow();
    } finally {
      await db.execute(sql.raw("drop trigger if exists t_notice_fail on alerts; drop function if exists t_notice_fail()"));
    }
    expect(await alertRows(admissionId)).toEqual([]);
    // Next time round it fires, with its notices.
    expect((await evaluateDepositLadder(db, admissionId, ist("2026-03-11T00:30:00"))).fired).toEqual(["top_up"]);
    expect((await notices(admissionId)).length).toBeGreaterThan(0);
  });

  it("7: a reversal re-arms and clears the desk; an advance refund fires the ladder", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:06:00"));
    expect((await readBillDesk(db, desk, ist("2026-03-11T09:00:00"))).rows.find((r) => r.admissionId === admissionId)?.reasons).toEqual(["deposit_75"]);
    // Reverse the day's nursing: ₹1,700 of ₹2,900 = 58.6 % — re-armed at once, gone from the desk.
    const nursing = (await db.execute(sql`select id from ipd_charge_lines where admission_id = ${admissionId} and component = 'nursing'`)).rows[0] as { id: string };
    await reverseChargeLine(db, w.billDesk, { chargeLineId: nursing.id, reason: "Synthetic wrong charge" }, { now: ist("2026-03-11T10:00:00") });
    expect((await alertRows(admissionId)).every((r) => r.rearmedAt !== null)).toBe(true);
    expect((await readBillDesk(db, desk, ist("2026-03-11T10:05:00"))).rows.map((r) => r.admissionId)).not.toContain(admissionId);

    // A second stay: ₹4,000 held, ₹2,200 posted (55 %); ₹1,500 of the advance refunded → ₹2,200 of ₹2,500 = 88 %.
    const other = await admitCash("2026-03-10T11:00:00");
    await deposit(other.admissionId, 400_000, "2026-03-10T11:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-11T00:07:00"));
    expect(await alertRows(other.admissionId)).toEqual([]);
    const unregister = registerIpdAdvanceRefundListener();
    try {
      await openSession(db, people.cashier, 0);
      const ask = { kind: "advance_refund" as const, patientId: other.patientId, amountPaise: 150_000, reasonClass: "genuine" as const, reason: "Synthetic part refund" };
      const asked = await requestRefund(db, people.cashier, ask);
      await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "fixture" });
      await issueRefundVoucher(db, people.cashier, { ...ask, approvalId: asked.approvalId, method: "cash" }, ist("2026-03-11T12:00:00"));
    } finally { unregister(); }
    expect((await alertRows(other.admissionId)).map((r) => r.level)).toEqual(["top_up"]);
  });

  it("8: a ladder failure after a committed receipt is logged; the desk gets its receipt", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    await db.execute(sql.raw(`create or replace function t_rearm_fail() returns trigger language plpgsql as $$ begin
      raise exception 'synthetic re-arm fault'; end $$`));
    await db.execute(sql.raw("create trigger t_rearm_fail before update on ipd_deposit_alerts for each row execute function t_rearm_fail()"));
    try {
      const out = await deposit(admissionId, 500_000, "2026-03-12T11:00:00");
      expect(out.amountPaise).toBe(500_000);
    } finally {
      await db.execute(sql.raw("drop trigger if exists t_rearm_fail on ipd_deposit_alerts; drop function if exists t_rearm_fail()"));
    }
    // The receipt stands; the nightly run re-evaluates and re-arms.
    await runIpdBillDeskNightly(db, ist("2026-03-12T12:00:00"));
    expect((await alertRows(admissionId)).every((r) => r.rearmedAt !== null)).toBe(true);
  });
});
