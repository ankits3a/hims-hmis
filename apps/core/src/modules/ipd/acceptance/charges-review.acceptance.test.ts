import { HttpException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../../kernel/db/client";
import { ipdAdmissionDeposits, ipdAdmissions, ipdChargeExceptions, ipdChargeLines, refundVouchers } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { CHARGE_RATES, mkChargesWorld } from "../../../../test/helpers/ipd";
import { IpdChargesController } from "../charges.controller";
import { postConsultantVisit, postNightlyIpdCharges, readInterimBill, reverseChargeLine } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ChargesWorld } from "../../../../test/helpers/ipd";

/**
 * E2.1 review (PR #756) — the reviewer's findings, each as a check against the intents with EXPLICIT instants (IST,
 * `+05:30`). Inputs, not a pin on the real clock: the job, the poster and the reads take `now`.
 */

jest.setTimeout(180_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);

describe("E2.1 running bill — review #756", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkChargesWorld(db); });

  const lines = async (admissionId: string) =>
    db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId)).orderBy(ipdChargeLines.serviceDate, ipdChargeLines.component);
  const rentDates = async (admissionId: string) => (await lines(admissionId)).filter((l) => l.component === "room").map((l) => l.serviceDate);

  it("2: a poisoned admission is quarantined after 3 failures and does not fail the job; the others post", async () => {
    const bad = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const good = await w.admitAt("general", ist("2026-03-10T11:00:00"));
    await db.update(ipdAdmissions).set({ tariffVersionId: "NO-SUCH-VERSION" }).where(eq(ipdAdmissions.id, bad.admissionId));
    for (const at of ["2026-03-11T00:05:00", "2026-03-11T00:06:00", "2026-03-11T00:07:00", "2026-03-11T00:08:00"]) {
      await expect(postNightlyIpdCharges(db, ist(at))).resolves.toMatchObject({ failed: expect.any(Number) });
    }
    expect(await rentDates(good.admissionId)).toEqual(["2026-03-10"]);
    const [q] = await db.select().from(ipdChargeExceptions)
      .where(and(eq(ipdChargeExceptions.admissionId, bad.admissionId), eq(ipdChargeExceptions.reason, "posting_failed")));
    expect(q).toMatchObject({ failCount: 3, resolvedAt: null, errorCode: "unknown_version" });
  });

  it("3: an admission that ended long ago with unposted days is still posted; a fully posted one is left alone", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await w.discharge(admissionId, ist("2026-03-12T16:00:00"));
    await postNightlyIpdCharges(db, ist("2026-05-01T00:05:00"));
    expect(await rentDates(admissionId)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    const [a] = await db.select({ through: ipdAdmissions.chargesPostedThrough }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId));
    expect(a!.through).toBe("2026-03-12");
  });

  it("5: the interim bill nets the patient's advance refunds since the admission against the deposit", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await db.insert(ipdAdmissionDeposits).values({
      id: newId(), admissionId, receiptId: newId(), receiptNo: "R-1", amountPaise: 1_000_000, tender: "cash", payerName: "Synthetic Payer",
      payerRelation: "self", idempotencyKey: newId(), takenBy: w.admitDesk.id, takenAt: ist("2026-03-10T10:05:00"),
    });
    await db.insert(refundVouchers).values({
      id: newId(), voucherNo: "RV-TEST-1", patientId, kind: "advance_refund", amountPaise: 400_000, method: "cash", reasonClass: "genuine",
      reason: "Part of the deposit returned", guardFlags: {}, approvalId: newId(), status: "paid", requestedBy: w.admitDesk.id,
      issuedAt: ist("2026-03-11T12:00:00"),
    });
    const bill = await readInterimBill(db, w.billDesk, admissionId);
    expect(bill.depositPaidPaise).toBe(600_000);
  });

  it("6: an admission with no tariff pin gets the resolved version persisted on its first post", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ tariffVersionId: null }).where(eq(ipdAdmissions.id, admissionId));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const [a] = await db.select({ v: ipdAdmissions.tariffVersionId }).from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId));
    expect(a!.v).toBe(w.versionId);
  });

  it("7: a reversed visit can be charged again the same day; a live one still answers repeat", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const tap = (at: string) => withTx(db, (tx) => postConsultantVisit(tx, { admissionId, consultantUserId: w.consultantUserId, seenAt: ist(at), source: "rounds_tap" }));
    const first = await tap("2026-03-10T11:00:00");
    await reverseChargeLine(db, w.billDesk, { chargeLineId: first.chargeLineId!, reason: "Tapped on the wrong patient" });
    await expect(tap("2026-03-10T12:00:00")).resolves.toMatchObject({ outcome: "charged" });
    await expect(tap("2026-03-10T13:00:00")).resolves.toEqual({ outcome: "repeat", chargeLineId: null });
    const net = (await lines(admissionId)).filter((l) => l.component === "visit").reduce((s, l) => s + l.netPaise, 0);
    expect(net).toBe(CHARGE_RATES.general.visit);
  });

  it("9: a zero-net line can be reversed; a double reversal answers charge_line_already_reversed", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const lineId = newId();
    await db.insert(ipdChargeLines).values({
      id: lineId, admissionId, patientId, serviceDate: "2026-03-10", component: "nursing", billedClass: "general", serviceId: newId(),
      serviceCode: "IPD_NURSING_GENERAL", serviceName: "Nursing", tariffVersionId: w.versionId, qty: 1, unitPaise: 50_000, grossPaise: 50_000,
      discountPaise: 50_000, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, netPaise: 0, gstRateBps: 0, gstExempt: true, source: "ipd.nightly",
      postedBy: "t", postedAt: ist("2026-03-11T00:05:00"),
    });
    const both = await Promise.allSettled([
      reverseChargeLine(db, w.billDesk, { chargeLineId: lineId, reason: "Charity write-off posted twice" }),
      reverseChargeLine(db, w.billDesk, { chargeLineId: lineId, reason: "Charity write-off posted twice" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "charge_line_already_reversed" } });
  });

  it("10: POST /ipd/charge-lines/:id/reverse reverses with a reason, refuses without one", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const room = (await lines(admissionId)).find((l) => l.component === "room")!;
    const ctrl = new IpdChargesController(db);
    await expect(ctrl.reverse(w.billDesk, room.id, { reason: " " })).rejects.toBeInstanceOf(HttpException);
    await expect(ctrl.reverse(w.doctor, room.id, { reason: "Wrong class" })).rejects.toMatchObject({ status: 403 });
    await expect(ctrl.reverse(w.billDesk, room.id, { reason: "Wrong class" })).resolves.toMatchObject({ reversalLineId: expect.any(String) });
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(ipdChargeLines).where(eq(ipdChargeLines.reversalOf, room.id))).toEqual([{ n: 1 }]);
  });
});
