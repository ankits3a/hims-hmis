import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { issuePaidInvoice, openSessionFor, seedBillingBase } from "./helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "./helpers/opd";
import { withTx } from "../src/kernel/db/client";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { creditNotes, events, receipts } from "../src/kernel/db/schema";
import { advanceOf, cashierDay, dayBook, invoiceSettlement, issueInvoice, listInvoices } from "../src/modules/billing";
import { changeConsultPricesNow } from "../src/modules/billing/consult-prices";
import { feeGate } from "../src/modules/billing/gate";
import { moveVisitDepartment, previewDepartmentMove } from "../src/modules/opd/department-move";
import { getEncounter, moveEncounter, openVisit, reclassifyVisit } from "../src/modules/opd/encounters";
import { loadOpdReport, rangeFor } from "../src/modules/opd/report";
import type { BillingBaseFixture } from "./helpers/billing";
import type { EncounterRow } from "../src/modules/opd/encounters";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-05 — "yes go ahead" to the four money rules of a department move (billing's
 * `visit-move.ts`): a ₹0 bill is corrected and re-raised; a paid fee that costs the same moves with
 * the visit; a different fee is the billing counter's to settle in the same act; anything else on
 * the bill goes to the billing office first.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const T0 = new Date("2026-08-08T10:00:00.000Z"); // an earlier consult day

