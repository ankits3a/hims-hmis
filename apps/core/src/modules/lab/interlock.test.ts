import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor } from "../../../test/helpers/billing";
import {
  grantLabResultPermissions, runLabOrder, seedLabDeskBase, serviceIdForLabCode, settleInvoice,
} from "../../../test/helpers/lab";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { withTx } from "../../kernel/db/client";
import { invoiceLines, invoices, labItems, orderItems, orders, services } from "../../kernel/db/schema";
import { issueInvoice } from "../billing";
import { deliveryAllowed, EXEMPT_PAYERS } from "./interlock";
import { activateTshReflex } from "./verify.test.helpers";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T7 / DD6, **DD23** — **THE DELIVERY INTERLOCK**. Assertion Book rows **A1, A1b, A2**.
 *
 * The §9.7 operand question — *"what is the compared quantity summed from, and name one real
 * transaction whose money that sum does not include"* — is answered by construction here: this
 * function SUMS NOTHING. It asks `invoiceSettlement` once per invoice and takes billing's verdict,
 * so the only thing to prove is that it asks about EVERY invoice carrying one of this order's lab
 * lines, which is A1, and that "some money arrived" is not "settled", which is A1b.
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("the lab delivery interlock (17b T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let cashier: { id: string; actor: { type: "user"; id: string } };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    cashier = await mkCashier(db, "lab.cashier") as typeof cashier;
    await openSessionFor(db, cashier, 0);
  });
  afterEach(() => { fx.unregister(); });

  /* ═════════ A1 — EVERY INVOICE CARRYING ONE OF THIS ORDER'S LAB LINES (DD23) ═════════ */

  it("A1: an order billed across TWO invoices is blocked while EITHER is unsettled", async () => {
    /**
     * ═══ §9.4 — A1's DISCRIMINATING INPUT IS CORRECTED BY EXECUTION ═══
     *
     * The plan wrote it as *"a CBC paid at the desk and a reflex FT4 invoiced on credit"* on ONE
     * order. **17a's DD9 does not produce that shape**: a reflex is a NEW ORDER in the same group
     * with its own invoice (proved by T6 A4), so `deliveryAllowed(deskOrderId)` legitimately never
     * sees the reflex's bill — each order carries its own report.
     *
     * The CLAIM A1 exists to make is still exactly right and is asserted below: `lab_items.invoice_id`
     * is per ITEM, so one order's lines can sit on two invoices, and the interlock must ask about
     * every one of them. The second invoice is composed through billing's own writer and the lab's
     * own column is repointed at it — the same construction A1b uses, and the honest one, because
     * no shipped writer produces a two-invoice order today (recorded in §9.2 as the reason DD23's
     * loop is defensive rather than exercised by the desk).
     */
    const run = await runLabOrder(db, fx, ["TSH", "GLUF"], { at: AT });
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);
    expect((await deliveryAllowed(db, run.orderId)).allowed).toBe(true);

    const second = await issueInvoice(db, fx.desk.actor, {
      draftId: newId(),
      patientId: fx.patientId,
      encounterId: fx.encounterNo,
      lines: [{ lineId: newId(), serviceId: serviceIdForLabCode("GLUF"), qty: 1 }],
      credit: { reason: "re-billed to the patient after the corporate cover was refused" },
    }, AT);
    const [secondLine] = await db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, second.invoiceId));
    await db.update(labItems)
      .set({ invoiceId: second.invoiceId, invoiceLineId: secondLine!.id })
      .where(eq(labItems.orderItemId, run.itemIds[1]!));

    const verdict = await deliveryAllowed(db, run.orderId);
    expect([verdict.allowed, verdict.reason]).toEqual([false, "unpaid_invoices"]);
    /** THE SECOND INVOICE, named. A mutant that read only the desk's would have released it. */
    expect(verdict.unpaidInvoiceIds).toEqual([second.invoiceId]);
  });

  it("A1: a reflex order carries its OWN bill, and its own report is held while that bill is unpaid", async () => {
    await activateTshReflex(db);
    const run = await runLabOrder(db, fx, ["TSH"], {
      at: AT, reflexConsent: true, values: { TSH: "9.0" },
    });
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);

    const allInvoices = await db.select().from(invoices);
    expect(allInvoices.length).toBeGreaterThan(1);
    const reflexInvoiceId = allInvoices.map((i) => i.id).find((id) => id !== run.invoiceId)!;

    expect((await deliveryAllowed(db, run.orderId)).reason).toBe("settled");
    const reflexVerdict = await deliveryAllowed(db, await orderIdOfItemInvoice(db, reflexInvoiceId));
    expect([reflexVerdict.allowed, reflexVerdict.reason, reflexVerdict.unpaidInvoiceIds])
      .toEqual([false, "unpaid_invoices", [reflexInvoiceId]]);
  });

  /* ═════════ A1b — "SOME MONEY ARRIVED" IS NOT "SETTLED", AND THE GRAIN IS THE INVOICE ═════════ */

  it("A1b: a partially-paid MIXED invoice blocks, and the verdict names the INVOICE", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });

    /**
     * ═══ A GENUINELY MIXED INVOICE — A CONSULTATION AND A LAB LINE ON ONE DOCUMENT ═══
     *
     * The lab desk cannot produce one (it bills the tests it places), so it is composed through
     * billing's own writer and the lab's own `invoice_line_id` is repointed at the lab line on it.
     * That column is this module's, and repointing it is exactly what a counter that bills a visit
     * as one document would leave behind.
     */
    const [consult] = await db.select({ id: services.id }).from(services)
      .where(eq(services.code, "OPD-CONSULT-NEW"));
    const mixed = await issueInvoice(db, fx.desk.actor, {
      draftId: newId(),
      patientId: fx.patientId,
      encounterId: fx.encounterNo,
      lines: [
        { lineId: newId(), serviceId: consult!.id, qty: 1 },
        { lineId: newId(), serviceId: serviceIdForLabCode("TSH"), qty: 1 },
      ],
      credit: { reason: "billed as one document at the counter" },
    }, AT);
    const mixedLines = await db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, mixed.invoiceId));
    const labLine = mixedLines.find((l) => l.serviceId === serviceIdForLabCode("TSH"))!;
    await db.update(labItems)
      .set({ invoiceId: mixed.invoiceId, invoiceLineId: labLine.id })
      .where(eq(labItems.orderItemId, run.itemIds[0]!));

    /** HALF the bill is paid — the half that may well have been for the consultation. */
    await settleInvoice(db, cashier, fx.patientId, mixed.invoiceId,
      Math.floor(mixed.totals.netPayablePaise / 2), AT);

    const verdict = await deliveryAllowed(db, run.orderId);
    expect([verdict.allowed, verdict.reason]).toEqual([false, "unpaid_invoices"]);
    /** THE INVOICE, not the line — DD23's whole point, and the operand question pre-answered. */
    expect(verdict.unpaidInvoiceIds).toEqual([mixed.invoiceId]);
    expect(verdict.unpaidInvoiceIds).not.toContain(labLine.id);
    expect(verdict.outstandingPaise).toBeGreaterThan(0);
  });

  it("settling the mixed invoice in full releases it", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    expect((await deliveryAllowed(db, run.orderId)).allowed).toBe(false);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);
    const verdict = await deliveryAllowed(db, run.orderId);
    expect([verdict.allowed, verdict.reason, verdict.unpaidInvoiceIds]).toEqual([true, "settled", []]);
  });

  /* ═══════════ A2 — THE PAYER BRANCH: INSTITUTIONS SETTLE ELSEWHERE ═══════════ */

  it("A2: a corporate visit delivers with ZERO receipts", async () => {
    fx.unregister();
    const corporateNo = "V2608290009";
    const unregister = registerEncounterResolver("V", async (_d, no) =>
      no === fx.encounterNo || no === corporateNo
        ? { patientId: fx.patientId, intendedPayer: no === corporateNo ? "corporate" : "self" }
        : null);
    try {
      const run = await runLabOrder(db, { ...fx, encounterNo: corporateNo }, ["TSH"], { at: AT });
      const [invoice] = await db.select({ intendedPayer: invoices.intendedPayer })
        .from(invoices).where(eq(invoices.id, run.invoiceId));
      expect(invoice!.intendedPayer).toBe("corporate");

      const verdict = await deliveryAllowed(db, run.orderId);
      expect([verdict.allowed, verdict.reason, verdict.outstandingPaise])
        .toEqual([true, "exempt_payer", 0]);
      /** And nobody paid: the invoice is still unsettled and that is the whole point. */
      expect(await db.select().from(invoices)).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it("A2: a `D` day-care encounter delivers with ZERO receipts — the bill is composed at discharge", async () => {
    const dayCareNo = "D2608290001";
    const unregister = registerEncounterResolver("D", async () =>
      ({ patientId: fx.patientId, intendedPayer: "self" }));
    try {
      const run = await runLabOrder(db, { ...fx, encounterNo: dayCareNo }, ["TSH"], { at: AT });
      const verdict = await deliveryAllowed(db, run.orderId);
      expect([verdict.allowed, verdict.reason]).toEqual([true, "exempt_payer"]);
    } finally {
      unregister();
    }
  });

  it("the exemption is per invoice and EVERY one must qualify — one self-pay line blocks", async () => {
    expect(EXEMPT_PAYERS).toEqual(["tpa", "pmjay", "corporate"]);
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    /** A self-pay invoice among the order's invoices is a bill somebody owes at the window. */
    const verdict = await deliveryAllowed(db, run.orderId);
    expect(verdict.allowed).toBe(false);
  });

  it("a granted release allows the hand-over and STILL names the unpaid invoices", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const held = await deliveryAllowed(db, run.orderId);
    const released = await deliveryAllowed(db, run.orderId, { releasedByApproval: true });
    expect([released.allowed, released.reason]).toEqual([true, "released_by_approval"]);
    /** The money did not move: the same invoices, the same outstanding. */
    expect([released.unpaidInvoiceIds, released.outstandingPaise])
      .toEqual([held.unpaidInvoiceIds, held.outstandingPaise]);
  });

  it("an order whose items carry no invoice line is not held for ever", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    await withTx(db, (tx) => tx.update(labItems)
      .set({ invoiceId: null, invoiceLineId: null })
      .where(eq(labItems.orderItemId, run.itemIds[0]!)));
    const verdict = await deliveryAllowed(db, run.orderId);
    expect([verdict.allowed, verdict.reason]).toEqual([true, "settled"]);
  });
});

/** The order behind the lab item that this invoice billed — the reflex order, in A1's case. */
async function orderIdOfItemInvoice(db: Db, invoiceId: string): Promise<string> {
  const [row] = await db
    .select({ orderId: orders.id })
    .from(labItems)
    .innerJoin(orderItems, eq(orderItems.id, labItems.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(labItems.invoiceId, invoiceId));
  return row!.orderId;
}
