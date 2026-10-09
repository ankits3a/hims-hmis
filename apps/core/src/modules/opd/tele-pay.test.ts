import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { billingConfig, opdAppointments, receiptTenders, receipts } from "../../kernel/db/schema";
import { encodeQr } from "../../kernel/printing/qr";
import { bookAppointment, cancelAppointment, rescheduleAppointment } from "./appointments";
import { moveEncounter, openVisit } from "./encounters";
import { recordTeleAdvance, teleDeskMarks, teleFee } from "./tele";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/**
 * TELE-CALL, SLICE 2 (owner 2026-10-09): *"tele-call costs same as in-person visit"* — the desk is
 * quoted the in-person fee for the slot's date and takes exactly it as one advance receipt.
 */
const S0930 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");
const T0 = new Date("2026-08-10T05:00:00.000Z"); // a consult a week before the slot
const FEE = 50_000; // seedBillingBase prices both consult services at ₹500

describe("opd tele-call — the desk's fee and the advance (slice 2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let p1: { id: string };
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    await seedBillingBase(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clerk = await mkUser(db, "tp_clerk", ["front_office", "cashier"]);
    vd = await mkUser(db, "tp_vd", ["vitals_desk"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
  });
  const bookTele = async (slotStart: Date = S0930) =>
    (await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart, mode: "tele", telePhone: "9876543021" }, NOW_SUN)).appointment;
  const cash = (amountPaise: number) => ({ amountPaise, tenders: [{ mode: "cash" as const, amountPaise }] });
  const row = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!;

  it("quotes the in-person fee for the slot's date; an in-person appointment has no tele fee", async () => {
    const a = await bookTele();
    expect(await teleFee(db, a.id)).toEqual({ appointmentId: a.id, amountPaise: FEE, covered: false, receiptId: null, upi: null });
    expect((await teleDeskMarks(db, [a])).get(a.id)).toEqual({ amountPaise: FEE, covered: false });
    const walk = (await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S1000 }, NOW_SUN)).appointment;
    await expect(teleFee(db, walk.id)).rejects.toMatchObject({ code: "not_a_tele_appointment" });
    await expect(recordTeleAdvance(db, clerk.actor, walk.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "not_a_tele_appointment" });
    expect((await teleDeskMarks(db, [walk])).size).toBe(0);
  });

  it("no open drawer: billing's own refusal, and nothing is stamped", async () => {
    const a = await bookTele();
    await expect(recordTeleAdvance(db, clerk.actor, a.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "no_open_session" });
    expect((await row(a.id)).advanceQuotedAt).toBeNull();
    expect(await db.select().from(receipts)).toHaveLength(0);
  });

  it("a wrong amount is refused with the right one; tenders that do not add up are refused; a UPI tender needs its reference", async () => {
    await openSessionFor(db, clerk, 0);
    const a = await bookTele();
    await expect(recordTeleAdvance(db, clerk.actor, a.id, cash(FEE - 100), NOW_SUN)).rejects.toMatchObject({ code: "tele_amount_mismatch", detail: { expectedPaise: FEE } });
    await expect(recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: FEE, tenders: [{ mode: "cash", amountPaise: FEE - 100 }] }, NOW_SUN)).rejects.toMatchObject({ code: "tele_amount_mismatch" });
    await expect(recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: FEE, tenders: [] }, NOW_SUN)).rejects.toMatchObject({ code: "tele_amount_mismatch" });
    await expect(recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: FEE, tenders: [{ mode: "upi", amountPaise: FEE, refText: "  " }] }, NOW_SUN)).rejects.toMatchObject({ code: "tele_upi_reference_required" });
    expect(await db.select().from(receipts)).toHaveLength(0);
    expect((await row(a.id)).advanceQuotedAt).toBeNull();
  });

  it("paid: ONE advance receipt for exactly the quote, the appointment stamped; a second payment is refused and takes nothing", async () => {
    await openSessionFor(db, clerk, 0);
    const a = await bookTele();
    const r = await recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: FEE, tenders: [{ mode: "upi", amountPaise: FEE, refText: " 428311907755 " }] }, NOW_SUN);
    expect(r.amountPaise).toBe(FEE);
    expect(r.receiptNo).toMatch(/\S/);
    const got = await db.select().from(receipts);
    expect(got).toHaveLength(1);
    expect({ id: got[0]!.id, patientId: got[0]!.patientId, totalPaise: got[0]!.totalPaise, receivedBy: got[0]!.receivedBy })
      .toEqual({ id: r.receiptId, patientId: p1.id, totalPaise: FEE, receivedBy: clerk.id });
    const tenders = await db.select().from(receiptTenders);
    expect(tenders.map((t) => ({ mode: t.mode, amountPaise: t.amountPaise, refText: t.refText }))).toEqual([{ mode: "upi", amountPaise: FEE, refText: "428311907755" }]);
    const stamped = await row(a.id);
    expect({ r: stamped.advanceReceiptId, q: stamped.advanceQuotePaise, at: stamped.advanceQuotedAt?.toISOString(), status: stamped.status })
      .toEqual({ r: r.receiptId, q: FEE, at: NOW_SUN.toISOString(), status: "booked" });
    expect(await teleFee(db, a.id)).toEqual({ appointmentId: a.id, amountPaise: FEE, covered: true, receiptId: r.receiptId, upi: null });
    expect((await teleDeskMarks(db, [stamped])).get(a.id)).toEqual({ amountPaise: FEE, covered: true });

    await expect(recordTeleAdvance(db, clerk.actor, a.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "tele_advance_state_conflict" });
    expect(await db.select().from(receipts)).toHaveLength(1);
  });

  it("a follow-up inside the doctor's free window is ₹0: covered with no receipt and no drawer", async () => {
    const prior = await openVisit(db, clerk.actor, { patientId: p1.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, prior.encounter, "waiting", {}, T0));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "in_consultation", {}, T0));
    await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "completed", { consultCompletedAt: T0, followUpDays: 14 }, T0));
    const a = await bookTele();
    expect((await teleFee(db, a.id)).amountPaise).toBe(0);
    await expect(recordTeleAdvance(db, clerk.actor, a.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "tele_amount_mismatch", detail: { expectedPaise: 0 } });
    const r = await recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: 0 }, NOW_SUN);
    expect({ receiptId: r.receiptId, amountPaise: r.amountPaise }).toEqual({ receiptId: null, amountPaise: 0 });
    const stamped = await row(a.id);
    expect({ r: stamped.advanceReceiptId, q: stamped.advanceQuotePaise, covered: stamped.advanceQuotedAt !== null }).toEqual({ r: null, q: 0, covered: true });
    expect(await db.select().from(receipts)).toHaveLength(0);
  });

  it("a paid tele-call that is moved stays paid; one that is cancelled keeps its receipt on the row (refund is by request)", async () => {
    await openSessionFor(db, clerk, 0);
    const a = await bookTele();
    const r = await recordTeleAdvance(db, clerk.actor, a.id, cash(FEE), NOW_SUN);
    const { to } = await rescheduleAppointment(db, clerk.actor, a.id, { slotStart: S1000 }, NOW_SUN);
    expect({ r: to.advanceReceiptId, q: to.advanceQuotePaise, at: to.advanceQuotedAt?.toISOString(), mode: to.mode })
      .toEqual({ r: r.receiptId, q: FEE, at: NOW_SUN.toISOString(), mode: "tele" });
    await expect(recordTeleAdvance(db, clerk.actor, to.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "tele_advance_state_conflict" });

    const { appointment: gone } = await cancelAppointment(db, clerk.actor, to.id, "patient asked", NOW_SUN);
    expect({ status: gone.status, r: gone.advanceReceiptId, q: gone.advanceQuotePaise }).toEqual({ status: "cancelled", r: r.receiptId, q: FEE });
    expect(await db.select().from(receipts)).toHaveLength(1);
    // a cancelled appointment cannot be paid for
    const b = await bookTele(S0930);
    await cancelAppointment(db, clerk.actor, b.id, "changed mind", NOW_SUN);
    await expect(recordTeleAdvance(db, clerk.actor, b.id, cash(FEE), NOW_SUN)).rejects.toMatchObject({ code: "tele_advance_state_conflict" });
  });

  // ——— slice 6: the hospital's UPI id as a QR on the desk's Collect sheet ———

  it("UPI QR: none without a UPI id; with one, the fee carries the payment request — payee, exact amount, the appointment number — and its QR; never once paid, and never for a free one", async () => {
    await openSessionFor(db, clerk, 0);
    const a = await bookTele();
    expect((await teleFee(db, a.id)).upi).toBeNull();

    await db.update(billingConfig).set({ upiVpa: "crkmch@sbi", upiPayeeName: "CRK Medical College & Hospital" }).where(eq(billingConfig.id, "main"));
    const fee = await teleFee(db, a.id);
    expect(fee.upi).not.toBeNull();
    expect(fee.upi!.uri).toBe(`upi://pay?pa=crkmch%40sbi&pn=CRK%20Medical%20College%20%26%20Hospital&am=500.00&cu=INR&tn=${a.appointmentNo}`);
    expect({ vpa: fee.upi!.vpa, payeeName: fee.upi!.payeeName }).toEqual({ vpa: "crkmch@sbi", payeeName: "CRK Medical College & Hospital" });
    // the QR is the server's own encoder's answer for exactly that request: a square of 0s and 1s
    const matrix = encodeQr(fee.upi!.uri);
    expect(fee.upi!.qr).toEqual(matrix.map((row) => row.map((d) => (d ? "1" : "0")).join("")));
    expect(fee.upi!.qr.every((row) => row.length === fee.upi!.qr.length && /^[01]+$/.test(row))).toBe(true);

    await recordTeleAdvance(db, clerk.actor, a.id, { amountPaise: FEE, tenders: [{ mode: "upi", amountPaise: FEE, refText: "428311907755" }] }, NOW_SUN);
    expect((await teleFee(db, a.id)).upi).toBeNull();
  });
});