describe("OPD — a moved visit takes its money with it", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: Awaited<ReturnType<typeof mkUser>>; // front office + cashier: holds billing.credit_note.issue
  let desk: Awaited<ReturnType<typeof mkUser>>; // front office alone: opens visits, settles no money
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let ortho: Awaited<ReturnType<typeof mkDoctor>>;
  let medic: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let patient: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    ({ deptId, dept2Id } = m);
    base = await seedBillingBase(db);
    ortho = await mkDoctor(db, { username: "drortho", departmentId: deptId, roomId: m.roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    medic = await mkDoctor(db, { username: "drmed", departmentId: dept2Id, roomId: m.room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    cashier = await mkUser(db, "mm_cashier", ["front_office", "cashier"]);
    desk = await mkUser(db, "mm_desk", ["front_office"]);
    vd = await mkUser(db, "mm_vd", ["vitals_desk"]);
    patient = await mkPatient(db, cashier.actor);
    await openSessionFor(db, { id: cashier.id }, 200_000);
    // The cashier holds billing.credit_note.issue, as `seed-roles` grants it; the bare front office does not.
    const registry = new ModuleRegistry();
    registry.install({ key: "billing", title: "Billing", menu: [], permissions: ["billing.credit_note.issue"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "cashier", "billing.credit_note.issue");
  });

  const seatInOrtho = () => openVisit(db, cashier.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
  const payFee = (encounterId: string) => issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.consultNewServiceId, encounterId }, MON);
  const move = (who: { actor: Awaited<ReturnType<typeof mkUser>>["actor"] }, encounterId: string, extra: { tenders?: { mode: "cash"; amountPaise: number }[] } = {}) =>
    moveVisitDepartment(db, who.actor, encounterId, { departmentId: dept2Id, doctorId: medic.doctorId, reason: "booked in ortho by mistake", ...extra }, MON);
  const receiptTotal = async () => (await db.select().from(receipts).where(eq(receipts.patientId, patient.id))).reduce((a, r) => a + r.totalPaise, 0);
  const priorMedicineConsult = async () => {
    const prior = await openVisit(db, cashier.actor, { patientId: patient.id, departmentId: dept2Id, doctorId: medic.doctorId }, T0);
    let enc: EncounterRow = await withTx(db, (tx) => moveEncounter(tx, vd.actor, prior.encounter, "waiting", {}, T0));
    enc = await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "in_consultation", {}, T0));
    await withTx(db, (tx) => moveEncounter(tx, medic.actor, enc, "completed", { consultCompletedAt: T0, followUpDays: 14 }, T0));
  };

  it("RULE 2 — a paid fee that costs the same moves to the new visit: old bill corrected, new bill settled, no money in or out", async () => {
    const wrong = await seatInOrtho();
    const paid = await payFee(wrong.encounter.id);
    const before = await receiptTotal();
    const drawerBefore = await cashierDay(db, cashier.id, "2026-08-17");

    const preview = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, desk.actor);
    expect(preview.money).toMatchObject({ kind: "transfer", invoiceNo: paid.invoiceNo, paidPaise: 50_000, newFeePaise: 50_000, differencePaise: 0 });

    // The registration desk may do it alone: nothing is refunded and nothing new is collected.
    const r = await move(desk, wrong.encounter.id);
    expect(r.money).toMatchObject({ kind: "transfer", invoiceNo: paid.invoiceNo, advancePaise: 0, collectedPaise: 0 });
    expect(r.money.creditNoteNo).not.toBeNull();
    expect(r.money.newInvoiceNo).not.toBeNull();

    const cn = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, paid.invoiceId));
    expect(cn.map((c) => c.kind)).toEqual(["correction"]);
    expect((await invoiceSettlement(db, paid.invoiceId)).outstandingPaise).toBe(0);
    const newBills = await listInvoices(db, { encounterId: r.to.encounter.id });
    expect(newBills).toHaveLength(1);
    expect((await invoiceSettlement(db, newBills[0]!.id)).state).toBe("settled");

    expect(await receiptTotal()).toBe(before); // the drawer is untouched
    expect(await advanceOf(db, patient.id)).toBe(0); // and nothing is left over as credit
    // The cashier's day and the day book still close: one receipt of ₹500, two bills less one correction.
    const drawerAfter = await cashierDay(db, cashier.id, "2026-08-17");
    expect(drawerAfter.totalPaise).toBe(drawerBefore.totalPaise);
    expect(drawerAfter.byMode).toEqual(drawerBefore.byMode);
    const book = await dayBook(db, "2026-08-17");
    expect(book.receipts).toMatchObject({ count: 1, totalPaise: 50_000 });
    expect(book.invoices.netPayablePaise - book.creditNotes.netPaise).toBe(50_000);
    expect(await feeGate(db, (await getEncounter(db, r.to.encounter.id))!)).toEqual({ ok: true }); // the doctor may see them

    const ev = (await db.select().from(events).where(eq(events.name, "visit.moved_department")))[0]!;
    expect(ev.payload).toMatchObject({ money: { kind: "transfer", fromInvoiceNo: paid.invoiceNo, paidPaise: 50_000, newFeePaise: 50_000 } });

    // and the OPD report counts the paid visit in General Medicine
    const report = await loadOpdReport(db, rangeFor("day", "2026-08-17"), MON);
    expect(report.departments.find((d) => d.departmentId === deptId)?.stillOpen ?? 0).toBe(0);
    expect(report.departments.find((d) => d.departmentId === dept2Id)?.stillOpen).toBe(1);
  });

  it("RULE 1 — a ₹0 bill is corrected and the new visit gets its own ₹0 bill, in one click at the desk", async () => {
    await changeConsultPricesNow(db, base.owner, { prices: { new: 0 }, note: "free OPD (समाज सेवा)" }, MON);
    const wrong = await seatInOrtho();
    const zero = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id, encounterId: wrong.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
    }, MON);
    expect(zero.totals.netPayablePaise).toBe(0);

    expect((await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, desk.actor)).money.kind).toBe("zero_bill");
    const r = await move(desk, wrong.encounter.id);
    expect(r.money.kind).toBe("zero_bill");
    expect((await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, zero.invoiceId))).map((c) => c.kind)).toEqual(["correction"]);
    const newBills = await listInvoices(db, { encounterId: r.to.encounter.id });
    expect(newBills.map((b) => b.netPayablePaise)).toEqual([0]);
  });

  it("RULE 3, LOWER — the registration desk is refused; the billing counter moves it and the rest stays as the patient's credit", async () => {
    await priorMedicineConsult(); // medicine sees a free revisit
    const wrong = await seatInOrtho();
    const paid = await payFee(wrong.encounter.id);
    const before = await receiptTotal();

    const asDesk = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, desk.actor);
    expect(asDesk.money).toMatchObject({ kind: "difference", paidPaise: 50_000, newFeePaise: 0, differencePaise: -50_000 });
    expect(asDesk.maySettleDifference).toBe(false);
    await expect(move(desk, wrong.encounter.id)).rejects.toMatchObject({ code: "move_fee_differs" });
    expect((await getEncounter(db, wrong.encounter.id))!.status).toBe("registered"); // nothing moved
    expect(await db.select().from(creditNotes)).toHaveLength(0); // and nothing was credited

    expect((await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, cashier.actor)).maySettleDifference).toBe(true);
    const r = await move(cashier, wrong.encounter.id);
    expect(r.to.visitType).toBe("revisit");
    expect(r.money).toMatchObject({ kind: "difference", advancePaise: 50_000, collectedPaise: 0, newInvoiceNo: null });
    expect((await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, paid.invoiceId))).map((c) => c.kind)).toEqual(["correction"]);
    expect(await advanceOf(db, patient.id)).toBe(50_000); // the patient's credit — refunded from Refunds if they want cash
    expect(await receiptTotal()).toBe(before);
  });

  it("RULE 3, HIGHER — the difference is collected in the same act, or the move does not happen", async () => {
    await changeConsultPricesNow(db, base.owner, { prices: { renewal: 30_000 }, note: "renewal ₹300" }, MON);
    const wrong = await seatInOrtho();
    await reclassifyVisit(db, cashier.actor, wrong.encounter.id, { visitType: "renewal", reason: "seen in ortho last year" }, MON);
    const paid = await issuePaidInvoice(db, cashier, { patientId: patient.id, serviceId: base.consultRenewalServiceId, encounterId: wrong.encounter.id }, MON);
    expect(paid.totals.netPayablePaise).toBe(30_000);

    const p = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, cashier.actor);
    expect(p.money).toMatchObject({ kind: "difference", paidPaise: 30_000, newFeePaise: 50_000, differencePaise: 20_000 });
    // ONE source: the fee line's two amounts are the money line's own (coordinator review 2026-10-05).
    expect(p.from).toMatchObject({ visitType: "renewal", feePaise: 30_000 });
    expect(p.to).toMatchObject({ visitType: "new", feePaise: 50_000 });

    await expect(move(cashier, wrong.encounter.id)).rejects.toMatchObject({ code: "move_difference_unpaid" });
    await expect(move(cashier, wrong.encounter.id, { tenders: [{ mode: "cash", amountPaise: 10_000 }] })).rejects.toMatchObject({ code: "move_difference_unpaid" });
    expect((await getEncounter(db, wrong.encounter.id))!.status).toBe("registered");

    const before = await receiptTotal();
    const r = await move(cashier, wrong.encounter.id, { tenders: [{ mode: "cash", amountPaise: 20_000 }] });
    expect(r.money).toMatchObject({ kind: "difference", collectedPaise: 20_000, advancePaise: 0 });
    expect(await receiptTotal()).toBe(before + 20_000);
    const newBills = await listInvoices(db, { encounterId: r.to.encounter.id });
    expect(newBills.map((b) => b.netPayablePaise)).toEqual([50_000]);
    expect((await invoiceSettlement(db, newBills[0]!.id)).state).toBe("settled");
    expect(await advanceOf(db, patient.id)).toBe(0);
  });

  it("a bill with anything but the consultation on it goes to the billing office — and nothing moves", async () => {
    const wrong = await seatInOrtho();
    await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId: patient.id, encounterId: wrong.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }, { lineId: "x", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 200_000 }] },
    }, MON);
    const p = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, cashier.actor);
    expect(p.money).toMatchObject({ kind: "billing_office", billingOfficeReason: "other_services" });
    await expect(move(cashier, wrong.encounter.id)).rejects.toMatchObject({ code: "move_needs_billing_office" });
    expect((await getEncounter(db, wrong.encounter.id))!.status).toBe("registered");
    expect(await db.select().from(events).where(and(eq(events.name, "visit.moved_department")))).toHaveLength(0);
  });

  it("a visit with no bill moves exactly as before, and says so", async () => {
    const wrong = await seatInOrtho();
    const p = await previewDepartmentMove(db, wrong.encounter.id, dept2Id, MON, desk.actor);
    expect(p.money.kind).toBe("none");
    expect(p.to.feePaise).toBe(p.money.newFeePaise); // the fee line and the money rule read one pricer
    expect(p.from.feePaise).toBe(50_000);
    const r = await move(desk, wrong.encounter.id);
    expect(r.money).toMatchObject({ kind: "none", creditNoteNo: null, newInvoiceNo: null });
  });
});
