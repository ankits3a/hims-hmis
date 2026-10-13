import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { alerts, ipdDepositAlerts, notifications, patients } from "../../../kernel/db/schema";
import { runNotifyPump } from "../../../kernel/notify/pump";
import { templateByKey } from "../../../kernel/notify/templates";
import { patientsManifest } from "../../patients";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { CHARGE_RATES, mkChargesWorld } from "../../../../test/helpers/ipd";
import {
  backfillDowntime, evaluateDepositLadder, ipdManifest, postConsultantVisit, postNightlyIpdCharges, queueDailyTotals,
  readBillDesk, runIpdBillDeskNightly, takeDeposit,
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
    expect(told.has(people.dutyManager.id) || told.has(w.ms.id)).toBe(false);
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
    for (const u of [people.cashier, people.foSupervisor, w.billingManager, people.dutyManager, w.ms]) expect(escalated.has(u.id)).toBe(true);
    // Once each: one notice per person per level.
    expect(all.filter((n) => n.userId === people.cashier.id)).toHaveLength(2);
    // Never a doctor: neither the doctor nor the doctor in a cashier seat.
    const doctors = [w.doctor.id, w.resident.id, w.crossUserId, people.doctorCashier.id];
    expect(all.filter((n) => doctors.includes(n.userId))).toEqual([]);
    expect(await db.select().from(alerts).where(eq(alerts.userId, people.doctorCashier.id))).toEqual([]);
  });

  it("(ii) a top-up that brings usage back under a threshold re-arms it", async () => {
    const { admissionId } = await admitCash("2026-03-10T10:00:00");
    await deposit(admissionId, 290_000, "2026-03-10T10:30:00");
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    await runIpdBillDeskNightly(db, ist("2026-03-12T00:06:00"));
    expect((await alertRows(admissionId)).filter((r) => r.rearmedAt === null)).toHaveLength(2);
    // Top-up ₹4,000: ₹4,400 of ₹6,900 = 63.8 % — both levels re-arm at the receipt.
    await deposit(admissionId, 400_000, "2026-03-12T11:00:00");
    const after = await alertRows(admissionId);
    expect(after.every((r) => r.rearmedAt !== null)).toBe(true);
    // Night 3: ₹6,600 of ₹6,900 = 95.6 % — both fire again, a new row each.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    const n3 = await runIpdBillDeskNightly(db, ist("2026-03-13T00:06:00"));
    expect(n3.ladder.find((o) => o.admissionId === admissionId)?.fired).toEqual(["top_up", "escalate"]);
    const rows = await alertRows(admissionId);
    expect(rows.filter((r) => r.level === "top_up")).toHaveLength(2);
    expect(rows.filter((r) => r.rearmedAt === null).map((r) => r.level).sort()).toEqual(["escalate", "top_up"]);
    expect((await notices(admissionId)).filter((n) => n.userId === people.cashier.id)).toHaveLength(4);
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
    expect(await queueDailyTotals(db, alone.admissionId, "2026-03-11", ist("2026-03-12T00:06:00"))).toBe("no_attendant_phone");
    expect(await db.select().from(notifications).where(eq(notifications.refId, alone.admissionId))).toEqual([]);
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
});
